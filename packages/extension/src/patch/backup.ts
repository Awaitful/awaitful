import * as fs from 'node:fs';
import * as path from 'node:path';
import { foreignMarkerToken } from './foreign.js';
import { MARKER_PREFIX } from './recipe.js';

/**
 * Backups per build. Two targets means two in normal operation; anything approaching this cap means
 * something upstream is deriving a new "pristine" repeatedly, which is what a patch war looks like
 * (one field machine accumulated 49 backups / 233 MB this way). Generous on purpose: the cap is a
 * backstop against runaway growth, never part of normal operation.
 */
const MAX_PER_BUILD = 8;

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

  /**
   * Persist pristine bytes. Idempotent — re-storing the same key is a no-op-ish overwrite.
   *
   * Refuses content carrying another patch tool's marker. Callers already hash-gate against the
   * recipe's `pristineSha256`, but that gate cannot help when the RECIPE ITSELF was self-derived
   * from contaminated content: the hash matches because it is the hash of the contamination. This
   * is the independent check, and it is the one that would have stopped 233 MB of competitor-laden
   * "originals" from being stored on a real machine. A backup is a promise about what the editor
   * looked like before we touched it, so a wrong one is worse than none.
   */
  save(buildId: string, sha: string, bytes: Buffer): boolean {
    const text = bytes.toString('utf8');
    // Any patch marker at all disqualifies it, ours included. `foreignMarkerToken` deliberately
    // skips AWAITFUL so we never attribute our own work to a competitor, which means our own block
    // would otherwise sail straight through - and a "pristine" containing our own patch is not
    // pristine. Callers must treat a refusal as "no pristine" and decline to write the target.
    if (foreignMarkerToken(text) !== undefined || text.includes(MARKER_PREFIX)) return false;
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(this.file(buildId, sha), bytes);
    this.capBuild(buildId, sha);
    return true;
  }

  /**
   * One-time cleanup of backups that carry a patch marker - ours or anyone's. These are the
   * residue of deriving "pristine" from contaminated bytes before `save()` validated anything;
   * one field machine held 49 of them totalling 233 MB.
   *
   * Marker-based only, never anchor-based: an anchor test is per-target, and running the
   * extension.js anchor across the whole store would delete a perfectly good webview pristine that
   * simply does not contain it. Never deletes on a read error, and never removes the last backup
   * for `activeBuildId` unless that file is itself provably contaminated.
   */
  purgeContaminated(activeBuildId?: string): number {
    let names: string[];
    try { names = fs.readdirSync(this.baseDir); } catch { return 0; }
    const re = /^(.+)\.([0-9a-f]{64})\.bak$/;
    const mine = names.filter((n) => re.test(n));
    const contaminated: string[] = [];
    for (const name of mine) {
      let text: string;
      try { text = fs.readFileSync(path.join(this.baseDir, name), 'utf8'); } catch { continue; }
      if (foreignMarkerToken(text) !== undefined || text.includes(MARKER_PREFIX)) contaminated.push(name);
    }
    let removed = 0;
    for (const name of contaminated) {
      const build = re.exec(name)?.[1];
      // Refuse to leave the active build with nothing, unless everything it has is contaminated
      // anyway (in which case none of it was ever a usable original).
      if (build && build === activeBuildId) {
        const forBuild = mine.filter((n) => re.exec(n)?.[1] === build);
        const cleanRemaining = forBuild.filter((n) => !contaminated.includes(n));
        if (cleanRemaining.length === 0 && forBuild.length === contaminated.length) {
          // every backup for the active build is contaminated: they are all worthless, delete on.
        } else if (cleanRemaining.length === 0) {
          continue;
        }
      }
      try { fs.unlinkSync(path.join(this.baseDir, name)); removed++; } catch { /* ignore */ }
    }
    return removed;
  }

  /**
   * Keep at most MAX_PER_BUILD backups for a build, evicting oldest-first and never the one just
   * written. Unreachable in normal operation (two targets, two backups); this only fires if
   * something is churning derivations, and bounded disk beats an unbounded leak.
   */
  private capBuild(buildId: string, keepSha: string): void {
    let names: string[];
    try { names = fs.readdirSync(this.baseDir); } catch { return; }
    const re = /^(.+)\.([0-9a-f]{64})\.bak$/;
    const mine: { name: string; mtimeMs: number }[] = [];
    for (const name of names) {
      const m = re.exec(name);
      if (!m || m[1] !== buildId || m[2] === keepSha) continue;
      try { mine.push({ name, mtimeMs: fs.statSync(path.join(this.baseDir, name)).mtimeMs }); } catch { /* raced */ }
    }
    if (mine.length + 1 <= MAX_PER_BUILD) return;
    mine.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { name } of mine.slice(0, mine.length + 1 - MAX_PER_BUILD)) {
      try { fs.unlinkSync(path.join(this.baseDir, name)); } catch { /* ignore */ }
    }
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
    // An empty keep-set means the caller found no Claude Code install at all. That is far more
    // often a wrong extensions root or a transient mid-update read than a licence to delete
    // irreplaceable megabytes - and deleting here would strand a second editor that is actively
    // patching the very build we could not see.
    if (keepBuildIds.size === 0) return;
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
