import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './hash.js';
import { findClaudeTarget, extensionsRoot, type ClaudeTarget } from './targets.js';
import { findRecipe as defaultFindRecipe, MARKER_PREFIX, type PatchRecipe, type RecipeTarget } from './recipe.js';
import { detectForeign, type ForeignDetection } from './foreign.js';
import type { BackupStore } from './backup.js';

/** Resolve a recipe for a build id. Injectable so tests can supply fixtures. */
export type RecipeLookup = (buildId: string) => PatchRecipe | undefined;

export type PatchState =
  | 'no-target'         // no Claude Code installed → stay in status-bar mode
  | 'unknown-build'     // installed, but no embedded recipe for this build
  | 'clean-pristine'    // every target matches its known-good hash → safe to patch
  | 'our-patch-present' // every target already carries our CURRENT patch → idempotent
  | 'our-patch-stale'   // our patch is present but an older shim version → re-apply
  | 'modified';         // some target differs from pristine and is not ours → do not trust

export interface Assessment {
  state: PatchState;
  target?: ClaudeTarget;
  recipe?: PatchRecipe;
  foreign?: ForeignDetection;
  /** For `modified`: can a take-over recover pristine from Awaitful-controlled sources? */
  recoverable?: boolean;
}

export type ApplyResult =
  | { ok: true; reloadNeeded: boolean; tookOver?: string | undefined }
  | {
      ok: false;
      reason: 'no-target' | 'unknown-build' | 'blocked' | 'no-pristine' | 'health-failed' | 'error';
      foreignVendor?: string | undefined;
    };

const TMP_SUFFIX = '.awaitful-tmp';
type TargetState = 'pristine' | 'ours' | 'ours-stale' | 'modified';

/**
 * The thinking-line patch engine. It safely modifies one or more Claude Code
 * files (the webview shim + a surgical CSP relaxation). Every path is fail-safe:
 * on any doubt it declines or auto-restores rather than risk the editor, and it
 * never treats a file modified by another extension or an unknown build as the
 * original. Multi-target changes are applied both-or-neither: if any target's
 * health probe fails, every target is restored.
 */
export class PatchEngine {
  constructor(
    private readonly backups: BackupStore,
    private readonly lookupRecipe: RecipeLookup = defaultFindRecipe,
    /** Path VS Code reports for the *running* Claude Code extension, if known. */
    private readonly getActiveDir: () => string | undefined = () => undefined,
  ) {}

  private target(): ClaudeTarget | undefined {
    return findClaudeTarget(this.getActiveDir());
  }

  /** Drop backups for Claude Code builds that are no longer installed. */
  pruneStaleBackups(): void {
    const keep = new Set<string>();
    try {
      for (const name of fs.readdirSync(extensionsRoot())) {
        if (name.startsWith('anthropic.claude-code-')) keep.add(name);
      }
    } catch {
      return;
    }
    this.backups.pruneExcept(keep);
  }

  // ── Assessment ────────────────────────────────────────────────────────────

  assess(): Assessment {
    const target = this.target();
    if (!target) return { state: 'no-target' };

    const recipe = this.lookupRecipe(target.buildId);
    if (!recipe) return { state: 'unknown-build', target };

    let anyModified = false, anyStale = false, allOurs = true;
    let foreign: ForeignDetection | undefined;

    for (const t of recipe.targets) {
      const abs = this.absFile(target, t);
      let content: string | undefined;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { content = undefined; }
      const st = this.classify(content, t);
      if (st !== 'ours') allOurs = false;
      if (st === 'ours-stale') anyStale = true;
      if (st === 'modified') {
        anyModified = true;
        // Surface the first modifier we can attribute — passing the content lets it read
        // the tool's own in-file marker (a name) even when it left no sibling backup.
        const f = detectForeign(abs, content);
        if (!foreign || (!foreign.vendor && f.vendor)) foreign = f;
      }
    }

    if (anyModified) {
      return {
        state: 'modified', target, recipe,
        foreign: foreign ?? { present: false },
        recoverable: this.canRecover(target, recipe),
      };
    }
    // Our patch present but an older shim version → re-apply the current one.
    if (anyStale) return { state: 'our-patch-stale', target, recipe };
    if (allOurs) return { state: 'our-patch-present', target, recipe };
    // All pristine, or a mix of pristine + ours (one target reverted): apply completes it.
    return { state: 'clean-pristine', target, recipe };
  }

  private classify(content: string | undefined, t: RecipeTarget): TargetState {
    if (content === undefined) return 'modified'; // unreadable → cannot verify → untrusted
    if (isCurrentPatch(content, t)) return 'ours';
    if (hasOurPatch(content, t)) return 'ours-stale'; // our marker, but a different version
    if (sha256(content) === t.pristineSha256) return 'pristine';
    return 'modified';
  }

  private absFile(target: ClaudeTarget, t: RecipeTarget): string {
    return path.join(target.dir, t.file);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  apply(consentTakeover = false): ApplyResult {
    const a = this.assess();
    const { target, recipe } = a;

    if (a.state === 'no-target') return { ok: false, reason: 'no-target' };
    if (a.state === 'unknown-build') return { ok: false, reason: 'unknown-build' };
    if (a.state === 'our-patch-present') {
      this.ensureBackups(target!, recipe!);
      return { ok: true, reloadNeeded: false };
    }
    if (a.state === 'modified' && !consentTakeover) {
      return { ok: false, reason: 'blocked', foreignVendor: a.foreign?.vendor };
    }

    // clean-pristine, our-patch-stale, or modified + consent: resolve verified
    // pristine for every target not already on the CURRENT patch, then apply all
    // -or-nothing. (A stale target's pristine comes from stripping its old shim.)
    const pristineByFile = new Map<string, Buffer>();
    for (const t of recipe!.targets) {
      const abs = this.absFile(target!, t);
      const cur = readOrUndefined(abs);
      if (cur && isCurrentPatch(cur.toString('utf8'), t)) continue; // current; skip
      const pristine = this.obtainPristine(abs, t);
      if (!pristine) return { ok: false, reason: 'no-pristine', foreignVendor: a.foreign?.vendor };
      pristineByFile.set(t.file, pristine);
    }

    const res = this.applyAll(target!, recipe!, pristineByFile);
    if (res.ok && a.state === 'modified' && a.foreign?.vendor) return { ...res, tookOver: a.foreign.vendor };
    return res;
  }

  /** Apply every target both-or-neither; restore all on any failure. */
  private applyAll(target: ClaudeTarget, recipe: PatchRecipe, pristineByFile: Map<string, Buffer>): ApplyResult {
    let changed = false;
    try {
      for (const t of recipe.targets) {
        const abs = this.absFile(target, t);
        const cur = readOrUndefined(abs);
        if (cur && isCurrentPatch(cur.toString('utf8'), t)) {
          this.ensureBackupForTarget(abs, t); // already on the current patch; ensure restore works
          continue;
        }
        const pristine = pristineByFile.get(t.file);
        if (!pristine || sha256(pristine) !== t.pristineSha256) {
          this.restore();
          return { ok: false, reason: 'no-pristine' };
        }
        this.backups.save(target.buildId, t.pristineSha256, pristine);
        atomicWrite(abs, applyToContent(pristine.toString('utf8'), t));
        changed = true;
      }

      // Health probe every target: stripping our change must reproduce pristine.
      for (const t of recipe.targets) {
        const abs = this.absFile(target, t);
        const after = readOrUndefined(abs)?.toString('utf8');
        const stripped = after !== undefined ? stripFromContent(after, t) : undefined;
        if (stripped === undefined || sha256(stripped) !== t.pristineSha256) {
          this.restore();
          return { ok: false, reason: 'health-failed' };
        }
      }
      return { ok: true, reloadNeeded: changed };
    } catch {
      try { this.restore(); } catch { /* ignore */ }
      return { ok: false, reason: 'error' };
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  /**
   * Return every target to pristine. Only acts on a target that still carries
   * our patch — if a file no longer carries our marker (Claude Code updated, or
   * another extension overwrote it) we must not clobber it with our old bytes.
   */
  restore(): { ok: true; changed: boolean } | { ok: false } {
    const target = this.target();
    const recipe = target ? this.lookupRecipe(target.buildId) : undefined;
    if (!target || !recipe) return { ok: true, changed: false };

    let changed = false, failed = false;
    for (const t of recipe.targets) {
      const abs = this.absFile(target, t);
      const contents = readOrUndefined(abs)?.toString('utf8');
      if (contents === undefined) continue;

      if (!hasOurPatch(contents, t)) {
        this.backups.delete(target.buildId, t.pristineSha256); // drop stale backup, leave file
        continue;
      }

      const backup = this.backups.read(target.buildId, t.pristineSha256);
      let pristine: string | undefined = backup?.toString('utf8');
      if (pristine === undefined || sha256(pristine) !== t.pristineSha256) {
        pristine = stripFromContent(contents, t);
      }
      if (pristine === undefined || sha256(pristine) !== t.pristineSha256) {
        failed = true; // cannot recover a trustworthy original → leave as-is
        continue;
      }
      try {
        atomicWrite(abs, pristine);
        this.backups.delete(target.buildId, t.pristineSha256);
        changed = true;
      } catch {
        failed = true;
      }
    }
    return failed ? { ok: false } : { ok: true, changed };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Resolve trustworthy pristine bytes for one target, or undefined.
   *
   * SAFETY MODEL: every candidate is verified by SHA-256 against the recipe's
   * known-good hash — Anthropic's genuine `webview/index.js` / `extension.js` for
   * this build. We never trust a file's provenance or contents, ONLY its verified
   * hash. So even reading a backup another extension left behind is safe: it is
   * used only if it is byte-for-byte Anthropic's original; anything else is
   * rejected. This is what lets Awaitful recover after another extension has
   * modified Claude Code, without ever writing bytes we haven't proven genuine.
   */
  private obtainPristine(absFile: string, t: RecipeTarget): Buffer | undefined {
    const verify = (bytes: Buffer): boolean => sha256(bytes) === t.pristineSha256;

    // 1. the current file, if it is already pristine (the common first-install case).
    const cur = readOrUndefined(absFile);
    if (cur && verify(cur)) return cur;

    // 1b. our OWN older patch: strip it to recover pristine (upgrade path). Safe —
    //     it only strips content between our own markers, and we hash-verify.
    if (cur) {
      const stripped = stripFromContent(cur.toString('utf8'), t);
      if (stripped !== undefined) {
        const buf = Buffer.from(stripped, 'utf8');
        if (verify(buf)) return buf;
      }
    }

    // 2. our own verified backup (from a previous Awaitful patch).
    const backup = this.backups.read(this.buildIdFromAbs(absFile), t.pristineSha256);
    if (backup && verify(backup)) return backup;

    // 3. any pristine copy on disk next to the file — including a backup another
    //    tool left behind — accepted ONLY when it hash-matches the genuine original.
    const dir = path.dirname(absFile);
    const base = path.basename(absFile);
    let siblings: string[] = [];
    try { siblings = fs.readdirSync(dir); } catch { /* none */ }
    for (const name of siblings) {
      if (name === base || !name.startsWith(base + '.') || name.endsWith(TMP_SUFFIX)) continue;
      const bytes = readOrUndefined(path.join(dir, name));
      if (bytes && verify(bytes)) return bytes;
    }

    // 4. pristine bytes served by Awaitful (server-delivered).
    return undefined;
  }

  /** Can a take-over recover pristine for every target from Awaitful-controlled sources? */
  private canRecover(target: ClaudeTarget, recipe: PatchRecipe): boolean {
    for (const t of recipe.targets) {
      const abs = this.absFile(target, t);
      const cur = readOrUndefined(abs);
      if (cur && hasOurPatch(cur.toString('utf8'), t)) continue;       // already ours
      if (cur && sha256(cur) === t.pristineSha256) continue;            // already pristine
      if (!this.obtainPristine(abs, t)) return false;                  // no controlled source
    }
    return true;
  }

  // Backups are keyed by (buildId, pristineSha). The sha uniquely identifies each
  // target file (their pristine hashes differ), so we only need the buildId here.
  private buildIdFromAbs(_absFile: string): string {
    const target = this.target();
    return target?.buildId ?? 'unknown';
  }

  private ensureBackups(target: ClaudeTarget, recipe: PatchRecipe): void {
    for (const t of recipe.targets) this.ensureBackupForTarget(this.absFile(target, t), t);
  }

  /** Reconstruct+store a target's backup from an already-patched file, if possible. */
  private ensureBackupForTarget(absFile: string, t: RecipeTarget): void {
    const buildId = this.buildIdFromAbs(absFile);
    if (this.backups.has(buildId, t.pristineSha256)) return;
    const contents = readOrUndefined(absFile)?.toString('utf8');
    if (contents === undefined) return;
    const stripped = stripFromContent(contents, t);
    if (stripped !== undefined && sha256(stripped) === t.pristineSha256) {
      this.backups.save(buildId, t.pristineSha256, Buffer.from(stripped, 'utf8'));
    }
  }
}

// ── Pure per-target transforms (exported for tests) ───────────────────────────

// NOTE (Awaitful rename): a pre-rename "CodeCue" patch is deliberately NOT recognized as ours.
// The new extension has a different id → no backups, and CodeCue left no on-disk pristine to
// recover from, so the honest outcome is to treat it as a foreign modification (→ the competitor
// flow guides the user to restore/reinstall) rather than a half-upgrade that can't complete.

/** Is ANY version of our change present (used for ownership/strip)? */
export function hasOurPatch(text: string, t: RecipeTarget): boolean {
  if (t.strategy === 'append-shim') return text.includes(MARKER_PREFIX); // any version
  return text.includes(t.marker!); // csp-insert: our unique marker token
}

/** Is our CURRENT change present (exact marker / replacement)? */
export function isCurrentPatch(text: string, t: RecipeTarget): boolean {
  if (t.strategy === 'append-shim') return text.includes(t.markerStart!); // exact version
  return text.includes(t.replacement!); // csp-insert: exact current replacement
}

/** Apply this target's change to pristine content. */
export function applyToContent(pristine: string, t: RecipeTarget): string {
  if (t.strategy === 'append-shim') {
    return pristine + `\n${t.markerStart}\n` + t.shim + `\n${t.markerEnd}\n`;
  }
  // csp-insert: replace the unique `find` with `replacement` (indexOf avoids the
  // special `$` semantics of String.replace, since both contain `${...}`).
  const i = pristine.indexOf(t.find!);
  if (i < 0) return pristine; // find missing → no-op (health probe will reject)
  return pristine.slice(0, i) + t.replacement + pristine.slice(i + t.find!.length);
}

/**
 * Remove this target's change, reproducing pristine when present. For append-shim
 * this is version-agnostic — it strips ANY `/* AWAITFUL-START … *​/ … /* AWAITFUL-END *​/`
 * block, so an older shim is cleaned just as well as the current one.
 */
export function stripFromContent(text: string, t: RecipeTarget): string | undefined {
  if (t.strategy === 'append-shim') return stripShimBlock(text, MARKER_PREFIX, t.markerEnd!);
  // csp-insert: reverse the replacement (replacement → find), byte-exact.
  const i = text.indexOf(t.replacement!);
  if (i < 0) return undefined;
  return text.slice(0, i) + t.find + text.slice(i + t.replacement!.length);
}

/** Strip a `\n<prefix> … \n<end>\n` shim block (any version), or undefined if absent. */
function stripShimBlock(text: string, prefix: string, end: string): string | undefined {
  const startTok = `\n${prefix}`;
  const endTok = `\n${end}\n`;
  const start = text.indexOf(startTok);
  if (start < 0) return undefined;
  const e = text.indexOf(endTok, start + startTok.length);
  if (e < 0) return undefined;
  return text.slice(0, start) + text.slice(e + endTok.length);
}

// ── IO helpers ────────────────────────────────────────────────────────────────

function atomicWrite(file: string, contents: string): void {
  // Unique per-write temp name (pid + uuid): with several VS Code windows
  // self-healing at once (e.g. during a Claude Code update), a rename can never
  // publish another process's partially-written file into the live bundle — each
  // rename only ever moves a complete file this call wrote.
  const tmp = `${file}.${process.pid}.${randomUUID()}${TMP_SUFFIX}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  try {
    fs.renameSync(tmp, file); // atomic within the same directory on POSIX
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function readOrUndefined(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}
