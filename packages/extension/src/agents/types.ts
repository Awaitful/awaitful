import type { AgentId } from '@awaitful/shared';

/**
 * A coding agent Awaitful integrates with (Claude Code today; Codex, … later). This is the ONLY
 * agent-specific seam for the terminal + thinking surfaces: detection, the loopback host, billing,
 * and the status-line script are all agent-neutral — only *how you register thinking hooks and a
 * status line into a given agent's config* differs. A new agent is a new implementation of this
 * interface plus one registry entry (agents/registry.ts); nothing else changes.
 *
 * Every method must preserve the user's other config, write atomically, and fail safe — these
 * touch the agent's own config files (golden rule 2). Reversibility is required: removeX fully
 * restores the pre-Awaitful state.
 *
 * **Install gates on presence; remove never does.** Every removeX is marker-scoped and guarded on
 * the agent's settings file already existing, so it is always safe to call and always *desirable*
 * to call — that is how entries an older build wrote get cleaned off a machine the agent has since
 * left. Only the installX side asks whether the agent is here.
 */
export interface AgentIntegration {
  readonly agent: AgentId;
  readonly label: string; // human name, e.g. "Claude Code"

  /**
   * Is this agent's OWN install (CLI/config) on this machine? Gates thinking hooks and the status
   * line, and so gates every surface that bills off a thinking event — the status bar included,
   * since it only earns because hooks fire.
   *
   * Must look for evidence the agent itself produced: never a path Awaitful writes, or the
   * extension detects itself. Pure `fs` + `$PATH` — no `vscode` import (agents/* has to stay
   * loadable under vitest's node environment) and no process spawn (nothing may delay activation).
   */
  detectCli(): Promise<boolean>;

  /**
   * The agent's VS Code extension id, when it has one. This is the *second* presence axis: it
   * gates the surfaces that patch that extension's webview bundle, independently of detectCli().
   * A terminal-only agent leaves it undefined. Resolved through a lookup the orchestrator injects
   * (agents/presence.ts), so this file never imports `vscode`.
   */
  readonly editorExtensionId?: string;

  /**
   * Install thinking-detection so this agent's sessions report thinking start/stop/pause to the
   * Awaitful loopback host (the port is read from ~/.awaitful/port at runtime). Idempotent.
   */
  installThinkingHooks(): Promise<void>;
  removeThinkingHooks(): Promise<void>;

  /** Whether this agent exposes a controllable terminal status line. */
  readonly supportsStatusLine: boolean;

  /**
   * Register `scriptPath` (the shared, agent-neutral status-line script) as this agent's status
   * line, preserving the user's existing one. No-op when !supportsStatusLine.
   */
  installStatusLine(scriptPath: string): Promise<void>;
  /** Restore the user's original status line exactly (or remove ours if they had none). */
  removeStatusLine(): Promise<void>;
}
