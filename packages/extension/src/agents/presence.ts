import type { AgentId } from '@awaitful/shared';
import type { AgentIntegration } from './types.js';
import { AGENT_INTEGRATIONS } from './registry.js';

/**
 * What Awaitful can actually attach to on this machine, per agent.
 *
 * TWO axes, because the single boolean this replaces was wrong about both things it gated:
 *
 *  - `cli`    — the agent's own install. Gates thinking hooks and the terminal status line, and
 *               therefore gates the STATUS BAR too: that surface earns only because hooks fire.
 *  - `editor` — the agent's VS Code extension, in THIS window. Gates only the surfaces that patch
 *               that extension's webview bundle (thinking-line, chat-banner).
 *
 * The pair is what lets the panel tell a terminal-first developer the truth: their status bar and
 * terminal earn, and the two webview spots are unavailable for a nameable reason.
 *
 * Deliberately vscode-free — the editor lookup is injected by the orchestrator — so detection stays
 * unit-testable under vitest's node environment, the same reason patch/targets.ts takes its
 * extensions root from an env var.
 */
export interface AgentPresence {
  readonly integration: AgentIntegration;
  readonly agent: AgentId;
  readonly label: string;
  readonly cli: boolean;
  readonly editor: boolean;
}

export type EditorExtensionLookup = (extensionId: string) => boolean;

export interface DetectOptions {
  /**
   * Agents already PROVEN present by a thinking hook that has fired on this machine. Positive
   * evidence outranks the filesystem heuristic — never the reverse, since no hook having fired is
   * not proof of no agent. This is the upgrade safety net: someone already earning under an older
   * build can never be switched off by a detector that is wrong about their unusual install.
   */
  readonly provenCli?: readonly AgentId[];
}

/** All-false presence, so the panel can render before the first detection resolves. */
export function initialPresence(): AgentPresence[] {
  return AGENT_INTEGRATIONS.map((integration) => ({
    integration,
    agent: integration.agent,
    label: integration.label,
    cli: false,
    editor: false,
  }));
}

export async function detectAgents(
  isEditorExtensionInstalled: EditorExtensionLookup,
  opts?: DetectOptions,
): Promise<AgentPresence[]> {
  return Promise.all(
    AGENT_INTEGRATIONS.map(async (integration) => {
      // Both axes fail to `false` on a thrown detector. That is the safe direction twice over: we
      // touch no config we cannot justify, and the panel says so honestly instead of pretending.
      let editor = false;
      try {
        editor = integration.editorExtensionId
          ? isEditorExtensionInstalled(integration.editorExtensionId) === true
          : false;
      } catch {
        editor = false;
      }

      // The editor extension implies the CLI — it ships and drives the agent binary. Worst case is
      // a window with the extension and a broken CLI, which is exactly today's behaviour, so it is
      // not a regression.
      const proven = opts?.provenCli?.includes(integration.agent) === true;
      let cli = editor || proven;
      if (!cli) {
        try {
          cli = await integration.detectCli();
        } catch {
          cli = false;
        }
      }

      return { integration, agent: integration.agent, label: integration.label, cli, editor };
    }),
  );
}

/** Agents whose thinking we can detect (hook install). */
export function cliAgents(presence: readonly AgentPresence[]): AgentIntegration[] {
  return presence.filter((p) => p.cli).map((p) => p.integration);
}

/** Agents present here whose terminal status line we can drive. */
export function statusLineAgents(presence: readonly AgentPresence[]): AgentIntegration[] {
  return presence.filter((p) => p.cli && p.integration.supportsStatusLine).map((p) => p.integration);
}

/** False means nothing on this machine can produce a thinking event, so nothing can earn at all. */
export function anyCli(presence: readonly AgentPresence[]): boolean {
  return presence.some((p) => p.cli);
}

/** False means the two webview surfaces have no extension bundle to attach to in this window. */
export function anyEditor(presence: readonly AgentPresence[]): boolean {
  return presence.some((p) => p.editor);
}
