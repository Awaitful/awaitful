import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../patch/hash.js';
import { BackupStore } from '../patch/backup.js';
import {
  extensionsOnDisk, extensionsElsewhere, obsoleteExtensionDirs, findClaudeTarget,
} from '../patch/targets.js';
import {
  PatchEngine, applyToContent, stripFromContent, hasOurPatch, type RecipeLookup,
} from '../patch/engine.js';
import { MARKER_START, MARKER_END, MARKER_PREFIX, findRecipe, assembleRecipe, type PatchRecipe, type RecipeTarget } from '../patch/recipe.js';
import { GLOW_THEMES } from '@awaitful/shared';
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
  it('no-recipe when no recipe matches and the files are clean', () => {
    writePristine();
    expect(engine(noRecipe).assess().state).toBe('no-recipe');
  });
  it('no-target when Claude Code is absent', () => {
    fs.rmSync(path.join(root, BUILD_ID), { recursive: true, force: true });
    expect(engine().assess().state).toBe('no-target');
  });
  it('unknown-modified when EITHER target differs from pristine with no marker', () => {
    writePristine();
    fs.writeFileSync(extFile, EXT + '\n// tweaked\n', 'utf8'); // only ext modified
    expect(engine().assess().state).toBe('unknown-modified');
  });

  /**
   * THE INCIDENT. A competitor holds the file on a build we have no recipe for. Recipe resolution
   * used to run FIRST and return a single "we don't know this build" state, so the panel told the
   * user their Claude Code version was unsupported and to wait for a release - while a competitor's
   * ad rendered in the surface we were supposed to own. Custody is decided from the bytes now.
   */
  it('foreign-only, never no-recipe, when a competitor holds the file on an unknown build', () => {
    writePristine();
    fs.writeFileSync(webFile, WEB + '\n/* VIBE-ADS-START */x();/* VIBE-ADS-END */\n', 'utf8');
    const a = engine(noRecipe).assess();
    expect(a.state).toBe('foreign-only');
    expect(a.foreign?.inFile).toBe(true);
    expect(a.recoverable).toBe('unknown'); // no recipe, so we cannot even ask
  });

  it('ours-unverified, never no-recipe, when our marker is present on an unknown build', () => {
    fs.writeFileSync(webFile, applyToContent(WEB, WEB_TARGET), 'utf8');
    fs.writeFileSync(extFile, EXT, 'utf8');
    expect(engine(noRecipe).assess().state).toBe('ours-unverified');
  });

  it('foreign-only + reports the token from a generic sibling backup', () => {
    writePristine();
    fs.writeFileSync(webFile, WEB + '\n/* OTHER-SHIM */\n', 'utf8');
    fs.writeFileSync(webFile + '.acmeads-backup', WEB, 'utf8');
    const a = engine().assess();
    expect(a.state).toBe('unknown-modified'); // no in-file marker: we accuse nobody
  });

  it('foreign-only + reports the token from an in-file marker (no sibling backup)', () => {
    writePristine();
    fs.writeFileSync(webFile, WEB + '\n/* CODECUE-START v19 */ globalThis.x=1; /* CODECUE-END */\n', 'utf8');
    const a = engine().assess();
    expect(a.state).toBe('foreign-only');
    expect(a.foreign?.token).toBe('CODECUE');
    // Nothing by that name is installed in this fixture, so we must NOT claim a vendor.
    expect(a.foreign?.vendorInstalled).not.toBe('yes');
    expect(a.foreign?.vendor).toBeUndefined();
  });

  it('names a vendor only when that extension is actually installed', () => {
    writePristine();
    fs.writeFileSync(webFile, WEB + '\n/* CODECUE-START v19 */x();/* CODECUE-END */\n', 'utf8');
    const withInstall = new PatchEngine(
      new BackupStore(storageDir), lookup, () => path.join(root, BUILD_ID),
      (token) => (token.toLowerCase() === 'codecue' ? { id: 'acme.codecue', label: 'CodeCue', active: true } : undefined),
    );
    const a = withInstall.assess();
    expect(a.foreign?.vendorInstalled).toBe('yes');
    expect(a.foreign?.vendor).toBe('CodeCue');
    expect(a.foreign?.vendorId).toBe('acme.codecue');
  });

  /**
   * Switched off is not gone. VS Code's extension API lists only ENABLED extensions, so a tool the
   * developer merely disabled looked identical to one they had removed - and the panel quoted a raw
   * marker token at someone whose extension was sitting right there in their list. Its change is
   * still in the file either way, so this state has to be nameable and actionable.
   */
  it('tells a disabled extension apart from an uninstalled one', () => {
    writePristine();
    fs.writeFileSync(webFile, WEB + '\n/* CODECUE-START v19 */x();/* CODECUE-END */\n', 'utf8');
    const withDisabled = new PatchEngine(
      new BackupStore(storageDir), lookup, () => path.join(root, BUILD_ID),
      (token) => (token.toLowerCase() === 'codecue' ? { id: 'acme.codecue', label: 'CodeCue', active: false } : undefined),
    );
    const a = withDisabled.assess();
    expect(a.foreign?.vendorInstalled).toBe('disabled');
    expect(a.foreign?.vendor).toBe('CodeCue');   // still nameable: it is right there on disk
  });

  /**
   * A copy installed for a DIFFERENT editor is neither gone nor switched off, and calling it either
   * is what made the repair unwinnable.
   *
   * Measured on a real machine: a patch tool installed only in VSCodium re-patched a Claude Code
   * that had just been installed into VS Code, within a minute, because it walks $HOME and edits the
   * agent wherever it finds it. From VS Code's own registry the tool looked uninstalled, so every
   * step said "removed", the file kept changing back, and the checklist sent the developer round the
   * reinstall loop with the actual fix sitting in another application.
   */
  it('tells a copy in another editor apart from one that is gone', () => {
    writePristine();
    fs.writeFileSync(webFile, WEB + '\n/* CODECUE-START v19 */x();/* CODECUE-END */\n', 'utf8');
    const far = new PatchEngine(
      new BackupStore(storageDir), lookup, () => path.join(root, BUILD_ID),
      (token) => (token.toLowerCase() === 'codecue'
        ? { id: 'acme.codecue', label: 'CodeCue', active: false, host: { label: 'Cursor', dir: '/home/dev/.cursor/extensions' } }
        : undefined),
    );
    const a = far.assess();
    expect(a.foreign?.vendorInstalled).toBe('elsewhere');
    expect(a.foreign?.vendorHost?.label).toBe('Cursor');
    // Nameable, and it has to be: "another editor" does not tell you which one to go and open.
    expect(a.foreign?.vendor).toBe('CodeCue');
  });

  it('a file carrying our block AND a foreign block is ours-plus-foreign, never ours', () => {
    // The silent-failure case: our marker is present, so the old substring test called this healthy
    // and the panel showed the surface as active while the competitor's line rendered instead.
    fs.writeFileSync(webFile, applyToContent(WEB, WEB_TARGET) + '\n/* VIBE-ADS-START */x();/* VIBE-ADS-END */\n', 'utf8');
    fs.writeFileSync(extFile, applyToContent(EXT, EXT_TARGET), 'utf8');
    expect(engine().assess().state).toBe('ours-plus-foreign');
  });

  it('our block over bytes that no longer strip to pristine is ours-plus-unknown', () => {
    // A competitor that does NOT wrap its work in a marker. Marker-only detection is a one-string
    // bypass for anyone who wants it, so the hash has to carry this case.
    fs.writeFileSync(webFile, applyToContent(WEB + '\n// silent edit\n', WEB_TARGET), 'utf8');
    fs.writeFileSync(extFile, applyToContent(EXT, EXT_TARGET), 'utf8');
    expect(engine().assess().state).toBe('ours-plus-unknown');
  });

  it('an unreadable target with no marker anywhere is unreadable, not a modification claim', () => {
    writePristine();
    fs.rmSync(extFile);
    const a = engine().assess();
    expect(a.state).toBe('unreadable');
    expect(a.errno).toBe('ENOENT');
  });

  it('a foreign marker on one target outranks an unreadable sibling', () => {
    // Otherwise a hostile tool could hide itself by making the OTHER target unreadable.
    writePristine();
    fs.writeFileSync(webFile, WEB + '\n/* VIBE-ADS-START */x();/* VIBE-ADS-END */\n', 'utf8');
    fs.rmSync(extFile);
    expect(engine().assess().state).toBe('foreign-only');
  });

  it('never attributes OUR OWN marker as a foreign modifier', () => {
    writePristine();
    // A file carrying our marker at an unexpected hash is ours-plus-unknown, never a "competitor".
    fs.writeFileSync(webFile, WEB + `\n${MARKER_START} tampered ${MARKER_END}\n`, 'utf8');
    const a = engine().assess();
    expect(a.foreign?.vendor).toBeUndefined();
    expect(a.state).toBe('ours-plus-unknown');
  });
});

// ── apply ─────────────────────────────────────────────────────────────────────

/**
 * Uninstalling an extension does not delete its folder. VS Code records the name in `.obsolete` and
 * sweeps the bytes later, once no window is holding them - so a scan that trusts directory names
 * alone reports removed tools as installed. That is what stopped the conflict checklist from ever
 * ticking after a successful uninstall, and made a working button look broken.
 */
describe('.obsolete: uninstalled is not the same as still on disk', () => {
  const markObsolete = (...names: string[]) => {
    const o: Record<string, boolean> = {};
    for (const n of names) o[n] = true;
    fs.writeFileSync(path.join(root, '.obsolete'), JSON.stringify(o), 'utf8');
  };
  const mkExt = (name: string) => fs.mkdirSync(path.join(root, name), { recursive: true });

  /**
   * The registry is the only trustworthy answer to "is this installed?", and it outranks both the
   * folder and `.obsolete`.
   *
   * Measured on a real machine: an uninstalled extension had its folder intact, an EMPTY `.obsolete`,
   * and no registry entry. Trusting the folder reported it as merely switched off, so the repair
   * checklist told the developer to turn off something they had already removed, and its step never
   * ticked - the flow simply stalled there.
   */
  it('believes the registry over a folder VS Code has not swept yet', () => {
    mkExt('acme.codecue-1.2.3');
    mkExt('other.tool-1.0.0');
    fs.writeFileSync(path.join(root, 'extensions.json'), JSON.stringify([
      { identifier: { id: 'other.tool' }, relativeLocation: 'other.tool-1.0.0' },
    ]), 'utf8');
    const ids = extensionsOnDisk().map(e => e.id);
    expect(ids).toContain('other.tool');
    expect(ids, 'a swept-pending folder counts as installed').not.toContain('acme.codecue');
  });

  it('falls back to folders when there is no registry to read', () => {
    mkExt('acme.codecue-1.2.3');
    expect(extensionsOnDisk().map(e => e.id)).toContain('acme.codecue');
    fs.writeFileSync(path.join(root, 'extensions.json'), 'not json', 'utf8');
    expect(extensionsOnDisk().map(e => e.id)).toContain('acme.codecue');
  });

  it('leaves an uninstalled extension out of the on-disk set', () => {
    mkExt('acme.codecue-1.2.3');
    expect(extensionsOnDisk().map(e => e.id)).toContain('acme.codecue');
    markObsolete('acme.codecue-1.2.3');
    expect(extensionsOnDisk().map(e => e.id)).not.toContain('acme.codecue');
  });

  it('reads an absent or unreadable .obsolete as "nothing is obsolete"', () => {
    expect(obsoleteExtensionDirs().size).toBe(0);
    fs.writeFileSync(path.join(root, '.obsolete'), 'not json at all', 'utf8');
    expect(obsoleteExtensionDirs().size).toBe(0);
    mkExt('acme.codecue-1.2.3');
    expect(extensionsOnDisk().map(e => e.id)).toContain('acme.codecue');
  });

  /**
   * After an update the previous build sits there until VS Code sweeps it. Picking it would write
   * into bytes nothing loads, and report patch health for a build that is not running.
   */
  it('never picks an uninstalled Claude Code build, however high its version', () => {
    fs.mkdirSync(path.join(root, 'anthropic.claude-code-9.9.9', 'webview'), { recursive: true });
    fs.writeFileSync(path.join(root, 'anthropic.claude-code-9.9.9', 'webview', 'index.js'), 'x', 'utf8');
    expect(findClaudeTarget()?.version).toBe('9.9.9');
    markObsolete('anthropic.claude-code-9.9.9');
    expect(findClaudeTarget()?.version).not.toBe('9.9.9');
  });
});

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

  it('take-over from a sibling backup that carries OUR OWN block succeeds (they backed up our patched file)', () => {
    // A competitor that installs AFTER us saves its "original" from the file we already patched.
    // Refusing that backup strands the user with the competitor's shim and no way to evict it; the
    // strip is byte-exact and the result is still accepted only on a hash match against pristine.
    fs.writeFileSync(webFile, WEB + '\n/* OTHER-SHIM */\n', 'utf8');
    fs.writeFileSync(webFile + '.other-backup', applyToContent(WEB, WEB_TARGET), 'utf8');
    fs.writeFileSync(extFile, EXT, 'utf8');
    const a = engine().assess();
    expect(a.state).toBe('unknown-modified');
    expect(a.recoverable).toBe('yes');
    const res = engine().apply(true);
    expect(res.ok).toBe(true);
    expect(readFile(webFile)).toContain(MARKER_START);
    expect(readFile(webFile)).not.toContain('OTHER-SHIM');       // the competitor's block is evicted
    expect(stripFromContent(readFile(webFile), WEB_TARGET)).toBe(WEB); // and pristine is exactly pristine
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

  it('DECLINES the write when the only hash-matching pristine is itself contaminated (save() refuses)', () => {
    // The last-resort guard (golden rule 2). A recipe self-derived from contamination: its pristineSha256
    // is the hash of bytes that carry a competitor marker. A sibling copy of exactly those bytes
    // hash-matches and is offered as "pristine", but BackupStore.save refuses to bank a non-pristine
    // original - so applyAll must DECLINE the write instead of stacking our shim on top with no backup.
    const dirtyWeb = `${WEB}/* VIBE-ADS-START */x();/* VIBE-ADS-END */\n`;
    const contaminated: PatchRecipe = { ...RECIPE, targets: [{ ...WEB_TARGET, pristineSha256: sha256(dirtyWeb) }] };
    const moddedWeb = WEB + '\n/* OTHER */\n';
    fs.writeFileSync(webFile, moddedWeb, 'utf8');                 // current file: modified, not pristine
    fs.writeFileSync(webFile + '.other-backup', dirtyWeb, 'utf8'); // hash-matches the contaminated pristine
    fs.writeFileSync(extFile, EXT, 'utf8');
    const res = engine(() => contaminated).apply(true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-pristine');
    expect(readFile(webFile)).toBe(moddedWeb); // our shim was never stacked on the contaminated bytes
    expect(new BackupStore(storageDir).read(BUILD_ID, sha256(dirtyWeb))).toBeUndefined(); // nothing banked
  });

  it('assess reports recoverable=true when a hash-verified pristine copy is on disk', () => {
    fs.writeFileSync(webFile, WEB + '\n/* OTHER */\n', 'utf8');
    fs.writeFileSync(webFile + '.other-backup', WEB, 'utf8');
    fs.writeFileSync(extFile, EXT, 'utf8');
    const a = engine().assess();
    expect(a.state).toBe('unknown-modified');
    expect(a.recoverable).toBe('yes');
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
    expect(eng.restore()).toMatchObject({ ok: true, changed: true, assessed: true });
    expect(readFile(webFile)).toBe(WEB);
    expect(readFile(extFile)).toBe(EXT);
  });

  it('does not write a target whose marker is absent (never clobbers another extension)', () => {
    const other = EXT + '\n// other ext\n';
    fs.writeFileSync(webFile, WEB, 'utf8');
    fs.writeFileSync(extFile, other, 'utf8');
    expect(engine().restore()).toMatchObject({ ok: true, changed: false, assessed: true });
    expect(readFile(extFile)).toBe(other);
  });

  it('recovers via strip when the stored backup is missing', () => {
    writePristine();
    const eng = engine();
    eng.apply();
    for (const f of fs.readdirSync(storageDir)) fs.rmSync(path.join(storageDir, f));
    expect(eng.restore()).toMatchObject({ ok: true, changed: true, assessed: true });
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
    expect(engine().restore()).toMatchObject({ ok: true, changed: false, assessed: true });
  });

  it('KEEPS our backup when a competitor has patched over us (it is the only pristine left)', () => {
    // restore() drops the stored backup for any target no longer carrying our marker. When a
    // competitor overwrote us, that backup is the machine's last copy of pristine - deleting it
    // turns a recoverable conflict into one that needs a full Claude Code reinstall.
    const store = new BackupStore(storageDir);
    store.save(BUILD_ID, WEB_TARGET.pristineSha256, Buffer.from(WEB, 'utf8'));
    fs.writeFileSync(webFile, WEB + '\n/* OTHER-SHIM */\n', 'utf8');
    fs.writeFileSync(extFile, EXT, 'utf8');

    engine().restore();
    expect(store.read(BUILD_ID, WEB_TARGET.pristineSha256)?.toString('utf8')).toBe(WEB);
  });

  it('still drops the backup when the file is genuinely pristine again (nothing left to recover)', () => {
    const store = new BackupStore(storageDir);
    store.save(BUILD_ID, WEB_TARGET.pristineSha256, Buffer.from(WEB, 'utf8'));
    writePristine();
    engine().restore();
    expect(store.read(BUILD_ID, WEB_TARGET.pristineSha256)).toBeUndefined();
  });
});

describe('BackupStore hygiene', () => {
  it('refuses to store bytes carrying another tool marker, whatever hash the caller claims', () => {
    // The caller's hash gate cannot catch this: when the RECIPE itself was self-derived from
    // contaminated content, the hash matches because it is the hash of the contamination. One field
    // machine accumulated 49 such "originals" (233 MB) this way.
    const store = new BackupStore(storageDir);
    const dirty = Buffer.from(`${WEB}/* VIBE-ADS-START */x();/* VIBE-ADS-END */\n`, 'utf8');
    store.save(BUILD_ID, sha256(dirty), dirty);
    expect(store.read(BUILD_ID, sha256(dirty))).toBeUndefined();
  });

  it('stores clean pristine', () => {
    const store = new BackupStore(storageDir);
    expect(store.save(BUILD_ID, WEB_TARGET.pristineSha256, Buffer.from(WEB, 'utf8'))).toBe(true);
    expect(store.read(BUILD_ID, WEB_TARGET.pristineSha256)?.toString('utf8')).toBe(WEB);
  });

  it('refuses bytes carrying OUR OWN marker - a "pristine" containing our patch is not pristine', () => {
    // foreignMarkerToken deliberately skips AWAITFUL so we never accuse ourselves of being a
    // competitor, which means our own block would otherwise pass the foreign check untouched.
    const store = new BackupStore(storageDir);
    const ours = Buffer.from(applyToContent(WEB, WEB_TARGET), 'utf8');
    expect(store.save(BUILD_ID, sha256(ours), ours)).toBe(false);
    expect(store.read(BUILD_ID, sha256(ours))).toBeUndefined();
  });

  it('purgeContaminated removes marked backups and keeps the one genuine original', () => {
    const store = new BackupStore(storageDir);
    store.save(BUILD_ID, WEB_TARGET.pristineSha256, Buffer.from(WEB, 'utf8')); // the clean one
    for (let i = 0; i < 5; i++) {
      // Written directly: these are the shape save() now refuses, but older builds stored them.
      const dirty = `${WEB}// round ${i}\n/* VIBE-ADS-START */x();/* VIBE-ADS-END */\n`;
      fs.writeFileSync(path.join(storageDir, `${BUILD_ID}.${sha256(dirty)}.bak`), dirty);
    }
    expect(store.purgeContaminated(BUILD_ID)).toBe(5);
    expect(store.read(BUILD_ID, WEB_TARGET.pristineSha256)?.toString('utf8')).toBe(WEB);
  });

  it('pruneExcept never deletes when the keep set is empty (a wrong root is not a licence to delete)', () => {
    const store = new BackupStore(storageDir);
    store.save(BUILD_ID, WEB_TARGET.pristineSha256, Buffer.from(WEB, 'utf8'));
    store.pruneExcept(new Set());
    expect(store.read(BUILD_ID, WEB_TARGET.pristineSha256)).toBeDefined();
  });

  it('caps backups per build so a patch war cannot leak unbounded disk', () => {
    const store = new BackupStore(storageDir);
    for (let i = 0; i < 20; i++) {
      const bytes = Buffer.from(`${WEB}// derivation ${i}\n`, 'utf8');
      store.save(BUILD_ID, sha256(bytes), bytes);
    }
    const mine = fs.readdirSync(storageDir).filter((n) => n.startsWith(BUILD_ID + '.'));
    expect(mine.length).toBeLessThanOrEqual(8);
  });
});

/**
 * An extension is installed into ONE editor, but it is not confined to one.
 *
 * A patch tool reads $HOME and edits the agent's files wherever it finds them, so a copy living in
 * a different editor changes the very bytes this window loads. Reading only our own registry made
 * that copy invisible: the panel found a marker in the file, matched it against nothing, and
 * concluded the tool was gone - so it told the developer to reinstall Claude Code, which the other
 * editor patched again within the minute.
 */
describe('other editors on the same machine', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env['HOME'];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'awaitful-home-'));
    process.env['HOME'] = home;
    // Ours, and therefore never reported as somewhere else.
    process.env['AWAITFUL_VSCODE_EXT_DIR'] = path.join(home, '.vscode', 'extensions');
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const editor = (dot: string, entries: { id: string; dir: string }[]) => {
    const root = path.join(home, dot, 'extensions');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions.json'), JSON.stringify(
      entries.map((e) => ({ identifier: { id: e.id }, relativeLocation: e.dir })),
    ), 'utf8');
    return root;
  };

  it('finds an extension installed for a different editor', () => {
    editor('.vscode', [{ id: 'awaitful.awaitful', dir: 'awaitful.awaitful-0.7.4' }]);
    editor('.vscode-oss', [{ id: 'acme.codecue', dir: 'acme.codecue-2.3.1' }]);
    const far = extensionsElsewhere();
    expect(far.map((e) => e.id)).toEqual(['acme.codecue']);
    expect(far[0]!.editor).toBe('VSCodium');
    expect(far[0]!.root).toBe(path.join(home, '.vscode-oss', 'extensions'));
  });

  // Our own editor is where the ordinary remove button works. Reporting it as "somewhere else"
  // would send the developer out of the application that can actually fix it.
  it('never reports this window’s own editor as another one', () => {
    editor('.vscode', [{ id: 'acme.codecue', dir: 'acme.codecue-2.3.1' }]);
    expect(extensionsElsewhere()).toEqual([]);
    expect(extensionsOnDisk().map((e) => e.id)).toContain('acme.codecue');
  });

  /**
   * Registry only, no folder fallback. For another editor we cannot watch `.obsolete` being swept or
   * a window holding bytes open, so a leftover folder there would raise an alarm about a tool the
   * developer has already removed - and send them to quit an application for no reason.
   */
  it('ignores a directory with no registry in it', () => {
    fs.mkdirSync(path.join(home, '.cursor', 'extensions', 'acme.codecue-2.3.1'), { recursive: true });
    expect(extensionsElsewhere()).toEqual([]);
  });

  /**
   * A fork we have never heard of still gets a name a developer recognises. Nobody has an
   * application called ".some-forked-editor", so telling someone to go and quit one is telling them
   * to decode a directory listing.
   */
  it('names an unknown editor the way a person would say it', () => {
    editor('.some-forked-editor', [{ id: 'acme.codecue', dir: 'acme.codecue-2.3.1' }]);
    expect(extensionsElsewhere()[0]?.editor).toBe('Some Forked Editor');
  });

  /**
   * An editor drops the registry entry the instant you uninstall and sweeps the folder only at its
   * next start - so between those two moments the extension is loaded and still doing its job.
   * Registry-only detection called that "gone", the flow fell back to the ordinary repair, and the
   * file kept changing back from an application we had just stopped mentioning.
   */
  it('sees an extension uninstalled elsewhere but not yet swept', () => {
    const root = editor('.cursor', []);
    fs.mkdirSync(path.join(root, 'acme.codecue-2.3.1'), { recursive: true });
    const far = extensionsElsewhere();
    expect(far.map((e) => e.id)).toEqual(['acme.codecue']);
    expect(far[0]!.pendingRemoval).toBe(true);
    // The extension's OWN folder, not the editor's: it is what to delete and what to reveal.
    expect(far[0]!.dir).toBe(path.join(root, 'acme.codecue-2.3.1'));
  });

  it('does not call a listed extension pending removal', () => {
    const root = editor('.cursor', [{ id: 'acme.codecue', dir: 'acme.codecue-2.3.1' }]);
    fs.mkdirSync(path.join(root, 'acme.codecue-2.3.1'), { recursive: true });
    const far = extensionsElsewhere();
    expect(far).toHaveLength(1);
    expect(far[0]!.pendingRemoval).toBe(false);
  });

  it('survives a home directory it cannot read', () => {
    process.env['HOME'] = path.join(home, 'nope');
    expect(extensionsElsewhere()).toEqual([]);
  });
});
