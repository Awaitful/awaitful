import { describe, it, expect, vi } from 'vitest';
import type { PatchState } from '../patch/engine.js';
import { BLOCKED_BY_STATE } from '../core/orchestrator.js';

vi.mock('vscode', () => ({
  window: {}, commands: {}, workspace: { getConfiguration: () => ({ get: () => undefined }) },
  Uri: {}, ViewColumn: {}, StatusBarAlignment: {}, extensions: { all: [] },
}));


/**
 * Every state in which a format CANNOT run must map to a reason the panel has guidance for.
 *
 * `no-target` did not, and the cost was concrete: it fell through to 'unsupported-build', which
 * blames the Claude Code version - for a machine where Claude Code's files are simply not there -
 * and which is the one reason the guidance box deliberately ignores. So the repair checklist went
 * blank at step two, the exact moment it had two steps left to give, twice in a row.
 *
 * The failure mode is a lookup table that did not grow with its enum, which no type checker catches:
 * the map is Partial by design, because the healthy states genuinely have no reason.
 */
const HEALTHY: PatchState[] = ['clean-pristine', 'our-patch-present', 'our-patch-stale'];

const ALL: PatchState[] = [
  'no-target', 'foreign-only', 'ours-plus-foreign', 'ours-plus-unknown', 'unknown-modified',
  'unreadable', 'ours-unverified', 'no-recipe', 'clean-pristine', 'our-patch-present',
  'our-patch-stale',
];

describe('every unhealthy patch state has an honest blocked reason', () => {
  it.each(ALL.filter(s => !HEALTHY.includes(s)))('%s maps to a reason', state => {
    expect(BLOCKED_BY_STATE[state], `${state} falls through to unsupported-build`).toBeDefined();
  });

  it('no healthy state claims to be blocked', () => {
    for (const state of HEALTHY) expect(BLOCKED_BY_STATE[state]).toBeUndefined();
  });

  /**
   * Only ONE state may say "not supported on this Claude Code version yet": a clean file on a build
   * we have not verified. Every other use of that sentence sends a developer to wait for a release
   * that was never the problem.
   */
  it('blames the Claude Code version only where the version really is the issue', () => {
    const blaming = ALL.filter(s => BLOCKED_BY_STATE[s] === 'unsupported-build');
    expect(blaming).toEqual(['no-recipe']);
  });

  // Missing files are missing files. This is the mapping whose absence blanked the repair page.
  it('reads no-target as "the editor extension is not here"', () => {
    expect(BLOCKED_BY_STATE['no-target']).toBe('no-agent-editor');
  });
});
