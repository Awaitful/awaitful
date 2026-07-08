import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RECIPE, RecipeResponseSchema,
  type RecipeResponse, type AgentId, type PatchOutcome, type PatchReportRequest,
} from '@awaitful/shared';
import { postJson } from '../lib/http.js';
import { sha256 } from './hash.js';
import { assembleRecipe, findRecipe, MARKER_PREFIX, CSP_FIND, type PatchRecipe, type RecipeTarget } from './recipe.js';
import { hasOurPatch, stripFromContent } from './engine.js';
import { detectForeign } from './foreign.js';
import { findClaudeTarget, type ClaudeTarget } from './targets.js';

// Only agent today. The recipe/consensus machinery is agent-agnostic (data model + contract carry
// `agent`); a future agent adds its own target-detector + embedded shim here without server change.
const AGENT: AgentId = 'claude-code';
const POLL_MS = 60_000;

function targetFiles(t: ClaudeTarget): { web: string; ext: string } {
  // Must match the engine's absFile: path.join(target.dir, t.file).
  return { web: t.webviewFile, ext: path.join(t.dir, 'extension.js') };
}

// Read a target file the SAME way the engine does (utf8 string) so our sha256 matches assess().
function readUtf8(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

// A structural marker that a webview bundle is genuine Claude Code (CC's own stable class).
const WEBVIEW_ANCHOR = 'spinnerRow_';

// A valid-shaped placeholder sha256 used ONLY to assemble the patch shape (markers/shim) before the
// real pristine hashes are known. The shape is hash-independent; we recompute the real hashes from
// the recovered pristine. Valid-shaped (64 hex) so it survives any future hash-format validation.
const SHAPE_SHA = '0'.repeat(64);

/**
 * Recover a genuine-pristine target from a competitor's sibling backup — the competitor's OWN saved
 * original, the same source the engine's take-over already trusts. Accept it ONLY if it structurally
 * IS unpatched Claude Code our recipe can patch: it carries no Awaitful marker, and it contains the
 * anchor the target's strategy needs (CC's spinner class for the webview; our exact CSP anchor for
 * extension.js). A garbage or wrong backup fails these and we simply don't offer a take-over
 * (fail-safe → the surface stays unavailable rather than a patch that would roll back). Returns the
 * backup's content (to hash), or undefined.
 */
function recoverPristine(backupPath: string | undefined, anchor: string): string | undefined {
  if (!backupPath) return undefined;
  const content = readUtf8(backupPath);
  if (content === undefined) return undefined;
  if (content.includes(MARKER_PREFIX)) return undefined;   // never "recover" our own patch
  if (!content.includes(anchor)) return undefined;         // must be patchable genuine Claude Code
  return content;
}

/**
 * Server-delivered recipes + self-activation + crowd-consensus reporting.
 *
 * Polls `GET /v1/recipe` in the background and answers the engine's synchronous `RecipeLookup`
 * from last-known state, so a fresh network fetch never blocks the hot path. Recipe resolution order:
 *   1. verified server recipe (confidence ≥ min)  → the fleet-attested hash
 *   2. embedded recipe (human-verified)           → the shipped fallback
 *   3. self-recipe (provisional)                  → trust-on-first-use on an unknown build: a clean
 *      target hashes its live file; a competitor-patched target recovers pristine from the
 *      competitor's own validated sibling backup, so take-over is available without a server recipe.
 * Every path re-assembles the recipe from OUR embedded shim/CSP; the engine re-verifies each hash
 * byte-for-byte before writing, so a wrong/contested server hash can only fail safe.
 */
export class RecipeClient {
  private server = new Map<string, { resp: RecipeResponse; assembled: PatchRecipe | undefined }>();
  private self = new Map<string, { key: string; recipe: PatchRecipe | undefined }>();
  private reported = new Set<string>(); // dedupe reports per (build|web|ext|outcome) per session
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly base: string,
    private readonly getToken: () => string | undefined,
    private readonly getActiveDir: () => string | undefined,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Synchronous recipe resolution for PatchEngine. Never throws. */
  lookup(buildId: string): PatchRecipe | undefined {
    const s = this.server.get(buildId);
    if (s && s.resp.status === 'verified' && s.resp.confidence >= RECIPE.minConfidence && s.assembled) {
      return s.assembled;
    }
    const embedded = findRecipe(buildId);
    if (embedded) return embedded;
    return this.selfRecipe(buildId);
  }

  /** Is the recipe the engine would use for the ACTIVE build a provisional self-recipe? (honest UX). */
  isProvisionalActive(): boolean {
    const target = findClaudeTarget(this.getActiveDir());
    if (!target) return false;
    const buildId = target.buildId;
    const s = this.server.get(buildId);
    if (s && s.resp.status === 'verified' && s.resp.confidence >= RECIPE.minConfidence && s.assembled) return false;
    if (findRecipe(buildId)) return false;
    return !!this.selfRecipe(buildId);
  }

  // ── Server poll ─────────────────────────────────────────────────────────────
  private async poll(): Promise<void> {
    const target = findClaudeTarget(this.getActiveDir());
    if (!target) return;
    const url = `${this.base}/v1/recipe?agent=${AGENT}&build=${encodeURIComponent(target.buildId)}`;
    const token = this.getToken();
    try {
      const res = await fetch(url, {
        headers: token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' },
      });
      if (res.status === 204) { this.server.delete(target.buildId); return; } // no recipe yet
      if (!res.ok) return;                                                     // 401/5xx → keep last-known
      const resp = RecipeResponseSchema.parse(await res.json()) as RecipeResponse;
      this.server.set(target.buildId, { resp, assembled: assembleRecipe(resp) });
    } catch {
      /* network / bad body → keep last-known; embedded/self still cover us */
    }
  }

  // ── Self-recipe (trust-on-first-use) ─────────────────────────────────────────
  private selfRecipe(buildId: string): PatchRecipe | undefined {
    const target = findClaudeTarget(this.getActiveDir());
    if (!target || target.buildId !== buildId) return undefined;
    const f = targetFiles(target);

    // Memoize by file freshness so churn (competitor patch/unpatch) recomputes but the hot path
    // doesn't re-hash. The foreign-present bit is in the key too — a competitor's sibling backup
    // can appear/vanish without touching the target files, and must still flip the clean verdict.
    let key: string;
    try {
      const sw = fs.statSync(f.web), se = fs.statSync(f.ext);
      const foreign = detectForeign(f.web).present || detectForeign(f.ext).present;
      key = `${sw.size}:${sw.mtimeMs}:${se.size}:${se.mtimeMs}:${foreign ? 'F' : 'C'}`;
    } catch { return undefined; }
    const memo = this.self.get(buildId);
    if (memo && memo.key === key) return memo.recipe;

    const recipe = this.computeSelfRecipe(target, f);
    this.self.set(buildId, { key, recipe });
    return recipe;
  }

  private computeSelfRecipe(target: ClaudeTarget, f: { web: string; ext: string }): PatchRecipe | undefined {
    const web = readUtf8(f.web), ext = readUtf8(f.ext);
    if (web === undefined || ext === undefined) return undefined;

    // Assemble our patch SHAPE (embedded shim + CSP markers) once, so we can strip our OWN patch to
    // recover pristine. The hashes here are placeholders; we recompute them from the recovered
    // pristine below. The target shapes are hash-independent, so this is safe.
    const shape = assembleRecipe(this.selfResponse(target, SHAPE_SHA, SHAPE_SHA));
    const wt = shape?.targets.find((t) => t.strategy === 'append-shim');
    const et = shape?.targets.find((t) => t.strategy === 'csp-insert');
    if (!wt || !et) return undefined;

    // Per target, establish the genuine PRISTINE content — we NEVER hash a patched live file:
    //  • our OWN patch present     → strip our patch (version-agnostic → reproduces pristine), so a
    //    build we already patched KEEPS a recipe and is recognized as 'our-patch-present' rather than
    //    falling through to 'unknown-build' ("Coming soon"). Critically this covers upgrading over a
    //    build we self-activated + patched, or a Claude Code version bump we re-applied to. It derives
    //    exactly the same pristine report() already derives by stripping, so consensus stays consistent.
    //  • competitor-patched target → recover pristine from the competitor's OWN validated sibling
    //    backup, so take-over is AVAILABLE without a server recipe. report() sends clean=false whenever
    //    a foreign backup is present, so a competitor-derived hash never votes in consensus.
    //  • clean target              → the live file IS pristine (votable path).
    // Detection is generic (any sibling backup), so this covers UNKNOWN competitors, not just named
    // ones. A verified server recipe, when it lands, supersedes this provisional one (see lookup order).
    const webPristine = this.pristineForSelf(web, f.web, wt, WEBVIEW_ANCHOR);
    const extPristine = this.pristineForSelf(ext, f.ext, et, CSP_FIND);
    if (webPristine === undefined || extPristine === undefined) return undefined;

    return assembleRecipe(this.selfResponse(target, sha256(webPristine), sha256(extPristine)));
  }

  /** The provisional self-recipe response for a build with the given per-target pristine hashes. */
  private selfResponse(target: ClaudeTarget, webSha: string, extSha: string): RecipeResponse {
    return {
      agent: AGENT, buildId: target.buildId, version: target.version,
      confidence: RECIPE.minConfidence, status: 'provisional',
      targets: [
        { file: 'webview/index.js', strategy: 'append-shim', pristineSha256: webSha },
        { file: 'extension.js', strategy: 'csp-insert', pristineSha256: extSha },
      ],
    };
  }

  /**
   * Recover the genuine PRISTINE content for one self-recipe target, or undefined if it can't be
   * trusted (→ the surface stays unavailable, fail-safe):
   *  - our OWN patch present → strip our patch; the result must be genuine, patchable Claude Code
   *    (no residual Awaitful marker AND carries the target's anchor), else we don't trust it.
   *  - competitor patch      → recover from the competitor's validated sibling backup.
   *  - otherwise             → the live file is already pristine.
   */
  private pristineForSelf(content: string, file: string, t: RecipeTarget, anchor: string): string | undefined {
    if (hasOurPatch(content, t)) {
      const stripped = stripFromContent(content, t);
      if (stripped === undefined || stripped.includes(MARKER_PREFIX) || !stripped.includes(anchor)) return undefined;
      return stripped;
    }
    const foreign = detectForeign(file, content);
    if (foreign.present) return recoverPristine(foreign.backupPath, anchor);
    return content;
  }

  // ── Consensus + patch-health report (rate-limited) ───────────────────────────
  /** Report the observed pristine hash pair + outcome. Clean (no foreign) reports feed consensus. */
  report(outcome: PatchOutcome): void {
    try {
      const target = findClaudeTarget(this.getActiveDir());
      if (!target) return;
      const f = targetFiles(target);
      const web = readUtf8(f.web), ext = readUtf8(f.ext);
      if (web === undefined || ext === undefined) return;

      const foreign = detectForeign(f.web, web).present || detectForeign(f.ext, ext).present;
      // Derive the PRISTINE hash: strip our own patch if present (never report an our-patched hash).
      const recipe = this.lookup(target.buildId);
      const webPristine = this.pristine(web, recipe?.targets.find((t) => t.file === 'webview/index.js'));
      const extPristine = this.pristine(ext, recipe?.targets.find((t) => t.file === 'extension.js'));

      const req: PatchReportRequest = {
        agent: AGENT, buildId: target.buildId, version: target.version,
        webSha256: sha256(webPristine), extSha256: sha256(extPristine),
        clean: !foreign, outcome,
      };
      const dedupe = `${req.buildId}|${req.webSha256}|${req.extSha256}|${req.outcome}`;
      if (this.reported.has(dedupe)) return; // rate-limit: churn can't spam
      this.reported.add(dedupe);
      void postJson(`${this.base}/v1/patch/report`, req, this.getToken()).catch(() => {});
    } catch { /* the report is best-effort; never disturb patching */ }
  }

  private pristine(text: string, target?: RecipeTarget): string {
    if (target && hasOurPatch(text, target)) {
      const stripped = stripFromContent(text, target);
      if (stripped !== undefined) return stripped;
    }
    return text;
  }
}
