import * as vscode from 'vscode';
import { getSpinner, frameAt, type StatusBarState, type AdSpinner } from '@awaitful/shared';
import { reduceMotion } from '../lib/config.js';

export class StatusBarUI {
  private readonly item: vscode.StatusBarItem;
  /** The ad currently on the bar, kept so a spinner tick (or a setting change) can re-render it. */
  private ad: { line: string; hasUrl: boolean; unpaid: boolean } | undefined;
  private spinTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * `spinnerFor` is injected rather than read here: the spinner is a per-format choice now, and a UI
   * component reaching for a global setting is exactly how it stayed global. The default keeps this
   * constructible in isolation (tests) without knowing about formats.
   */
  constructor(private readonly spinnerFor: () => AdSpinner = () => getSpinner(undefined)) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      1000, // High priority keeps it visible before other items collapse.
    );
    this.item.command = 'awaitful.menu';
    this.setState('signin');
    this.item.show();
  }

  /**
   * Redraw the ad currently on the bar with whatever the status-bar format now looks like, so a pick
   * on its page previews in place. A no-op when nothing is showing.
   *
   * Called by the orchestrator rather than watched for here: this used to subscribe to a VS Code
   * setting directly, which stopped being the source of truth the moment the spinner became a
   * per-format choice - and a UI component watching its own settings is how it stayed global.
   */
  refreshAd(): void {
    if (this.ad) this.showAd(this.ad.line, this.ad.hasUrl, this.ad.unpaid);
  }

  setState(state: StatusBarState, earning?: { amount?: string; tooltip?: string }): void {
    // Leaving the ad state stops the spinner: it must never tick while nothing is sponsored.
    this.stopSpinner();
    // Reset to the standard menu command; showAd() overrides this while an ad is live.
    this.item.command = 'awaitful.menu';

    switch (state) {
      case 'signin':
        this.item.text = '$(key) Awaitful';
        this.item.tooltip = 'Awaitful - click to sign in and start earning';
        this.item.backgroundColor = undefined;
        break;
      case 'earning': {
        // Compact: no space between the icon and the label (the codicon keeps its own margin).
        // `amount` (e.g. "$1.23") is appended only when earnings are meaningful and not hidden.
        const amt = earning?.amount ? ' ' + earning.amount : '';
        this.item.text = '$(circle-filled)Awaitful' + amt;
        this.item.tooltip = earning?.tooltip ?? 'Awaitful is active - click to manage';
        this.item.backgroundColor = undefined;
        break;
      }
      case 'off':
        this.item.text = '$(circle-outline) Paused';
        this.item.tooltip = 'Awaitful is paused - click to resume';
        this.item.backgroundColor = undefined;
        break;
      case 'killed':
        this.item.text = '$(warning) Awaitful';
        this.item.tooltip = 'Awaitful is paused server-side';
        this.item.backgroundColor = undefined;
        break;
      case 'offline':
        this.item.text = '$(cloud-offline) Awaitful';
        this.item.tooltip = 'Awaitful cannot reach the server - will retry';
        this.item.backgroundColor = undefined;
        break;
      case 'no-agent':
        // Not an error and not a warning background: a developer who simply does not use Claude
        // Code must not get a permanently yellow status bar. Calm, distinct from earning
        // ($(circle-filled)) and paused ($(circle-outline)), and the click lands on the panel where
        // the full explanation and the setup link live.
        this.item.text = '$(circle-slash) Awaitful';
        this.item.tooltip = 'No agent found - Awaitful earns while Claude Code thinks. Click to set it up.';
        this.item.backgroundColor = undefined;
        break;
      case 'reload-to-earn':
        this.item.text = '$(warning) Reload to activate';
        this.item.tooltip = 'Click to reload the window and activate your Awaitful ad format';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.command = 'awaitful.reload';
        break;
    }
  }

  /**
   * Show the active ad creative in the status bar.
   * Clicking the item while an ad is showing sends 'awaitful.visitAd' so the
   * click can be billed and the sponsor URL opened.
   */
  showAd(line: string, hasUrl = false, unpaid = false): void {
    this.stopSpinner();
    this.ad = { line, hasUrl, unpaid };
    // The zero-bid house fallback bills nobody and pays nothing, and this tooltip is where the
    // status bar says so instead of claiming earnings that are not happening.
    this.item.tooltip = unpaid
      ? 'House message - nothing is bidding right now. It bills nobody and pays nothing.'
      : hasUrl
        ? 'Sponsored · click to visit - Awaitful is earning'
        : 'Sponsored · Awaitful is earning';
    this.item.backgroundColor = undefined;
    this.item.command = hasUrl ? 'awaitful.visitAd' : 'awaitful.menu';

    const spinner = this.spinnerFor();
    // Spinner "none", or a developer who asked for less motion. Both land on the same static dot, so
    // the line stays visibly marked as sponsored either way - reduced motion removes the animation,
    // never the disclosure. This is the one surface with no CSS to carry a media query, so the check
    // has to happen here, before the timer starts rather than inside it.
    if (spinner.frames.length === 0 || reduceMotion()) {
      this.item.text = `$(circle-filled)${line}`;
      return;
    }
    // Wall-clock frames keep the bar in step with the webview and terminal surfaces. The timer
    // exists only while an ad is on the bar, which is only while the agent is thinking - so the
    // idle cost of the animation is exactly zero.
    const render = () => {
      this.item.text = `${frameAt(spinner, Date.now())} ${line}`;
    };
    render();
    this.spinTimer = setInterval(render, spinner.intervalMs);
  }

  private stopSpinner(): void {
    this.ad = undefined;
    if (this.spinTimer !== undefined) {
      clearInterval(this.spinTimer);
      this.spinTimer = undefined;
    }
  }

  dispose(): void {
    this.stopSpinner();
    this.item.dispose();
  }
}
