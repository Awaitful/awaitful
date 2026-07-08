import * as vscode from 'vscode';

// Injected at build time from the API_BASE_URL environment variable.
declare const AWAITFUL_API_BASE_URL: string;

export function apiBaseUrl(): string {
  const override = vscode.workspace.getConfiguration('awaitful').get<string>('apiBaseUrl');
  if (override) return override;
  if (AWAITFUL_API_BASE_URL) return AWAITFUL_API_BASE_URL;
  throw new Error(
    'Awaitful: no server URL configured. Set API_BASE_URL when building, or override via VS Code settings: awaitful.apiBaseUrl',
  );
}
