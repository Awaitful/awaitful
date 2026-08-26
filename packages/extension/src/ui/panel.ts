import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { type ResolvedElement } from '@awaitful/shared';
// Its own subpath, not the barrel - see the note in shared/src/index.ts.
import { WIREFRAME_SVG } from '@awaitful/shared/wireframe';

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Why a surface cannot be chosen on this machine, or undefined when it is offerable.
 *
 *  - `no-agent-cli`      no coding agent is installed at all, so no thinking event can fire.
 *  - `no-agent-editor`   the agent's CLI is here but its VS Code extension is not, so the two
 *                        surfaces that patch that extension's bundle have nothing to attach to.
 *                        The status bar and the terminal still earn.
 *  - `unsupported-build` the agent is here, but this build has no recipe yet.
 *
 * Replaces the old `comingSoon` flag, which claimed a FEATURE was unbuilt when the truth was about
 * the machine. The flag is gone rather than kept: it was a lie in the only place it ever fired, and
 * a dead flag invites the next false badge.
 */
export type SurfaceBlockedReason =
  | 'no-agent-cli'
  | 'no-agent-editor'
  /** Another tool holds Claude Code's file. Named when it is installed, described when it is not. */
  | 'foreign-conflict'
  /** The file is not what we verified and nothing in it says who changed it. We accuse nobody. */
  | 'changed-unknown'
  /** Our patch is in place on a build we have no verified original for: cannot check or undo it. */
  | 'ours-unverified'
  /** A target could not be read at all - permissions, or Claude Code is mid-update. */
  | 'unreadable'
  /** Genuinely clean bytes on a build not verified yet. The ONLY case "not supported yet" is true. */
  | 'unsupported-build';

export interface PanelSurface {
  id: string;
  active: boolean;
  available: boolean;
  consentGranted: boolean;
  blockedReason?: SurfaceBlockedReason | undefined;
  modifiesFiles: boolean;
  /** Earning rate relative to the status bar (1 = base). From the live rate card; undefined until known. */
  earnRate: number | undefined;
  /** True when Claude Code has been modified by another extension. */
  conflict?: boolean | undefined;
  /** Display name of the other extension, ONLY when it is actually installed here. */
  conflictVendor?: string | undefined;
  /** Its extension id, so a step can open or remove THAT extension rather than a search result. */
  conflictVendorId?: string | undefined;
  /** Whether that extension is running, merely switched off, or gone. Drives both the copy and the
   *  step's done-state: 'no' means the remove step is already satisfied. */
  conflictVendorInstalled?: 'yes' | 'disabled' | 'removing' | 'no' | 'elsewhere' | 'unknown' | undefined;
  /** Which other editor holds it, and that extension's own folder (home-relative, display only).
   *  Set only with 'elsewhere', and the reason that state needs its own steps: nothing this window
   *  can click removes an extension belonging to another application.
   *  `pendingRemoval` means it was uninstalled there and that editor has not restarted, so it is
   *  still loaded and still writing - a different sentence and a shorter list. */
  conflictVendorHost?: { label: string; dir: string; pendingRemoval?: boolean } | undefined;
  /**
   * The developer removed Claude Code from inside the repair checklist and has not put it back.
   *
   * The one thing here that cannot be read off the disk: a machine with no Claude Code extension
   * looks identical whether someone is half way through a repair or never installed it. Without
   * this the checklist has to hand over to a different box with different numbering exactly when the
   * developer does what it asked, which reads as the software losing its place.
   */
  repairing?: boolean | undefined;
  /** Are Claude Code's files on DISK? Distinct from anyAgentEditor, which is the running window -
   *  they disagree between a removal and the reload that applies it, and that gap is why the reload
   *  is a step rather than a footnote. */
  agentFilesPresent?: boolean | undefined;
  /** Is it INSTALLED, as opposed to merely present on disk? A third fact again: an editor drops the
   *  registry entry the instant you uninstall and deletes the folder only when the whole app
   *  restarts, so between those moments Claude Code is uninstalled with its patched bytes intact. */
  agentInstalled?: boolean | undefined;
  /** The raw marker token found on disk (e.g. "VIBE-ADS"). A fact we can quote when the tool that
   *  wrote it is no longer installed, so we can be specific without naming a vendor we cannot find. */
  conflictToken?: string | undefined;
  /** True when a take-over can recover pristine from Awaitful-controlled sources. */
  canTakeOver?: boolean | undefined;
  /** False when this build has no recipe / no target (surface can't be offered here). */
  supported?: boolean | undefined;
  /** Active via a provisional self-recipe on a brand-new build, pending server confirmation. */
  provisional?: boolean | undefined;
  /**
   * Whether the surface is genuinely RENDERING, which is a separate axis from whether it is
   * chosen. `active` is the radio (our bytes are on disk and this is the picked spot); this says
   * whether anything has actually been seen on screen. Conflating them is what let the panel
   * report a surface as earning while it showed nothing.
   */
  live?: 'unknown' | 'loaded' | 'live' | 'reload-needed' | 'not-rendering' | 'silent' | undefined;
}

export interface PanelState {
  /** Extension version, shown in fine print in the panel footer. */
  version: string;
  /** What this editor calls itself (`vscode.env.appName`) - "Cursor", "Windsurf", "VS Codium". The
   *  section header used to say "Visual Studio Code" to every one of them, which is wrong for most
   *  of the editors this actually runs in. */
  appName: string;
  signedIn: boolean;
  email: string | undefined;
  /** Display name, shown in place of the email when set - falls back to email otherwise. */
  name: string | undefined;
  earningsToday: string | undefined;
  /** Earned but not yet paid out (lifetime minus payouts). */
  unredeemedUsd: string | undefined;
  disabled: boolean;
  /** True once the agent has thought at least once on this machine - the activation signal. Until it
   *  is true (and the developer is signed in and not paused), the panel shows the "no agent activity
   *  yet" hint, because a silent $0 is almost always "not actually running Claude Code here". */
  everThoughtSeen: boolean;
  /** At least one agent's own CLI is installed here. False means nothing can earn at all: no thinking
   *  hook can fire, so the status bar, the terminal and both webview spots are equally dead. */
  anyAgentCli: boolean;
  /** At least one agent's VS Code extension is installed in this window. The two webview spots patch
   *  that extension's bundle, so this gates them independently of anyAgentCli. */
  anyAgentEditor: boolean;
  /** No agent here, and clearing an older build's entries out of the agent's settings did not fully
   *  succeed - so the panel must not claim we left them untouched. Mirrors pauseRestoreFailed. */
  agentCleanupFailed: boolean;
  /** Paused, but the restore to pristine could not be confirmed, so we must not claim the editor is
   *  unmodified. */
  pauseRestoreFailed: boolean;
  /** Whether accrued earnings are shown in the VS Code status bar (idle state). */
  showEarningsInStatusBar: boolean;
  /** Off (default): a surface preference set from the web dashboard only nudges - this device must
   *  confirm here before any Claude Code file changes. On: it applies automatically, the same way it
   *  already does when a surface is picked here - this device's own opt-in IS the consent. */
  remoteControlAllowed: boolean;
  /** Set when an ad is currently showing in the status bar. */
  activeAdLine: string | undefined;
  /** Set when the showing ad is the zero-bid house fallback (bills nobody, pays nothing). */
  activeAdUnpaid: boolean;
  activeAdUrl: string | undefined;
  /**
   * How each ad format looks on this machine, keyed by format id: for every element that format
   * draws, its label, its options, and the value in force. The panel renders straight from this and
   * knows nothing about what a "spinner" or a "glow" is, so adding an element to the shared
   * catalogue gives every format that declares it a working control with no change here.
   *
   * Replaced the account-wide fields this panel once carried, which said one spinner for four
   * formats - never what it was actually storing. Those settings are gone entirely as of 0.7.5.
   */
  customize: Record<string, ResolvedElement[]>;
  /** The shared glow @keyframes/@property, injected once so a swatch preview animates for real. */
  glowKeyframes: string;
  /** VS Code surfaces — exactly one active at a time. */
  vsSurfaces: PanelSurface[];
  terminalEnabled: boolean;
  terminalConsentGranted: boolean;
  /** The terminal needs only the agent's CLI, never its VS Code extension, so 'no-agent-cli' is the
   *  only reason it can be blocked. */
  terminalBlockedReason?: 'no-agent-cli' | undefined;
  terminalEarnRate: number | undefined;
  /** Device-local: the onboarding stepper was dismissed with its ✕. Persisted, so it never returns on
   *  this machine - the format cards and the sync toggle stay the way to change things afterwards. */
  onboardingDismissed: boolean;
  /** The one format the stepper's "turn on a format" step offers - pickBestUpgrade's result (chat
   *  banner normally; the best available on a capability-limited machine). undefined when there is
   *  nothing better than the status bar to turn on here. */
  bestUpgrade: string | undefined;
  /** The extension version changed since this machine last saw the panel - show the one-time "what's
   *  new" banner. False on a fresh install (nothing to be new about) and after it is acknowledged. */
  justUpdated: boolean;
  /** The account's web-set format preference (from /v1/me). A non-null value - including "status-bar" -
   *  is a deliberate dashboard choice, so the stepper's format step counts as settled and never pushes a
   *  different format against it. */
  remoteSurfacePref: string | null;
}

export type PanelMessage =
  | { type: 'sign-in' }
  | { type: 'sign-out' }
  | { type: 'open-dashboard' }
  /** The ONE customization write. Four element-specific messages collapsed into it; the host
   *  validates the (format, element, value) triple against the shared catalogue before storing. */
  | { type: 'set-element'; format: string; element: string; value: string | boolean }
  | { type: 'set-surface'; id: string }
  | { type: 'consent-grant'; id: string; takeover?: boolean }
  | { type: 'toggle-terminal' }
  | { type: 'restore-files' }
  /** Carries where the panel was when it was clicked, so the reload can land back on that page.
   *  Both fields are validated host-side against the known views and format ids - the webview says
   *  where it WAS, it does not get to name an arbitrary destination. */
  | { type: 'reload-window'; view?: string; detailId?: string }
  | { type: 'open-extensions'; query: string }
  /** Open ONE extension's own page. The id is echoed back from what the host itself detected and
   *  sent down, never composed in the webview - so this cannot be pointed at an arbitrary target. */
  | { type: 'open-extension'; id: string }
  /** Remove one extension, on an explicit click on a button that says so. Same id constraint. The
   *  host never does this on its own initiative - see the conflict box's doc comment. */
  | { type: 'uninstall-extension'; id: string; from?: string }
  /** Install one extension (only ever the agent's own, to undo the uninstall a step above). */
  | { type: 'install-extension'; id: string }
  /** Carries no slug on purpose: the webview must not be able to steer openExternal at any path. */
  | { type: 'open-setup-docs' }
  /** Reveal the other editor's extensions folder. Carries no path, for the same reason. */
  | { type: 'show-conflict-host' }
  | { type: 'open-github' }
  | { type: 'open-privacy' }
  | { type: 'toggle-enabled' }
  | { type: 'toggle-statusbar-earnings' }
  | { type: 'toggle-remote-control' }
  /** Dismiss the onboarding stepper (its ✕). Available only once signed in - the signed-out stepper
   *  IS the sign-in surface, so there is nothing to dismiss to. Persisted device-local by the host. */
  | { type: 'dismiss-onboarding' }
  /** Open the release notes AND mark this version seen, from the post-update banner's "See what's new". */
  | { type: 'whats-new' }
  /** Mark this version seen without opening anything, from the post-update banner's ✕. */
  | { type: 'dismiss-whats-new' }
  | { type: 'visit-ad' };

// ── Panel singleton ───────────────────────────────────────────────────────────

export class AwaitfulPanel {
  private static instance: AwaitfulPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onMessageCallback: (msg: PanelMessage) => void;

  private constructor(
    context: vscode.ExtensionContext,
    onMessage: (msg: PanelMessage) => void,
    initialState: PanelState,
  ) {
    this.onMessageCallback = onMessage;

    this.panel = vscode.window.createWebviewPanel(
      'awaitful.panel',
      'Awaitful',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.webview.html = buildHtml(initialState);

    this.panel.webview.onDidReceiveMessage(
      (msg: PanelMessage) => this.onMessageCallback(msg),
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => {
        AwaitfulPanel.instance = undefined;
        this.disposables.forEach((d) => d.dispose());
      },
      undefined,
      context.subscriptions,
    );
  }

  /**
   * Open the panel, or bring an already-open one forward. REVEALS, so it is only ever correct for
   * something the developer just asked for: a command, a notification they clicked, or the page
   * being restored after they pressed Reload here.
   *
   * Never call this to deliver a state update. See `update`.
   */
  static openOrReveal(
    context: vscode.ExtensionContext,
    onMessage: (msg: PanelMessage) => void,
    state: PanelState,
  ): AwaitfulPanel {
    if (AwaitfulPanel.instance) {
      // Its OWN column, not the active one. Revealing into the active column drags the tab across
      // the window to wherever the developer happens to be working, which is a second surprise on
      // top of the tab changing at all.
      AwaitfulPanel.instance.panel.reveal(AwaitfulPanel.instance.panel.viewColumn, true);
      AwaitfulPanel.instance.setState(state);
      return AwaitfulPanel.instance;
    }
    const inst = new AwaitfulPanel(context, onMessage, state);
    AwaitfulPanel.instance = inst;
    return inst;
  }

  /**
   * Deliver a state update to an open panel, and do NOTHING if it is closed.
   *
   * The separation is the whole point. `syncPanel` runs on 35 different occasions - every thinking
   * tick, every account refresh, every presence change - and it used to reach the open panel through
   * `openOrReveal`, which reveals. So the panel hauled its own tab to the front of its group over
   * and over: a developer talking to their agent watched the settings tab replace whatever they were
   * reading, on a window nobody had reloaded and a panel nobody had asked for. Updating state and
   * asking for attention are different acts and must not share a door.
   */
  static update(state: PanelState): void {
    AwaitfulPanel.instance?.setState(state);
  }

  static isOpen(): boolean {
    return !!AwaitfulPanel.instance;
  }

  /** Push a state update to the already-open panel without full re-render. */
  setState(state: PanelState): void {
    void this.panel.webview.postMessage({ type: 'state', state });
  }

  /** Steer the open panel to a view ('detail' = one format's own page, paired with detailId); used
   *  by commands and the settings link, so every entrance lands on the same page with the same back
   *  button. */
  navigate(view: string, detailId?: string): void {
    void this.panel.webview.postMessage({ type: 'navigate', view, detailId });
  }

  dispose(): void {
    AwaitfulPanel.instance = undefined;
    this.panel.dispose();
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────

/**
 * Exported for the tests, and only for them. Everything below this line is a template literal, which
 * means TypeScript checks none of it: the CSS is a string, and so is the entire client script. A
 * typo compiles cleanly and breaks the panel at runtime, in a webview whose console nobody watches.
 * panel.test.ts parses the script and asserts the CSP, so that class of silence has one guard.
 */
export function buildHtml(initialState: PanelState): string {
  const nonce = randomUUID().replace(/-/g, '');
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    // `data:` only, never a remote host: the logo preview must render an <img> the same way the shim
    // does, and an extension panel that can reach out to the network is a promise we do not make.
    `img-src data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Awaitful</title>
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="initial-state">${JSON.stringify(initialState)}</script>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{height:100%}

body{
  font-family:var(--vscode-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);
  font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;
  background:var(--bg);color:var(--text);
  min-height:100%;
}

/* ── Theme tokens ── */
body.vscode-light{
  --bg:#ffffff;--surface:oklch(98.5% 0.003 135);--surface-2:#ffffff;
  --border:oklch(10% 0.004 135 / 0.10);--border-strong:oklch(10% 0.004 135 / 0.20);
  --text:oklch(10% 0.004 135);--text-2:oklch(33% 0.006 135);--text-3:oklch(47% 0.006 135);
  --brand:oklch(86% 0.171 134);--brand-dark:oklch(29% 0.084 135);
  --cta:oklch(29% 0.084 135);--cta-text:#ffffff;
  --active-border:oklch(29% 0.084 135);--active-bg:oklch(96% 0.06 134);
  --ring:oklch(52% 0.170 145 / 0.32);
  --warn:oklch(52% 0.140 58);
  --warn-bg:oklch(52% 0.140 58 / 0.08);
  --warn-edge:oklch(52% 0.140 58 / 0.28);
  --danger:oklch(48% 0.190 26);
  --danger-edge:oklch(48% 0.190 26 / 0.30);
  --toggle-off:oklch(10% 0.004 135 / 0.18);
}
body.vscode-dark,body.vscode-high-contrast{
  --bg:oklch(11% 0.050 135);--surface:oklch(18% 0.064 135);--surface-2:oklch(22% 0.072 135);
  --border:oklch(86% 0.171 134 / 0.13);--border-strong:oklch(86% 0.171 134 / 0.25);
  --text:oklch(97% 0.004 135);--text-2:oklch(70% 0.010 135);--text-3:oklch(52% 0.008 135);
  --brand:oklch(86% 0.171 134);--brand-dark:oklch(86% 0.171 134);
  --cta:oklch(86% 0.171 134);--cta-text:oklch(10% 0.004 135);
  --active-border:oklch(86% 0.171 134);--active-bg:oklch(86% 0.171 134 / 0.09);
  --ring:oklch(80% 0.190 140 / 0.36);
  --warn:oklch(80% 0.120 72);
  --warn-bg:oklch(80% 0.120 72 / 0.11);
  --warn-edge:oklch(80% 0.120 72 / 0.32);
  --danger:oklch(74% 0.150 26);
  --danger-edge:oklch(74% 0.150 26 / 0.34);
  --toggle-off:oklch(86% 0.171 134 / 0.20);
}
/* fallback for unthemed body */
body:not(.vscode-light):not(.vscode-dark):not(.vscode-high-contrast){
  --bg:var(--vscode-sideBar-background,#1e1e1e);--surface:#252526;--surface-2:#2d2d2d;
  --border:rgba(255,255,255,0.10);--border-strong:rgba(255,255,255,0.20);
  --text:var(--vscode-foreground,#ccc);--text-2:#999;--text-3:#666;
  --brand:oklch(86% 0.171 134);--brand-dark:oklch(86% 0.171 134);
  --cta:oklch(86% 0.171 134);--cta-text:oklch(10% 0.004 135);
  --active-border:oklch(86% 0.171 134);--active-bg:oklch(86% 0.171 134 / 0.09);
  --ring:oklch(80% 0.190 140 / 0.36);
  --warn:oklch(80% 0.120 72);
  --warn-bg:oklch(80% 0.120 72 / 0.11);
  --warn-edge:oklch(80% 0.120 72 / 0.32);
  --toggle-off:rgba(255,255,255,0.18);
}

/* ── Layout ── */
.panel{max-width:480px;margin:0 auto;padding:20px 16px 32px}

/* ── Header ── */
/* Two full-width rows stacked, not one row beside a 2-line text column: that is what lets the
   right-hand controls (the web-control toggle, the status-bar eye) land in the same x-position,
   one directly under the other, instead of the bottom one trailing left of the top one. */
.header{display:flex;flex-direction:column;gap:2px;margin-bottom:20px}
.header-row{display:flex;align-items:center;gap:10px}
.avatar{
  width:34px;height:34px;border-radius:50%;
  background:var(--brand);color:oklch(10% 0.004 135);
  display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:14px;flex-shrink:0;
}
/* Row 2 has no avatar - this spacer keeps its text lined up under the name above, not the avatar. */
.header-spacer{width:34px;flex-shrink:0}
.header-email{flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-sub-text{flex:1;min-width:0;font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-sub-eye{display:flex;align-items:center;gap:4px;flex-shrink:0}
.header-sub-eye .eye-btn{margin-left:0}
/* Row 1, right edge: the account-wide "let the web dashboard control this device" switch - it lives
   with the identity it governs, not buried between the surface cards it happens to affect. Shares
   .hdr-toggle-label with the status-bar toggle below it. */
.header-rc{display:flex;align-items:center;gap:6px;flex-shrink:0}
.hdr-toggle-label{font-size:11px;color:var(--text-2);white-space:nowrap}
.toggle.sm{width:26px;height:16px}
.toggle.sm::after{width:10px;height:10px;top:3px;left:3px}
.toggle.sm.on::after{transform:translateX(10px)}
.info-btn{position:relative;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:none;border:none;padding:3px;border-radius:6px;color:var(--text-3);cursor:pointer;transition:color .12s,background .12s}
.info-btn::before{content:'';position:absolute;top:50%;left:50%;width:28px;height:28px;transform:translate(-50%,-50%)}
.info-btn:hover{color:var(--text);background:var(--surface)}
.info-btn:focus-visible{outline:2px solid var(--brand-dark);outline-offset:1px}
.header-rc-note{font-size:11px;color:var(--text-3);line-height:1.5;margin:6px 0 14px}
.eye-btn{position:relative;margin-left:auto;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:none;border:none;padding:5px;border-radius:6px;color:var(--text-3);cursor:pointer;transition:color .12s,background .12s}
/* Extend the tap/click target to 40px without enlarging the visible button (dense desktop min). */
.eye-btn::before{content:'';position:absolute;top:50%;left:50%;width:40px;height:40px;transform:translate(-50%,-50%)}
.eye-btn:hover{color:var(--text);background:var(--surface)}
.eye-btn:focus-visible{outline:2px solid var(--brand-dark);outline-offset:1px}

/* ── Sign-in prompt ── */
.signin{
  background:var(--surface);border:1px solid var(--border);
  border-radius:10px;padding:24px 20px;text-align:center;margin-bottom:20px;
}
.signin-logo{
  width:44px;height:44px;border-radius:12px;background:var(--brand);
  display:flex;align-items:center;justify-content:center;
  font-size:22px;margin:0 auto 12px;
}
.signin h3{font-size:15px;font-weight:600;margin-bottom:4px;text-wrap:balance}
.signin p{font-size:12px;color:var(--text-2);margin-bottom:16px;line-height:1.5}

/* ── What's-new banner (post-update, one-time) ── */
.whatsnew{display:flex;align-items:center;gap:8px;background:var(--active-bg);border:1px solid var(--active-border);border-radius:9px;padding:8px 10px;margin-bottom:16px}
.whatsnew-spark{color:var(--brand-dark);font-size:12px;flex-shrink:0}
.whatsnew-text{font-size:12px;font-weight:600;color:var(--text);flex-shrink:0}
.whatsnew-cta{font-size:11.5px;font-weight:600;color:var(--brand-dark);background:none;border:none;padding:2px 4px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.whatsnew-cta:hover{opacity:.8}
.whatsnew-cta:focus-visible{outline:2px solid var(--brand-dark);outline-offset:1px;border-radius:4px}
.whatsnew-x{margin-left:auto;flex-shrink:0;width:22px;height:22px;display:flex;align-items:center;justify-content:center;background:none;border:none;border-radius:6px;color:var(--text-3);font-size:15px;line-height:1;cursor:pointer;transition:color .12s,background .12s}
.whatsnew-x:hover{color:var(--text);background:var(--surface-2)}
.whatsnew-x:focus-visible{outline:2px solid var(--brand-dark);outline-offset:1px}

/* ── Onboarding stepper ── */
/* A vertical 3-step guide pinned to the top: sign in, turn on a format, sync. Every step's done/current
   state is DERIVED from panel state (no stored step flags); only the ✕-dismissal is persisted. */
.stepper{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 16px 10px;margin-bottom:20px}
.stepper-title{font-size:13px;font-weight:600;color:var(--text)}
.stepper-sub{font-size:11px;color:var(--text-3);margin:2px 0 15px}
.stepper-x{position:absolute;top:9px;right:9px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;background:none;border:none;border-radius:6px;color:var(--text-3);font-size:16px;line-height:1;cursor:pointer;transition:color .12s,background .12s}
.stepper-x:hover{color:var(--text);background:var(--surface-2)}
.stepper-x:focus-visible{outline:2px solid var(--brand-dark);outline-offset:1px}
.step{display:flex;gap:12px;position:relative;padding-bottom:16px}
.step:last-child{padding-bottom:6px}
.step-rail{position:relative;flex-shrink:0;width:22px;display:flex;justify-content:center}
.step:not(:last-child) .step-rail::after{content:'';position:absolute;top:24px;bottom:-14px;left:50%;transform:translateX(-50%);width:1.5px;background:var(--border)}
.step.done .step-rail::after{background:var(--active-border)}
.step-num{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;z-index:1;border:1.5px solid var(--border-strong);color:var(--text-3);background:var(--bg)}
.step.current .step-num{border-color:var(--active-border);color:var(--cta);background:var(--active-bg)}
.step.done .step-num{border-color:var(--active-border);background:var(--active-border);color:var(--cta-text)}
.step-main{flex:1;min-width:0}
.step-title{font-size:12.5px;font-weight:600;color:var(--text)}
.step.todo .step-title,.step.blocked .step-title{color:var(--text-3);font-weight:500}
.step-sub{font-size:11px;color:var(--text-3);line-height:1.45;margin-top:1px}
.step-act{margin-top:9px}
.step-blocked-note{font-size:10.5px;color:var(--text-3);line-height:1.4;margin-top:5px}

/* ── Interactive illustration ── */
.illus-wrap{
  background:var(--surface);border:1px solid var(--border);
  border-radius:10px;overflow:hidden;margin-bottom:16px;
  aspect-ratio:16/9;position:relative;
  /* The artwork is theme-agnostic; these three say what OUR green is here. --brand is the same
     value in all three theme blocks, so the picture is pixel-identical to before the move. */
  --awf-hl:var(--brand);--awf-hl-ink:oklch(10% 0.004 135);--awf-hl-glyph:#fff;
}
.illus-wrap svg{width:100%;height:100%;display:block}
/* Which region is lit is an ATTRIBUTE on the wrapper, not a class toggled per element. The wrapper
   can therefore be coloured and aimed before it is ever in the document, which is what removes the
   old bug: the list page called updateHighlight() while the svg was still detached, getElementById
   returned null, and the default highlight silently never applied until the first hover-out. */
.illus-wrap [data-region]{opacity:0;transition:opacity 180ms ease}
.illus-wrap[data-active='status-bar'] [data-region='status-bar'],
.illus-wrap[data-active='thinking-line'] [data-region='thinking-line'],
.illus-wrap[data-active='chat-banner'] [data-region='chat-banner'],
.illus-wrap[data-active='terminal'] [data-region='terminal']{opacity:1}

/* ── Privacy strip ── */
/* The strongest thing this product can say about itself, so it is given room to say it: the mark
   sits in its own tinted plate on the left and every line of copy runs in one column to its right.
   It used to be a 14px glyph inline with the sentence, which read as a footnote. */
.privacy{
  display:flex;align-items:flex-start;gap:12px;
  background:var(--surface);border:1px solid var(--border);
  border-radius:10px;padding:13px 14px;margin-bottom:14px;
  cursor:pointer;transition:border-color .12s,background .12s;
}
.privacy:hover{border-color:var(--brand-dark);background:var(--surface-2,var(--surface))}
.privacy:focus-visible{outline:2px solid var(--brand-dark);outline-offset:1px}
.privacy-mark{
  flex-shrink:0;width:38px;height:38px;border-radius:10px;
  display:flex;align-items:center;justify-content:center;
  background:color-mix(in oklab, var(--brand-dark) 10%, transparent);
  color:var(--brand-dark);
}
.privacy-mark svg{width:21px;height:21px}
.privacy-col{display:flex;flex-direction:column;gap:4px;min-width:0}
.privacy-title{font-size:12.5px;font-weight:700;color:var(--text);letter-spacing:.005em}
.privacy-text{font-size:11px;color:var(--text-2);line-height:1.55;text-wrap:pretty}
/* The line that turns a reassurance into a next move. A shade stronger than the body, so the eye
   lands on it after the promise rather than before it. */
.privacy-do{font-size:11px;color:var(--text);line-height:1.55;text-wrap:pretty}
.privacy-more{color:var(--brand-dark);font-weight:600;white-space:nowrap}

/* ── "What leaves your machine" view ── */
.send-row{padding:9px 0;border-bottom:1px solid var(--border)}
.send-row:last-child{border-bottom:none;padding-bottom:0}
.send-row:first-child{padding-top:0}
.send-h{font-size:12px;font-weight:600;color:var(--text);margin-bottom:2px}
.send-b{font-size:11px;color:var(--text-2);line-height:1.5}
.never-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:2px}
.never-h{font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px}
.never-list{margin:0;padding-left:16px}
.never-list li{font-size:11px;color:var(--text-2);line-height:1.7}

/* ── Earning-rate chip ── */
.card-name-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rate{
  font-size:11px;font-weight:700;letter-spacing:.01em;
  color:var(--brand-dark);background:var(--active-bg);
  border:1px solid var(--active-border);border-radius:10px;
  padding:1px 8px;white-space:nowrap;cursor:default;font-variant-numeric:tabular-nums;
}
.rate.base{color:var(--text-3);background:var(--surface-2);border-color:var(--border);font-weight:600}

/* ── Safe tag (surfaces that change nothing) ── */
.tag-safe{font-size:10px;font-weight:500;color:var(--brand-dark);display:flex;align-items:center;gap:3px}

/* ── Section label ── */
.sect{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin:16px 0 6px}
.sect-sub{font-size:11px;color:var(--text-3);margin:-2px 0 8px}

/* ── Surface card ── */
.card{
  display:flex;align-items:flex-start;gap:10px;
  background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:10px 12px;margin-bottom:6px;
  cursor:pointer;transition:border-color 120ms,background 120ms,box-shadow 120ms;
  user-select:none;
}
.card:hover:not(.active):not(.blocked){border-color:var(--border-strong)}
/* Selected surface: not a hard 1px outline but the site's focused-field treatment - the accent border
   plus a soft ring and a little depth, so it reads as chosen, not just bordered. */
.card.active{border-color:var(--active-border);background:var(--active-bg);box-shadow:0 0 0 3px var(--ring),0 1px 4px rgba(0,0,0,.10)}
/* Cannot run on this machine (no agent, no editor extension, unsupported build). Inert, and faded -
   but only its IDENTITY fades. The reason and its way out stay at full strength, because reading
   them is the entire point of the state; a 55% explanation would be the silent dead end again in a
   quieter font. (Opacity cannot be undone on a descendant, hence the per-element list.) */
.card.blocked{cursor:default}
.card.blocked .card-icon,
.card.blocked .card-name-row,
.card.blocked .card-desc,
.card.blocked .card-meta{opacity:.55}
.card.blocked:hover{border-color:var(--warn-edge)}
/* Signed-out: the surface is visible but deactivated (faded) until sign-in. */
.card.locked{opacity:.55}
.lock{display:flex;align-items:center;justify-content:center;width:34px;color:var(--text-3)}
.card-icon{width:28px;height:28px;border-radius:6px;background:var(--surface-2);border:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;margin-top:1px}
.card-body{flex:1;min-width:0}
.card-name{font-size:13px;font-weight:600;color:var(--text)}
.card-desc{font-size:11px;color:var(--text-2);margin-top:2px;line-height:1.4;text-wrap:pretty}
.card-meta{display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap}
.tag-mod{font-size:10px;color:var(--text-3);display:flex;align-items:center;gap:3px}
.tag-mod svg{opacity:.6}
.card-action{flex-shrink:0;display:flex;align-items:center;margin-top:2px}
.badge-blocked{font-size:10px;color:var(--text-3);background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:2px 8px}
/* Why a card is blocked - same weight and rhythm as .card-conflict, since both answer "why can I
   not pick this?" and both end in the way out. */
.card-blocked{margin-top:6px;font-size:11px;line-height:1.4;color:var(--text-2);text-wrap:pretty}
/* With a warning mark the text hangs beside it rather than wrapping under it - the same shape as the
   conflict hint, so the two read as one class of problem. */
.more-link{color:var(--brand-dark);font-weight:600;background:none;border:0;padding:0;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.more-link:hover{text-decoration:underline}
.more-link:focus-visible{outline:2px solid var(--brand-dark);outline-offset:2px;border-radius:4px}

/* ── Toggle ── */
.toggle{
  width:34px;height:20px;background:var(--toggle-off);border-radius:10px;
  border:none;padding:0;cursor:pointer;position:relative;transition:background 180ms;
  flex-shrink:0;
}
.toggle.on{background:var(--active-border)}
/* Extend the switch's click target to 40px tall without changing its look; it sits alone at a row's
   right edge, so the larger area never overlaps a neighbouring control. */
.toggle::before{content:'';position:absolute;top:50%;left:50%;width:100%;min-width:40px;height:40px;transform:translate(-50%,-50%)}
.toggle::after{
  content:'';width:14px;height:14px;background:#fff;border-radius:50%;
  position:absolute;top:3px;left:3px;transition:transform 180ms;
  box-shadow:0 1px 3px rgba(0,0,0,.25);
}
.toggle.on::after{transform:translateX(14px)}
.toggle:focus-visible{outline:2px solid var(--brand-dark);outline-offset:2px}

/* ── Card action slot ──
   Two glyphs, each doing one job: what the state IS, then the chevron saying this leads to the page
   where it is changed. The state glyph differs by KIND, and that difference is the point - the three
   VS Code formats are pick-one (a ring, filled when chosen), while the terminal runs alongside
   whichever one you picked and so wears a switch. Giving the terminal the same ring would say it is
   a fourth contender for a slot only one thing can hold, which is the opposite of what it does. */
.pick{width:18px;height:18px;border-radius:50%;border:2px solid var(--border-strong);flex-shrink:0;position:relative;background:transparent;transition:border-color 150ms}
.pick.on{border-color:var(--active-border)}
.pick.on::after{content:'';position:absolute;inset:3px;border-radius:50%;background:var(--active-border)}
.card:hover .pick:not(.on){border-color:var(--text-3)}
.card-go{display:flex;align-items:center;color:var(--text-3);transition:color 120ms,transform 120ms}
.card:hover .card-go{color:var(--text-2);transform:translateX(2px)}
.card:focus-visible{outline:2px solid var(--brand-dark);outline-offset:2px}

/* ── Conflict hint on a card (a competitor changed Claude Code) ── */
/* A blocked card is the one thing on this list a developer has to act on, and it used to whisper it
   in the same grey as the description above. Same tinted callout the detail page gives the same
   problem, so the two read as one thing seen at two zoom levels. Warn, not red: nothing here is
   destructive or lost - it is stopped, and there is a way out. */
.card-conflict{display:flex;align-items:flex-start;gap:6px;margin-top:7px;padding:6px 8px;font-size:11px;line-height:1.45;text-align:left;
  color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-edge);border-radius:6px;text-wrap:pretty}
.card-conflict svg{flex-shrink:0;margin-top:2px;color:var(--warn)}
.card-conflict .more{color:var(--warn);font-weight:700;white-space:nowrap;text-decoration:underline}

/* ── Divider ── */
.div{height:1px;background:var(--border);margin:14px 0}

/* ── Footer ── */
.footer{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px}
.btn-ghost{font-size:12px;color:var(--text-2);background:none;border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer;transition:border-color 100ms,color 100ms}
.btn-ghost:hover{border-color:var(--border-strong);color:var(--text)}
/* Tokenised per theme. This was one hardcoded 40%-lightness red for both, which reads on white and
   all but vanishes against the dark surface - on the button that undoes every file change we made,
   which is the last control that should be hard to find. */
.btn-ghost.danger{color:var(--danger);border-color:var(--danger-edge)}
.btn-ghost.danger:hover{background:color-mix(in oklab, var(--danger) 9%, transparent)}

/* ── Detail view ── */
.view{display:none}
.view.on{display:block}
.back{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:var(--text-2);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 12px 6px 9px;cursor:pointer;margin-bottom:16px;transition:border-color 120ms,color 120ms,background 120ms}
.back:hover{color:var(--text);border-color:var(--border-strong);background:var(--surface-2)}
.back:focus-visible{outline:2px solid var(--brand-dark);outline-offset:2px}
.back svg{flex-shrink:0;opacity:.9}
.detail-title{font-size:17px;font-weight:700;margin-bottom:4px;text-wrap:balance}
/* Heading and its action on one line, the action flush with the illustration's right edge. */
.detail-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:2px}
.detail-head>.card-name-row{flex:1;min-width:0}
.detail-head>.btn-primary{flex-shrink:0;margin-top:1px}
.detail-head>.btn-primary:disabled{opacity:.55;cursor:default}
.detail-desc{font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:16px;text-wrap:pretty}
.info-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px}
.info-box.conflict{border-color:oklch(70% 0.14 70 / .5);background:oklch(70% 0.14 70 / .08)}
.conflict-text{font-size:12px;color:var(--text-2);line-height:1.55;text-wrap:pretty}
/* ── The numbered rail ──
   Geometry is taken from the dot itself, never from a fixed offset guess. Rows align to flex-start
   so the dot's position cannot depend on how far its label wraps: under align-items:center a
   two-line row pushed the dot down while the connector's top stayed where it was, which is why the
   line rendered as a stub that never reached the next number. The connector now starts at the dot's
   bottom edge (top:1.5em, the dot's own height) and runs to the bottom of the row's padding box -
   and that padding IS the gap between rows, so it lands exactly on the next dot's top edge.
   All em, against ONE font context set here on the container, so the rail tracks the panel's text
   size and every child measures the same em. Anything that draws part of the rail must inherit that
   size; a child with its own font-size would put its segment a fraction of a pixel off. */
.conflict-actions{display:flex;flex-direction:column;margin-top:11px;font-size:12px}
/* The spent-checklist actions: side by side, because neither is a step and neither comes first. */
.stalled-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
/* An aside BETWEEN two steps. Indented to the label column with the rail carried through, because
   full width broke the connector in half and left the steps below it reading as a second, unrelated
   list that had lost its place in the first. */
/* Indented to the label column - 1.5em of dot plus the .75em gap - and carrying the rail straight
   through, so an aside between two steps does not cut the sequence in half. It sits INSIDE the same
   column as the steps and inherits their font-size, which is what keeps its segment on the same
   vertical line as theirs. */
.step-note{position:relative;padding-left:2.25em;padding-bottom:.75em;color:var(--text-3);line-height:1.5;text-wrap:pretty}
.step-note::before{content:'';position:absolute;left:calc(.75em - .75px);top:0;bottom:0;width:1.5px;background:var(--border-strong)}
.step-note.after-done::before{background:var(--active-border)}
/* The checklist failed. It used to say so in the same grey aside used for footnotes, directly under
   a full row of ticks - so the one sentence that contradicted the ticks was the quietest thing in
   the box. Same warn treatment the cards use for the same class of problem. */
.stalled{display:flex;align-items:flex-start;gap:7px;margin-top:11px;padding:8px 9px;border-radius:6px;
  font-size:11.5px;line-height:1.5;text-wrap:pretty;color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-edge)}
.stalled svg{flex-shrink:0;margin-top:2px;color:var(--warn)}
.stalled b{font-weight:700}
.conflict-step{display:flex;align-items:flex-start;gap:.75em;position:relative;padding-bottom:.75em}
/* The last row ends the rail, so it carries no trailing gap to draw one into. */
.conflict-actions>*:last-child{padding-bottom:0}
.conflict-step .num{flex-shrink:0;width:1.5em;height:1.5em;border-radius:50%;border:1.5px solid var(--warn);color:var(--warn);font-weight:700;line-height:1;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;background:transparent;transition:background 160ms,border-color 160ms,color 160ms}
.conflict-step .num svg{width:.83em;height:.83em}
/* Done: filled, ticked, and the rail below it turns with it - so the list reads as progress rather
   than as a static set of instructions. Derived from the world (the extension really is gone), never
   from "a button was clicked", so it is equally right when the developer did it in VS Code's own
   view or had already done it before opening this panel. */
.conflict-step.done .num{background:var(--active-border);border-color:var(--active-border);color:var(--cta-text)}
.conflict-step.done .lbl{color:var(--text-3)}
/* The connector between one step and the next. Drawn from the step ABOVE, so its colour says
   "everything up to here is done" rather than decorating a step not yet reached. */
.conflict-step:not(:last-child)::before{content:'';position:absolute;left:calc(.75em - .75px);top:1.5em;bottom:0;width:1.5px;background:var(--border-strong)}
.conflict-step.done:not(:last-child)::before{background:var(--active-border)}
.conflict-manual{margin-top:11px}
/* The manual path, unfolded. Sunk into the box rather than raised out of it: it is the alternative
   route, not the recommended one, and it must not out-shout the numbered steps above it. */
.manual-box{margin-top:9px;padding:10px 11px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px}
.manual-box .conflict-step{margin-top:8px;padding-bottom:0}
/* Marker, not a number: these open a page, they are not part of the count above. */
.manual-box .num.open{border-color:var(--border-strong);color:var(--text-3)}
.manual-box .conflict-step::before{display:none}
.manual-box .lbl{color:var(--text-3)}
.conflict-step .lbl{flex:1;font-size:12px;color:var(--text-2);line-height:1.4}
.conflict-act{flex-shrink:0;font-size:11.5px;font-weight:600;color:var(--brand-dark);background:none;border:1px solid var(--border-strong);border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap;transition:background 100ms}
.conflict-act:hover{background:var(--surface-2)}
.conflict-act:focus-visible{outline:2px solid var(--brand-dark);outline-offset:2px}
.file-why{font-size:11px;color:var(--text-3);line-height:1.5;margin:3px 0 2px}
.meta-line{text-align:center;font-size:10px;color:var(--text-3);margin-top:16px;opacity:.75}
.meta-link{font-size:10px;color:var(--text-3);background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;transition:text-decoration-color 100ms}
.meta-link:hover{text-decoration-color:currentColor;color:var(--text-2)}
.btn-ghost:disabled{opacity:.45;cursor:default}
.btn-ghost.danger:disabled:hover{background:none;border-color:var(--border)}
.info-label{font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px}
.code-path{font-family:var(--vscode-editor-font-family,ui-monospace,'JetBrains Mono',monospace);font-size:11px;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:6px 8px;word-break:break-all;line-height:1.4;color:var(--text)}
.restore-list{list-style:none;font-size:12px;color:var(--text-2);line-height:1.9}
.restore-list li::before{content:'· ';color:var(--text-3)}
.theme-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.theme-chip{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);border-radius:14px;padding:4px 11px 4px 6px;cursor:pointer;transition:border-color 120ms,background 120ms,color 120ms}
.theme-chip:hover{border-color:var(--border-strong)}
.theme-chip.on{color:var(--brand-dark);background:var(--active-bg);border-color:var(--active-border);font-weight:600}
.theme-swatch{width:22px;height:11px;border-radius:6px;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(128,128,128,.25)}
/* Live theme preview — a mock ad banner + mock chat box, with a frame-aware glow (mirrors the shim). */
.bp-preview{position:relative;margin:10px 0 12px}
.bp-glow{position:absolute;top:-2px;left:0;right:0;z-index:2;pointer-events:none;box-sizing:border-box;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor}
.bp-glow.f-banner{bottom:42px;padding:2px 2px 0 2px;border-radius:9px 9px 0 0}      /* rings the ad, open bottom */
.bp-glow.f-full{left:-2px;right:-2px;bottom:-2px;padding:2px;border-radius:9px}       /* wraps ad + chat box */
.bp-face{position:relative;z-index:1;display:flex;align-items:center;gap:6px;background:var(--surface-2);border-radius:7px 7px 0 0;padding:6px 11px;font-size:12px;overflow:hidden;white-space:nowrap}
.bp-timer{margin-left:auto;flex:0 0 auto;opacity:.55;font-variant-numeric:tabular-nums;color:var(--text-3)}
.bp-box{position:relative;z-index:1;box-sizing:border-box;height:42px;background:var(--surface-2);border:1px solid var(--border);border-radius:0 0 7px 7px;display:flex;align-items:center;padding:0 11px}
.bp-box span{font-size:12px;color:var(--text-3)}
.bp-preview.is-full .bp-face{border-bottom:1px solid var(--border)}                    /* divider between ad + chat */
.bp-preview.is-full .bp-box{border-color:transparent;border-top-color:var(--border)}   /* the glow is the outer edge */

/* ── Customize: one element's control, on a format's own page ── */
.elem{margin-top:14px}
.elem:first-of-type{margin-top:10px}
.elem-head{margin-bottom:2px}
.opt-row{display:flex;align-items:center;gap:12px}
.opt-text{min-width:0}
.opt-title{font-size:12px;color:var(--text)}
.opt-sub{font-size:11px;color:var(--text-3);margin-top:2px;line-height:1.45}
.opt-row .toggle{flex:0 0 auto;margin-left:auto}
/* The example is the ad line itself: same order the shim paints, spinner then logo then text. */
.ad-eg{display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 11px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:12px}
.ad-eg-spin{flex:0 0 1em;width:1em;text-align:left;font-family:var(--vscode-editor-font-family,ui-monospace,'SF Mono',monospace);color:var(--text-2);opacity:.85}
.ad-eg-logo{width:1.15em;height:1.15em;border-radius:.2em;flex:0 0 auto;object-fit:contain;
  transition:opacity 160ms cubic-bezier(.32,.72,0,1),width 160ms cubic-bezier(.32,.72,0,1),margin-right 160ms cubic-bezier(.32,.72,0,1)}
/* Off: collapse the slot rather than just hide it, so the text closes the gap exactly as it will in
   the editor. Negative margin cancels the flex gap, or the line would keep a phantom logo's width. */
.ad-eg.off .ad-eg-logo{opacity:0;width:0;margin-right:-8px}
.ad-eg-text{color:var(--text);text-decoration:underline;overflow:hidden;text-overflow:ellipsis;min-width:0}
/* Inside the chat banner's mock the same line has no box of its own - the banner IS the box, and one
   preview per page is the rule. Every format previews the ad line; only this one wraps it in chrome. */
.bp-face .ad-eg{background:none;border:0;padding:0;margin:0;flex:1;min-width:0}

/* ── Customize: the spinner gallery ── */
.spin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px;margin-top:10px}
.spin-tile{height:64px;display:flex;align-items:center;justify-content:center;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;cursor:pointer;padding:0;transition:border-color 120ms,background 120ms}
.spin-tile:hover{border-color:var(--border-strong)}
.spin-tile:focus-visible{outline:2px solid var(--brand-dark);outline-offset:1px}
.spin-tile.on{border-color:var(--active-border);background:var(--active-bg)}
.spin-glyph{font-family:var(--vscode-editor-font-family,ui-monospace,'SF Mono',monospace);font-size:20px;color:var(--text)}
.spin-tile.none .spin-glyph{opacity:.4;font-size:11px}
.gh-btn{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--brand-dark);background:none;border:1px solid var(--border-strong);border-radius:6px;padding:8px 12px;cursor:pointer;width:100%;transition:background 100ms;margin-bottom:16px}
.gh-btn:hover{background:var(--surface)}
.detail-footer{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}
.detail-footer-l{display:flex;gap:8px}
.detail-footer-r{display:flex;gap:8px}
.btn-primary{font-size:12px;font-weight:600;color:var(--cta-text);background:var(--cta);border:none;border-radius:6px;padding:6px 14px;cursor:pointer;transition:opacity 100ms}
.btn-primary:hover{opacity:.88}

/* ── Ad callout (when ad is showing) ── */
.ad-callout{background:var(--active-bg);border:1px solid var(--active-border);border-radius:8px;padding:10px 12px;margin-bottom:14px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.ad-line{font-size:13px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad-unpaid{font-size:11px;color:var(--text-3);margin-top:4px;width:100%}
.btn-visit{font-size:11px;font-weight:600;color:var(--cta-text);background:var(--cta);border:none;border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:opacity 100ms}
.btn-visit:hover{opacity:.88}

/* ── Paused banner ── */
.paused-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;padding:12px 14px;margin-bottom:16px}
.paused-text{font-size:12px;color:var(--text-2);line-height:1.5}
.paused-text strong{color:var(--text);font-weight:600}
.paused-banner .btn-primary{flex-shrink:0}
/* The "no agent activity yet" hint: accent-tinted like the ad callout (informational and hopeful,
   not an error), shown until the first thinking event lands. */
.activate-note{background:var(--active-bg);border:1px solid var(--active-border);border-radius:10px;padding:12px 14px;margin-bottom:16px}
.activate-text{font-size:12px;color:var(--text-2);line-height:1.5}
.activate-text strong{color:var(--text);font-weight:600}
/* The "no agent found" block: the same accent-tinted, non-alarming treatment, plus an action - this
   one is a dead end the developer can actually walk out of, so it carries the way out. */
.agent-note{display:flex;align-items:center;gap:12px;background:var(--active-bg);border:1px solid var(--active-border);border-radius:10px;padding:12px 14px;margin-bottom:16px}
.agent-text{flex:1;font-size:12px;color:var(--text-2);line-height:1.5;text-wrap:pretty}
.agent-text strong{color:var(--text);font-weight:600}
.agent-note .btn-primary{flex-shrink:0;white-space:nowrap}

/* ── Tactile press: a subtle 0.96 scale on the panel's buttons. Every property is listed explicitly
   (never transition:all), and the scale is dropped under reduced-motion. ── */
.btn-primary,.btn-visit,.gh-btn,.back,.btn-ghost,.conflict-act{transition:transform 110ms cubic-bezier(.2,0,0,1),opacity 100ms,border-color 100ms,background 100ms,color 100ms}
.btn-primary:active,.btn-visit:active,.gh-btn:active,.back:active,.btn-ghost:active,.conflict-act:active{transform:scale(.96)}

/* ── Reduced motion: one rule, not a list of exceptions ──────────────────────────
   This replaced four per-selector opt-outs that between them covered a step number, the logo
   collapse, the glow and the press scale - while roughly seventeen other transitions (cards,
   toggles, chips, tiles, the highlight fade) kept animating for someone who had asked them not to.
   A blanket rule cannot fall behind the stylesheet the way an exception list does: a transition
   added tomorrow is covered the day it is written.

   animation:none rather than a collapsed duration, because the breathing glow theme ends at
   opacity .28 - running it once at ~0ms would freeze it dimmed, where none leaves it at its
   initial value. The press scale needs its own line: it is an :active STATE, not a transition, so
   removing the transition alone would still shrink the button, just instantly.

   (No backticks anywhere in this comment: the whole sheet is a TypeScript template literal, so one
   would end the string mid-stylesheet.) ── */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{transition:none!important;animation:none!important}
  .btn-primary:active,.btn-visit:active,.gh-btn:active,.back:active,.btn-ghost:active,.conflict-act:active{transform:none}
}
`;


// ── Client-side JavaScript ────────────────────────────────────────────────────
//
// Everything below is ONE template literal, so two rules apply to every line including comments:
// no backtick may appear (it closes the string, and tsc reports it as a stray TS1005 on whatever
// line follows, which reads nothing like the real cause), and ${...} would interpolate. Write
// 'quoted' or plain prose in comments here, never `code style`.

const JS = `
'use strict';
const vscode = acquireVsCodeApi();
const send = (type, extra) => vscode.postMessage({ type, ...extra });

// Surface metadata (descriptions + modifies info)
const TL_FILES = [
  { path: 'claude-code / webview/index.js', why: 'Shows the sponsored line in place of the thinking spinner.' },
  { path: 'claude-code / extension.js', why: 'Lets the line confirm it was actually shown, over localhost only - so earnings are never counted unless the ad was really visible.' },
];
// The agent's own extension id. A constant here, never built from state, so the two "Show Claude
// Code" steps cannot be steered anywhere else.
const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';
const META = {
  'status-bar':   { icon:'◉', label:'Status bar',       desc:'A single sponsored line at the right end of the status bar, only while your agent thinks.', mod:false },
  'chat-banner':  { icon:'▣', label:'Chat banner',      desc:'A sponsored banner above the chat input while the agent thinks. Disappears when the response starts.', mod:true, files: TL_FILES, ghPath:'src/patch' },
  'thinking-line':{ icon:'≡', label:'Thinking line',    desc:'Replaces the spinner verb while the agent thinks. Subtle and unobtrusive.', mod:true, files: TL_FILES, ghPath:'src/patch' },
};

let state = JSON.parse(document.getElementById('initial-state').textContent);
let spinCells = [];  // animating glyphs on a format's page (tiles + preview); rebuilt per render
let rcInfoOpen = false;  // "what does syncing across devices do" note, expanded via the header's (i) button
let manualOpen = false;  // the conflict box's "do it yourself" alternative path

// ── State application ──────────────────────────────────────────────────────
function render() {
  const root = document.getElementById('root');
  const signed = state.signedIn;

  root.innerHTML = '';
  spinCells = [];

  if (state._view === 'detail') {
    root.appendChild(buildDetailView(state._detailId));
    return;
  }

  if (state._view === 'privacy') {
    root.appendChild(buildPrivacyView());
    return;
  }

  const panel = el('div', 'panel');

  // Post-update "what's new" banner, one-time, above everything - it is about the extension version,
  // independent of sign-in state.
  if (state.justUpdated) panel.append(buildWhatsNew(state));

  // Header or sign-in
  if (signed) {
    const header = el('div', 'header');
    const displayName = (state.name && state.name.trim()) || state.email || '';

    // Row 1: avatar + name/email, and the account-wide "sync my settings across devices" switch — off
    // by default. Even on, every safety step (backup, atomic write, verify, fail-safe) still runs
    // exactly as it does when a surface is picked here; this only decides whether a format chosen on
    // another device (or the dashboard) applies here on its own, or asks for a click here first.
    const row1 = el('div', 'header-row');
    const av = el('div', 'avatar');
    av.textContent = (displayName || '?')[0].toUpperCase();
    const he = el('div', 'header-email'); he.textContent = displayName;
    const rc = el('div', 'header-rc');
    const rcLabel = el('span', 'hdr-toggle-label'); rcLabel.textContent = 'Sync across devices';
    const rcOn = !!state.remoteControlAllowed;
    const rcInfo = el('button', 'info-btn');
    rcInfo.setAttribute('aria-label', 'What does syncing across devices do?');
    rcInfo.setAttribute('aria-expanded', rcInfoOpen ? 'true' : 'false');
    rcInfo.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="8" cy="8" r="6.3" stroke-width="1.3"/><line x1="8" y1="5" x2="8" y2="5" stroke-width="1.7"/><line x1="8" y1="7.3" x2="8" y2="11" stroke-width="1.3"/></svg>';
    rcInfo.onclick = () => { rcInfoOpen = !rcInfoOpen; render(); };
    const rcToggle = el('button', 'toggle sm');
    if (rcOn) rcToggle.classList.add('on');
    rcToggle.setAttribute('role', 'switch');
    rcToggle.setAttribute('aria-checked', rcOn ? 'true' : 'false');
    rcToggle.setAttribute('aria-label', 'Sync my Awaitful settings across devices');
    // Echo the flip locally before telling the host, the same way the element switch does. Without
    // it the knob only moves when the host pushes state back, and that push REBUILDS this node - so
    // the new one mounts already in its final position and the 180ms slide never plays at all. The
    // echo is optimistic, not authoritative: if the write fails, the host's state corrects it.
    rcToggle.onclick = () => {
      const next = !rcToggle.classList.contains('on');
      rcToggle.classList.toggle('on', next);
      rcToggle.setAttribute('aria-checked', next ? 'true' : 'false');
      send('toggle-remote-control');
    };
    // Info before the toggle: the switch is the actionable control, so it sits rightmost.
    rc.append(rcLabel, rcInfo, rcToggle);
    row1.append(av, he, rc);

    // Row 2: the earnings figure (or fallback line), lined up under the name via a spacer the same
    // width as the avatar, and "Earning in status bar" + its toggle - a full-width row of its own
    // (not nested inside row 1's text column) so this toggle lands directly under the one above it.
    const row2 = el('div', 'header-row');
    const spacer = el('div', 'header-spacer');
    const hsText = el('span', 'header-sub-text');
    if (state.unredeemedUsd !== undefined || state.earningsToday !== undefined) {
      const parts = [];
      if (state.unredeemedUsd !== undefined) parts.push(fmtUsd(state.unredeemedUsd) + ' unredeemed');
      if (state.earningsToday !== undefined) parts.push(fmtUsd(state.earningsToday) + ' today');
      hsText.textContent = parts.join(' · ');
    } else {
      hsText.textContent = 'Earning while your AI agent thinks';
    }
    // Eye toggle: show/hide accrued earnings in the status bar (a device-local privacy preference —
    // e.g. hiding a dollar figure on a machine used for screen-sharing, unlike the account-wide
    // switch on row 1).
    const hsEye = el('span', 'header-sub-eye');
    const eyeLabel = el('span', 'hdr-toggle-label'); eyeLabel.textContent = 'Earning in status bar';
    const eye = el('button', 'eye-btn');
    // One function for both the first paint and the click echo, so the two cannot drift into
    // disagreeing about which icon means "shown".
    const paintEye = (on) => {
      eye.title = on ? 'Earnings shown in the status bar - click to hide' : 'Earnings hidden from the status bar - click to show';
      eye.setAttribute('aria-label', eye.title);
      eye.setAttribute('aria-pressed', on ? 'true' : 'false');
      eye.innerHTML = on
        ? '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2.1"/></svg>'
        : '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" opacity=".45"/><circle cx="8" cy="8" r="2.1" opacity=".45"/><line x1="2.5" y1="2.5" x2="13.5" y2="13.5"/></svg>';
    };
    let eyeOn = state.showEarningsInStatusBar;
    paintEye(eyeOn);
    // Same optimistic echo as the switch above: repaint now, let the host's push confirm or correct.
    eye.onclick = () => { eyeOn = !eyeOn; paintEye(eyeOn); send('toggle-statusbar-earnings'); };
    hsEye.append(eyeLabel, eye);
    row2.append(spacer, hsText, hsEye);

    header.append(row1, row2);
    panel.append(header);

    if (rcInfoOpen) {
      const rcNote = el('div', 'header-rc-note');
      rcNote.textContent = 'On: set your preferred customization from any device, including your Awaitful account. Off: keep these settings to this device only. Either way, any format Awaitful applies here is backed up, verified, and safe to undo.';
      panel.append(rcNote);
    }
    // Onboarding, at the top of the settings, until every step is done or it is dismissed with its ✕.
    if (stepperVisible(state)) panel.append(buildStepper(state));
  } else {
    // Signed out, the stepper IS the sign-in surface: step 1 active, steps 2-3 previewed, no ✕.
    panel.append(buildStepper(state));
  }

  // Paused banner — prominent, forget-proof resume.
  if (signed && state.disabled) {
    const pb = el('div', 'paused-banner');
    const pt = el('div', 'paused-text');
    // "left unmodified" is a claim about the files on disk, so it may only be made when the restore was
    // confirmed. If it was not, say what is actually true and point at the manual restore.
    pt.innerHTML = state.pauseRestoreFailed
      ? '<strong>Paused.</strong> Awaitful is earning nothing. We could not confirm Claude Code was returned to its original files - use "Restore original files" on the thinking-line page if it is still modified. Resume whenever you like.'
      : '<strong>Paused.</strong> Awaitful is earning nothing, and Claude Code is left unmodified. Resume whenever you like.';
    const rb = el('button', 'btn-primary'); rb.textContent = 'Resume'; rb.onclick = () => send('toggle-enabled');
    pb.append(pt, rb);
    panel.append(pb);
  }

  // No agent at all: nothing here can produce a thinking event, so nothing can earn - the silent $0
  // this panel used to hide entirely. Persistent by design: NOT behind the everThought latch, which
  // was the flaw (it latches on the first hook, so on the machine that needs this message it never
  // fires, and everywhere else it vanishes for good). Shown signed in or out, since the missing
  // dependency is worth knowing before signing up. Suppressed while paused, where the paused banner
  // is already the answer.
  if (!state.anyAgentCli && !state.disabled) {
    const nb = el('div', 'agent-note');
    const nt = el('div', 'agent-text');
    // "written nothing into Claude Code's settings" is a claim about the disk, so it may only be
    // made when the cleanup confirmed it - the same honesty gate as pauseRestoreFailed above.
    nt.innerHTML = state.agentCleanupFailed
      ? "<strong>No agent found.</strong> Awaitful earns while Claude Code thinks, and we cannot find Claude Code on this machine, so nothing is earning. We could not finish clearing an older Awaitful entry from ~/.claude/settings.json - open that file if you want it gone. Install Claude Code and run it once, then reopen this panel."
      : "<strong>No agent found.</strong> Awaitful earns while Claude Code thinks, and we cannot find Claude Code on this machine, so nothing is earning. Awaitful has written nothing into Claude Code's settings. Install Claude Code and run it once, then reopen this panel.";
    const sb = el('button', 'btn-primary');
    sb.textContent = 'Set up Claude Code';
    sb.onclick = () => send('open-setup-docs');
    nb.append(nt, sb);
    panel.append(nb);
  }

  // A CLI IS here but has never thought: a different problem with a different fix. Almost always the
  // developer is prompting through a different agent (Cursor's, Copilot) rather than Claude Code.
  // The "Claude Code is missing" half this note used to carry is now the persistent block above.
  if (signed && !state.disabled && state.anyAgentCli && !state.everThoughtSeen) {
    const nb = el('div', 'activate-note');
    const nt = el('div', 'activate-text');
    nt.innerHTML = "<strong>No agent activity yet.</strong> Claude Code is installed here, but we have not seen it think. Awaitful earns from Claude Code specifically, so make sure you're prompting through it, not your editor's built-in agent. Your line appears the moment it starts working.";
    nb.append(nt);
    panel.append(nb);
  }

  // Privacy reassurance — the trust anchor for the default choice.
  panel.append(buildPrivacyStrip());

  // Ad callout (when ad is showing in status bar)
  if (state.activeAdLine) {
    const ac = el('div', 'ad-callout');
    const al = el('div', 'ad-line'); al.textContent = state.activeAdLine;
    const vb = el('button', 'btn-visit'); vb.textContent = 'Visit sponsor';
    vb.onclick = () => send('visit-ad');
    if (!state.activeAdUrl) vb.style.display = 'none';
    ac.append(al, vb);
    if (state.activeAdUnpaid) {
      const un = el('div', 'ad-unpaid');
      un.textContent = 'House message - nothing is bidding right now. It bills nobody and pays nothing.';
      ac.append(un);
    }
    panel.append(ac);
  }

  // Illustration, already aimed at the format that is earning.
  panel.append(illusWrap(getDefaultHighlight()));

  // VS Code ad formats
  const sect1 = el('div', 'sect'); sect1.textContent = state.appName || 'Visual Studio Code';
  const sub1 = el('div', 'sect-sub'); sub1.textContent = 'One active format at a time · Open one to turn it on and style it';
  panel.append(sect1, sub1);

  const group = el('div');
  const ids = ['status-bar', 'thinking-line', 'chat-banner'];
  for (const id of ids) {
    const sv = (state.vsSurfaces || []).find(s => s.id === id) || { id, active:false, available:false, consentGranted:false, blockedReason:'no-agent-cli', modifiesFiles:false };
    // EVERY affected card says so. This used to show on the first conflicted card only, on the
    // grounds that the two webview formats share one patch and so share one fix - but the developer
    // reading the chat banner's card is not told to look at the thinking line's, so the second card
    // simply looked fine while being just as blocked. One shared cause is not one shared card.
    // (A blocked card still renders its own reason instead, which is more specific.)
    group.append(buildCard(sv, !!sv.conflict && !sv.blockedReason));
  }
  panel.append(group);

  // Terminal
  const div1 = el('div', 'div');
  const sect2 = el('div', 'sect'); sect2.textContent = 'Terminal';
  const sub2 = el('div', 'sect-sub'); sub2.textContent = 'Stacks on top of your editor format - run both · Works in any terminal';
  panel.append(div1, sect2, sub2);
  panel.append(buildTerminalCard());

  // Footer
  const div2 = el('div', 'div');
  const footer = el('div', 'footer');
  const btnDash = el('button', 'btn-ghost'); btnDash.textContent = 'View earnings'; btnDash.onclick = () => send('open-dashboard');
  const btnToggle = el('button', 'btn-ghost'); btnToggle.textContent = state.disabled ? 'Resume earning' : 'Pause earning'; btnToggle.onclick = () => send('toggle-enabled');
  const btnOut = el('button', 'btn-ghost'); btnOut.textContent = 'Sign out'; btnOut.onclick = () => send('sign-out');
  if (!signed) { btnDash.disabled = true; btnToggle.disabled = true; btnOut.textContent = 'Sign in'; btnOut.onclick = () => send('sign-in'); }
  footer.append(btnDash, btnToggle, btnOut);
  panel.append(div2, footer);

  // Fine print — version + source link.
  const meta = el('div', 'meta-line');
  const ver = el('span'); ver.textContent = 'Awaitful v' + (state.version || '');
  const dot = el('span'); dot.textContent = ' · ';
  const src = el('button', 'meta-link'); src.textContent = 'source'; src.onclick = () => send('open-github');
  meta.append(ver, dot, src);
  panel.append(meta);

  root.append(panel);
}

// Whether the onboarding stepper shows. Signed out it always does (it IS the sign-in surface); signed
// in it shows until every step is done or it was dismissed with its ✕ (persisted device-local).
function stepperVisible(state) {
  if (!state.signedIn) return true;
  if (state.onboardingDismissed) return false;
  var premiumActive = (state.vsSurfaces || []).some(function (s) { return s.active && s.id !== 'status-bar'; });
  var formatDone = premiumActive || !!state.terminalEnabled || state.remoteSurfacePref != null;
  return !(formatDone && !!state.remoteControlAllowed);
}

// The 3-step onboarding guide. Every step's done/current/blocked state is DERIVED from panel state
// (signed in, a format active, sync on) - there are no stored step flags to orphan. Only the ✕ is
// persisted. The step buttons reuse the exact messages the rest of the panel already sends, so the
// existing consent + patch-war + reload flow runs unchanged: no activation path is reinvented here.
function buildStepper(state) {
  var box = el('div', 'stepper');

  // ✕ dismiss — only once signed in; the signed-out stepper is the sign-in surface, nothing to skip to.
  if (state.signedIn) {
    var x = el('button', 'stepper-x');
    x.setAttribute('aria-label', 'Dismiss setup');
    x.title = 'Dismiss setup';
    x.textContent = '×';
    x.onclick = function () { send('dismiss-onboarding'); };
    box.append(x);
  }

  var title = el('div', 'stepper-title'); title.textContent = 'Set up Awaitful';
  var sub = el('div', 'stepper-sub'); sub.textContent = 'Three steps to start earning.';
  box.append(title, sub);

  // ── Derived step state ──
  // A deliberate dashboard format choice (even status-bar) settles the format step - never nag a user to
  // turn on a format they chose to move away from on the web (see PanelState.remoteSurfacePref).
  var premiumActive = (state.vsSurfaces || []).some(function (s) { return s.active && s.id !== 'status-bar'; });
  var formatDone = premiumActive || !!state.terminalEnabled || state.remoteSurfacePref != null;
  var best = state.bestUpgrade;                 // 'chat-banner' | 'thinking-line' | 'terminal' | undefined
  var fmtName = best === 'thinking-line' ? 'thinking line' : best === 'terminal' ? 'terminal' : 'chat banner';
  var fmtTitle = fmtName.charAt(0).toUpperCase() + fmtName.slice(1);
  var rate;
  if (best === 'terminal') rate = state.terminalEarnRate;
  else { var sc = (state.vsSurfaces || []).find(function (s) { return s.id === best; }); rate = sc && sc.earnRate; }
  // A real webview that is present but held by a competitor right now: onboarding routes through its own
  // guided conflict flow, not the terminal (see pickBestUpgrade), so step 2 opens that card to fix it.
  var contested = (state.vsSurfaces || [])
    .filter(function (s) { return (s.id === 'chat-banner' || s.id === 'thinking-line') && s.available && s.conflict && !s.active; })
    .sort(function (a, b) { return (b.earnRate || 0) - (a.earnRate || 0); })[0];

  // Step 2: done -> a check; a real upgrade -> offer it; a contested webview -> resolve the conflict;
  // otherwise (no Claude Code / no editor here) -> the blocked note. Never divert a contested webview to
  // the terminal - the status bar stays the fallback and the conflict is the thing to fix.
  var step2;
  if (formatDone) {
    step2 = { title: 'Ad format is on', sub: 'Your sponsored line is in a higher-earning spot.' };
  } else if (best) {
    var s2sub = best === 'terminal' ? 'Stacks on your status bar to earn a little more.'
      : (rate ? 'Earns about ' + rate + 'x the status bar.' : 'Show your sponsored line where it earns the most.');
    step2 = {
      title: fmtTitle, sub: s2sub, btn: 'Turn on ' + fmtName,
      go: function () { if (best === 'terminal') send('toggle-terminal'); else send('consent-grant', { id: best }); },
    };
  } else if (contested) {
    step2 = {
      title: 'Turn on the chat banner',
      sub: 'Another extension is using Claude Code right now. Open it to put the original back, then turn this on.',
      btn: 'Resolve the conflict',
      go: function () { openDetail(contested.id); },
    };
  } else {
    step2 = {
      title: 'Turn on the chat banner',
      sub: 'Show your sponsored line where it earns the most.',
      blocked: true,
      blockedNote: 'Install Claude Code and an editor here to turn this on.',
    };
  }

  var steps = [
    {
      title: 'Sign in',
      sub: 'Link this editor to your Awaitful account.',
      done: !!state.signedIn,
      btn: 'Sign in',
      go: function () { send('sign-in'); },
    },
    {
      title: step2.title,
      sub: step2.sub,
      done: formatDone,
      blocked: !!step2.blocked,
      blockedNote: step2.blockedNote,
      btn: step2.btn,
      go: step2.go,
    },
    {
      title: 'Sync across your devices',
      sub: 'Apply the format you choose here to every device on your Awaitful account, automatically.',
      done: !!state.remoteControlAllowed,
      btn: 'Turn on sync',
      go: function () { send('toggle-remote-control'); },
    },
  ];

  // The one actionable step: the first that is neither done nor blocked. Only it shows a button, so the
  // stepper reads straight down - finish this one, the next lights up.
  var currentIdx = -1;
  for (var i = 0; i < steps.length; i++) { if (!steps[i].done && !steps[i].blocked) { currentIdx = i; break; } }

  for (var j = 0; j < steps.length; j++) {
    var st = steps[j];
    var cls = st.done ? 'done' : st.blocked ? 'blocked' : (j === currentIdx ? 'current' : 'todo');
    var row = el('div', 'step ' + cls);

    var rail = el('div', 'step-rail');
    var num = el('div', 'step-num'); num.textContent = st.done ? '✓' : String(j + 1);
    rail.append(num);

    var main = el('div', 'step-main');
    var stt = el('div', 'step-title'); stt.textContent = st.title;
    var sts = el('div', 'step-sub'); sts.textContent = st.sub;
    main.append(stt, sts);

    if (j === currentIdx && st.btn) {
      var act = el('div', 'step-act');
      var b = el('button', 'btn-primary'); b.textContent = st.btn; b.onclick = st.go;
      act.append(b);
      main.append(act);
    } else if (st.blocked && st.blockedNote) {
      var bn = el('div', 'step-blocked-note'); bn.textContent = st.blockedNote;
      main.append(bn);
    }

    row.append(rail, main);
    box.append(row);
  }

  return box;
}

// The post-update banner. Shown once when the version changed since this machine last saw the panel;
// both actions mark it seen so it does not return. A gentle cue, not a modal - it links to the notes
// rather than interrupting.
function buildWhatsNew(state) {
  var bar = el('div', 'whatsnew');
  var spark = el('span', 'whatsnew-spark'); spark.textContent = '✦';
  var txt = el('span', 'whatsnew-text'); txt.textContent = 'Updated to v' + (state.version || '');
  var see = el('button', 'whatsnew-cta'); see.textContent = "See what's new";
  see.onclick = function () { send('whats-new'); };
  var x = el('button', 'whatsnew-x'); x.setAttribute('aria-label', 'Dismiss'); x.title = 'Dismiss'; x.textContent = '×';
  x.onclick = function () { send('dismiss-whats-new'); };
  bar.append(spark, txt, see, x);
  return bar;
}

function buildPrivacyStrip() {
  const p = el('div', 'privacy');
  p.setAttribute('role', 'button');
  p.setAttribute('tabindex', '0');
  p.title = 'See exactly what leaves your machine';
  const mark = el('div', 'privacy-mark');
  mark.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0l6 2.5v4.2c0 3.9-2.6 7.4-6 8.8-3.4-1.4-6-4.9-6-8.8V2.5L8 0z" opacity=".25"/><path d="M6.9 10.2L4.7 8l.9-.9 1.3 1.3 3.5-3.5.9.9-4.4 4.4z"/></svg>';

  const col = el('div', 'privacy-col');
  const title = el('div', 'privacy-title');
  title.textContent = 'Private by design';

  /**
   * "The default Status bar format modifies nothing" used to end this paragraph, and it quietly did
   * the opposite of its job: naming one format as the safe one invites the reader to assume the
   * others are a privacy trade. They are not - the promise is identical across all four. Whether a
   * format edits a file is a different question from what Awaitful can SEE, and it is answered in
   * full on each format's own page, so the guarantee is stated once here, for everything.
   */
  const t = el('div', 'privacy-text');
  t.textContent = 'Awaitful never reads your code, your prompts, or what your agent writes. '
    + 'It sees only that an agent is thinking, and for how long. That is the same on every format.';

  const doIt = el('div', 'privacy-do');
  doIt.textContent = 'Pick where your sponsored line appears below. Change it or switch it off '
    + 'whenever you like, and anything a format touched is put back.';

  const more = el('div', 'privacy-text');
  more.innerHTML = '<span class="privacy-more">What leaves your machine →</span>';

  col.append(title, t, doIt, more);
  p.append(mark, col);
  const open = () => { state._view = 'privacy'; render(); };
  p.onclick = open;
  p.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  return p;
}

// A full, honest disclosure of the only things the client ever sends. Mirrors PRIVACY.md;
// every row here is enforced by the egress-whitelist test in @awaitful/shared.
function buildPrivacyView() {
  const panel = el('div', 'panel');
  const back = backButton();
  panel.append(back);

  const title = el('div', 'detail-title'); title.textContent = 'What leaves your machine';
  const desc = el('div', 'detail-desc');
  desc.innerHTML = 'Awaitful needs to know only <strong>that</strong> your agent is thinking and <strong>for how long</strong> - never <strong>what</strong> you or the agent are doing. Below is the complete list of what the client sends. There is no field anywhere for your code, prompts, files, or the agent’s output.';
  panel.append(title, desc);

  const sends = [
    ['Which ad format to show', 'The format name (status bar, chat banner, …) and optional coarse hints like hour-of-day - off unless you enable them.'],
    ['Ad events', 'A random event id, the event type, which ad/slate it was, the placement, a timestamp, and how many milliseconds the line was actually visible. That’s the most specific thing Awaitful learns.'],
    ['Patch-health report (patch mode only)', 'SHA-256 hashes of Claude Code’s OWN shipped files plus the applied/failed outcome - used to recognise a known-good build. Never your content; a wrong hash only makes us refuse to patch.'],
    ['Account reads', 'Read-only: your email and earnings, so the panel can show whose account is earning. A device token can never move money or change campaigns.'],
    ['Device token', 'One opaque, revocable token identifying this device - not you inside a session. Revoke it any time from the dashboard.'],
  ];
  const box = el('div', 'info-box');
  for (const [h, b] of sends) {
    const row = el('div', 'send-row');
    const rh = el('div', 'send-h'); rh.textContent = h;
    const rb = el('div', 'send-b'); rb.textContent = b;
    row.append(rh, rb);
    box.append(row);
  }
  panel.append(box);

  const never = el('div', 'never-box');
  never.innerHTML = '<div class="never-h">Never sent</div>' +
    '<ul class="never-list">' +
    '<li>Your source files, open buffers, terminal, or clipboard</li>' +
    '<li>Your prompts or the agent’s responses</li>' +
    '<li>File names, paths, project or repository names</li>' +
    '<li>Any cross-site tracking or third-party analytics</li>' +
    '</ul>';
  panel.append(never);

  const note = el('div', 'detail-desc');
  note.style.marginTop = '14px';
  note.innerHTML = 'This isn’t just a promise: all network calls go through one file, and the exact payload shapes are pinned by a test - a field that could carry content can’t be added without failing the build. The extension is open source; verify it yourself.';
  panel.append(note);

  const footer = el('div', 'detail-footer');
  const right = el('div', 'detail-footer-r');
  const privBtn = el('button', 'btn-ghost'); privBtn.textContent = 'Read PRIVACY.md'; privBtn.onclick = () => send('open-privacy');
  const srcBtn = el('button', 'btn-ghost'); srcBtn.textContent = 'View source'; srcBtn.onclick = () => send('open-github');
  right.append(privBtn, srcBtn);
  footer.append(right);
  panel.append(footer);

  return panel;
}

// Earning chip — value comes from the server's live rate card, never hardcoded here. Hidden until the
// rate card has been fetched. The label says "earnings" so a new user reads it as money, not speed: the
// status bar is "1× base earnings", others are "N× earnings", and the additive terminal is "+N× earnings".
// Always anchored to the base (status-bar) rate, so the number never shifts when the user switches.
//
// The base chip carries its 1× rather than reading "Base earnings" on its own. Every other chip leads
// with a multiplier, so a wordy one broke the column a reader scans down and left them working out
// what the baseline was worth against a 2× beside it. Saying 1× makes the comparison immediate.
function rateChip(rate, additive) {
  if (rate === undefined || rate === null) return null;
  const base = rate === 1 && !additive;
  const chip = el('span', base ? 'rate base' : 'rate');
  chip.textContent = additive
    ? '+' + rate + '× earnings'
    : base
      ? '1× base earnings'
      : rate + '× earnings';
  chip.title = additive
    ? 'Runs alongside your editor format and earns about ' + rate + '× the base rate on top of it.'
    : base
      ? 'The baseline earnings - every other placement earns a multiple of this.'
      : 'Earns about ' + rate + '× what the status bar earns. Set by the live rate card, and can change over time.';
  return chip;
}

// Small padlock shown in a surface's action slot when signed out - the surface is
// visible but deactivated until sign-in; clicking the card prompts sign-in.
function lockGlyph() {
  const lock = el('span', 'lock');
  lock.setAttribute('aria-label', 'Locked - sign in to activate');
  lock.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a3 3 0 0 0-3 3v2h-.5A1.5 1.5 0 0 0 3 7.5v6A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 11.5 6H11V4a3 3 0 0 0-3-3Zm1.5 5h-3V4a1.5 1.5 0 0 1 3 0v2Z"/></svg>';
  return lock;
}

/**
 * The one-line amber warning a card shows when something has stopped this format, and the way in.
 *
 * Deliberately NOT a button. The whole card opens the page, so a nested control would be a second
 * target for one action - and the developer would have to aim at four small words instead of the
 * box their eye already landed on.
 */
function cardWarning(line) {
  const w = el('div', 'card-conflict');
  w.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.6 15 14H1L8 1.6z"/><path d="M8 6.4v3.1M8 11.6h.01"/></svg>';
  w.appendChild(text(line + ' '));
  const more = el('span', 'more'); more.textContent = 'Fix it \u2192';
  w.appendChild(more);
  return w;
}

function buildCard(sv, showConflict) {
  const m = META[sv.id] || {};
  // Blocked outranks locked: "sign in to activate" is the wrong next step for a surface that cannot
  // run on this machine at all.
  const blocked = !!sv.blockedReason;
  const locked = !state.signedIn && !blocked;
  const active = sv.active && !locked;
  const conflict = !!showConflict && !locked && !blocked;
  const card = el('div', 'card');
  if (active) card.classList.add('active');
  if (blocked) card.classList.add('blocked');
  if (locked) { card.classList.add('locked'); card.title = 'Sign in to activate'; }

  // Every card opens its own page - the one place a format is turned on, turned off, and styled.
  // The status bar used to activate on click while the other two opened a page, so the same gesture
  // meant two different things and the status bar had nowhere to put its own settings.
  cardOpens(card, sv.id, { blocked, locked, active, label: m.label || sv.id, rate: sv.earnRate });

  // Highlight illustration on hover
  card.addEventListener('mouseenter', () => updateHighlight(sv.id));
  card.addEventListener('mouseleave', () => updateHighlight(getDefaultHighlight()));

  const icon = el('div', 'card-icon'); icon.textContent = m.icon || '□';
  const body = el('div', 'card-body');
  const nameRow = el('div', 'card-name-row');
  const name = el('div', 'card-name'); name.textContent = m.label || sv.id;
  nameRow.append(name);
  const chip = rateChip(sv.earnRate);
  if (chip) nameRow.append(chip);
  const desc = el('div', 'card-desc'); desc.textContent = m.desc || '';
  body.append(nameRow, desc);

  const meta = el('div', 'card-meta');
  if (m.mod) {
    const tag = el('span', 'tag-mod');
    tag.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" opacity=".6"/><path d="M14 1H2a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V2a1 1 0 00-1-1z" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".4"/></svg> Modifies Claude Code';
    meta.append(tag);
  } else {
    meta.append(safeTag('Does not modify Claude Code'));
  }
  body.append(meta);

  // Conflict hint: a competitor changed Claude Code, so this format needs a clean copy first.
  // Surfaced on the card so the block is visible without opening the page; the fix lives there, and
  // the card itself is the way in - so this is plain text now, not a second button to the same place.
  if (conflict) {
    body.append(cardWarning('Changed by ' + (sv.conflictVendor || 'another extension') + ', needs a clean copy.'));
  }

  // Render honesty for the CHOSEN surface: our bytes being on disk is not proof anything appeared.
  // Never claim a line is showing without a beacon that says it was painted.
  if (!blocked && active && sv.live && sv.live !== 'live') {
    const ln = el('div', 'card-blocked');
    if (sv.live === 'reload-needed') {
      ln.appendChild(text("Claude Code's panel is running an older version of Awaitful's change. Reload the window. "));
      const a = el('button', 'more-link'); a.textContent = 'Reload window →';
      a.onclick = (e) => { e.stopPropagation(); reloadHere(); };
      ln.appendChild(a);
    } else if (sv.live === 'not-rendering') {
      ln.appendChild(text("Applied, but nothing appeared in Claude Code's panel in the last 3 thinking turns, so earning moved to your status bar. Reloading the window usually fixes it. "));
      const a = el('button', 'more-link'); a.textContent = 'Reload window →';
      a.onclick = (e) => { e.stopPropagation(); reloadHere(); };
      ln.appendChild(a);
    } else if (sv.live === 'silent') {
      // Three causes, none of which we can tell apart from here. Name them; assert none.
      ln.appendChild(text("Applied, but Claude Code's panel has not reported back in the last 3 thinking turns, so earning moved to your status bar. That happens when the panel is closed, off screen, or being driven from another window."));
    } else {
      ln.appendChild(text("Applied. It confirms itself the next time Claude Code's panel is open and thinking."));
    }
    body.append(ln);
  }

  // The real reason, in the body where there is room for a sentence. The badge in the action slot
  // only has room for a word.
  if (blocked) {
    // Every stopped format speaks with one voice: the amber callout, one line, and the way in. It is
    // the same problem at two zoom levels as the box on the page behind it, so it should not look
    // like a different class of thing depending on which reason stopped it.
    const fixable = {
      'no-agent-cli': 'Claude Code is not installed on this machine.',
      'no-agent-editor': 'Claude Code is not installed in this window.',
      'changed-unknown': "Claude Code's file was changed by something, and nothing says what.",
    }[sv.blockedReason];

    if (sv.blockedReason === 'foreign-conflict') {
      // Named only when that extension is really installed. Otherwise describe what is on disk and
      // quote the marker - specific without asserting a vendor we cannot find.
      body.append(cardWarning(sv.conflictVendor
        ? 'Changed by ' + sv.conflictVendor + ', needs a clean copy.'
        : sv.conflictToken
          ? 'Changed by another tool (marked ' + sv.conflictToken + '), needs a clean copy.'
          : 'Changed by another tool, needs a clean copy.'));
    } else if (fixable) {
      body.append(cardWarning(fixable));
    } else {
      // No fix to point at, so no way in either - a link to a page with nothing on it is worse than
      // a sentence that says so plainly.
      const nb = el('div', 'card-blocked');
      nb.appendChild(text(sv.blockedReason === 'ours-unverified'
        ? "Awaitful's change is in place, but it has no verified copy of this Claude Code version's original files, so it cannot check the change or undo it automatically. Reinstalling Claude Code restores a clean copy."
        : sv.blockedReason === 'unreadable'
          ? "Awaitful could not read one of Claude Code's files, so it changed nothing. That usually means Claude Code is mid-update, or the extensions folder is not readable. Reload the window and try again."
          : 'Not supported on this Claude Code version yet. It turns on by itself when support lands, and your status bar keeps earning meanwhile.'));
      body.append(nb);
    }
  }

  const action = el('div', 'card-action');
  if (blocked) {
    const b = el('span', 'badge-blocked');
    // "Paused" means we could run here and chose not to yet. "Unavailable" means this machine
    // cannot run it at all. Never the same word for both.
    b.textContent = (sv.blockedReason === 'unsupported-build' || sv.blockedReason === 'foreign-conflict'
      || sv.blockedReason === 'changed-unknown' || sv.blockedReason === 'ours-unverified')
      ? 'Paused' : 'Unavailable';
    action.append(b);
  } else if (locked) {
    action.append(lockGlyph());
  } else {
    // A "not confirmed" note sits BESIDE the active dot, never instead of it: whether a format is on
    // is the user's choice, while liveness is a separate fact about what is on screen. Merging the
    // two would make a chosen format look unchosen.
    if (active && sv.live && sv.live !== 'live' && sv.live !== 'unknown') {
      const b = el('span', 'badge-blocked');
      b.textContent = sv.live === 'reload-needed' ? 'Reload'
        : sv.live === 'not-rendering' ? 'Not showing'
        : 'Not confirmed';
      action.append(b);
    }
    if (active && sv.provisional) card.title = 'Running on a new Claude Code version - confirming it automatically. You are earning normally.';
    action.append(pickGlyph(active), goChevron());
  }

  card.append(icon, body, action);
  return card;
}

/** Pick-one ring, filled when this is the chosen VS Code format. Decorative: the card's own
 *  aria-label already says "active", so a screen reader hears it once rather than twice. */
function pickGlyph(on) {
  const d = el('span', 'pick');
  if (on) d.classList.add('on');
  d.setAttribute('aria-hidden', 'true');
  return d;
}

/** Chevron: this card leads somewhere. Shown wherever the dot is not, so the slot is never empty. */
function goChevron() {
  const g = el('span', 'card-go');
  g.setAttribute('aria-hidden', 'true');
  g.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.25 10.75 8 6 12.75"/></svg>';
  return g;
}

/**
 * Make a card open its format's page. One definition for all four, so the gesture cannot mean
 * something different on one of them - which is exactly what it used to do.
 *
 * Signed out, the click asks for sign-in instead: the page behind it is about turning a format on,
 * and that is not the next step yet. Blocked, nothing is clickable at all - "sign in to activate" and
 * "open the page" are both the wrong next step for a format that cannot run on this machine.
 */
function cardOpens(card, id, o) {
  // A stopped card opens its page too. It used to be inert, on the reasoning that "open the page" is
  // not the next step for a format that cannot run - but that page now carries the whole fix, so it
  // is exactly the next step. Nothing here activates anything: the page's own button does that, and
  // it withholds itself while the format is blocked.
  const act = o.locked ? () => send('sign-in') : () => openDetail(id);
  // An explicit name, or the button announces as every descendant's text concatenated - the
  // description and the inner links swept in with it.
  const ratePhrase = o.rate === 1 ? 'base earning rate' : o.rate ? 'about ' + o.rate + ' times the base rate' : '';
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', o.label + (o.active ? ', active' : '') + (ratePhrase ? ', ' + ratePhrase : ''));
  if (o.active) card.setAttribute('aria-current', 'true');
  card.tabIndex = 0;
  card.onclick = act;
  card.onkeydown = (e) => {
    // Only the card's OWN keys act. Enter/Space bubbling up from an inner link must not be hijacked.
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); }
  };
}

function buildTerminalCard() {
  const sv = { id: 'terminal', active: false, blockedReason: state.terminalBlockedReason };
  const blocked = !!sv.blockedReason;
  const locked = !state.signedIn && !blocked;
  const m = { icon: '>_', label: 'Terminal status line', desc: 'A sponsored line in Claude Code’s status line while it’s thinking. Runs alongside whichever format you picked in the editor.', mod: true, file: '~/.claude/settings.json', ghPath: 'src/hooks/statusLineScript.ts' };

  const card = el('div', 'card');
  const active = !!state.terminalEnabled && !locked && !blocked;
  if (active) card.classList.add('active');
  if (blocked) card.classList.add('blocked');
  if (locked) { card.classList.add('locked'); card.title = 'Sign in to activate'; }
  cardOpens(card, 'terminal', { blocked, locked, active, label: m.label, rate: state.terminalEarnRate });
  card.addEventListener('mouseenter', () => updateHighlight('terminal'));
  card.addEventListener('mouseleave', () => updateHighlight(getDefaultHighlight()));

  const icon = el('div', 'card-icon'); icon.textContent = '>_'; icon.style.fontFamily = 'monospace';
  const body = el('div', 'card-body');
  const nameRow = el('div', 'card-name-row');
  const name = el('div', 'card-name'); name.textContent = m.label;
  nameRow.append(name);
  // Additive: the '+' prefix + the independent switch (vs the radios above) say it stacks, not replaces.
  const chip = rateChip(state.terminalEarnRate, true);
  if (chip) nameRow.append(chip);
  const desc = el('div', 'card-desc'); desc.textContent = m.desc;
  const meta = el('div', 'card-meta');
  const tag = el('span', 'tag-mod'); tag.textContent = '⚙ Modifies settings.json';
  meta.append(tag);
  body.append(nameRow, desc, meta);

  // Needs only the CLI, never the VS Code extension - worth saying, because it is the one surface a
  // terminal-first developer can run when the two webview spots cannot.
  if (blocked) {
    const nb = el('div', 'card-blocked');
    nb.appendChild(text('The status line lives inside Claude Code, which is not installed here. It works in any terminal once Claude Code is - you do not need the Claude Code extension for this one. '));
    const a = el('button', 'more-link'); a.textContent = 'Set up Claude Code →';
    a.onclick = (e) => { e.stopPropagation(); send('open-setup-docs'); };
    nb.appendChild(a);
    body.append(nb);
  }

  const action = el('div', 'card-action');
  if (blocked) {
    // No control at all, not a disabled one: a switch here is exactly what let a developer flip a
    // format that could never render and be told it worked.
    const b = el('span', 'badge-blocked'); b.textContent = 'Unavailable';
    action.append(b);
  } else if (locked) {
    action.append(lockGlyph());
  } else {
    // A SWITCH, never the pick-one ring the three VS Code formats wear. The terminal is not a fourth
    // contender for a slot only one thing can hold: it runs alongside whichever one you picked, in
    // every terminal you open. A ring here would say the opposite.
    const toggle = el('button', 'toggle');
    if (active) toggle.classList.add('on');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', active ? 'true' : 'false');
    toggle.setAttribute('aria-label', m.label);
    // Off is immediate; on opens the page first, because turning it on writes to settings.json and
    // that change is reviewed before it happens - the same rule the file-modifying formats follow.
    toggle.onclick = (e) => {
      e.stopPropagation();
      if (state.terminalEnabled) send('toggle-terminal');
      else openDetail('terminal');
    };
    action.append(toggle, goChevron());
  }

  card.append(icon, body, action);
  return card;
}

// The illustration, shared by the format list and every detail page. Genuinely injected once now:
// the artwork used to be interpolated at two call sites, so every panel carried ~10 KB of it twice.
// The caller names the region to light, and it is set before the node is in the document.
function illusWrap(active) {
  const iw = el('div', 'illus-wrap');
  iw.setAttribute('data-active', active);
  iw.innerHTML = ${JSON.stringify(WIREFRAME_SVG)};
  return iw;
}

// The "does not touch your files" checkmark tag, shared by the card and the status-bar page.
function safeTag(label) {
  const tag = el('span', 'tag-safe');
  tag.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> ';
  tag.appendChild(document.createTextNode(label));
  return tag;
}

// The Back control shared by every detail and sub-page - one definition so the chevron, label, target,
// and styling can never drift between pages. Returns to the settings (placements) view.
function backButton() {
  const b = el('button', 'back');
  b.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.25 5.25 8 10 12.75"/></svg>';
  b.appendChild(text('Back'));
  b.setAttribute('aria-label', 'Back to settings');
  b.onclick = () => { state._view = 'surfaces'; render(); };
  return b;
}

/** Heading on the left, the page's one primary action on the right - aligned with the illustration
 *  above it, so the decision sits where the eye already is rather than past every explanation. */
function detailHead(titleRow, action) {
  if (!action) return titleRow;
  const row = el('div', 'detail-head');
  row.append(titleRow, action);
  return row;
}

/**
 * The one thing a format's page is for: turning it on. At the TOP, beside the heading and aligned
 * with the illustration's right edge - it used to sit past the styling controls, the file
 * disclosure and the backup notes, which is a long way to scroll for the only decision on the page.
 *
 * Returns null where turning it on is not the next step: a blocked format (its guidance box owns
 * the conversation), a contested file (the take-over shortcut owns it), or the terminal once it is
 * already running, whose only remaining action is destructive and belongs in the footer.
 */
/**
 * Does the repair box own this page, instead of the activate button?
 *
 * The latch alone is not enough, and trusting it was the bug. It means "Claude Code was taken off as
 * part of a fix", which stays true after the fix has WORKED - so a finished repair kept the box up,
 * drawing steps for a conflict that no longer existed ("remove the other extension" with nothing
 * left to remove), and kept the activate button hidden behind them. The developer had done
 * everything asked and had no way to turn the format on.
 *
 * Ownership is a fact about the world, never a memory: a contested file, or a repair whose Claude
 * Code has not come back yet. Once it is back and the bytes are clean there is nothing to guide, and
 * whether the surface is actually painting is the liveness note's job - which is measured rather
 * than remembered.
 */
function repairBoxNeeded(sv) {
  return !!sv.conflict || (!!sv.repairing && sv.agentFilesPresent === false);
}

function detailPrimary(id, sv, m) {
  if (sv.blockedReason) return null;
  const label = m.label || id;
  const b = el('button', 'btn-primary');

  if (sv.active) {
    b.textContent = 'Showing now';
    b.disabled = true;
    return b;
  }
  if (id === 'terminal') {
    b.textContent = 'Turn on';
    b.onclick = () => { send('toggle-terminal'); state._view = 'surfaces'; render(); };
    return b;
  }
  if (id === 'status-bar') {
    b.textContent = 'Turn on';
    b.onclick = () => { send('set-surface', { id: 'status-bar' }); state._view = 'surfaces'; render(); };
    return b;
  }
  if (repairBoxNeeded(sv)) return null;   // the repair box carries the way forward instead
  b.textContent = 'Turn on';
  b.title = 'Turn on ' + label;
  b.onclick = () => { send('consent-grant', { id }); state._view = 'surfaces'; render(); };
  return b;
}

// Status bar modifies nothing, so its detail page is deliberately simpler than the patch surfaces':
// the shared illustration (highlighting the status bar), what it is, a one-tap activate, and a plain
// "No file changes" reassurance. No consent gate, no file disclosure, no restore/reload.
//
// Simpler, but not silent when it is stopped. Its card says "Fix it →" like the other three, and
// this page used to open on a description and a missing button - the promise made on the card with
// nothing behind it. The one thing that can stop the status bar is a machine with no Claude Code on
// it, which is exactly the case the shared guidance box already names and gives the steps for.
function buildStatusBarDetail() {
  const m = META['status-bar'];
  const sv = (state.vsSurfaces || []).find(s => s.id === 'status-bar') || {};
  const panel = el('div', 'panel');

  const back = backButton();
  panel.append(back);

  panel.append(illusWrap('status-bar'));

  const titleRow = el('div', 'card-name-row');
  const title = el('div', 'detail-title'); title.textContent = m.label;
  titleRow.append(title);
  const chip = rateChip(sv.earnRate);
  if (chip) titleRow.append(chip);
  const desc = el('div', 'detail-desc'); desc.textContent = m.desc;
  panel.append(detailHead(titleRow, detailPrimary('status-bar', sv, m)), desc);

  // Above the styling controls, same as on the other three pages: the reason it cannot run comes
  // before how it would look. The same box too - a parallel one here would be a second place for the
  // no-Claude-Code copy to drift.
  const blocked = buildBlockedBox('status-bar', sv, m);
  if (blocked) panel.append(blocked);

  const cz = buildCustomize('status-bar');
  if (cz) panel.append(cz);

  const footer = el('div', 'detail-footer');
  const left = el('div', 'detail-footer-l');
  left.append(safeTag('No file changes'));
  footer.append(left, el('div', 'detail-footer-r'));
  panel.append(footer);
  return panel;
}

/**
 * One numbered step in a fix, with its own button. Shared by every guidance box, so a second one
 * cannot quietly grow a different rail, a different tick, or a step that does nothing when clicked.
 */
/**
 * Reload, and come back to this page.
 *
 * A reload is a real step in several flows here, and the window used to come back with the panel
 * closed - so the developer had to find their way back to the format they were half way through
 * setting up, with no sign that anything had progressed. Every reload button goes through this, so
 * a new one cannot forget.
 */
function reloadHere() {
  send('reload-window', { view: state._view || 'surfaces', detailId: state._detailId });
}

function stepRow(actions, text, opts) {
  const o = opts || {};
  const row = el('div', 'conflict-step');
  if (o.done) row.classList.add('done');
  const num = el('span', 'num');
  // A tick, not a number, once it is done - what is left to do is the useful count.
  if (o.done) num.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
  else num.textContent = String(o.n);
  const lbl = el('span', 'lbl'); lbl.textContent = text;
  row.append(num, lbl);
  if (o.btn && !o.done) {
    const b = el('button', 'conflict-act');
    b.textContent = o.btn;
    b.onclick = o.onClick;
    row.append(b);
  }
  actions.append(row);
  return row;
}

/**
 * The do-it-yourself route, folded away until asked for.
 *
 * Every button in here only OPENS a page - same destinations as the numbered steps, none of the
 * actions. That is the whole difference between the two paths, and the reason someone would pick
 * this one: it is a fair thing to want an ad extension not to press buttons for you.
 */
function manualSection(rows) {
  const wrap = el('div', 'conflict-manual');
  const toggle = el('button', 'more-link');
  toggle.textContent = manualOpen ? 'Hide \u25b4' : 'Or do it yourself \u25be';
  toggle.setAttribute('aria-expanded', manualOpen ? 'true' : 'false');
  toggle.onclick = () => { manualOpen = !manualOpen; render(); };
  wrap.append(toggle);
  if (!manualOpen) return wrap;

  const box = el('div', 'manual-box');
  const note = el('div', 'file-why');
  note.textContent = 'These only open the page. Nothing is removed or installed for you.';
  box.append(note);
  for (const r of rows) {
    const row = el('div', 'conflict-step');
    // An open-arrow marker where a numbered step has its digit: same rhythm and alignment, while
    // saying these are not part of the count - every one of them only opens a page.
    const mark = el('span', 'num open');
    mark.innerHTML = '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
    const lbl = el('span', 'lbl'); lbl.textContent = r[1];
    const b = el('button', 'conflict-act'); b.textContent = r[0]; b.onclick = r[2];
    row.append(mark, lbl, b);
    box.append(row);
  }
  wrap.append(box);
  return wrap;
}

/**
 * Why this format cannot run, and the exact sequence out of it - as a checklist that fills in as
 * each step really lands, not a wall of instructions.
 *
 * ── What Awaitful does and does not do here ──────────────────────────────────────
 *
 * The remove buttons run VS Code's own uninstall, on an explicit click on a button that says
 * exactly that. Awaitful still never removes or disables anything on its own initiative, and never
 * touches another extension's code - the distinction that matters is UNILATERAL versus REQUESTED,
 * and every one of these is requested. Nothing here is chained or automatic: one click, one step.
 *
 * ── Progress is derived, never remembered ───────────────────────────────────────
 *
 * A step is done because the world says so, not because a button was pressed. "Remove the other
 * extension" ticks when it is genuinely no longer on disk, which the host re-reads on every
 * extension change - so the list fills in live, and it is equally right if the developer did it
 * themselves in the Extensions view, or did it before ever opening this panel.
 *
 * The Claude Code steps have no tick of their own on purpose: the moment its file is pristine again
 * this entire box disappears, which is a more honest completion signal than a green circle.
 *
 * ── Heading copy is conditional on evidence ─────────────────────────────────────
 *
 * "Was modified by another extension" may only be said when a foreign marker or a named vendor was
 * actually found. In the unknown states it could equally be a partial update or a hand edit, and
 * blaming an extension would send the developer hunting for one that may not exist. It never says
 * "already modified" either - that reads as though Awaitful did it.
 */
/**
 * The repair worked, and one reload is left.
 *
 * Not the conflict box. Installing Claude Code makes it present immediately, so tearing the guidance
 * away on that event would lose the reload step before it could be clicked - the requirement this
 * state exists for. But keeping the CONFLICT box for it was worse: it drew a checklist for a
 * conflict that no longer existed, told the developer to remove an extension that was already gone,
 * and offered to restore a file that was already clean. Nothing here is wrong, so nothing here is
 * warn-coloured, and the activate button stays on the page beside it.
 */
function buildRepairDoneBox(m) {
  const box = el('div', 'info-box');
  const lbl = el('div', 'info-label');
  lbl.textContent = 'Almost there';
  const t = el('div', 'conflict-text');
  t.textContent = 'Claude Code’s file is clean again. Reload the window to finish, and '
    + (m.label || 'this format') + ' will show its line.';
  const acts = el('div', 'stalled-acts');
  const b = el('button', 'conflict-act');
  b.textContent = 'Reload window';
  b.onclick = () => reloadHere();
  acts.append(b);
  box.append(lbl, t, acts);
  return box;
}

function buildConflictBox(id, sv, m) {
  const named = sv.conflictVendor;                       // on disk, so safe to name
  const vendorState = sv.conflictVendorInstalled;
  const attributable = !!(named || sv.conflictToken);    // a real foreign fingerprint was found
  const who = named || 'Another extension';
  const whoLow = named || 'the other extension';
  const label = m.label || id;
  const appLabel = state.appName || 'the editor';
  const vhost = sv.conflictVendorHost;
  const hostName = (vhost && vhost.label) || 'another editor';
  const hostPending = !!(vhost && vhost.pendingRemoval);

  // Two different facts, and the gap between them is the whole reason a reload is a step rather than
  // a footnote. One is the DISK: VS Code marked the extension removed. The other is the running
  // window, which keeps the old extension loaded - still drawing its status bar item, still
  // clickable - until a reload. Only a reload closes that gap.
  const filesGone = sv.agentFilesPresent === false;
  const hostHasEditor = state.anyAgentEditor !== false;
  const removalPending = filesGone && hostHasEditor;
  const agentInstalled = sv.agentInstalled !== false;
  /**
   * Uninstalled, with its patched bytes still on disk.
   *
   * THE DEFECT THIS FIELD EXISTS FOR. An editor drops the registry entry the instant you uninstall
   * and deletes the folder only when the whole app restarts - so "Remove Claude Code" leaves the
   * changed file exactly where it was. installedBack read the surviving file as proof Claude Code
   * had been put back, so the last three steps ticked the moment Remove was clicked, having achieved
   * nothing at all, and the box then reported that the steps had not held. They had not been taken.
   */
  const filesStale = !agentInstalled && !filesGone;
  // Claude Code has been put back during this repair - so a competitor that is ALSO back is about to
  // undo it, and the developer is one reload from the top of this list again. Keyed on the registry,
  // never on the bytes: a folder awaiting deletion is not an install.
  const installedBack = sv.repairing === true && agentInstalled;

  const box = el('div', 'info-box conflict');
  const clbl = el('div', 'info-label');
  // ONE heading for the whole repair. It used to change as the state moved underneath, so a
  // developer who did exactly what step two asked watched the box become a different box.
  clbl.textContent = attributable
    ? 'Claude Code was modified by another extension'
    : 'Claude Code was modified outside Awaitful';
  box.append(clbl);

  const lead = el('div', 'conflict-text');
  if (filesGone && sv.repairing) {
    // "Removed" is a claim about something the developer just did HERE. Said on a machine that
    // simply never had Claude Code, it describes a repair nobody started - which is exactly what a
    // stale latch produced on a fresh install.
    lead.textContent = 'Claude Code is removed, so the changed file went with it. Finish the steps below to put a clean copy back.';
  } else if (filesGone) {
    lead.textContent = 'Claude Code is not installed here, so there is no file to attach to. The steps below put a clean copy in place.';
  } else if (vendorState === 'elsewhere') {
    // The state that made the checklist unwinnable. From this window the tool looks uninstalled, so
    // every step said "removed" and the file kept changing back. Naming the application is the whole
    // remedy: the fix is not in this list, it is in that one.
    lead.textContent = hostPending
      // Uninstalled over there, and STILL RUNNING - because an editor keeps an uninstalled extension
      // loaded until it restarts. Without this the developer does the right thing, watches the file
      // change back, and reasonably concludes the instructions were wrong.
      ? who + ' is uninstalled in ' + hostName + ', but ' + hostName + ' has not restarted since - so it '
        + 'is still loaded there and still changing this file. An editor keeps an uninstalled extension '
        + 'running until it starts again.'
      : who + ' is not installed in this window, but a copy in ' + hostName
        + ' is. An extension there can change the same Claude Code files this window uses, so removing it here does not stop it.';
  } else if (vendorState === 'removing') {
    // Uninstalled here and STILL RUNNING. The editor drops the registry entry at once and keeps the
    // code alive until the window reloads, so the developer clicks Remove, watches the file change
    // back, and reasonably concludes the button did nothing.
    lead.textContent = who + ' is uninstalled, but it is still running in this window until you '
      + 'reload - and it puts its change straight back while it runs.';
  } else if (vendorState === 'disabled') {
    // Switched off is not gone, and saying so is the point: the developer already acted, and being
    // told the file is still contested without being told why reads as the fix not working.
    lead.textContent = who + ' is switched off, but the change it already made is still in Claude Code\u2019s file - turning a tool off never undoes what it wrote.';
  } else if (vendorState === 'no' && attributable) {
    lead.textContent = 'The extension that changed Claude Code is gone, but its change is still in the file - removing a tool never undoes what it wrote.';
  } else {
    lead.textContent = (attributable ? who + ' changed' : 'Something changed')
      + ' Claude Code\u2019s files, so Awaitful has stopped showing its line rather than have two sponsored lines appear.';
    if (!attributable) {
      lead.textContent += ' Nothing in the file says what changed it, so this could be another tool, a partial update, or a hand edit.';
    }
  }
  box.append(lead);

  // The loop, named. A tool that re-applies its change on a timer will re-patch a fresh Claude Code
  // within a minute of it appearing, so finishing the reinstall while it is running just returns the
  // developer to the top of this list - which is exactly what it looks like from the outside.
  if (vendorState === 'yes' && installedBack) {
    const loop = el('div', 'conflict-text');
    loop.style.marginTop = '9px';
    loop.textContent = who + ' is installed and running again, and re-applies its change by itself. '
      + 'Claude Code will not stay clean until it is removed, however many times you reinstall it.';
    box.append(loop);
  }

  // The one-click shortcut, when a verified original is recoverable from an Awaitful-controlled
  // source. An ADDITION to the box, never a replacement rendering: it used to return early with its
  // own copy and no button, and the box changed shape the moment it appeared or vanished.
  // Not offered once the file is gone - restoring bytes into nothing is an offer we cannot keep.
  const actions = el('div', 'conflict-actions');
  const step = (text, opts) => stepRow(actions, text, opts);

  /**
   * How far the repair has got, as ONE number.
   *
   * Each step used to read its own fact, which let progress run BACKWARDS: reinstalling Claude Code
   * makes the files present again, so "Remove Claude Code" and the reload after it both un-ticked
   * the moment the developer completed the step after them. A checklist that loses ticks is worse
   * than one that renumbers.
   *
   * A later phase implies every earlier one, because it cannot be reached any other way - so this is
   * a single ladder, and a step is done when the ladder has passed it.
   */
  const phase = installedBack ? 3
    : (!agentInstalled && filesGone && !hostHasEditor) ? 2
      : !agentInstalled ? 1
        : 0;
  const reached = (at) => phase >= at;

  /**
   * The competitor step reads the LIVE world, never the ladder.
   *
   * Monotonic progress is right for the Claude Code steps, because reinstalling it genuinely makes
   * the files present again and un-ticking "remove it" would be progress running backwards. It is
   * WRONG here: nothing later in this list puts the other extension back, so if it is present again
   * the work really was undone, and a tick that survives that is the checklist lying. Reinstalling
   * Claude Code was ticking step one on a machine where the competitor had returned.
   */
  // Uninstalled counts as removed the moment the registry drops it, which is the instant the button
  // is clicked. It used to wait for 'no' - the extension gone from the running window too - so the
  // step sat undone until a reload and the click looked like it had failed.
  const vendorClear = vendorState === 'no' || vendorState === 'removing';
  // ...but the RELOAD is only done when it has actually stopped running. These two used to tick
  // together, on the reasoning that a swept folder proved a restart. The registry is faster than
  // that: it drops the entry immediately, so tying them together would have ticked the reload the
  // developer still has to do.
  const vendorStopped = vendorState === 'no';

  // FIXED numbering, never a count of what is left. A developer working down a list needs step two
  // to still be step two after step one is done; renumbering under them is the same disorientation
  // as the list disappearing, just quieter.
  let n = 0;
  const next = () => ++n;

  const gone = vendorClear;
  const removeText = gone
    ? (named ? named + ' is removed.' : 'The other extension is removed.')
    : vendorState === 'removing'
      ? 'Remove ' + whoLow + '.'
    : filesGone
      ? 'Remove the other extension, if it is still installed.'
      : vendorState === 'disabled'
        ? 'Remove ' + whoLow + '. Switching it off is not enough - it can still be turned back on.'
        : 'Remove ' + whoLow + ' so it stops changing the files.';
  const removeStep = {
    done: gone,
    btn: sv.conflictVendorId ? 'Remove ' + who : 'Show extensions',
    onClick: sv.conflictVendorId
      ? () => send('uninstall-extension', { id: sv.conflictVendorId, from: id })
      : () => send('open-extensions', { query: '@installed' }),
  };

  /**
   * With a verified-clean original of our own, the whole repair is two steps - remove the other tool,
   * then put the file back. Reinstalling Claude Code is the long way round, and only needed when we
   * have no original to write.
   *
   * The removal is not optional and is not a footnote. A tool that re-patches on every load simply
   * undoes the restore within seconds; the engine reclaims a bounded number of times and then yields,
   * so offering the restore as a shortcut ON ITS OWN was offering something that could not hold. It
   * is step two now, behind the removal that makes it stick.
   */
  if (vendorState === 'elsewhere') {
    /**
     * Its own list, because not one step of the ordinary repair applies.
     *
     * There is nothing to remove here, so no button on this page can end it; reinstalling Claude
     * Code only hands the other editor a fresh file to change. The steps have to leave this
     * application, and none of them can be ticked from here - we cannot see another editor's
     * windows, and a tick we cannot justify is worse than a step that waits.
     */
    // Already uninstalled over there, so that step is spent - what remains is the restart, which is
    // the part an editor does not tell you about.
    if (!hostPending) {
      step('Open ' + hostName + ' and uninstall ' + whoLow + ' there, or delete its folder.', {
        n: next(), btn: 'Show the folder', onClick: () => send('show-conflict-host'),
      });
    }
    step('Quit ' + hostName + ' and open it again. Uninstalling does not take effect until it '
      + 'restarts, and until then it keeps putting its change back.', hostPending
      ? { n: next(), btn: 'Show the folder', onClick: () => send('show-conflict-host') }
      : { n: next() });
    step('Come back here and reload this window.', {
      n: next(), btn: 'Reload window', onClick: () => reloadHere(),
    });
    if (sv.canTakeOver) {
      step('If this box is still here afterwards, put Claude Code’s original file back.', {
        n: next(), btn: 'Restore original & enable',
        onClick: () => { send('consent-grant', { id, takeover: true }); state._view = 'surfaces'; render(); },
      });
    }
    box.append(actions);
    if (vhost && vhost.dir) {
      const where = el('div', 'file-why');
      where.style.marginTop = '9px';
      // The folder itself, because deleting it is the one route that does not depend on that
      // editor's own uninstall doing what it says.
      where.textContent = 'Its folder is ' + vhost.dir + '.';
      box.append(where);
    }
  } else if (sv.canTakeOver && !filesGone) {
    step(removeText, { n: next(), ...removeStep });
    step(gone
      ? 'Put Claude Code\u2019s original file back and turn on ' + label + '.'
      : 'Then put Claude Code\u2019s original file back. Doing this first would only be undone.', {
      n: next(),
      btn: 'Restore original & enable',
      onClick: () => { send('consent-grant', { id, takeover: true }); state._view = 'surfaces'; render(); },
    });
    const why = el('div', 'file-why');
    why.textContent = 'Awaitful has a copy of this Claude Code version\u2019s genuine original, verified byte-for-byte, so nothing needs reinstalling.';
    why.style.marginTop = '9px';
    box.append(actions, why);
  } else {
    // No verified original to write, so the file has to come back from Claude Code itself.
    step(removeText, { n: next(), ...removeStep });

    /**
     * The reload comes SECOND, right after the removal, because it is what makes the removal stick.
     *
     * Measured, not assumed: uninstalling the competitor ran its own uninstall hook, which restored
     * Claude Code's original file and deleted its backup - and then the still-running instance put
     * its change straight back within seconds, because VS Code keeps an uninstalled extension loaded
     * until a reload. So the file is only clean once the window has restarted.
     *
     * And once it is clean this whole box disappears, which makes the steps below a FALLBACK for a
     * tool that does not put the file back - not the normal path. They used to run unconditionally,
     * telling everyone to reinstall Claude Code when most never need to.
     */
    // Ticks with the step above it, and that is sound rather than lazy: VS Code only sweeps a
    // removed extension's folder at startup, so the folder being gone - which is what makes
    // vendorState 'no' rather than 'disabled' - IS the evidence that a reload has happened.
    step(vendorStopped
      ? 'The window has been reloaded, so it is no longer running.'
      : 'Reload the window. Until you do, a removed extension keeps running - and puts its change straight back.', {
      n: next(), done: vendorStopped,
      btn: 'Reload window', onClick: () => reloadHere(),
    });

    // Indented to the label column so the rail runs through it: this note sits between step two and
    // step three, and at full width it cut the connector, leaving three steps below looking like a
    // separate list. The after-done class colours that stretch of rail with the steps above it.
    // Appended INTO the step column, not between two of them. Two sibling columns each started
    // their own rail, so the connector died at step two and restarted at step three - the sequence
    // read as two unrelated lists. One column, one rail, and the note is simply a row in it.
    const onlyIfNeeded = el('div', 'step-note' + (gone ? ' after-done' : ''));
    onlyIfNeeded.textContent = 'Most tools put Claude Code\u2019s file back when they are removed. If this box is gone after the reload, you are done - the steps below are only for a tool that did not.';
    actions.append(onlyIfNeeded);

    const restStep = (text, opts) => stepRow(actions, text, opts);

    // Same rule as the lead: "removed" is a claim about something the developer just did here, so it
    // is only said when a repair is genuinely under way. Otherwise the step describes the state.
    // The old copy promised that removing Claude Code "takes the changed file off your machine". It
    // does not: the folder survives until the app restarts, which is the whole reason these steps
    // used to end in a file that had never changed.
    restStep(reached(1)
      ? (filesStale
        ? 'Claude Code is removed, but its files are still on disk until ' + appLabel + ' restarts.'
        : sv.repairing
          ? 'Claude Code is removed, and the changed file went with it.'
          : 'Claude Code is not installed, so there is nothing to remove.')
      : 'Remove Claude Code. The changed file goes with it at the next restart.', {
      n: next(), done: reached(1), btn: 'Remove Claude Code',
      onClick: () => send('uninstall-extension', { id: CLAUDE_CODE_EXT_ID, from: id }),
    });

    // Quit, not reload, and the difference is the entire bug. A window reload restarts the extension
    // host but deletes nothing; only starting the app again removes an uninstalled extension's
    // folder. Reloading here left the patched bytes in place and the next step reinstalled on top of
    // them, so the sequence completed with the file exactly as it started.
    restStep(filesStale
      ? 'Quit ' + appLabel + ' completely and open it again. This is when the changed file is deleted - a window reload leaves it on disk.'
      : removalPending
        ? 'Reload again. Until you do, the removed Claude Code is still loaded.'
        : 'Reload so the removal takes effect.', filesStale
      ? { n: next(), done: reached(2) }
      : {
        n: next(), done: reached(2),
        btn: 'Reload window', onClick: () => reloadHere(),
      });

    // "on a clean file" used to end this sentence, and it could never be true where it was read:
    // this box only renders while the file IS contested, so the last step congratulated the
    // developer on a clean file directly above the warning that the file was not clean. A step may
    // tick for the action it asked for - Claude Code is back - and must claim nothing about bytes it
    // has not checked.
    restStep(reached(3)
      ? 'Claude Code is installed again.'
      : filesStale
        // Reinstalling on top of a folder that has not been deleted yet gets the old bytes back.
        ? 'Install Claude Code again, after the restart above.'
        : 'Install Claude Code again, then turn on ' + label + ' here.', {
      n: next(), done: reached(3), btn: 'Install Claude Code',
      onClick: () => send('install-extension', { id: CLAUDE_CODE_EXT_ID }),
    });
    box.append(actions);

    /**
     * Every step ticked and the file contested anyway: the checklist has FAILED, and until now it
     * said so nowhere.
     *
     * The page read as finished - five ticks, no buttons left - while the box above it warned the
     * format was blocked and the activate button was (correctly) withheld. So the software looked
     * broken in the one state where it most needed to be believed. A finished list that has not
     * fixed anything has to admit it and hand over the next real action.
     */
    // sv.conflict is load-bearing, not belt-and-braces: this box also renders on the latch alone,
    // in the window between putting Claude Code back and the reload that finishes the job. The file
    // is genuinely clean there, so "the change is back in the file" would be exactly wrong.
    if (gone && reached(3) && sv.conflict) {
      // Warn treatment, not a grey footnote. It is the one sentence in the box that contradicts the
      // row of ticks above it, and it has to outrank them or the page still reads as finished.
      const stalled = el('div', 'stalled');
      stalled.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.6 15 14H1L8 1.6z"/><path d="M8 6.4v3.1M8 11.6h.01"/></svg>';
      const strong = el('b');
      strong.textContent = 'These steps did not hold. ';
      const rest2 = text('Every step is done and the file is still changed. Most often the old bytes '
        + 'were never deleted: an editor only removes an uninstalled extension\u2019s folder when the whole '
        + 'app restarts, so a window reload leaves the changed file exactly where it was. Quit '
        + appLabel + ' completely, open it again, and any other editor you have running too.');
      const body = el('span');
      body.append(strong, rest2);
      stalled.appendChild(body);
      box.append(stalled);

      // Plain buttons, not numbered steps. The numbered list is spent; presenting a sixth step
      // would say the same sequence is still running when it has just been shown not to work.
      const after = el('div', 'stalled-acts');
      const act = (text, onClick) => {
        const b = el('button', 'conflict-act');
        b.textContent = text;
        b.onclick = onClick;
        after.append(b);
      };
      act('Reload window', () => reloadHere());
      act('Show all extensions', () => send('open-extensions', { query: '@installed' }));
      box.append(after);
    }
  }

  const rows = [];
  if (sv.conflictVendorId) {
    rows.push(['Open ' + who, 'Uninstall ' + whoLow + ' from its own page.',
      () => send('open-extension', { id: sv.conflictVendorId })]);
  }
  // Not offered when the other copy is in a different editor: reinstalling Claude Code there just
  // hands it a fresh file to change, which is the loop this state exists to name.
  if (vendorState !== 'elsewhere') {
    rows.push(['Open Claude Code', 'Uninstall it, then install it again to get a clean file.',
      () => send('open-extension', { id: CLAUDE_CODE_EXT_ID })]);
  }
  rows.push(['Show all extensions', 'Everything installed, in one list.',
    () => send('open-extensions', { query: '@installed' })]);
  // Kept even though the numbered flow may not end in one: doing it by hand means doing the
  // uninstalls by hand, and THAT is what needs a reload.
  rows.push(['Reload window', 'Needed after removing an extension, not after installing one.',
    () => reloadHere()]);
  box.append(manualSection(rows));
  return box;
}

/**
 * A blocked format that has a way out, on its own page.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────
 *
 * Removing Claude Code is step two of the conflict fix - and the moment it lands, the file is gone,
 * so the state stops being "contested" and becomes "the editor extension is not installed". The
 * conflict box was correct to disappear, but it took the remaining steps with it: the developer was
 * left mid-sequence on a page that had stopped explaining anything, having done exactly what they
 * were told.
 *
 * So the remaining steps live HERE, keyed on the state that is actually true. No latch, nothing
 * remembered: "Claude Code is not installed, here is how to install it and reload" is the right
 * guidance for someone half way through the fix AND for someone who simply never had it. The
 * sequence continues because both boxes describe the same world, not because either is tracking the
 * other.
 */
function buildBlockedBox(id, sv, m) {
  const reason = sv.blockedReason;
  if (reason !== 'no-agent-editor' && reason !== 'no-agent-cli') return null;
  // Mid-repair machines keep the repair checklist instead; this is the never-had-it case, where a
  // list that opened with two ticked steps would describe something the developer never did.
  if (sv.repairing) return null;
  const label = m.label || id;

  const box = el('div', 'info-box conflict');
  const lbl = el('div', 'info-label');
  const lead = el('div', 'conflict-text');

  if (reason === 'no-agent-cli') {
    lbl.textContent = 'Claude Code is not on this machine';
    lead.textContent = 'Awaitful earns while Claude Code thinks, so nothing can run here until it is installed. Install it and run it once, then come back to this page.';
    box.append(lbl, lead);
    const actions = el('div', 'conflict-actions');
    stepRow(actions, 'Install Claude Code and run it once.', {
      n: 1, btn: 'Set up Claude Code', onClick: () => send('open-setup-docs'),
    });
    stepRow(actions, 'Reload this window, then turn on ' + label + ' here.', {
      n: 2, btn: 'Reload window', onClick: () => reloadHere(),
    });
    box.append(actions);
    return box;
  }

  lbl.textContent = 'Claude Code is not installed in this window';
  lead.textContent = label + ' lives inside the Claude Code extension, so it has nothing to attach to until that is back. Your status bar and terminal keep earning meanwhile. If you just removed it to clear another tool\u2019s change, this is the rest of that fix.';
  box.append(lbl, lead);

  // One step. Installing an extension needs no reload - VS Code registers it immediately and this
  // box clears itself. A reload is only needed to unload something that was REMOVED.
  const actions = el('div', 'conflict-actions');
  stepRow(actions, 'Install Claude Code. A fresh install is a clean file, with no other tool\u2019s change in it. Then turn on ' + label + ' here.', {
    n: 1, btn: 'Install Claude Code', onClick: () => send('install-extension', { id: CLAUDE_CODE_EXT_ID }),
  });
  box.append(actions);

  box.append(manualSection([
    ['Open Claude Code', 'Install it from its own page.', () => send('open-extension', { id: CLAUDE_CODE_EXT_ID })],
    ['Reload window', 'Needed after removing an extension, not after installing one.', () => reloadHere()],
  ]));
  return box;
}

function buildDetailView(id) {
  if (id === 'status-bar') return buildStatusBarDetail();
  const isVS = META[id];
  const termMeta = { label: 'Terminal status line', desc: 'Adds a status line to Claude Code (~/.claude/settings.json) that shows a single sponsored line while the agent is thinking, then hands back to your own status line the instant it finishes. Your existing status line is preserved and restored. Works in any terminal - your editor’s or external - and earns alongside whichever format you picked there.', files: [{ path: '~/.claude/settings.json', why: 'Adds a statusLine entry pointing at Awaitful’s script. Your existing status line is backed up and restored when you turn this off.' }], ghPath: 'src/hooks/statusLineScript.ts' };
  const m = isVS ? META[id] : (id === 'terminal' ? termMeta : {});

  const panel = el('div', 'panel');
  const back = backButton();
  panel.append(back);

  panel.append(illusWrap(id));

  const titleRow = el('div', 'card-name-row');
  const title = el('div', 'detail-title'); title.textContent = m.label || id;
  titleRow.append(title);
  const detailRate = id === 'terminal'
    ? state.terminalEarnRate
    : ((state.vsSurfaces || []).find(s => s.id === id) || {}).earnRate;
  // The terminal is additive, so its chip reads "+N×" here exactly as on its card (never a bare "N×").
  const detailChip = rateChip(detailRate, id === 'terminal');
  if (detailChip) titleRow.append(detailChip);
  const desc = el('div', 'detail-desc'); desc.textContent = m.desc || '';

  // Terminal isn't a VS Code format (not in vsSurfaces) - synthesize its state so the footer's
  // Enable/Restore logic works. It has no competitor-conflict concept (settings.json
  // preserve/restore handles coexistence). Resolved before the heading, because the heading now
  // carries the page's primary action and needs to know whether there is one.
  const svDetail = id === 'terminal'
    ? { active: !!state.terminalEnabled, blockedReason: state.terminalBlockedReason, conflict: false }
    : ((state.vsSurfaces || []).find(s => s.id === id) || {});
  const modFiles = m.files || (m.file ? [{ path: m.file, why: '' }] : null);

  panel.append(detailHead(titleRow, detailPrimary(id, svDetail, m)), desc);

  // FIRST, above everything else on the page. This is the reason the format is not working, and it
  // used to sit below the styling controls - so the page opened on "pick a spinner" while the thing
  // that actually needed doing was off screen.
  if (modFiles && repairBoxNeeded(svDetail)) {
    // Same box, same steps, right through the middle of the repair - including the moment removing
    // Claude Code stops the file being contested at all.
    panel.append(buildConflictBox(id, svDetail, m));
  } else if (modFiles && svDetail.repairing) {
    // The repair worked and one reload is left. It used to keep the whole conflict box for this,
    // which then drew steps for a conflict that no longer existed - "remove the other extension"
    // with nothing left to remove, and an offer to restore a file already clean.
    panel.append(buildRepairDoneBox(m));
  } else {
    // Not contested, but still unable to run - and until now this page said nothing at all about
    // why. That silence is what swallowed the back half of the conflict fix.
    const blocked = buildBlockedBox(id, svDetail, m);
    if (blocked) panel.append(blocked);
  }

  // How this format looks: the thing you came here to change once the format is on.
  const cz = buildCustomize(id);
  if (cz) panel.append(cz);

  // Chat-banner: a precise note on what this mode is.
  if (id === 'chat-banner') {
    const whyBox = el('div', 'info-box');
    const whyLbl = el('div', 'info-label'); whyLbl.textContent = 'Why the chat banner';
    const whyP = el('div', 'conflict-text');
    whyP.textContent = "Claude Code's spinner scrolls away with the transcript. The chat banner pins the sponsored line above your input while Claude thinks - a fixed, glanceable ‘still working’ cue that disappears the instant it finishes, so you can scroll back through output and always see when it's done.";
    whyBox.append(whyLbl, whyP);
    panel.append(whyBox);
  }

  if (modFiles) {
    // What changes — one row per file, each with why it changes.
    const box1 = el('div', 'info-box');
    const lbl1 = el('div', 'info-label'); lbl1.textContent = modFiles.length > 1 ? 'What changes (' + modFiles.length + ' files)' : 'What changes';
    box1.append(lbl1);
    modFiles.forEach(f => {
      const p = el('div', 'code-path'); p.textContent = f.path; p.style.marginTop = '6px';
      box1.append(p);
      if (f.why) { const w = el('div', 'file-why'); w.textContent = f.why; box1.append(w); }
    });
    panel.append(box1);

    // Backup & restore
    const box2 = el('div', 'info-box');
    const lbl2 = el('div', 'info-label'); lbl2.textContent = 'Backup & restore';
    const ul = el('ul', 'restore-list');
    const restoreItems = id === 'terminal'
      ? ['Your existing status line is saved before any change', 'The status-line script talks only to 127.0.0.1 and sends no content', 'Restored exactly when you turn this off or restore files']
      : ['A byte-exact copy is saved before any change', 'Restored when you switch format, sign out, or uninstall', 'Restore any time with the button below'];
    restoreItems.forEach(t => {
      const li = el('li'); li.textContent = t; ul.append(li);
    });
    box2.append(lbl2, ul);
    panel.append(box2);

    // GitHub link
    const gh = el('button', 'gh-btn');
    gh.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
    gh.appendChild(text(' View patch source on GitHub →'));
    gh.onclick = () => send('open-github');
    panel.append(gh);
  }


  // Footer
  const footer = el('div', 'detail-footer');
  const restoreBtn = el('button', 'btn-ghost danger');
  // Only actionable once we've actually modified files (surface active).
  if (!modFiles) {
    restoreBtn.style.display = 'none';
  } else if (svDetail.active) {
    if (id === 'terminal') {
      restoreBtn.textContent = 'Restore original status line';
      restoreBtn.onclick = () => { send('toggle-terminal'); state._view = 'surfaces'; render(); };
    } else {
      restoreBtn.textContent = 'Restore original files';
      restoreBtn.onclick = () => send('restore-files');
    }
  } else {
    restoreBtn.textContent = 'Nothing to restore';
    restoreBtn.disabled = true;
    restoreBtn.title = 'No files have been changed yet, so there is nothing to restore.';
  }
  // Reload is offered alongside restore for modifying surfaces — enabling or
  // restoring only takes full effect after the Claude Code webview reloads.
  const reloadBtn = el('button', 'btn-ghost');
  reloadBtn.textContent = 'Reload window';
  reloadBtn.onclick = () => reloadHere();
  if (!modFiles) reloadBtn.style.display = 'none';

  const right = el('div', 'detail-footer-r');
  // A blocked surface never offers Enable. The state can change while a detail page is open (the
  // user uninstalls Claude Code in another window), so this is guarded here too, not only upstream.
  // No enable button down here: the page's primary action lives at the top, beside the heading. Two
  // copies of one action is what let the take-over's button and its explanation drift apart.
  const left = el('div', 'detail-footer-l');
  left.append(restoreBtn, reloadBtn);
  footer.append(left, right);
  panel.append(footer);

  return panel;
}

function openDetail(id) {
  state._view = 'detail';
  state._detailId = id;
  render();
}

// ── Illustration highlight logic ─────────────────────────────────────────────
function getDefaultHighlight() {
  const active = (state.vsSurfaces || []).find(s => s.active);
  return active ? active.id : 'status-bar';
}

// Aim the illustration at one region. The picture decides what that means in CSS, so this is a
// single attribute write rather than four id lookups - and it cannot half-apply.
function updateHighlight(id) {
  for (const iw of document.querySelectorAll('.illus-wrap')) iw.setAttribute('data-active', id);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function text(str) { return document.createTextNode(str); }

// Register the glow @keyframes/@property once (persists across re-renders) so the theme preview animates.
function ensureThemeKeyframes(kf) {
  if (!kf) return;
  let s = document.getElementById('bp-kf');
  if (!s) { s = document.createElement('style'); s.id = 'bp-kf'; document.head.appendChild(s); }
  if (s.textContent !== kf) s.textContent = kf;
}

// Compact money display: cents once ≥ 1¢, four decimals below (sub-cent
// earnings are real here), plain $0.00 for zero.
function fmtUsd(s) {
  const v = parseFloat(s || '0');
  if (!v) return '$0.00';
  return '$' + (v < 0.01 ? v.toFixed(4) : v.toFixed(2));
}

// ── Customize, on each format's own page ─────────────────────────────────────
// These controls are the developer's say over the FRAME an ad is drawn in - the spinner, the logo,
// the glow. They deliberately offer nothing that touches the MESSAGE (the sponsored line and its
// link): that is what the advertiser actually bought, and hiding it while still being paid would
// be a lie.
//
// Nothing below knows what a "spinner" or a "glow" is. state.customize[format] carries each element
// with its control kind, its options and the value in force, straight from the shared catalogue, so
// adding an element there gives every format that declares it a working control with no code here.

/**
 * The stand-in logo. Awaitful advertises on its own network (the house ad), so this is a real ad
 * that really renders, not a mock-up. SVG is fine HERE because this is our own panel; the server
 * only ever inlines raster (PNG/JPEG/WebP/GIF) into a real ad.
 */
const SAMPLE_LOGO = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAyNCAyNCc+PHJlY3Qgd2lkdGg9JzI0JyBoZWlnaHQ9JzI0JyByeD0nNicgZmlsbD0nIzE3MzQwMCcvPjxwYXRoIGQ9J00xMiA1LjVhNi41IDYuNSAwIDEgMS02LjUgNi41JyBmaWxsPSdub25lJyBzdHJva2U9JyNBMUU5NkYnIHN0cm9rZS13aWR0aD0nMi42JyBzdHJva2UtbGluZWNhcD0ncm91bmQnLz48L3N2Zz4=';
const SAMPLE_LINE = 'Awaitful: Get paid awaiting your AI thinking!';

/** One format's elements, or [] for a format that draws none. */
function elementsOf(fmtId) {
  return (state.customize || {})[fmtId] || [];
}
function elementOf(fmtId, elementId) {
  return elementsOf(fmtId).find(e => e.id === elementId);
}
function optionOf(fmtId, elementId, optId) {
  const e = elementOf(fmtId, elementId);
  return e ? (e.options || []).find(o => o.id === optId) : undefined;
}

/**
 * The sponsored line as the shim paints it: spinner, logo, text - in that order, from this format's
 * own values. Every format's page previews with this same function, so a preview cannot drift from
 * the thing it previews, and a format that draws no logo simply has no logo slot.
 */
function linePreview(fmtId) {
  const eg = el('div', 'ad-eg');
  const spin = el('span', 'ad-eg-spin');
  eg.append(spin);

  let img = null;
  if (elementOf(fmtId, 'logo')) {
    img = el('img', 'ad-eg-logo');
    img.src = SAMPLE_LOGO;
    img.setAttribute('alt', '');
    eg.append(img);
  }
  const txt = el('span', 'ad-eg-text');
  txt.textContent = state.activeAdLine || SAMPLE_LINE;
  eg.append(txt);

  // One mutable cell in the shared wall-clock loop, re-pointed as the choice changes - so picking a
  // spinner animates the example immediately without a timer of its own.
  const cell = { frames: [], intervalMs: 0, glyph: spin, txt: '' };
  spinCells.push(cell);

  return {
    node: eg,
    setSpinner: (id) => {
      const o = optionOf(fmtId, 'spinner', id) || {};
      cell.frames = o.frames || [];
      cell.intervalMs = o.intervalMs || 0;
      // "None" is a real choice: clear the glyph rather than leave the last frame frozen there.
      if (!cell.frames.length) { cell.txt = ''; spin.textContent = ''; }
    },
    setLogo: (on) => { eg.classList.toggle('off', on !== true); },
  };
}

/** The chat banner's chrome around that same line: the glow ring and the chat box it outlines. */
function bannerChrome(lineNode) {
  const preview = el('div', 'bp-preview');
  const glow = el('div', 'bp-glow');
  const face = el('div', 'bp-face');
  const tmr = el('span', 'bp-timer'); tmr.textContent = '1.2s';
  face.append(lineNode, tmr);
  const box = el('div', 'bp-box');
  const ph = el('span'); ph.textContent = 'Message Claude…';
  box.append(ph);
  preview.append(glow, face, box);
  return {
    node: preview,
    setGlow: (o) => { if (o) { glow.style.background = o.background; glow.style.animation = o.animation; } },
    setFrame: (id) => {
      glow.classList.remove('f-banner', 'f-full');
      glow.classList.add(id === 'full' ? 'f-full' : 'f-banner');
      preview.classList.toggle('is-full', id === 'full');
    },
  };
}

/**
 * The customization block for one format: a live preview of that format's ad, then a control for
 * each element it declares. Returns null for a format that declares none, so a page never renders
 * an empty box.
 */
function buildCustomize(fmtId) {
  const elements = elementsOf(fmtId);
  if (!elements.length) return null;

  const box = el('div', 'info-box');
  const lbl = el('div', 'info-label'); lbl.textContent = 'Customize';
  box.append(lbl);

  const line = linePreview(fmtId);
  let chrome = null;
  if (elementOf(fmtId, 'glow')) {
    // Register the glow @keyframes/@property once, or the ring renders as a still gradient.
    ensureThemeKeyframes(state.glowKeyframes);
    chrome = bannerChrome(line.node);
    box.append(chrome.node);
  } else {
    box.append(line.node);
  }

  // Every element's live effect on the preview, in one place. An element with nothing to preview
  // (there is none today) simply falls through, so this can never throw on a newer catalogue.
  const preview = (elementId, value) => {
    if (elementId === 'spinner') line.setSpinner(value);
    else if (elementId === 'logo') line.setLogo(value);
    else if (elementId === 'glow' && chrome) chrome.setGlow(optionOf(fmtId, 'glow', value));
    else if (elementId === 'frame' && chrome) chrome.setFrame(value);
  };

  for (const e of elements) {
    box.append(buildElement(fmtId, e, preview));
    preview(e.id, e.value);   // seed the preview from what is in force right now
  }
  return box;
}

/** One element's control. Its control kind decides the shape; nothing here is element-specific. */
function buildElement(fmtId, e, preview) {
  const wrap = el('div', 'elem');
  const commit = (value) => {
    e.value = value;                 // local echo, so the control and preview react before the round trip
    send('set-element', { format: fmtId, element: e.id, value });
    preview(e.id, value);
  };

  if (e.control === 'switch') {
    const row = el('div', 'opt-row');
    const txt = el('div', 'opt-text');
    const t = el('div', 'opt-title'); t.textContent = e.label;
    const sub = el('div', 'opt-sub'); sub.textContent = e.hint;
    txt.append(t, sub);
    const tg = el('button', 'toggle');
    if (e.value === true) tg.classList.add('on');
    tg.setAttribute('role', 'switch');
    tg.setAttribute('aria-checked', e.value === true ? 'true' : 'false');
    tg.setAttribute('aria-label', e.label);
    tg.onclick = () => {
      const next = !tg.classList.contains('on');
      tg.classList.toggle('on', next);
      tg.setAttribute('aria-checked', next ? 'true' : 'false');
      commit(next);
    };
    row.append(txt, tg);
    wrap.append(row);
    return wrap;
  }

  const head = el('div', 'elem-head');
  const t = el('div', 'opt-title'); t.textContent = e.label;
  const sub = el('div', 'opt-sub'); sub.textContent = e.hint;
  head.append(t, sub);
  wrap.append(head);

  const options = e.options || [];
  const select = (row, node, value) => {
    for (const c of row.children) c.classList.remove('on');
    node.classList.add('on');
    commit(value);
  };

  if (e.control === 'gallery') {
    const grid = el('div', 'spin-grid');
    for (const o of options) {
      const frames = o.frames || [];
      const tile = el('button', 'spin-tile');
      if (!frames.length) tile.classList.add('none');
      if (e.value === o.id) tile.classList.add('on');
      tile.title = o.label;
      tile.setAttribute('aria-label', o.label);
      const glyph = el('span', 'spin-glyph');
      glyph.textContent = frames[0] || 'off';
      tile.append(glyph);
      tile.onclick = () => select(grid, tile, o.id);
      grid.append(tile);
      if (frames.length) spinCells.push({ frames, intervalMs: o.intervalMs, glyph, txt: glyph.textContent });
    }
    wrap.append(grid);
    return wrap;
  }

  // 'swatch' and 'chip' are the same row: a swatch option just carries a colour to show alongside
  // its label. An option that can be previewed live is previewed on hover and put back on leave.
  const row = el('div', 'theme-row');
  for (const o of options) {
    const chip = el('button', 'theme-chip');
    if (e.value === o.id) chip.classList.add('on');
    if (o.swatch) { const sw = el('span', 'theme-swatch'); sw.style.background = o.swatch; chip.append(sw); }
    const lb = el('span'); lb.textContent = o.label; chip.append(lb);
    if (o.background) {
      chip.onmouseenter = () => preview(e.id, o.id);
      chip.onmouseleave = () => preview(e.id, e.value);
    }
    chip.onclick = () => select(row, chip, o.id);
    row.append(chip);
  }
  wrap.append(row);
  return wrap;
}

// Wall-clock frames, the same math every real surface uses, so the preview never lies. The loop is
// idle-cheap: spinCells is empty on every page without a customize block. A cell with no frames is
// the "none" spinner, which has nothing to tick and would divide by a zero interval.
(function spinTick() {
  for (const c of spinCells) {
    if (!c.frames.length || !c.intervalMs) continue;
    const f = c.frames[Math.floor(Date.now() / c.intervalMs) % c.frames.length];
    if (f !== c.txt) { c.txt = f; c.glyph.textContent = f; }
  }
  requestAnimationFrame(spinTick);
})();

// ── Message handler ───────────────────────────────────────────────────────────
window.addEventListener('message', e => {
  if (e.data.type === 'navigate') {
    state._view = e.data.view;
    if (e.data.detailId !== undefined) state._detailId = e.data.detailId;
    render();
    return;
  }
  if (e.data.type === 'state') {
    const view = state._view;
    const detailId = state._detailId;
    state = e.data.state;
    state._view = view;
    state._detailId = detailId;
    render();
  }
});

// Initial render
render();
`;

