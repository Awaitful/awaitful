import * as fs from 'node:fs';
import type { AgentIntegration } from './types.js';
import { awaitfulDir, readClaudeSettings, writeClaudeSettings } from '../hooks/claudeSettings.js';
import { registerClaudeHooks, removeClaudeHooks } from '../hooks/setup.js';
import { STATUSLINE_REFRESH_SECONDS, statusLineScriptPath, prevJsonPath, prevScriptPath } from '../hooks/statusLineScript.js';

const AGENT = 'claude-code';

type StatusLineEntry = { type?: string; command?: string; [k: string]: unknown };

// POSIX single-quote a path so spaces/special chars survive the shell `command` string.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Also recognize the pre-rename script path for one release, so an upgrade can restore/clean a
// status line the old "CodeCue" build installed (which pointed at ~/.codecue/statusline.sh).
const LEGACY_SCRIPT_PATH = '.codecue/statusline.sh';

/** True when the settings' statusLine is the one WE installed (its command runs our script). */
function isOurs(entry: unknown, scriptPath: string): entry is StatusLineEntry {
  if (!entry || typeof entry !== 'object') return false;
  const cmd = (entry as StatusLineEntry).command;
  return typeof cmd === 'string' && (cmd.includes(scriptPath) || cmd.includes(LEGACY_SCRIPT_PATH));
}

/**
 * Claude Code integration. Thinking hooks reuse hooks/setup.ts (already installed for the webview
 * surfaces too); the status line is registered in ~/.claude/settings.json, preserving + restoring
 * the user's existing one (only one status line can be active).
 */
export const claudeCodeAgent: AgentIntegration = {
  agent: AGENT,
  label: 'Claude Code',
  supportsStatusLine: true,

  // Claude Code is the primary target; its config dir is created on demand. Future agents check
  // their own binary/config here so we never touch config for an agent that isn't installed.
  isPresent() {
    return Promise.resolve(true);
  },

  installThinkingHooks() {
    return registerClaudeHooks();
  },
  removeThinkingHooks() {
    return removeClaudeHooks();
  },

  async installStatusLine(scriptPath: string): Promise<void> {
    await fs.promises.mkdir(awaitfulDir(), { recursive: true }); // backups live here
    const settings = await readClaudeSettings();
    const existing = settings.statusLine;

    // Preserve the user's original the FIRST time we take over — never overwrite a saved backup.
    if (existing && !isOurs(existing, scriptPath) && !fs.existsSync(prevJsonPath(AGENT))) {
      await fs.promises.writeFile(prevJsonPath(AGENT), JSON.stringify(existing, null, 2), 'utf8');
      const cmd = (existing as StatusLineEntry).command;
      if (typeof cmd === 'string') {
        // A tiny wrapper our shared script chains to when idle, so their line still renders.
        await fs.promises.writeFile(prevScriptPath(AGENT), `#!/bin/sh\n${cmd}\n`, { encoding: 'utf8', mode: 0o755 });
      }
    }

    settings.statusLine = {
      type: 'command',
      command: `sh ${shQuote(scriptPath)} ${AGENT}`,
      refreshInterval: STATUSLINE_REFRESH_SECONDS,
    };
    await writeClaudeSettings(settings);
  },

  async removeStatusLine(): Promise<void> {
    const settings = await readClaudeSettings();
    // Only touch the status line if it's still ours (the user may have changed it since).
    if (isOurs(settings.statusLine, statusLineScriptPath())) {
      const backup = await readPrevStatusLine();
      if (backup) settings.statusLine = backup;
      else delete settings.statusLine;
      await writeClaudeSettings(settings);
    }
    await fs.promises.rm(prevJsonPath(AGENT), { force: true });
    await fs.promises.rm(prevScriptPath(AGENT), { force: true });
  },
};

async function readPrevStatusLine(): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.promises.readFile(prevJsonPath(AGENT), 'utf8'));
  } catch {
    return null;
  }
}
