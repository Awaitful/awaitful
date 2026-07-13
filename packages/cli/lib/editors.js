'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Editor support is DATA. Supporting a new editor is one entry here - the detection, the picker,
 * the install flow and `status` all render whatever this table says, and nothing else in the
 * package names an editor.
 *
 * `source` is informational honesty for the user: VS Code family resolves extension ids against
 * the VS Code Marketplace; Cursor, Windsurf and VSCodium resolve against Open VSX. Awaitful is
 * published to both, which is exactly why this installer never needs to know a version or URL.
 */

/**
 * @typedef {object} EditorDef
 * @property {string} id       stable value for the --editor flag
 * @property {string} name     what the user calls it
 * @property {string[]} bins   CLI names to try on PATH, in order
 * @property {string[]} macPaths  absolute app-bundle CLI paths (also tried under ~ for
 *                                per-user installs)
 * @property {string[]} winPaths  install paths relative to %LOCALAPPDATA%
 * @property {'VS Code Marketplace' | 'Open VSX'} source
 */

/** @type {EditorDef[]} */
const EDITORS = [
  {
    id: 'code',
    name: 'VS Code',
    bins: ['code'],
    macPaths: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
    winPaths: ['Programs/Microsoft VS Code/bin/code.cmd'],
    source: 'VS Code Marketplace',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    bins: ['cursor'],
    macPaths: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
    winPaths: ['Programs/cursor/resources/app/bin/cursor.cmd'],
    source: 'Open VSX',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    bins: ['windsurf'],
    macPaths: ['/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf'],
    winPaths: ['Programs/Windsurf/bin/windsurf.cmd'],
    source: 'Open VSX',
  },
  {
    id: 'codium',
    name: 'VSCodium',
    bins: ['codium', 'vscodium'],
    macPaths: ['/Applications/VSCodium.app/Contents/Resources/app/bin/codium'],
    winPaths: ['Programs/VSCodium/bin/codium.cmd'],
    source: 'Open VSX',
  },
  {
    id: 'code-insiders',
    name: 'VS Code Insiders',
    bins: ['code-insiders'],
    macPaths: ['/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders'],
    winPaths: ['Programs/Microsoft VS Code Insiders/bin/code-insiders.cmd'],
    source: 'VS Code Marketplace',
  },
];

/**
 * Every command worth probing for one editor: bare bin names first (PATH wins - it is what the
 * user chose), then the platform's known install locations for when the shell command was never
 * set up (the most common miss on Macs). Pure, so the per-platform lists are unit-testable.
 *
 * @param {EditorDef} editor
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function candidatesFor(editor, platform, env) {
  const candidates = [...editor.bins];
  if (platform === 'darwin') {
    const home = env['HOME'];
    for (const appPath of editor.macPaths) {
      candidates.push(appPath);
      // Per-user installs live under ~/Applications; path.join drops the leading slash for us.
      if (home) candidates.push(path.join(home, appPath));
    }
  }
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'];
    if (base) {
      for (const rel of editor.winPaths) candidates.push(path.join(base, rel));
    }
  }
  return candidates;
}

/**
 * Ask a candidate to identify itself. `--version` both confirms the CLI actually runs (not merely
 * exists) and gives `status` something informative to print. Windows needs a shell to resolve
 * .cmd shims; paths with spaces get quoted for it.
 *
 * @param {string} command
 * @returns {{ ok: boolean; version: string | null }}
 */
function probe(command) {
  const shell = process.platform === 'win32';
  const cmd = shell && command.includes(' ') ? `"${command}"` : command;
  const res = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell, timeout: 10_000 });
  if (res.error || res.status !== 0) return { ok: false, version: null };
  const version = (res.stdout || '').trim().split('\n')[0] || null;
  return { ok: true, version };
}

/**
 * @typedef {object} FoundEditor
 * @property {EditorDef} editor
 * @property {string} command   the exact command that answered --version; used for everything after
 * @property {string | null} version
 */

/**
 * Walk the table, first answering candidate wins per editor. The probe is injectable so tests can
 * simulate any machine without one.
 *
 * @param {{ probe?: typeof probe; platform?: NodeJS.Platform; env?: Record<string, string | undefined> }} [opts]
 * @returns {FoundEditor[]}
 */
function detectEditors(opts = {}) {
  const probeFn = opts.probe ?? probe;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  /** @type {FoundEditor[]} */
  const found = [];
  for (const editor of EDITORS) {
    for (const candidate of candidatesFor(editor, platform, env)) {
      // Absolute candidates are checked on disk before spawning; bare names are for PATH to judge.
      const isPath = candidate.includes('/') || candidate.includes('\\');
      if (isPath && !fs.existsSync(candidate)) continue;
      const res = probeFn(candidate);
      if (res.ok) {
        found.push({ editor, command: candidate, version: res.version });
        break;
      }
    }
  }
  return found;
}

module.exports = { EDITORS, candidatesFor, probe, detectEditors };
