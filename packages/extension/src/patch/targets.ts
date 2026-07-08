import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// os.homedir() ignores $HOME on macOS; prefer $HOME so tests can override the
// install root. Mirrors the idiom in src/hooks/setup.ts.
function homedir(): string {
  return process.env['HOME'] ?? os.homedir();
}

/** Where VS Code keeps installed extensions. Overridable for tests. */
export function extensionsRoot(): string {
  return process.env['AWAITFUL_VSCODE_EXT_DIR'] ?? path.join(homedir(), '.vscode', 'extensions');
}

export interface ClaudeTarget {
  /** Absolute path to the extension directory. */
  dir: string;
  /** Version string parsed from the directory name, e.g. "2.1.199". */
  version: string;
  /** Stable identity for recipe/backup keying (the directory basename). */
  buildId: string;
  /** Absolute path to the patch target (Claude Code webview bundle). */
  webviewFile: string;
}

const DIR_RE = /^anthropic\.claude-code-(\d+\.\d+\.\d+)(?:-.*)?$/;

/** Compare two dotted version strings numerically; positive if a > b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** Build a ClaudeTarget from a specific extension directory, or undefined. */
function targetFromDir(dir: string): ClaudeTarget | undefined {
  const name = path.basename(dir);
  const m = DIR_RE.exec(name);
  if (!m) return undefined;
  const webviewFile = path.join(dir, 'webview', 'index.js');
  if (!fs.existsSync(webviewFile)) return undefined;
  return { dir, version: m[1]!, buildId: name, webviewFile };
}

/**
 * Resolve the Claude Code build to patch. Prefers `activeDir` — the path VS Code
 * reports for the *running* Claude Code extension — so with several builds
 * installed we never patch one that isn't the active one. Falls back to the
 * highest installed version. Returns undefined if none qualifies. Never throws.
 */
export function findClaudeTarget(activeDir?: string): ClaudeTarget | undefined {
  // 1. The build VS Code is actually running, when we know it.
  if (activeDir) {
    const t = targetFromDir(activeDir);
    if (t) return t;
  }

  // 2. Fallback: the highest-versioned installed build.
  const root = extensionsRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }

  const candidates: ClaudeTarget[] = [];
  for (const name of entries) {
    const t = targetFromDir(path.join(root, name));
    if (t) candidates.push(t);
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => cmpVersion(b.version, a.version));
  return candidates[0];
}
