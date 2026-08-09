import type { AgentId } from '@awaitful/shared';
import type { AgentIntegration } from './types.js';
import { claudeCodeAgent } from './claudeCode.js';

/**
 * Every agent Awaitful integrates with. Add a new agent by implementing AgentIntegration and
 * appending it here — the orchestrator, host, billing, and status-line script are agent-neutral
 * and need no change.
 */
export const AGENT_INTEGRATIONS: readonly AgentIntegration[] = [claudeCodeAgent];

export function agentIntegration(id: AgentId): AgentIntegration | undefined {
  return AGENT_INTEGRATIONS.find((a) => a.agent === id);
}

/**
 * The agent a fired thinking hook can only have come from. Exactly one agent ships, so a hook that
 * fired proves THAT agent — an exact attribution, not a guess. Feeds `detectAgents({ provenCli })`
 * so someone who is already earning can never be switched off by a detector that got it wrong.
 *
 * The length check makes this self-disable the day a second agent lands, which forces the correct
 * fix (hooks posting their own agent id, hooks/setup.ts) instead of silently mis-attributing.
 */
export const HOOK_PROVEN_AGENTS: readonly AgentId[] =
  AGENT_INTEGRATIONS.length === 1 ? [AGENT_INTEGRATIONS[0]!.agent] : [];
