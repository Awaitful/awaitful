import * as vscode from 'vscode';
import type { StatusBarState } from '@awaitful/shared';
import { getSpinner, frameAt } from './spinners.js';

export class StatusBarUI {
  private readonly item: vscode.StatusBarItem;
  /** The ad currently on the bar, kept so a spinner tick (or a setting change) can re-render it. */
  private ad: { line: string; hasUrl: boolean; unpaid: boolean } | undefined;
  private spinTimer: ReturnType<typeof setInterval> | undefined;
  private readonly configSub: vscode.Disposable;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      1000, // High priority keeps it visible before other items collapse.
    );
    this.item.command = 'awaitful.menu';
    this.setState('signin');
    this.item.show();
    // The picker previews live: changing the setting while an ad is on the bar re-renders it.
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('awaitful.adSpinner') && this.ad) {
        this.showAd(this.ad.line, this.ad.hasUrl, this.ad.unpaid);
      }
    });
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
      case 'incompatible':
        this.item.text = '$(error) Awaitful';
        this.item.tooltip = 'Awaitful is incompatible with this environment';
        this.item.backgroundColor = undefined;
        break;
      case 'reload-to-earn':
        this.item.text = '$(warning) Reload to activate';
        this.item.tooltip = 'Click to reload the window and activate the Awaitful surface';
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

    const spinner = getSpinner(vscode.workspace.getConfiguration('awaitful').get<string>('adSpinner'));
    if (spinner.frames.length === 0) {
      // Spinner "none": the static dot stays, so a sponsored line is still visibly marked.
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
    this.configSub.dispose();
    this.item.dispose();
  }
}
