import { describe, it, expect } from 'vitest';
import { src, methodBody } from './sourceGuard.js';

/**
 * Two-way sync has to survive a failed request, a sign-out, and an apply that did not land.
 *
 * The device -> account write arrived in 0.7.6 as a single fire-and-forget POST with no retry, alone
 * among the reports in this file. Every other one holds a `lastReported*` memo and re-sends on the
 * next check-in; this one dropped the developer's choice on any failure - offline, a 5xx, a server
 * restart mid-deploy - and the very next check-in read the older account value and applied it back
 * over them. The revert this feature exists to prevent, caused by the feature.
 *
 * These are ORDER and SHAPE assertions, because the Orchestrator cannot be constructed in a test.
 * See sourceGuard.ts for why that trade is made here and nowhere it can be avoided.
 */
const ORCHESTRATOR = 'core/orchestrator.ts';

describe('the account write survives failure', () => {
  /**
   * The flush must precede the reconcile inside refreshAccount. `me` was fetched at the top of that
   * method, so while a choice is unsent that response is out of date BY CONSTRUCTION: reconciling
   * first applies the older value and then reports it back as this device's own state, laundering a
   * revert into a fact.
   */
  it('pushes an unsent choice before reading the account back', () => {
    const body = methodBody(src(ORCHESTRATOR), 'private async refreshAccount(');
    const flush = body.indexOf('flushSurfaceChoice');
    const reconcile = body.indexOf('reconcileRemoteSurfacePreference');
    expect(flush, 'refreshAccount no longer flushes the pending choice').toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(-1);
    expect(flush, 'the reconcile now runs before the flush, which reverts the developer')
      .toBeLessThan(reconcile);
  });

  // And the reconciler refuses outright while anything is unsent, so no other caller can reintroduce
  // the same staleness by reaching it another way.
  it('refuses to reconcile at all against a read that predates an unsent choice', () => {
    const body = methodBody(src(ORCHESTRATOR), 'private async reconcileRemoteSurfacePreference(');
    expect(body).toContain('this.pendingSurfaceChoice !== undefined');
  });

  /**
   * Linking again mints a NEW device row with every flag at its default, so each "already told the
   * server" memo is about a token the server has never seen. `lastReportedControl` is the dangerous
   * one: keep it and the server never learns this device is synced, and then REFUSES every shared
   * write it sends, for the life of the window.
   */
  it('forgets every already-reported memo on sign-out', () => {
    const body = methodBody(src(ORCHESTRATOR), 'async signOut(): Promise<void>');
    for (const field of [
      'lastReportedSurface', 'lastReportedTerminal', 'lastReportedFailure',
      'lastReportedControl', 'pendingSurfaceChoice',
    ]) {
      expect(body, `signOut leaves ${field} set, so the new device row is never told`)
        .toContain(`this.${field} = undefined`);
    }
  });
});

describe('the account write describes something that happened', () => {
  /**
   * It used to fire at the click. So a take-over dialog the developer then CANCELLED, or an apply
   * that failed its health probe and rolled back, still told the account this device had switched -
   * and every other device dutifully followed a change that never happened here.
   */
  it('reports the shared choice only from inside the successful-apply branch', () => {
    const body = methodBody(src(ORCHESTRATOR), 'private async enableWebviewSurface(');
    const report = body.indexOf('reportSurfaceChoiceIfSynced');
    const chose = body.indexOf('await this.chooseWebviewSurface(id)');
    expect(report, 'enableWebviewSurface no longer reports the shared choice').toBeGreaterThan(-1);
    expect(report, 'the report moved back ahead of the apply that proves it')
      .toBeGreaterThan(chose);
  });

  // Only a deliberate local pick may write the shared value. An automatic apply or a fail-safe
  // fallback writing it would let one machine's problem redefine every other machine's format.
  it('gates the shared write on a local choice, never on an automatic apply', () => {
    const body = methodBody(src(ORCHESTRATOR), 'private async enableWebviewSurface(');
    expect(body).toContain('if (localChoice) this.reportSurfaceChoiceIfSynced(id)');
  });
});

describe('the terminal is not disarmed by a machine that never opted in', () => {
  /**
   * Turning the terminal off writes nothing dangerous, but it still UNDOES something the developer
   * did on this machine. Acting on the account's request needed the same opt-in that turning it ON
   * has always needed - otherwise a dashboard switch reaches into an editor that never agreed to
   * follow it. Its own two-way write is what stops that request being permanently stale.
   */
  it('checks consent or sync before acting on a remote switch-off', () => {
    const body = methodBody(src(ORCHESTRATOR), 'private async reconcileRemoteTerminalPreference(');
    const off = body.indexOf("if (pref === false)");
    expect(off).toBeGreaterThan(-1);
    const branch = body.slice(off, off + 400);
    expect(branch).toContain("!this.consent.isGranted('terminal') && !this.remoteControlAllowed");
  });

  it('writes the terminal choice back to the account when synced', () => {
    const body = methodBody(src(ORCHESTRATOR), 'private async toggleTerminal(');
    expect(body).toContain('reportTerminalChoiceIfSynced');
    // Only on a real change: enableTerminal refuses outright with no status-line agent, and
    // reporting a declined choice would tell every other device to follow what did not happen.
    expect(body).toContain('this.terminalEnabled !== before');
  });
});
