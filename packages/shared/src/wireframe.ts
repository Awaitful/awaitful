/**
 * A picture of a VS Code window, with one hotspot per ad format.
 *
 * ── One artwork, two apps ────────────────────────────────────────────────────────
 *
 * The extension panel and the web install page both draw this. It lives here because it was
 * previously extension-only, and the web needed the same picture: a second copy would mean every
 * future edit done twice, and the two quietly disagreeing about where the chat banner sits. The
 * region ids are deliberately NOT re-listed here - they are exactly AD_FORMATS' ids, and a second
 * list of formats is the thing syncedSettings.ts keeps deleting. A test ties the two together.
 *
 * ── How a consumer colours it ────────────────────────────────────────────────────
 *
 * The base wireframe is `currentColor` at 3-25% opacity, so it takes the host's text colour and
 * themes itself. Only the four hotspots carry colour, through three custom properties the consumer
 * sets on any ancestor:
 *
 *   --awf-hl        the highlight itself (extension: --brand; web: --color-accent)
 *   --awf-hl-ink    label text ON that highlight - must stay legible against --awf-hl
 *   --awf-hl-glyph  the ad glyphs inside the status-bar plate
 *
 * Each carries a fallback of the value the artwork was drawn with, and the fallbacks are
 * load-bearing rather than decoration: an undefined `var()` with no fallback is invalid at computed
 * value time, and `fill` then resolves to its initial black - the picture would not degrade, it
 * would break. With them, this string renders correctly dropped into a surface with no CSS at all.
 *
 * ── Showing a region ─────────────────────────────────────────────────────────────
 *
 * Pure CSS, no script: hotspots are `[data-region="<format id>"]`, hidden by default, revealed by a
 * `[data-active="<format id>"]` ancestor. That is what lets both apps stay declarative, and it is
 * why there is no `id=` anywhere in here - two copies mounted at once must not collide.
 *
 * ── One hard constraint ──────────────────────────────────────────────────────────
 *
 * NO BACKTICK and NO `${` may ever appear in this string. The extension interpolates it into a
 * template literal that carries its whole client script, via JSON.stringify(), which escapes
 * neither - a backtick here ends that script mid-file. A test pins this; it is not theoretical,
 * the build has broken this way before.
 */
export const WIREFRAME_SVG = `<svg viewBox="0 0 400 225" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <!-- Window chrome (short title bar) -->
  <rect width="400" height="225" rx="6" fill="currentColor" opacity=".06"/>
  <rect width="400" height="24" rx="6" fill="currentColor" opacity=".08"/>
  <rect y="18" width="400" height="6" fill="currentColor" opacity=".08"/>
  <circle cx="14" cy="11" r="3.5" fill="currentColor" opacity=".22"/>
  <circle cx="26" cy="11" r="3.5" fill="currentColor" opacity=".22"/>
  <circle cx="38" cy="11" r="3.5" fill="currentColor" opacity=".22"/>
  <!-- Command bar (top center, in line with the traffic lights) -->
  <rect x="140" y="5" width="120" height="11" rx="3" fill="currentColor" opacity=".05"/>
  <rect x="140" y="5" width="120" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1" opacity=".12"/>
  <rect x="154" y="9" width="92" height="3" rx="1" fill="currentColor" opacity=".14"/>

  <!-- Activity bar -->
  <rect x="0" y="24" width="24" height="186" fill="currentColor" opacity=".06"/>
  <rect x="4" y="34" width="16" height="16" rx="3" fill="currentColor" opacity=".15"/>
  <rect x="4" y="56" width="16" height="16" rx="3" fill="currentColor" opacity=".10"/>
  <rect x="4" y="78" width="16" height="16" rx="3" fill="currentColor" opacity=".10"/>

  <!-- Sidebar / explorer -->
  <rect x="24" y="24" width="48" height="186" fill="currentColor" opacity=".04"/>
  <rect x="30" y="34" width="36" height="5" rx="2" fill="currentColor" opacity=".20"/>
  <rect x="30" y="44" width="26" height="4" rx="2" fill="currentColor" opacity=".15"/>
  <rect x="30" y="52" width="32" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="30" y="60" width="22" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="30" y="68" width="28" height="4" rx="2" fill="currentColor" opacity=".12"/>

  <!-- Editor (middle-left, code) -->
  <rect x="72" y="24" width="144" height="150" fill="currentColor" opacity=".03"/>
  <rect x="80" y="34" width="100" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="42" width="122" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="50" width="82" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="62" width="114" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="70" width="94" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="82" width="110" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="94" width="78" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="106" width="118" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="118" width="98" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="130" width="112" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="142" width="86" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="80" y="154" width="102" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="80" y="166" width="90" height="4" rx="2" fill="currentColor" opacity=".16"/>

  <!-- Terminal (lower-middle, left of Claude Code, above the status bar) -->
  <rect x="72" y="176" width="144" height="34" fill="currentColor" opacity=".05"/>
  <rect x="72" y="176" width="144" height="1" fill="currentColor" opacity=".12"/>
  <rect x="80" y="182" width="22" height="4" rx="2" fill="currentColor" opacity=".25"/>
  <rect x="106" y="182" width="40" height="4" rx="2" fill="currentColor" opacity=".14"/>
  <circle cx="82" cy="198" r="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".20" stroke-dasharray="10 6"/>
  <rect x="92" y="194.5" width="96" height="7" rx="2" fill="currentColor" opacity=".12"/>

  <!-- Claude Code panel (docked right, widest) -->
  <rect x="218" y="24" width="182" height="186" fill="currentColor" opacity=".035"/>
  <rect x="218" y="24" width="1" height="186" fill="currentColor" opacity=".12"/>
  <!-- chat messages -->
  <rect x="226" y="34" width="130" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="226" y="42" width="150" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="226" y="50" width="108" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="226" y="62" width="142" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="226" y="70" width="96" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="226" y="82" width="134" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="226" y="90" width="104" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <!-- Thinking line (just above the banner) -->
  <circle cx="232" cy="157" r="5" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".22" stroke-dasharray="12 8"/>
  <rect x="242" y="153" width="96" height="8" rx="3" fill="currentColor" opacity=".12"/>
  <!-- Chat banner: same width as the chat box; rounded top, sides end where the box corner curve ends -->
  <path d="M226 178 L226 170 Q226 165 231 165 L387 165 Q392 165 392 170 L392 178 Z" fill="currentColor" opacity=".06"/>
  <path d="M226 184 L226 170 Q226 165 231 165 L387 165 Q392 165 392 170 L392 184" fill="none" stroke="currentColor" stroke-width="1" opacity=".14"/>
  <rect x="232" y="169" width="70" height="4" rx="2" fill="currentColor" opacity=".16"/>
  <rect x="368" y="169" width="20" height="4" rx="1" fill="currentColor" opacity=".16"/>
  <!-- Chat input box (placeholder row + mic, button row below) -->
  <rect x="226" y="178" width="166" height="30" rx="6" fill="currentColor" opacity=".03"/>
  <rect x="226" y="178" width="166" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1" opacity=".16"/>
  <rect x="232" y="184" width="88" height="4" rx="2" fill="currentColor" opacity=".14"/>
  <circle cx="384" cy="186" r="2.6" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".22"/>
  <rect x="232" y="197" width="7" height="7" rx="2" fill="currentColor" opacity=".14"/>
  <rect x="242" y="197" width="7" height="7" rx="2" fill="currentColor" opacity=".14"/>
  <rect x="346" y="199" width="26" height="4" rx="2" fill="currentColor" opacity=".12"/>
  <rect x="378" y="194" width="11" height="11" rx="3" fill="currentColor" opacity=".25"/>

  <!-- Status bar (very bottom strip; the ad area is the wide item at the right) -->
  <rect x="0" y="210" width="400" height="15" fill="currentColor" opacity=".08"/>
  <rect x="6" y="214" width="30" height="7" rx="2" fill="currentColor" opacity=".14"/>
  <rect x="42" y="214" width="22" height="7" rx="2" fill="currentColor" opacity=".10"/>
  <rect x="304" y="214" width="88" height="7" rx="2" fill="currentColor" opacity=".13"/>
  <circle cx="311" cy="217.5" r="2" fill="currentColor" opacity=".18"/>

  <!-- ═══════════ HOTSPOT OVERLAYS (toggled by JS) ═══════════════════════════ -->

  <!-- Status bar highlight (ad area = wide item on the right; label centered) -->
  <g data-region="status-bar">
    <rect x="0" y="210" width="400" height="15" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".25"/>
    <rect x="304" y="211" width="90" height="13" rx="2" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".6"/>
    <circle cx="311" cy="217.5" r="2.5" fill="var(--awf-hl-glyph,#fff)"/>
    <rect x="318" y="214" width="70" height="7" rx="2" fill="var(--awf-hl-glyph,#fff)" opacity=".75"/>
    <rect x="162" y="211" width="76" height="13" rx="2" fill="var(--awf-hl,oklch(86% 0.171 134))"/>
    <text x="200" y="220.5" text-anchor="middle" font-size="9" font-weight="600" fill="var(--awf-hl-ink,oklch(10% 0.004 135))">Status bar</text>
    <line x1="238" y1="217.5" x2="302" y2="217.5" stroke="var(--awf-hl,oklch(86% 0.171 134))" stroke-width="1" stroke-dasharray="3 2"/>
  </g>

  <!-- Thinking line highlight -->
  <g data-region="thinking-line">
    <rect x="218" y="149" width="182" height="16" rx="2" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".12"/>
    <circle cx="232" cy="157" r="5" fill="none" stroke="var(--awf-hl,oklch(86% 0.171 134))" stroke-width="1.8" stroke-dasharray="12 8"/>
    <rect x="242" y="153" width="100" height="8" rx="3" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".65"/>
    <rect x="108" y="149" width="100" height="16" rx="3" fill="var(--awf-hl,oklch(86% 0.171 134))"/>
    <text x="158" y="160.5" text-anchor="middle" font-size="9" font-weight="600" fill="var(--awf-hl-ink,oklch(10% 0.004 135))">Thinking line</text>
    <line x1="208" y1="157" x2="226" y2="157" stroke="var(--awf-hl,oklch(86% 0.171 134))" stroke-width="1" stroke-dasharray="3 2"/>
  </g>

  <!-- Chat banner highlight (same width; open-bottom outline; seconds bar) -->
  <g data-region="chat-banner">
    <path d="M226 178 L226 170 Q226 165 231 165 L387 165 Q392 165 392 170 L392 178 Z" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".24"/>
    <path d="M226 184 L226 170 Q226 165 231 165 L387 165 Q392 165 392 170 L392 184" fill="none" stroke="var(--awf-hl,oklch(86% 0.171 134))" stroke-width="1.2" opacity=".85"/>
    <rect x="232" y="169" width="70" height="4" rx="2" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".9"/>
    <rect x="368" y="169" width="20" height="4" rx="1" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".7"/>
    <rect x="104" y="163" width="100" height="16" rx="3" fill="var(--awf-hl,oklch(86% 0.171 134))"/>
    <text x="154" y="174.5" text-anchor="middle" font-size="9" font-weight="600" fill="var(--awf-hl-ink,oklch(10% 0.004 135))">Chat banner</text>
    <line x1="204" y1="171" x2="224" y2="172" stroke="var(--awf-hl,oklch(86% 0.171 134))" stroke-width="1" stroke-dasharray="3 2"/>
  </g>

  <!-- Terminal highlight -->
  <g data-region="terminal">
    <rect x="72" y="176" width="144" height="34" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".12"/>
    <rect x="72" y="176" width="144" height="1.5" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".5"/>
    <circle cx="82" cy="198" r="4" fill="none" stroke="var(--awf-hl,oklch(86% 0.171 134))" stroke-width="1.8" stroke-dasharray="10 6"/>
    <rect x="92" y="194.5" width="104" height="7" rx="2" fill="var(--awf-hl,oklch(86% 0.171 134))" opacity=".65"/>
    <rect x="98" y="160" width="86" height="16" rx="3" fill="var(--awf-hl,oklch(86% 0.171 134))"/>
    <text x="141" y="171.5" text-anchor="middle" font-size="9" font-weight="600" fill="var(--awf-hl-ink,oklch(10% 0.004 135))">Terminal</text>
    <line x1="141" y1="176" x2="141" y2="182" stroke="var(--awf-hl,oklch(86% 0.171 134))" stroke-width="1" stroke-dasharray="3 2"/>
  </g>
</svg>`;
