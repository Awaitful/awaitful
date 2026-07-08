import * as vscode from 'vscode';
import type { StatusBarState } from '@awaitful/shared';

export class StatusBarUI {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      1000, // High priority keeps it visible before other items collapse.
    );
    this.item.command = 'awaitful.menu';
    this.setState('signin');
    this.item.show();
  }

  setState(state: StatusBarState, earning?: { amount?: string; tooltip?: string }): void {
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
  showAd(line: string, hasUrl = false): void {
    this.item.text = `$(circle-filled)${line}`;
    this.item.tooltip = hasUrl
      ? 'Sponsored · click to visit - Awaitful is earning'
      : 'Sponsored · Awaitful is earning';
    this.item.backgroundColor = undefined;
    this.item.command = hasUrl ? 'awaitful.visitAd' : 'awaitful.menu';
  }

  dispose(): void {
    this.item.dispose();
  }
}
