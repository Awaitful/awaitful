import { describe, expect, it } from 'vitest';
import { AD_SPINNERS, DEFAULT_SPINNER_ID, getSpinner, frameAt } from '../ui/spinners.js';

describe('ad spinner registry', () => {
  it('has unique ids and the promised default', () => {
    const ids = AD_SPINNERS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_SPINNER_ID);
    expect(ids).toContain('none');
  });

  // The curation rule that got bouncing-bar and arc rejected: every frame is EXACTLY one display
  // column, or the ad text jitters sideways on each tick. [...f] counts code points, not UTF-16
  // units, so glyphs outside the BMP would still be caught.
  it('every frame of every spinner is one display column wide', () => {
    for (const s of AD_SPINNERS) {
      for (const f of s.frames) {
        expect([...f].length, `${s.id} frame "${f}" must be a single glyph`).toBe(1);
      }
    }
  });

  it('none is empty and everything else animates', () => {
    for (const s of AD_SPINNERS) {
      if (s.id === 'none') {
        expect(s.frames.length).toBe(0);
      } else {
        expect(s.frames.length, s.id).toBeGreaterThan(1);
        expect(s.intervalMs, s.id).toBeGreaterThan(0);
      }
    }
  });

  it('unknown ids fall back to the default - a cosmetic setting must never break an ad', () => {
    expect(getSpinner('retired-someday').id).toBe(DEFAULT_SPINNER_ID);
    expect(getSpinner(undefined).id).toBe(DEFAULT_SPINNER_ID);
    expect(getSpinner('dots').id).toBe('dots');
  });

  it('frameAt is pure wall-clock math: same instant, same frame', () => {
    const claude = getSpinner('claude');
    expect(frameAt(claude, 0)).toBe(claude.frames[0]);
    expect(frameAt(claude, claude.intervalMs)).toBe(claude.frames[1]);
    // A full cycle later, the same frame again.
    const cycle = claude.intervalMs * claude.frames.length;
    expect(frameAt(claude, 12_345)).toBe(frameAt(claude, 12_345 + cycle));
    // The none spinner never has a frame.
    expect(frameAt(getSpinner('none'), 999)).toBe('');
  });
});
