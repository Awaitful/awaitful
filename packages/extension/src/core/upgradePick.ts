/**
 * "Best format this machine can turn on right now" - the single source of truth shared by the first-run
 * moment (open the panel on it) and the discoverability nudge (only fire if one exists). Pure and derived
 * only from the already-built panel state, so both callers agree by construction and it is unit-tested
 * directly, without pulling in vscode.
 */

/** The formats the first-run moment can recommend. status-bar is the 1x base, never an "upgrade". */
export type UpgradeSurface = 'thinking-line' | 'chat-banner' | 'terminal';

/** The slice of the panel state the pick depends on (a structural subset of PanelState, so the real
 *  state is assignable - kept narrow so the pure logic is trivial to test). */
interface UpgradeSurfaceCard {
  id: string;
  available: boolean;
  conflict?: boolean | undefined;
  active: boolean;
  earnRate: number | undefined;
}
export interface UpgradeInput {
  vsSurfaces: UpgradeSurfaceCard[];
  terminalBlockedReason?: 'no-agent-cli' | undefined;
  terminalEnabled: boolean;
  terminalEarnRate: number | undefined;
}

/**
 * The single highest-value ad format this machine can turn on RIGHT NOW, or undefined when there is
 * nothing better than the status bar to offer.
 *
 * Order:
 *  1. An exclusive webview surface (thinking-line / chat-banner) REPLACES the status bar's base rate
 *     with a higher one. Pick the highest-earning that is available, NOT in a conflict, and not already
 *     active. earnRate must be known and above the 1x base, so we never call a move an upgrade we cannot
 *     prove is one (golden rule 3).
 *  2. If a real webview is present here but CONTESTED (a competitor holds its file), fall back to the
 *     status bar (undefined) so onboarding routes through that file's own guided conflict flow -
 *     resolving it gets the user the high-value webview. We deliberately do NOT divert to the terminal
 *     here: the webview is the achievable target, and a foreign-held file must never become an auto
 *     take-over.
 *  3. Otherwise the ADDITIVE terminal, which stacks on top of the status bar - the only real upgrade on a
 *     CLI-only / editor-less machine (no webview to get). Offered only when available and currently off.
 *  4. Otherwise undefined: stay quiet. The status bar is a working, non-penalized surface.
 */
export function pickBestUpgrade(state: UpgradeInput): UpgradeSurface | undefined {
  const webview = state.vsSurfaces
    .filter(
      (s) =>
        (s.id === 'thinking-line' || s.id === 'chat-banner') &&
        s.available &&
        !s.conflict &&
        !s.active &&
        s.earnRate !== undefined &&
        s.earnRate > 1,
    )
    .sort((a, b) => (b.earnRate ?? 0) - (a.earnRate ?? 0))[0];
  if (webview) return webview.id as UpgradeSurface;

  // A real webview is present here but held by a competitor right now (available + conflict, not active).
  // Its file has its own guided conflict flow, and resolving that gets the user the high-value webview -
  // so we do NOT divert onboarding to the lower-value terminal (and a second file edit) while Claude Code
  // is already contested. Stay on the status bar (undefined); the caller surfaces the conflict. The
  // terminal is the fallback only where there is genuinely no webview to get (CLI-only / editor-less).
  const webviewContestedHere = state.vsSurfaces.some(
    (s) => (s.id === 'thinking-line' || s.id === 'chat-banner') && s.available && s.conflict === true && !s.active,
  );
  if (webviewContestedHere) return undefined;

  if (
    state.terminalBlockedReason === undefined &&
    !state.terminalEnabled &&
    state.terminalEarnRate !== undefined &&
    state.terminalEarnRate > 0
  ) {
    return 'terminal';
  }
  return undefined;
}
