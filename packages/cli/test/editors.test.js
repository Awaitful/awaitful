'use strict';
// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EDITORS, candidatesFor, detectEditors } = require('../lib/editors');

test('the editor table is coherent', () => {
  const ids = EDITORS.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'editor ids must be unique');

  for (const editor of EDITORS) {
    assert.match(editor.id, /^[a-z][a-z-]*$/, `${editor.id}: ids are lowercase kebab (they are flag values)`);
    assert.ok(editor.name.length > 0);
    assert.ok(editor.bins.length > 0, `${editor.id}: needs at least one PATH binary to probe`);
    assert.ok(['VS Code Marketplace', 'Open VSX'].includes(editor.source));
  }

  const allBins = EDITORS.flatMap(e => e.bins);
  assert.equal(new Set(allBins).size, allBins.length, 'a binary name in two entries would double-install');
});

test('candidatesFor puts PATH first, then platform install locations', () => {
  const code = EDITORS.find(e => e.id === 'code');
  assert.ok(code);

  const mac = candidatesFor(code, 'darwin', { HOME: '/Users/dev' });
  assert.equal(mac[0], 'code', 'the PATH binary is always tried first: it is what the user chose');
  assert.ok(mac.some(c => c === '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'));
  assert.ok(
    mac.some(c => c.startsWith('/Users/dev/') && c.includes('Visual Studio Code.app')),
    'per-user installs under ~/Applications are probed too',
  );

  const win = candidatesFor(code, 'win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' });
  assert.ok(win.some(c => c.endsWith('code.cmd')), 'Windows probes the .cmd shim in LOCALAPPDATA');

  const linux = candidatesFor(code, 'linux', {});
  assert.deepEqual(linux, ['code'], 'no hardcoded install paths outside mac/win: PATH is the contract');
});

test('missing platform env vars degrade to PATH-only, never throw', () => {
  const code = EDITORS.find(e => e.id === 'code');
  assert.ok(code);
  assert.deepEqual(candidatesFor(code, 'darwin', {}), ['code', ...code.macPaths]);
  assert.deepEqual(candidatesFor(code, 'win32', {}), ['code']);
});

test('detectEditors reports exactly what the probe confirms', () => {
  /** @param {string} command */
  const onlyCursor = command =>
    command === 'cursor' ? { ok: true, version: '0.45.1' } : { ok: false, version: null };

  const found = detectEditors({ probe: onlyCursor, platform: 'linux', env: {} });

  assert.equal(found.length, 1);
  const hit = found[0];
  assert.ok(hit);
  assert.equal(hit.editor.id, 'cursor');
  assert.equal(hit.command, 'cursor');
  assert.equal(hit.version, '0.45.1');
});

test('detectEditors stops at the first answering candidate per editor', () => {
  /** @type {string[]} */
  const probed = [];
  /** @param {string} command */
  const alwaysOk = command => {
    probed.push(command);
    return { ok: true, version: '1.0.0' };
  };

  const found = detectEditors({ probe: alwaysOk, platform: 'linux', env: {} });

  assert.equal(found.length, EDITORS.length, 'every editor detected when everything answers');
  // codium has two candidate bins; only the first should ever have been spawned.
  assert.ok(probed.includes('codium'));
  assert.ok(!probed.includes('vscodium'));
});
