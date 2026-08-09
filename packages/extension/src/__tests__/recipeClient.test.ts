import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecipeResponse } from '@awaitful/shared';
import { sha256 } from '../patch/hash.js';
import { assembleRecipe, MARKER_PREFIX } from '../patch/recipe.js';
import { applyToContent } from '../patch/engine.js';
import { RecipeClient } from '../patch/recipeClient.js';

const BUILD = 'anthropic.claude-code-9.9.9-darwin-x64';
const WEB = 'console.log("cc webview");var _u={spinnerRow:"spinnerRow_ab12"};\n'; // carries the CC webview anchor
const EXT = "default-src 'none'; ${p};\n"; // contains the CSP anchor the recipe targets

let root: string, buildDir: string, webFile: string, extFile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recipe-'));
  process.env['AWAITFUL_VSCODE_EXT_DIR'] = root;
  buildDir = path.join(root, BUILD);
  fs.mkdirSync(path.join(buildDir, 'webview'), { recursive: true });
  webFile = path.join(buildDir, 'webview', 'index.js');
  extFile = path.join(buildDir, 'extension.js');
  fs.writeFileSync(webFile, WEB);
  fs.writeFileSync(extFile, EXT);
});

afterEach(() => {
  delete process.env['AWAITFUL_VSCODE_EXT_DIR'];
  fs.rmSync(root, { recursive: true, force: true });
});

const client = () => new RecipeClient('http://localhost:0', () => undefined, () => buildDir);

describe('assembleRecipe', () => {
  const resp: RecipeResponse = {
    agent: 'claude-code', buildId: BUILD, version: '9.9.9', confidence: 1, status: 'verified',
    targets: [
      { file: 'webview/index.js', strategy: 'append-shim', pristineSha256: 'a'.repeat(64) },
      { file: 'extension.js', strategy: 'csp-insert', pristineSha256: 'b'.repeat(64) },
    ],
  };

  it('binds our EMBEDDED shim/CSP to the server-attested hashes (data-only delivery)', () => {
    const r = assembleRecipe(resp)!;
    expect(r.buildId).toBe(BUILD);
    expect(r.targets[0]!.pristineSha256).toBe('a'.repeat(64));
    expect(r.targets[1]!.pristineSha256).toBe('b'.repeat(64));
    expect(r.targets[0]!.shim).toContain('data-awaitful-overlay'); // our shim, never from the server
    expect(r.targets[1]!.marker).toBe('awaitful.invalid');
  });

  it('returns undefined when a required target is missing', () => {
    expect(assembleRecipe({ ...resp, targets: [resp.targets[0]!] })).toBeUndefined();
  });
});

describe('RecipeClient self-recipe (trust-on-first-use)', () => {
  it('self-activates a clean unknown build with hashes matching the engine (utf8 sha256)', () => {
    const c = client();
    const r = c.lookup(BUILD)!;
    expect(r).toBeDefined();
    expect(c.isProvisionalActive()).toBe(true);
    // Hashes must be sha256 of the utf8 file contents — exactly what engine.assess() computes.
    expect(r.targets[0]!.pristineSha256).toBe(sha256(WEB));
    expect(r.targets[1]!.pristineSha256).toBe(sha256(EXT));
  });

  it('self-activates from our OWN patch by stripping it to recover pristine (upgrade over a build we patched)', () => {
    // Assemble our real patch shape so we can apply it exactly as the engine would.
    const ours = assembleRecipe({
      agent: 'claude-code', buildId: BUILD, version: '9.9.9', confidence: 1, status: 'verified',
      targets: [
        { file: 'webview/index.js', strategy: 'append-shim', pristineSha256: 'a'.repeat(64) },
        { file: 'extension.js', strategy: 'csp-insert', pristineSha256: 'b'.repeat(64) },
      ],
    })!;
    const webT = ours.targets.find((t) => t.strategy === 'append-shim')!;
    const extT = ours.targets.find((t) => t.strategy === 'csp-insert')!;
    // Both targets carry OUR real patch (as after we applied it, then Claude Code / the extension upgraded).
    fs.writeFileSync(webFile, applyToContent(WEB, webT));
    fs.writeFileSync(extFile, applyToContent(EXT, extT));

    const r = client().lookup(BUILD)!;
    expect(r).toBeDefined();                                 // recognized as ours, NOT "coming soon"
    expect(r.targets[0]!.pristineSha256).toBe(sha256(WEB));  // pristine recovered by stripping our patch...
    expect(r.targets[1]!.pristineSha256).toBe(sha256(EXT));  // ...for both targets, never the patched file
  });

  it('refuses to self-activate from a corrupt/unstrippable own-patch (fail-safe)', () => {
    // Our marker is present but not a well-formed strippable block → cannot recover pristine → unavailable.
    fs.writeFileSync(webFile, `${WEB}\n${MARKER_PREFIX} v9 */ /* AWAITFUL-END */`);
    const c = client();
    expect(c.lookup(BUILD)).toBeUndefined();
    expect(c.isProvisionalActive()).toBe(false);
  });

  it('recovers pristine from a competitor sibling backup so take-over is AVAILABLE (never voting)', () => {
    const c = client();
    expect(c.lookup(BUILD)).toBeDefined(); // clean → self-activates (and would vote clean)

    // A competitor patches the live webview and leaves its own saved original alongside.
    const patched = `${WEB}/* COMPETITOR OVERLAY */`;
    fs.writeFileSync(webFile, patched);
    fs.writeFileSync(`${webFile}.acme-classic-backup`, WEB); // the competitor's backup = genuine pristine
    const r = c.lookup(BUILD)!;
    expect(r).toBeDefined();                                        // AVAILABLE, not "coming soon"
    expect(r.targets[0]!.pristineSha256).toBe(sha256(WEB));         // derived from the BACKUP...
    expect(r.targets[0]!.pristineSha256).not.toBe(sha256(patched)); // ...never the patched live file
    expect(c.isProvisionalActive()).toBe(true);

    // Competitor removed and the file returns to pristine → clean self-activation again.
    fs.rmSync(`${webFile}.acme-classic-backup`);
    fs.writeFileSync(webFile, WEB);
    expect(c.lookup(BUILD)).toBeDefined();
  });

  it('refuses a competitor backup that is not genuine Claude Code (garbage → no take-over, fail-safe)', () => {
    const c = client();
    fs.writeFileSync(webFile, `${WEB}/* COMPETITOR OVERLAY */`);
    fs.writeFileSync(`${webFile}.acme-classic-backup`, 'not a real claude code bundle'); // lacks the anchor
    expect(c.lookup(BUILD)).toBeUndefined();
  });
});

/**
 * Coexistence with a competitor that patches the SAME Claude Code files. Every case here was
 * reachable in the field; the first one actually happened and stranded a user on "Coming soon"
 * with a competitor's ad rendering in the surface we were supposed to own.
 */
describe('RecipeClient coexistence with a competitor patch tool', () => {
  /** Our real patch shape, so tests apply/strip exactly the bytes the engine would. */
  function ourTargets() {
    const r = assembleRecipe({
      agent: 'claude-code', buildId: BUILD, version: '9.9.9', confidence: 1, status: 'verified',
      targets: [
        { file: 'webview/index.js', strategy: 'append-shim', pristineSha256: 'a'.repeat(64) },
        { file: 'extension.js', strategy: 'csp-insert', pristineSha256: 'b'.repeat(64) },
      ],
    })!;
    return {
      webT: r.targets.find((t) => t.strategy === 'append-shim')!,
      extT: r.targets.find((t) => t.strategy === 'csp-insert')!,
    };
  }
  const VIBE = '/* VIBE-ADS-START */;(function(){})();/* VIBE-ADS-END */\n';

  it('recovers pristine through OUR OWN block in a competitor backup (it backed up a file we had already patched)', () => {
    // The field incident, exactly: we patched first, the competitor installed second and saved ITS
    // "original" from our patched file, then wrote its own shim over genuine pristine.
    const { webT } = ourTargets();
    fs.writeFileSync(`${webFile}.kickbacks-backup`, applyToContent(WEB, webT));
    fs.writeFileSync(webFile, WEB + VIBE);

    const r = client().lookup(BUILD);
    expect(r, 'a competitor backup carrying our block must still yield pristine').toBeDefined();
    expect(r!.targets[0]!.pristineSha256).toBe(sha256(WEB)); // stripped back to genuine, not their file
    expect(r!.targets[1]!.pristineSha256).toBe(sha256(EXT));
  });

  it('applying then stripping our patch is byte-exact, so a derived pristine can never be off by one', () => {
    // The take-over writes pristine + our shim and then verifies by stripping. If apply/strip ever
    // stop being exact inverses, a derived pristine would hash wrong and every take-over would roll
    // back in the field - a failure that is invisible in any test that only compares hashes.
    const { webT } = ourTargets();
    const patched = applyToContent(WEB, webT);
    expect(patched.indexOf(MARKER_PREFIX)).toBe(WEB.length + 1); // our own leading newline
    expect(patched.startsWith(WEB)).toBe(true);
  });

  it('refuses a competitor backup carrying TWO of our blocks (double-patched: one strip is not enough)', () => {
    const { webT } = ourTargets();
    fs.writeFileSync(`${webFile}.kickbacks-backup`, applyToContent(applyToContent(WEB, webT), webT));
    fs.writeFileSync(webFile, WEB + VIBE);
    expect(client().lookup(BUILD)).toBeUndefined();
  });

  it('refuses a competitor backup whose Awaitful block is truncated (unstrippable → never guess)', () => {
    fs.writeFileSync(`${webFile}.kickbacks-backup`, `${WEB}\n${MARKER_PREFIX} v25 */\n;(function(){})();`);
    fs.writeFileSync(webFile, WEB + VIBE);
    expect(client().lookup(BUILD)).toBeUndefined();
  });

  it('refuses a competitor backup carrying ours AND another tool block (residue is not pristine)', () => {
    // Stripping ours leaves THEIRS. Nothing downstream can catch this: the recipe hash, the
    // pre-write verify and the health probe would all agree with the contaminated value.
    const { webT } = ourTargets();
    fs.writeFileSync(`${webFile}.kickbacks-backup`, applyToContent(WEB, webT) + VIBE);
    fs.writeFileSync(webFile, WEB + VIBE);
    expect(client().lookup(BUILD)).toBeUndefined();
  });

  it('refuses to self-activate when the LIVE file carries ours AND another tool block', () => {
    // This is the path that produced 49 competitor-contaminated backups on a real machine: strip
    // ours, hash a residue that still contains theirs, store it as "the original".
    const { webT } = ourTargets();
    fs.writeFileSync(webFile, applyToContent(WEB, webT) + VIBE);
    expect(client().lookup(BUILD)).toBeUndefined();
  });

  /**
   * Vote eligibility must key on a foreign marker in the LIVE bytes, not on a leftover backup file.
   * A competitor's sibling backup outlives the competitor: it survives its uninstall AND our
   * take-over, so keying on it disenfranchised a machine permanently. On one real fleet this made
   * more than half of all patch reports unable to vote, which is why no build ever reached quorum.
   */
  it('votes clean when the live files are clean, even with a competitor backup still on disk', () => {
    const { webT } = ourTargets();
    fs.writeFileSync(`${webFile}.kickbacks-backup`, applyToContent(WEB, webT)); // their leftover
    fs.writeFileSync(webFile, WEB);                                            // ours took over, file is clean
    fs.writeFileSync(extFile, EXT);

    const posted: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((_u: string, init?: { body?: string }) => {
      if (init?.body) posted.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;

    try {
      client().report('applied');
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(posted).toHaveLength(1);
    expect((posted[0] as { clean: boolean }).clean).toBe(true);
  });

  it('votes NOT clean while another tool block is actually in the live file', () => {
    fs.writeFileSync(webFile, WEB + VIBE);
    fs.writeFileSync(extFile, EXT);

    const posted: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((_u: string, init?: { body?: string }) => {
      if (init?.body) posted.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;

    try {
      client().report('conflict');
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(posted).toHaveLength(1);
    expect((posted[0] as { clean: boolean }).clean).toBe(false);
  });

  it('still self-activates cleanly once the competitor block is gone', () => {
    const { webT } = ourTargets();
    fs.writeFileSync(webFile, applyToContent(WEB, webT) + VIBE);
    expect(client().lookup(BUILD)).toBeUndefined();
    fs.writeFileSync(webFile, applyToContent(WEB, webT)); // competitor evicted by a take-over
    const r = client().lookup(BUILD);
    expect(r).toBeDefined();
    expect(r!.targets[0]!.pristineSha256).toBe(sha256(WEB));
  });
});
