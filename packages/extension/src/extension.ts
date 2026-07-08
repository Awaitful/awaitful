import type * as vscode from 'vscode';
import { Orchestrator } from './core/orchestrator.js';

let orchestrator: Orchestrator | undefined;

export function activate(context: vscode.ExtensionContext): void {
  orchestrator = new Orchestrator(context);
  // Never let activation crash VS Code — degrade silently.
  orchestrator.start().catch((err: unknown) => {
    console.error('[Awaitful] Startup error:', err);
  });
}

export function deactivate(): void {
  orchestrator?.stop();
}
