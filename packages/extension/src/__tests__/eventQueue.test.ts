import { describe, expect, it } from 'vitest';
import { EventQueue } from '../metrics/eventQueue.js';
import type { AdEvent } from '@awaitful/shared';

const makeEvent = (eventId: string, type: AdEvent['type'] = 'view_tick'): AdEvent => ({
  eventId,
  type,
  adId: 'ad-1',
  slateId: 'slate-1',
  placement: 'status-bar',
  occurredAtClientMs: Date.now(),
});

describe('EventQueue', () => {
  it('enqueues events and tracks pending count', () => {
    const q = new EventQueue('http://localhost', () => 'device-1', () => undefined);
    q.enqueue(makeEvent('evt-1'));
    q.enqueue(makeEvent('evt-2'));
    expect(q.pendingCount).toBe(2);
    q.dispose();
  });

  it('silently ignores duplicate eventIds', () => {
    const q = new EventQueue('http://localhost', () => 'device-1', () => undefined);
    q.enqueue(makeEvent('evt-1'));
    q.enqueue(makeEvent('evt-1')); // duplicate
    expect(q.pendingCount).toBe(1);
    q.dispose();
  });

  it('treats events with different ids as distinct', () => {
    const q = new EventQueue('http://localhost', () => 'device-1', () => undefined);
    q.enqueue(makeEvent('evt-1', 'impression_rendered'));
    q.enqueue(makeEvent('evt-2', 'view_threshold_met'));
    expect(q.pendingCount).toBe(2);
    q.dispose();
  });
});
