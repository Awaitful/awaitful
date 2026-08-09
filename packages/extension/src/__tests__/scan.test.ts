import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanTargets, anyForeignInFile, anyOurs, anyNewerThanOurs, TARGET_FILES } from '../patch/scan.js';
import { MARKER_PREFIX, SHIM_VERSION } from '../patch/recipe.js';
import type { ClaudeTarget } from '../patch/targets.js';

/**
 * Scanning exists to answer "who is holding Claude Code's files" WITHOUT a recipe. That question
 * used to be asked only after a recipe resolved - so a competitor, which is precisely what breaks
 * recipe resolution, was invisible, and the panel blamed the Claude Code version for another
 * tool's edit. Every test here pins that the answer needs no recipe and no hash.
 */
const BUILD = 'anthropic.claude-code-9.9.9-darwin-x64';
const WEB = 'cc webview bundle\n';
const EXT = 'cc extension host\n';

let root: string, target: ClaudeTarget, webFile: string, extFile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awaitful-scan-'));
  const dir = path.join(root, BUILD);
  fs.mkdirSync(path.join(dir, 'webview'), { recursive: true });
  webFile = path.join(dir, 'webview', 'index.js');
  extFile = path.join(dir, 'extension.js');
  fs.writeFileSync(webFile, WEB);
  fs.writeFileSync(extFile, EXT);
  target = { dir, version: '9.9.9', buildId: BUILD, webviewFile: webFile };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('scanTargets', () => {
  it('reads both targets with no recipe and no hashing', () => {
    const scans = scanTargets(target);
    expect(scans.map((s) => s.file)).toEqual([...TARGET_FILES]);
    expect(scans.every((s) => s.readable)).toBe(true);
    expect(anyOurs(scans)).toBe(false);
    expect(anyForeignInFile(scans)).toBeUndefined();
  });

  it('reports a foreign token from the file bytes alone', () => {
    fs.writeFileSync(webFile, `${WEB}/* VIBE-ADS-START */x();/* VIBE-ADS-END */\n`);
    const hit = anyForeignInFile(scanTargets(target));
    expect(hit?.foreignToken).toBe('VIBE-ADS');
  });

  it('parses our own shim version off the on-disk marker', () => {
    fs.writeFileSync(webFile, `${WEB}\n${MARKER_PREFIX} v${SHIM_VERSION} */x();/* AWAITFUL-END */\n`);
    const scans = scanTargets(target);
    expect(scans[0]!.ours).toBe('current');
    expect(scans[0]!.oursVersion).toBe(SHIM_VERSION);
    expect(anyNewerThanOurs(scans)).toBe(false);
  });

  it('flags an on-disk shim NEWER than this build, so the older window stands down', () => {
    // Two windows on different extension versions otherwise rewrite a multi-megabyte bundle at each
    // other forever: neither ever sees the file as modified, so no reclaim budget bounds it.
    fs.writeFileSync(webFile, `${WEB}\n${MARKER_PREFIX} v${SHIM_VERSION + 1} */x();/* AWAITFUL-END */\n`);
    const scans = scanTargets(target);
    expect(scans[0]!.ours).toBe('newer');
    expect(anyNewerThanOurs(scans)).toBe(true);
  });

  it('reports an older shim as older', () => {
    fs.writeFileSync(webFile, `${WEB}\n${MARKER_PREFIX} v1 */x();/* AWAITFUL-END */\n`);
    expect(scanTargets(target)[0]!.ours).toBe('older');
  });

  it('records errno so the copy can distinguish a mid-update from a permissions problem', () => {
    fs.rmSync(extFile);
    const scans = scanTargets(target);
    const ext = scans.find((s) => s.file === 'extension.js')!;
    expect(ext.readable).toBe(false);
    expect(ext.errno).toBe('ENOENT');
  });

  it('a sibling backup never sets a foreign IN-FILE flag', () => {
    // The split that matters: a leftover backup proves a tool once ran here; only an in-file marker
    // proves the bytes are modified NOW. Conflating them accuses a clean machine.
    fs.writeFileSync(`${webFile}.acme-backup`, WEB);
    const scans = scanTargets(target);
    expect(scans[0]!.siblingBackup).toContain('.acme-backup');
    expect(scans[0]!.foreignToken).toBeUndefined();
    expect(anyForeignInFile(scans)).toBeUndefined();
  });

  it('never treats our own marker as foreign', () => {
    fs.writeFileSync(webFile, `${WEB}\n${MARKER_PREFIX} v${SHIM_VERSION} */x();/* AWAITFUL-END */\n`);
    expect(anyForeignInFile(scanTargets(target))).toBeUndefined();
  });

  it('never throws on a missing build directory', () => {
    fs.rmSync(path.join(root, BUILD), { recursive: true, force: true });
    expect(() => scanTargets(target)).not.toThrow();
    expect(scanTargets(target).every((s) => !s.readable)).toBe(true);
  });
});
