import { DEFAULTS } from '@awaitful/shared';

export type ViewTimerCallbacks = {
  onTick(visibleMs: number): void;
  onThresholdMet(visibleMs: number): void;
  onStuck(): void;
};

export class ViewTimer {
  private startedAt: number | undefined;
  private accumulatedMs = 0;
  private thresholdFired = false;
  private tickInterval: ReturnType<typeof setInterval> | undefined;
  private stuckTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly callbacks: ViewTimerCallbacks,
    private readonly thresholdMs = DEFAULTS.viewThresholdSeconds * 1000,
    private readonly tickMs = DEFAULTS.viewTickSeconds * 1000,
    private readonly stuckMs = DEFAULTS.stuckSessionSeconds * 1000,
  ) {}

  start(): void {
    if (this.startedAt !== undefined) return;
    this.startedAt = Date.now();

    this.tickInterval = setInterval(() => {
      const ms = this.visibleMs();
      this.callbacks.onTick(ms);
      if (!this.thresholdFired && ms >= this.thresholdMs) {
        this.thresholdFired = true;
        this.callbacks.onThresholdMet(ms);
      }
    }, this.tickMs);

    this.stuckTimeout = setTimeout(() => {
      if (!this.thresholdFired) this.callbacks.onStuck();
    }, this.stuckMs);
  }

  pause(): void {
    if (this.startedAt === undefined) return;
    this.accumulatedMs += Date.now() - this.startedAt;
    this.startedAt = undefined;
    this.clearTimers();
  }

  stop(): void {
    this.pause();
    this.accumulatedMs = 0;
    this.thresholdFired = false;
  }

  visibleMs(): number {
    const elapsed = this.startedAt !== undefined ? Date.now() - this.startedAt : 0;
    return this.accumulatedMs + elapsed;
  }

  private clearTimers(): void {
    if (this.tickInterval !== undefined) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
    if (this.stuckTimeout !== undefined) {
      clearTimeout(this.stuckTimeout);
      this.stuckTimeout = undefined;
    }
  }
}
