import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../patch/hash.js';
import { BackupStore } from '../patch/backup.js';
import {
  PatchEngine, applyToContent, stripFromContent, hasOurPatch, type RecipeLookup,
} from '../patch/engine.js';
import { MARKER_START, MARKER_END, MARKER_PREFIX, findRecipe, assembleRecipe, GLOW_THEMES, type PatchRecipe, type RecipeTarget } from '../patch/recipe.js';
import type { RecipeResponse } from '@awaitful/shared';

// Two-target fixture: an append-shim webview + a csp-insert extension.js. The
// engine discovers Claude Code under AWAITFUL_VSCODE_EXT_DIR and resolves recipes
// via an injectable lookup, so every path runs offline against real files.

const BUILD_ID = 'anthropic.claude-code-2.1.199-darwin-x64';
const WEB = 'WEBVIEW_BUNDLE_v2.1.199\n// ... minified ...\n';
const ANCHOR = "default-src 'none'; ${p};";
const EXT = `HEADER; ${ANCHOR} script-src 'nonce'; TAIL`;
const FIND = "default-src 'none'; ${p};";
const REPLACEMENT = "default-src 'none'; connect-src http://127.0.0.1:* awaitful.invalid; ${p};";

const WEB_TARGET: RecipeTarget = {
  file: 'webview/index.js', strategy: 'append-shim', pristineSha256: sha256(WEB),
  markerStart: MARKER_START, markerEnd: MARKER_END, shim: ';(()=>{globalThis.__cc=1;})();',
};
const EXT_TARGET: RecipeTarget = {
  file: 'extension.js', strategy: 'csp-insert', pristineSha256: sha256(EXT),
  find: FIND, replacement: REPLACEMENT, marker: 'awaitful.invalid',
};
const RECIPE: PatchRecipe = {
  buildId: BUILD_ID, version: '2.1.199', recipeVersion: 2, confidence: 0.5,
  targets: [WEB_TARGET, EXT_TARGET],
};
const lookup: RecipeLookup = (id) => (id === BUILD_ID ? RECIPE : undefined);
const noRecipe: RecipeLookup = () => undefined;

let root: string, storageDir: string, webFile: string, extFile: string;

function engine(l: RecipeLookup = lookup): PatchEngine {
  return new PatchEngine(new BackupStore(storageDir), l);
}
const readFile = (f: string) => fs.readFileSync(f, 'utf8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awaitful-ext-'));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awaitful-bk-'));
  process.env['AWAITFUL_VSCODE_EXT_DIR'] = root;
  const dir = path.join(root, BUILD_ID);
  fs.mkdirSync(path.join(dir, 'webview'), { recursive: true });
  webFile = path.join(dir, 'webview', 'index.js');
  extFile = path.join(dir, 'extension.js');
});
afterEach(() => {
  delete process.env['AWAITFUL_VSCODE_EXT_DIR'];
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(storageDir, { recursive: true, force: true });
});

function writePristine() {
  fs.writeFileSync(webFile, WEB, 'utf8');
  fs.writeFileSync(extFile, EXT, 'utf8');
}

// ── Pure transforms ───────────────────────────────────────────────────────────

describe('append-shim transforms', () => {
  it('apply then strip round-trips byte-for-byte', () => {
    const patched = applyToContent(WEB, WEB_TARGET);
    expect(patched).toContain(MARKER_START);
    expect(hasOurPatch(patched, WEB_TARGET)).toBe(true);
    expect(stripFromContent(patched, WEB_TARGET)).toBe(WEB);
  });
});

describe('csp-insert transforms', () => {
  it('puts connect-src FIRST (right after default-src, before ${p}) and is reversible', () => {
    const patched = applyToContent(EXT, EXT_TARGET);
    expect(patched).toContain('connect-src http://127.0.0.1');
    // our connect-src must come before ${p}
    expect(patched.indexOf('connect-src http://127.0.0.1')).toBeLessThan(patched.indexOf('${p}'));
    expect(hasOurPatch(patched, EXT_TARGET)).toBe(true);
    expect(stripFromContent(patched, EXT_TARGET)).toBe(EXT);
  });
  it('handles the literal ${...} without $-substitution bugs', () => {
    const patched = applyToContent(EXT, EXT_TARGET);
    expect(patched).toContain('${p}'); // preserved verbatim
  });
});

// A pre-rename (CodeCue) patch is intentionally treated as a FOREIGN modification, not ours —
// the new extension has no backups to recover from, so the honest path is the competitor flow.
describe('legacy (CodeCue) patch is not mistaken for ours', () => {
  it('does not recognize a CodeCue shim as our patch', () => {
    const legacyPatched = WEB + '\n/* CODECUE-START v18 */\nOLD_SHIM_BODY\n/* CODECUE-END */\n';
    expect(hasOurPatch(legacyPatched, WEB_TARGET)).toBe(false);        // → assessed as modified/foreign
    expect(stripFromContent(legacyPatched, WEB_TARGET)).toBeUndefined();
  });

  it('does not recognize a legacy csp marker as ours', () => {
    const legacyCsp = 'HEADER; connect-src http://127.0.0.1:* codecue.invalid; TAIL';
    expect(hasOurPatch(legacyCsp, EXT_TARGET)).toBe(false);
  });
});

// ── assess ────────────────────────────────────────────────────────────────────

describe('assess', () => {
  it('clean-pristine when both targets are untouched', () => {
    writePristine();
    expect(engine().assess().state).toBe('clean-pristine');
  });
  it('unknown-build when no recipe matches', () => {
    writePristine();
    expect(engine(noRecipe).assess().state).toBe('unknown-build');
  });
  it('no-target when Claude Code is absent', () => {
    fs.rmSync(path.join(root, BUILD_ID), { recursive: true, force: true });
    expect(engine().assess().state).toBe('no-target');
  });
  it('modified when EITHER target differs from pristine', () => {
    writePristine();
    fs.writeFileSync(extFile, EXT + '\n// tweaked\n', 'utf8'); // only ext modified
    expect(engine().assess().state).toBe('modified');
  });
  it('modified + resolves a name from a generic sibling backup', () => {
    writePristine();
    fs.writeFileSync(webFile, WEB + '\n/* OTHER-SHIM */\n', 'utf8');
    fs.writeFileSync(webFile + '.acmeads-backup', WEB, 'utf8');
    const a = engine().assess();
    expect(a.state).toBe('modified');
    expect(a.foreign?.vendor).toBe('Acmeads');
  });
  it('modified + names the modifier from its OWN in-file patch marker (no sibling backup)', () => {
    writePristine();
    // A competitor that appends a marker-wrapped shim but keeps its backup elsewhere.
    fs.writeFileSync(webFile, WEB + '\n/* CODECUE-START v19 */ globalThis.x=1; /* CODECUE-END */\n', 'utf8');
    const a = engine().assess();
    expect(a.state).toBe('modified');
    // No matching install here, so it falls back to the raw marker token; in the field
    // resolveVendorName maps "codecue" → the installed extension's display name ("CodeCue").
    expect(a.foreign?.vendor).toBe('CODECUE');
  });
  it('never attributes OUR OWN marker as a foreign modifier', () => {
    writePristine();
    // A file carrying our marker at an unexpected hash is ours-stale, never a "competitor".
    fs.writeFileSync(webFile, WEB + `\n${MARKER_START} tampered ${MARKER_END}\n`, 'utf8');
    const a = engine().assess();
    expect(a.foreign?.vendor).toBeUndefined();
  });
});

// ── apply ─────────────────────────────────────────────────────────────────────

describe('apply', () => {
  it('patches BOTH targets and passes health probes', () => {
    writePristine();
    expect(engine().apply()).toEqual({ ok: true, reloadNeeded: true });
    expect(readFile(webFile)).toContain(MARKER_START);
    expect(readFile(extFile)).toContain('connect-src http://127.0.0.1');
  });

  it('is idempotent — re-applying is a no-op needing no reload', () => {
    writePristine();
    const eng = engine();
    eng.apply();
    expect(eng.apply()).toEqual({ ok: true, reloadNeeded: false });
  });

  it('detects an OLDER shim version as stale and re-applies the current one', () => {
    // Simulate an install carrying a previous shim version: same markers/pristine,
    // but a different marker version + shim body.
    const oldTarget: RecipeTarget = { ...WEB_TARGET, markerStart: `${MARKER_PREFIX} v1 */`, shim: 'OLD_SHIM_BODY' };
    const oldWebPatched = applyToContent(WEB, oldTarget);
    fs.writeFileSync(webFile, oldWebPatched, 'utf8');
    fs.writeFileSync(extFile, applyToContent(EXT, EXT_TARGET), 'utf8'); // ext already current

    expect(engine().assess().state).toBe('our-patch-stale');
    const res = engine().apply();
    expect(res).toEqual({ ok: true, reloadNeeded: true });
    const after = readFile(webFile);
    expect(after).toContain(MARKER_START);          // current version marker
    expect(after).not.toContain('OLD_SHIM_BODY');   // old shim stripped
    expect(after).toContain(WEB_TARGET.shim!);      // current shim present
    expect(stripFromContent(after, WEB_TARGET)).toBe(WEB); // still byte-exact reversible
  });

  it('both-or-neither: a health failure on one target restores the other', () => {
    // ext pristine lacks the anchor → csp-insert cannot apply → health fails →
    // the already-written webview shim must be rolled back.
    fs.writeFileSync(webFile, WEB, 'utf8');
    const brokenExt = 'NO ANCHOR HERE';
    fs.writeFileSync(extFile, brokenExt, 'utf8');
    const badRecipe: PatchRecipe = {
      ...RECIPE,
      targets: [WEB_TARGET, { ...EXT_TARGET, pristineSha256: sha256(brokenExt) }],
    };
    const res = engine(() => badRecipe).apply();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('health-failed');
    expect(readFile(webFile)).toBe(WEB);        // rolled back
    expect(readFile(extFile)).toBe(brokenExt);  // untouched
  });

  it('refuses to patch or snapshot when a target is modified (no consent)', () => {
    writePristine();
    const moddedExt = EXT + '\n// other ext\n';
    fs.writeFileSync(extFile, moddedExt, 'utf8');
    const res = engine().apply(false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('blocked');
    expect(readFile(extFile)).toBe(moddedExt);      // untouched
    expect(readFile(webFile)).toBe(WEB);            // untouched
    expect(fs.readdirSync(storageDir)).toHaveLength(0); // nothing snapshotted
  });

  it('take-over from our OWN backup succeeds', () => {
    const store = new BackupStore(storageDir);
    store.save(BUILD_ID, WEB_TARGET.pristineSha256, Buffer.from(WEB, 'utf8'));
    store.save(BUILD_ID, EXT_TARGET.pristineSha256, Buffer.from(EXT, 'utf8'));
    fs.writeFileSync(webFile, WEB + '\n/* OTHER */\n', 'utf8');
    fs.writeFileSync(extFile, EXT + '\n// other\n', 'utf8');
    const res = engine().apply(true);
    expect(res.ok).toBe(true);
    expect(readFile(webFile)).toContain(MARKER_START);
    expect(readFile(webFile)).not.toContain('OTHER');
    expect(stripFromContent(readFile(extFile), EXT_TARGET)).toBe(EXT);
  });

  it('take-over from a HASH-VERIFIED sibling backup succeeds (recovers a foreign-modified file)', () => {
    fs.writeFileSync(webFile, WEB + '\n/* OTHER-SHIM */\n', 'utf8');
    fs.writeFileSync(webFile + '.other-backup', WEB, 'utf8'); // byte-for-byte pristine
    fs.writeFileSync(extFile, EXT + '\n// other\n', 'utf8');
    fs.writeFileSync(extFile + '.other-backup', EXT, 'utf8'); // byte-for-byte pristine
    const res = engine().apply(true);
    expect(res.ok).toBe(true);
    expect(readFile(webFile)).toContain(MARKER_START);
    expect(readFile(webFile)).not.toContain('OTHER-SHIM');
    expect(stripFromContent(readFile(extFile), EXT_TARGET)).toBe(EXT);
  });

  it('take-over still REFUSES a sibling backup that does NOT hash to pristine', () => {
    const moddedWeb = WEB + '\n/* OTHER */\n';
    fs.writeFileSync(webFile, moddedWeb, 'utf8');
    fs.writeFileSync(webFile + '.other-backup', 'NOT THE ORIGINAL', 'utf8'); // wrong bytes
    fs.writeFileSync(extFile, EXT, 'utf8');
    const res = engine().apply(true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-pristine');
    expect(readFile(webFile)).toBe(moddedWeb); // untouched
  });

  it('assess reports recoverable=true when a hash-verified pristine copy is on disk', () => {
    fs.writeFileSync(webFile, WEB + '\n/* OTHER */\n', 'utf8');
    fs.writeFileSync(webFile + '.other-backup', WEB, 'utf8');
    fs.writeFileSync(extFile, EXT, 'utf8');
    const a = engine().assess();
    expect(a.state).toBe('modified');
    expect(a.recoverable).toBe(true);
  });
});

// ── restore ───────────────────────────────────────────────────────────────────

// ── shim editor-safety ─────────────────────────────────────────────────────────
// The shim is APPENDED to Claude Code's webview bundle, so a syntax error would break
// CC's entire webview (golden rule 2). Guard that every embedded shim parses as JS.
describe('embedded shim', () => {
  for (const buildId of [
    'anthropic.claude-code-2.1.199-darwin-x64',
    'anthropic.claude-code-2.1.200-darwin-x64',
    'anthropic.claude-code-2.1.201-darwin-x64',
  ]) {
    it(`is syntactically valid JS for ${buildId}`, () => {
      const recipe = findRecipe(buildId);
      expect(recipe).toBeDefined();
      const shim = recipe!.targets.find((t) => t.strategy === 'append-shim')?.shim;
      expect(shim).toBeTruthy();
      // A parse error throws here; valid JS constructs a function without running it.
      expect(() => new Function(shim!)).not.toThrow();
      // Sanity: it's our overlay shim and carries no unresolved config placeholder.
      expect(shim).toContain('data-awaitful-overlay');
      expect(shim).not.toContain('/*CONFIG*/');
      // Both render modes are present (regression guard for the chat-banner surface):
      // the injected hide/glow stylesheet, the chat-banner branch, and the composer anchor.
      expect(shim).toContain('data-awaitful-style');
      expect(shim).toContain('chat-banner');
      expect(shim).toContain('inputContainer_');
      // Every picker glow theme's live CSS is injected into the shim (single source with the panel preview).
      for (const t of GLOW_THEMES) expect(shim).toContain(t.background);
    });
  }
});

// ── assembleRecipe: server DATA (hashes/selectors) + our EMBEDDED shim ───────────
describe('assembleRecipe', () => {
  const resp = (over: Partial<RecipeResponse> = {}): RecipeResponse => ({
    agent: 'claude-code', buildId: BUILD_ID, version: '2.1.199', confidence: 0.8, status: 'verified',
    targets: [
      { file: 'webview/index.js', strategy: 'append-shim', pristineSha256: sha256(WEB) },
      { file: 'extension.js', strategy: 'csp-insert', pristineSha256: sha256(EXT) },
    ],
    ...over,
  });
  const shimOf = (r: PatchRecipe | undefined) => r!.targets.find((t) => t.strategy === 'append-shim')!.shim!;

  it('binds server hashes to the embedded shim, which parses + carries both render modes', () => {
    const recipe = assembleRecipe(resp());
    expect(recipe).toBeDefined();
    const shim = shimOf(recipe);
    expect(() => new Function(shim)).not.toThrow();
    expect(shim).not.toContain('/*CONFIG*/');
    expect(shim).toContain('chat-banner');
    expect(shim).toContain('inputContainer_');           // composer anchor default
    expect(recipe!.targets.find((t) => t.file === 'webview/index.js')!.pristineSha256).toBe(sha256(WEB));
  });

  it('a server selectors hot-fix retargets the spinner but keeps composer/hide defaults (and still parses)', () => {
    const shim = shimOf(assembleRecipe(resp({ selectors: ['[class*="spinnerRowV2_"]'] })));
    expect(() => new Function(shim)).not.toThrow();
    expect(shim).toContain('spinnerRowV2_');             // hot-fixed spinner selector applied
    expect(shim).toContain('inputContainer_');           // composer default retained
  });

  it('returns undefined when the expected two targets are missing', () => {
    expect(assembleRecipe(resp({ targets: [] }))).toBeUndefined();
  });
});

describe('BackupStore.pruneExcept', () => {
  it('deletes backups for builds not in the keep set, keeps the rest', () => {
    const store = new BackupStore(storageDir);
    const shaA = sha256('A'), shaB = sha256('B');
    store.save('anthropic.claude-code-2.1.199-darwin-x64', shaA, Buffer.from('A'));
    store.save('anthropic.claude-code-2.1.200-darwin-x64', shaB, Buffer.from('B'));
    store.pruneExcept(new Set(['anthropic.claude-code-2.1.200-darwin-x64']));
    expect(store.has('anthropic.claude-code-2.1.199-darwin-x64', shaA)).toBe(false);
    expect(store.has('anthropic.claude-code-2.1.200-darwin-x64', shaB)).toBe(true);
  });
});

describe('restore', () => {
  it('restores BOTH targets byte-exact after a patch', () => {
    writePristine();
    const eng = engine();
    eng.apply();
    expect(eng.restore()).toEqual({ ok: true, changed: true, assessed: true });
    expect(readFile(webFile)).toBe(WEB);
    expect(readFile(extFile)).toBe(EXT);
  });

  it('does not write a target whose marker is absent (never clobbers another extension)', () => {
    const other = EXT + '\n// other ext\n';
    fs.writeFileSync(webFile, WEB, 'utf8');
    fs.writeFileSync(extFile, other, 'utf8');
    expect(engine().restore()).toEqual({ ok: true, changed: false, assessed: true });
    expect(readFile(extFile)).toBe(other);
  });

  it('recovers via strip when the stored backup is missing', () => {
    writePristine();
    const eng = engine();
    eng.apply();
    for (const f of fs.readdirSync(storageDir)) fs.rmSync(path.join(storageDir, f));
    expect(eng.restore()).toEqual({ ok: true, changed: true, assessed: true });
    expect(readFile(webFile)).toBe(WEB);
    expect(readFile(extFile)).toBe(EXT);
  });

  // The honesty distinction behind the "nothing to restore" message: assessed:true means we looked and
  // found nothing of ours (a real all-clear); assessed:false means no recipe resolved so we could not
  // look at all, and the caller must NOT claim the editor is unmodified.
  it('reports assessed:false when no recipe resolves for the build', () => {
    writePristine();
    expect(engine(noRecipe).restore()).toEqual({ ok: true, changed: false, assessed: false });
  });

  it('reports assessed:true when a recipe resolves and no patch of ours is present', () => {
    writePristine();
    expect(engine().restore()).toEqual({ ok: true, changed: false, assessed: true });
  });
});
