import { describe, expect, it } from 'vitest';

/**
 * The guard that decides whether the dashboard asked for anything at all.
 *
 * This is pinned as a standalone predicate rather than through the orchestrator (which needs the
 * whole VS Code API to construct) because the bug was never in the logic AROUND it - it was in the
 * comparison itself, and that is exactly what a test can hold still.
 *
 * ── The bug this exists for ──────────────────────────────────────────────────────
 *
 * `remoteTerminalEnabled` is typed `boolean | null`, and the reconciler guarded on `=== null`. But a
 * server that predates the column does not send null - it omits the field, so the client reads
 * `undefined`. `undefined === null` is false, so every check-in fell PAST the guard, past the
 * "turn it off" branch, and into enableTerminal() for anyone who had ever granted terminal consent:
 * the status line switched itself on, with a success toast, having been asked by nobody.
 *
 * The same shape had already bitten once, when a zod schema silently stripped `prefsVersion` and a
 * fast path went quietly dead. Absent and null are the same fact - "nobody asked" - and only `== null`
 * says so.
 */

/** True when the dashboard has expressed no preference: explicit null, or a server too old to know. */
function noRequest(pref: unknown): boolean {
  return pref == null;
}

describe('an absent preference is not a request', () => {
  it.each([
    ['explicit null - the developer cleared it', null],
    ['absent - a server that predates the field', undefined],
  ])('%s', (_why, value) => {
    expect(noRequest(value)).toBe(true);
  });

  it.each([
    ['on', true],
    ['off', false],
  ])('a real boolean IS a request: %s', (_why, value) => {
    expect(noRequest(value)).toBe(false);
  });

  /**
   * The distinction that makes this worth a test: `false` is a real instruction (turn it off) and
   * must NOT be swallowed by the same guard that ignores absence. A `!pref` check would have fixed
   * the reported bug and broken remote switch-off in the same line.
   */
  it('never confuses "turn it off" with "nobody asked"', () => {
    expect(noRequest(false)).toBe(false);
    expect(!(false as unknown)).toBe(true); // what the tempting shortcut would have done
  });

  // A surface preference is a string, and the same guard has to hold for it: an older server omits
  // any field, and acting on undefined would try to apply a surface with no id.
  it('holds for the surface preference too', () => {
    expect(noRequest(undefined)).toBe(true);
    expect(noRequest('chat-banner')).toBe(false);
  });
});
