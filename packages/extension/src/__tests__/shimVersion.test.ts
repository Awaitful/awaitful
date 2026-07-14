import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHIM_VERSION } from '../patch/recipe.js';

/**
 * The lesson this test encodes (2026-07-13): the shim was changed three times without bumping
 * SHIM_VERSION, and every already-patched machine silently kept the OLD shim - the engine's
 * idempotency marker is `AWAITFUL-START v<SHIM_VERSION>`, so "same version" reads as "current
 * patch, nothing to do". The fixes shipped, installed, and never ran.
 *
 * The rule: any change to recipe.ts (the shim, its themes, its selectors - all of it becomes the
 * PATCHED BYTES) requires a SHIM_VERSION bump so 'ours-stale' triggers restore + re-apply.
 *
 * Mechanism: a lock file pairs the current SHIM_VERSION with a hash of recipe.ts (version line
 * normalized out). Change the file without bumping -> same version, different hash -> this fails.
 * Bump the version -> the lock updates itself on the next test run.
 */
const RECIPE_PATH = join(__dirname, '..', 'patch', 'recipe.ts');
const LOCK_PATH = join(__dirname, 'shim-version.lock.json');

function currentHash(): string {
  const source = readFileSync(RECIPE_PATH, 'utf8')
    // Normalize the version line itself, so bumping the number is what unlocks a new hash.
    .replace(/export const SHIM_VERSION = \d+;/, 'export const SHIM_VERSION = X;');
  return createHash('sha256').update(source).digest('hex');
}

describe('shim versioning', () => {
  it('recipe.ts cannot change without a SHIM_VERSION bump', () => {
    const hash = currentHash();

    if (!existsSync(LOCK_PATH)) {
      writeFileSync(LOCK_PATH, JSON.stringify({ shimVersion: SHIM_VERSION, sha256: hash }, null, 2) + '\n');
      return;
    }

    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { shimVersion: number; sha256: string };

    if (SHIM_VERSION !== lock.shimVersion) {
      // A bump: re-lock at the new version. Moving backwards is the one direction that is a bug.
      expect(SHIM_VERSION, 'SHIM_VERSION must only ever increase').toBeGreaterThan(lock.shimVersion);
      writeFileSync(LOCK_PATH, JSON.stringify({ shimVersion: SHIM_VERSION, sha256: hash }, null, 2) + '\n');
      return;
    }

    expect(
      hash,
      `patch/recipe.ts changed but SHIM_VERSION is still ${SHIM_VERSION}. ` +
        'Already-patched machines will keep the OLD shim forever (the idempotency marker embeds ' +
        'the version, so "same version" means "nothing to re-apply"). Bump SHIM_VERSION.',
    ).toBe(lock.sha256);
  });
});
