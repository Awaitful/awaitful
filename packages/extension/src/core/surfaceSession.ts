import type { AdEvent } from '@awaitful/shared';
import { DEFAULTS } from '@awaitful/shared';
import type { SurfaceCreative, SurfaceBeacon } from '../hooks/server.js';

type Emit = (type: AdEvent['type'], visibleMs?: number) => void;

/**
 * Verified billing for a shim-rendered surface (thinking-line). The host cannot
 * see into Claude Code's webview, so nothing is billed until the shim beacons
 * that it *actually* rendered / was visible — the guarantee behind golden rule 3.
 *
 * One creative per thinking session. Beacons that don't match the active creative
 * are ignored; `impression_rendered` and `view_threshold_met` each fire at most
 * once. If no beacon ever arrives (selector failed, panel hidden), nothing bills.
 */
export class SurfaceSession {
  private creative: SurfaceCreative | null = null;
  private renderedFired = false;
  private thresholdFired = false;
  private visibleMs = 0;
  /**
   * The shim instance that actually painted this creative. Latched by the first matching `rendered`
   * and required by every beacon after it.
   *
   * Without this, two open Claude Code webviews - two windows, or VS Code and Cursor side by side -
   * both fetch the same creative and both post `visible {visibleMs:1000}` at 1 Hz into this one
   * accumulator, so `view_threshold_met` fires after half the visible time it represents. That is
   * billing for time nobody watched (golden rule 3), and it is invisible in any single-window test.
   */
  private boundShimId: string | undefined;

  constructor(
    private readonly emit: Emit,
    private readonly thresholdMs = DEFAULTS.viewThresholdSeconds * 1000,
  ) {}

  /** Start a session for the creative the shim will paint this think. */
  begin(creative: SurfaceCreative): void {
    this.creative = creative;
    this.renderedFired = false;
    this.thresholdFired = false;
    this.visibleMs = 0;
    this.boundShimId = undefined;
  }

  end(): void {
    this.creative = null;
    this.boundShimId = undefined;
  }

  /**
   * Patch the active creative's cosmetic fields (glow style / frame) in place — a live preview. Same ad
   * (adId/slateId unchanged), so no billing state resets; the shim repaints on its next poll because its
   * `changed()` check includes these fields.
   */
  restyle(patch: Partial<SurfaceCreative>): void {
    if (this.creative) this.creative = { ...this.creative, ...patch };
  }

  get current(): SurfaceCreative | null {
    return this.creative;
  }

  private matches(b: SurfaceBeacon): boolean {
    if (!this.creative || b.adId !== this.creative.adId || b.slateId !== this.creative.slateId) return false;
    // Once a shim has painted, only that shim's beacons count for this impression. A second webview
    // showing the same creative is a second view of the same ad, not more time on the first.
    if (this.boundShimId !== undefined && b.shimId !== this.boundShimId) return false;
    return true;
  }

  rendered(b: SurfaceBeacon): void {
    if (!this.matches(b) || this.renderedFired) return;
    this.renderedFired = true;
    this.boundShimId = b.shimId; // whoever painted first owns this impression
    this.emit('impression_rendered');
  }

  visible(b: SurfaceBeacon): void {
    if (!this.matches(b)) return;
    // Clamp each beacon so a misbehaving shim can't inflate visible time.
    this.visibleMs += Math.max(0, Math.min(b.visibleMs ?? 0, 2000));
    this.emit('view_tick', this.visibleMs);
    if (!this.thresholdFired && this.visibleMs >= this.thresholdMs) {
      this.thresholdFired = true;
      this.emit('view_threshold_met', this.visibleMs);
    }
  }

  /** Returns the URL to open on a genuine click, or undefined. */
  click(b: SurfaceBeacon): string | undefined {
    if (!this.matches(b)) return undefined;
    const url = this.creative?.url;
    if (!url) return undefined;
    this.emit('click');
    return url;
  }
}
