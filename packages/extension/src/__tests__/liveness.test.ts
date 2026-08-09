import { describe, it, expect } from 'vitest';
import { DEFAULTS } from '@awaitful/shared';
import { SurfaceLiveness, MIN_ATTESTABLE_TURN_MS, FAILED_TURN_LIMIT } from '../core/surfaceLiveness.js';
import type { LivenessState } from '../core/surfaceLiveness.js';

/**
 * The panel used to treat "our patch is on disk" as "the surface is working". It is not the same
 * claim, and the gap between them is a developer watching an empty spinner while the panel says
 * they are earning. These tests pin both halves: we must detect a real non-render, and we must
 * never manufacture one out of a quiet turn.
 */
const SHIM_V = 26;

function make(now: { t: number }) {
  const seen: LivenessState[] = [];
  const l = new SurfaceLiveness((s) => seen.push(s), SHIM_V, FAILED_TURN_LIMIT, MIN_ATTESTABLE_TURN_MS, () => now.t);
  return { l, seen };
}

/** One turn that runs long enough to be judged, ending however the caller sets up. */
function attestableTurn(l: SurfaceLiveness, now: { t: number }, fn?: () => void) {
  l.beginTurn('ad-1', 'slate-1');
  fn?.();
  now.t += MIN_ATTESTABLE_TURN_MS + 1000;
  l.endTurn();
}

describe('SurfaceLiveness thresholds', () => {
  it('ties the attestable-turn floor to the view threshold, not a magic number', () => {
    // A turn shorter than the billing threshold could not have earned anything even on a perfect
    // render, so it must never count against the surface.
    expect(MIN_ATTESTABLE_TURN_MS).toBe(DEFAULTS.viewThresholdSeconds * 1000);
  });
});

describe('SurfaceLiveness proof of life', () => {
  it('a matched paint sets live and clears the failure streak', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    attestableTurn(l, now, () => l.attest({ hostId: 'h', shimId: 's1', v: SHIM_V, stage: 'no-anchor', adId: 'ad-1' }));
    l.beginTurn('ad-2', 'slate-1');
    l.shimHello('s1', SHIM_V);
    l.painted('ad-2', 'slate-1', 's1');
    expect(l.state.stage).toBe('live');
    expect(l.state.failedTurns).toBe(0);
  });

  it('an unpaid house creative that paints still counts as live', () => {
    // Liveness keys on render, never on revenue: a zero-bid house ad is a real paint.
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.beginTurn('house-1', 'slate-1');
    l.painted('house-1', 'slate-1', 's1');
    expect(l.state.stage).toBe('live');
  });
});

describe('SurfaceLiveness never fabricates a failure', () => {
  it('an empty slate never opens a turn, so 100 fill-less turns say nothing', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    for (let i = 0; i < 100; i++) { now.t += 60_000; l.endTurn(); }
    expect(l.state.stage).toBe('unknown');
    expect(l.state.failedTurns).toBe(0);
  });

  it('a turn shorter than the view threshold is not attestable', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    for (let i = 0; i < FAILED_TURN_LIMIT + 2; i++) {
      l.beginTurn('ad-1', 'slate-1');
      l.attest({ hostId: 'h', shimId: 's1', v: SHIM_V, stage: 'no-anchor', adId: 'ad-1' });
      now.t += MIN_ATTESTABLE_TURN_MS - 100;   // just under
      l.endTurn();
    }
    expect(l.state.stage).not.toBe('not-rendering');
  });

  it('a turn spent waiting on a permission prompt is not attestable', () => {
    // Pause/resume exclude the wait, so a long approval cannot be read as a long failed render.
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.shimHello('s1', SHIM_V);
    for (let i = 0; i < FAILED_TURN_LIMIT + 1; i++) {
      l.beginTurn('ad-1', 'slate-1');
      l.attest({ hostId: 'h', shimId: 's1', v: SHIM_V, stage: 'no-anchor', adId: 'ad-1' });
      now.t += 500;
      l.pause();
      now.t += 10 * MIN_ATTESTABLE_TURN_MS;    // the user was away, not the surface broken
      l.resume();
      now.t += 500;
      l.endTurn();
    }
    expect(l.state.stage).not.toBe('not-rendering');
  });

  it('an aborted turn is dropped ungraded', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    for (const abort of ['killed', 'paused', 'surface-changed', 'reload'] as const) {
      l.beginTurn('ad-1', 'slate-1');
      l.attest({ hostId: 'h', shimId: 's1', v: SHIM_V, stage: 'no-anchor', adId: 'ad-1' });
      now.t += MIN_ATTESTABLE_TURN_MS + 1000;
      l.endTurn(abort);
    }
    expect(l.state.failedTurns).toBe(0);
  });

  it('an attestation from a shim this host has never heard from is ignored', () => {
    // The exact VS Code + Cursor sequence: another window's shim must not vote our surface down.
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.shimHello('ours', SHIM_V);
    for (let i = 0; i < FAILED_TURN_LIMIT + 1; i++) {
      attestableTurn(l, now, () => l.attest({ hostId: 'h', shimId: 'a-stranger', v: SHIM_V, stage: 'no-anchor', adId: 'ad-1' }));
    }
    expect(l.state.stage).not.toBe('not-rendering');
  });

  it('an attestation about a different turn is ignored', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.shimHello('s1', SHIM_V);
    for (let i = 0; i < FAILED_TURN_LIMIT + 1; i++) {
      attestableTurn(l, now, () => l.attest({ hostId: 'h', shimId: 's1', v: SHIM_V, stage: 'no-anchor', adId: 'a-stale-ad' }));
    }
    expect(l.state.stage).not.toBe('not-rendering');
  });
});

describe('SurfaceLiveness proven failure', () => {
  it('reaches not-rendering on the third attestable no-anchor turn, and not the second', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.shimHello('s1', SHIM_V);
    for (let i = 0; i < FAILED_TURN_LIMIT - 1; i++) {
      attestableTurn(l, now, () => l.attest({ hostId: 'h', shimId: 's1', v: SHIM_V, stage: 'no-anchor', adId: 'ad-1' }));
    }
    expect(l.state.stage).not.toBe('not-rendering');
    attestableTurn(l, now, () => l.attest({ hostId: 'h', shimId: 's1', v: SHIM_V, stage: 'no-anchor', adId: 'ad-1' }));
    expect(l.state.stage).toBe('not-rendering');
  });

  it('reaches silent when we served ads and no shim ever spoke', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    for (let i = 0; i < FAILED_TURN_LIMIT; i++) attestableTurn(l, now);
    expect(l.state.stage).toBe('silent');
  });

  it('a live shim that simply did not paint reports loaded, claiming no cause', () => {
    // Panel hidden or the anchor scrolled away: we cannot prove why, so we assert nothing.
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.shimHello('s1', SHIM_V);
    for (let i = 0; i < FAILED_TURN_LIMIT + 2; i++) attestableTurn(l, now);
    expect(l.state.stage).toBe('loaded');
  });
});

describe('SurfaceLiveness stale shim', () => {
  it('a bound shim on older bytes asks for a reload', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.beginTurn('ad-1', 'slate-1');
    l.painted('ad-1', 'slate-1', 's1');       // binds s1
    l.shimHello('s1', SHIM_V - 1);
    expect(l.state.stage).toBe('reload-needed');
  });

  it('an UNBOUND shim on older bytes never pins this window on reload', () => {
    // Two editors on different Awaitful versions is ordinary; the working window must not be
    // told to reload because a foreign window's shim is behind.
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.shimHello('a-foreign-shim', SHIM_V - 1);
    expect(l.state.stage).not.toBe('reload-needed');
  });

  it('reload-needed still lets the failure streak accumulate', () => {
    // Otherwise any co-resident could hold a stale shim open and switch the whole check off.
    const now = { t: 1_000_000 };
    const { l } = make(now);
    l.beginTurn('ad-0', 'slate-1');
    l.painted('ad-0', 'slate-1', 's1');
    l.shimHello('s1', SHIM_V - 1);
    expect(l.state.stage).toBe('reload-needed');
    for (let i = 0; i < FAILED_TURN_LIMIT; i++) {
      attestableTurn(l, now, () => l.attest({ hostId: 'h', shimId: 's1', v: SHIM_V - 1, stage: 'no-anchor', adId: 'ad-1' }));
    }
    expect(l.state.stage).toBe('not-rendering');
  });
});

describe('SurfaceLiveness change notification', () => {
  it('fires on transitions only, never per beacon', () => {
    // visible beacons arrive at 1 Hz and each panel sync reads multi-megabyte bundles.
    const now = { t: 1_000_000 };
    const { l, seen } = make(now);
    l.beginTurn('ad-1', 'slate-1');
    for (let i = 0; i < 100; i++) l.painted('ad-1', 'slate-1', 's1');
    expect(seen.filter((s) => s.stage === 'live')).toHaveLength(1);
  });

  it('reset clears the streak and the bindings', () => {
    const now = { t: 1_000_000 };
    const { l } = make(now);
    for (let i = 0; i < FAILED_TURN_LIMIT; i++) attestableTurn(l, now);
    expect(l.state.stage).toBe('silent');
    l.reset();
    expect(l.state.stage).toBe('unknown');
    expect(l.state.failedTurns).toBe(0);
  });
});
