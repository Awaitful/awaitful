#!/usr/bin/env node
'use strict';
// @ts-check

/**
 * npx awaitful - install the Awaitful extension into your editor.
 *
 * This file is orchestration only; the logic lives in lib/ and is unit-tested there. The whole
 * package is deliberately small enough to read before you run it: it detects your editor, runs
 * `<editor> --install-extension awaitful.awaitful`, and nothing else. Your editor downloads the
 * extension from its own marketplace; this installer never touches the network (enforced by
 * test/receipts.test.js).
 */

// Before anything else: a clear sentence beats the TypeError an older Node would throw the
// moment parseArgs is touched. Everything below may assume Node 18+.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(`awaitful needs Node 18 or newer; this is Node ${process.versions.node}.`);
  console.error('Upgrade Node, or install the extension by hand:');
  console.error('  https://marketplace.visualstudio.com/items?itemName=awaitful.awaitful');
  process.exit(1);
}

const { parseArgs } = require('node:util');
const { detectEditors, EDITORS } = require('../lib/editors');
const { chooseTargets, displayCommand, installInto, extensionStatus } = require('../lib/install');
const { bold, dim, green, red, ask } = require('../lib/ui');

const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=awaitful.awaitful';
const OPEN_VSX_URL = 'https://open-vsx.org/extension/awaitful/awaitful';

const USAGE = `${bold('awaitful')} - install the Awaitful extension into your editor

${bold('Usage')}
  npx awaitful              install into a detected editor
  npx awaitful status       show where Awaitful is installed

${bold('Options')}
  --editor <id>   pick the editor without a prompt (${EDITORS.map(e => e.id).join(', ')})
  --all           install into every detected editor
  --dry-run       print the exact commands without running anything
  -v, --version   print this installer's version
  -h, --help      show this help

The installer runs \`<editor> --install-extension awaitful.awaitful\` and nothing else.
It makes no network requests of its own; your editor downloads the extension from its
own marketplace. Read the source: https://github.com/Awaitful/awaitful
`;

function printNoEditors() {
  console.error('No supported editor was found on this machine.');
  console.error(`Looked for: ${EDITORS.map(e => e.name).join(', ')}.`);
  console.error('');
  console.error('You can install the extension by hand instead:');
  console.error(`  VS Code:                      ${MARKETPLACE_URL}`);
  console.error(`  Cursor, Windsurf, VSCodium:   ${OPEN_VSX_URL}`);
}

/**
 * @param {import('../lib/editors').FoundEditor} found
 * @returns {string}
 */
function editorLabel(found) {
  return found.version ? `${found.editor.name} ${dim(`(${found.version})`)}` : found.editor.name;
}

/** @param {import('../lib/editors').FoundEditor[]} found */
async function promptForTargets(found) {
  console.log('Found more than one editor.');
  found.forEach((f, i) => console.log(`  ${i + 1}. ${editorLabel(f)}`));
  console.log('  a. All of them');
  const answer = await ask('Install into [1]: ');
  if (answer === '') {
    const first = found[0];
    return first ? [first] : [];
  }
  if (answer.toLowerCase() === 'a') return found;
  const index = Number.parseInt(answer, 10);
  const hit = Number.isInteger(index) ? found[index - 1] : undefined;
  if (!hit) {
    console.error(`Not an option: "${answer}". Answer with a number from the list, or "a".`);
    process.exit(2);
  }
  return [hit];
}

/** @param {import('../lib/editors').FoundEditor[]} found */
function runStatus(found) {
  if (found.length === 0) {
    printNoEditors();
    process.exit(1);
  }
  for (const f of found) {
    const s = extensionStatus(f);
    const state = s.installed ? green(`Awaitful ${s.version} installed`) : dim('not installed');
    console.log(`  ${editorLabel(f)}: ${state}`);
  }
}

/**
 * @param {import('../lib/editors').FoundEditor[]} targets
 * @param {{ dryRun: boolean }} opts
 */
function runInstall(targets, opts) {
  if (opts.dryRun) {
    console.log('Would run:');
    for (const t of targets) console.log(`  ${displayCommand(t)}`);
    return;
  }

  let failures = 0;
  for (const t of targets) {
    console.log(`${bold(t.editor.name)}: ${dim(displayCommand(t))}`);
    const res = installInto(t);
    if (res.ok) {
      console.log(`${t.editor.name}: ${green('installed')}`);
    } else {
      failures += 1;
      const why = res.reason ?? `exit code ${res.status ?? 'unknown'}; the editor's own output is above`;
      console.error(`${t.editor.name}: ${red('install failed')} (${why}).`);
      const manual = t.editor.source === 'VS Code Marketplace' ? MARKETPLACE_URL : OPEN_VSX_URL;
      console.error(`You can install it from the editor's Extensions view (search "Awaitful"),`);
      console.error(`or from the marketplace directly: ${manual}`);
    }
  }

  if (failures === 0) {
    console.log('');
    console.log(bold('Done. One step left:'));
    console.log('  Open your editor and run "Awaitful: Sign In" from the Command Palette');
    console.log('  (Cmd+Shift+P / Ctrl+Shift+P).');
    console.log('');
    console.log('  Then let your agent think. You earn a share of what advertisers pay.');
    console.log(`  ${dim('https://awaitful.com')}`);
  } else {
    process.exit(1);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        editor: { type: 'string' },
        all: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('');
    console.error(USAGE);
    process.exit(2);
  }

  const { values, positionals } = parsed;

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log(/** @type {{ version: string }} */ (require('../package.json')).version);
    return;
  }

  const command = positionals[0];
  if (command !== undefined && command !== 'status') {
    console.error(`Unknown command: "${command}".`);
    console.error('');
    console.error(USAGE);
    process.exit(2);
  }

  if (values.editor !== undefined && !EDITORS.some(e => e.id === values.editor)) {
    console.error(`Unknown editor: "${values.editor}". Editors: ${EDITORS.map(e => e.id).join(', ')}.`);
    process.exit(2);
  }

  const found = detectEditors();

  if (command === 'status') {
    runStatus(found);
    return;
  }

  const choice = chooseTargets(found, {
    editor: values.editor,
    all: values.all === true,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });

  if (choice.kind === 'error') {
    if (choice.reason === 'none-found') {
      printNoEditors();
    } else if (choice.reason === 'not-detected') {
      console.error(`${values.editor} is supported but was not found on this machine.`);
      console.error(`Detected: ${found.map(f => f.editor.id).join(', ') || 'none'}.`);
      console.error('If it is installed, its command line tool is probably not on your PATH;');
      console.error('in the editor, run "Shell Command: Install ... command in PATH" from the Command Palette.');
    } else {
      console.error('More than one editor was found, and there is no terminal to ask in.');
      found.forEach(f => console.error(`  --editor ${f.editor.id}   (${f.editor.name})`));
      console.error('Pick one with --editor, or use --all.');
    }
    process.exit(choice.reason === 'none-found' ? 1 : 2);
  }

  const targets = choice.kind === 'prompt' ? await promptForTargets(found) : choice.targets;
  runInstall(targets, { dryRun: values['dry-run'] === true });
}

main().catch(err => {
  // An unexpected crash is OUR bug until proven otherwise: say so, and say where to report it.
  console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  console.error('');
  console.error('This looks like a bug in the installer, not in your setup.');
  console.error('Please report it: https://github.com/Awaitful/awaitful/issues');
  console.error('Meanwhile you can install by hand: search "Awaitful" in your editor\'s Extensions view.');
  process.exit(1);
});
