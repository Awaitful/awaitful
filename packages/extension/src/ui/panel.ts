import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

// ── Public types ──────────────────────────────────────────────────────────────

export interface PanelSurface {
  id: string;
  active: boolean;
  available: boolean;
  consentGranted: boolean;
  comingSoon: boolean;
  modifiesFiles: boolean;
  /** Earning rate relative to the status bar (1 = base). From the live rate card; undefined until known. */
  earnRate: number | undefined;
  /** True when Claude Code has been modified by another extension. */
  conflict?: boolean | undefined;
  /** Display name of the other extension, when it can be resolved. */
  conflictVendor?: string | undefined;
  /** True when a take-over can recover pristine from Awaitful-controlled sources. */
  canTakeOver?: boolean | undefined;
  /** False when this build has no recipe / no target (surface can't be offered here). */
  supported?: boolean | undefined;
  /** Active via a provisional self-recipe on a brand-new build, pending server confirmation. */
  provisional?: boolean | undefined;
}

export interface PanelState {
  /** Extension version, shown in fine print in the panel footer. */
  version: string;
  signedIn: boolean;
  email: string | undefined;
  earningsToday: string | undefined;
  /** Earned but not yet paid out (lifetime minus payouts). */
  unredeemedUsd: string | undefined;
  disabled: boolean;
  /** Whether accrued earnings are shown in the VS Code status bar (idle state). */
  showEarningsInStatusBar: boolean;
  /** Set when an ad is currently showing in the status bar. */
  activeAdLine: string | undefined;
  activeAdUrl: string | undefined;
  /** Chosen chat-banner glow style id, the styles offered, and the shared @keyframes (for the live preview). */
  chatBannerStyle: string;
  chatBannerKeyframes: string;
  chatBannerThemes: { id: string; label: string; swatch: string; background: string; animation: string }[];
  /** Chosen outline frame ('banner' | 'full') and the frames offered. */
  chatBannerFrame: string;
  chatBannerFrames: { id: string; label: string }[];
  /** VS Code surfaces — exactly one active at a time. */
  vsSurfaces: PanelSurface[];
  terminalEnabled: boolean;
  terminalConsentGranted: boolean;
  terminalComingSoon: boolean;
  terminalEarnRate: number | undefined;
}

export type PanelMessage =
  | { type: 'sign-in' }
  | { type: 'sign-out' }
  | { type: 'open-dashboard' }
  | { type: 'set-surface'; id: string }
  | { type: 'set-banner-style'; style: string }
  | { type: 'set-banner-frame'; frame: string }
  | { type: 'consent-grant'; id: string; takeover?: boolean }
  | { type: 'toggle-terminal' }
  | { type: 'restore-files' }
  | { type: 'reload-window' }
  | { type: 'open-github' }
  | { type: 'open-privacy' }
  | { type: 'toggle-enabled' }
  | { type: 'toggle-statusbar-earnings' }
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

  static openOrReveal(
    context: vscode.ExtensionContext,
    onMessage: (msg: PanelMessage) => void,
    state: PanelState,
  ): AwaitfulPanel {
    if (AwaitfulPanel.instance) {
      AwaitfulPanel.instance.panel.reveal(vscode.ViewColumn.Active, true);
      AwaitfulPanel.instance.setState(state);
      return AwaitfulPanel.instance;
    }
    const inst = new AwaitfulPanel(context, onMessage, state);
    AwaitfulPanel.instance = inst;
    return inst;
  }

  static isOpen(): boolean {
    return !!AwaitfulPanel.instance;
  }

  /** Push a state update to the already-open panel without full re-render. */
  setState(state: PanelState): void {
    void this.panel.webview.postMessage({ type: 'state', state });
  }

  dispose(): void {
    AwaitfulPanel.instance = undefined;
    this.panel.dispose();
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml(initialState: PanelState): string {
  const nonce = randomUUID().replace(/-/g, '');
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
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
  --toggle-off:oklch(10% 0.004 135 / 0.18);
}
body.vscode-dark,body.vscode-high-contrast{
  --bg:oklch(11% 0.050 135);--surface:oklch(18% 0.064 135);--surface-2:oklch(22% 0.072 135);
  --border:oklch(86% 0.171 134 / 0.13);--border-strong:oklch(86% 0.171 134 / 0.25);
  --text:oklch(97% 0.004 135);--text-2:oklch(70% 0.010 135);--text-3:oklch(52% 0.008 135);
  --brand:oklch(86% 0.171 134);--brand-dark:oklch(86% 0.171 134);
  --cta:oklch(86% 0.171 134);--cta-text:oklch(10% 0.004 135);
  --active-border:oklch(86% 0.171 134);--active-bg:oklch(86% 0.171 134 / 0.09);
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
  --toggle-off:rgba(255,255,255,0.18);
}

/* ── Layout ── */
.panel{max-width:480px;margin:0 auto;padding:20px 16px 32px}

/* ── Header ── */
.header{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.avatar{
  width:34px;height:34px;border-radius:50%;
  background:var(--brand);color:oklch(10% 0.004 135);
  display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:14px;flex-shrink:0;
}
.header-text{flex:1;min-width:0}
.header-email{font-size:13px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-sub{font-size:11px;color:var(--text-3);margin-top:1px}
/* Eye toggle at the header's right edge: show/hide earnings in the status bar. */
.eye-btn{margin-left:auto;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:none;border:none;padding:5px;border-radius:6px;color:var(--text-3);cursor:pointer;transition:color .12s,background .12s}
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
.signin h3{font-size:15px;font-weight:600;margin-bottom:4px}
.signin p{font-size:12px;color:var(--text-2);margin-bottom:16px;line-height:1.5}

/* ── Interactive illustration ── */
.illus-wrap{
  background:var(--surface);border:1px solid var(--border);
  border-radius:10px;overflow:hidden;margin-bottom:16px;
  aspect-ratio:16/9;position:relative;
}
.illus-wrap svg{width:100%;height:100%;display:block}
.hl{opacity:0;transition:opacity 180ms ease}
.hl.on{opacity:1}

/* ── Privacy strip ── */
.privacy{
  display:flex;align-items:flex-start;gap:9px;
  background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:10px 12px;margin-bottom:14px;
}
.privacy{cursor:pointer;transition:border-color .12s,background .12s}
.privacy:hover{border-color:var(--brand-dark);background:var(--surface-2,var(--surface))}
.privacy:focus-visible{outline:2px solid var(--brand-dark);outline-offset:1px}
.privacy svg{flex-shrink:0;margin-top:1px;color:var(--brand-dark)}
.privacy-text{font-size:11px;color:var(--text-2);line-height:1.55}
.privacy-text strong{color:var(--text);font-weight:600}
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
  font-size:10px;font-weight:600;letter-spacing:.02em;
  color:var(--brand-dark);background:var(--active-bg);
  border:1px solid var(--active-border);border-radius:10px;
  padding:1px 7px;white-space:nowrap;cursor:default;
}
.rate.base{color:var(--text-3);background:var(--surface-2);border-color:var(--border)}

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
  cursor:pointer;transition:border-color 120ms,background 120ms;
  user-select:none;
}
.card:hover:not(.active):not(.soon){border-color:var(--border-strong)}
.card.active{border-color:var(--active-border);background:var(--active-bg);cursor:default}
.card.soon{opacity:.55;cursor:default}
/* Signed-out: the surface is visible but deactivated (faded) until sign-in. */
.card.locked{opacity:.55}
.lock{display:flex;align-items:center;justify-content:center;width:34px;color:var(--text-3)}
.card-icon{width:28px;height:28px;border-radius:6px;background:var(--surface-2);border:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;margin-top:1px}
.card-body{flex:1;min-width:0}
.card-name{font-size:13px;font-weight:600;color:var(--text)}
.card-desc{font-size:11px;color:var(--text-2);margin-top:2px;line-height:1.4}
.card-meta{display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap}
.tag-mod{font-size:10px;color:var(--text-3);display:flex;align-items:center;gap:3px}
.tag-mod svg{opacity:.6}
.btn-learn{font-size:11px;color:var(--brand-dark);background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;transition:text-decoration-color 100ms}
.btn-learn:hover{text-decoration-color:currentColor}
.card-action{flex-shrink:0;display:flex;align-items:center;margin-top:2px}
.badge-soon{font-size:10px;color:var(--text-3);background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:2px 8px}

/* ── Toggle ── */
.toggle{
  width:34px;height:20px;background:var(--toggle-off);border-radius:10px;
  border:none;padding:0;cursor:pointer;position:relative;transition:background 180ms;
  flex-shrink:0;
}
.toggle.on{background:var(--active-border)}
.toggle::after{
  content:'';width:14px;height:14px;background:#fff;border-radius:50%;
  position:absolute;top:3px;left:3px;transition:transform 180ms;
  box-shadow:0 1px 3px rgba(0,0,0,.25);
}
.toggle.on::after{transform:translateX(14px)}
.toggle:focus-visible{outline:2px solid var(--brand-dark);outline-offset:2px}

/* ── Divider ── */
.div{height:1px;background:var(--border);margin:14px 0}

/* ── Footer ── */
.footer{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px}
.btn-ghost{font-size:12px;color:var(--text-2);background:none;border:1px solid var(--border);border-radius:6px;padding:5px 12px;cursor:pointer;transition:border-color 100ms,color 100ms}
.btn-ghost:hover{border-color:var(--border-strong);color:var(--text)}
.btn-ghost.danger{color:oklch(40% 0.18 26);border-color:oklch(40% 0.18 26 / 0.3)}
.btn-ghost.danger:hover{background:oklch(40% 0.18 26 / 0.07)}

/* ── Detail view ── */
.view{display:none}
.view.on{display:block}
.back{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--text-2);background:none;border:none;padding:0;cursor:pointer;margin-bottom:16px}
.back:hover{color:var(--text)}
.detail-title{font-size:17px;font-weight:700;margin-bottom:4px}
.detail-desc{font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:16px}
.info-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px}
.info-box.conflict{border-color:oklch(70% 0.14 70 / .5);background:oklch(70% 0.14 70 / .08)}
.conflict-text{font-size:12px;color:var(--text-2);line-height:1.55}
.conflict-steps{font-size:12px;color:var(--text-2);line-height:1.55;margin:8px 0 0;padding-left:18px}
.conflict-steps li{margin:2px 0}
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
.bp-text{color:var(--text);text-decoration:underline;overflow:hidden;text-overflow:ellipsis;min-width:0}
.bp-timer{margin-left:auto;flex:0 0 auto;opacity:.55;font-variant-numeric:tabular-nums;color:var(--text-3)}
.bp-box{position:relative;z-index:1;box-sizing:border-box;height:42px;background:var(--surface-2);border:1px solid var(--border);border-radius:0 0 7px 7px;display:flex;align-items:center;padding:0 11px}
.bp-box span{font-size:12px;color:var(--text-3)}
.bp-preview.is-full .bp-face{border-bottom:1px solid var(--border)}                    /* divider between ad + chat */
.bp-preview.is-full .bp-box{border-color:transparent;border-top-color:var(--border)}   /* the glow is the outer edge */
.bp-frame-row{display:flex;gap:6px;margin:2px 0 8px}
.bp-frame{font-size:11px;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:4px 12px;cursor:pointer;transition:all 120ms}
.bp-frame:hover{border-color:var(--border-strong)}
.bp-frame.on{color:var(--brand-dark);background:var(--active-bg);border-color:var(--active-border);font-weight:600}
@media (prefers-reduced-motion:reduce){.bp-glow{animation:none!important}}
.gh-btn{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--brand-dark);background:none;border:1px solid var(--border-strong);border-radius:6px;padding:8px 12px;cursor:pointer;width:100%;transition:background 100ms;margin-bottom:16px}
.gh-btn:hover{background:var(--surface)}
.detail-footer{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}
.detail-footer-l{display:flex;gap:8px}
.detail-footer-r{display:flex;gap:8px}
.btn-primary{font-size:12px;font-weight:600;color:var(--cta-text);background:var(--cta);border:none;border-radius:6px;padding:6px 14px;cursor:pointer;transition:opacity 100ms}
.btn-primary:hover{opacity:.88}

/* ── Ad callout (when ad is showing) ── */
.ad-callout{background:var(--active-bg);border:1px solid var(--active-border);border-radius:8px;padding:10px 12px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.ad-line{font-size:13px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn-visit{font-size:11px;font-weight:600;color:var(--cta-text);background:var(--cta);border:none;border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:opacity 100ms}
.btn-visit:hover{opacity:.88}

/* ── Paused banner ── */
.paused-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;padding:12px 14px;margin-bottom:16px}
.paused-text{font-size:12px;color:var(--text-2);line-height:1.5}
.paused-text strong{color:var(--text);font-weight:600}
.paused-banner .btn-primary{flex-shrink:0}
`;

// ── Interactive VS Code Illustration ─────────────────────────────────────────
// Single SVG of a VS Code window; each surface has a named group (.hl) that
// fades in on hover/active to show exactly where that surface lives.

const ILLUSTRATION = `<svg viewBox="0 0 400 225" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <!-- Window chrome (short title bar) -->
  <rect width="400" height="225" rx="6" fill="currentColor" opacity=".06"/>
  <rect width="400" height="24" rx="6" fill="currentColor" opacity=".08"/>
  <rect y="18" width="400" height="6" fill="currentColor" opacity=".08"/>
  <circle cx="14" cy="11" r="3.5" fill="currentColor" opacity=".22"/>
  <circle cx="26" cy="11" r="3.5" fill="currentColor" opacity=".22"/>
  <circle cx="38" cy="11" r="3.5" fill="currentColor" opacity=".22"/>
  <!-- Command bar (top center, in line with the traffic lights) -->
  <rect x="140" y="5" width="120" height="11" rx="3" fill="currentColor" opacity=".05"/>
  <rect x="140" y="5" width="120" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1" opacity=".12"/>
  <rect x="154" y="9" width="92" height="3" rx="1" fill="currentColor" opacity=".14"/>

  <!-- Activity bar -->
  <rect x="0" y="24" width="24" height="186" fill="currentColor" opacity=".06"/>
  <rect x="4" y="34" width="16" height="16" rx="3" fill="currentColor" opacity=".15"/>
  <rect x="4" y="56" width="16" height="16" rx="3" fill="currentColor" opacity=".10"/>
  <rect x="4" y="78" width="16" height="16" rx="3" fill="currentColor" opacity=".10"/>

  <!-- Sidebar / explorer -->
  <rect x="24" y="24" width="48" height="186" fill="currentColor" opacity=".04"/>
  <rect x="30" y="34" width="36" height="5" rx="2" fill="currentColor" opacity=".20"/>
  <rect x="30" y="44" width="26" height="4" rx="2" fill="currentColor" opacity=".15"/>
  <rect x="30" y="52" width="32" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="30" y="60" width="22" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="30" y="68" width="28" height="4" rx="2" fill="currentColor" opacity=".12"/>

  <!-- Editor (middle-left, code) -->
  <rect x="72" y="24" width="144" height="150" fill="currentColor" opacity=".03"/>
  <rect x="80" y="34" width="100" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="42" width="122" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="50" width="82" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="62" width="114" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="70" width="94" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="82" width="110" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="94" width="78" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="106" width="118" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="118" width="98" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="130" width="112" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="142" width="86" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="154" width="102" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="166" width="90" height="4" rx="2" fill="currentColor" opacity=".16"/>

  <!-- Terminal (lower-middle, left of Claude Code, above the status bar) -->
  <rect x="72" y="176" width="144" height="34" fill="currentColor" opacity=".05"/>
  <rect x="72" y="176" width="144" height="1" fill="currentColor" opacity=".12"/>
  <rect x="80" y="182" width="22" height="4" rx="2" fill="currentColor" opacity=".25"/>
  <rect x="106" y="182" width="40" height="4" rx="2" fill="currentColor" opacity=".14"/>
  <circle cx="82" cy="198" r="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".20" stroke-dasharray="10 6"/>
  <rect x="92" y="194.5" width="96" height="7" rx="2" fill="currentColor" opacity=".12"/>

  <!-- Claude Code panel (docked right, widest) -->
  <rect x="218" y="24" width="182" height="186" fill="currentColor" opacity=".035"/>
  <rect x="218" y="24" width="1" height="186" fill="currentColor" opacity=".12"/>
  <!-- chat messages -->
  <rect x="226" y="34" width="130" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="226" y="42" width="150" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="226" y="50" width="108" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="226" y="62" width="142" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="226" y="70" width="96" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="226" y="82" width="134" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="226" y="90" width="104" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <!-- Thinking line (just above the banner) -->
  <circle cx="232" cy="157" r="5" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".22" stroke-dasharray="12 8"/>
  <rect x="242" y="153" width="96" height="8" rx="3" fill="currentColor" opacity=".12"/>
  <!-- Chat banner: same width as the chat box; rounded top, sides end where the box corner curve ends -->
  <path d="M226 178 L226 170 Q226 165 231 165 L387 165 Q392 165 392 170 L392 178 Z" fill="currentColor" opacity=".06"/>
  <path d="M226 184 L226 170 Q226 165 231 165 L387 165 Q392 165 392 170 L392 184" fill="none" stroke="currentColor" stroke-width="1" opacity=".14"/>
  <rect x="232" y="169" width="70" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="368" y="169" width="20" height="4" rx="1" fill="currentColor" opacity=".16"/>
  <!-- Chat input box (placeholder row + mic, button row below) -->
  <rect x="226" y="178" width="166" height="30" rx="6" fill="currentColor" opacity=".03"/>
  <rect x="226" y="178" width="166" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1" opacity=".16"/>
  <rect x="232" y="184" width="88" height="4" rx="2" fill="currentColor" opacity=".14"/>
  <circle cx="384" cy="186" r="2.6" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".22"/>
  <rect x="232" y="197" width="7" height="7" rx="2" fill="currentColor" opacity=".14"/>
  <rect x="242" y="197" width="7" height="7" rx="2" fill="currentColor" opacity=".14"/>
  <rect x="346" y="199" width="26" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="378" y="194" width="11" height="11" rx="3" fill="currentColor" opacity=".25"/>

  <!-- Status bar (very bottom strip; the ad area is the wide item at the right) -->
  <rect x="0" y="210" width="400" height="15" fill="currentColor" opacity=".08"/>
  <rect x="6" y="214" width="30" height="7" rx="2" fill="currentColor" opacity=".14"/>
  <rect x="42" y="214" width="22" height="7" rx="2" fill="currentColor" opacity=".10"/>
  <rect x="304" y="214" width="88" height="7" rx="2" fill="currentColor" opacity=".13"/>
  <circle cx="311" cy="217.5" r="2" fill="currentColor" opacity=".18"/>

  <!-- ═══════════ HOTSPOT OVERLAYS (toggled by JS) ═══════════════════════════ -->

  <!-- Status bar highlight (ad area = wide item on the right; label centered) -->
  <g id="hl-status-bar" class="hl">
    <rect x="0" y="210" width="400" height="15" fill="oklch(86% 0.171 134)" opacity=".25"/>
    <rect x="304" y="211" width="90" height="13" rx="2" fill="oklch(86% 0.171 134)" opacity=".6"/>
    <circle cx="311" cy="217.5" r="2.5" fill="white"/>
    <rect x="318" y="214" width="70" height="7" rx="2" fill="white" opacity=".75"/>
    <rect x="162" y="211" width="76" height="13" rx="2" fill="oklch(86% 0.171 134)"/>
    <text x="200" y="220.5" text-anchor="middle" font-size="9" font-weight="600" fill="oklch(10% 0.004 135)">Status bar</text>
    <line x1="238" y1="217.5" x2="302" y2="217.5" stroke="oklch(86% 0.171 134)" stroke-width="1" stroke-dasharray="3 2"/>
  </g>

  <!-- Thinking-line highlight -->
  <g id="hl-thinking-line" class="hl">
    <rect x="218" y="149" width="182" height="16" rx="2" fill="oklch(86% 0.171 134)" opacity=".12"/>
    <circle cx="232" cy="157" r="5" fill="none" stroke="oklch(86% 0.171 134)" stroke-width="1.8" stroke-dasharray="12 8"/>
    <rect x="242" y="153" width="100" height="8" rx="3" fill="oklch(86% 0.171 134)" opacity=".65"/>
    <rect x="108" y="149" width="100" height="16" rx="3" fill="oklch(86% 0.171 134)"/>
    <text x="158" y="160.5" text-anchor="middle" font-size="9" font-weight="600" fill="oklch(10% 0.004 135)">Thinking-line</text>
    <line x1="208" y1="157" x2="226" y2="157" stroke="oklch(86% 0.171 134)" stroke-width="1" stroke-dasharray="3 2"/>
  </g>

  <!-- Chat banner highlight (same width; open-bottom outline; seconds bar) -->
  <g id="hl-chat-banner" class="hl">
    <path d="M226 178 L226 170 Q226 165 231 165 L387 165 Q392 165 392 170 L392 178 Z" fill="oklch(86% 0.171 134)" opacity=".24"/>
    <path d="M226 184 L226 170 Q226 165 231 165 L387 165 Q392 165 392 170 L392 184" fill="none" stroke="oklch(86% 0.171 134)" stroke-width="1.2" opacity=".85"/>
    <rect x="232" y="169" width="70" height="4" rx="2" fill="oklch(86% 0.171 134)" opacity=".9"/>
    <rect x="368" y="169" width="20" height="4" rx="1" fill="oklch(86% 0.171 134)" opacity=".7"/>
    <rect x="104" y="163" width="100" height="16" rx="3" fill="oklch(86% 0.171 134)"/>
    <text x="154" y="174.5" text-anchor="middle" font-size="9" font-weight="600" fill="oklch(10% 0.004 135)">Chat banner</text>
    <line x1="204" y1="171" x2="224" y2="172" stroke="oklch(86% 0.171 134)" stroke-width="1" stroke-dasharray="3 2"/>
  </g>

  <!-- Terminal highlight -->
  <g id="hl-terminal" class="hl">
    <rect x="72" y="176" width="144" height="34" fill="oklch(86% 0.171 134)" opacity=".12"/>
    <rect x="72" y="176" width="144" height="1.5" fill="oklch(86% 0.171 134)" opacity=".5"/>
    <circle cx="82" cy="198" r="4" fill="none" stroke="oklch(86% 0.171 134)" stroke-width="1.8" stroke-dasharray="10 6"/>
    <rect x="92" y="194.5" width="104" height="7" rx="2" fill="oklch(86% 0.171 134)" opacity=".65"/>
    <rect x="98" y="160" width="86" height="16" rx="3" fill="oklch(86% 0.171 134)"/>
    <text x="141" y="171.5" text-anchor="middle" font-size="9" font-weight="600" fill="oklch(10% 0.004 135)">Terminal</text>
    <line x1="141" y1="176" x2="141" y2="182" stroke="oklch(86% 0.171 134)" stroke-width="1" stroke-dasharray="3 2"/>
  </g>
</svg>`;

// ── Client-side JavaScript ────────────────────────────────────────────────────

const JS = `
'use strict';
const vscode = acquireVsCodeApi();
const send = (type, extra) => vscode.postMessage({ type, ...extra });

// Surface metadata (descriptions + modifies info)
const TL_FILES = [
  { path: 'claude-code / webview/index.js', why: 'Shows the sponsored line in place of the thinking spinner.' },
  { path: 'claude-code / extension.js', why: 'Lets the line confirm it was actually shown, over localhost only - so earnings are never counted unless the ad was really visible.' },
];
const META = {
  'status-bar':   { icon:'◉', label:'Status bar',       desc:'A single sponsored line at the right end of the status bar, only while your agent thinks.', mod:false },
  'chat-banner':  { icon:'▣', label:'Chat banner',      desc:'A sponsored banner above the chat input while the agent thinks. Disappears when the response starts.', mod:true, files: TL_FILES, ghPath:'src/patch' },
  'thinking-line':{ icon:'≡', label:'Thinking-line',    desc:'Replaces the spinner verb while the agent thinks. Subtle and unobtrusive.', mod:true, files: TL_FILES, ghPath:'src/patch' },
};

let state = JSON.parse(document.getElementById('initial-state').textContent);
let hovered = null;  // currently hovered surface id

// ── State application ──────────────────────────────────────────────────────
function render() {
  const root = document.getElementById('root');
  const signed = state.signedIn;

  root.innerHTML = '';

  if (state._view === 'detail') {
    root.appendChild(buildDetailView(state._detailId));
    return;
  }

  if (state._view === 'privacy') {
    root.appendChild(buildPrivacyView());
    return;
  }

  const panel = el('div', 'panel');

  // Header or sign-in
  if (signed) {
    const header = el('div', 'header');
    const av = el('div', 'avatar');
    av.textContent = (state.email || '?')[0].toUpperCase();
    const ht = el('div', 'header-text');
    const he = el('div', 'header-email'); he.textContent = state.email || '';
    const hs = el('div', 'header-sub');
    if (state.unredeemedUsd !== undefined || state.earningsToday !== undefined) {
      const parts = [];
      if (state.unredeemedUsd !== undefined) parts.push(fmtUsd(state.unredeemedUsd) + ' to redeem');
      if (state.earningsToday !== undefined) parts.push(fmtUsd(state.earningsToday) + ' today');
      hs.textContent = parts.join(' · ');
    } else {
      hs.textContent = 'Earning while your AI agent thinks';
    }
    ht.append(he, hs);
    // Eye toggle (right edge): show/hide accrued earnings in the status bar (a privacy preference).
    const eye = el('button', 'eye-btn');
    const shown = state.showEarningsInStatusBar;
    eye.title = shown ? 'Earnings shown in the status bar - click to hide' : 'Earnings hidden from the status bar - click to show';
    eye.setAttribute('aria-label', eye.title);
    eye.innerHTML = shown
      ? '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2.1"/></svg>'
      : '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" opacity=".45"/><circle cx="8" cy="8" r="2.1" opacity=".45"/><line x1="2.5" y1="2.5" x2="13.5" y2="13.5"/></svg>';
    eye.onclick = () => send('toggle-statusbar-earnings');
    header.append(av, ht, eye);
    panel.append(header);
  } else {
    panel.append(buildSignIn());
  }

  // Paused banner — prominent, forget-proof resume.
  if (signed && state.disabled) {
    const pb = el('div', 'paused-banner');
    const pt = el('div', 'paused-text');
    pt.innerHTML = '<strong>Paused.</strong> Awaitful is earning nothing, and Claude Code is left unmodified. Resume whenever you like.';
    const rb = el('button', 'btn-primary'); rb.textContent = 'Resume'; rb.onclick = () => send('toggle-enabled');
    pb.append(pt, rb);
    panel.append(pb);
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
    panel.append(ac);
  }

  // Illustration
  const iw = el('div', 'illus-wrap');
  iw.innerHTML = ${JSON.stringify(ILLUSTRATION)};
  panel.append(iw);

  // Sync highlights
  updateHighlight(getDefaultHighlight());

  // VS Code surfaces
  const sect1 = el('div', 'sect'); sect1.textContent = 'Visual Studio Code';
  const sub1 = el('div', 'sect-sub'); sub1.textContent = 'One active surface at a time';
  panel.append(sect1, sub1);

  const ids = ['status-bar', 'thinking-line', 'chat-banner'];
  for (const id of ids) {
    const sv = (state.vsSurfaces || []).find(s => s.id === id) || { id, active:false, available:false, consentGranted:false, comingSoon:true, modifiesFiles:false };
    panel.append(buildCard(sv));
  }

  // Terminal
  const div1 = el('div', 'div');
  const sect2 = el('div', 'sect'); sect2.textContent = 'Terminal';
  const sub2 = el('div', 'sect-sub'); sub2.textContent = 'Stacks on top of your VS Code earnings - run both · Works in any terminal';
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

function buildSignIn() {
  const s = el('div', 'signin');
  const logo = el('div', 'signin-logo'); logo.textContent = '◉';
  const h3 = el('h3'); h3.textContent = 'Sign in to start earning';
  const p = el('p'); p.textContent = 'Link your editor once. Earn every time your AI agent thinks.';
  const btn = el('button', 'btn-primary'); btn.textContent = 'Sign in'; btn.onclick = () => send('sign-in');
  s.append(logo, h3, p, btn);
  return s;
}

function buildPrivacyStrip() {
  const p = el('div', 'privacy');
  p.setAttribute('role', 'button');
  p.setAttribute('tabindex', '0');
  p.title = 'See exactly what leaves your machine';
  p.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0l6 2.5v4.2c0 3.9-2.6 7.4-6 8.8-3.4-1.4-6-4.9-6-8.8V2.5L8 0z" opacity=".25"/><path d="M6.9 10.2L4.7 8l.9-.9 1.3 1.3 3.5-3.5.9.9-4.4 4.4z"/></svg>';
  const t = el('div', 'privacy-text');
  t.innerHTML = '<strong>Private by design.</strong> Awaitful never reads your code, prompts, or agent output - it only detects that your agent is thinking, and for how long. The default Status bar surface modifies nothing. <span class="privacy-more">What leaves your machine →</span>';
  p.append(t);
  const open = () => { state._view = 'privacy'; render(); };
  p.onclick = open;
  p.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  return p;
}

// A full, honest disclosure of the only things the client ever sends. Mirrors PRIVACY.md;
// every row here is enforced by the egress-whitelist test in @awaitful/shared.
function buildPrivacyView() {
  const panel = el('div', 'panel');
  const back = el('button', 'back'); back.textContent = '← Back'; back.onclick = () => { state._view = 'surfaces'; render(); };
  panel.append(back);

  const title = el('div', 'detail-title'); title.textContent = 'What leaves your machine';
  const desc = el('div', 'detail-desc');
  desc.innerHTML = 'Awaitful needs to know only <strong>that</strong> your agent is thinking and <strong>for how long</strong> - never <strong>what</strong> you or the agent are doing. Below is the complete list of what the client sends. There is no field anywhere for your code, prompts, files, or the agent’s output.';
  panel.append(title, desc);

  const sends = [
    ['Which surface to show an ad on', 'The placement name (status bar, chat banner, …) and optional coarse hints like hour-of-day - off unless you enable them.'],
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

// Earning-rate chip — value comes from the server's live rate card, never
// hardcoded here. Hidden until the rate card has been fetched.
function rateChip(rate) {
  if (rate === undefined || rate === null) return null;
  const chip = el('span', rate === 1 ? 'rate base' : 'rate');
  chip.textContent = rate === 1 ? '1× base rate' : '≈' + rate + '× earnings';
  chip.title = 'Verified views here earn about ' + rate + '× the status-bar rate. Set by the live rate card and may change over time.';
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

function buildCard(sv) {
  const m = META[sv.id] || {};
  const locked = !state.signedIn && !sv.comingSoon;
  const card = el('div', 'card');
  if (sv.active && !locked) card.classList.add('active');
  if (sv.comingSoon) card.classList.add('soon');
  if (locked) {
    card.classList.add('locked');
    card.title = 'Sign in to activate';
    card.onclick = () => send('sign-in');
  } else if (!sv.active && !sv.comingSoon) {
    card.onclick = () => handleEnable(sv);
  }

  // Highlight illustration on hover
  card.addEventListener('mouseenter', () => { hovered = sv.id; updateHighlight(sv.id); });
  card.addEventListener('mouseleave', () => { hovered = null; updateHighlight(getDefaultHighlight()); });

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
    if (!locked) {
      const learn = el('button', 'btn-learn'); learn.textContent = 'Learn more →';
      learn.onclick = (e) => { e.stopPropagation(); openDetail(sv.id); };
      meta.append(learn);
    }
  } else {
    const tag = el('span', 'tag-safe');
    tag.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Does not modify Claude Code';
    meta.append(tag);
  }
  body.append(meta);

  const action = el('div', 'card-action');
  if (sv.comingSoon) {
    const b = el('span', 'badge-soon'); b.textContent = 'Coming soon';
    action.append(b);
  } else if (locked) {
    action.append(lockGlyph());
  } else {
    // iOS-style switch. The three VS Code surfaces are mutually exclusive (exactly one active),
    // so turning one on switches away from the others; turning off a webview surface reverts to
    // the status-bar default (the always-on floor, which can't itself be turned off).
    const toggle = el('button', 'toggle');
    if (sv.active) toggle.classList.add('on');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', sv.active ? 'true' : 'false');
    toggle.setAttribute('aria-label', m.label || sv.id);
    if (sv.active && sv.provisional) toggle.title = 'Running on a new Claude Code version - confirming it automatically. You are earning normally.';
    toggle.onclick = (e) => {
      e.stopPropagation();
      if (sv.active) {
        if (sv.id !== 'status-bar') send('set-surface', { id: 'status-bar' }); // revert to the default
      } else {
        handleEnable(sv); // activate (status-bar: direct; webview: opens the consent/detail page)
      }
    };
    action.append(toggle);
  }

  card.append(icon, body, action);
  return card;
}

function buildTerminalCard() {
  const sv = { id: 'terminal', active: false, comingSoon: state.terminalComingSoon };
  const locked = !state.signedIn && !sv.comingSoon;
  const m = { icon: '>_', label: 'Terminal status line', desc: 'A sponsored line in Claude Code’s status line while it’s thinking. Runs alongside your VS Code surface.', mod: true, file: '~/.claude/settings.json', ghPath: 'src/hooks/statusLineScript.ts' };

  const card = el('div', 'card');
  if (sv.comingSoon) card.classList.add('soon');
  if (locked) {
    card.classList.add('locked');
    card.title = 'Sign in to activate';
    card.onclick = () => send('sign-in');
  }
  card.addEventListener('mouseenter', () => { hovered = 'terminal'; updateHighlight('terminal'); });
  card.addEventListener('mouseleave', () => { hovered = null; updateHighlight(getDefaultHighlight()); });

  const icon = el('div', 'card-icon'); icon.textContent = '>_'; icon.style.fontFamily = 'monospace';
  const body = el('div', 'card-body');
  const nameRow = el('div', 'card-name-row');
  const name = el('div', 'card-name'); name.textContent = m.label;
  nameRow.append(name);
  const chip = rateChip(state.terminalEarnRate);
  if (chip) {
    chip.title = 'Runs alongside your VS Code surface - these earnings stack on top. ' + chip.title;
    nameRow.append(chip);
  }
  const desc = el('div', 'card-desc'); desc.textContent = m.desc;
  const meta = el('div', 'card-meta');
  const tag = el('span', 'tag-mod'); tag.textContent = '⚙ Modifies settings.json';
  meta.append(tag);
  if (!locked) {
    const learn = el('button', 'btn-learn'); learn.textContent = 'Learn more →';
    learn.onclick = (e) => { e.stopPropagation(); openDetail('terminal'); };
    meta.append(learn);
  }
  body.append(nameRow, desc, meta);

  const action = el('div', 'card-action');
  if (sv.comingSoon) {
    const b = el('span', 'badge-soon'); b.textContent = 'Coming soon';
    action.append(b);
  } else if (locked) {
    action.append(lockGlyph());
  } else {
    const toggle = el('button', 'toggle');
    if (state.terminalEnabled) toggle.classList.add('on');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', state.terminalEnabled ? 'true' : 'false');
    toggle.setAttribute('aria-label', 'Terminal status line');
    // Like the file-modifying VS Code surfaces: turning it ON opens the detail page (review the
    // settings.json change, then enable); turning it OFF disables + restores your status line.
    toggle.onclick = (e) => {
      e.stopPropagation();
      if (state.terminalEnabled) send('toggle-terminal');
      else openDetail('terminal');
    };
    action.append(toggle);
  }

  card.append(icon, body, action);
  return card;
}

function buildDetailView(id) {
  const isVS = META[id];
  const termMeta = { label: 'Terminal status line', desc: 'Adds a status line to Claude Code (~/.claude/settings.json) that shows a single sponsored line while the agent is thinking, then hands back to your own status line the instant it finishes. Your existing status line is preserved and restored. Works in any terminal - VS Code’s or external - and earns alongside your VS Code surface.', files: [{ path: '~/.claude/settings.json', why: 'Adds a statusLine entry pointing at Awaitful’s script. Your existing status line is backed up and restored when you turn this off.' }], ghPath: 'src/hooks/statusLineScript.ts' };
  const m = isVS ? META[id] : (id === 'terminal' ? termMeta : {});

  const panel = el('div', 'panel');
  const back = el('button', 'back'); back.textContent = '← Back'; back.onclick = () => { state._view = 'surfaces'; render(); };
  panel.append(back);

  const iw = el('div', 'illus-wrap');
  iw.innerHTML = ${JSON.stringify(ILLUSTRATION)};
  panel.append(iw);
  // Highlight the surface in the detail illustration
  setTimeout(() => updateHighlight(id), 0);

  const titleRow = el('div', 'card-name-row');
  const title = el('div', 'detail-title'); title.textContent = m.label || id;
  titleRow.append(title);
  const detailRate = id === 'terminal'
    ? state.terminalEarnRate
    : ((state.vsSurfaces || []).find(s => s.id === id) || {}).earnRate;
  const detailChip = rateChip(detailRate);
  if (detailChip) titleRow.append(detailChip);
  const desc = el('div', 'detail-desc'); desc.textContent = m.desc || '';
  panel.append(titleRow, desc);

  // Chat-banner: the banner-style gallery stays up top (the main thing you tune here).
  if (id === 'chat-banner' && (state.chatBannerThemes || []).length) {
    const themes = state.chatBannerThemes;
    ensureThemeKeyframes(state.chatBannerKeyframes); // register @property/@keyframes so the preview animates

    const styleBox = el('div', 'info-box');
    const sLbl = el('div', 'info-label'); sLbl.textContent = 'Banner style';
    styleBox.append(sLbl);

    // Mock ad banner + mock chat box — the glow's colour AND frame reflect the selection, animated.
    const preview = el('div', 'bp-preview');
    const glow = el('div', 'bp-glow');
    const face = el('div', 'bp-face');
    const txt = el('span', 'bp-text'); txt.textContent = state.activeAdLine || 'Your sponsored line shows here';
    const tmr = el('span', 'bp-timer'); tmr.textContent = '1.2s';
    face.append(txt, tmr);
    const box = el('div', 'bp-box'); const ph = el('span'); ph.textContent = 'Message Claude…'; box.append(ph);
    preview.append(glow, face, box);
    styleBox.append(preview);

    const applyColor = (t) => { glow.style.background = t.background; glow.style.animation = t.animation; };
    const applyFrame = (fid) => {
      glow.classList.remove('f-banner', 'f-full');
      glow.classList.add(fid === 'full' ? 'f-full' : 'f-banner');
      preview.classList.toggle('is-full', fid === 'full');
    };
    const selColor = () => themes.find(t => t.id === state.chatBannerStyle) || themes[0];
    applyColor(selColor());
    applyFrame(state.chatBannerFrame);

    // Frame toggle (Banner vs Full box) — orthogonal to the colour theme.
    const frames = state.chatBannerFrames || [];
    if (frames.length > 1) {
      const frameRow = el('div', 'bp-frame-row');
      for (const f of frames) {
        const b = el('button', 'bp-frame');
        if (state.chatBannerFrame === f.id) b.classList.add('on');
        b.textContent = f.label;
        b.onclick = () => {
          send('set-banner-frame', { frame: f.id });
          state.chatBannerFrame = f.id;
          for (const c of frameRow.children) c.classList.remove('on');
          b.classList.add('on');
          applyFrame(f.id);
        };
        frameRow.append(b);
      }
      styleBox.append(frameRow);
    }

    // Colour gallery
    const row = el('div', 'theme-row');
    for (const t of themes) {
      const chip = el('button', 'theme-chip');
      if (state.chatBannerStyle === t.id) chip.classList.add('on');
      const sw = el('span', 'theme-swatch'); if (t.swatch) sw.style.background = t.swatch;
      const lbl = el('span'); lbl.textContent = t.label;
      chip.append(sw, lbl);
      chip.onmouseenter = () => applyColor(t);           // hover to preview…
      chip.onmouseleave = () => applyColor(selColor());
      chip.onclick = () => {                                 // …click to keep it
        send('set-banner-style', { style: t.id });
        state.chatBannerStyle = t.id;
        for (const c of row.children) c.classList.remove('on');
        chip.classList.add('on');
        applyColor(t);
      };
      row.append(chip);
    }
    styleBox.append(row);
    panel.append(styleBox);
  }

  // Chat-banner: a precise note on what this mode is.
  if (id === 'chat-banner') {
    const whyBox = el('div', 'info-box');
    const whyLbl = el('div', 'info-label'); whyLbl.textContent = 'Why the chat banner';
    const whyP = el('div', 'conflict-text');
    whyP.textContent = "Claude Code's spinner scrolls away with the transcript. The chat banner pins the sponsored line above your input while Claude thinks - a fixed, glanceable ‘still working’ cue that disappears the instant it finishes, so you can scroll back through output and always see when it's done.";
    whyBox.append(whyLbl, whyP);
    panel.append(whyBox);
  }

  // Terminal isn't a VS Code surface (not in vsSurfaces) — synthesize its state so the footer's
  // Enable/Restore logic works. It has no competitor-conflict concept (settings.json preserve/restore
  // handles coexistence).
  const svDetail = id === 'terminal'
    ? { active: !!state.terminalEnabled, comingSoon: false, conflict: false }
    : ((state.vsSurfaces || []).find(s => s.id === id) || {});
  const modFiles = m.files || (m.file ? [{ path: m.file, why: '' }] : null);

  if (modFiles) {
    // Conflict banner — Claude Code has been modified by another extension.
    if (svDetail.conflict) {
      const who = svDetail.conflictVendor ? svDetail.conflictVendor : 'Another extension';
      const box = el('div', 'info-box conflict');
      const clbl = el('div', 'info-label'); clbl.textContent = 'Claude Code is already modified';
      box.append(clbl);
      if (svDetail.canTakeOver) {
        const cp = el('div', 'conflict-text');
        cp.textContent = who + ' has modified Claude Code. Awaitful can restore the genuine original file, verified byte-for-byte against the known-good version, then apply its own. Click below to do that.' + (svDetail.conflictVendor ? ' Afterwards, disable ' + svDetail.conflictVendor + ' so the two do not change the same file.' : '');
        box.append(cp);
      } else {
        const lead = el('div', 'conflict-text');
        lead.textContent = who + ' has changed Claude Code’s files. Disabling it stops further changes but does not undo the ones already saved to disk, so Awaitful leaves the files alone. To restore Claude Code’s originals:';
        const steps = el('ol', 'conflict-steps');
        [
          'Disable ' + who + ' so it stops changing the files. You can leave it installed.',
          'Uninstall Claude Code, then reload this window so its files are fully removed.',
          'Install Claude Code again. This restores its original files.',
          'Open Awaitful settings and enable ' + (m.label || id) + '.',
        ].forEach(t => { const li = el('li'); li.textContent = t; steps.append(li); });
        box.append(lead, steps);
      }
      panel.append(box);
    }

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
      : ['A byte-exact copy is saved before any change', 'Restored when you switch surface, sign out, or uninstall', 'Restore any time with the button below'];
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
  reloadBtn.onclick = () => send('reload-window');
  if (!modFiles) reloadBtn.style.display = 'none';

  const right = el('div', 'detail-footer-r');
  const cancel = el('button', 'btn-ghost'); cancel.textContent = 'Cancel'; cancel.onclick = () => { state._view = 'surfaces'; render(); };

  right.append(cancel);
  if (id === 'terminal' && !svDetail.active) {
    // Terminal enables via its own toggle path (settings.json statusLine), not the webview patch.
    const enableBtn = el('button', 'btn-primary');
    enableBtn.textContent = 'Enable ' + (m.label || id);
    enableBtn.onclick = () => { send('toggle-terminal'); state._view = 'surfaces'; render(); };
    right.append(enableBtn);
  } else if (modFiles && !svDetail.comingSoon && !svDetail.active) {
    // A conflict only offers a take-over when pristine is recoverable from a
    // Awaitful-controlled source; otherwise the guidance above is the path.
    if (svDetail.conflict && !svDetail.canTakeOver) {
      // no primary button — the conflict box tells the user what to do
    } else if (svDetail.conflict) {
      const enableBtn = el('button', 'btn-primary');
      enableBtn.textContent = 'Restore original & enable';
      enableBtn.onclick = () => { send('consent-grant', { id, takeover: true }); state._view = 'surfaces'; render(); };
      right.append(enableBtn);
    } else {
      const enableBtn = el('button', 'btn-primary');
      enableBtn.textContent = 'Enable ' + (m.label || id);
      enableBtn.onclick = () => { send('consent-grant', { id }); state._view = 'surfaces'; render(); };
      right.append(enableBtn);
    }
  }
  const left = el('div', 'detail-footer-l');
  left.append(restoreBtn, reloadBtn);
  footer.append(left, right);
  panel.append(footer);

  return panel;
}

function handleEnable(sv) {
  // File-modifying surfaces always open their detail page — that's where the
  // user reviews exactly what changes and triggers the patch. (Consent may
  // already be granted from a previous session, but the surface still has to be
  // re-applied here, so we must not skip the detail page.)
  if (sv.modifiesFiles) {
    openDetail(sv.id);
  } else {
    send('set-surface', { id: sv.id });
  }
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

function updateHighlight(id) {
  const ids = ['status-bar', 'chat-banner', 'thinking-line', 'terminal'];
  for (const hlId of ids) {
    const el = document.getElementById('hl-' + hlId);
    if (el) el.classList.toggle('on', hlId === id);
  }
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

// ── Message handler ───────────────────────────────────────────────────────────
window.addEventListener('message', e => {
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

