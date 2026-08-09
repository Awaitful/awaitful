import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Find an executable without running it. Used by agent presence detection, which runs on the
 * activation path — so this must be cheap, must never throw, and must never spawn: a wedged shell
 * out to `which`/`where` would delay activation, and golden rule 2 says the editor comes first.
 *
 * `fs.existsSync` rather than an X_OK check on purpose. A file named `claude` sitting on $PATH is
 * evidence enough, and the false-positive direction (we think it's there when it isn't) is the one
 * we can afford: it only means we install hooks that never fire, which is exactly the pre-existing
 * behaviour. The false-negative direction is corrected the moment a thinking hook proves the agent.
 */
/**
 * System-wide install dirs, searched in addition to $PATH because a GUI-launched VS Code on macOS
 * does not inherit the login shell's PATH — it gets a minimal one, so a Homebrew or /usr/local
 * install would be invisible to a PATH-only scan and we would wrongly report "no agent".
 *
 * Overridable so tests can exclude the *real* machine's install from a negative assertion. Mirrors
 * AWAITFUL_VSCODE_EXT_DIR in patch/targets.ts.
 */
export function systemBinDirs(): string[] {
  const override = process.env['AWAITFUL_SYSTEM_BIN_DIRS'];
  if (override !== undefined) return override.split(path.delimiter).filter(Boolean);
  return ['/usr/local/bin', '/opt/homebrew/bin'];
}

export function findOnPath(name: string, extraDirs: readonly string[] = []): string | undefined {
  try {
    // Windows resolves a bare command name against PATHEXT; the three that matter for a CLI shipped
    // via npm/native installer are .cmd (npm shim), .exe (native), and the extension-less script.
    const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
    const dirs = [...(process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean), ...extraDirs];
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, name + suffix);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
