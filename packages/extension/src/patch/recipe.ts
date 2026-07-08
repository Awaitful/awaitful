/**
 * Embedded patch recipes, keyed by Claude Code build id.
 *
 * A recipe is the *only* place that knows how to safely modify a specific
 * Claude Code build. Recipes are bundled in the extension as a fallback; the
 * server also delivers them keyed by build hash, with a canary channel.
 *
 * A recipe now has one or more **targets** — each a file the surface must modify,
 * with its own strategy, pristine hash, and marker. `pristineSha256` per target is
 * the SHA-256 of that file untouched for this build; the engine only ever backs up
 * / patches a file whose hash matches, so a file modified by another extension (or
 * hand-edited) is never mistaken for the original.
 *
 * NOTE ON AUTHORING: every pristine hash MUST be captured from, and re-verified
 * against, a genuinely clean Claude Code install (one no other extension has
 * modified).
 */

import type { RecipeResponse } from '@awaitful/shared';

export type PatchStrategy = 'append-shim' | 'csp-insert';

export interface RecipeTarget {
  /** File to modify, relative to the Claude Code extension directory. */
  file: string;
  strategy: PatchStrategy;
  pristineSha256: string;
  // append-shim: wrap `shim` between markers appended at EOF.
  markerStart?: string;
  markerEnd?: string;
  shim?: string;
  // csp-insert: replace the unique `find` substring with `replacement` (which is
  // `find` plus our directive). `marker` is a unique token in `replacement` used
  // to detect our edit. Byte-exact reversible: strip replaces `replacement` → `find`.
  find?: string;
  replacement?: string;
  marker?: string;
}

export interface PatchRecipe {
  buildId: string;
  version: string;
  recipeVersion: number;
  /** 0..1 authoring confidence; low values should not auto-apply. */
  confidence: number;
  targets: RecipeTarget[];
}

// Version token embedded in the shim marker. BUMP THIS whenever the shim body
// changes so an already-patched install is detected as stale and re-patched
// (instead of skipped as our-patch-present with the old shim running forever).
// v20: bumped for the Awaitful rename (the shim body changed — the host↔shim discovery key is now
// `awaitful`). Future shim changes bump this so an already-Awaitful-patched editor re-patches; a
// pre-rename CodeCue patch is handled as a foreign modification, not by staleness (see engine.ts).
export const SHIM_VERSION = 20;
export const MARKER_PREFIX = '/* AWAITFUL-START';
export const MARKER_START = `${MARKER_PREFIX} v${SHIM_VERSION} */`;
export const MARKER_END = '/* AWAITFUL-END */';

/**
 * Shim config, injected at `/*CONFIG*\/` so a reviewer sees exactly what runs and
 * detection can be hot-fixed server-side without an extension release.
 */
export interface ShimConfig {
  /** CSS selectors tried in order to locate Claude Code's spinner row (thinking detection + anchor). */
  selectors: string[];
  /** CSS selectors for the composer region the chat-banner docks above. */
  composerSelectors: string[];
  /** CSS selectors the chat-banner hides while it is on screen (CC's spinner line). */
  hideSelectors: string[];
  /** Render the tasteful per-turn elapsed timer next to the ad (mirrors CC's clock). */
  showTimer: boolean;
  /** Glow themes (id → live CSS) the chat-banner can render; the active one is picked by `bannerStyle`. */
  themes: Record<string, { background: string; animation: string }>;
  /** The @keyframes/@property all glow themes reference — injected once. */
  themeKeyframes: string;
}

/** A chat-banner glow style. The animation CODE lives in the shim's `THEMES` registry
 * (source-available — "read exactly what runs"); this is the id + label the UI offers and
 * the host validates a preference against. Adding a theme means an entry in BOTH places. */
// The chat-banner glow themes — the SINGLE source of truth. Each theme's live CSS (background +
// animation) is injected into the shim via ShimConfig.themes AND drives the panel's animated preview,
// so the preview always matches what renders. Add a theme = one entry here. `id` travels to the shim
// via the creative's `bannerStyle`; the shim ships the animation, the server/pref ships only the id.
const ANGLE_KF = "@property --cc-a{syntax:'<angle>';inherits:false;initial-value:0deg}@keyframes cc-spin{to{--cc-a:360deg}}";
const BREATHE_KF = "@keyframes cc-breathe{0%,100%{opacity:.28}50%{opacity:1}}";
/** All glow @keyframes/@property — injected once, into both the shim and the panel preview. */
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
export const DEFAULT_GLOW_THEME = 'aurora';

/** The outline frame: how far the glow extends. Orthogonal to the colour theme. */
export interface BannerFrame { id: string; label: string; }
export const BANNER_FRAMES: readonly BannerFrame[] = [
  { id: 'banner', label: 'Banner' },   // outline the ad only, sides aligned with the chat box
  { id: 'full', label: 'Full box' },   // one continuous outline around the ad + chat box
];
export const DEFAULT_BANNER_FRAME = 'banner';

/** Per-theme live CSS injected into the shim (id → background/animation). */
const SHIM_THEMES: Record<string, { background: string; animation: string }> =
  Object.fromEntries(GLOW_THEMES.map((t) => [t.id, { background: t.background, animation: t.animation }]));

// Detection anchor: Claude Code renders its animated "thinking" verb inside a
// `div.spinnerRow_<hash>` (the hash suffix changes per build; the `spinnerRow_`
// prefix is stable — confirmed by patch reports across many builds). Targeting CC's OWN
// class is far more resilient than the old verb-word / digit / "token" heuristic,
// which had to be re-authored for every build that added a verb and mis-fired on
// the "Thinking… N tokens" status line. The status line is a SEPARATE element, so
// `spinnerRow_` naturally covers only the animated verb line and leaves it alone.
// It's an array so a future build rename is a one-line recipe edit (or a
// server hot-fix) rather than a code change; if none match, the ad simply doesn't
// show (fail-safe — prime directive over visibility).
const DEFAULT_SELECTORS = ['[class*="spinnerRow_"]'];

// The chat-banner docks above Claude Code's composer — `inputContainer_<hash>` is the
// always-mounted, bottom-pinned region (same stable module family as spinnerRow_), with
// contenteditable/textarea fallbacks. Hidden CC lines (banner mode) default to the spinner
// row itself: hiding it removes ONLY the animated verb+glyph (the whole spinnerRow subtree),
// so the banner replaces the distracting line while the transcript is otherwise untouched.
const DEFAULT_COMPOSER_SELECTORS = ['[class*="inputContainer_"]', '[contenteditable][role="textbox"]', 'div[contenteditable]', 'textarea'];
const DEFAULT_HIDE_SELECTORS = ['[class*="spinnerRow_"]'];

// ── The webview shim (authored, readable — a reviewer can read it) ─────────────
//
// Runs inside Claude Code's webview. It shows the sponsored line ONLY while the agent
// is thinking, and reports what it actually showed back to the Awaitful host on 127.0.0.1
// — so the host bills verified impressions, never assumed ones (golden rule 3).
//
// TWO render modes, one at a time (the host tags each creative with `placement`):
//   • thinking-line — an opaque overlay covering CC's spinner verb (the default).
//   • chat-banner   — a fixed, gently-glowing banner docked above the composer, which
//     also HIDES CC's spinner line so the banner is the single thinking indicator. The
//     hide is a scoped injected <style> (never a DOM mutation) and is applied ONLY while
//     the banner is on screen — so if the banner can't render, CC's own spinner stays:
//     there is always exactly one thinking indicator, never zero.
//
// "Thinking" is detected from CC's OWN spinner verb, which is present (non-empty text)
// exactly while the agent is thinking — and whose text survives display:none, so the
// banner can hide the row and still read the signal. This also gives free pause handling:
// during a permission prompt CC clears the verb, so the ad hides and stops billing.
//
// CRITICAL SAFETY DESIGN — hard-won rules the shim never breaks:
//   1. NEVER mutate Claude Code's own DOM nodes. CC renders with React; writing to a
//      React-managed node's text/children crashes the panel ("removeChild: node is not a
//      child"). The shim renders a single OVERLAY element it owns, and to hide CC's
//      spinner it injects its OWN <style> element — React reconciles neither, so it can
//      never corrupt CC's tree. It only reads CC's class/text/geometry.
//   2. NO document-wide MutationObserver. A `{childList,subtree}` observer fires on every
//      streamed token — hundreds/sec — until the webview dies. Detection is a slow
//      interval; smooth work (positioning + timer + glow) rides requestAnimationFrame /
//      compositor animation, which self-pause when hidden.
//   3. Fail safe. Every path is wrapped so a failure can only hide the overlay (and
//      un-hide CC's spinner), never break the editor.
//
// The host port is discovered by scanning a small fixed 127.0.0.1 range (the webview
// cannot read the port file). CSP `connect-src http://127.0.0.1:*` (added by the
// csp-insert target) allows the beacons; `style-src 'unsafe-inline'` (already in CC's
// webview CSP) allows the injected hide/glow rules.
const THINKING_SHIM = String.raw`
;(function () {
  "use strict";
  try {
    var CFG = /*CONFIG*/;
    var SELECTORS = (CFG && CFG.selectors) || ['[class*="spinnerRow_"]'];
    var COMPOSER_SELECTORS = (CFG && CFG.composerSelectors) || ['[class*="inputContainer_"]', '[contenteditable][role="textbox"]', 'div[contenteditable]', 'textarea'];
    var HIDE_SELECTORS = (CFG && CFG.hideSelectors) || ['[class*="spinnerRow_"]'];
    var SHOW_TIMER = !(CFG && CFG.showTimer === false);
    // DOCK_GAP is NEGATIVE: the banner overlaps the composer's top edge by a few px so its opaque
    // background covers the hairline seam (otherwise the page background shows through when scrolled).
    var PORT_BASE = 51789, PORT_SPAN = 12, DOCK_GAP = -3;

    var origin = null, current = null, overlay = null, faceEl = null, glowEl = null;
    var iconEl = null, textEl = null, timerEl = null, lastEl = null;
    var simStart = 0, lastBeacon = 0, lastLive = 0, askAt = 0, fetching = false, fetchingSince = 0;
    var rectKey = "", styleAt = 0, fontVal = "", bgVal = "", timerText = "", builtSig = "", verbOffset = 0, glowKey = "";
    var cssEl = null, cssText = "";

    // Inspectable from the webview devtools: window.__awaitful
    var dbg = (globalThis.__awaitful = globalThis.__awaitful || {});
    dbg.loaded = true; dbg.host = null; dbg.spinner = false; dbg.creative = null; dbg.overlay = false;

    // The webview may be minimised / occluded / on another OS Space: setInterval keeps
    // firing there (only rAF self-pauses), and layout stays frozen non-zero so the
    // spinner still "looks" on screen. document.hidden is the truthful signal — it flips
    // only when the webview is actually not visible, NOT on mere focus loss — so we pause
    // the surface while hidden and never bill unseen time (golden rule 3).
    function isHidden() { try { return document.hidden === true; } catch (e) { return false; } }

    // fetch with a hard deadline so a loopback probe that connects but never answers (a
    // half-open socket squatting a port in our range) can't leave a promise pending
    // forever — which would wedge 'fetching' true and dark-out the surface for the whole
    // session. AbortController is available in CC's Electron and unaffected by CSP.
    function timedFetch(url, opts, ms) {
      var ac = (typeof AbortController === "function") ? new AbortController() : null;
      var o = opts || {}; if (ac) o.signal = ac.signal;
      var p = fetch(url, o);
      if (!ac) return p;
      var to = setTimeout(function () { try { ac.abort(); } catch (e) {} }, ms);
      return p.then(function (r) { clearTimeout(to); return r; }, function (e) { clearTimeout(to); throw e; });
    }

    // ---- host discovery (loopback port scan) ------------------------------
    function tryPorts(i, done) {
      if (i >= PORT_SPAN) { done(null); return; }
      var base = "http://127.0.0.1:" + (PORT_BASE + i);
      timedFetch(base + "/surface/hello", null, 800).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.awaitful) done(base); else tryPorts(i + 1, done); })
        .catch(function () { tryPorts(i + 1, done); });
    }
    function host(cb) { if (origin) { cb(origin); return; } tryPorts(0, function (o) { origin = o; cb(o); }); }
    // POST a beacon to the host. Plain fetch, NOT sendBeacon: the loopback is a different
    // origin, so the JSON content-type needs a CORS preflight — fetch performs it and the
    // host answers OPTIONS, whereas sendBeacon reports success while silently dropping the
    // non-safelisted request (which broke click-through AND rendered/visible billing).
    // Clicking the ad opens the sponsor URL host-side, so there's no webview teardown to
    // outrun and keepalive fetch is fully reliable here.
    function post(path, body) {
      host(function (o) {
        if (!o) return;
        try {
          fetch(o + path, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
        } catch (e) {}
      });
    }

    // ---- detection: Claude Code's OWN stable classes ----------------------
    // Pick the LAST non-empty, on-screen, not-ours match: the transcript appends, so the
    // live animating row is the latest; an emptied/off-screen row is skipped. Shared by
    // the spinner (thinking-line anchor) and composer (chat-banner anchor) finders.
    function pick(selectors, needText) {
      try {
        for (var s = 0; s < selectors.length; s++) {
          var els = document.querySelectorAll(selectors[s]);
          var best = null;
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.nodeType !== 1 || el.getAttribute("data-awaitful-overlay")) continue;
            if (needText && (el.textContent || "").trim() === "") continue;    // emptied row => turn end
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            if (r.top < 0 || r.top >= (window.innerHeight || 1e9)) continue;    // on-screen only
            best = el;
          }
          if (best) return best;
        }
      } catch (e) {}
      return null;
    }
    function findSpinner() { return pick(SELECTORS, true); }
    function findComposer() { return pick(COMPOSER_SELECTORS, false); }

    // Is CC thinking? Its spinner verb has non-empty text exactly while thinking, and that
    // text survives display:none — so this reads true even in banner mode where we've
    // hidden the row, and reads false the instant a turn ends or a permission prompt clears
    // the verb (free pause handling). Visibility-independent by design — do NOT gate on rect.
    function spinnerThinking() {
      try {
        for (var s = 0; s < SELECTORS.length; s++) {
          var els = document.querySelectorAll(SELECTORS[s]);
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.getAttribute("data-awaitful-overlay")) continue;
            if ((el.textContent || "").trim() !== "") return true;
          }
        }
      } catch (e) {}
      return false;
    }

    // ---- injected stylesheet: hide CC's spinner (banner) + glow @keyframes -
    // Adding a <style> is React-safe (React never reconciles a stylesheet we add) and
    // reversible; CC's webview CSP includes style-src 'unsafe-inline', so the rules apply.
    // Present ONLY while our banner is on screen (see show/hide) — so if the banner can't
    // render, CC's spinner stays visible: never zero thinking indicators.
    function setCss(txt) {
      try {
        if (!txt) { if (cssEl && cssText) { cssText = ""; cssEl.textContent = ""; } return; }
        if (!cssEl) {
          cssEl = document.createElement("style");
          cssEl.setAttribute("data-awaitful-style", "1");
          (document.head || document.documentElement).appendChild(cssEl);
        }
        if (cssText !== txt) { cssText = txt; cssEl.textContent = txt; }
      } catch (e) {}
    }
    function hideRule() {
      var out = "";
      for (var i = 0; i < HIDE_SELECTORS.length; i++) out += HIDE_SELECTORS[i] + "{display:none!important}";
      return out;
    }

    // ---- glow themes for the chat banner (registry: add a theme = one entry here + one in
    // GLOW_THEMES). Every theme animates COMPOSITOR-only properties: a registered @property <angle>
    // (colours flow AROUND the frame — rotating the element would swing a rectangle's corners), or
    // opacity. No layout, no filter, no observer, so nothing can saturate the renderer. The @property
    // + @keyframes need the stylesheet (injected by setCss); the gradient + animation shorthand are set
    // via .style (CSSOM), which CSP does not gate. prefers-reduced-motion disables the animation via
    // a media rule setCss injects, leaving a tasteful static border. ----
    // Per-theme live CSS (background + animation) comes from the INJECTED config — the same
    // GLOW_THEMES data the panel preview uses, so preview always matches render. The @keyframes/
    // @property (CFG.themeKeyframes) are injected once by setCss. reduced-motion freezes to a static
    // border. Adding a theme is one GLOW_THEMES entry; nothing changes in the shim body.
    var THEMES = (CFG && CFG.themes) || {};
    function themeOf(id) { return THEMES[id] || THEMES.aurora || { background: "", animation: "" }; }
    var GLOW_KF = (CFG && CFG.themeKeyframes) || "";
    var REDUCED_MOTION = "@media (prefers-reduced-motion:reduce){[data-cc-glow]{animation:none!important}}";

    // ---- robust theming ---------------------------------------------------
    // The face must be OPAQUE to cover CC's verb (line mode) or read cleanly over the
    // transcript (banner mode). Walk ancestors for the first FULLY-opaque background (skip
    // transparent AND translucent); fall back to the VS Code editor-background var so we
    // match the panel even when nothing resolves (and it re-themes for free on a switch).
    function isOpaque(bg) {
      if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") return false;
      var m = bg.match(/rgba\(\s*[^)]*,\s*([0-9.]+)\s*\)/);           // alpha channel, if any
      if (m && parseFloat(m[1]) < 0.95) return false;
      return true;
    }
    function solidBg(el) {
      try {
        for (var n = el, i = 0; n && n.nodeType === 1 && i < 12; i++, n = n.parentElement) {
          var bg = getComputedStyle(n).backgroundColor;
          if (isOpaque(bg)) return bg;
        }
      } catch (e) {}
      return "var(--vscode-editor-background, #1e1e1e)";
    }

    // ---- overlay: a positioning box we own; content lives in faceEl -------
    function ensureOverlay() {
      if (overlay && document.body && document.body.contains(overlay)) return overlay;
      overlay = document.createElement("div");
      overlay.setAttribute("data-awaitful-overlay", "1");
      // visibility:hidden until the first real placement, so the box never flashes at 0,0.
      overlay.style.cssText =
        "position:fixed;z-index:2147483000;pointer-events:auto;display:none;visibility:hidden;box-sizing:border-box;";
      overlay.addEventListener("click", onClick, false);
      (document.body || document.documentElement).appendChild(overlay);
      builtSig = ""; iconEl = textEl = timerEl = faceEl = glowEl = null;
      return overlay;
    }
    // Icon + ad text + timer, appended to the given parent. Rebuilt ONLY when the creative's shape
    // changes (rotation / mode / theme), never per frame — innerHTML-per-tick detaches the
    // click target mid-click. The hot path only writes text nodes.
    function buildContent(c, parent) {
      // Logo slot — an <img> hidden until a creative carries a data: iconUrl. A broken/blocked
      // image hides itself; onerror is wired in JS (CC's CSP blocks inline onerror="").
      iconEl = document.createElement("img");
      iconEl.setAttribute("data-cc-icon", "1");
      iconEl.setAttribute("aria-hidden", "true");
      iconEl.style.cssText = "width:13px;height:13px;border-radius:3px;flex:0 0 auto;object-fit:contain;display:none;";
      iconEl.onerror = function () { try { iconEl.style.display = "none"; } catch (e) {} };
      parent.appendChild(iconEl);
      // Only data: URIs render — CC's img-src CSP allows only data: + the webview cspSource,
      // so an external https logo is blocked; this guard avoids even a transient broken image.
      if (c.iconUrl && /^data:/i.test(c.iconUrl)) { try { iconEl.src = c.iconUrl; iconEl.style.display = "block"; } catch (e) {} }
      // Ad text — foreground colour from the VS Code var so it reads native in either theme;
      // underline marks it as the clickable link it is.
      textEl = document.createElement("span");
      textEl.setAttribute("data-cc-text", "1");
      textEl.style.cssText =
        "min-width:0;overflow:hidden;text-overflow:ellipsis;text-decoration:underline;color:var(--vscode-foreground, currentColor);";
      textEl.textContent = c.line || "";
      parent.appendChild(textEl);
      // Elapsed timer — the tasteful "still thinking, sponsored" tell. Right-pinned, dim,
      // tabular so digits don't jitter. Updated in the rAF loop.
      if (SHOW_TIMER) {
        timerEl = document.createElement("span");
        timerEl.setAttribute("data-cc-timer", "1");
        timerEl.style.cssText =
          "flex:0 0 auto;margin-left:auto;padding-left:16px;opacity:.6;font-variant-numeric:tabular-nums;color:var(--vscode-descriptionForeground, currentColor);";
        parent.appendChild(timerEl);
        timerText = "";
      } else timerEl = null;
    }
    function build(c) {
      var banner = c.placement === "chat-banner";
      var sig = (c.adId || "") + "|" + (c.iconUrl || "") + "|" + (c.line || "") + "|" + (SHOW_TIMER ? "1" : "0") + "|" + (banner ? "b:" + (c.bannerStyle || "") + ":" + (c.bannerFrame || "") : "s");
      if (sig === builtSig) return;
      builtSig = sig; rectKey = ""; styleAt = 0; fontVal = ""; bgVal = ""; glowKey = "";
      overlay.textContent = ""; glowEl = null; faceEl = null;
      if (banner) {
        overlay.style.overflow = "visible";   // the glow ring extends beyond the face/box
        overlay.style.alignItems = ""; overlay.style.gap = ""; overlay.style.whiteSpace = "";
        var full = c.bannerFrame === "full";
        // FACE first (opaque ad content). Rounded top; 'full' adds a divider between ad and chat box.
        faceEl = document.createElement("div");
        faceEl.setAttribute("data-cc-face", "1");
        faceEl.style.cssText = "position:relative;z-index:1;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;box-sizing:border-box;border-radius:8px 8px 0 0;padding:5px 12px;width:100%;" +
          (full ? "border-bottom:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,.35));" : "");
        overlay.appendChild(faceEl);
        buildContent(c, faceEl);
        // GLOW ring LAST so it's on top by BOTH DOM order and z-index — otherwise the face's opaque bg
        // clips the left/right of the ring once the ring aligns to the chat box edges (only the top, which
        // sits above the face, would show). Masked (only the 2px border paints, centre transparent) +
        // pointer-events:none → it never covers the ad text or blocks clicks. Extent set per frame in placeDocked.
        glowEl = document.createElement("div");
        glowEl.setAttribute("aria-hidden", "true");
        glowEl.setAttribute("data-cc-glow", "1");   // target for the reduced-motion rule
        glowEl.style.cssText = "position:absolute;z-index:2;pointer-events:none;box-sizing:border-box;" +
          "-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;";
        var _t = themeOf(c.bannerStyle);
        glowEl.style.background = _t.background || "";
        glowEl.style.animation = _t.animation || "";
        overlay.appendChild(glowEl);
      } else {
        // The line covers CC's spinner verb: overlay IS the flex row, made opaque in place().
        overlay.style.overflow = "hidden";
        overlay.style.alignItems = "center"; overlay.style.gap = "6px"; overlay.style.whiteSpace = "nowrap";
        buildContent(c, overlay);
      }
    }

    // Where does the VERB TEXT start? (thinking-line only.) The spinner row is
    // "<glyph> Verb… <timer>"; the animated glyph (·✢✳…) sits before the verb. We measure
    // the verb's first letter x from live layout (a read-only DOM Range — never a mutation),
    // so the ad aligns with the verb AND CC's glyph stays visible to its left. Null when it
    // can't be measured → caller falls back to the row's left edge (glyph covered, still shown).
    function verbLeft(el) {
      try {
        var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        var node;
        while ((node = w.nextNode())) {
          var t = node.nodeValue || "";
          var i = t.search(/[A-Za-z]/);          // first letter = start of the verb (glyph is a symbol)
          if (i < 0) continue;
          var rg = document.createRange();
          rg.setStart(node, i);
          rg.setEnd(node, i + 1);
          var rr = rg.getBoundingClientRect();
          if (rr && (rr.left || rr.top || rr.width)) return rr.left;
        }
      } catch (e) {}
      return null;
    }
    function copyFont(fromEl, toEl) {
      try {
        var cs = getComputedStyle(fromEl);
        var f = cs.font || (cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily);
        if (f && f !== fontVal) { fontVal = f; toEl.style.font = f; }
      } catch (e) {}
    }

    // ---- positioning: over the spinner (line) or docked above the composer (banner) ----
    function placeSpinner(el) {
      var ov = overlay; if (!ov) return;
      try {
        var now = Date.now();
        var r = el.getBoundingClientRect();
        // Font + background + verb offset on a slow cadence (also catches a mid-session
        // theme switch); only WRITE when the value actually changed. verbOffset is cached
        // (stable within a turn) instead of re-measuring a Range every rAF frame.
        if (now - styleAt > 1500 || !fontVal) {
          styleAt = now;
          copyFont(el, ov);
          var bg = solidBg(el);
          if (bg !== bgVal) { bgVal = bg; ov.style.background = bg; }
          var vx = verbLeft(el);
          verbOffset = (vx !== null && vx > r.left && vx < r.right) ? (vx - r.left) : 0;
        }
        var left = r.left + verbOffset;                 // align the ad with the verb, not the glyph
        var vw = (window.innerWidth || 800);
        var key = left + "," + r.top + "," + r.right + "," + r.height;
        if (key !== rectKey) {
          rectKey = key;
          ov.style.width = "";                // clear any banner-mode fixed width
          ov.style.left = left + "px";
          ov.style.top = r.top + "px";
          ov.style.height = r.height + "px";
          // Cover at least the rest of the row (so no original verb/timer peeks past a short
          // ad), grow to fit a longer ad, but never past the viewport edge (then ellipsize).
          ov.style.minWidth = Math.max(0, r.right - left) + "px";
          ov.style.maxWidth = Math.max(120, vw - left - 24) + "px";
          ov.style.display = "flex";
          ov.style.visibility = "visible";
        }
      } catch (e) {}
    }
    // Dock the banner in the gap just above the composer's top edge. A fixed element with
    // no explicit width shrinks to its content (the face), capped at the composer width.
    function placeDocked(el) {
      var ov = overlay, fc = faceEl; if (!ov || !fc) return;
      try {
        var now = Date.now();
        var r = el.getBoundingClientRect();
        if (now - styleAt > 1500 || !fontVal) {
          styleAt = now;
          copyFont(el, fc);
          var bg = solidBg(el);
          if (bg !== bgVal) { bgVal = bg; fc.style.background = bg; }
        }
        var h = ov.offsetHeight || 28;
        // A real banner: span the FULL width of the composer and appose its top edge, so the face is
        // centred on the chat box and the rotating border spins around the BANNER's centre (not the text's).
        var left = r.left;
        var width = r.width;
        var top = Math.max(0, r.top - h - DOCK_GAP);
        var key = left + "," + top + "," + width;
        if (key !== rectKey) {
          rectKey = key;
          ov.style.left = left + "px";
          ov.style.top = top + "px";
          ov.style.width = width + "px";
          ov.style.maxWidth = ""; ov.style.minWidth = ""; ov.style.height = "";  // clear any line-mode geometry
          ov.style.display = "block";
          ov.style.visibility = "visible";
        }
        // Glow extent per frame. 'full' rings the ad + chat box (bottom extends down over the composer,
        // tracking its height); 'banner' rings the ad only (open bottom, sides aligned to the box). Sides
        // sit at the composer edges (left/right:0) so the outline lines up with the box's own borders.
        var glow = glowEl; if (!glow) return;
        var full = current && current.bannerFrame === "full";
        var ch = full ? Math.round(r.height) : 0;
        var gk = (full ? "F" : "B") + ch;
        if (gk !== glowKey) {
          glowKey = gk;
          glow.style.top = "-2px"; glow.style.left = "0px"; glow.style.right = "0px";
          if (full) {
            glow.style.bottom = (-ch) + "px";
            glow.style.padding = "2px";
            glow.style.borderRadius = "9px";
          } else {
            glow.style.bottom = "0px";
            glow.style.padding = "2px 2px 0 2px";
            glow.style.borderRadius = "9px 9px 0 0";
          }
        }
      } catch (e) {}
    }
    function reposition(el) {
      if (!overlay || !el) return;
      if (current && current.placement === "chat-banner") placeDocked(el); else placeSpinner(el);
    }

    function onClick() { if (current) post("/surface/click", { adId: current.adId, slateId: current.slateId }); }

    function anchorFor(c) { return (c && c.placement === "chat-banner") ? findComposer() : findSpinner(); }

    function show(c) {
      ensureOverlay();
      build(c);
      var anchor = anchorFor(c);
      if (!anchor) return;                 // can't place yet — CC's own indicator stays up
      lastEl = anchor;
      overlay.style.cursor = c.url ? "pointer" : "default";
      overlay.title = "Sponsored · Awaitful";
      reposition(anchor);
      // Hand off: hide CC's spinner ONLY now that our banner is placed (never before).
      if (c.placement === "chat-banner") setCss(hideRule() + GLOW_KF + REDUCED_MOTION);
      dbg.overlay = true;
    }
    function hide() {
      if (overlay) { overlay.style.display = "none"; overlay.style.visibility = "hidden"; }
      setCss("");                          // un-hide CC's spinner (never zero indicators)
      current = null; simStart = 0; rectKey = ""; timerText = ""; lastBeacon = 0; styleAt = 0; fontVal = ""; bgVal = ""; dbg.overlay = false;
    }
    function fmt(ms) { return (Math.max(0, ms) / 1000).toFixed(1) + "s"; }

    // ---- rAF: keep the overlay glued to its anchor + tick the timer -------
    function frame() {
      try {
        if (overlay && current && lastEl && lastEl.isConnected) {
          reposition(lastEl);
          if (SHOW_TIMER && timerEl && simStart) {
            var t = fmt(Date.now() - simStart);
            if (t !== timerText) { timerText = t; timerEl.textContent = t; }
          }
        }
      } catch (e) {}
      try { requestAnimationFrame(frame); } catch (e) { setTimeout(frame, 16); }
    }
    try { requestAnimationFrame(frame); } catch (e) { setTimeout(frame, 16); }

    // ---- detection + session lifecycle (slow; rAF does the smooth work) ----
    function changed(a, b) {
      return a.adId !== b.adId || a.line !== b.line ||
        (a.url || "") !== (b.url || "") || (a.iconUrl || "") !== (b.iconUrl || "") ||
        (a.placement || "") !== (b.placement || "") || (a.bannerStyle || "") !== (b.bannerStyle || "") ||
        (a.bannerFrame || "") !== (b.bannerFrame || "");
    }
    function adopt(c) {
      current = c; simStart = Date.now(); lastBeacon = simStart; lastLive = simStart;
      show(c);
      post("/surface/rendered", { adId: c.adId, slateId: c.slateId });
    }
    function tick() {
      try {
        // Never let 'fetching' stay stuck true (belt-and-suspenders with timedFetch).
        if (fetching && Date.now() - fetchingSince > 15000) fetching = false;
        // Pause the surface entirely while the window is hidden/minimised/occluded (golden
        // rule 3: only count time the developer could actually see).
        if (isHidden()) { if (current) hide(); return; }

        if (current) {
          // Active session. End the instant CC stops thinking (turn end OR a permission
          // prompt clears the verb) — crisp, both modes, via the visibility-independent
          // verb text. Then re-acquire the anchor per mode; losing it fail-safe hides.
          if (!spinnerThinking()) { hide(); return; }
          var el = anchorFor(current);
          if (!el) { hide(); return; }
          lastEl = el;
          var now = Date.now();
          if (now - lastBeacon >= 1000) {
            lastBeacon = now;
            post("/surface/visible", { adId: current.adId, slateId: current.slateId, visibleMs: 1000 });
          }
          if (now - lastLive >= 2000 && !fetching) {   // host-gated liveness + rotation backstop
            lastLive = now; fetching = true; fetchingSince = now;
            host(function (o) {
              if (!o) { fetching = false; return; }
              timedFetch(o + "/surface/creative", null, 4000).then(function (r) { return r.status === 200 ? r.json() : null; })
                .then(function (c) {
                  fetching = false;
                  if (!current) return;                                            // torn down mid-fetch
                  if (!c || !c.line) { hide(); askAt = Date.now() + 2000; return; } // host ended session => hide
                  if (changed(c, current)) adopt(c);                               // rotated / theme change
                }).catch(function () { fetching = false; });
            });
          }
          return;
        }

        // No session: CC's spinner verb is the thinking signal in BOTH modes (we only hide
        // the row AFTER our banner is up). The host's creative tells us which mode to render.
        var thinking = spinnerThinking();
        dbg.spinner = thinking;
        if (!thinking) return;
        var t = Date.now();
        if (fetching || t < askAt) return;
        fetching = true; fetchingSince = t;
        host(function (o) {
          dbg.host = o;
          if (!o) { fetching = false; askAt = Date.now() + 1000; return; }
          timedFetch(o + "/surface/creative", null, 4000).then(function (r) { return r.status === 200 ? r.json() : null; })
            .then(function (c) {
              fetching = false; dbg.creative = c;
              if (!c || !c.line) { askAt = Date.now() + 2000; return; }   // host has no fill => back off
              if (isHidden() || !spinnerThinking()) return;               // hidden or turn ended mid-fetch
              // Only adopt once the anchor is actually placeable (e.g. the spinner is on-screen
              // in line mode). Otherwise adopt->show can't place and the next tick hides again;
              // throttle instead of churning adopt/rendered at tick rate while it's out of view.
              if (!anchorFor(c)) { askAt = Date.now() + 500; return; }
              adopt(c);
            }).catch(function () { fetching = false; askAt = Date.now() + 1500; });
        });
      } catch (e) { try { hide(); } catch (e2) {} }
    }
    setInterval(tick, 250);
    // Stop billing the instant the window hides (don't wait for the next throttled tick).
    try { document.addEventListener("visibilitychange", function () { try { if (isHidden() && current) hide(); } catch (e) {} }, false); } catch (e) {}
  } catch (e) { /* prime directive: never break the editor */ }
})();
`.trim();

/** Inject the readable config literal into the shim (function form avoids `$` in String.replace). */
function shimForConfig(cfg: ShimConfig): string {
  return THINKING_SHIM.replace('/*CONFIG*/', () => JSON.stringify(cfg));
}

// Detection is now build-independent (CC's own classes), so one shim serves every build.
const DEFAULT_SHIM_CONFIG: ShimConfig = {
  selectors: DEFAULT_SELECTORS,
  composerSelectors: DEFAULT_COMPOSER_SELECTORS,
  hideSelectors: DEFAULT_HIDE_SELECTORS,
  showTimer: true,
  themes: SHIM_THEMES,
  themeKeyframes: GLOW_KEYFRAMES,
};
const THINKING_SHIM_BODY = shimForConfig(DEFAULT_SHIM_CONFIG);

// The CSP relaxation is identical across builds (same webview CSP template). We put
// our `connect-src` FIRST — immediately after `default-src 'none';`, before `${p}`
// (which itself expands to a connect-src directive) — so ours is the effective one
// (CSP uses the first `connect-src`; later duplicates are ignored). `awaitful.invalid`
// is a unique, never-resolving marker host (RFC 6761); it permits no real connection.
export const CSP_FIND = "default-src 'none'; ${p};";
const CSP_REPLACEMENT = "default-src 'none'; connect-src http://127.0.0.1:* awaitful.invalid; ${p};";

/**
 * The two patch targets for a build, binding OUR embedded shim/CSP to the given pristine
 * hashes. When `selectors` are supplied (a server hot-fix), the shim is re-generated with them;
 * otherwise the default-config shim is reused. This is the single place shim/CSP live — server
 * recipes carry data only (hashes + optional selectors), never executable shim code.
 */
function buildTargets(webSha: string, extSha: string, selectors?: string[]): RecipeTarget[] {
  // A server hot-fix carries only the spinner `selectors`; composer/hide selectors ride the
  // embedded defaults (server-delivered structured selectors are a later slice).
  const shim = selectors && selectors.length
    ? shimForConfig({ ...DEFAULT_SHIM_CONFIG, selectors })
    : THINKING_SHIM_BODY;
  return [
    { file: 'webview/index.js', strategy: 'append-shim', pristineSha256: webSha,
      markerStart: MARKER_START, markerEnd: MARKER_END, shim },
    { file: 'extension.js', strategy: 'csp-insert', pristineSha256: extSha,
      find: CSP_FIND, replacement: CSP_REPLACEMENT, marker: 'awaitful.invalid' },
  ];
}

/** Build a recipe for one Claude Code build (embedded fallback). */
function makeRecipe(buildId: string, version: string, webSha: string, extSha: string): PatchRecipe {
  return { buildId, version, recipeVersion: SHIM_VERSION, confidence: 0.5, targets: buildTargets(webSha, extSha) };
}

/**
 * Assemble a full `PatchRecipe` from a server (or self-computed) `RecipeResponse`: DATA (per-target
 * pristine hashes + optional selectors) + our EMBEDDED shim/CSP. Returns undefined if the response
 * lacks the expected two targets. The engine then re-verifies every hash byte-for-byte before writing.
 */
export function assembleRecipe(resp: RecipeResponse): PatchRecipe | undefined {
  const web = resp.targets.find((t) => t.file === 'webview/index.js' && t.strategy === 'append-shim');
  const ext = resp.targets.find((t) => t.file === 'extension.js' && t.strategy === 'csp-insert');
  if (!web || !ext) return undefined;
  return {
    buildId: resp.buildId, version: resp.version, recipeVersion: SHIM_VERSION, confidence: resp.confidence,
    targets: buildTargets(web.pristineSha256, ext.pristineSha256, resp.selectors),
  };
}

// NOTE: each build's pristine hashes MUST be authored from a genuinely clean Claude
// Code install for that exact build (the server delivers these so an update
// doesn't require an extension release).
const RECIPES: readonly PatchRecipe[] = [
  makeRecipe('anthropic.claude-code-2.1.199-darwin-x64', '2.1.199',
    '9d975a629702568feda07daee13db9f9651b7d4ac810a01ac38175e63092810c',
    '970e7f13d84f6e5dced5e3cee047d94b6ddf53801f69843b5b7f16e0f22b9cc5'),
  makeRecipe('anthropic.claude-code-2.1.200-darwin-x64', '2.1.200',
    'bb229d26fe5d0a49877222edf50a93e4cdd8efbd03b91c4fb890e45948f0acd0',
    '9069e2fee9bdc5341c908b250e4af2cdb99399b7c5667aa1af70e6221e6f40c7'),
  makeRecipe('anthropic.claude-code-2.1.201-darwin-x64', '2.1.201',
    '989c0ce3567a2b5e39d50021978ed13ecba8bc0fb7dfa03de77b6e00390bb8f6',
    '2896e67b90ca016ffaf0158c91b9c44cd1f72074eb9bc0ff7a454e8b060e2ab3'),
];

/** Look up the recipe for a build id, or undefined if none is embedded. */
export function findRecipe(buildId: string): PatchRecipe | undefined {
  return RECIPES.find((r) => r.buildId === buildId);
}
