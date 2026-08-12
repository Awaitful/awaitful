import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { LINKS, GLOW_KEYFRAMES, AD_FORMATS, getSpinner, frameAt, allFormatSettings, type AdFormatId, type ElementId, type ElementValue } from '@awaitful/shared';
import type { AdEvent, StatusBarState, PlacementId, Creative, RemoteSurfaceId, AdSpinner, AdPreferences, SurfaceApplyFailure } from '@awaitful/shared';
import { apiBaseUrl, REDUCE_MOTION_SETTING } from '../lib/config.js';
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
import { PatchEngine, type PatchState } from '../patch/engine.js';
import { scanTargets, anyNewerThanOurs } from '../patch/scan.js';
import {
  extensionsOnDisk, extensionsElsewhere, extensionDisplayName, extensionsRoot, homedir,
} from '../patch/targets.js';

/** One installed extension as the conflict lookup sees it; `host` marks a copy in another editor. */
interface ExtensionSnapshot {
  id: string;
  label: string;
  active: boolean;
  host?: VendorHost;
  /** Uninstalled in THIS editor but still loaded, so it keeps running until the window reloads. */
  pendingRemoval?: boolean;
}
import { sha256 as sha256Hex } from '../patch/hash.js';
import { installedLookup, type VendorHost } from '../patch/foreign.js';
import { BackupStore } from '../patch/backup.js';
import { PatchWatcher } from '../patch/watch.js';
import { RecipeClient } from '../patch/recipeClient.js';
import { SHIM_VERSION } from '../patch/recipe.js';
import { HookServer, type SurfaceBeacon } from '../hooks/server.js';
import { SurfaceSession } from './surfaceSession.js';
import { SurfaceLiveness, type LivenessState } from './surfaceLiveness.js';
import { Customization } from './customization.js';
import { writePortFile } from '../hooks/setup.js';
import { AGENT_INTEGRATIONS, HOOK_PROVEN_AGENTS } from '../agents/registry.js';
import {
  detectAgents,
  initialPresence,
  cliAgents,
  statusLineAgents,
  anyCli,
  anyEditor,
  type AgentPresence,
} from '../agents/presence.js';
import { writeStatusLineScript, removeStatusLineScript, statusLineScriptPath } from '../hooks/statusLineScript.js';
import { formatTerminalLine } from './terminalFormat.js';
import { HttpError } from '../lib/http.js';
import { pickBestUpgrade } from './upgradePick.js';
import { mapApplyFailure } from './applyFailure.js';

// Persisted soft-pause state, so "Paused" survives a restart (like a real Off switch).
const ENABLED_KEY = 'awaitful.enabled';
// The chosen webview placement (thinking-line OR chat-banner) persists across restarts so the
// patch re-applies to the right surface; they are mutually exclusive and share one patch.
const WEBVIEW_SURFACE_KEY = 'awaitful.webviewSurface';
/**
 * Which surface the "your dashboard set X" toast was last shown for - ONE value, not a flag per
 * surface. A request prompts whenever it differs from what is stored, and the store is cleared once
 * the request is withdrawn or applied, so asking for the same surface again later lands.
 *
 * This replaces `awaitful.remoteSurfacePrompted.<id>` booleans, which were written true and never
 * cleared anywhere. That made the gate permanent per surface: the FIRST dashboard request for a
 * given surface was the only one that ever reached the developer. Since switching to the status bar
 * applies silently and never prompts at all, a developer who had tried the thinking line and the
 * chat banner once each got silence from the dashboard from then on - while the terminal, whose gate
 * did clear itself, kept working and made the difference look like a surface-only bug.
 *
 * Reading a different key is also what repairs an already-stuck install: the stale booleans are
 * simply never consulted again, so no migration is needed.
 */
const REMOTE_SURFACE_PROMPTED_KEY = 'awaitful.remoteSurfacePromptedFor';
const TERMINAL_ENABLED_KEY = 'awaitful.terminalEnabled';
// One-time gate for the "your dashboard asked to turn the terminal on" toast. A single key, not one
// per value: the request is a boolean, and the only prompting case is turning it ON (off needs no
// consent, so it never prompts). Cleared when the request is withdrawn, so a later ask still lands.
const REMOTE_TERMINAL_PROMPTED_KEY = 'awaitful.remoteTerminalPrompted';
// The developer removed Claude Code from inside the repair checklist and has not put it back. The
// ONE thing in that flow that cannot be read off the disk: a machine with no Claude Code extension
// looks identical whether someone is half way through a repair or never installed it. Set when a
// removal is requested from the panel, cleared the moment the extension is back.
// The agent's own extension id. Matches the panel's constant; both are checked against the same
// literal rather than passing it over the wire, so a webview message can never redirect either.
const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';
const REPAIRING_KEY = 'awaitful.repairInProgress';
/**
 * How long a started repair still counts as in progress.
 *
 * The latch used to have no expiry, on the reasoning that it clears when Claude Code comes back. It
 * does - but only then. A developer who abandons the repair, or who removes Claude Code and simply
 * carries on without it, keeps the flag forever; and on a machine that never had Claude Code the
 * clear condition can never be met at all. Both end the same way: a fresh install being told
 * "Claude Code is removed, finish the steps to put a clean copy back" about a repair nobody started.
 *
 * The flow is a handful of clicks and two reloads. Two hours is far longer than that takes and short
 * enough that walking away ends it.
 */
const REPAIR_TTL_MS = 2 * 60 * 60 * 1000;
// Which format's page the repair was started from, so a reload - now a real step in the middle of
// the flow - hands the developer back exactly where they were instead of a closed panel.
const REPAIRING_FROM_KEY = 'awaitful.repairFrom';
// Show accrued earnings in the status bar (idle state only) - a device-local privacy preference.
const SHOW_EARNINGS_KEY = 'awaitful.showEarningsInStatusBar';
// Off by default. On: reconcileRemoteSurfacePreference may apply a webview surface without the
// one-time toast - this device's own opt-in stands in for the per-surface click-through consent.
const REMOTE_CONTROL_KEY = 'awaitful.remoteControlAllowed';
// Device-local: the onboarding stepper was dismissed with its ✕. Persisted so it never returns on this
// machine (the format cards + sync toggle remain the way to change things after).
const ONBOARDING_DISMISSED_KEY = 'awaitful.onboardingDismissed';
// The extension version this machine last acknowledged in the panel. Drives the one-time post-update
// "what's new" banner: a mismatch with the running version means we updated since it was last seen.
const LAST_SEEN_VERSION_KEY = 'awaitful.lastSeenVersion';
// Latches true the first time the agent-thinking hook ever fires on this machine. Drives the panel's
// "no agent activity yet" hint: until we have seen a single thinking event, a signed-in developer is
// almost certainly on a different agent or not driving Claude Code through the extension.
const EVER_THOUGHT_KEY = 'awaitful.everThought';
// One-time, once-ever: after a user earns their first cents while still on the base status-bar
// surface, gently point them at the higher-value placements. Never shown to anyone who already
// explored (moved off status-bar or turned on the terminal) - discoverability, not a nag.
const PLACEMENT_NUDGE_KEY = 'awaitful.placementNudgeShown';
// Last account settings-version applied in THIS editor. Absent on a fresh install, so the first
// check-in inherits the account's choices - the reason the web card exists at all.
const PREFS_VERSION_KEY = 'awaitful.prefsVersion';
// Separate from PREFS_VERSION_KEY: this tracks the SURFACE/TERMINAL push version, so a format change
// lands within a slate poll without disturbing the ad-styling ratchet above (which would clobber a
// developer's local look edits if it moved on a mere surface change).
const SETTINGS_VERSION_KEY = 'awaitful.settingsVersion';
// A competitor that also patches Claude Code can overwrite our take-over on reload. We RECLAIM the
// surface (restore the verified original + re-apply) a bounded number of times — winning against a
// passive competitor — before yielding honestly to an aggressive one. Awaitful never touches another
// extension's files, so past the cap the only fix is for the user to disable the other extension.
const MAX_RECLAIM_ATTEMPTS = 3;
// Persisted reclaim budget, so a window reload cannot hand a competitor a fresh three attempts.
const RECLAIM_KEY_PREFIX = 'awaitful.reclaim.';

/**
 * Where the panel was when a reload button was clicked, so the window comes back to that page.
 *
 * A reload is a real step in the repair flows and in turning a format on, and the window used to
 * return with the panel closed - dropping the developer back at square one with no sign that the
 * step they had just taken had landed.
 */
const PANEL_RETURN_KEY = 'awaitful.panelReturn';
/** Long enough for a reload, short enough that it never surprises someone days later. A stale entry
 *  would pop the panel open on an unrelated startup, which is a window stealing focus for no reason. */
const PANEL_RETURN_TTL_MS = 5 * 60_000;
/** The views the panel can be asked to return to. A webview message may name one of these and
 *  nothing else. */
const PANEL_VIEWS: ReadonlySet<string> = new Set(['surfaces', 'detail', 'privacy']);

/** A home-relative path, for showing someone where a file is without a wall of directory names. */
function tildify(p: string): string {
  const home = homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Custody states where someone other than a clean copy of our own patch holds Claude Code's file.
 * All of them get the conflict affordance; they differ only in how much we can honestly say.
 */
const CONTESTED_STATES: ReadonlySet<PatchState> = new Set<PatchState>([
  'foreign-only',
  'ours-plus-foreign',
  'ours-plus-unknown',
  'unknown-modified',
]);

/**
 * Why a webview surface cannot be offered, keyed by what the bytes actually say. Anything absent
 * falls through to 'unsupported-build', which now means only what it says: a clean file on a build
 * we have not verified yet.
 */
export const BLOCKED_BY_STATE: Partial<Record<PatchState, PanelSurface['blockedReason']>> = {
  // There are no Claude Code files to attach to - which is exactly where the repair checklist puts
  // the developer at step two. Falling through to 'unsupported-build' blamed a version for a file
  // that was not there, and 'unsupported-build' is the one reason the guidance box ignores, so the
  // page went blank at the precise moment it had two steps left to give.
  'no-target': 'no-agent-editor',
  'foreign-only': 'foreign-conflict',
  'ours-plus-foreign': 'foreign-conflict',
  'ours-plus-unknown': 'changed-unknown',
  'unknown-modified': 'changed-unknown',
  'ours-unverified': 'ours-unverified',
  unreadable: 'unreadable',
  'no-recipe': 'unsupported-build',
};

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
   * that switching this format's logo back on restores what the ad really had, and never invents a
   * logo for an ad that never carried one.
   */
  private activeIconUrl: string | undefined;
  private activePlacement: PlacementId = 'status-bar';
  // True while the status-bar ad is paused because Claude is waiting for the user
  // (a permission prompt / elicitation) — accrual is suspended so idle time never bills.
  private thinkingPaused = false;
  // Have we ever seen the agent think on this machine? Latched, persisted to globalState. False means
  // the "no agent activity yet" hint shows; the first thinking hook flips it true for good.
  private everThought = false;
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

  /**
   * Which agents are actually here, on both axes (agents/presence.ts). Cached because
   * buildPanelState() runs on every sync and must never hit the filesystem; refreshed at exactly
   * the four moments the answer can change — activation, vscode.extensions.onDidChange, panel open,
   * and the first thinking hook. No timer: this is a fact that changes twice in a user's life.
   */
  private agentPresence: AgentPresence[] = initialPresence();
  /**
   * Set when the no-agent self-heal could not finish clearing an older build's entries out of the
   * agent's settings, so the panel must not claim we left them untouched. Same honesty gate as
   * pauseRestoreFailed: a claim about the disk is only made when the disk confirmed it.
   */
  private agentCleanupFailed = false;

  /** Per-format look of the ad on this machine. The one place customization values live. */
  private readonly custom: Customization;

  /**
   * Whether our webview surface is genuinely rendering. Patch-present is NOT the same claim, and
   * treating it as one is how the panel came to say "active and earning" over a surface that
   * showed nothing and billed nothing.
   */
  private readonly liveness = new SurfaceLiveness(
    (s) => this.onLivenessChange(s),
    SHIM_VERSION,
  );
  /** Set once we have demoted to the status bar over a proven non-render, so we do it only once. */
  private livenessSteppedBack = false;

  private readonly account: AccountClient;
  private readonly patch: PatchEngine;
  private readonly recipeClient: RecipeClient;
  private accountEmail: string | undefined;
  private accountName: string | undefined;
  private earningsToday: string | undefined;
  private unredeemedUsd: string | undefined;
  /** The surface value last reported via reportAppliedSurface(), so a steady activeSurface does not
   *  re-POST every refreshAccount cycle. Reset to undefined on a failed report so the next cycle
   *  retries. */
  private lastReportedSurface: RemoteSurfaceId | undefined;
  /** Last terminal state reported, so an unchanged one is not re-sent on every check-in. */
  private lastReportedTerminal: boolean | undefined;
  /** The coarse apply-failure to report for THIS device: null once the last apply succeeded (or none was
   *  attempted). Set at the single choke point (enableWebviewSurface / switchToStatusBar) so it is honest
   *  regardless of what triggered the attempt. Lets the dashboard show WHY a format did not switch on. */
  private lastApplyFailure: SurfaceApplyFailure | null = null;
  /** The failure value last reported, so a steady state does not re-POST every cycle. `undefined` = never
   *  reported, so the first report always goes out. */
  private lastReportedFailure: SurfaceApplyFailure | null | undefined = undefined;
  /** Last "Control from web" state reported, so an unchanged one is not re-sent every check-in. */
  private lastReportedControl: boolean | undefined;
  private showEarningsInStatusBar = true;
  private remoteControlAllowed = false;
  private lastAccountFetchMs = 0;
  /** Set on each explicit sign-in, consumed once by the first post-sign-in refresh to open the panel on
   *  the setup stepper. In-memory only: a fresh sign-in re-opens, a window reload does not (that is not a
   *  sign-in), and nothing is persisted - so there is no state to orphan. */
  private onboardingOpenPending = false;
  /** True when the running version differs from the one this machine last saw - drives the one-time
   *  "what's new" banner. Computed once in the constructor. Stays visible for the session it is
   *  detected in (noteWhatsNewShown persists the version so the NEXT launch is silent), and clears
   *  immediately if the developer acts on it (markVersionSeen). Either way it never nags twice. */
  private justUpdated = false;
  /** The account's web-set format preference from the last /v1/me. A non-null value - including
   *  "status-bar" - is a deliberate format choice made on the dashboard, so the onboarding stepper
   *  treats its format step as settled and never pushes a different format against it. Without this, a
   *  status-bar dashboard choice reverted the device and the stepper kept nagging to re-enable the
   *  chat banner - the choice it was told to respect. */
  private remoteSurfacePref: RemoteSurfaceId | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    const base = apiBaseUrl();
    this.base = base;

    this.custom = new Customization(context.globalState);
    this.ui = new StatusBarUI(() => this.adSpinner('status-bar'));
    this.auth = new DeviceLink(context.secrets);
    this.slate = new SlateCache(base, 'status-bar');
    this.killswitch = new KillswitchMonitor(base);
    this.queue = new EventQueue(base, () => this.currentDeviceId, () => this.currentToken);
    this.placement = new StatusBarPlacement(this.ui, () => this.statusBarEarning());
    this.consent = new ConsentStore(context.globalState);
    this.enabled = context.globalState.get<boolean>(ENABLED_KEY) !== false; // default on
    this.terminalEnabled = context.globalState.get<boolean>(TERMINAL_ENABLED_KEY) === true; // default off
    this.showEarningsInStatusBar = context.globalState.get<boolean>(SHOW_EARNINGS_KEY) !== false; // default on
    this.remoteControlAllowed = context.globalState.get<boolean>(REMOTE_CONTROL_KEY) === true; // default off
    this.everThought = context.globalState.get<boolean>(EVER_THOUGHT_KEY) === true; // default false
    // Post-update detection. A fresh install (no stored version) shows nothing new but records the
    // current version, so the NEXT update is caught. A stored version that differs from the running
    // one means we updated since it was last seen - show the banner until it is acknowledged.
    const runningVersion = context.extension.packageJSON.version as string;
    const lastSeenVersion = context.globalState.get<string>(LAST_SEEN_VERSION_KEY);
    if (lastSeenVersion === undefined) {
      void context.globalState.update(LAST_SEEN_VERSION_KEY, runningVersion);
    } else if (lastSeenVersion !== runningVersion) {
      this.justUpdated = true;
    }
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
      // Resolve a marker token against what is ACTUALLY installed, so we never tell someone to turn
      // off a tool they removed. Read lazily: extensions can be installed mid-session.
      (token) => installedLookup(this.installedExtensions())(token),
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
    // Drop stored "originals" that carry a patch marker. These are residue from deriving pristine
    // out of contaminated bytes before that was validated; they can never match a legitimate recipe
    // hash, so they are dead weight that can run to hundreds of megabytes.
    this.patch.purgeContaminatedBackups();
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
        // Claim the agent's hook routing for the window the developer is actually looking at.
        // ~/.awaitful/port is a single file every window overwrites, so without this the thinking
        // hooks keep going to whichever window happened to start last - which may have no Claude
        // Code panel in view at all, leaving the window they ARE using dark and earning nothing.
        if (s.focused && this.hookServer) void writePortFile(this.hookServer.port).catch(() => {});
      }),
    );

    // Reduced motion is read when the ad goes up, so a change while one is already showing would
    // otherwise not land until the next thinking turn. refreshAd() re-runs showAd() with the current
    // preference, which either starts the ticker or drops to the static dot.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(REDUCE_MOTION_SETTING)) this.ui.refreshAd();
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
      onRendered: (b) => { this.surface.rendered(b); this.notePaint(b); this.confirmSurfaceLive(); },
      onVisible: (b) => { this.surface.visible(b); this.notePaint(b); this.confirmSurfaceLive(); },
      onClick: (b) => { this.notePaint(b); this.onSurfaceClick(b); },
      getTerminalLine: () => this.terminalLine(),
      onTerminalTick: () => this.onTerminalTick(),
      onShimHello: (shimId, v) => this.liveness.shimHello(shimId, v),
      onAttest: (a) => this.liveness.attest(a),
    });
    const port = await this.hookServer.start();
    await writePortFile(port);
    // Install thinking-detection for every agent that is ACTUALLY here. Agent-agnostic via the
    // registry so a future agent is one adapter + registry entry — see agents/*. With no agent we
    // write nothing at all, and clean up anything an older build left behind.
    await this.refreshPresence();
    if (this.hasCliAgent()) {
      for (const agent of cliAgents(this.agentPresence)) {
        try { await agent.installThinkingHooks(); } catch { /* fail-safe: a config write fault must never crash activation */ }
      }
      // Re-assert the terminal status line if it was left enabled from a previous session (idempotent).
      if (this.terminalEnabled && statusLineAgents(this.agentPresence).length > 0) await this.ensureTerminalInstalled();
    } else {
      await this.selfHealNoAgent();
    }
    // The user may install (or remove) an agent's VS Code extension without reloading the window.
    this.context.subscriptions.push(vscode.extensions.onDidChange(() => { void this.onPresenceChanged(); }));

    // A reload is a real step in the repair checklist - it is what makes VS Code actually delete the
    // removed extensions, and what lets Claude Code load the patched bytes - so hand the developer
    // straight back to the page they were on instead of a closed panel.
    //
    // BEFORE the network block below, and that is the point. It used to run after it, so an
    // unreachable server (or a slow one that threw) skipped the clear entirely and left the repair
    // latched for its full two hours: the box stayed up on a machine where the fix had worked, and
    // the activate button stayed hidden behind it. Finishing a local repair must not depend on
    // reaching the internet.
    void this.resumeAfterReload();

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

      // refreshAccount otherwise only fires reactively, which misses a remote surface preference set
      // from the web dashboard while this window sits idle. Coarse on purpose - the 15s throttle
      // inside refreshAccount makes this cheap, and a surface preference is not time-sensitive.
      const remoteSurfaceTimer = setInterval(() => void this.refreshAccount(), 5 * 60_000);
      this.context.subscriptions.push({ dispose: () => clearInterval(remoteSurfaceTimer) });

      // The slate poll already carries the account's settings version every 60s, so a change made
      // on the web can be noticed within a minute instead of five - by comparing one integer we
      // already have in memory. No extra request, and nothing new leaves the machine; we only fetch
      // the settings themselves once the version actually moves.
      const prefsTimer = setInterval(() => {
        const v = this.slate.prefsVersion;
        if (v !== undefined && v !== this.context.globalState.get<number>(PREFS_VERSION_KEY)) {
          void this.refreshAccount(true);
        }
        // Surface/terminal pushes carry their own version so a format change lands within a minute
        // without touching the styling ratchet above. Stored optimistically: the surface reconcile is
        // idempotent (it compares the requested surface to the active one), so a missed refresh still
        // applies on the next natural one - the version only decides when we look sooner.
        const sv = this.slate.settingsVersion;
        if (sv !== undefined && sv !== this.context.globalState.get<number>(SETTINGS_VERSION_KEY)) {
          void this.context.globalState.update(SETTINGS_VERSION_KEY, sv);
          void this.refreshAccount(true);
        }
      }, 60_000);
      this.context.subscriptions.push({ dispose: () => clearInterval(prefsTimer) });
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

  // ── Agent presence ──────────────────────────────────────────────────────

  private async refreshPresence(): Promise<void> {
    this.agentPresence = await detectAgents(
      (id) => vscode.extensions.getExtension(id) !== undefined,
      // A thinking hook that has already fired here proves the CLI whatever the scan concludes.
      // Without this, a detector that is wrong about an unusual install could switch off someone
      // who is already earning.
      { provenCli: this.everThought ? HOOK_PROVEN_AGENTS : [] },
    );
  }

  /** False means nothing on this machine can produce a thinking event, so no surface can earn. */
  private hasCliAgent(): boolean {
    return anyCli(this.agentPresence);
  }

  /**
   * The installed-extension set changed — the user may have just installed the agent's VS Code
   * extension. Re-detect and, if an agent APPEARED, install what activation skipped so they do not
   * have to reload to start earning.
   *
   * Deliberately not symmetric: an agent disappearing mid-session does not rip hooks out from under
   * a live window. That cleanup runs at the next activation (selfHealNoAgent), where it cannot race
   * a session that is still using them.
   */
  /**
   * Every extension this machine has, active or not.
   *
   * Two sources, because neither alone is the truth. `vscode.extensions.all` lists only ENABLED
   * extensions, so a tool the developer merely switched off disappears from it - and a switched-off
   * tool's change is still sitting in Claude Code's file. The disk listing catches those, at the
   * cost of a display name, which is read only for the directory that actually matched.
   *
   * Active entries win on id, so a running extension keeps its real display name.
   *
   * A third source fills what is left: the same machine's OTHER editors. A patch tool edits the
   * agent's files wherever it finds them on disk, so a copy installed only in another editor is
   * still changing the bytes this window loads - and looked, from here, exactly like a tool that had
   * been uninstalled. Lowest priority by construction: anything installed here is what this window
   * can actually act on, so a far copy never displaces a near one.
   */
  private installedExtensions(): ExtensionSnapshot[] {
    const out = new Map<string, ExtensionSnapshot>();
    const label = (dir: string, id: string) =>
      // Fall back to the id's name half rather than reading every package.json on disk.
      extensionDisplayName(dir) ?? id.split('.').slice(1).join('.') ?? id;
    const fromRegistry = extensionsOnDisk();
    for (const d of fromRegistry) {
      out.set(d.id.toLowerCase(), { id: d.id, label: label(d.dir, d.id), active: false });
    }
    // The registry is what is INSTALLED; this list is what is LOADED, and between an uninstall and
    // the reload that applies it they disagree. That gap used to be invisible: a running extension
    // overwrote its own registry absence with active:true, so the moment the developer clicked
    // "Remove", the tool read as fully installed again and its step could not tick until a reload.
    // The click looked like it had done nothing.
    const root = extensionsRoot();
    const registered = new Set(fromRegistry.map((d) => d.id.toLowerCase()));
    for (const e of vscode.extensions.all) {
      const pkg = e.packageJSON as { displayName?: string; name?: string } | undefined;
      const key = e.id.toLowerCase();
      // Built-ins live outside the user extensions directory and are never in that registry, so
      // they must not be read as half-uninstalled.
      const userInstalled = typeof e.extensionPath === 'string' && e.extensionPath.startsWith(root);
      out.set(key, {
        id: e.id, label: pkg?.displayName ?? pkg?.name ?? e.id, active: true,
        pendingRemoval: userInstalled && !registered.has(key),
      });
    }
    for (const e of extensionsElsewhere()) {
      const key = e.id.toLowerCase();
      if (out.has(key)) continue;
      out.set(key, {
        id: e.id, label: label(e.dir, e.id), active: false,
        host: { label: e.editor, dir: e.root, extensionDir: e.dir, pendingRemoval: e.pendingRemoval },
      });
    }
    return [...out.values()];
  }

  /**
   * Is the agent's editor extension INSTALLED, as opposed to merely present on disk?
   *
   * Uninstalling drops the registry entry at once; the folder survives until the whole app restarts.
   * So a lingering directory is not an install, and treating it as one is what let the repair
   * checklist believe Claude Code had been put back when nothing had happened yet.
   */
  private agentExtensionInstalled(): boolean {
    return this.installedExtensions().some(
      (e) => e.id.toLowerCase() === CLAUDE_CODE_EXT_ID.toLowerCase() && !e.pendingRemoval,
    );
  }

  /**
   * Remove an extension the developer asked to remove, then say what happened.
   *
   * Falls back to opening that extension's page rather than failing silently: the uninstall command
   * is not part of VS Code's documented API surface, so a future version could rename it, and the
   * developer must still end up somewhere they can finish the job by hand.
   */
  private async removeExtension(id: string, from?: string): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
      // ONLY Claude Code's removal latches the repair, and the distinction is load-bearing. The
      // latch means "Claude Code was taken off as part of this fix", which is the single thing the
      // disk cannot tell us later. Setting it for any removal made it mean "some removal happened",
      // and the checklist read that plus a present Claude Code as "removed and reinstalled" - so
      // removing the competitor alone ticked all four steps at once.
      if (id === CLAUDE_CODE_EXT_ID) {
        // Latch BEFORE the panel re-renders: removing Claude Code is what makes the file stop being
        // contested, so without this the checklist loses its own reason to exist at exactly the
        // moment the developer does what it asked.
        await this.context.globalState.update(REPAIRING_KEY, Date.now());
        if (from) await this.context.globalState.update(REPAIRING_FROM_KEY, from);
      }
      // Re-read presence NOW rather than waiting for extensions.onDidChange: this same call is about
      // to rebuild the panel, and a stale cache would have it describe a world one step behind.
      await this.refreshPresence();
      // The panel re-renders itself from vscode.extensions.onDidChange, so the step ticks on its own.
      vscode.window.showInformationMessage(`Awaitful: removed ${id}.`);
    } catch {
      const pick = await vscode.window.showWarningMessage(
        `Awaitful: could not remove ${id} automatically. Its page is open - use Uninstall there.`,
        'Show it',
      );
      if (pick === 'Show it') await this.showExtension(id);
      else await this.showExtension(id);
    }
    this.syncPanel();
  }

  /** Install an extension by id (only ever the agent's own - see the install-extension message). */
  private async addExtension(id: string): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
      vscode.window.showInformationMessage(`Awaitful: installed ${id}. Reload the window to finish.`);
    } catch {
      await this.showExtension(id);
    }
    this.syncPanel();
  }

  /** Surface one extension: filter the Extensions view to it AND open its own page. */
  private async showExtension(id: string): Promise<void> {
    try { await vscode.commands.executeCommand('workbench.extensions.search', id); } catch { /* view may be unavailable */ }
    try { await vscode.commands.executeCommand('extension.open', id); } catch { /* older VS Code: the search above already surfaced it */ }
  }

  /**
   * Is a repair in flight - Claude Code removed from the checklist and not yet put back?
   *
   * Clears itself the moment the extension is present again, so the latch cannot outlive the thing
   * it describes: a developer who repairs, reloads, and comes back weeks later sees no trace of it.
   * Deliberately the only remembered bit in the whole flow; everything else is read off the disk.
   */
  private isRepairing(): boolean {
    const at = this.context.globalState.get<number | boolean>(REPAIRING_KEY);
    // `true` is the old shape, from before this carried a time. Unexpirable by construction, so it
    // is treated as already expired - which also releases anyone the previous build left stuck.
    if (typeof at !== 'number') return false;
    return Date.now() - at < REPAIR_TTL_MS;
  }

  /**
   * Drop the repair latch once Claude Code is genuinely back.
   *
   * Called ONLY from onPresenceChanged, where presence has just been re-read. The first cut cleared
   * it from the getter instead, which ran during the very syncPanel() that follows the uninstall -
   * while the presence cache still listed the extension. So the latch was set and then cleared
   * microseconds later, off a stale read, and the checklist lost its place exactly as before.
   */
  private async clearRepairIfDone(): Promise<void> {
    if (!this.isRepairing()) return;
    if (!anyEditor(this.agentPresence)) return;
    await this.context.globalState.update(REPAIRING_KEY, undefined);
    await this.context.globalState.update(REPAIRING_FROM_KEY, undefined);
  }

  /**
   * Finish the repair on ACTIVATION, never on the install itself.
   *
   * Installing Claude Code makes the extension present immediately, so clearing on that event tore
   * the checklist away before its last step could be read, let alone clicked. And that last step is
   * load-bearing: Claude Code may already have loaded its webview from the unpatched file, so the
   * bytes Awaitful writes only reach the screen after a reload. Completing here means the reload IS
   * the completion - the developer clicks it, the window comes back, and the box is gone because
   * the work is genuinely done.
   */
  /**
   * Everything that has to happen because a reload just took place. One entry point, so the two
   * reasons to reopen the panel cannot both fire and navigate it to different pages.
   */
  private async resumeAfterReload(): Promise<void> {
    const restored = await this.restorePanelView();
    await this.finishRepairOnActivation(restored);
  }

  private async finishRepairOnActivation(alreadyOpened = false): Promise<void> {
    if (!this.isRepairing()) return;
    const from = this.context.globalState.get<string>(REPAIRING_FROM_KEY);
    const complete = anyEditor(this.agentPresence);
    if (complete) await this.clearRepairIfDone();
    // Either way, hand them back the page they started from: mid-repair to carry on, or completed so
    // they can turn the format on. Skipped when the reload already restored a page - that note was
    // written by the click itself, so it is the more specific answer.
    if (!alreadyOpened && isWebviewSurface(from ?? '')) this.openPanel(from as WebviewSurface);
  }



  private async onPresenceChanged(): Promise<void> {
    const hadEditor = anyEditor(this.agentPresence);
    const had = this.hasCliAgent();
    await this.refreshPresence();
    // Claude Code just appeared: patch it NOW rather than leaving the developer's chosen format
    // dead until something else happens to re-run activation. Installing an extension from the
    // repair checklist used to land a clean Claude Code that nothing then patched.
    if (!hadEditor && anyEditor(this.agentPresence)) this.reapplyWebviewSurface();
    if (!had && this.hasCliAgent()) {
      for (const agent of cliAgents(this.agentPresence)) {
        try { await agent.installThinkingHooks(); } catch { /* fail-safe */ }
      }
      if (this.terminalEnabled) await this.ensureTerminalInstalled();
      this.agentCleanupFailed = false;
    }
    this.applyState(this.activeState());
    this.syncPanel();
  }

  /**
   * No agent CLI here, so anything an older Awaitful wrote into an agent's config points at a
   * product that is not installed. Remove ONLY our own entries — both removers are marker-scoped
   * (`# awaitful`), restore the user's own status line exactly, and no-op when the agent's settings
   * file does not exist, so a remove is never the write that creates ~/.claude. We never delete the
   * user's file and never touch a key we did not write.
   *
   * Iterates EVERY integration rather than the presence-filtered set — cleaning up after an agent
   * that is gone is the entire point. Safe because this is only reachable when hasCliAgent() is
   * false, which includes the everThought proof: a user who has ever earned here cannot land here.
   */
  private async selfHealNoAgent(): Promise<void> {
    let failed = false;
    for (const integration of AGENT_INTEGRATIONS) {
      try { await integration.removeThinkingHooks(); } catch { failed = true; }
      if (integration.supportsStatusLine) {
        try { await integration.removeStatusLine(); } catch { failed = true; }
      }
    }
    try { await removeStatusLineScript(); } catch { /* ours, best-effort */ }
    this.agentCleanupFailed = failed;
    // Stop claiming a terminal surface that has nothing to render into.
    if (this.terminalEnabled) {
      this.terminalEnabled = false;
      await this.context.globalState.update(TERMINAL_ENABLED_KEY, false);
      await this.consent.revoke('terminal');
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
    // Removal, unlike install, is NOT presence-gated: it is marker-scoped and no-ops when the
    // agent's settings file does not exist, so on a machine with no agent this writes nothing, and
    // on a machine that once had one it cleans up.
    void (async () => {
      for (const integration of AGENT_INTEGRATIONS) {
        try { await integration.removeThinkingHooks(); } catch { /* best-effort on shutdown */ }
      }
    })();
    this.queue.flush().catch(() => {});
  }

  // ── Thinking detection ──────────────────────────────────────────────────

  /**
   * Latch "we have seen the agent think here" the first time it happens, and refresh the panel so
   * the "no agent activity yet" hint disappears at once. Called at the very top of onThinkingStart,
   * BEFORE the enabled/token guards on purpose: the hook firing at all is the proof the user is
   * driving Claude Code through the extension. Whether that turn earns (signed in, enabled, market
   * bidding) is a separate question the panel already answers on its own.
   */
  private markThoughtSeen(): void {
    if (this.everThought) return;
    this.everThought = true;
    void this.context.globalState.update(EVER_THOUGHT_KEY, true);
    this.syncPanel();
    // The hook firing is proof the CLI is here, whatever the filesystem scan concluded. Re-detect
    // (the latch now feeds provenCli) so the status bar leaves 'no-agent' and the panel's no-agent
    // block clears at once, rather than at the next reload.
    void this.refreshPresence().then(() => { this.applyState(this.activeState()); this.syncPanel(); });
  }

  private onThinkingStart(): void {
    this.markThoughtSeen();
    // We are the host the agent is actually driving. Shims prefer a serving host when they scan,
    // so this is what makes them converge here instead of on an idle window's host.
    this.hookServer?.markServing();
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
    this.liveness.endTurn(this.killswitch.isKilled ? 'killed' : !this.enabled ? 'paused' : undefined);
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
    this.liveness.pause();     // a turn spent waiting on the user is not a turn we failed to render
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
    this.liveness.resume();
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
    // No fill is not a render failure, so the ledger must never see a turn here. This early return
    // is the structural reason an empty slate can never demote the surface.
    if (!slate || !creative) { this.surface.end(); return; }
    this.liveness.beginTurn(creative.adId, slate.slateId ?? '');

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
      ...(this.showBrandLogo(placement) && this.activeIconUrl ? { iconUrl: this.activeIconUrl } : {}),
      ...(placement === 'chat-banner' ? { bannerStyle: this.chatBannerStyle(), bannerFrame: this.chatBannerFrame() } : {}),
      ...this.spinnerPayload(placement),
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
    return c ? formatTerminalLine(c, frameAt(this.adSpinner('terminal'), Date.now())) : null;
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
    // Report at once rather than waiting for the next check-in: the dashboard may be open and
    // watching for exactly this, having asked for it. Best-effort, so a failure just retries later.
    void this.reportAppliedTerminal();
  }

  private async enableTerminal(): Promise<void> {
    // Nothing to attach a status line to. Refuse BEFORE any write: no consent, no persisted flag,
    // no settings.json, no ~/.claude, and above all no success toast for something that did not
    // happen. This is the reported dead end - the switch used to flip and claim success on a
    // machine where Claude Code was never installed.
    if (statusLineAgents(this.agentPresence).length === 0) {
      const pick = await vscode.window.showWarningMessage(
        'Awaitful: the terminal status line needs Claude Code, and we cannot find it on this machine. Nothing was changed. Install Claude Code and run it once, then turn this on.',
        'Set up Claude Code',
      );
      if (pick === 'Set up Claude Code') this.openSetupDocs();
      this.syncPanel();
      return;
    }

    await this.consent.grant('terminal');
    this.terminalEnabled = true;
    await this.context.globalState.update(TERMINAL_ENABLED_KEY, true);
    const { installed, present } = await this.ensureTerminalInstalled();

    // We only claim "enabled" when we actually wrote the status line into at least one agent. If agents
    // were present but every write failed (a read-only or corp-managed ~/.claude/settings.json), saying
    // "enabled" would send the user hunting for a line that will never appear. Tell them the truth.
    if (present > 0 && installed === 0) {
      // Nothing was written, so nothing may stay flipped on: leaving terminalEnabled true would show
      // an "on" switch for a surface that will never render - the same false-success family as the
      // refusal above.
      this.terminalEnabled = false;
      await this.context.globalState.update(TERMINAL_ENABLED_KEY, false);
      await this.consent.revoke('terminal');
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
    const agents = statusLineAgents(this.agentPresence);
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
    // Not presence-gated (see AgentIntegration): removal is marker-scoped and no-ops without the
    // agent's settings file, so iterating every integration only ever cleans up.
    for (const integration of AGENT_INTEGRATIONS) {
      if (!integration.supportsStatusLine) continue;
      try { await integration.removeStatusLine(); } catch { /* best-effort */ }
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
    if (!this.currentToken) return 'signin';
    // Signed in and switched on, but nothing here can produce a thinking event, so nothing will
    // ever earn. Sits BELOW sign-in on purpose: signing in is the first step either way, and
    // leading a signed-out developer with a missing-agent message points them at the wrong fix.
    if (!this.hasCliAgent()) return 'no-agent';
    return 'earning';
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

  private async toggleRemoteControl(): Promise<void> {
    this.remoteControlAllowed = !this.remoteControlAllowed;
    await this.context.globalState.update(REMOTE_CONTROL_KEY, this.remoteControlAllowed);
    this.syncPanel();
    void this.reportControlAllowed(); // let the dashboard reflect this editor's new opt-in promptly
  }

  /** Report this device's "Control from web" opt-in so the dashboard shows which editors will auto-apply
   *  a web-set format. De-duped like the other reports; best-effort, retried next cycle on failure. */
  private async reportControlAllowed(): Promise<void> {
    if (!this.currentToken) return;
    if (this.lastReportedControl === this.remoteControlAllowed) return;
    const enabled = this.remoteControlAllowed;
    try {
      await this.account.reportControlAllowed(this.currentToken, enabled);
      this.lastReportedControl = enabled;
    } catch {
      // Swallow - lastReportedControl stays put, so the next cycle retries.
    }
  }

  /**
   * A shim beacon proves our surface is LIVE in the current webview — so clear any stale
   * "reload to activate" (e.g. a heal-reclaim re-wrote the file for the next load while the running
   * webview already shows our ad). The beacon, not the file state, is the truth about what's rendered.
   */
  /** A beacon the session accepted is proof the overlay was painted. */
  private notePaint(b: SurfaceBeacon): void {
    this.liveness.painted(b.adId, b.slateId, b.shimId);
  }

  /**
   * Our webview surface is provably not rendering. Move earning somewhere real rather than let the
   * panel keep claiming a dead spot is active - `onThinkingStart` routes to the webview surface and
   * returns, so a dead one earns exactly zero.
   *
   * The patch stays on disk and consent is not revoked: the bytes may be fine and a reload may fix
   * it, so the user's choice survives to the next window load.
   */
  private onLivenessChange(s: LivenessState): void {
    if ((s.stage === 'not-rendering' || s.stage === 'silent') && !this.livenessSteppedBack) {
      this.livenessSteppedBack = true;
      this.stepBackToStatusBar(true);
      this.notifyNotRendering(s.stage);
    }
    this.syncPanel();
  }

  private notifyNotRendering(stage: 'not-rendering' | 'silent'): void {
    const key = `live:${stage}`;
    if (this.pausedNotified.has(key)) return;
    this.pausedNotified.add(key);
    const msg = stage === 'not-rendering'
      ? "Awaitful: Claude Code's panel could not place the sponsored line in the last 3 thinking turns, so earning moved to your status bar. Reloading the window usually fixes it."
      : "Awaitful: Claude Code's panel has not reported back in the last 3 thinking turns, so earning moved to your status bar. Open Claude Code's panel in this window and keep it in view to earn at the higher rate.";
    void vscode.window.showWarningMessage(msg, 'Reload window', 'Open Awaitful').then((pick) => {
      if (pick === 'Reload window') this.reloadWindow();
      else if (pick === 'Open Awaitful') this.openPanel();
    });
  }

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
    if (me.status === 'fulfilled') {
      this.accountEmail = me.value.email;
      this.accountName = me.value.name ?? undefined;
      this.remoteSurfacePref = me.value.remoteSurfacePreference;
      // Awaited (unlike the rest of this method's fire-and-forget callers) so the report below
      // always reflects activeSurface AFTER reconciliation settles, not mid-flight.
      await this.reconcileRemoteSurfacePreference(me.value.remoteSurfacePreference);
      await this.reconcileRemoteTerminalPreference(me.value.remoteTerminalEnabled);
      void this.reportAppliedSurface();
      void this.reportAppliedTerminal();
      void this.reportControlAllowed();
      void this.reconcileAdPreferences(me.value.adPreferences, this.slate.prefsVersion);
    }
    if (earnings.status === 'fulfilled') {
      this.earningsToday = earnings.value.todayUsd;
      this.unredeemedUsd = earnings.value.unredeemedUsd;
      this.maybeNudgePlacements();
    }
    if (me.status === 'fulfilled' || earnings.status === 'fulfilled') {
      this.syncPanel();
      // Refresh the idle status-bar earnings, but never clobber a live ad.
      if (this.activeAdLine === undefined) this.applyState(this.activeState());
    }
  }

  /**
   * First-earning nudge: once ever, after the user has actually earned something while still on the
   * base status-bar surface, surface that higher-value placements exist. Gated so explorers (anyone
   * who already moved off status-bar or turned on the terminal) and repeat sessions never see it -
   * this is discoverability, not a nag, and the safe default is never punished for staying put.
   */
  private maybeNudgePlacements(): void {
    if (this.context.globalState.get<boolean>(PLACEMENT_NUDGE_KEY) === true) return;
    // Hold off while the setup stepper is still guiding them: the stepper already offers the format
    // upgrade, so a second toast saying the same thing would just be the "too many notifications" the
    // stepper was meant to replace. Once onboarding is done or dismissed, this returns to normal.
    if (this.onboardingIncomplete()) return;
    // Never while paused: the copy says "you are earning", which must be true when shown, and a paused
    // mis-fire would also burn the one-shot flag so the real nudge never appears once they resume.
    if (!this.enabled) return;
    const earned = parseFloat(this.unredeemedUsd ?? '0') > 0 || parseFloat(this.earningsToday ?? '0') > 0;
    const onBaseOnly = this.activeSurface === 'status-bar' && !this.terminalEnabled;
    if (!earned || !onBaseOnly) return;
    // Only nudge toward a format this machine can actually use - never tell a CLI-only / editor-less
    // developer to use a spot they cannot turn on. Same honest definition of "best" the first-run moment
    // uses, so the two never disagree.
    if (!pickBestUpgrade(this.buildPanelState())) return;
    // Set the flag before showing so a concurrent refresh can never double-fire it.
    void this.context.globalState.update(PLACEMENT_NUDGE_KEY, true);
    void vscode.window
      .showInformationMessage(
        'Awaitful: nice, you are earning on the status bar. You can earn more by showing the ad in a higher-value spot, like the thinking line. Want to see your options?',
        'Show placements',
      )
      .then((pick) => {
        if (pick === 'Show placements') this.openPanel();
      });
  }

  /**
   * First-run onboarding open. Once per sign-in, open the panel so the developer sees the setup stepper
   * (sign in / turn on a format / sync). It only OPENS the panel - it never activates a format on its
   * own; the stepper's own buttons carry the unchanged one-tap consent + fail-safe patch flow. Silent
   * for a returning, fully-set-up developer, or one who dismissed the stepper: onboardingIncomplete()
   * gates it on the same derived state the webview's stepperVisible() uses, so the two never disagree.
   */
  private async maybeOpenOnboarding(): Promise<void> {
    if (!this.onboardingOpenPending) return;
    this.onboardingOpenPending = false; // once per sign-in; never re-fire on later refreshes
    if (!this.currentToken || !this.enabled) return;
    // Capability changes about twice in a developer's life; refresh it once so bestUpgrade (the stepper's
    // format target) is honest before the panel reads it.
    await this.refreshPresence();
    if (!this.onboardingIncomplete()) return;
    this.openPanel();
  }

  /** True while any onboarding step is still open on this machine and the stepper was not dismissed - the
   *  host-side mirror of the webview's stepperVisible(), so the auto-open and the panel agree, and the
   *  discoverability nudge holds off until the guided setup is out of the way. */
  private onboardingIncomplete(): boolean {
    if (this.context.globalState.get<boolean>(ONBOARDING_DISMISSED_KEY) === true) return false;
    // A deliberate dashboard format choice (even status-bar) settles the format step - see remoteSurfacePref.
    const formatDone = this.activeSurface !== 'status-bar' || this.terminalEnabled || this.remoteSurfacePref !== null;
    return !(formatDone && this.remoteControlAllowed);
  }

  /** Record the running version as acknowledged and drop the "what's new" banner NOW. Called from either
   *  banner action (the ✕ or "See what's new"), so it clears immediately this session too. */
  private markVersionSeen(): void {
    void this.context.globalState.update(LAST_SEEN_VERSION_KEY, this.context.extension.packageJSON.version as string);
    this.justUpdated = false;
    this.syncPanel();
  }

  /** The banner has now had its chance to be seen - the panel is open on the main view where it lives.
   *  Persist the version so it does NOT return on the next launch, but keep justUpdated so it stays
   *  visible for the rest of THIS session. A what's-new note should show once, not nag every restart. */
  private noteWhatsNewShown(): void {
    if (!this.justUpdated) return;
    void this.context.globalState.update(LAST_SEEN_VERSION_KEY, this.context.extension.packageJSON.version as string);
  }

  /**
   * Reconcile the account-wide preference set from the web dashboard (docs/CONTRACT.md's
   * `GET /v1/me` field) against this device's own state. This is the ONE place remote config is
   * allowed to touch the active surface, and it never widens what a device consents to on its own:
   *
   *   - `null`, or already the active surface → nothing to do.
   *   - `status-bar` → applied immediately. Switching TO status bar never modifies a file.
   *   - a webview surface (thinking-line / chat-banner) this device has already consented to, OR
   *     `remoteControlAllowed` is on → applied immediately via the same path the panel itself uses.
   *     `remoteControlAllowed` does not skip any safety step (backup, atomic write, verify,
   *     fail-safe) - `enableWebviewSurface` runs exactly as it does from a manual click. It only
   *     skips asking first, because this device's own opt-in already is that consent.
   *   - neither → never auto-patch a Claude Code file without one of the above (CLAUDE.md golden
   *     rule 2). Nudge instead, once per distinct requested value so a later, different request
   *     still surfaces even if an earlier one was ignored - deep-linked straight to that surface's
   *     own review page, where the developer confirms through the panel's existing consent flow.
   */
  private async reconcileRemoteSurfacePreference(pref: RemoteSurfaceId | null): Promise<void> {
    // Withdraw the gate once there is nothing outstanding to prompt for, so a later ask lands. Runs
    // BEFORE the early returns: a request that is null, or that this device has already applied, is
    // exactly when the gate should lift. Same rule the terminal reconciler has always had.
    // `== null`, so an ABSENT field is treated the same as an explicit null. A server that predates
    // this field omits it entirely, and `undefined === null` is false - so a strict check falls
    // straight through and acts on a request nobody made. See the terminal reconciler below, where
    // exactly that shipped and switched the status line on by itself.
    if (pref == null || pref === this.activeSurface) {
      if (this.context.globalState.get<string>(REMOTE_SURFACE_PROMPTED_KEY) !== undefined) {
        await this.context.globalState.update(REMOTE_SURFACE_PROMPTED_KEY, undefined);
      }
      return;
    }

    if (pref === 'status-bar') {
      await this.switchToStatusBar();
      return;
    }

    if (this.consent.isGranted(pref) || this.remoteControlAllowed) {
      await this.enableWebviewSurface(pref, false);
      return;
    }

    // Prompt once per distinct outstanding request: silence while the same one stands, a fresh
    // toast the moment the dashboard asks for something else.
    if (this.context.globalState.get<string>(REMOTE_SURFACE_PROMPTED_KEY) === pref) return;
    await this.context.globalState.update(REMOTE_SURFACE_PROMPTED_KEY, pref);

    const label = surfaceLabel(pref);
    const pick = await vscode.window.showInformationMessage(
      `Your Awaitful dashboard set the ${label} as your preferred ad format. That changes a Claude Code file on this device, so it needs your OK here first.`,
      'Open panel',
    );
    if (pick === 'Open panel') this.openPanel(pref);
  }

  /**
   * Apply the account's terminal request - the same permission category as a webview format, and
   * handled the same way.
   *
   * Not part of reconcileRemoteSurfacePreference because the terminal is ADDITIVE: it runs alongside
   * whichever VS Code format is chosen, so it can never be a fourth value of a pick-one preference.
   * But turning it on writes ~/.claude/settings.json, so golden rule 2 applies exactly as it does to
   * a patch: no consent on this device, no write - a notification instead, and the developer turns
   * it on themselves.
   *
   * Turning it OFF is asymmetric on purpose, and it is not a loophole: removing our own status-line
   * entry restores what was there before, so there is nothing to consent to. Refusing to switch off
   * without a prompt would leave a developer unable to stop it from the dashboard at all.
   */
  private async reconcileRemoteTerminalPreference(pref: boolean | null): Promise<void> {
    // The dashboard is no longer asking for it on, so let a future ask prompt again. Guarded rather
    // than written blindly: null is the common case, and this runs on every check-in.
    if (pref !== true && this.context.globalState.get<boolean>(REMOTE_TERMINAL_PROMPTED_KEY) === true) {
      await this.context.globalState.update(REMOTE_TERMINAL_PROMPTED_KEY, undefined);
    }
    // `== null` covers BOTH "no request" (explicit null) and "this server does not know about the
    // field yet" (absent, so undefined). The strict `=== null` here was a real bug: against a server
    // that had not deployed the column, every check-in fell past this guard, past the false branch,
    // and straight into enableTerminal() for anyone who had ever granted terminal consent - turning
    // the status line on, with a success toast, having been asked by nobody.
    if (pref == null || pref === this.terminalEnabled) return;

    if (pref === false) {
      await this.disableTerminal();
      this.syncPanel();
      return;
    }

    // Nothing to attach a status line to. Silent: the panel already carries the full explanation and
    // the setup link, and a toast about a missing product the developer never asked for here is noise.
    if (statusLineAgents(this.agentPresence).length === 0) return;

    if (this.consent.isGranted('terminal') || this.remoteControlAllowed) {
      await this.enableTerminal();
      this.syncPanel();
      return;
    }

    // One-time per requested value, so a dashboard request that goes ignored does not nag - and a
    // later, different request still gets through.
    if (this.context.globalState.get<boolean>(REMOTE_TERMINAL_PROMPTED_KEY) === true) return;
    await this.context.globalState.update(REMOTE_TERMINAL_PROMPTED_KEY, true);

    const pick = await vscode.window.showInformationMessage(
      'Your Awaitful dashboard asked to turn on the terminal status line. That changes ~/.claude/settings.json on this device, so it needs your OK here first.',
      'Open panel',
    );
    if (pick === 'Open panel') this.openPanel('terminal');
  }

  /** Tell the server what this device's terminal line actually ended up as - see
   *  reportAppliedSurface for why a request is never taken as its own outcome. */
  private async reportAppliedTerminal(): Promise<void> {
    if (!this.currentToken) return;
    if (this.lastReportedTerminal === this.terminalEnabled) return;
    const enabled = this.terminalEnabled;
    try {
      await this.account.reportTerminalApplied(this.currentToken, enabled);
      this.lastReportedTerminal = enabled;
    } catch {
      // Swallow - lastReportedTerminal stays put, so the next cycle retries.
    }
  }

  /**
   * Tell the server which surface this device just confirmed - a fact independent of whether an ad
   * has rendered there yet (that can take arbitrarily long: the line only exists while the agent is
   * genuinely thinking). This is what lets the web distinguish "applied, waiting on the first ad to
   * confirm it" from "nothing has happened on any device yet", instead of a single ad-event-derived
   * signal that can sit stuck forever whenever a switch lands between coding sessions. Best-effort:
   * a failed report just retries on the next refreshAccount cycle, never blocks anything.
   */
  private async reportAppliedSurface(): Promise<void> {
    if (!this.currentToken) return;
    const surface = this.activeSurface;
    const failure = this.lastApplyFailure;
    // Report when EITHER the surface or the failure changed - so a request that failed and left this
    // device on the status bar it was already on still tells the dashboard why, instead of silence.
    if (this.lastReportedSurface === surface && this.lastReportedFailure === failure) return;
    try {
      await this.account.reportSurfaceApplied(this.currentToken, surface, failure);
      this.lastReportedSurface = surface;
      this.lastReportedFailure = failure;
    } catch {
      // Swallow - the reported state stays put, so the next cycle retries.
    }
  }

  /**
   * Apply any ad-rendering preference set from the web dashboard - unconditionally, unlike
   * reconcileRemoteSurfacePreference. None of these touch a Claude Code file (no patch, no
   * golden-rule-2 concern), so there is nothing to confirm and no toast to show; each present field
   * just applies the same way it would from a local panel click, live-restyling the ad on screen if
   * one is already showing.
   */
  /**
   * Apply the account's settings to this editor, ONCE per change.
   *
   * This used to run unconditionally on every check-in, so it re-applied the stored web value every
   * five minutes: a developer who changed their spinner inside VS Code watched it silently revert,
   * forever. The account now carries a version, and this acts only when the version DIFFERS from
   * the last one applied here. So a local edit is permanent until the web deliberately changes
   * something, which is the only thing that should ever override it.
   *
   * Inequality, not greater-than: if the counter ever moves backwards (a database restore), every
   * device applies once more and converges. A strict `>` would strand the fleet on a version the
   * server no longer has.
   *
   * The stored version is written ONLY after every setting applied. A partial failure leaves it
   * behind, so the next check-in retries rather than believing it is done - the failure mode is a
   * repeat, never a silent half-applied state.
   */
  private async reconcileAdPreferences(prefs: AdPreferences | null, version: number | undefined): Promise<void> {
    if (version === undefined) return;                       // anonymous slate: no account, nothing to apply
    const applied = this.context.globalState.get<number>(PREFS_VERSION_KEY);
    if (applied === version) return;                         // already on this version

    // One write for every format, so a version can never be half-applied. allFormatSettings skips
    // anything this build cannot render - a key from a newer server, or a value that has left an
    // option list - so a settings rollout cannot brick an editor that has not updated yet.
    const ok = await this.custom.applyAll(allFormatSettings(prefs as Record<string, unknown> | null));
    if (ok) await this.context.globalState.update(PREFS_VERSION_KEY, version);

    this.restyleLive();
    this.syncPanel();
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
    const ps: PanelState = {
      version: this.context.extension.packageJSON.version as string,
      // What this editor calls itself. Cursor, Windsurf and VS Codium all run this, and the panel
      // used to tell every one of them their formats live in "Visual Studio Code".
      appName: vscode.env.appName,
      signedIn: !!this.currentToken,
      email: this.accountEmail,
      name: this.accountName,
      earningsToday: this.earningsToday,
      unredeemedUsd: this.unredeemedUsd,
      disabled: !this.enabled,
      everThoughtSeen: this.everThought,
      // The two presence axes (agents/presence.ts). anyAgentCli false means NOTHING can earn here;
      // anyAgentEditor false means only the two webview spots are out. Kept as booleans rather than
      // the full presence list because the panel's copy names Claude Code literally throughout, and
      // half-generic copy would be worse than none - revisit when a second agent ships.
      anyAgentCli: this.hasCliAgent(),
      anyAgentEditor: anyEditor(this.agentPresence),
      agentCleanupFailed: this.agentCleanupFailed,
      pauseRestoreFailed: this.pauseRestoreFailed,
      showEarningsInStatusBar: this.showEarningsInStatusBar,
      remoteControlAllowed: this.remoteControlAllowed,
      remoteSurfacePref: this.remoteSurfacePref,
      activeAdLine: this.activeAdLine,
      activeAdUnpaid: this.activeAdUnpaid,
      activeAdUrl: this.activeAdUrl,
      // Every format's own look, drawn on that format's own page. Built from AD_FORMATS rather than
      // a list here, so a new format appears in the panel the moment it is declared in the catalogue.
      customize: Object.fromEntries(AD_FORMATS.map((f) => [f.id, this.custom.elements(f.id)])),
      glowKeyframes: GLOW_KEYFRAMES,
      vsSurfaces: [
        {
          id: 'status-bar',
          active: this.activeSurface === 'status-bar',
          available: this.hasCliAgent(),
          consentGranted: true,
          modifiesFiles: false,
          earnRate: this.relativeRate('status-bar'),
          // The status bar earns only because thinking hooks fire. No agent CLI, no hooks, no
          // earnings - so even the always-available default is not available here, and must not
          // pretend to be.
          blockedReason: this.hasCliAgent() ? undefined : 'no-agent-cli',
        },
        cb,
        tl,
      ],
      // The terminal needs only the CLI, never the VS Code extension - that is the whole point of
      // the second axis: a terminal-first Claude Code developer earns on this surface.
      terminalEnabled: this.terminalEnabled && this.hasCliAgent(),
      terminalConsentGranted: this.consent.isGranted('terminal'),
      terminalBlockedReason: this.hasCliAgent() ? undefined : 'no-agent-cli',
      terminalEarnRate: this.relativeRate('terminal'),
      onboardingDismissed: this.context.globalState.get<boolean>(ONBOARDING_DISMISSED_KEY) === true,
      justUpdated: this.justUpdated,
      // Filled below - pickBestUpgrade reads the surfaces we just built, so it runs on the finished object.
      bestUpgrade: undefined,
    };
    // The stepper's "turn on a format" target: the same honest best-format pick the first-run open and
    // the discoverability nudge use, so all three agree by construction.
    ps.bestUpgrade = pickBestUpgrade(ps);
    return ps;
  }

  /**
   * Derive a webview surface card from a live patch assessment. Both webview placements share
   * one patch, so patchability is identical; only `active` differs — it is true when this
   * placement is the CHOSEN one (mutually exclusive with the other webview spot).
   */
  private webviewSurfaceCard(id: WebviewSurface): PanelSurface {
    // These two spots live inside the agent's VS Code extension bundle, so they need the editor
    // axis - a machine with only the CLI can earn on the status bar and the terminal, but not here.
    const editorHere = anyEditor(this.agentPresence);
    const a = this.patch.assess();
    // Our patch is present whether it's the current version or an older one being upgraded.
    const patched = a.state === 'our-patch-present' || a.state === 'our-patch-stale';
    const active = patched && this.activeSurface === id;
    // Someone else is holding a file we patch. `conflict` drives the fix-it affordance, so it
    // covers every contested custody state, not only the attributable ones.
    const conflict = CONTESTED_STATES.has(a.state);
    // On disk is the bar for naming it, not running. A switched-off extension is still sitting in
    // the developer's list with a real display name and a page to open - and its change is still in
    // the file. Gating this on 'yes' alone dropped both the name and the id the moment the developer
    // did the reasonable thing and disabled the tool, so the panel said "undefined is switched off"
    // and offered no way to act on it.
    // 'elsewhere' is nameable for the same reason 'disabled' is, and more urgently: the developer
    // has to go to a named application to fix it, and "another extension" does not tell them which.
    const nameable = a.foreign?.vendorInstalled === 'yes'
      || a.foreign?.vendorInstalled === 'disabled'
      || a.foreign?.vendorInstalled === 'elsewhere';
    const conflictVendor = nameable ? a.foreign?.vendor : undefined;
    // Deliberately dropped for a copy in another editor: this id names something this window cannot
    // remove or open, and every button built from it would fail on a click.
    const conflictVendorId = nameable && a.foreign?.vendorInstalled !== 'elsewhere'
      ? a.foreign?.vendorId
      : undefined;
    const host = a.foreign?.vendorHost;
    const conflictToken = a.foreign?.token;
    // We can take over only if pristine is recoverable from an Awaitful-controlled source.
    const canTakeOver = a.recoverable === 'yes';
    // Offer on a clean build, when already active, or on a conflict (guidance / take-over).
    const supported = editorHere && (a.state === 'clean-pristine' || patched || conflict);
    // Active via a self-computed (provisional) recipe on a build the server hasn't confirmed yet.
    const provisional = active && this.recipeClient.isProvisionalActive();
    // Deepest cause first. Custody now outranks "we don't know this build": a competitor is exactly
    // what breaks recipe resolution, so blaming the Claude Code version for another tool's edit was
    // both wrong and unactionable. 'unsupported-build' is now reserved for a genuinely clean file
    // on a build we have not verified - the one case its copy is true for.
    const blockedReason: PanelSurface['blockedReason'] = !this.hasCliAgent()
      ? 'no-agent-cli'
      : !editorHere
        ? 'no-agent-editor'
        : supported
          ? undefined
          : BLOCKED_BY_STATE[a.state] ?? 'unsupported-build';
    return {
      id,
      active,
      available: blockedReason === undefined,
      consentGranted: this.consent.isGranted(id),
      blockedReason,
      modifiesFiles: true,
      earnRate: this.relativeRate(id),
      conflict,
      conflictVendor,
      conflictVendorId,
      conflictVendorInstalled: a.foreign?.vendorInstalled,
      // Shortened for reading, not for action: the panel only ever displays this, and the reveal
      // button re-derives the real path host-side rather than trusting one back from the webview.
      conflictVendorHost: host
        ? {
          label: host.label,
          // The extension's OWN folder, not the editor's: it is what to delete, and revealing it
          // opens the extensions directory with it already selected.
          dir: tildify(host.extensionDir ?? host.dir),
          pendingRemoval: host.pendingRemoval === true,
        }
        : undefined,
      repairing: this.isRepairing(),
      // The DISK, not the running window. They disagree between a removal and the reload that
      // applies it, and the checklist needs both to say which step is actually done.
      agentFilesPresent: a.target !== undefined,
      // And the REGISTRY, which is a third fact again. An editor drops the entry the instant you
      // uninstall and deletes the folder only when the whole app restarts, so between those two
      // moments Claude Code is uninstalled with its patched bytes still sitting on disk. Reading
      // "the files are there" as "it is installed" made the checklist tick its last three steps the
      // moment Remove was clicked, having achieved nothing.
      agentInstalled: this.agentExtensionInstalled(),
      conflictToken,
      canTakeOver,
      supported,
      provisional,
      // Only meaningful for the chosen surface: the ledger is about what this window is rendering.
      live: active ? this.liveness.state.stage : undefined,
    };
  }

  private syncPanel(): void {
    if (AwaitfulPanel.isOpen()) {
      // Build ONCE. Each build assesses two surface cards, and an assessment reads both Claude Code
      // targets - several megabytes. Building twice quadrupled that for no benefit.
      const state = this.buildPanelState();
      AwaitfulPanel.openOrReveal(this.context, (msg) => this.handlePanelMessage(msg), state).setState(state);
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
      case 'set-element':
        void this.setElement(msg.format, msg.element, msg.value);
        break;
      case 'toggle-enabled':
        if (this.enabled) this.disable(); else this.enable();
        break;
      case 'toggle-statusbar-earnings':
        void this.toggleStatusBarEarnings();
        break;
      case 'toggle-remote-control':
        void this.toggleRemoteControl();
        break;
      case 'dismiss-onboarding':
        // Device-local + persisted: the stepper never returns on this machine. The format cards and the
        // sync toggle stay the way to finish those steps later, so nothing is lost by dismissing.
        void this.context.globalState.update(ONBOARDING_DISMISSED_KEY, true);
        this.syncPanel();
        break;
      case 'whats-new':
        void vscode.env.openExternal(vscode.Uri.parse(LINKS.changelog));
        this.markVersionSeen();
        break;
      case 'dismiss-whats-new':
        this.markVersionSeen();
        break;
      case 'consent-grant':
        if (isWebviewSurface(msg.id)) {
          void this.enableWebviewSurface(msg.id, msg.takeover === true);
        } else {
          void this.consent.grant(msg.id as Parameters<ConsentStore['grant']>[0]);
          this.syncPanel();
        }
        break;
      case 'restore-files':
        void this.restorePatchedFiles();
        break;
      case 'reload-window':
        void this.reloadWindow(msg.view, msg.detailId);
        break;
      case 'uninstall-extension':
        // VS Code's own uninstall, on an explicit click on a button that says exactly that. The
        // distinction Awaitful holds to is UNILATERAL versus REQUESTED: it still never removes or
        // disables anything on its own initiative, and never touches another extension's code.
        // The id is echoed back from what we detected (or our own constant), so a webview message
        // cannot aim this at some third extension.
        // `from` is the page it was clicked on, so the reload step can hand it back.
        void this.removeExtension(msg.id, msg.from);
        break;
      case 'install-extension':
        // Only ever the agent's own, to undo the uninstall a step above.
        void this.addExtension(msg.id);
        break;
      case 'open-extension':
        // Opens ONE extension's own page. The id is echoed back from what we detected and sent down
        // (or our own constant for Claude Code), so the webview cannot point this anywhere new.
        // Navigation only: Awaitful never uninstalls or disables another extension - the developer
        // stays the one who decides what leaves their machine.
        void this.showExtension(msg.id);
        break;
      case 'open-extensions':
        // Open the Extensions view filtered to the conflict fix (the competitor, or Claude Code),
        // so the guided steps land the user exactly where they need to click.
        void vscode.commands.executeCommand('workbench.extensions.search', msg.query || '');
        break;
      case 'open-setup-docs':
        this.openSetupDocs();
        break;
      case 'show-conflict-host':
        this.showConflictHost();
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
            `Awaitful: the '${msg.id}' ad format will be available in a future update.`,
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
    // An explicit re-enable is the user overriding our demotion. Clear it FIRST, or the activate
    // call below no-ops and their chosen surface silently stays unchecked.
    this.livenessSteppedBack = false;
    this.liveness.reset();
    // An explicit enable is the user overriding our yield, so give the reclaim budget back.
    this.setReclaim(this.patch.assess().target?.buildId ?? 'unknown', 0);
    if (this.killswitch.isKilled) {
      vscode.window.showWarningMessage('Awaitful: patching is paused server-side right now.');
      return;
    }

    // If we've already lost this build to an actively-re-patching competitor, don't restart the futile
    // take-over/reload loop — surface the real fix (disable the other extension) up front.
    const pre = this.patch.assess();
    const preBuild = pre.target?.buildId ?? 'unknown';
    if (CONTESTED_STATES.has(pre.state) && this.getReclaim(preBuild) >= MAX_RECLAIM_ATTEMPTS) {
      const who = pre.foreign?.vendorInstalled === 'yes' && pre.foreign.vendor ? pre.foreign.vendor : 'another tool';
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
      this.lastApplyFailure = null; // a successful apply clears any prior failure this device reported
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

    // Fail-safe: explain, stay in status-bar mode. Record the coarse reason so the dashboard can show
    // WHY this editor did not switch, instead of an indefinite "confirm in your editor".
    this.lastApplyFailure = mapApplyFailure(res.reason);
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
        // "Status-bar mode is active" is only true when a CLI is here to fire thinking hooks; with
        // no agent at all, claiming it would be the same false reassurance this change exists to end.
        vscode.window.showInformationMessage(
          `Awaitful: Claude Code is not installed in this window, so the ${surfaceLabel(id)} format has nothing to attach to.` +
            (this.hasCliAgent()
              ? ' Status-bar mode is active.'
              : ' Nothing is earning here yet - open the Awaitful panel to see what is missing.'),
        );
        break;
      case 'no-recipe':
        // ONLY for a genuinely clean file on an unverified build. A competitor holding the file
        // used to land here too, which sent people to wait for a Claude Code release that was never
        // the problem. Custody states now route to 'blocked' above with copy that names what happened.
        vscode.window.showInformationMessage(
          `Awaitful: the ${surfaceLabel(id)} format is not available for this Claude Code build yet. Status-bar mode is active and earning.`,
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

    // A NEWER shim than ours is on disk: another window is running a newer Awaitful. Stand down.
    // Without this the two windows classify each other's bytes as stale and rewrite a multi-megabyte
    // bundle at each other indefinitely - and no reclaim budget bounds it, because neither side ever
    // sees the file as modified. VS Code updates extensions without reloading open windows, so this
    // is an ordinary upgrade-day event, not an edge case.
    if (a.target && anyNewerThanOurs(scanTargets(a.target))) return;

    // Ours (or a clean build we can patch): apply idempotently and reset the reclaim budget.
    if (a.state === 'our-patch-present' || a.state === 'our-patch-stale' || a.state === 'clean-pristine') {
      const res = this.patch.apply(false);
      this.reportPatchOutcome(res.ok);
      if (res.ok) {
        // Deliberately NOT resetting the budget here. A successful write only means we wrote last;
        // a reactive competitor rewrites moments later, and zeroing on each win made the budget
        // unreachable and the war unbounded. The budget clears only on an explicit user re-enable.
        this.activateWebviewSurface(chosen);
      } else {
        this.stepBackToStatusBar(interactive);
      }
      return;
    }

    // Someone re-modified CC on the surface the user chose. Reclaim it (bounded across reloads).
    if (CONTESTED_STATES.has(a.state) && a.recoverable === 'yes') {
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
      // Lost the patch-war (or reclaim failed) → yield and guide the user honestly. Pristine was
      // recoverable here, so disabling the competitor is enough (no reinstall needed).
      this.recipeClient.report('conflict');
      this.stepBackToStatusBar(interactive);
      if (interactive) this.notifyCompetitorConflict(chosen, this.namedVendor(a), true);
      return;
    }

    // Contested with no recoverable original, or no-recipe / unreadable / no-target: not active here.
    const contested = CONTESTED_STATES.has(a.state);
    this.recipeClient.report(contested ? 'conflict' : 'unknown-build');
    this.stepBackToStatusBar(interactive);
    if (interactive) {
      // Contested with no recoverable pristine → disabling alone can't fix it (reinstall needed).
      if (contested) this.notifyCompetitorConflict(chosen, this.namedVendor(a), false);
      else this.notifyWebviewSurfacePaused(chosen, a.target?.buildId);
    }
  }

  /**
   * A vendor name we are willing to put in front of the user: only when that extension is actually
   * installed. Telling someone to turn off a tool they uninstalled months ago sends them hunting
   * for something that is not there, and the leftover file change is the real problem anyway.
   */
  private namedVendor(a: { foreign?: { vendor?: string | undefined; vendorInstalled?: string | undefined } }): string | undefined {
    return a.foreign?.vendorInstalled === 'yes' ? a.foreign.vendor : undefined;
  }

  /**
   * The reclaim budget, PERSISTED per build.
   *
   * It used to live in a per-session Map, so every window reload handed a competitor a fresh three
   * attempts - an unbounded war in practice. The key includes the build directory because the same
   * build id names two different files under two editors.
   */
  private reclaimKey(buildId: string): string {
    const dir = this.patch.assess().target?.dir ?? '';
    return `${RECLAIM_KEY_PREFIX}${sha256Hex(dir)}|${buildId}`;
  }
  private getReclaim(buildId: string): number {
    return this.context.globalState.get<number>(this.reclaimKey(buildId)) ?? 0;
  }
  private setReclaim(buildId: string, n: number): void {
    void this.context.globalState.update(this.reclaimKey(buildId), n <= 0 ? undefined : n);
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

  /**
   * Honest guidance when a competitor keeps re-modifying CC and we've stopped fighting the war.
   * The message branches on `recoverable`: when we hold a verified-clean copy, disabling the
   * competitor is enough; when we don't, disabling alone can't help (its edit is already on disk),
   * so we're honest that a clean Claude Code (reinstall) is what's needed. The detailed, click-through
   * fix lives on the surface's page in the panel, so we offer a way back into it.
   */
  private notifyCompetitorConflict(id: WebviewSurface, vendor: string | undefined, recoverable: boolean): void {
    const who = vendor ?? 'Another extension';
    const key = `conflict:${who}:${id}`;
    if (this.pausedNotified.has(key)) return;
    this.pausedNotified.add(key);
    const label = surfaceLabel(id);
    const message = recoverable
      ? `Awaitful: ${who} keeps changing Claude Code and overwriting the ${label}. Disable ${who} so the two stop fighting over the same file, then reopen Awaitful to switch back to the ${label}. Status-bar mode is active and earning meanwhile.`
      : `Awaitful: ${who} changed Claude Code and Awaitful has no clean copy to restore, so the ${label} is paused. Disabling ${who} stops new changes but will not undo the ones already on disk - reinstalling Claude Code restores a clean copy. Status-bar mode is active and earning meanwhile.`;
    void vscode.window.showWarningMessage(message, 'Manage extensions', 'Open Awaitful').then((pick) => {
      // We can't disable another extension ourselves (no VS Code API, and it would be user-hostile);
      // we open the Extensions view so the user can do it, or the panel where the guided fix lives.
      if (pick === 'Manage extensions') void vscode.commands.executeCommand('workbench.view.extensions');
      else if (pick === 'Open Awaitful') this.openPanel();
    });
  }

  // Tell the user once per build when their premium surface pauses because we don't yet support this
  // Claude Code version — otherwise the status bar silently reverts to the lower rate with no signal.
  private notifyWebviewSurfacePaused(id: WebviewSurface, buildId: string | undefined): void {
    const key = `unsupported:${buildId ?? 'unknown'}`;
    if (this.pausedNotified.has(key)) return;
    this.pausedNotified.add(key);
    vscode.window.showInformationMessage(
      `Awaitful: the ${surfaceLabel(id)} format is paused for this Claude Code version - status-bar mode is active and earning. It will resume automatically when support for this version lands.`,
    );
  }

  /** Make a webview placement the active surface and (re)point its slate poll at it. */
  private activateWebviewSurface(id: WebviewSurface): void {
    // The patch watcher's self-heal reaches here, and would otherwise re-activate a surface we just
    // demoted for provably not rendering - putting earnings straight back into a dead spot.
    if (this.livenessSteppedBack) return;
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
  /** Does THIS format show a logo when the ad carries one? Formats that cannot draw one say false. */
  private showBrandLogo(format: AdFormatId): boolean {
    return this.custom.for(format).logo === true;
  }

  /** The spinner THIS format draws. Every format keeps its own, so one never moves another. */
  private adSpinner(format: AdFormatId): AdSpinner {
    return getSpinner(this.custom.for(format).spinner as string);
  }

  /** The spinner as creative-payload fields; empty frames (spinner "none") send nothing. */
  private spinnerPayload(format: AdFormatId): { spinnerFrames?: string[]; spinnerIntervalMs?: number } {
    const s = this.adSpinner(format);
    return s.frames.length ? { spinnerFrames: [...s.frames], spinnerIntervalMs: s.intervalMs } : {};
  }

  private chatBannerStyle(): string {
    return this.custom.for('chat-banner').glow as string;
  }

  /** The chosen chat-banner outline frame, validated against the shipped set. */
  private chatBannerFrame(): string {
    return this.custom.for('chat-banner').frame as string;
  }

  /**
   * The ONE writer for every customization control, whichever format's page it was clicked on.
   *
   * These messages come from a webview, so the (format, element, value) triple is checked against
   * the shared catalogue before anything is stored: a triple this build cannot draw is dropped, not
   * saved. Four element-specific handlers used to do this, each with its own validation, and each a
   * place to forget one.
   */
  private async setElement(format: string, element: string, value: string | boolean): Promise<void> {
    const stored = await this.custom.set(format as AdFormatId, element as ElementId, value as ElementValue);
    if (!stored) return;
    this.restyleLive();
    this.syncPanel();
  }

  /**
   * Repaint what is on screen RIGHT NOW with the current look, so a pick previews in place instead
   * of waiting for the next thinking turn. Same adId throughout, so no billing state resets - the
   * developer is restyling the frame, not refusing the ad.
   *
   * Only the two live surfaces need telling: the terminal reads its frames on its next poll.
   */
  private restyleLive(): void {
    this.ui.refreshAd();
    const live = isWebviewSurface(this.activeSurface) ? this.activeSurface : undefined;
    if (!live) return;
    const s = this.adSpinner(live);
    this.surface.restyle({
      // Sent even when empty: an empty frame list is the "none" spinner, and the shim rebuilds
      // without a spinner element rather than freezing on the last glyph.
      spinnerFrames: [...s.frames],
      spinnerIntervalMs: s.intervalMs,
      // Restoring means restoring what the ad ACTUALLY had, which for most ads is nothing: a logo is
      // optional for the advertiser, so turning logos on must never invent one.
      iconUrl: this.showBrandLogo(live) ? this.activeIconUrl : undefined,
      bannerStyle: this.chatBannerStyle(),
      bannerFrame: this.chatBannerFrame(),
    });
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
      // We looked at every target. If something OTHER than Awaitful is now holding a file we patch (our
      // marker is gone, but it is not pristine either), say so honestly rather than imply the editor is
      // untouched: "no Awaitful changes" is true, "nothing changed" is not. Only give the verified clean
      // bill when nothing foreign is in there.
      if (r.foreignHeld.length > 0) {
        vscode.window.showWarningMessage(
          'Awaitful: your Claude Code files were changed by another extension, not Awaitful, so there is nothing of ours to undo. Restore from that extension - the file path is in the panel.',
        );
      } else {
        vscode.window.showInformationMessage('Awaitful: nothing to restore - no Awaitful changes are present.');
      }
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
    this.lastApplyFailure = null; // the status bar is a deliberate destination, never a failure
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
  async reloadWindow(view?: string, detailId?: string): Promise<void> {
    await this.rememberPanelView(view, detailId);
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /**
   * Note where the panel was, for the window that comes back.
   *
   * Validated, never echoed: the message says where the webview WAS, and only a name from the known
   * set survives. A webview that could hand back an arbitrary view string would be choosing what the
   * next window opens on, which is not its decision to make.
   */
  private async rememberPanelView(view?: string, detailId?: string): Promise<void> {
    if (!view || !PANEL_VIEWS.has(view)) return;
    const known = detailId !== undefined
      && (isWebviewSurface(detailId) || detailId === 'terminal' || detailId === 'status-bar');
    await this.context.globalState.update(PANEL_RETURN_KEY, {
      view, ...(known ? { detailId } : {}), at: Date.now(),
    });
  }

  /**
   * Reopen the page the developer reloaded from. Returns whether it opened anything, so the repair
   * flow does not also navigate and fight it for the same panel.
   *
   * Cleared before it is used, always: a note that survived a failure to act on it would reopen the
   * panel on every startup thereafter.
   */
  private async restorePanelView(): Promise<boolean> {
    const saved = this.context.globalState.get<{ view?: string; detailId?: string; at?: number }>(PANEL_RETURN_KEY);
    if (!saved) return false;
    await this.context.globalState.update(PANEL_RETURN_KEY, undefined);
    if (typeof saved.at !== 'number' || Date.now() - saved.at > PANEL_RETURN_TTL_MS) return false;
    if (!saved.view || !PANEL_VIEWS.has(saved.view)) return false;
    this.openPanelAt(saved.view, saved.detailId);
    return true;
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /** `focusSurface` jumps straight to that surface's own review page (used by the remote-surface
   *  toast) instead of the default list, so confirming a dashboard change is a single click, not a
   *  hunt through the panel. */
  openPanel(focusSurface?: WebviewSurface | 'terminal'): void {
    this.openPanelAt(focusSurface ? 'detail' : '', focusSurface);
  }

  /** Open the panel on a named view. `view` empty means "wherever it already was". */
  private openPanelAt(view: string, detailId?: string): void {
    const panel = AwaitfulPanel.openOrReveal(
      this.context,
      (msg) => this.handlePanelMessage(msg),
      this.buildPanelState(),
    );
    if (view) panel.navigate(view, detailId);
    else this.noteWhatsNewShown(); // main view = the banner is on screen; let it retire after this session
    void this.refreshAccount();
    // Opening the panel is exactly the moment the developer wants a current answer about what is
    // installed, and the cheapest place to pay for one.
    void this.refreshPresence().then(() => this.syncPanel());
  }

  /**
   * The Claude Code setup article. Built from `this.base` (the awaitful.apiBaseUrl setting), never
   * a hardcoded domain; the panel message carries no slug, so the webview cannot steer
   * openExternal at an arbitrary path.
   */
  private openSetupDocs(): void {
    void vscode.env.openExternal(vscode.Uri.parse(`${this.base}/docs/claude-code-setup`));
  }

  /**
   * Reveal the other editor's extensions folder in the OS file manager.
   *
   * The path is re-derived here from a fresh assessment and never taken from the message, on the
   * same rule as openSetupDocs: the webview says WHICH ACTION, never which target. Reveal, not open
   * - showing a developer where a thing lives is help; opening another application's files is not
   * ours to do.
   */
  private showConflictHost(): void {
    const host = this.patch.assess().foreign?.vendorHost;
    const dir = host?.extensionDir ?? host?.dir;
    if (!dir) return;
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
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
    // Offer the best format this machine can use, once per sign-in, after the account + capability are
    // known. Fire-and-forget: a first-run flourish must never delay or fail the sign-in it rides on.
    this.onboardingOpenPending = true;
    void this.refreshAccount(true).then(() => this.maybeOpenOnboarding()).catch(() => undefined);
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.currentToken = undefined;
    this.accountEmail = undefined;
    this.accountName = undefined;
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
