import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Byte-exact backups of the pristine target, stored in the extension's private
 * global storage — never as a sibling file next to Claude Code (so an uninstall
 * leaves nothing orphaned, and a competitor can't see or clobber our copy).
 *
 * Keyed by buildId + pristine SHA: a Claude Code update changes the build id,
 * naturally invalidating a stale backup instead of risking a wrong restore.
 */
export class BackupStore {
  constructor(private readonly baseDir: string) {}

  private file(buildId: string, sha: string): string {
    // buildId already filesystem-safe (an extension dir name); sha is hex.
    return path.join(this.baseDir, `${buildId}.${sha}.bak`);
  }

  has(buildId: string, sha: string): boolean {
    return fs.existsSync(this.file(buildId, sha));
  }

  /** Persist pristine bytes. Idempotent — re-storing the same key is a no-op-ish overwrite. */
  save(buildId: string, sha: string, bytes: Buffer): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(this.file(buildId, sha), bytes);
  }

  read(buildId: string, sha: string): Buffer | undefined {
    try {
      return fs.readFileSync(this.file(buildId, sha));
    } catch {
      return undefined;
    }
  }

  delete(buildId: string, sha: string): void {
    try {
      fs.unlinkSync(this.file(buildId, sha));
    } catch {
      /* already gone */
    }
  }

  /**
   * Delete backups for builds that are no longer installed, so superseded
   * Claude Code versions don't leak multi-MB pristine copies forever. Keeps
   * every backup whose buildId is in `keepBuildIds`. Never throws.
   */
  pruneExcept(keepBuildIds: Set<string>): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.baseDir);
    } catch {
      return; // storage dir not created yet → nothing to prune
    }
    // Filename shape: `${buildId}.${sha64}.bak`. buildId may contain dots.
    const re = /^(.+)\.[0-9a-f]{64}\.bak$/;
    for (const name of names) {
      const m = re.exec(name);
      if (!m) continue;
      if (keepBuildIds.has(m[1]!)) continue;
      try { fs.unlinkSync(path.join(this.baseDir, name)); } catch { /* ignore */ }
    }
  }
}
