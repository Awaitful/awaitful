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

/** The VS Code setting this reads, so a config-change listener can match it without repeating it. */
export const REDUCE_MOTION_SETTING = 'workbench.reduceMotion';

/**
 * Whether the developer has asked for less motion.
 *
 * `workbench.reduceMotion` is `on | off | auto`, and `auto` means "follow the OS". The extension HOST
 * cannot resolve `auto`: it is plain Node with no DOM, so no `matchMedia`, and VS Code exposes only the
 * raw setting rather than what it resolved to. So only an explicit `on` counts here.
 *
 * That is narrower than it looks. The two surfaces that CAN see the OS query already honour it through
 * their own CSS - the panel webview and the shim inside Claude Code both carry
 * `@media (prefers-reduced-motion:reduce)`. This function exists for the one surface that has no CSS at
 * all, the status bar, where the animation is a `setInterval` we own outright.
 */
export function reduceMotion(): boolean {
  return vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion') === 'on';
}
