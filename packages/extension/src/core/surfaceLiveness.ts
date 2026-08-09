import { DEFAULTS } from '@awaitful/shared';
import type { SurfaceAttestation } from '../hooks/server.js';

/**
 * Is our webview surface ACTUALLY rendering?
 *
 * Patch-present was being treated as surface-working, and it is not the same claim. A competitor
 * can hold the same DOM anchor, Claude Code can move the markup we attach to, the shim can throw,
 * or the webview can still be running pre-patch bytes - and in every one of those the panel showed
 * the surface as active and earning while nothing appeared and nothing billed. This ledger exists
 * to make that failure visible instead of silent.
 *
 * The governing rule: **the only artifact that proves a paint is a beacon emitted after the overlay
 * was placed, from a shim bound to this host, for a creative this host issued in this turn.**
 * Everything weaker is `loaded`. Absence of evidence is never promoted to proof of failure - only
 * the shim's own "I had an ad and could not place it" counts as a negative.
 */
export type LivenessStage =
  | 'unknown'        // too little has happened to say anything
  | 'loaded'         // a shim is talking to us; nothing has painted yet
  | 'live'           // a matched, painted beacon arrived
  | 'reload-needed'  // the bound shim is running older bytes than the ones on disk
  | 'not-rendering'  // proven: the shim had ads on N attestable turns and could not place them
  | 'silent';        // N attestable turns served a creative and no shim spoke at all

export interface LivenessState {
  stage: LivenessStage;
  failedTurns: number;
  lastPaintAtMs: number;
  /** Shim version reported by a bound shim, or 0 when unknown. */
  runningShimVersion: number;
}

/**
 * A turn shorter than the view threshold could never have billed a cent even on a flawless render,
 * so demoting someone over three of them would be demoting them over money that never existed.
 */
export const MIN_ATTESTABLE_TURN_MS = DEFAULTS.viewThresholdSeconds * 1000;
export const FAILED_TURN_LIMIT = 3;

interface Turn {
  adId: string;
  slateId: string;
  startedMs: number;
  pausedAtMs: number;
  pausedMs: number;
  painted: boolean;
  attestedNoAnchor: boolean;
}

export class SurfaceLiveness {
  private stage: LivenessStage = 'unknown';
  private failedTurns = 0;
  private lastPaintAtMs = 0;
  private runningShimVersion = 0;
  private turn: Turn | undefined;
  /** Shims that have talked to THIS host this session (hello, or a matched paint). */
  private readonly knownShims = new Set<string>();
  /** The shim that has actually painted for us. Only its attestations are evidence. */
  private boundShimId: string | undefined;

  constructor(
    private readonly onChange: (s: LivenessState) => void,
    private readonly currentShimVersion: number,
    private readonly limit = FAILED_TURN_LIMIT,
    private readonly minTurnMs = MIN_ATTESTABLE_TURN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): LivenessState {
    return {
      stage: this.stage,
      failedTurns: this.failedTurns,
      lastPaintAtMs: this.lastPaintAtMs,
      runningShimVersion: this.runningShimVersion,
    };
  }

  /** Activation, reload, enable/disable, surface switch: forget everything and start clean. */
  reset(): void {
    this.turn = undefined;
    this.failedTurns = 0;
    this.knownShims.clear();
    this.boundShimId = undefined;
    this.runningShimVersion = 0;
    this.set('unknown');
  }

  /** A patch was written; the running webview is stale until it reloads. */
  armReload(): void {
    this.set('reload-needed');
  }

  shimHello(shimId: string, shimVersion: number): void {
    this.knownShims.add(shimId);
    if (this.boundShimId === undefined || shimId === this.boundShimId) {
      this.runningShimVersion = shimVersion;
    }
    // Only a shim that has painted for us may pin the panel on "reload". Otherwise an ordinary
    // two-editor split - one on an older Awaitful - would leave the working window permanently
    // telling the user to reload.
    if (shimId === this.boundShimId && shimVersion > 0 && shimVersion < this.currentShimVersion) {
      this.set('reload-needed');
      return;
    }
    if (this.stage === 'unknown') this.set('loaded');
  }

  /** Open a turn. Call ONLY when a creative actually exists - no fill is not a failure. */
  beginTurn(adId: string, slateId: string): void {
    // A re-entrant start (queued prompt, interrupt-and-resubmit) drops the prior turn ungraded,
    // mirroring the view-timer teardown that exists for the same reason.
    this.turn = {
      adId, slateId,
      startedMs: this.now(),
      pausedAtMs: 0,
      pausedMs: 0,
      painted: false,
      attestedNoAnchor: false,
    };
  }

  pause(): void {
    if (this.turn && !this.turn.pausedAtMs) this.turn.pausedAtMs = this.now();
  }

  resume(): void {
    if (this.turn?.pausedAtMs) {
      this.turn.pausedMs += this.now() - this.turn.pausedAtMs;
      this.turn.pausedAtMs = 0;
    }
  }

  /** A rendered / visible / click beacon that the session already matched. Proof of paint. */
  painted(adId: string, slateId: string, shimId: string | undefined): void {
    if (shimId) {
      this.knownShims.add(shimId);
      this.boundShimId ??= shimId;
    }
    this.lastPaintAtMs = this.now();
    this.failedTurns = 0;
    if (this.turn && this.turn.adId === adId && this.turn.slateId === slateId) this.turn.painted = true;
    this.set('live');
  }

  /**
   * The shim's self-reported non-render. Counted only when it is about THIS turn's creative and
   * comes from a shim we have proof is co-resident with us - otherwise another window's shim could
   * vote our surface down.
   */
  attest(a: SurfaceAttestation): void {
    if (!this.turn || a.adId !== this.turn.adId) return;
    if (!this.knownShims.has(a.shimId)) return;
    if (a.v > 0) this.runningShimVersion = a.v;
    this.turn.attestedNoAnchor = true;
  }

  /** Close the turn and grade it. `abort` drops it ungraded. */
  endTurn(abort?: 'killed' | 'paused' | 'surface-changed' | 'reload' | 'reentrant'): void {
    const t = this.turn;
    this.turn = undefined;
    if (!t || abort) return;

    if (t.painted) {
      this.failedTurns = 0;
      this.set('live');
      return;
    }

    this.resumeInto(t);
    const unpausedMs = this.now() - t.startedMs - t.pausedMs;
    if (unpausedMs < this.minTurnMs) return; // too short to have earned anything either way

    if (t.attestedNoAnchor) {
      this.failedTurns++;
      if (this.failedTurns >= this.limit) this.set('not-rendering');
      return;
    }
    if (this.knownShims.size === 0) {
      // We served an ad and nothing in any webview ever spoke to us. That is the honest verdict:
      // nothing rendered and nothing earned. It does NOT say why - the panel copy must not either.
      this.failedTurns++;
      if (this.failedTurns >= this.limit) this.set('silent');
      return;
    }
    // A shim is alive but did not paint and did not complain: the panel is probably hidden or the
    // anchor scrolled away. Not a failure we can prove, so we claim nothing.
    if (this.stage !== 'reload-needed') this.set('loaded');
  }

  private resumeInto(t: Turn): void {
    if (t.pausedAtMs) {
      t.pausedMs += this.now() - t.pausedAtMs;
      t.pausedAtMs = 0;
    }
  }

  /** Fire onChange on transitions only: `visible` beacons arrive at 1 Hz and a panel sync is costly. */
  private set(stage: LivenessStage): void {
    if (this.stage === stage) return;
    this.stage = stage;
    this.onChange(this.state);
  }
}
