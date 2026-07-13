'use strict';
// @ts-check

/**
 * Terminal niceties, dependency-free. Color switches off when output is not a TTY, when NO_COLOR
 * is set (https://no-color.org), or when TERM=dumb - the standard trio. Everything degrades to
 * plain text, so piping the output never captures escape codes.
 */

const useColor =
  Boolean(process.stdout.isTTY) &&
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb';

/** @param {string} code @returns {(text: string) => string} */
function paint(code) {
  return text => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
}

const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');

/**
 * One question, one line, trimmed.
 * @param {string} question
 * @returns {Promise<string>}
 */
function ask(question) {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

module.exports = { bold, dim, green, red, ask };
