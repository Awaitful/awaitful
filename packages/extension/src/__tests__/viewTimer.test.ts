import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ViewTimer } from '../viewTracking/viewTimer.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function makeTimer(thresholdMs = 5000, tickMs = 1000, stuckMs = 5000) {
  const ticks: number[] = [];
  const thresholds: number[] = [];
  const stucks: number[] = [];
  const timer = new ViewTimer(
    {
      onTick: (ms) => ticks.push(ms),
      onThresholdMet: (ms) => thresholds.push(ms),
      onStuck: () => stucks.push(1),
    },
    thresholdMs,
    tickMs,
    stuckMs,
  );
  return { timer, ticks, thresholds, stucks };
}

describe('ViewTimer', () => {
  it('fires ticks at the configured cadence', () => {
    const { timer, ticks } = makeTimer(5000, 1000);
    timer.start();
    vi.advanceTimersByTime(3000);
    expect(ticks.length).toBe(3);
    timer.stop();
  });

  it('fires onThresholdMet exactly once when visible time crosses threshold', () => {
    const { timer, thresholds } = makeTimer(3000, 1000);
    timer.start();
    vi.advanceTimersByTime(5000);
    expect(thresholds.length).toBe(1);
    timer.stop();
  });

  it('does not fire onThresholdMet if stopped before threshold', () => {
    const { timer, thresholds } = makeTimer(5000, 1000);
    timer.start();
    vi.advanceTimersByTime(2000);
    timer.stop();
    vi.advanceTimersByTime(5000);
    expect(thresholds.length).toBe(0);
  });

  it('accumulates time across pause/resume', () => {
    const { timer } = makeTimer(5000, 1000);
    timer.start();
    vi.advanceTimersByTime(2000);
    timer.pause();
    const mid = timer.visibleMs();
    expect(mid).toBeGreaterThanOrEqual(2000);
    timer.start();
    vi.advanceTimersByTime(3000);
    expect(timer.visibleMs()).toBeGreaterThanOrEqual(5000);
    timer.stop();
  });

  it('resets accumulated time on stop', () => {
    const { timer } = makeTimer();
    timer.start();
    vi.advanceTimersByTime(2000);
    timer.stop();
    expect(timer.visibleMs()).toBe(0);
  });

  it('fires onStuck if threshold not met within stuckMs', () => {
    const { timer, stucks } = makeTimer(10000, 1000, 5000);
    timer.start();
    vi.advanceTimersByTime(5000);
    expect(stucks.length).toBe(1);
    timer.stop();
  });

  it('does not fire onStuck if threshold already met', () => {
    const { timer, stucks } = makeTimer(3000, 1000, 5000);
    timer.start();
    vi.advanceTimersByTime(5000);
    expect(stucks.length).toBe(0);
    timer.stop();
  });
});
