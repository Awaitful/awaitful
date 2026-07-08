import { describe, expect, it } from 'vitest';
import { Rotation } from '../core/rotation.js';
import type { Creative } from '@awaitful/shared';

const makeCreative = (adId: string): Creative => ({
  adId,
  campaignId: 'campaign-1',
  line: `Ad from ${adId}`,
});

describe('Rotation', () => {
  it('returns undefined for an empty list', () => {
    expect(new Rotation([]).next()).toBeUndefined();
  });

  it('always returns the same item for a single-item list', () => {
    const r = new Rotation([makeCreative('a')]);
    expect(r.next()?.adId).toBe('a');
    expect(r.next()?.adId).toBe('a');
  });

  it('round-robins across items', () => {
    const r = new Rotation([makeCreative('a'), makeCreative('b'), makeCreative('c')]);
    const ids = Array.from({ length: 6 }, () => r.next()?.adId);
    expect(ids).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('never returns the same ad twice in a row', () => {
    const r = new Rotation([makeCreative('a'), makeCreative('b')]);
    const ids = Array.from({ length: 10 }, () => r.next()?.adId);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).not.toBe(ids[i - 1]);
    }
  });

  it('reset restarts the rotation', () => {
    const r = new Rotation([makeCreative('a'), makeCreative('b')]);
    r.next();
    r.next();
    r.reset();
    expect(r.next()?.adId).toBe('a');
  });
});
