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

/** The present agents whose terminal status line we can drive. */
export async function presentStatusLineAgents(): Promise<AgentIntegration[]> {
  const present = await Promise.all(
    AGENT_INTEGRATIONS.map(async (a) => (a.supportsStatusLine && (await a.isPresent()) ? a : null)),
  );
  return present.filter((a): a is AgentIntegration => a !== null);
}

/** The present agents whose thinking we can detect (for hook install on activation). */
export async function presentAgents(): Promise<AgentIntegration[]> {
  const present = await Promise.all(AGENT_INTEGRATIONS.map(async (a) => ((await a.isPresent()) ? a : null)));
  return present.filter((a): a is AgentIntegration => a !== null);
}
