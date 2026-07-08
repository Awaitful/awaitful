import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// os.homedir() on macOS reads from the system passwd database and ignores $HOME, which breaks
// tests that override process.env.HOME. Using $HOME first makes the paths overridable in tests
// and is consistent with how shells resolve ~.
export function homedir(): string {
  return process.env['HOME'] ?? os.homedir();
}

export function awaitfulDir(): string {
  return path.join(homedir(), '.awaitful');
}

export function claudeSettingsPath(): string {
  return path.join(homedir(), '.claude', 'settings.json');
}

export type ClaudeSettings = { hooks?: unknown; statusLine?: unknown; [key: string]: unknown };

/** Read ~/.claude/settings.json, or `{}` if missing/unparseable (never throws). */
export async function readClaudeSettings(): Promise<ClaudeSettings> {
  try {
    const raw = await fs.promises.readFile(claudeSettingsPath(), 'utf8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return {};
  }
}

/**
 * Write ~/.claude/settings.json atomically (temp file + rename) so a crash mid-write can never
 * leave the user with a truncated, unparseable settings file — the editor-safety bar (golden
 * rule 2) applied to the file we merge into.
 */
export async function writeClaudeSettings(settings: ClaudeSettings): Promise<void> {
  const target = claudeSettingsPath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.awaitful-${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await fs.promises.rename(tmp, target);
}
