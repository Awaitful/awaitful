import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentIntegration } from './types.js';
import { findOnPath, systemBinDirs } from './binary.js';
import { awaitfulDir, claudeSettingsExists, homedir, readClaudeSettings, writeClaudeSettings } from '../hooks/claudeSettings.js';
import { registerClaudeHooks, removeClaudeHooks } from '../hooks/setup.js';
import { STATUSLINE_REFRESH_SECONDS, statusLineScriptPath, prevJsonPath, prevScriptPath } from '../hooks/statusLineScript.js';

const AGENT = 'claude-code';

/** Claude Code's config dir, honouring CLAUDE_CONFIG_DIR the way Claude Code itself does so a
 *  relocated config is never read as "not installed". */
function claudeHome(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? path.join(homedir(), '.claude');
}

/**
 * Entries that ONLY Claude Code writes, inside its config dir.
 *
 * This list deliberately EXCLUDES `~/.claude/` itself and `~/.claude/settings.json`: Awaitful
 * creates both (writeClaudeSettings does a mkdir -p), so trusting either would make the extension
 * detect *itself* on a machine where Claude Code was never installed — which is the exact bug this
 * detection exists to fix.
 */
const CLI_MARKERS = ['projects', 'statsig', 'history.jsonl', 'todos', 'ide', 'shell-snapshots'] as const;

/** Install locations that do not always export their directory onto $PATH. */
function extraBinDirs(): string[] {
  return [
    path.join(claudeHome(), 'local'), // `claude migrate-installer` local install
    path.join(homedir(), '.local', 'bin'), // native installer
    path.join(homedir(), 'bin'),
    ...systemBinDirs(),
  ];
}

type StatusLineEntry = { type?: string; command?: string; [k: string]: unknown };

// POSIX single-quote a path so spaces/special chars survive the shell `command` string.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** True when the settings' statusLine is the one WE installed (its command runs our script). */
function isOurs(entry: unknown, scriptPath: string): entry is StatusLineEntry {
  if (!entry || typeof entry !== 'object') return false;
  const cmd = (entry as StatusLineEntry).command;
  return typeof cmd === 'string' && cmd.includes(scriptPath);
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
  editorExtensionId: 'anthropic.claude-code',

  // Evidence that Claude Code ITSELF has run or is installed here — never a path Awaitful creates.
  // Ordered cheapest-and-most-definitive first; ~8 existsSync calls plus a $PATH walk, cached by
  // the caller. See CLI_MARKERS for why ~/.claude and its settings.json are not evidence.
  detectCli(): Promise<boolean> {
    // 1. The state file Claude Code writes on first run. It lives OUTSIDE the directory we create,
    //    so its presence can never be our own doing.
    if (fs.existsSync(path.join(homedir(), '.claude.json'))) return Promise.resolve(true);
    // 2. Anything inside the config dir that only Claude Code writes.
    const dir = claudeHome();
    if (CLI_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return Promise.resolve(true);
    // 3. The binary itself, found without spawning it.
    return Promise.resolve(findOnPath('claude', extraBinDirs()) !== undefined);
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
    // Same rule as removeClaudeHooks: a remove must never be the write that creates ~/.claude.
    // Our own backups still get cleaned up below — they live under ~/.awaitful, which is ours.
    if (!claudeSettingsExists()) {
      await fs.promises.rm(prevJsonPath(AGENT), { force: true });
      await fs.promises.rm(prevScriptPath(AGENT), { force: true });
      return;
    }
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
