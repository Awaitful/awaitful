import * as fs from 'node:fs';
import * as path from 'node:path';
import { awaitfulDir } from './claudeSettings.js';

/**
 * The terminal status-line script. It is **agent-neutral** — every agent whose status line we
 * drive registers this same script (passing its own agent id as $1); only the per-agent config
 * registration differs (see agents/*). Behaviour:
 *   - talks ONLY to 127.0.0.1 (the Awaitful host) and sends NO content (golden rule 1);
 *   - while the agent is thinking, prints the sponsored line the host returns;
 *   - otherwise, runs the user's PREVIOUS status line (preserved per agent), so their line
 *     keeps working; if they had none, prints nothing;
 *   - fails safe: if the host is unreachable, it degrades to the previous line / nothing.
 * A `-m 1` bounds the curl so a wedged host can never stall the terminal.
 */

const STATUSLINE_REFRESH_SECONDS = 2; // how often Claude Code re-runs the line (min 1s)

export function statusLineScriptPath(): string {
  return path.join(awaitfulDir(), 'statusline.sh');
}

/** Per-agent backup of the user's original status line (for exact restore + idle chaining). */
export function prevJsonPath(agent: string): string {
  return path.join(awaitfulDir(), `${agent}.statusline.prev.json`);
}
export function prevScriptPath(agent: string): string {
  return path.join(awaitfulDir(), `${agent}.statusline.prev.sh`);
}

export { STATUSLINE_REFRESH_SECONDS };

const SCRIPT = `#!/bin/sh
# Awaitful terminal status line — see PRIVACY.md. Talks only to 127.0.0.1 and sends no content;
# it prints a sponsored line while your agent is thinking, else your previous status line.
agent="\${1:-claude-code}"
input=$(cat)
port=$(cat "$HOME/.awaitful/port" 2>/dev/null)
line=""
[ -n "$port" ] && line=$(curl -fsS -m 1 "http://127.0.0.1:$port/surface/terminal" 2>/dev/null)
if [ -n "$line" ]; then
  printf '%s' "$line"
else
  prev="$HOME/.awaitful/$agent.statusline.prev.sh"
  [ -f "$prev" ] && printf '%s' "$input" | sh "$prev"
fi
`;

export async function writeStatusLineScript(): Promise<void> {
  const target = statusLineScriptPath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, SCRIPT, { encoding: 'utf8', mode: 0o755 });
}

export async function removeStatusLineScript(): Promise<void> {
  await fs.promises.rm(statusLineScriptPath(), { force: true });
}
