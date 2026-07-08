import { describe, expect, it } from 'vitest';
import { DEFAULTS, PlacementIdSchema } from '@awaitful/shared';
import { Rotation } from '../core/rotation.js';
import { EventQueue } from '../metrics/eventQueue.js';

describe('shared contract is accessible', () => {
  it('DEFAULTS has expected values', () => {
    expect(DEFAULTS.viewThresholdSeconds).toBe(5);
    expect(DEFAULTS.stuckSessionSeconds).toBe(5);
    expect(DEFAULTS.minPollSeconds).toBe(3);
  });

  it('PlacementIdSchema validates known placements', () => {
    expect(PlacementIdSchema.parse('status-bar')).toBe('status-bar');
    expect(() => PlacementIdSchema.parse('unknown')).toThrow();
  });
});

describe('pure modules are importable', () => {
  it('Rotation initialises', () => {
    const r = new Rotation([]);
    expect(r.next()).toBeUndefined();
  });

  it('EventQueue initialises with zero pending', () => {
    const q = new EventQueue('http://localhost', () => undefined, () => undefined);
    expect(q.pendingCount).toBe(0);
    q.dispose();
  });
});
