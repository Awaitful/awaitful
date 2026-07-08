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
 */
export interface AgentIntegration {
  readonly agent: AgentId;
  readonly label: string; // human name, e.g. "Claude Code"

  /** Does this agent look usable/configurable on this machine? Gates whether we touch its config. */
  isPresent(): Promise<boolean>;

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
