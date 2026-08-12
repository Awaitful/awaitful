/**
 * Ad-rendering customization: the spinner, the chat-banner glow theme, and its outline frame.
 *
 * PURE DATA + pure functions, no platform import - the single source of truth shared by the
 * extension (which renders these) and the web dashboard (which now also lets a developer set them,
 * synced to every linked device). Adding an option is one entry here; both surfaces pick it up with
 * no further code changes.
 */

// ── Ad spinner ──────────────────────────────────────────────────────────────────
// The little animation that precedes the sponsored line while the agent thinks.
//
// Every surface derives its current frame from the WALL CLOCK (`frameAt(spinner, Date.now())`),
// which buys two things for free: all surfaces animate in sync without sharing a timer, and the
// terminal status line (which Claude Code polls on its own cadence) shows the "right" frame per
// poll instead of needing a timer it cannot have.
//
// Curation rule: every frame of a spinner is EXACTLY ONE display column wide (pinned by test), or
// the ad text jitters sideways each tick. That rule is why bouncing-bar and arc were rejected by
// the owner. Text glyphs only - these must survive a terminal - and no emoji.

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

// ── Chat-banner glow theme ────────────────────────────────────────────────────────
// The animation CODE lives in the shim's `THEMES` registry (source-available - "read exactly what
// runs"); this is the id + label the UI offers and the host validates a preference against. Adding
// a theme means an entry here - the shim, the panel preview, and now the web all read from it.

const ANGLE_KF = "@property --cc-a{syntax:'<angle>';inherits:false;initial-value:0deg}@keyframes cc-spin{to{--cc-a:360deg}}";
const BREATHE_KF = "@keyframes cc-breathe{0%,100%{opacity:.28}50%{opacity:1}}";
/** All glow @keyframes/@property - injected once, into both the shim and any preview. */
export const GLOW_KEYFRAMES = ANGLE_KF + BREATHE_KF;

export interface GlowTheme {
  id: string;
  label: string;
  /** Simplified static gradient for the tiny picker chip. */
  swatch: string;
  /** The live glow-ring background. */
  background: string;
  /** The animation shorthand (references a name in GLOW_KEYFRAMES). */
  animation: string;
}

export const GLOW_THEMES: readonly GlowTheme[] = [
  // Awaitful's own: signal-green sweeping through the brand's ground green. The default, so a fresh
  // install glows on-brand. Brand hex lives ONLY here (single source), like every other theme.
  { id: 'signal', label: 'Signal', swatch: 'linear-gradient(90deg,#163300,#4ade80,#9fe870)',
    background: 'conic-gradient(from var(--cc-a),#9fe870,#4ade80,#163300,#4ade80,#9fe870)', animation: 'cc-spin 5s linear infinite' },
  { id: 'aurora', label: 'Aurora', swatch: 'linear-gradient(90deg,#38bdf8,#818cf8,#c084fc)',
    background: 'conic-gradient(from var(--cc-a),#38bdf8,#818cf8,#c084fc,#38bdf8)', animation: 'cc-spin 5s linear infinite' },
  { id: 'comet', label: 'Comet', swatch: 'linear-gradient(90deg,#0b1220,#7dd3fc,#e0f2fe)',
    background: 'conic-gradient(from var(--cc-a),#e0f2fe 0deg,rgba(125,211,252,0.55) 10deg,rgba(125,211,252,0.08) 34deg,transparent 62deg,transparent 360deg)', animation: 'cc-spin 2.4s linear infinite' },
  { id: 'breathing', label: 'Breathing', swatch: 'linear-gradient(90deg,#5eead4,#38bdf8,#818cf8)',
    background: 'linear-gradient(90deg,#5eead4,#38bdf8,#818cf8)', animation: 'cc-breathe 3.6s ease-in-out infinite' },
  { id: 'chameleon', label: 'Chameleon', swatch: 'linear-gradient(90deg,var(--vscode-focusBorder,#3794ff),var(--vscode-charts-purple,#b180ff),var(--vscode-charts-green,#89d185))',
    background: 'conic-gradient(from var(--cc-a),var(--vscode-focusBorder,#3794ff),var(--vscode-charts-purple,#b180ff),var(--vscode-charts-green,#89d185),var(--vscode-focusBorder,#3794ff))', animation: 'cc-spin 6s linear infinite' },
  { id: 'rainbow', label: 'Rainbow', swatch: 'linear-gradient(90deg,#ff5f6d,#ffc371,#47e891,#3aa3ff,#a55eea)',
    background: 'conic-gradient(from var(--cc-a),#ff5f6d,#ffc371,#47e891,#3aa3ff,#a55eea,#ff5f6d)', animation: 'cc-spin 6s linear infinite' },
  { id: 'ember', label: 'Ember', swatch: 'linear-gradient(90deg,#ff6a00,#ff2d55,#ffb347)',
    background: 'conic-gradient(from var(--cc-a),#ff6a00,#ff2d55,#ffb347,#ff6a00)', animation: 'cc-spin 5s linear infinite' },
];
export const DEFAULT_GLOW_THEME = 'signal';

/** The outline frame: how far the glow extends. Orthogonal to the colour theme. */
export interface BannerFrame {
  id: string;
  label: string;
}

export const BANNER_FRAMES: readonly BannerFrame[] = [
  { id: 'banner', label: 'Banner' }, // outline the ad only, sides aligned with the chat box
  { id: 'full', label: 'Full box' }, // one continuous outline around the ad + chat box
];
export const DEFAULT_BANNER_FRAME = 'banner';

/**
 * Whether an advertiser's logo shows when the ad carries one.
 *
 * The single source for this default. It used to have to match a VS Code manifest entry, tied by a
 * test because a manifest cannot import from here; that setting is gone, so this value now stands
 * alone. The web reads it to describe what an editor does when the account has set no preference.
 */
export const DEFAULT_BRAND_LOGO = true;
