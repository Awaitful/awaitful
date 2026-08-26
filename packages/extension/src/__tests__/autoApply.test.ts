import { describe, it, expect, vi } from 'vitest';
import { mayAutoApply } from '../core/orchestrator.js';

vi.mock('vscode', () => ({
  window: {}, commands: {}, workspace: { getConfiguration: () => ({ get: () => undefined }) },
  Uri: {}, ViewColumn: {}, StatusBarAlignment: {}, extensions: { all: [] },
}));

/**
 * A dashboard request may only patch this machine silently when this machine has already said yes.
 *
 * ── The bug this exists for ──────────────────────────────────────────────────────
 *
 * "Restore original files" is the remedy the extension prescribes for its own worst case: a patch
 * that went wrong, an editor behaving oddly, a file someone wants back. It clears the local choice
 * and the local consent.
 *
 * It did not clear the ACCOUNT's standing request, and it had no reason to until 0.7.6 gave an
 * account a format preference that a device obeys. From then on the reconciler saw sync on, saw a
 * preference this device was not currently showing, and re-applied it on the next check-in - within
 * five minutes, and SILENTLY, because the same release suppressed the reload message on the sync
 * path. The one action a developer takes when their editor is misbehaving quietly undid itself.
 *
 * So the escape hatch outranks the standing request. The developer is asked instead, for as long as
 * the dashboard keeps asking for the same thing.
 */
describe('a restore outranks a standing dashboard request', () => {
  const base = { pref: 'chat-banner', restoredFrom: undefined, consentGranted: false, syncOn: false };

  it('never re-applies the format that was just restored away, however much permission exists', () => {
    // Both doors to a silent apply are wide open, and the latch still shuts it.
    expect(mayAutoApply({
      ...base, restoredFrom: 'chat-banner', consentGranted: true, syncOn: true,
    })).toBe(false);
  });

  it('still applies a DIFFERENT format the dashboard asks for', () => {
    // The latch is about one format, not a blanket freeze: a fresh choice is a fresh request, and
    // holding it back would strand a developer who fixed things by picking something else.
    expect(mayAutoApply({
      ...base, pref: 'thinking-line', restoredFrom: 'chat-banner', syncOn: true,
    })).toBe(true);
  });

  it('leaves the ordinary paths exactly as they were', () => {
    expect(mayAutoApply({ ...base, syncOn: true })).toBe(true);
    expect(mayAutoApply({ ...base, consentGranted: true })).toBe(true);
    // Neither consent nor sync: the developer gets a prompt, which is the pre-existing behaviour.
    expect(mayAutoApply(base)).toBe(false);
  });

  /**
   * Sync being on is not consent to have a restore reversed. This is the combination that actually
   * shipped broken, so it gets its own line rather than living inside the table above.
   */
  it('does not let sync alone override the restore', () => {
    expect(mayAutoApply({ ...base, restoredFrom: 'chat-banner', syncOn: true })).toBe(false);
  });

  // An absent latch must never accidentally match an absent preference and freeze everything.
  it('treats "nothing was restored" as no latch at all', () => {
    expect(mayAutoApply({ ...base, restoredFrom: undefined, syncOn: true })).toBe(true);
  });
});
