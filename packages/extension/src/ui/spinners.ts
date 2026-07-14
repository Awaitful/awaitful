/**
 * The ad spinners: the little animation that precedes the sponsored line while the agent thinks.
 *
 * PURE DATA + pure functions, no vscode import - the same registry pattern as everything else.
 * Every surface derives its current frame from the WALL CLOCK (`frameAt(spinner, Date.now())`),
 * which buys two things for free: all surfaces animate in sync without sharing a timer, and the
 * terminal status line (which Claude Code polls on its own cadence) shows the "right" frame per
 * poll instead of needing a timer it cannot have.
 *
 * Curation rule: every frame of a spinner is EXACTLY ONE display column wide (pinned by test), or
 * the ad text jitters sideways each tick. That rule is why bouncing-bar and arc were rejected by
 * the owner. Text glyphs only - these must survive a terminal - and no emoji.
 *
 * The set was chosen by hand from a live line-up (2026-07-13). `claude` is the default: it is the
 * flower pulse users already read as "the agent is thinking". Custom user-defined frame sequences
 * can join later: surfaces receive frames, never ids, so they need no changes.
 */

export interface AdSpinner {
  id: string;
  label: string;
  /** Empty means "no spinner": the ad renders bare and surfaces fall back to their own marker. */
  frames: readonly string[];
  intervalMs: number;
}

export const AD_SPINNERS: readonly AdSpinner[] = [
  { id: 'claude', label: 'Claude', frames: ['·', '✢', '✳', '✻', '✽', '✻', '✳', '✢'], intervalMs: 120 },
  { id: 'dots', label: 'Dots', frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], intervalMs: 80 },
  { id: 'line', label: 'Line', frames: ['|', '/', '-', '\\'], intervalMs: 130 },
  { id: 'circle-halves', label: 'Circle halves', frames: ['◐', '◓', '◑', '◒'], intervalMs: 120 },
  { id: 'square-quarters', label: 'Square quarters', frames: ['◰', '◳', '◲', '◱'], intervalMs: 120 },
  { id: 'triangle', label: 'Triangle', frames: ['◢', '◣', '◤', '◥'], intervalMs: 120 },
  { id: 'arrows', label: 'Arrows', frames: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'], intervalMs: 110 },
  { id: 'pulse', label: 'Pulse', frames: ['·', '•', '●', '•'], intervalMs: 150 },
  { id: 'star', label: 'Star', frames: ['✶', '✸', '✹', '✺', '✹', '✸'], intervalMs: 130 },
  { id: 'toggle', label: 'Toggle', frames: ['⊶', '⊷'], intervalMs: 280 },
  { id: 'none', label: 'None', frames: [], intervalMs: 0 },
];

export const DEFAULT_SPINNER_ID = 'claude';

/**
 * Resolve an id to a spinner. Unknown ids (a setting synced from a newer version, a retired id)
 * fall back to the default rather than erroring: a cosmetic preference must never break an ad.
 */
export function getSpinner(id: string | undefined): AdSpinner {
  const hit = AD_SPINNERS.find(s => s.id === id);
  return hit ?? AD_SPINNERS.find(s => s.id === DEFAULT_SPINNER_ID)!;
}

/** The frame to show at this instant, or '' for the none spinner. Pure wall-clock math. */
export function frameAt(spinner: AdSpinner, nowMs: number): string {
  if (spinner.frames.length === 0 || spinner.intervalMs <= 0) return '';
  return spinner.frames[Math.floor(nowMs / spinner.intervalMs) % spinner.frames.length] ?? '';
}
