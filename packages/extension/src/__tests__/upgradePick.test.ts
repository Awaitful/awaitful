import { describe, it, expect } from 'vitest';
import { pickBestUpgrade, type UpgradeInput } from '../core/upgradePick.js';

/** Build a panel-state slice with sensible defaults, overriding only what a case cares about. */
function state(over: Partial<UpgradeInput> & { vsSurfaces?: UpgradeInput['vsSurfaces'] } = {}): UpgradeInput {
  return {
    vsSurfaces: [
      { id: 'status-bar', available: true, active: true, earnRate: 1 },
      { id: 'thinking-line', available: false, active: false, earnRate: 2 },
      { id: 'chat-banner', available: false, active: false, earnRate: 2.5 },
    ],
    terminalBlockedReason: 'no-agent-cli',
    terminalEnabled: false,
    terminalEarnRate: 0.5,
    ...over,
  };
}

const surfaces = (ov: Record<string, Partial<UpgradeInput['vsSurfaces'][number]>>) => [
  { id: 'status-bar', available: true, active: true, earnRate: 1, ...ov['status-bar'] },
  { id: 'thinking-line', available: false, active: false, earnRate: 2, ...ov['thinking-line'] },
  { id: 'chat-banner', available: false, active: false, earnRate: 2.5, ...ov['chat-banner'] },
];

describe('pickBestUpgrade', () => {
  it('recommends the highest-earning available webview surface', () => {
    expect(pickBestUpgrade(state({
      vsSurfaces: surfaces({ 'thinking-line': { available: true }, 'chat-banner': { available: true } }),
    }))).toBe('chat-banner');
  });

  it('falls to the next webview surface when the top one is not available here', () => {
    expect(pickBestUpgrade(state({
      vsSurfaces: surfaces({ 'thinking-line': { available: true }, 'chat-banner': { available: false } }),
    }))).toBe('thinking-line');
  });

  it('never recommends a surface whose file is contested (routes through the conflict flow instead)', () => {
    // available:true is how a conflict card reads (it offers the fix-it affordance) - must still be skipped.
    expect(pickBestUpgrade(state({
      vsSurfaces: surfaces({ 'chat-banner': { available: true, conflict: true }, 'thinking-line': { available: true, conflict: true } }),
      terminalBlockedReason: 'no-agent-cli',
    }))).toBeUndefined();
  });

  it('a contested webview stays on the status bar even when the terminal IS available (never diverts to terminal)', () => {
    // The gap this closes: with a real webview present-but-contested, the terminal used to be offered as a
    // consolation. The webview is the achievable target via its conflict flow, so the fallback is the
    // status bar, not the lower-value terminal (and a second file edit) while Claude Code is contested.
    expect(pickBestUpgrade(state({
      vsSurfaces: surfaces({ 'chat-banner': { available: true, conflict: true }, 'thinking-line': { available: true, conflict: true } }),
      terminalBlockedReason: undefined, terminalEnabled: false, terminalEarnRate: 0.5,
    }))).toBeUndefined();
  });

  it('falls back to the additive terminal on a CLI-only / editor-less machine', () => {
    // Both webview spots blocked (no editor), terminal is available and off.
    expect(pickBestUpgrade(state({ terminalBlockedReason: undefined, terminalEnabled: false }))).toBe('terminal');
  });

  it('returns undefined when the terminal is the only upgrade but already on', () => {
    expect(pickBestUpgrade(state({ terminalBlockedReason: undefined, terminalEnabled: true }))).toBeUndefined();
  });

  it('returns undefined when nothing beats the status bar', () => {
    expect(pickBestUpgrade(state())).toBeUndefined();
  });

  it('prefers a webview surface over the additive terminal', () => {
    expect(pickBestUpgrade(state({
      vsSurfaces: surfaces({ 'thinking-line': { available: true } }),
      terminalBlockedReason: undefined,
    }))).toBe('thinking-line');
  });

  it('never recommends an already-active surface', () => {
    expect(pickBestUpgrade(state({
      vsSurfaces: surfaces({ 'chat-banner': { available: true, active: true } }),
    }))).toBeUndefined();
  });

  it('does not recommend a webview surface whose earn rate is unknown', () => {
    expect(pickBestUpgrade(state({
      vsSurfaces: surfaces({ 'chat-banner': { available: true, earnRate: undefined } }),
    }))).toBeUndefined();
  });
});
