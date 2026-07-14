import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { LINKS } from '@awaitful/shared';
import type { AdEvent, StatusBarState, PlacementId, Creative } from '@awaitful/shared';
import { apiBaseUrl } from '../lib/config.js';
import { SlateCache } from './slateCache.js';
import { KillswitchMonitor } from '../killswitch/monitor.js';
import { EventQueue } from '../metrics/eventQueue.js';
import { ViewTimer } from '../viewTracking/viewTimer.js';
import { DeviceLink } from '../auth/deviceLink.js';
import { StatusBarUI } from '../ui/statusBar.js';
import { StatusBarPlacement } from '../placements/statusBar.js';
import { registerCommands } from '../ui/menu.js';
import { AwaitfulPanel, type PanelState, type PanelMessage, type PanelSurface } from '../ui/panel.js';
import { ConsentStore } from './consent.js';
import { AccountClient } from './account.js';
import { PatchEngine } from '../patch/engine.js';
import { BackupStore } from '../patch/backup.js';
import { PatchWatcher } from '../patch/watch.js';
import { RecipeClient } from '../patch/recipeClient.js';
import { GLOW_THEMES, GLOW_KEYFRAMES, DEFAULT_GLOW_THEME, BANNER_FRAMES, DEFAULT_BANNER_FRAME } from '../patch/recipe.js';
import { HookServer, type SurfaceBeacon } from '../hooks/server.js';
import { SurfaceSession } from './surfaceSession.js';
import { writePortFile } from '../hooks/setup.js';
import { presentAgents, presentStatusLineAgents } from '../agents/registry.js';
import { writeStatusLineScript, removeStatusLineScript, statusLineScriptPath } from '../hooks/statusLineScript.js';
import { formatTerminalLine } from './terminalFormat.js';
import { AD_SPINNERS, getSpinner, frameAt, type AdSpinner } from '../ui/spinners.js';
import { HttpError } from '../lib/http.js';

// Persisted soft-pause state, so "Paused" survives a restart (like a real Off switch).
const ENABLED_KEY = 'awaitful.enabled';
// The chosen webview placement (thinking-line OR chat-banner) persists across restarts so the
// patch re-applies to the right surface; they are mutually exclusive and share one patch.
const WEBVIEW_SURFACE_KEY = 'awaitful.webviewSurface';
const BANNER_STYLE_KEY = 'awaitful.chatBannerStyle';
const BANNER_FRAME_KEY = 'awaitful.chatBannerFrame';
const TERMINAL_ENABLED_KEY = 'awaitful.terminalEnabled';
// Show accrued earnings in the status bar (idle state only) - a device-local privacy preference.
const SHOW_EARNINGS_KEY = 'awaitful.showEarningsInStatusBar';
// A competitor that also patches Claude Code can overwrite our take-over on reload. We RECLAIM the
// surface (restore the verified original + re-apply) a bounded number of times — winning against a
// passive competitor — before yielding honestly to an aggressive one. Awaitful never touches another
// extension's files, so past the cap the only fix is for the user to disable the other extension.
const MAX_RECLAIM_ATTEMPTS = 3;

/** The two webview placements. Both use the same patch/shim; only one is active at a time. */
type WebviewSurface = 'thinking-line' | 'chat-banner';
function isWebviewSurface(s: string): s is WebviewSurface {
  return s === 'thinking-line' || s === 'chat-banner';
}
function surfaceLabel(id: WebviewSurface): string {
  return id === 'chat-banner' ? 'chat banner' : 'thinking line';
}

export class Orchestrator {
  private readonly ui: StatusBarUI;
  private readonly auth: DeviceLink;
  private readonly slate: SlateCache;
  private readonly killswitch: KillswitchMonitor;
  private readonly queue: EventQueue;
  private readonly placement: StatusBarPlacement;
  private readonly consent: ConsentStore;

  private currentToken: string | undefined;
  private currentDeviceId: string | undefined;

  private enabled = true;
  /** Set when a pause tried to restore Claude Code but could not, so the panel does not claim the
   *  editor is "left unmodified" when our bytes may still be on disk. */
  private pauseRestoreFailed = false;
  private hookServer: HookServer | undefined;
  private viewTimer: ViewTimer | undefined;
  private patchWatcher: PatchWatcher | undefined;

  // Separate 401 streaks for slate (60 s poll) and event queue (5 s flush).
  // Slate is the authoritative signal — 2 consecutive slate 401s means the token is
  // genuinely revoked. Queue alone can never trigger sign-out (avoids false-positives
  // during server restarts when event flushes pile up 5× faster than slate polls).
  private slateAuthFails = 0;
  private queueAuthFails = 0;

  private activeAdId: string | undefined;
  private activeSlateId: string | undefined;
  private activeAdLine: string | undefined;
  private activeAdUnpaid = false;
  private activeAdUrl: string | undefined;
  private activeCreative: Creative | undefined;
  /**
   * The webview ad's OWN logo, before the developer's preference is applied. `undefined` whenever
   * the ad simply has none, which is most of them (a logo is optional for the advertiser). Kept so
   * that switching `awaitful.adBrandLogo` back on restores what the ad really had, and never invents
   * a logo for an ad that never carried one.
   */
  private activeIconUrl: string | undefined;
  private activePlacement: PlacementId = 'status-bar';
  // True while the status-bar ad is paused because Claude is waiting for the user
  // (a permission prompt / elicitation) — accrual is suspended so idle time never bills.
  private thinkingPaused = false;
  // Window focus gates status-bar accrual: view time only counts while VS Code is focused,
  // so time spent with the editor in the background never bills (golden rule 3).
  private windowFocused = true;

  // Active VS Code surface — exactly one at a time. status-bar renders + bills host-side;
  // the two webview placements (thinking-line, chat-banner) are rendered by the in-webview
  // shim and billed only from its beacons (verified, never assumed). The webview placements
  // share one patch and are mutually exclusive, so a single active slate serves whichever is chosen.
  private activeSurface: 'status-bar' | 'thinking-line' | 'chat-banner' = 'status-bar';
  private readonly base: string;
  private webviewSlate: SlateCache | undefined;
  private webviewSlatePlacement: WebviewSurface | undefined;
  // Per-build, per-session reclaim counter (in-memory → resets each window session, so disabling the
  // competitor and reloading always gets a fresh attempt). Bounds the in-session patch-war: after
  // MAX_RECLAIM_ATTEMPTS we stop reclaiming, earn in the status bar, and guide the user to disable the
  // other extension. Awaitful never disables it itself (no VS Code API, and it would be user-hostile).
  private readonly reclaimAttempts = new Map<string, number>();
  private readonly surface = new SurfaceSession(
    (type, visibleMs) => this.enqueue(type, visibleMs),
  );

  // Terminal status-line surface — a CONCURRENT surface (runs alongside the active VS Code surface),
  // rendered by each agent's statusLine script and billed only from verified render ticks while the
  // agent is genuinely thinking. Its own ad ids + SurfaceSession keep its billing independent of the
  // status-bar/webview surface. See agents/* for the per-agent install; the script + host are neutral.
  private terminalEnabled = false;
  private terminalSlate: SlateCache | undefined;
  private terminalAdId: string | undefined;
  private terminalSlateId: string | undefined;
  private lastTerminalTickMs = 0;
  private readonly terminalSurface = new SurfaceSession(
    (type, visibleMs) => this.enqueueTerminal(type, visibleMs),
  );

  private readonly account: AccountClient;
  private readonly patch: PatchEngine;
  private readonly recipeClient: RecipeClient;
  private accountEmail: string | undefined;
  private earningsToday: string | undefined;
  private unredeemedUsd: string | undefined;
  private showEarningsInStatusBar = true;
  private lastAccountFetchMs = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    const base = apiBaseUrl();
    this.base = base;

    this.ui = new StatusBarUI();
    this.auth = new DeviceLink(context.secrets);
    this.slate = new SlateCache(base, 'status-bar');
    this.killswitch = new KillswitchMonitor(base);
    this.queue = new EventQueue(base, () => this.currentDeviceId, () => this.currentToken);
    this.placement = new StatusBarPlacement(this.ui, () => this.statusBarEarning());
    this.consent = new ConsentStore(context.globalState);
    this.enabled = context.globalState.get<boolean>(ENABLED_KEY) !== false; // default on
    this.terminalEnabled = context.globalState.get<boolean>(TERMINAL_ENABLED_KEY) === true; // default off
    this.showEarningsInStatusBar = context.globalState.get<boolean>(SHOW_EARNINGS_KEY) !== false; // default on
    this.account = new AccountClient(base);
    // Patch the build VS Code is actually running, not merely the newest on disk.
    const activeDir = () => vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath;
    // Server-delivered recipes + self-activation + consensus reporting. Its synchronous lookup
    // resolves verified-server → embedded → provisional-self, with the embedded recipe as fallback.
    this.recipeClient = new RecipeClient(base, () => this.currentToken, activeDir);
    this.patch = new PatchEngine(
      new BackupStore(context.globalStorageUri.fsPath),
      (buildId) => this.recipeClient.lookup(buildId),
      activeDir,
    );

    context.subscriptions.push(
      this.ui,
      { dispose: () => this.slate.dispose() },
      { dispose: () => this.webviewSlate?.dispose() },
      { dispose: () => this.terminalSlate?.dispose() },
      { dispose: () => this.killswitch.dispose() },
      { dispose: () => this.queue.dispose() },
      { dispose: () => this.hookServer?.dispose() },
      { dispose: () => this.patchWatcher?.dispose() },
      { dispose: () => this.recipeClient.dispose() },
    );

    registerCommands(context, this);
  }

  async start(): Promise<void> {
    // Re-apply the patch FIRST — before any await — so Claude Code's webview
    // loads the shim on this session's very first render. (If it ran later, the
    // webview could load the file before we patched it, and the shim would be
    // absent until the next reload.) It is idempotent and fail-safe.
    this.reapplyWebviewSurface();
    this.patch.pruneStaleBackups();
    this.patchWatcher = new PatchWatcher(() => this.healWebviewSurface());
    this.patchWatcher.start();
    // Poll the server for this build's recipe (embedded/self cover us until it lands).
    this.recipeClient.start();

    this.currentDeviceId = await this.auth.ensureDeviceId();
    this.currentToken = await this.auth.token();

    // Seed + track window focus so the status-bar view timer only accrues while VS Code
    // is focused (the ad isn't genuinely seen when the editor is in the background).
    this.windowFocused = vscode.window.state.focused;
    this.context.subscriptions.push(
      vscode.window.onDidChangeWindowState((s) => {
        this.windowFocused = s.focused;
        this.reconcileViewTimer();
      }),
    );

    // Ad appearance is settings (Settings Sync roams them); when one changes, restyle the LIVE
    // webview creative so the picker previews in place - the same move as banner styles. The
    // status bar listens for itself, and the terminal picks the new frames up on its next poll.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('awaitful.adSpinner')) {
          const s = this.adSpinner();
          this.surface.restyle({ spinnerFrames: [...s.frames], spinnerIntervalMs: s.intervalMs });
          this.syncPanel();
        }
        if (e.affectsConfiguration('awaitful.adBrandLogo')) {
          // Put the logo back, or take it away, on the ad that is on screen RIGHT NOW. Same adId,
          // so no billing state resets - the developer is restyling the frame, not refusing the ad.
          // Restoring means restoring what the ad ACTUALLY had, which for most ads is nothing:
          // a logo is optional for the advertiser, so activeIconUrl is undefined far more often
          // than not, and turning the setting on must never invent one.
          this.surface.restyle({ iconUrl: this.showBrandLogo() ? this.activeIconUrl : undefined });
          this.syncPanel();
        }
      }),
    );

    this.killswitch.onKillswitchChange((killed) => {
      if (killed) this.haltImpression(); // a server kill must also stop an in-flight impression
      this.applyState(killed ? 'killed' : this.activeState());
      this.syncPanel();
    });

    this.hookServer = new HookServer({
      onStart: () => this.onThinkingStart(),
      onStop: () => this.onThinkingStop(),
      onPause: () => this.onThinkingPause(),
      onResume: () => this.onThinkingResume(),
      getCreative: () => this.surface.current,
      onRendered: (b) => { this.surface.rendered(b); this.confirmSurfaceLive(); },
      onVisible: (b) => { this.surface.visible(b); this.confirmSurfaceLive(); },
      onClick: (b) => this.onSurfaceClick(b),
      getTerminalLine: () => this.terminalLine(),
      onTerminalTick: () => this.onTerminalTick(),
    });
    const port = await this.hookServer.start();
    await writePortFile(port);
    // Install thinking-detection for every present agent (Claude Code today). Agent-agnostic via
    // the registry so a future agent is one adapter + registry entry — see agents/*.
    for (const agent of await presentAgents()) {
      try { await agent.installThinkingHooks(); } catch { /* fail-safe: a config write fault must never crash activation */ }
    }
    // Re-assert the terminal status line if it was left enabled from a previous session (idempotent).
    if (this.terminalEnabled) await this.ensureTerminalInstalled();

    try {
      await Promise.all([
        this.slate.refresh(this.currentToken),
        // The webview slate was created back in reapplyWebviewSurface() - BEFORE the token was
        // loaded a few lines up - so its first fetch went out anonymous, and an anonymous slate is
        // NOT personalised: the server cannot exclude the viewer's own campaigns from an ad it
        // cannot attribute, so a developer who also advertises sees their own line until the next
        // poll. Re-fetch now that the token exists, so own-ad exclusion applies from the first
        // frame instead of up to a poll-interval later. (Polling reads the token lazily and keeps
        // it correct thereafter.)
        this.webviewSlate?.refresh(this.currentToken).catch(() => {}),
        this.killswitch.check(),
      ]);
      const onSlateUnauthorized = () => {
        this.slateAuthFails++;
        if (this.slateAuthFails >= 2) {
          this.slateAuthFails = 0;
          this.queueAuthFails = 0;
          void this.signOut();
        }
      };
      const onQueueUnauthorized = () => {
        this.queueAuthFails++;
        if (this.slateAuthFails >= 1 && this.queueAuthFails >= 5) {
          this.slateAuthFails = 0;
          this.queueAuthFails = 0;
          void this.signOut();
        }
      };
      const onAuthSuccess = () => {
        this.slateAuthFails = 0;
        this.queueAuthFails = 0;
      };

      this.slate.startPolling(60_000, () => this.currentToken, onSlateUnauthorized, onAuthSuccess);
      this.killswitch.startPolling(30_000);
      this.queue.startFlushing(5_000, onQueueUnauthorized, onAuthSuccess);
      this.applyState(this.activeState()); // honours the persisted paused state
      void this.refreshAccount(true);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        await this.auth.signOut();
        this.currentToken = undefined;
        this.applyState('signin');
      } else {
        this.applyState('offline');
      }
    }
  }

  stop(): void {
    // We deliberately do NOT restore the patch on deactivate. Restoring here would
    // make Claude Code pristine on every window reload, and its webview could then
    // load that pristine file before our next-session re-apply runs — so the shim
    // would be missing and no ad would show. Keeping the patch persistent means the
    // webview always loads the shim. The shim is harmless if ever orphaned (it only
    // reaches a local host that no longer exists), and the user can cleanly revert
    // any time with "Restore original files". Uninstall cleanup is a known trade-off
    // (see docs/ARCHITECTURE.md §5).
    // Remove thinking hooks for every agent (the terminal status line is left in place — it's
    // fail-safe when the host is down, chaining to the user's own line; it's cleaned up on an
    // explicit terminal-disable or "Restore original files", mirroring the persistent patch).
    void (async () => {
      for (const agent of await presentAgents()) {
        try { await agent.removeThinkingHooks(); } catch { /* best-effort on shutdown */ }
      }
    })();
    this.queue.flush().catch(() => {});
  }

  // ── Thinking detection ──────────────────────────────────────────────────

  private onThinkingStart(): void {
    if (!this.enabled || this.killswitch.isKilled) return;
    if (!this.currentToken) return;

    // A start can re-enter mid-turn with no intervening Stop (a queued/steered prompt, or
    // interrupt-and-resubmit). Tear down any prior impression's timer first, or its interval
    // leaks and keeps firing view_tick / view_threshold_met against the NEW ad — a double-bill.
    this.viewTimer?.stop();
    this.viewTimer = undefined;
    this.thinkingPaused = false; // fresh turn — clear any stale pause

    // The terminal is a concurrent surface — start its impression regardless of which VS Code
    // surface is active (they bill independently). No-op unless the terminal surface is enabled.
    if (this.terminalEnabled) this.startTerminalImpression();

    if (isWebviewSurface(this.activeSurface)) {
      this.startWebviewImpression(this.activeSurface);
      return;
    }

    const creative = this.slate.nextCreative();
    if (!creative) return;

    this.activeAdId = creative.adId;
    this.activeSlateId = this.slate.slateId;
    this.activeAdLine = creative.line;
    this.activeAdUnpaid = creative.unpaid === true;
    this.activeAdUrl = creative.url;
    this.activeCreative = creative;
    this.activePlacement = 'status-bar';

    this.placement.show(creative);
    this.enqueue('impression_rendered');

    this.viewTimer = new ViewTimer({
      onTick: (visibleMs) => this.enqueue('view_tick', visibleMs),
      onThresholdMet: (visibleMs) => this.enqueue('view_threshold_met', visibleMs),
      onStuck: () => this.enqueue('error_impression'),
    });
    this.reconcileViewTimer(); // start accruing only if the window is focused
    this.syncPanel();
  }

  private onThinkingStop(): void {
    this.haltImpression();
    this.applyState(this.activeState());
    this.syncPanel();
    void this.refreshAccount();  // earnings likely just changed
  }

  /** Fully end the current status-bar impression: stop the timer, clear ids, drop the ad. */
  private haltImpression(): void {
    this.viewTimer?.stop();
    this.viewTimer = undefined;
    this.activeAdId = undefined;
    this.activeSlateId = undefined;
    this.activeAdLine = undefined;
    this.activeAdUnpaid = false;
    this.activeAdUrl = undefined;
    this.activeCreative = undefined;
    this.activeIconUrl = undefined;
    this.thinkingPaused = false;
    this.surface.end();
    this.placement.hide();
    // End the concurrent terminal impression too (its next tick after this would otherwise
    // accrue against a stale creative).
    this.terminalSurface.end();
    this.terminalAdId = undefined;
    this.terminalSlateId = undefined;
    this.lastTerminalTickMs = 0;
  }

  /**
   * Single source of truth for whether the status-bar view timer accrues. It counts only
   * while we're genuinely earning (enabled, not killed), the window is focused, and we're
   * not paused waiting for the user. Called whenever any of those inputs change;
   * ViewTimer.start()/pause() are idempotent, so the two pause sources never fight.
   */
  private reconcileViewTimer(): void {
    if (!this.viewTimer) return;
    const accrue = this.enabled && !this.killswitch.isKilled && this.windowFocused && !this.thinkingPaused;
    if (accrue) this.viewTimer.start(); else this.viewTimer.pause();
  }

  /**
   * Claude paused mid-turn to wait for the USER — a tool-permission prompt, an MCP
   * elicitation, or a background session awaiting input (Claude Code's `Notification`
   * hook). The agent is idle, so the status-bar ad must stop accruing view time;
   * otherwise a user could leave a permission prompt open and earn on an unanswered
   * question (golden rule 3: never bill time the developer isn't genuinely served). The
   * thinking-line surface needs no action here — its shim already hides the moment the
   * spinner disappears during a prompt.
   */
  private onThinkingPause(): void {
    // Pause every concurrent surface, not just the status bar: the terminal status line reads
    // `thinkingPaused` to blank the ad, so this must flip even when no status-bar viewTimer is
    // running (e.g. a webview surface is active). reconcileViewTimer/placement.hide no-op safely
    // when there's no status-bar impression.
    if (this.thinkingPaused) return;
    this.thinkingPaused = true;
    this.reconcileViewTimer(); // freeze status-bar accrual; accumulated time is preserved
    this.placement.hide();     // drop the status-bar ad — reverts to the plain indicator
    // Terminal: the next status-line tick after resume must not count the paused gap as one big
    // tick, so reset the tick baseline (the first tick after resume then accrues zero).
    this.lastTerminalTickMs = 0;
  }

  /**
   * The user answered and the agent resumed work (a tool just ran — Claude Code's
   * `PostToolUse` hook). Resume accrual on the SAME impression: re-show the ad and let the
   * reconciler restart the timer, which continues from the preserved accumulated time (the
   * threshold is not re-armed, so the paused gap is simply excluded).
   */
  private onThinkingResume(): void {
    if (!this.thinkingPaused) return;
    this.thinkingPaused = false;
    if (this.activeCreative) this.placement.show(this.activeCreative);
    this.reconcileViewTimer(); // resumes only if the window is focused / still earning
    // Terminal resumes automatically: terminalLine() returns non-null again, and lastTerminalTickMs
    // was reset on pause so the first post-resume tick accrues zero (the gap is excluded).
  }

  // ── Webview surfaces (shim-driven, verified billing) ──────────────────────

  /**
   * Pick the creative the shim will paint this thinking session for the active webview
   * placement, and expose it at /surface/creative tagged with its `placement` (and, for the
   * chat-banner, the chosen glow style). We do NOT bill here — impressions are emitted only
   * when the shim beacons that it actually rendered/was visible (golden rule 3).
   */
  private startWebviewImpression(placement: WebviewSurface): void {
    const slate = this.webviewSlate;
    const creative = slate?.nextCreative();
    if (!slate || !creative) { this.surface.end(); return; }

    this.activeAdId = creative.adId;
    this.activeSlateId = slate.slateId;
    this.activePlacement = placement;
    // The ad's own logo, kept unstripped: `undefined` for the many ads that simply do not have one
    // (it is optional for the advertiser), and the value to restore if logos are switched back on.
    this.activeIconUrl = creative.brand?.iconUrl;
    this.surface.begin({
      adId: creative.adId,
      slateId: slate.slateId ?? '',
      line: creative.line,
      placement,
      ...(creative.url !== undefined ? { url: creative.url } : {}),
      // Two independent reasons there is no logo here, and they must not be confused: the ad never
      // had one, or the developer turned logos off. Hence an AND, never a default.
      ...(this.showBrandLogo() && this.activeIconUrl ? { iconUrl: this.activeIconUrl } : {}),
      ...(placement === 'chat-banner' ? { bannerStyle: this.chatBannerStyle(), bannerFrame: this.chatBannerFrame() } : {}),
      ...this.spinnerPayload(),
      ...(creative.unpaid ? { unpaid: true } : {}),
    });
    // Status bar stays a plain earning indicator — the ad shows in the webview.
  }

  private onSurfaceClick(b: SurfaceBeacon): void {
    const url = this.surface.click(b);
    if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // ── Terminal status-line surface (concurrent, verified-tick billing) ──────────

  /** Begin the concurrent terminal impression for this think from the terminal slate. */
  private startTerminalImpression(): void {
    const slate = this.terminalSlate;
    const creative = slate?.nextCreative();
    if (!slate || !creative) {
      this.terminalSurface.end();
      this.terminalAdId = undefined;
      this.terminalSlateId = undefined;
      return;
    }
    this.terminalAdId = creative.adId;
    this.terminalSlateId = slate.slateId;
    this.lastTerminalTickMs = 0;
    this.terminalSurface.begin({
      adId: creative.adId,
      slateId: slate.slateId ?? '',
      line: creative.line,
      placement: 'terminal',
      ...(creative.url !== undefined ? { url: creative.url } : {}),
    });
  }

  /**
   * The status-line string to print right now, or null to show nothing. Gated on genuinely
   * earning (enabled, not killed) + thinking (a live terminal creative) + not paused — so the
   * terminal only shows/bills while the agent is actually working (golden rule 3). We cannot
   * observe terminal focus, hence terminal's lower rate-card weight + impression-only billing.
   */
  private terminalLine(): string | null {
    if (!this.terminalEnabled || this.thinkingPaused) return null;
    if (!this.enabled || this.killswitch.isKilled) return null;
    const c = this.terminalSurface.current;
    return c ? formatTerminalLine(c, frameAt(this.adSpinner(), Date.now())) : null;
  }

  /**
   * A verified render tick: an agent re-ran its status line and we returned a creative. Fire the
   * one-time rendered event, then accrue the time since the previous tick (SurfaceSession clamps
   * each beacon, so a slow/sped-up refresh can't inflate) toward the view threshold.
   */
  private onTerminalTick(): void {
    const c = this.terminalSurface.current;
    if (!c) return;
    const beacon = { adId: c.adId, slateId: c.slateId };
    this.terminalSurface.rendered(beacon);
    const now = Date.now();
    if (this.lastTerminalTickMs) this.terminalSurface.visible({ ...beacon, visibleMs: now - this.lastTerminalTickMs });
    this.lastTerminalTickMs = now;
  }

  private enqueueTerminal(type: AdEvent['type'], visibleMs?: number): void {
    if (!this.enabled || this.killswitch.isKilled) return;
    if (!this.terminalAdId || !this.terminalSlateId) return;
    this.queue.enqueue({
      eventId: randomUUID(),
      type,
      adId: this.terminalAdId,
      slateId: this.terminalSlateId,
      placement: 'terminal',
      occurredAtClientMs: Date.now(),
      ...(visibleMs !== undefined ? { visibleMs } : {}),
    });
  }

  private async toggleTerminal(): Promise<void> {
    if (this.terminalEnabled) await this.disableTerminal();
    else await this.enableTerminal();
    this.syncPanel();
  }

  private async enableTerminal(): Promise<void> {
    await this.consent.grant('terminal');
    this.terminalEnabled = true;
    await this.context.globalState.update(TERMINAL_ENABLED_KEY, true);
    const { installed, present } = await this.ensureTerminalInstalled();

    // We only claim "enabled" when we actually wrote the status line into at least one agent. If agents
    // were present but every write failed (a read-only or corp-managed ~/.claude/settings.json), saying
    // "enabled" would send the user hunting for a line that will never appear. Tell them the truth.
    if (present > 0 && installed === 0) {
      await vscode.window.showWarningMessage(
        'Awaitful: could not write the terminal status line - Claude Code\'s settings file may be read-only or managed. Nothing was changed. Check the file permissions and try again.',
      );
      return;
    }

    // Claude Code reads the statusLine when a session starts, so it appears on the next new/reloaded
    // Claude Code session, not necessarily the one currently running.
    const pick = await vscode.window.showInformationMessage(
      'Awaitful: terminal status line enabled. Start a new Claude Code session - or reload the window - to see it while it thinks.',
      'Reload window',
    );
    if (pick === 'Reload window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  private async disableTerminal(): Promise<void> {
    this.terminalEnabled = false;
    await this.context.globalState.update(TERMINAL_ENABLED_KEY, false);
    await this.consent.revoke('terminal');
    this.terminalSurface.end();
    this.terminalAdId = undefined;
    this.terminalSlateId = undefined;
    this.terminalSlate?.dispose();
    this.terminalSlate = undefined;
    await this.removeTerminalInstall();
  }

  /** Write the shared status-line script + register it for every present status-line agent. Idempotent. */
  /** Returns how many present agents we could ACTUALLY install into, and how many were present, so the
   *  caller can tell "installed" from "tried and every write failed" without ever crashing activation. */
  private async ensureTerminalInstalled(): Promise<{ installed: number; present: number }> {
    await writeStatusLineScript();
    const scriptPath = statusLineScriptPath();
    const agents = await presentStatusLineAgents();
    let installed = 0;
    for (const agent of agents) {
      // Still caught per-agent: a read-only ~/.claude/settings.json must never break activation. But
      // the failure is now COUNTED, not silently discarded, so we do not later claim success.
      try { await agent.installStatusLine(scriptPath); installed++; } catch { /* fail-safe */ }
    }
    if (!this.terminalSlate) {
      this.terminalSlate = new SlateCache(this.base, 'terminal');
      this.terminalSlate.refresh(this.currentToken).catch(() => {});
      this.terminalSlate.startPolling(60_000, () => this.currentToken);
    }
    return { installed, present: agents.length };
  }

  /** Restore every agent's original status line + delete our script (reversible, per the golden rules). */
  private async removeTerminalInstall(): Promise<void> {
    for (const agent of await presentStatusLineAgents()) {
      try { await agent.removeStatusLine(); } catch { /* best-effort */ }
    }
    await removeStatusLineScript();
  }

  private enqueue(type: AdEvent['type'], visibleMs?: number): void {
    // Never bill while soft-paused or killed, even if a timer somehow outlives the halt.
    if (!this.enabled || this.killswitch.isKilled) return;
    if (!this.activeAdId || !this.activeSlateId) return;
    const event: AdEvent = {
      eventId: randomUUID(),
      type,
      adId: this.activeAdId,
      slateId: this.activeSlateId,
      placement: this.activePlacement,
      occurredAtClientMs: Date.now(),
      ...(visibleMs !== undefined ? { visibleMs } : {}),
    };
    this.queue.enqueue(event);
  }

  // ── State helpers ───────────────────────────────────────────────────────

  private activeState(): StatusBarState {
    if (this.killswitch.isKilled) return 'killed';
    if (!this.enabled) return 'off';
    return this.currentToken ? 'earning' : 'signin';
  }

  private lastState: StatusBarState = 'earning';
  private applyState(state: StatusBarState): void {
    this.lastState = state;
    this.ui.setState(state, state === 'earning' ? this.statusBarEarning() : undefined);
  }

  /**
   * Idle status-bar earnings label + tooltip, or undefined to show the plain brand. Hidden when the
   * user turned it off (privacy - then the amount appears in neither the label nor the tooltip), or
   * until something meaningful has accrued (never "$0.00"): shown once the unredeemed total rounds to
   * at least $0.01.
   */
  private statusBarEarning(): { amount?: string; tooltip?: string } | undefined {
    if (!this.showEarningsInStatusBar) return undefined;
    const v = parseFloat(this.unredeemedUsd ?? '0');
    if (!(v >= 0.01)) return undefined;
    const tooltip = `Awaitful · ${this.fmtUsd(this.unredeemedUsd)} unredeemed · ${this.fmtUsd(this.earningsToday)} today · click to manage`;
    return { amount: '$' + v.toFixed(2), tooltip };
  }

  private fmtUsd(s: string | undefined): string {
    const v = parseFloat(s ?? '0');
    if (!v) return '$0.00';
    return '$' + (v < 0.01 ? v.toFixed(4) : v.toFixed(2));
  }

  private async toggleStatusBarEarnings(): Promise<void> {
    this.showEarningsInStatusBar = !this.showEarningsInStatusBar;
    await this.context.globalState.update(SHOW_EARNINGS_KEY, this.showEarningsInStatusBar);
    if (this.activeAdLine === undefined) this.applyState(this.activeState()); // reflect immediately when idle
    this.syncPanel();
  }

  /**
   * A shim beacon proves our surface is LIVE in the current webview — so clear any stale
   * "reload to activate" (e.g. a heal-reclaim re-wrote the file for the next load while the running
   * webview already shows our ad). The beacon, not the file state, is the truth about what's rendered.
   */
  private confirmSurfaceLive(): void {
    if (this.lastState === 'reload-to-earn') {
      this.applyState(this.activeState());
      this.syncPanel();
    }
  }

  // ── Account info (panel header) ─────────────────────────────────────────

  /**
   * Refresh the email + earned-today shown in the panel header. Throttled;
   * failures are swallowed and never feed the sign-out streak — the slate
   * poll is the sole authority on token revocation (see fields above).
   */
  private async refreshAccount(force = false): Promise<void> {
    if (!this.currentToken) return;
    const now = Date.now();
    if (!force && now - this.lastAccountFetchMs < 15_000) return;
    this.lastAccountFetchMs = now;

    const [me, earnings] = await Promise.allSettled([
      this.account.fetchMe(this.currentToken),
      this.account.fetchEarnings(this.currentToken),
    ]);
    if (me.status === 'fulfilled') this.accountEmail = me.value.email;
    if (earnings.status === 'fulfilled') {
      this.earningsToday = earnings.value.todayUsd;
      this.unredeemedUsd = earnings.value.unredeemedUsd;
    }
    if (me.status === 'fulfilled' || earnings.status === 'fulfilled') {
      this.syncPanel();
      // Refresh the idle status-bar earnings, but never clobber a live ad.
      if (this.activeAdLine === undefined) this.applyState(this.activeState());
    }
  }

  // ── Panel ───────────────────────────────────────────────────────────────

  /**
   * Earning rate of a placement relative to the status bar (1.0 = same).
   * Derived from the server's live rate card so the incentive shown in the
   * panel tracks whatever operators set — never hardcoded in the client.
   */
  private relativeRate(id: string): number | undefined {
    const weights = this.slate.placementWeights;
    const base = weights?.['status-bar'];
    const mine = weights?.[id];
    if (!base || mine === undefined) return undefined;
    return Math.round((mine / base) * 10) / 10;
  }

  private buildPanelState(): PanelState {
    // Exactly one VS Code surface earns at a time. The two webview placements (thinking-line,
    // chat-banner) share one patch and are mutually exclusive; `active` reflects the CHOSEN one
    // (activeSurface), so the panel shows the real exclusivity — status bar, or one webview spot.
    const tl = this.webviewSurfaceCard('thinking-line');
    const cb = this.webviewSurfaceCard('chat-banner');
    return {
      version: this.context.extension.packageJSON.version as string,
      signedIn: !!this.currentToken,
      email: this.accountEmail,
      earningsToday: this.earningsToday,
      unredeemedUsd: this.unredeemedUsd,
      disabled: !this.enabled,
      pauseRestoreFailed: this.pauseRestoreFailed,
      showEarningsInStatusBar: this.showEarningsInStatusBar,
      activeAdLine: this.activeAdLine,
      activeAdUnpaid: this.activeAdUnpaid,
      activeAdUrl: this.activeAdUrl,
      chatBannerStyle: this.chatBannerStyle(),
      chatBannerFrame: this.chatBannerFrame(),
      chatBannerFrames: BANNER_FRAMES.map((x) => ({ id: x.id, label: x.label })),
      chatBannerKeyframes: GLOW_KEYFRAMES,
      chatBannerThemes: GLOW_THEMES.map((t) => ({ id: t.id, label: t.label, swatch: t.swatch, background: t.background, animation: t.animation })),
      adSpinner: this.adSpinner().id,
      adSpinners: AD_SPINNERS.map((sp) => ({ id: sp.id, label: sp.label, frames: [...sp.frames], intervalMs: sp.intervalMs })),
      adBrandLogo: this.showBrandLogo(),
      vsSurfaces: [
        {
          id: 'status-bar',
          active: this.activeSurface === 'status-bar',
          available: true,
          consentGranted: true,
          comingSoon: false,
          modifiesFiles: false,
          earnRate: this.relativeRate('status-bar'),
        },
        cb,
        tl,
      ],
      terminalEnabled: this.terminalEnabled,
      terminalConsentGranted: this.consent.isGranted('terminal'),
      terminalComingSoon: false,
      terminalEarnRate: this.relativeRate('terminal'),
    };
  }

  /**
   * Derive a webview surface card from a live patch assessment. Both webview placements share
   * one patch, so patchability is identical; only `active` differs — it is true when this
   * placement is the CHOSEN one (mutually exclusive with the other webview spot).
   */
  private webviewSurfaceCard(id: WebviewSurface): PanelSurface {
    const a = this.patch.assess();
    // Our patch is present whether it's the current version or an older one being upgraded.
    const patched = a.state === 'our-patch-present' || a.state === 'our-patch-stale';
    const active = patched && this.activeSurface === id;
    // Claude Code has been modified (by another extension, or hand-edited).
    const conflict = a.state === 'modified';
    const conflictVendor = a.foreign?.vendor;
    // We can take over only if pristine is recoverable from a Awaitful-controlled source.
    const canTakeOver = a.recoverable === true;
    // Offer on a clean build, when already active, or on a conflict (guidance / take-over).
    const supported = a.state === 'clean-pristine' || patched || conflict;
    // Active via a self-computed (provisional) recipe on a build the server hasn't confirmed yet.
    const provisional = active && this.recipeClient.isProvisionalActive();
    return {
      id,
      active,
      available: supported,
      consentGranted: this.consent.isGranted(id),
      comingSoon: !supported,
      modifiesFiles: true,
      earnRate: this.relativeRate(id),
      conflict,
      conflictVendor,
      canTakeOver,
      supported,
      provisional,
    };
  }

  private syncPanel(): void {
    if (AwaitfulPanel.isOpen()) {
      AwaitfulPanel.openOrReveal(
        this.context,
        (msg) => this.handlePanelMessage(msg),
        this.buildPanelState(),
      ).setState(this.buildPanelState());
    }
  }

  private handlePanelMessage(msg: PanelMessage): void {
    switch (msg.type) {
      case 'sign-in':
        void this.signIn();
        break;
      case 'sign-out':
        void this.signOut();
        break;
      case 'open-dashboard':
        void this.openDashboard();
        break;
      case 'set-ad-spinner':
        if (AD_SPINNERS.some((sp) => sp.id === msg.id)) {
          void vscode.workspace.getConfiguration('awaitful').update('adSpinner', msg.id, vscode.ConfigurationTarget.Global);
        }
        break;
      case 'toggle-ad-logo':
        // Write the setting and stop. The config listener above does the rest (restyle the live ad,
        // re-sync the panel), so the toggle behaves identically whether it was flipped here or in
        // VS Code's own settings UI - one path, not two that can drift.
        void vscode.workspace
          .getConfiguration('awaitful')
          .update('adBrandLogo', !this.showBrandLogo(), vscode.ConfigurationTarget.Global);
        break;
      case 'toggle-enabled':
        if (this.enabled) this.disable(); else this.enable();
        break;
      case 'toggle-statusbar-earnings':
        void this.toggleStatusBarEarnings();
        break;
      case 'consent-grant':
        if (isWebviewSurface(msg.id)) {
          void this.enableWebviewSurface(msg.id, msg.takeover === true);
        } else {
          void this.consent.grant(msg.id as Parameters<ConsentStore['grant']>[0]);
          this.syncPanel();
        }
        break;
      case 'set-banner-style':
        void this.setChatBannerStyle(msg.style);
        break;
      case 'set-banner-frame':
        void this.setChatBannerFrame(msg.frame);
        break;
      case 'restore-files':
        void this.restorePatchedFiles();
        break;
      case 'reload-window':
        this.reloadWindow();
        break;
      case 'open-github':
        void vscode.env.openExternal(vscode.Uri.parse(LINKS.sourceCode));
        break;
      case 'open-privacy':
        void vscode.env.openExternal(vscode.Uri.parse(LINKS.egressManifest));
        break;
      case 'visit-ad':
        if (this.activeAdUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(this.activeAdUrl));
          this.enqueue('click');
        }
        break;
      case 'set-surface':
        // File-modifying surfaces are enabled from their detail page, not here.
        if (isWebviewSurface(msg.id)) {
          void this.enableWebviewSurface(msg.id, false);
        } else if (msg.id === 'status-bar') {
          // The status bar is the always-available default surface — switching to it means
          // undoing the thinking-line patch (surfaces are mutually exclusive).
          void this.switchToStatusBar();
        } else {
          vscode.window.showInformationMessage(
            `Awaitful: Surface '${msg.id}' will be available in a future update.`,
          );
        }
        break;
      case 'toggle-terminal':
        void this.toggleTerminal();
        break;
    }
  }

  // ── Webview patch surfaces (thinking-line / chat-banner) ──────────────────

  /**
   * Enable a webview surface. Both webview placements share one patch, so this applies it
   * and marks the chosen placement (deactivating the other webview spot). The engine is
   * fail-safe: a foreign conflict without take-over consent, an unknown build, or a failed
   * health probe all leave the editor untouched and keep status-bar mode working.
   */
  private async enableWebviewSurface(id: WebviewSurface, takeover: boolean): Promise<void> {
    if (this.killswitch.isKilled) {
      vscode.window.showWarningMessage('Awaitful: patching is paused server-side right now.');
      return;
    }

    // If we've already lost this build to an actively-re-patching competitor, don't restart the futile
    // take-over/reload loop — surface the real fix (disable the other extension) up front.
    const pre = this.patch.assess();
    const preBuild = pre.target?.buildId ?? 'unknown';
    if (pre.state === 'modified' && this.getReclaim(preBuild) >= MAX_RECLAIM_ATTEMPTS) {
      const who = pre.foreign?.vendor ?? 'another extension';
      const pick = await vscode.window.showWarningMessage(
        `Awaitful: ${who} is actively re-modifying Claude Code and will overwrite the ${surfaceLabel(id)} again on reload. To use it, disable ${who} first.`,
        'Manage extensions', 'Try anyway',
      );
      if (pick === 'Manage extensions') { void vscode.commands.executeCommand('workbench.view.extensions'); return; }
      if (pick !== 'Try anyway') return;
      this.setReclaim(preBuild, 0); // explicit override → fresh reclaim budget
    }

    const res = this.patch.apply(takeover);
    this.reportPatchOutcome(res.ok);
    if (res.ok) {
      await this.chooseWebviewSurface(id);
      if (res.reloadNeeded) {
        this.applyState('reload-to-earn');
        const label = surfaceLabel(id);
        const pick = await vscode.window.showInformationMessage(
          res.tookOver
            ? `Awaitful is now active in the ${label} (replaced ${res.tookOver}). Reload to see it - and disable ${res.tookOver} to avoid conflicts.`
            : `Awaitful is now active in the ${label}. Reload the window to see it.`,
          'Reload window',
        );
        if (pick === 'Reload window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
      this.syncPanel();
      return;
    }

    // Fail-safe: explain, stay in status-bar mode.
    switch (res.reason) {
      case 'blocked':
        vscode.window.showWarningMessage(
          res.foreignVendor
            ? `Awaitful: an extension named ${res.foreignVendor} is already modifying Claude Code. Open the panel to switch to Awaitful, or keep using status-bar mode.`
            : 'Awaitful: Claude Code has been modified by another extension. Open the panel to switch to Awaitful, or keep using status-bar mode.',
        );
        break;
      case 'no-pristine':
        vscode.window.showWarningMessage(
          'Awaitful: could not verify the original Claude Code file, so it was left unchanged. Status-bar mode still works.',
        );
        break;
      case 'no-target':
        // Claude Code is not installed in THIS window - a different fact from "your build is not
        // supported yet", which would send the user looking for a version fix that is not the problem.
        vscode.window.showInformationMessage(
          `Awaitful: Claude Code is not installed in this window, so the ${surfaceLabel(id)} surface has nothing to attach to. Status-bar mode is active.`,
        );
        break;
      case 'unknown-build':
        vscode.window.showInformationMessage(
          `Awaitful: the ${surfaceLabel(id)} surface is not available for this Claude Code build yet. Status-bar mode is active and earning.`,
        );
        break;
      case 'health-failed':
      case 'error':
        // "rolled back to keep your editor safe" is a claim the rollback SUCCEEDED. When it did not,
        // our bytes may still be on disk, and saying "safe" is the worst possible lie here.
        vscode.window.showWarningMessage(
          res.rolledBack === false
            ? 'Awaitful: patching failed and could not be fully undone. Open the thinking-line page and use "Restore original files" to return Claude Code to its original state.'
            : 'Awaitful: patching was rolled back to keep your editor safe. Status-bar mode is active.',
        );
        break;
    }
    this.syncPanel();
  }

  /**
   * Report the patch outcome to the server (feeds crowd consensus + patch-health). A successful
   * apply on a build with no verified/embedded recipe is a provisional self-activation — the
   * first-adopter signal that seeds consensus for that build.
   */
  private reportPatchOutcome(ok: boolean): void {
    this.recipeClient.report(ok ? (this.recipeClient.isProvisionalActive() ? 'self-activated' : 'applied') : 'apply-failed');
  }

  /**
   * Re-apply the patch on activation if the user already chose a webview surface — keeps it
   * alive across restarts. Because deactivate restored the file to pristine, this re-patches
   * BEFORE Claude Code's webview loads, so the fresh webview picks up the patch with no reload
   * prompt. Silent; a conflict or unknown build simply does nothing (never a modal at startup).
   */
  private reapplyWebviewSurface(): void {
    const chosen = this.chosenWebviewSurface();
    if (!this.enabled || !chosen || this.killswitch.isKilled) return;
    // Silent at startup: no modal, no reload prompt — the webview loads the just-patched file directly.
    try { this.syncWebviewPatch(chosen, false); } catch { /* fail-safe: never break activation */ }
  }

  /**
   * Debounced self-heal, fired when the extensions dir changes (Claude Code
   * update, or another extension re-patched a target). Re-applies our patch if
   * it's safe, or steps back to status-bar mode if the surface is no longer
   * available. Quiet — no modal; only a status-bar hint when a reload is needed.
   */
  private healWebviewSurface(): void {
    // Skip while paused — otherwise the watcher would re-apply the patch that
    // pause just restored, fighting the user's choice.
    const chosen = this.chosenWebviewSurface();
    if (!this.enabled || !chosen || this.killswitch.isKilled) return;
    try { this.syncWebviewPatch(chosen, true); } catch { /* fail-safe */ }
  }

  /**
   * Bring the on-disk patch in line with the chosen webview surface. Both the activation re-apply
   * and the fs.watch self-heal funnel through here. When a competitor has re-modified Claude Code on
   * a surface the user chose (typically via take-over), we RECLAIM it — restore the verified original
   * (from our own byte-exact backup) and re-apply — up to `MAX_RECLAIM_ATTEMPTS`, so Awaitful wins
   * against a passive competitor without an endless patch-war against an aggressive one. Past the cap
   * (or when pristine isn't recoverable) we yield honestly: Awaitful never touches another extension's
   * files, so we tell the user to disable it. Automatic (re)apply never shows "reload to activate" —
   * only the explicit user enable does — so a competitor that keeps re-patching can't trap the status
   * bar in a reload loop; we just earn in the status bar. `interactive` gates the conflict notification
   * (off at startup so a fresh window doesn't nag; on for the live watcher).
   */
  private syncWebviewPatch(chosen: WebviewSurface, interactive: boolean): void {
    const a = this.patch.assess();
    const buildId = a.target?.buildId ?? 'unknown';

    // Ours (or a clean build we can patch): apply idempotently and reset the reclaim budget.
    if (a.state === 'our-patch-present' || a.state === 'our-patch-stale' || a.state === 'clean-pristine') {
      const res = this.patch.apply(false);
      this.reportPatchOutcome(res.ok);
      if (res.ok) {
        this.setReclaim(buildId, 0);   // won and stable → reset the reclaim budget
        this.activateWebviewSurface(chosen);
      } else {
        this.stepBackToStatusBar(interactive);
      }
      return;
    }

    // A competitor re-modified CC on the surface the user chose. Reclaim it (bounded across reloads).
    if (a.state === 'modified' && a.recoverable === true) {
      const attempts = this.getReclaim(buildId);
      if (attempts < MAX_RECLAIM_ATTEMPTS) {
        const res = this.patch.apply(true); // restore verified pristine + re-apply over the competitor
        this.reportPatchOutcome(res.ok);
        if (res.ok) {
          this.setReclaim(buildId, attempts + 1);
          this.activateWebviewSurface(chosen);
          return;
        }
      }
      // Lost the patch-war (or reclaim failed) → yield and guide the user honestly.
      this.recipeClient.report('conflict');
      this.stepBackToStatusBar(interactive);
      if (interactive) this.notifyCompetitorConflict(chosen, a.foreign?.vendor);
      return;
    }

    // 'modified' with no recoverable original, or unknown-build / no-target: not active here.
    this.recipeClient.report(a.state === 'modified' ? 'conflict' : 'unknown-build');
    this.stepBackToStatusBar(interactive);
    if (interactive) {
      if (a.state === 'modified') this.notifyCompetitorConflict(chosen, a.foreign?.vendor);
      else this.notifyWebviewSurfacePaused(chosen, a.target?.buildId);
    }
  }

  private getReclaim(buildId: string): number { return this.reclaimAttempts.get(buildId) ?? 0; }
  private setReclaim(buildId: string, n: number): void {
    if (n <= 0) this.reclaimAttempts.delete(buildId); else this.reclaimAttempts.set(buildId, n);
  }

  /** Fall back to the working status-bar surface; `refresh` re-renders state (off during startup). */
  private stepBackToStatusBar(refresh: boolean): void {
    if (!isWebviewSurface(this.activeSurface)) return;
    this.activeSurface = 'status-bar';
    this.surface.end();
    if (refresh) { this.applyState(this.activeState()); this.syncPanel(); }
  }

  // Notified at most once per (competitor, surface) per session — never nag on every fs event.
  private readonly pausedNotified = new Set<string>();

  /** Honest guidance when a competitor keeps re-modifying CC and we've stopped fighting the war. */
  private notifyCompetitorConflict(id: WebviewSurface, vendor: string | undefined): void {
    const who = vendor ?? 'Another extension';
    const key = `conflict:${who}:${id}`;
    if (this.pausedNotified.has(key)) return;
    this.pausedNotified.add(key);
    void vscode.window.showWarningMessage(
      `Awaitful: ${who} keeps re-modifying Claude Code and overwriting the ${surfaceLabel(id)}. Awaitful never changes another extension's files, so disable ${who} to use the ${surfaceLabel(id)} - status-bar mode is active and earning meanwhile.`,
      'Manage extensions',
    ).then((pick) => {
      // We can't disable another extension ourselves (no VS Code API, and it would be user-hostile);
      // we just open the Extensions view so the user can disable it with one click.
      if (pick === 'Manage extensions') void vscode.commands.executeCommand('workbench.view.extensions');
    });
  }

  // Tell the user once per build when their premium surface pauses because we don't yet support this
  // Claude Code version — otherwise the status bar silently reverts to the lower rate with no signal.
  private notifyWebviewSurfacePaused(id: WebviewSurface, buildId: string | undefined): void {
    const key = `unsupported:${buildId ?? 'unknown'}`;
    if (this.pausedNotified.has(key)) return;
    this.pausedNotified.add(key);
    vscode.window.showInformationMessage(
      `Awaitful: the ${surfaceLabel(id)} surface is paused for this Claude Code version - status-bar mode is active and earning. It will resume automatically when support for this version lands.`,
    );
  }

  /** Make a webview placement the active surface and (re)point its slate poll at it. */
  private activateWebviewSurface(id: WebviewSurface): void {
    this.activeSurface = id;
    if (!this.webviewSlate || this.webviewSlatePlacement !== id) {
      this.webviewSlate?.dispose();
      this.webviewSlate = new SlateCache(this.base, id);
      this.webviewSlatePlacement = id;
      this.webviewSlate.refresh(this.currentToken).catch(() => {});
      this.webviewSlate.startPolling(60_000, () => this.currentToken);
    }
  }

  /** The webview placement the user last chose and still consents to, or undefined. */
  private chosenWebviewSurface(): WebviewSurface | undefined {
    const id = this.context.globalState.get<string>(WEBVIEW_SURFACE_KEY);
    if (id && isWebviewSurface(id) && this.consent.isGranted(id)) return id;
    // Migration: users who enabled thinking-line before this key existed have the consent but no
    // stored placement — honour that legacy consent so they don't silently drop to status-bar (with
    // an orphaned patch) on upgrade. `chooseWebviewSurface` writes the key the next time they pick.
    if (id === undefined && this.consent.isGranted('thinking-line')) return 'thinking-line';
    return undefined;
  }

  /** Grant consent for the chosen webview placement, drop the other (mutually exclusive), persist, activate. */
  private async chooseWebviewSurface(id: WebviewSurface): Promise<void> {
    const other: WebviewSurface = id === 'thinking-line' ? 'chat-banner' : 'thinking-line';
    await this.consent.grant(id);
    await this.consent.revoke(other);
    await this.context.globalState.update(WEBVIEW_SURFACE_KEY, id);
    this.activateWebviewSurface(id);
  }

  /** Drop any webview-surface choice (both consents + the persisted pointer) — back to status bar. */
  private async clearWebviewChoice(): Promise<void> {
    await this.consent.revoke('thinking-line');
    await this.consent.revoke('chat-banner');
    await this.context.globalState.update(WEBVIEW_SURFACE_KEY, undefined);
  }

  /** The chosen chat-banner glow style, validated against the shipped registry (never trusted raw). */
  /** The configured ad spinner. A cosmetic preference, so unknown ids quietly fall back. */
  /**
   * Does this developer want to see advertiser logos? Theirs to choose: they own the FRAME the ad is
   * drawn in (spinner, logo), never the MESSAGE (the line and its link, which always render - that is
   * what the advertiser actually bought, and what golden rule 3 bills for).
   *
   * Defaults to on: an advertiser who bothered to supply a logo has earned it, and a logo makes it
   * plainer that the line is an ad and whose it is, which serves the developer too.
   */
  private showBrandLogo(): boolean {
    return vscode.workspace.getConfiguration('awaitful').get<boolean>('adBrandLogo') ?? true;
  }

  private adSpinner(): AdSpinner {
    return getSpinner(vscode.workspace.getConfiguration('awaitful').get<string>('adSpinner'));
  }

  /** The spinner as creative-payload fields; empty frames (spinner "none") send nothing. */
  private spinnerPayload(): { spinnerFrames?: string[]; spinnerIntervalMs?: number } {
    const s = this.adSpinner();
    return s.frames.length ? { spinnerFrames: [...s.frames], spinnerIntervalMs: s.intervalMs } : {};
  }

  customizeAd(): void {
    AwaitfulPanel.openOrReveal(
      this.context,
      (msg) => this.handlePanelMessage(msg),
      this.buildPanelState(),
    ).navigate('ad');
    void this.refreshAccount();
  }

  private chatBannerStyle(): string {
    const s = this.context.globalState.get<string>(BANNER_STYLE_KEY);
    return s && GLOW_THEMES.some((t) => t.id === s) ? s : DEFAULT_GLOW_THEME;
  }

  private async setChatBannerStyle(style: string): Promise<void> {
    if (!GLOW_THEMES.some((t) => t.id === style)) return;
    await this.context.globalState.update(BANNER_STYLE_KEY, style);
    // Live preview: if the banner is on screen right now, restyle the active creative so the shim
    // repaints within a couple seconds — no need to wait for the next thinking turn.
    if (this.activeSurface === 'chat-banner') this.surface.restyle({ bannerStyle: style });
    this.syncPanel();
  }

  /** The chosen chat-banner outline frame, validated against the shipped set. */
  private chatBannerFrame(): string {
    const f = this.context.globalState.get<string>(BANNER_FRAME_KEY);
    return f && BANNER_FRAMES.some((x) => x.id === f) ? f : DEFAULT_BANNER_FRAME;
  }

  private async setChatBannerFrame(frame: string): Promise<void> {
    if (!BANNER_FRAMES.some((x) => x.id === frame)) return;
    await this.context.globalState.update(BANNER_FRAME_KEY, frame);
    if (this.activeSurface === 'chat-banner') this.surface.restyle({ bannerFrame: frame });
    this.syncPanel();
  }

  private async restorePatchedFiles(): Promise<void> {
    // Drop the choice FIRST so re-apply-on-activation cannot silently re-patch and
    // undo the restore (the surface only comes back when the user re-enables it).
    await this.clearWebviewChoice();
    this.activeSurface = 'status-bar';
    this.surface.end();
    // "Restore original files" undoes every Awaitful modification — including the terminal status
    // line's settings.json edit. (Thinking hooks stay: they're auto-managed and status-bar mode
    // still needs them.)
    if (this.terminalEnabled) await this.disableTerminal();

    const r = this.patch.restore();
    this.applyState(this.activeState());
    this.syncPanel();

    if (r.ok && r.changed) {
      const pick = await vscode.window.showInformationMessage(
        'Awaitful: restored Claude Code to its original files. Reload the window to drop the changes from the running editor.',
        'Reload window',
      );
      if (pick === 'Reload window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else if (r.ok && r.assessed) {
      // We looked at every target and none carries our patch: a verified clean bill.
      vscode.window.showInformationMessage('Awaitful: nothing to restore - no Awaitful changes are present.');
    } else if (r.ok) {
      // ok but NOT assessed: no recipe resolved for this build, so we could not actually check. Do not
      // claim the editor is clean on a check that never ran - a competitor may have patched over us.
      vscode.window.showWarningMessage(
        'Awaitful: could not verify Claude Code for this build, so nothing was changed. If another extension has modified it, restore from that extension. The file path is in the panel.',
      );
    } else {
      vscode.window.showWarningMessage('Awaitful: could not restore automatically. See the panel for the file path.');
    }
  }

  /**
   * Switch the earning surface back to the status bar. The status bar is the always-available
   * default; because surfaces are mutually exclusive and the thinking line modifies files,
   * switching to it undoes the thinking-line patch and revokes its consent (so it doesn't
   * silently re-apply on the next activation). Earning continues immediately in the status bar.
   */
  private async switchToStatusBar(): Promise<void> {
    const a = this.patch.assess();
    const patched = a.state === 'our-patch-present' || a.state === 'our-patch-stale';
    if (this.activeSurface === 'status-bar' && !patched) {
      // Already the active surface with nothing of ours on disk — nothing to switch.
      this.syncPanel();
      return;
    }

    await this.clearWebviewChoice();
    this.activeSurface = 'status-bar';
    this.surface.end();

    const r = this.patch.restore();
    this.applyState(this.activeState());
    this.syncPanel();

    if (r.ok && r.changed) {
      const pick = await vscode.window.showInformationMessage(
        'Awaitful: switched to status-bar mode. Reload the window to drop the thinking-line changes from the running editor.',
        'Reload window',
      );
      if (pick === 'Reload window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else if (!r.ok) {
      vscode.window.showWarningMessage(
        'Awaitful: switched to status-bar mode, but could not fully restore Claude Code automatically - see the thinking-line page for the file path.',
      );
    }
  }

  /** Reload the VS Code window (used by the status-bar "reload to activate" item). */
  reloadWindow(): void {
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  openPanel(): void {
    AwaitfulPanel.openOrReveal(
      this.context,
      (msg) => this.handlePanelMessage(msg),
      this.buildPanelState(),
    );
    void this.refreshAccount();
  }

  // showMenu kept as the legacy alias — now opens the panel.
  async showMenu(): Promise<void> {
    this.openPanel();
  }

  async signIn(): Promise<void> {
    const token = await this.auth.signIn();
    if (!token) return;
    await this.auth.saveToken(token);
    this.currentToken = token;
    try {
      await this.slate.refresh(token);
    } catch { /* non-fatal */ }
    this.applyState(this.activeState());
    this.syncPanel();
    void this.refreshAccount(true);
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.currentToken = undefined;
    this.accountEmail = undefined;
    this.earningsToday = undefined;
    this.unredeemedUsd = undefined;
    this.applyState('signin');
    this.syncPanel();
  }

  /** Resume from a soft pause: earn again and re-apply the patch if consented. */
  enable(): void {
    this.enabled = true;
    this.pauseRestoreFailed = false; // no longer paused; the pause-time restore state is moot
    void this.context.globalState.update(ENABLED_KEY, true);
    this.reapplyWebviewSurface(); // re-apply the patch we removed on pause
    this.applyState(this.activeState());
    this.syncPanel();
  }

  /**
   * Soft-pause ("deactivate"): stop earning AND return Claude Code to pristine,
   * while staying in the status bar as "Paused" and keeping the user signed in +
   * consented. Resume re-applies. This is the visible, forget-proof alternative to
   * a hard VS Code disable. The patch is restored, not just idle.
   */
  disable(): void {
    this.enabled = false;
    void this.context.globalState.update(ENABLED_KEY, false);
    this.haltImpression();              // stop any in-flight status-bar accrual immediately
    // Capture whether the restore left Claude Code genuinely un-ours. The panel says "Claude Code is
    // left unmodified" while paused, and that must be TRUE. restore() returns ok:false in exactly the
    // case that makes it false: it found our patch on disk but could not write pristine back (a
    // read-only extensions dir, a disk full). Then our bytes remain, and the banner must say so rather
    // than give a false all-clear. A throw is treated the same way - we did not confirm removal.
    let restored = false;
    try {
      restored = this.patch.restore().ok;
    } catch { /* fail-safe */ }
    this.pauseRestoreFailed = !restored;
    this.activeSurface = 'status-bar';  // patch restored → thinking-line is no longer live
    this.applyState('off');
    this.syncPanel();
  }

  async openDashboard(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(`${apiBaseUrl()}/earnings`));
  }

  about(): void {
    vscode.window.showInformationMessage(
      "Awaitful - monetise your AI agent's thinking time. Click the status bar item to manage.",
    );
  }

  visitAd(): void {
    if (this.activeAdUrl) {
      void vscode.env.openExternal(vscode.Uri.parse(this.activeAdUrl));
      this.enqueue('click');
    }
  }
}
