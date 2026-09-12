import * as vscode from 'vscode';
import type { PlatformId } from '@awaitful/shared';

// Injected at build time from the API_BASE_URL environment variable.
declare const AWAITFUL_API_BASE_URL: string;

/**
 * Which client this build is, on the platform axis.
 *
 * `vscode` is the whole family, not the app: this same build runs in Cursor, Devin, VSCodium and VS
 * Code Insiders, and one platform switch covers all of them. The distinction that matters to the
 * server is which BINARY is reporting - the thing that can be released, capped, or killed - and by
 * that measure they are one client.
 *
 * Stated by the client rather than inferred, so it matches what the Mac app has always sent. The
 * server does backfill an absent platform to `vscode` (routes/v1/events.ts), which is a fact about
 * builds published before the field existed rather than a guess - but a client that says what it is
 * needs no backfill, and "the server infers it for one client and not the other" is exactly the kind
 * of asymmetry that makes behaviour hard to predict.
 */
export const CLIENT_PLATFORM: PlatformId = 'vscode';

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
