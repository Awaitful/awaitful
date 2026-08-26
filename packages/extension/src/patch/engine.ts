import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './hash.js';
import { findClaudeTarget, extensionsRoot, homedir, type ClaudeTarget } from './targets.js';
import { findRecipe as defaultFindRecipe, MARKER_PREFIX, type PatchRecipe, type RecipeTarget } from './recipe.js';
import { detectForeign, foreignMarkerToken, type ForeignDetection, type InstalledLookup } from './foreign.js';
import { scanTargets, anyForeignInFile, anyOurs, type TargetScan } from './scan.js';
import type { BackupStore } from './backup.js';

/** Resolve a recipe for a build id. Injectable so tests can supply fixtures. */
export type RecipeLookup = (buildId: string) => PatchRecipe | undefined;

/**
 * Who holds Claude Code's files right now, worst news first.
 *
 * The ordering matters as much as the members. `assess()` used to resolve a recipe FIRST and bail
 * to a single "we don't know this build" state — so a competitor, which is exactly what breaks
 * recipe resolution, was invisible, and the panel blamed the Claude Code version for another
 * tool's edit. Custody is now decided from the bytes, and the recipe only refines it.
 */
export type PatchState =
  | 'no-target'         // no Claude Code files visible to this window
  | 'foreign-only'      // another tool's marker in the live bytes, none of ours
  | 'ours-plus-foreign' // our marker AND another tool's — two sponsored lines can appear
  | 'ours-plus-unknown' // our marker, but the rest no longer matches pristine and nothing says why
  | 'unknown-modified'  // no marker at all, and the bytes are not pristine
  | 'unreadable'        // a target exists but we could not read it
  | 'ours-unverified'   // our marker, no recipe: we can neither verify nor safely undo
  | 'no-recipe'         // clean-looking, but this build is not verified yet
  | 'clean-pristine'    // every target matches its known-good hash → safe to patch
  | 'our-patch-present' // every target carries our CURRENT patch, strip-verified → idempotent
  | 'our-patch-stale';  // our patch is present but an older shim version → re-apply

/** Can a take-over recover pristine? `unknown` = no recipe, so we cannot even ask. */
export type Recoverable = 'yes' | 'no' | 'unknown';

/** A target we patch that is currently held by something other than pristine or our own patch. */
export interface ForeignHeldTarget {
  file: string;
  foreign: ForeignDetection;
}

export type RestoreResult =
  | {
      ok: true;
      changed: boolean;
      assessed: true;
      /**
       * Targets that are neither pristine nor ours. `changed:false` with a non-empty list means
       * "we had nothing of our own to undo, and something else is in there" - a very different
       * message from "your editor is unmodified".
       */
      foreignHeld: ForeignHeldTarget[];
    }
  | { ok: true; changed: false; assessed: false }
  | { ok: false };

export interface Assessment {
  state: PatchState;
  target?: ClaudeTarget;
  recipe?: PatchRecipe;
  foreign?: ForeignDetection;
  recoverable?: Recoverable;
  /** Reason a target could not be read, for honest copy (mid-update vs permissions). */
  errno?: 'ENOENT' | 'EACCES' | 'OTHER';
}

export type ApplyResult =
  | { ok: true; reloadNeeded: boolean; tookOver?: string | undefined }
  | {
      ok: false;
      reason: 'no-target' | 'no-recipe' | 'blocked' | 'no-pristine' | 'health-failed' | 'error';
      foreignVendor?: string | undefined;
      /** For a failure that attempted a rollback (no-pristine / health-failed / error): whether the
       *  editor was CONFIRMED returned to pristine. When false, our bytes may still be on disk and the
       *  caller must not claim the editor is safe. Undefined for failures that never wrote anything. */
      rolledBack?: boolean | undefined;
    };

/**
 * States where the file is held by something other than a clean copy of our own work, so writing
 * requires explicit take-over consent. Every one of these means "the bytes on disk are not what we
 * verified"; they differ only in how much we can honestly say about who put them there.
 */
const CONTESTED: ReadonlySet<PatchState> = new Set<PatchState>([
  'foreign-only',
  'ours-plus-foreign',
  'ours-plus-unknown',
  'unknown-modified',
]);

const TMP_SUFFIX = '.awaitful-tmp';
type TargetState =
  | 'pristine'
  | 'ours'
  | 'ours-stale'
  | 'ours-plus-foreign'
  | 'ours-plus-unknown'
  | 'foreign'
  | 'modified'
  | 'unreadable';

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
    /** Resolve a marker token to an INSTALLED extension, so we never name a tool that is gone. */
    private readonly installed?: InstalledLookup,
  ) {}

  private target(): ClaudeTarget | undefined {
    return findClaudeTarget(this.getActiveDir());
  }

  /**
   * Drop backups for Claude Code builds that are no longer installed.
   *
   * The keep-set spans EVERY extensions root we know of, not just `~/.vscode/extensions`. A user
   * with VS Code and Cursor has two independent Claude Code installs; scanning one root and
   * pruning against it deleted the other editor's only verified pristine while that editor was
   * actively patching the build. `pruneExcept` additionally refuses an empty keep-set.
   */
  pruneStaleBackups(): void {
    const keep = new Set<string>();
    const roots = new Set<string>([extensionsRoot()]);
    const active = this.target();
    if (active) roots.add(path.dirname(active.dir)); // whichever editor we are actually running in
    for (const dir of ['.vscode', '.vscode-insiders', '.vscode-oss', '.cursor', '.windsurf', '.vscode-server']) {
      roots.add(path.join(homedir(), dir, 'extensions'));
    }
    for (const root of roots) {
      try {
        for (const name of fs.readdirSync(root)) {
          if (name.startsWith('anthropic.claude-code-')) keep.add(name);
        }
      } catch { /* root absent — try the next */ }
    }
    this.backups.pruneExcept(keep);
  }

  /** One-time removal of stored "originals" that carry a patch marker. Returns how many went. */
  purgeContaminatedBackups(): number {
    return this.backups.purgeContaminated(this.target()?.buildId);
  }

  // ── Assessment ────────────────────────────────────────────────────────────

  assess(): Assessment {
    const target = this.target();
    if (!target) return { state: 'no-target', recoverable: 'unknown' };

    // Scan the BYTES first, with no recipe. Custody is a fact about the files; whether we happen
    // to have a verified hash for this build is a separate question that must not hide it.
    const scans = scanTargets(target);
    const foreignScan = anyForeignInFile(scans);
    const oursPresent = anyOurs(scans);
    const recipe = this.lookupRecipe(target.buildId);

    const foreignFor = (s: TargetScan | undefined): ForeignDetection | undefined =>
      s ? detectForeign(s.abs, s.bytes, this.installed) : undefined;

    // 1. A foreign marker in the live bytes outranks everything, INCLUDING an unreadable sibling.
    //    Ranking `unreadable` first would let a locked or missing extension.js hide a competitor
    //    sitting in webview/index.js - the same "someone else's edit reported as something else"
    //    defect, and trivially inducible by a hostile tool.
    if (foreignScan) {
      return {
        state: oursPresent ? 'ours-plus-foreign' : 'foreign-only',
        target,
        ...(recipe ? { recipe } : {}),
        foreign: foreignFor(foreignScan) ?? { present: true },
        recoverable: recipe ? (this.canRecover(target, recipe) ? 'yes' : 'no') : 'unknown',
      };
    }

    // 2. Something we cannot read. Not a modification claim - we genuinely do not know.
    const unreadable = scans.find((s) => !s.readable);
    if (unreadable) {
      return {
        state: 'unreadable',
        target,
        ...(recipe ? { recipe } : {}),
        ...(unreadable.errno ? { errno: unreadable.errno } : {}),
        recoverable: 'unknown',
      };
    }

    // 3. No recipe: we can say who holds the file, never whether the rest of it is genuine.
    if (!recipe) {
      return { state: oursPresent ? 'ours-unverified' : 'no-recipe', target, recoverable: 'unknown' };
    }

    let anyStale = false, allOurs = true, anyOursPlusUnknown = false, anyModified = false;
    for (const t of recipe.targets) {
      const scan = scans.find((s) => s.file === t.file);
      const st = this.classify(scan?.bytes, t);
      if (st !== 'ours') allOurs = false;
      if (st === 'ours-stale') anyStale = true;
      if (st === 'ours-plus-unknown') anyOursPlusUnknown = true;
      if (st === 'modified') anyModified = true;
    }

    // 4. Our marker is there but the file no longer strips back to pristine. A tool that does not
    //    mark its work, a partial update, or a hand edit - we say what we know and accuse nobody.
    if (anyOursPlusUnknown) {
      return {
        state: 'ours-plus-unknown', target, recipe,
        recoverable: this.canRecover(target, recipe) ? 'yes' : 'no',
      };
    }
    if (anyModified) {
      return {
        state: 'unknown-modified', target, recipe,
        foreign: { present: false },
        recoverable: this.canRecover(target, recipe) ? 'yes' : 'no',
      };
    }
    if (anyStale) return { state: 'our-patch-stale', target, recipe, recoverable: 'yes' };
    if (allOurs) return { state: 'our-patch-present', target, recipe, recoverable: 'yes' };
    // All pristine, or a mix of pristine + ours (one target reverted): apply completes it.
    return { state: 'clean-pristine', target, recipe, recoverable: 'yes' };
  }

  /**
   * What is in one target file.
   *
   * Order is load-bearing. `isCurrentPatch` used to win before anything else looked, so
   * `pristine + our block + their block` classified as a healthy `ours` - the panel said the
   * surface was active while a competitor's line rendered instead of ours. Our marker now only
   * means "ours" once the file strips back to the verified original.
   */
  private classify(content: string | undefined, t: RecipeTarget): TargetState {
    if (content === undefined) return 'unreadable';
    const foreign = foreignMarkerToken(content) !== undefined;
    if (hasOurPatch(content, t)) {
      const stripped = stripFromContent(content, t);
      const clean = stripped !== undefined && sha256(stripped) === t.pristineSha256;
      if (foreign) return 'ours-plus-foreign';
      if (!clean) return 'ours-plus-unknown';
      return isCurrentPatch(content, t) ? 'ours' : 'ours-stale';
    }
    if (foreign) return 'foreign';
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
    if (a.state === 'unreadable') return { ok: false, reason: 'no-pristine' };
    if (!recipe || a.state === 'no-recipe' || a.state === 'ours-unverified') {
      return { ok: false, reason: 'no-recipe' };
    }
    if (a.state === 'our-patch-present') {
      this.ensureBackups(target!, recipe);
      return { ok: true, reloadNeeded: false };
    }
    if (CONTESTED.has(a.state) && !consentTakeover) {
      return { ok: false, reason: 'blocked', foreignVendor: a.foreign?.vendor };
    }

    // clean-pristine, our-patch-stale, or a contested state + consent: resolve verified pristine
    // for every target not already CLEANLY on the current patch, then apply all-or-nothing.
    const pristineByFile = new Map<string, Buffer>();
    for (const t of recipe.targets) {
      const abs = this.absFile(target!, t);
      const cur = readOrUndefined(abs);
      if (cur && this.isCleanCurrent(cur.toString('utf8'), t)) continue; // genuinely done; skip
      const pristine = this.obtainPristine(abs, t);
      if (!pristine) return { ok: false, reason: 'no-pristine', foreignVendor: a.foreign?.vendor };
      pristineByFile.set(t.file, pristine);
    }

    const res = this.applyAll(target!, recipe, pristineByFile);
    if (res.ok && CONTESTED.has(a.state) && a.foreign?.vendor) return { ...res, tookOver: a.foreign.vendor };
    return res;
  }

  /**
   * Is this file genuinely finished — our current shim AND nothing else?
   *
   * `isCurrentPatch` alone is a substring test for our marker, which stays true when another tool
   * has appended its own block on top of ours. Skipping on that test made the take-over write
   * nothing and report `{ok:true}`: the user clicked "Restore original and enable", was told it
   * worked, and both blocks were still there. A skip must mean "already correct", never "our
   * marker is somewhere in this file".
   */
  private isCleanCurrent(content: string, t: RecipeTarget): boolean {
    if (!isCurrentPatch(content, t)) return false;
    if (foreignMarkerToken(content) !== undefined) return false;
    const stripped = stripFromContent(content, t);
    return stripped !== undefined && sha256(stripped) === t.pristineSha256;
  }

  /** Apply every target both-or-neither; restore all on any failure. */
  private applyAll(target: ClaudeTarget, recipe: PatchRecipe, pristineByFile: Map<string, Buffer>): ApplyResult {
    let changed = false;
    try {
      for (const t of recipe.targets) {
        const abs = this.absFile(target, t);
        const cur = readOrUndefined(abs);
        if (cur && this.isCleanCurrent(cur.toString('utf8'), t)) {
          this.ensureBackupForTarget(abs, t); // genuinely current; ensure restore works
          continue;
        }
        const pristine = pristineByFile.get(t.file);
        if (!pristine || sha256(pristine) !== t.pristineSha256) {
          const rb = this.restore();
          return { ok: false, reason: 'no-pristine', rolledBack: rb.ok };
        }
        // save() is the last-resort pristine check: it REFUSES (returns false) when the bytes we are
        // about to bank as "original" actually carry a patch marker - a competitor's or our own - which
        // means they are not pristine. Its contract is that a refusal must be treated as no-pristine and
        // the write declined, so we never modify Claude Code without a verified backup on disk (golden
        // rule 2). Roll back anything already written this pass and fail safe.
        if (!this.backups.save(target.buildId, t.pristineSha256, pristine)) {
          const rb = this.restore();
          return { ok: false, reason: 'no-pristine', rolledBack: rb.ok };
        }
        // A csp-insert whose `find` is absent from these bytes leaves them unchanged, so the write
        // below would replace Claude Code's file with a copy of itself - and the health probe would
        // then reject it and roll the whole pass back. We can see the change did not land BEFORE
        // touching the disk, so decline here: same both-or-neither outcome, one fewer pointless
        // rewrite of the editor's own bundle (golden rule 2).
        const patched = applyToContent(pristine.toString('utf8'), t);
        if (!isCurrentPatch(patched, t)) {
          const rb = this.restore();
          return { ok: false, reason: 'health-failed', rolledBack: rb.ok };
        }
        atomicWrite(abs, patched);
        changed = true;
      }

      // Health probe every target: stripping our change must reproduce pristine.
      for (const t of recipe.targets) {
        const abs = this.absFile(target, t);
        const after = readOrUndefined(abs)?.toString('utf8');
        const stripped = after !== undefined ? stripFromContent(after, t) : undefined;
        if (stripped === undefined || sha256(stripped) !== t.pristineSha256) {
          const rb = this.restore();
          return { ok: false, reason: 'health-failed', rolledBack: rb.ok };
        }
      }
      return { ok: true, reloadNeeded: changed };
    } catch {
      let rolledBack = false;
      try { rolledBack = this.restore().ok; } catch { /* ignore */ }
      return { ok: false, reason: 'error', rolledBack };
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  /**
   * Return every target to pristine. Only acts on a target that still carries
   * our patch — if a file no longer carries our marker (Claude Code updated, or
   * another extension overwrote it) we must not clobber it with our old bytes.
   */
  restore(): RestoreResult {
    const target = this.target();
    const recipe = target ? this.lookupRecipe(target.buildId) : undefined;
    // `assessed: false` means we could not even look: no Claude Code target, or no recipe for this
    // build. That is NOT the same as "we looked and there is nothing of ours" (assessed: true,
    // changed: false), and the caller must not tell the user "your editor is unmodified" on the
    // strength of a check that never ran. A competitor could have patched over us and left no backup,
    // producing exactly this no-recipe state on the file the user is asking us to clean.
    if (!target || !recipe) return { ok: true, changed: false, assessed: false };

    let changed = false, failed = false;
    const foreignHeld: ForeignHeldTarget[] = [];
    for (const t of recipe.targets) {
      const abs = this.absFile(target, t);
      const contents = readOrUndefined(abs)?.toString('utf8');
      if (contents === undefined) continue;

      if (!hasOurPatch(contents, t)) {
        // Someone else is holding a file we patch. Report it rather than let the caller say
        // "nothing to restore - no Awaitful changes are present", which is true about US and
        // useless to a user staring at another tool's sponsored line.
        if (sha256(contents) !== t.pristineSha256) {
          foreignHeld.push({ file: t.file, foreign: detectForeign(abs, contents, this.installed) });
        }
        // Our patch is gone from this file. Only drop the backup when the file on disk IS the
        // genuine original — then the backup is redundant. If something else is in there (a
        // competitor patched over us, or the file was hand-edited), that backup is the ONLY
        // remaining copy of pristine on this machine, and deleting it turns a recoverable conflict
        // into a permanent one that needs a Claude Code reinstall. Keep it and leave the file alone.
        if (sha256(contents) === t.pristineSha256) this.backups.delete(target.buildId, t.pristineSha256);
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
        // Deliberately KEEP the backup. One file of at most a few MB per build is the difference
        // between "Awaitful can take this back" and "reinstall Claude Code"; MAX_PER_BUILD already
        // bounds the store, and pruning on uninstall already collects it.
        changed = true;
      } catch {
        failed = true;
      }
    }
    return failed ? { ok: false } : { ok: true, changed, assessed: true, foreignHeld };
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
      if (!bytes) continue;
      if (verify(bytes)) return bytes;
      // Same asymmetry as 1b: a competitor that installed AFTER us saved its "original" from the
      // file we had already patched, so its backup carries our block. Stripping ours is byte-exact,
      // and the result is still accepted ONLY on a hash match against the recipe's genuine pristine
      // — so this widens what we can RECOVER without widening what we are willing to WRITE.
      const stripped = stripFromContent(bytes.toString('utf8'), t);
      if (stripped !== undefined) {
        const buf = Buffer.from(stripped, 'utf8');
        if (verify(buf)) return buf;
      }
    }

    // 4. pristine bytes served by Awaitful (server-delivered).
    return undefined;
  }

  /**
   * Can a take-over recover pristine for every target from Awaitful-controlled sources?
   *
   * This answer becomes a button. It used to skip any target merely carrying our marker, so a file
   * holding our block AND a competitor's reported recoverable with no pristine source anywhere -
   * offering a remedy that could not run. A target only counts as needing no recovery when it is
   * already CLEANLY ours or already byte-pristine; anything else has to produce real bytes.
   */
  private canRecover(target: ClaudeTarget, recipe: PatchRecipe): boolean {
    for (const t of recipe.targets) {
      const abs = this.absFile(target, t);
      const cur = readOrUndefined(abs);
      if (cur && this.isCleanCurrent(cur.toString('utf8'), t)) continue; // cleanly ours
      if (cur && sha256(cur) === t.pristineSha256) continue;             // already pristine
      if (!this.obtainPristine(abs, t)) return false;                    // no controlled source
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

/**
 * Apply this target's change to pristine content.
 *
 * A csp-insert whose `find` is absent from these bytes returns them UNCHANGED, so the result is
 * never proof the change landed. `applyAll` re-checks with `isCurrentPatch` and declines the write
 * rather than replace one of Claude Code's files with a copy of itself.
 */
export function applyToContent(pristine: string, t: RecipeTarget): string {
  if (t.strategy === 'append-shim') {
    return pristine + `\n${t.markerStart}\n` + t.shim + `\n${t.markerEnd}\n`;
  }
  // csp-insert: replace the unique `find` with `replacement` (indexOf avoids the
  // special `$` semantics of String.replace, since both contain `${...}`).
  const i = pristine.indexOf(t.find!);
  if (i < 0) return pristine; // find missing → no-op; the caller refuses to write it
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
