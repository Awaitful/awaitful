'use strict';
// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The receipts. The npm README claims the installer makes no network calls of its own - the editor
 * does the downloading through its own marketplace channel. This test is that claim, enforced: it
 * fails the build the day anyone adds a network primitive to the shipped source. Same move as the
 * extension's egress-whitelist test, and it is linked from the README so a skeptic can read it.
 */
const SHIPPED_DIRS = ['bin', 'lib'];
const NETWORK_PRIMITIVES = [
  /\bfetch\s*\(/,
  /node:https?\b/,
  /require\(\s*['"]https?['"]\s*\)/,
  /node:net\b/,
  /node:dgram\b/,
  /node:tls\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
];

function shippedSources() {
  const root = path.join(__dirname, '..');
  /** @type {{ file: string; source: string }[]} */
  const out = [];
  for (const dir of SHIPPED_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs, { recursive: true })) {
      const file = path.join(abs, String(name));
      if (fs.statSync(file).isFile() && file.endsWith('.js')) {
        out.push({ file: path.relative(root, file), source: fs.readFileSync(file, 'utf8') });
      }
    }
  }
  return out;
}

test('the shipped source contains no network primitives', () => {
  const sources = shippedSources();
  assert.ok(sources.length > 0, 'no shipped sources found - the scan is looking in the wrong place');
  for (const { file, source } of sources) {
    for (const pattern of NETWORK_PRIMITIVES) {
      assert.ok(!pattern.test(source), `${file} matches ${pattern} - the installer must not talk to the network`);
    }
  }
});

test('the shipped source pulls in no dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'the installer is dependency-free on purpose; do not add any');
});

test('the bin runs and speaks', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'awaitful.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.match(out, /awaitful/i);
});
