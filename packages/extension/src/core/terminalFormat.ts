import type { SurfaceCreative } from '../hooks/server.js';

// Agent-neutral rendering of the terminal status-line string. Pure + tested. The creative line
// arrives already sanitized of escape sequences (server contract), so wrapping it in our own
// controlled ANSI/OSC-8 is safe.
const ESC = String.fromCharCode(27); // ESC (0x1b)
const ST = `${ESC}\\`; // OSC 8 string terminator (ESC \)
const MARKER = '◍'; // a small ring
// Bold + green: the sponsored line must stand out in the status row. Plain "dim" text was
// near-invisible on some terminal themes. ANSI bold+green (1;32) uses the terminal's own palette,
// so it stays readable in both light and dark themes.
const STYLE = `${ESC}[1;32m`;
const RESET = `${ESC}[0m`;

/**
 * Build the styled, optionally-clickable status-line string for a terminal creative.
 *
 * `spinnerFrame` replaces the static marker while a spinner is configured: the terminal cannot run
 * a timer of its own (the agent polls the status line on its own cadence), so the caller computes
 * the wall-clock frame per poll and the animation comes out coarse but correct.
 */
export function formatTerminalLine(c: SurfaceCreative, spinnerFrame = ''): string {
  const styled = `${STYLE}${spinnerFrame || MARKER} ${c.line}${RESET}`;
  if (!c.url) return styled;
  // OSC 8 hyperlink: clickable in supporting terminals (iTerm2/Kitty/WezTerm), plain text elsewhere.
  return `${ESC}]8;;${c.url}${ST}${styled}${ESC}]8;;${ST}`;
}
