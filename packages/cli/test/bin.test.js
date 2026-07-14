'use strict';
// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const BIN = path.join(__dirname, '..', 'bin', 'awaitful.js');

/**
 * Run the bin non-interactively (no TTY in a child by construction) and capture everything.
 * @param {string[]} args
 * @returns {{ status: number; stdout: string; stderr: string }}
 */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = /** @type {{ status?: number; stdout?: string; stderr?: string }} */ (err);
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('--help prints usage and exits 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage/);
  assert.match(res.stdout, /--dry-run/);
  assert.match(res.stdout, /no network requests/);
});

test('--version prints the package version and exits 0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const res = run(['--version']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), pkg.version);
});

test('an unknown flag is a usage error: exit 2, usage on stderr', () => {
  const res = run(['--frobnicate']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage/);
});

test('an unknown command is a usage error too', () => {
  const res = run(['install-everything']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown command/);
});

test('an unknown --editor value names the valid ones', () => {
  const res = run(['--editor', 'emacs']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown editor/);
  assert.match(res.stderr, /code, cursor, devin, codium, code-insiders/);
});

test('help output carries no em dash', () => {
  const res = run(['--help']);
  assert.ok(!res.stdout.includes('—'));
});
