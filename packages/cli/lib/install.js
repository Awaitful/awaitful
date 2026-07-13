'use strict';
// @ts-check
const { spawnSync } = require('node:child_process');

/**
 * The one constant this package hardcodes. The id is immutable by definition (publisher.name on
 * both registries), and it is the whole reason the installer never needs updating when the
 * extension does: the editor resolves it against its own marketplace and pulls the latest.
 */
const EXTENSION_ID = 'awaitful.awaitful';

const INSTALL_ARGS = ['--install-extension', EXTENSION_ID];

/**
 * Decide which detected editors to install into. Pure - the caller owns all messaging - and the
 * rules are boring on purpose: --all wins, --editor picks one, a single detection needs no
 * choosing, several without a TTY is an error (a script cannot answer a prompt), several with a
 * TTY asks.
 *
 * @param {import('./editors').FoundEditor[]} found
 * @param {{ editor: string | undefined; all: boolean; interactive: boolean }} flags
 * @returns {{ kind: 'targets'; targets: import('./editors').FoundEditor[] }
 *   | { kind: 'prompt' }
 *   | { kind: 'error'; reason: 'none-found' | 'not-detected' | 'ambiguous' }}
 */
function chooseTargets(found, flags) {
  if (found.length === 0) return { kind: 'error', reason: 'none-found' };
  if (flags.all) return { kind: 'targets', targets: found };
  if (flags.editor !== undefined) {
    const hit = found.find(f => f.editor.id === flags.editor);
    if (!hit) return { kind: 'error', reason: 'not-detected' };
    return { kind: 'targets', targets: [hit] };
  }
  const only = found[0];
  if (found.length === 1 && only) return { kind: 'targets', targets: [only] };
  if (!flags.interactive) return { kind: 'error', reason: 'ambiguous' };
  return { kind: 'prompt' };
}

/**
 * The command as the user would type it themselves - printed by --dry-run and before every real
 * run, because an installer that shows its exact command before running it has nothing to hide.
 *
 * @param {import('./editors').FoundEditor} found
 * @returns {string}
 */
function displayCommand(found) {
  const cmd = found.command.includes(' ') ? `"${found.command}"` : found.command;
  return `${cmd} ${INSTALL_ARGS.join(' ')}`;
}

/**
 * Run the install with the editor's output streaming straight through (stdio inherit): failures
 * arrive in the editor's own words, not ours. Success is ONLY exit code 0. When the process
 * could not run at all (timeout, binary vanished between detection and now), the underlying
 * reason comes back too - "exit code unknown" explains nothing.
 *
 * @param {import('./editors').FoundEditor} found
 * @returns {{ ok: boolean; status: number | null; reason: string | null }}
 */
function installInto(found) {
  const shell = process.platform === 'win32';
  const cmd = shell && found.command.includes(' ') ? `"${found.command}"` : found.command;
  const res = spawnSync(cmd, INSTALL_ARGS, { stdio: 'inherit', shell, timeout: 300_000 });
  const reason =
    res.error === undefined
      ? null
      : /** @type {NodeJS.ErrnoException} */ (res.error).code === 'ETIMEDOUT'
        ? 'the editor did not finish within 5 minutes'
        : res.error.message;
  return { ok: res.status === 0, status: res.status, reason };
}

/**
 * Find our extension in `--list-extensions --show-versions` output (`publisher.name@version`,
 * one per line).
 *
 * @param {string} output
 * @returns {string | null} the installed version, or null
 */
function parseInstalledVersion(output) {
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^awaitful\.awaitful@(.+)$/i);
    const version = match?.[1];
    if (version) return version;
  }
  return null;
}

/**
 * Is Awaitful installed in this editor, and at what version?
 *
 * @param {import('./editors').FoundEditor} found
 * @returns {{ installed: boolean; version: string | null }}
 */
function extensionStatus(found) {
  const shell = process.platform === 'win32';
  const cmd = shell && found.command.includes(' ') ? `"${found.command}"` : found.command;
  const res = spawnSync(cmd, ['--list-extensions', '--show-versions'], {
    encoding: 'utf8',
    shell,
    timeout: 60_000,
  });
  if (res.error || res.status !== 0) return { installed: false, version: null };
  const version = parseInstalledVersion(res.stdout || '');
  return { installed: version !== null, version };
}

module.exports = { EXTENSION_ID, chooseTargets, displayCommand, installInto, parseInstalledVersion, extensionStatus };
