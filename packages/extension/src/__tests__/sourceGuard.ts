import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Reading source in a test, on purpose.
 *
 * Some invariants in this extension live in code that no test can construct: the Orchestrator needs
 * the whole VS Code API, and the panel's client script is a string. An invariant nobody can check is
 * one that quietly stops holding, so where behaviour cannot be exercised the ORDER and SHAPE of the
 * code is asserted instead. It is a weaker guarantee than running the thing, and it is a much
 * stronger one than a comment asking the next person to be careful.
 *
 * Prefer a real test whenever the code can be called. Reach for this only when it cannot.
 */

/** Source of a file under packages/extension/src, by path relative to that directory. */
export const src = (p: string): string =>
  fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/**
 * Comments removed, so assertions read CODE.
 *
 * Not optional: a doc block explaining why a call was REMOVED contains the call's name, and reads
 * to a substring match exactly like the call still being there. Every guard here was written against
 * a first draft that passed for that reason.
 */
export const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** A named function or method's body, brace-balanced from its opening `{`, comments stripped. */
export function methodBody(source: string, signature: string): string {
  const at = source.indexOf(signature);
  if (at < 0) throw new Error(`${signature} no longer exists`);
  let i = source.indexOf('{', at);
  const start = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return stripComments(source.slice(start, i + 1));
  }
  throw new Error(`unbalanced braces after ${signature}`);
}
