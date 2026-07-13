'use strict';
// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EDITORS } = require('../lib/editors');
const { EXTENSION_ID, chooseTargets, displayCommand, parseInstalledVersion } = require('../lib/install');

/**
 * @param {string} id
 * @returns {import('../lib/editors').FoundEditor}
 */
function found(id) {
  const editor = EDITORS.find(e => e.id === id);
  assert.ok(editor, `no such editor in the table: ${id}`);
  return { editor, command: editor.bins[0] ?? id, version: '1.0.0' };
}

test('the extension id is the one hardcoded constant, and it is the published one', () => {
  assert.equal(EXTENSION_ID, 'awaitful.awaitful');
});

test('chooseTargets: the boring rules, all of them', () => {
  const code = found('code');
  const cursor = found('cursor');

  assert.deepEqual(chooseTargets([], { editor: undefined, all: false, interactive: true }), {
    kind: 'error',
    reason: 'none-found',
  });

  assert.deepEqual(chooseTargets([code], { editor: undefined, all: false, interactive: false }), {
    kind: 'targets',
    targets: [code],
  });

  assert.deepEqual(chooseTargets([code, cursor], { editor: undefined, all: true, interactive: false }), {
    kind: 'targets',
    targets: [code, cursor],
  });

  assert.deepEqual(chooseTargets([code, cursor], { editor: 'cursor', all: false, interactive: false }), {
    kind: 'targets',
    targets: [cursor],
  });

  assert.deepEqual(chooseTargets([code], { editor: 'windsurf', all: false, interactive: true }), {
    kind: 'error',
    reason: 'not-detected',
  });

  // Two editors, no terminal to ask in: an error, never a guess.
  assert.deepEqual(chooseTargets([code, cursor], { editor: undefined, all: false, interactive: false }), {
    kind: 'error',
    reason: 'ambiguous',
  });

  assert.deepEqual(chooseTargets([code, cursor], { editor: undefined, all: false, interactive: true }), {
    kind: 'prompt',
  });
});

test('displayCommand shows exactly what will run, quoting paths with spaces', () => {
  assert.equal(displayCommand(found('code')), 'code --install-extension awaitful.awaitful');

  const editor = EDITORS.find(e => e.id === 'code');
  assert.ok(editor);
  const appBundle = {
    editor,
    command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    version: null,
  };
  assert.equal(
    displayCommand(appBundle),
    '"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension awaitful.awaitful',
  );
});

test('parseInstalledVersion finds our extension and nothing else', () => {
  const listing = [
    'ms-python.python@2026.6.0',
    'awaitful.awaitful@0.7.1',
    'dbaeumer.vscode-eslint@3.0.10',
  ].join('\n');
  assert.equal(parseInstalledVersion(listing), '0.7.1');

  assert.equal(parseInstalledVersion('ms-python.python@2026.6.0\n'), null);
  assert.equal(parseInstalledVersion(''), null);
  // A different publisher squatting a similar name must not count.
  assert.equal(parseInstalledVersion('notawaitful.awaitful@9.9.9'), null);
  // Case-insensitive, as editor listings are on some platforms.
  assert.equal(parseInstalledVersion('Awaitful.Awaitful@1.2.3'), '1.2.3');
});
