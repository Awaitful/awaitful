import type { AdEvent, EventBatch } from '@awaitful/shared';
import { postJson, HttpError } from '../lib/http.js';

export class EventQueue {
  private readonly pending = new Map<string, AdEvent>();
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly getDeviceId: () => string | undefined,
    private readonly getToken: () => string | undefined,
  ) {}

  enqueue(event: AdEvent): void {
    // eventId is the idempotency key — silently ignore duplicates.
    if (!this.pending.has(event.eventId)) {
      this.pending.set(event.eventId, event);
    }
  }

  startFlushing(
    intervalMs = 5_000,
    onUnauthorized?: () => void,
    onSuccess?: () => void,
  ): void {
    this.stopFlushing();
    this.flushTimer = setInterval(() => {
      this.flush().then((sent) => {
        // Only reset the auth streak when we actually got a successful response,
        // not on empty-queue no-ops.
        if (sent) onSuccess?.();
      }).catch((err) => {
        if (err instanceof HttpError && err.status === 401) {
          onUnauthorized?.();
        }
        // network / 5xx: keep events pending, leave auth streak untouched
      });
    }, intervalMs);
  }

  stopFlushing(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  // Returns true when events were actually POSTed (not a no-op empty-queue call).
  async flush(): Promise<boolean> {
    if (this.pending.size === 0) return false;
    const deviceId = this.getDeviceId();
    if (!deviceId) return false;

    const events = [...this.pending.values()];
    const batch: EventBatch = { deviceId, events };

    // Only clear after a successful POST (at-least-once delivery; server dedupes).
    await postJson(`${this.apiUrl}/v1/events`, batch, this.getToken());
    for (const e of events) this.pending.delete(e.eventId);
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.stopFlushing();
  }
}
