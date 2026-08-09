import { AD_SPINNERS, GLOW_THEMES, BANNER_FRAMES, DEFAULT_SPINNER_ID, DEFAULT_GLOW_THEME, DEFAULT_BANNER_FRAME, DEFAULT_BRAND_LOGO } from './adCustomization.js';

/**
 * How an ad looks, per ad format.
 *
 * ── Why every value is per-format ────────────────────────────────────────────────
 *
 * An earlier model kept one spinner and one logo choice for the whole account, because both are
 * drawn by more than one format. That put the reader to work: the spinner reaches all four formats,
 * the logo only the two that can draw one, and the glow only the chat banner - so changing anything
 * meant first working out how far it would travel, from a map that grows every time a format is
 * added. Per-format removes the question. Changing the thinking line's spinner changes the thinking
 * line. Nothing else, ever.
 *
 * It also buys a capability that was previously unexpressible: a restrained spinner inline in the
 * thinking line and a livelier one in the chat banner.
 *
 * ── The one rule that decides how a setting behaves ──────────────────────────────
 *
 * **Can applying it fail, or need consent?**
 *
 *  - YES  → it is NOT here. Choosing a format itself rewrites a Claude Code file, so it needs
 *           consent, another tool can block it, and only an explicit device report
 *           (`/v1/me/surface-applied`) can say whether it took.
 *  - NO   → it belongs here. Applying is a config write that cannot meaningfully fail, so there is
 *           no consent and no report: a device fetching the settings IS the receipt, and the web
 *           infers "applied" from that device's own check-in timestamp.
 *
 * ── Structure ────────────────────────────────────────────────────────────────────
 *
 * An ELEMENT is defined once (label, default, validator). A FORMAT declares which elements it
 * draws. Storage is one flat map keyed `${format}.${element}`, so every key has the same shape and
 * there is no "is this one global?" to learn. Adding a format is one entry in AD_FORMATS; giving an
 * existing format a new element is one array item. No definition is ever copied.
 *
 * ── How a value reaches a device ─────────────────────────────────────────────────
 *
 * The account carries a monotonic `prefsVersion`; a device stores the last version it applied and
 * acts only when the server's DIFFERS. So a change made inside an editor is never overwritten (the
 * version did not move), a change made on the web broadcasts once to every editor (it did), and a
 * fresh install inherits the account's choices (it has no stored version). Inequality rather than
 * greater-than, so a database restore that rewinds the counter still converges.
 */

/** A value an element can hold. Deliberately narrow - these are user-visible display choices. */
export type ElementValue = string | boolean;

export type AdFormatId = 'status-bar' | 'thinking-line' | 'chat-banner' | 'terminal';
export type ElementId = 'spinner' | 'logo' | 'glow' | 'frame';

/**
 * How a value is picked. The renderer maps this to a control ONCE, so adding an element - here and
 * to a format's list - gives both the panel and the web a working control with no new UI code.
 */
export type ElementControl = 'gallery' | 'swatch' | 'chip' | 'switch';

/** One choosable value, carrying whatever the control needs to draw it. */
export interface ElementOption {
  id: string;
  label: string;
  /** Gallery: the frames to animate in the tile, and their cadence. */
  frames?: readonly string[];
  intervalMs?: number;
  /** Swatch: `swatch` paints the chip; `background` + `animation` drive a live preview of the real thing. */
  swatch?: string;
  background?: string;
  animation?: string;
}

export interface CustomizationElement {
  id: ElementId;
  label: string;
  /** One line saying what it does, in the format's own terms. */
  hint: string;
  control: ElementControl;
  /** What can be picked. Empty for a switch, whose two states need no list. */
  options: readonly ElementOption[];
  /** What a format uses when the account has not chosen. Must match the extension's own default. */
  defaultValue: ElementValue;
  /** Does this build understand the value? Guards both directions of a version skew. */
  isValid(value: unknown): value is ElementValue;
}

/** A pick-one element. `isValid` is DERIVED from the options, so the two can never disagree. */
function choice(
  id: ElementId, label: string, hint: string,
  control: Exclude<ElementControl, 'switch'>,
  options: readonly ElementOption[], defaultValue: string,
): CustomizationElement {
  return {
    id, label, hint, control, options, defaultValue,
    isValid: (v): v is ElementValue => typeof v === 'string' && options.some((o) => o.id === v),
  };
}

function toggle(id: ElementId, label: string, hint: string, defaultValue: boolean): CustomizationElement {
  return {
    id, label, hint, control: 'switch', options: [], defaultValue,
    isValid: (v): v is ElementValue => typeof v === 'boolean',
  };
}

/** Defined ONCE. A format that draws an element references it; nothing is duplicated. */
export const ELEMENTS: Record<ElementId, CustomizationElement> = {
  spinner: choice(
    'spinner', 'Spinner', 'The animation before the sponsored line while your agent thinks.',
    'gallery',
    AD_SPINNERS.map((s) => ({ id: s.id, label: s.label, frames: s.frames, intervalMs: s.intervalMs })),
    DEFAULT_SPINNER_ID,
  ),
  logo: toggle(
    'logo', "Advertiser's logo", 'Show it when the ad carries one. Most do not.',
    DEFAULT_BRAND_LOGO,
  ),
  glow: choice(
    'glow', 'Glow', 'The colour that outlines the banner.',
    'swatch',
    GLOW_THEMES.map((t) => ({ id: t.id, label: t.label, swatch: t.swatch, background: t.background, animation: t.animation })),
    DEFAULT_GLOW_THEME,
  ),
  frame: choice(
    'frame', 'Outline', 'How far the glow extends around the banner.',
    'chip',
    BANNER_FRAMES.map((f) => ({ id: f.id, label: f.label })),
    DEFAULT_BANNER_FRAME,
  ),
};

export interface AdFormat {
  id: AdFormatId;
  label: string;
  /** Which elements this format actually draws. Order is the order they render in the UI. */
  elements: readonly ElementId[];
}

/**
 * "Format" rather than "surface": surface is our own jargon and tells a developer nothing. The
 * elements list is the honest statement of what each one can draw - the status bar and terminal are
 * text-only, so no logo, and only the chat banner has an outline to colour.
 */
export const AD_FORMATS: readonly AdFormat[] = [
  { id: 'status-bar', label: 'Status bar', elements: ['spinner'] },
  { id: 'thinking-line', label: 'Thinking line', elements: ['spinner', 'logo'] },
  { id: 'chat-banner', label: 'Chat banner', elements: ['spinner', 'logo', 'glow', 'frame'] },
  { id: 'terminal', label: 'Terminal', elements: ['spinner'] },
];

export function adFormat(id: string): AdFormat | undefined {
  return AD_FORMATS.find((f) => f.id === id);
}

/** The stored key for one element of one format. The ONLY place this shape is written. */
export function settingKey(format: AdFormatId, element: ElementId): string {
  return `${format}.${element}`;
}

/**
 * Legacy account-wide keys, from before customization was per-format. Read-only compatibility: a
 * stored legacy value seeds every format that draws that element, so an account keeps its choices
 * without a data migration and without the client needing to know which shape it is reading.
 * Nothing writes these any more.
 */
const LEGACY_KEYS: Record<string, ElementId> = {
  spinner: 'spinner',
  brandLogo: 'logo',
  chatBannerStyle: 'glow',
  chatBannerFrame: 'frame',
};

/** Legacy keys that only ever applied to one format, so they must not fan out to the others. */
const LEGACY_FORMAT_SCOPE: Record<string, AdFormatId | undefined> = {
  chatBannerStyle: 'chat-banner',
  chatBannerFrame: 'chat-banner',
};

/**
 * Resolve what a format should draw: the value the account chose, or the element's default.
 *
 * Never throws and never returns something this build cannot render. An unknown key (a newer server
 * talking to an older client) and a value that has since left an option list are both skipped, so a
 * settings rollout can never brick an editor that has not updated yet.
 */
export function formatSettings(
  prefs: Record<string, unknown> | null | undefined,
  format: AdFormatId,
): Record<ElementId, ElementValue> {
  const def = adFormat(format);
  const out = {} as Record<ElementId, ElementValue>;
  if (!def) return out;

  for (const elementId of def.elements) {
    const element = ELEMENTS[elementId];
    out[elementId] = element.defaultValue;
    if (!prefs) continue;

    // Legacy account-wide value seeds this format, unless it was scoped to a different one.
    for (const [legacyKey, mapped] of Object.entries(LEGACY_KEYS)) {
      if (mapped !== elementId) continue;
      const scope = LEGACY_FORMAT_SCOPE[legacyKey];
      if (scope && scope !== format) continue;
      const v = prefs[legacyKey];
      if (v !== undefined && element.isValid(v)) out[elementId] = v;
    }
    // A per-format value always wins over a legacy one.
    const v = prefs[settingKey(format, elementId)];
    if (v !== undefined && element.isValid(v)) out[elementId] = v;
  }
  return out;
}

/** Has the account explicitly chosen this element for this format (rather than inheriting a default)? */
export function isChosen(
  prefs: Record<string, unknown> | null | undefined,
  format: AdFormatId,
  element: ElementId,
): boolean {
  if (!prefs) return false;
  const own = prefs[settingKey(format, element)];
  if (own !== undefined && ELEMENTS[element].isValid(own)) return true;
  for (const [legacyKey, mapped] of Object.entries(LEGACY_KEYS)) {
    if (mapped !== element) continue;
    const scope = LEGACY_FORMAT_SCOPE[legacyKey];
    if (scope && scope !== format) continue;
    const v = prefs[legacyKey];
    if (v !== undefined && ELEMENTS[element].isValid(v)) return true;
  }
  return false;
}

/**
 * One element of one format, resolved and ready to draw: what it is, what can be picked, what is
 * picked now, and whether that was a real choice or an inherited default.
 *
 * Deliberately plain data - no functions - because this crosses two boundaries that would drop or
 * reject one: JSON to the panel's webview, and JSON to the browser. Both renderers read this same
 * shape, which is what keeps a control from being hand-written twice.
 */
export interface ResolvedElement {
  id: ElementId;
  label: string;
  hint: string;
  control: ElementControl;
  options: readonly ElementOption[];
  value: ElementValue;
  /** False when this is the element's default rather than something anyone picked. */
  chosen: boolean;
}

/** Everything a UI needs to render one format's customization. The only entry point renderers use. */
export function formatElements(
  prefs: Record<string, unknown> | null | undefined,
  format: AdFormatId,
): ResolvedElement[] {
  const resolved = formatSettings(prefs, format);
  return (adFormat(format)?.elements ?? []).map((id) => {
    const e = ELEMENTS[id];
    return {
      id, label: e.label, hint: e.hint, control: e.control, options: e.options,
      value: resolved[id], chosen: isChosen(prefs, format, id),
    };
  });
}

/**
 * Every (format, element) pair with the value to apply. What a client iterates to reconcile an
 * editor - one flat list, so no caller needs to know the nesting.
 */
export function allFormatSettings(
  prefs: Record<string, unknown> | null | undefined,
): { format: AdFormatId; element: ElementId; value: ElementValue }[] {
  const out: { format: AdFormatId; element: ElementId; value: ElementValue }[] = [];
  for (const f of AD_FORMATS) {
    const resolved = formatSettings(prefs, f.id);
    for (const e of f.elements) out.push({ format: f.id, element: e, value: resolved[e] });
  }
  return out;
}

/** Validate an incoming patch, dropping anything unknown or unrenderable. Used by the server. */
export function sanitizePatch(patch: Record<string, unknown>): Record<string, ElementValue> {
  const out: Record<string, ElementValue> = {};
  for (const f of AD_FORMATS) {
    for (const elementId of f.elements) {
      const key = settingKey(f.id, elementId);
      const v = patch[key];
      if (v !== undefined && ELEMENTS[elementId].isValid(v)) out[key] = v;
    }
  }
  return out;
}

/**
 * A patch setting one element to the same value on EVERY format that draws it.
 *
 * The bridge from the old account-wide controls to per-format storage, and the shape an
 * "apply everywhere" affordance would use if one is ever wanted. Formats that do not draw the
 * element are skipped, so this can never invent a choice a format cannot honour - asking for a logo
 * on the status bar produces nothing rather than an unrenderable key.
 */
export function patchEveryFormat(element: ElementId, value: ElementValue): Record<string, ElementValue> {
  const out: Record<string, ElementValue> = {};
  if (!ELEMENTS[element]?.isValid(value)) return out;
  for (const f of AD_FORMATS) {
    if (f.elements.includes(element)) out[settingKey(f.id, element)] = value;
  }
  return out;
}
