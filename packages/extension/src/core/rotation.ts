import type { Creative } from '@awaitful/shared';

export class Rotation {
  private index = 0;
  private lastAdId: string | undefined;

  constructor(private readonly items: readonly Creative[]) {}

  next(): Creative | undefined {
    if (this.items.length === 0) return undefined;
    if (this.items.length === 1) return this.items[0];

    // Round-robin, never the same ad twice in a row.
    let candidate = this.items[this.index % this.items.length]!;
    if (candidate.adId === this.lastAdId) {
      this.index++;
      candidate = this.items[this.index % this.items.length]!;
    }
    this.lastAdId = candidate.adId;
    this.index++;
    return candidate;
  }

  reset(): void {
    this.index = 0;
    this.lastAdId = undefined;
  }
}
