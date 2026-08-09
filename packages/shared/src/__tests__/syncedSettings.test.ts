import { describe, it, expect } from 'vitest';
import {
  AD_FORMATS, ELEMENTS, adFormat, settingKey, formatSettings, isChosen, allFormatSettings,
  sanitizePatch, formatElements,
} from '../syncedSettings.js';
import { AD_SPINNERS, GLOW_THEMES, BANNER_FRAMES, DEFAULT_SPINNER_ID, DEFAULT_GLOW_THEME, DEFAULT_BANNER_FRAME, DEFAULT_BRAND_LOGO } from '../adCustomization.js';

/**
 * These values are pushed from the web into every linked editor, so the cases that matter are the
 * awkward ones: a format asked about an element it does not draw, an account still holding the old
 * account-wide keys, and a version skew in either direction. Every one must degrade to "use the
 * default for that element", never to a crash or a value an editor cannot render.
 */
describe('the element catalogue', () => {
  it('every default is valid by the element own check', () => {
    // A default that fails its own validator would be written into an editor that cannot render it,
    // and would look like a rendering bug rather than a settings bug.
    for (const e of Object.values(ELEMENTS)) {
      expect(e.isValid(e.defaultValue), `${e.id} default is not valid`).toBe(true);
    }
  });

  it('defaults agree with the option registries', () => {
    expect(ELEMENTS.spinner.defaultValue).toBe(DEFAULT_SPINNER_ID);
    expect(ELEMENTS.glow.defaultValue).toBe(DEFAULT_GLOW_THEME);
    expect(ELEMENTS.frame.defaultValue).toBe(DEFAULT_BANNER_FRAME);
    expect(ELEMENTS.logo.defaultValue).toBe(DEFAULT_BRAND_LOGO);
  });

  it('accepts every id its registry actually offers', () => {
    for (const s of AD_SPINNERS) expect(ELEMENTS.spinner.isValid(s.id)).toBe(true);
    for (const t of GLOW_THEMES) expect(ELEMENTS.glow.isValid(t.id)).toBe(true);
    for (const f of BANNER_FRAMES) expect(ELEMENTS.frame.isValid(f.id)).toBe(true);
  });

  it('every element a format declares is defined exactly once', () => {
    for (const f of AD_FORMATS) {
      for (const e of f.elements) expect(ELEMENTS[e], `${f.id} declares unknown element ${e}`).toBeDefined();
      expect(new Set(f.elements).size, `${f.id} declares a duplicate`).toBe(f.elements.length);
    }
  });

  it('only formats that can draw a thing declare it', () => {
    // The status bar and terminal are text-only, and only the chat banner has an outline. This is
    // the honest statement of what each format can do, and the reason per-format is not busywork.
    expect(adFormat('status-bar')!.elements).not.toContain('logo');
    expect(adFormat('terminal')!.elements).not.toContain('logo');
    expect(adFormat('thinking-line')!.elements).not.toContain('glow');
    expect(adFormat('chat-banner')!.elements).toContain('glow');
  });
});

describe('per-format independence', () => {
  it('one format spinner does not move another', () => {
    // The whole point of the model: changing the thinking line changes the thinking line.
    const prefs = { 'thinking-line.spinner': 'dots' };
    expect(formatSettings(prefs, 'thinking-line').spinner).toBe('dots');
    expect(formatSettings(prefs, 'chat-banner').spinner).toBe(DEFAULT_SPINNER_ID);
    expect(formatSettings(prefs, 'status-bar').spinner).toBe(DEFAULT_SPINNER_ID);
    expect(formatSettings(prefs, 'terminal').spinner).toBe(DEFAULT_SPINNER_ID);
  });

  it('each format can hold a different value for the same element', () => {
    const prefs = { 'thinking-line.spinner': 'pulse', 'chat-banner.spinner': 'dots' };
    expect(formatSettings(prefs, 'thinking-line').spinner).toBe('pulse');
    expect(formatSettings(prefs, 'chat-banner').spinner).toBe('dots');
  });

  it('returns only the elements a format draws', () => {
    expect(Object.keys(formatSettings(null, 'status-bar'))).toEqual(['spinner']);
    expect(Object.keys(formatSettings(null, 'chat-banner')).sort()).toEqual(['frame', 'glow', 'logo', 'spinner']);
  });

  it('falls back to defaults with nothing stored', () => {
    expect(formatSettings(null, 'chat-banner')).toEqual({
      spinner: DEFAULT_SPINNER_ID, logo: DEFAULT_BRAND_LOGO, glow: DEFAULT_GLOW_THEME, frame: DEFAULT_BANNER_FRAME,
    });
  });

  it('a false boolean is a choice, not an absence', () => {
    const prefs = { 'chat-banner.logo': false };
    expect(formatSettings(prefs, 'chat-banner').logo).toBe(false);
    expect(isChosen(prefs, 'chat-banner', 'logo')).toBe(true);
  });
});

describe('legacy account-wide keys', () => {
  // Accounts written before customization was per-format keep their choices with no data
  // migration: the old key seeds every format that draws that element.
  const legacy = { spinner: 'dots', brandLogo: false, chatBannerStyle: 'ember', chatBannerFrame: 'full' };

  it('an old account-wide spinner seeds every format', () => {
    for (const f of AD_FORMATS) expect(formatSettings(legacy, f.id).spinner).toBe('dots');
  });

  it('an old logo choice reaches only the formats that draw one', () => {
    expect(formatSettings(legacy, 'thinking-line').logo).toBe(false);
    expect(formatSettings(legacy, 'chat-banner').logo).toBe(false);
    expect(formatSettings(legacy, 'status-bar')).not.toHaveProperty('logo');
  });

  it('old chat-banner keys never leak to another format', () => {
    // These were always chat-banner only; fanning them out would invent a choice nobody made.
    expect(formatSettings(legacy, 'chat-banner').glow).toBe('ember');
    expect(formatSettings(legacy, 'thinking-line')).not.toHaveProperty('glow');
  });

  it('a per-format value wins over a legacy one', () => {
    const mixed = { ...legacy, 'chat-banner.spinner': 'pulse' };
    expect(formatSettings(mixed, 'chat-banner').spinner).toBe('pulse');
    expect(formatSettings(mixed, 'thinking-line').spinner).toBe('dots'); // still the legacy value
  });

  it('counts a legacy value as chosen, so the UI does not call it a default', () => {
    expect(isChosen(legacy, 'terminal', 'spinner')).toBe(true);
    expect(isChosen(null, 'terminal', 'spinner')).toBe(false);
  });
});

describe('version skew degrades safely', () => {
  it('skips a key from a NEWER server rather than choking', () => {
    const prefs = { 'chat-banner.spinner': 'dots', 'chat-banner.somethingWeShipLater': 'x', 'future-format.spinner': 'dots' };
    expect(formatSettings(prefs, 'chat-banner').spinner).toBe('dots');
    expect(() => allFormatSettings(prefs)).not.toThrow();
  });

  it('skips a value that has left an option list', () => {
    // An account holding a spinner we since removed must not have it written into an editor.
    expect(formatSettings({ 'chat-banner.spinner': 'a-spinner-we-deleted' }, 'chat-banner').spinner)
      .toBe(DEFAULT_SPINNER_ID);
  });

  it('skips a value of the wrong type', () => {
    expect(formatSettings({ 'chat-banner.logo': 'yes' }, 'chat-banner').logo).toBe(DEFAULT_BRAND_LOGO);
  });

  it('an unknown format id yields nothing rather than throwing', () => {
    expect(formatSettings(null, 'not-a-format' as never)).toEqual({});
  });
});

describe('allFormatSettings + sanitizePatch', () => {
  it('covers every declared pair exactly once', () => {
    const all = allFormatSettings(null);
    const expected = AD_FORMATS.reduce((n, f) => n + f.elements.length, 0);
    expect(all).toHaveLength(expected);
    expect(new Set(all.map(a => settingKey(a.format, a.element))).size).toBe(expected);
  });

  it('formatElements gives a renderer everything it needs, and nothing it cannot serialise', () => {
    // Both the panel's webview and the browser receive this as JSON. A function on it (isValid was
    // the obvious one to spread in) is silently dropped by one and rejected by the other, and the
    // control arrives with no options at all.
    const els = formatElements({ 'chat-banner.glow': 'ember' }, 'chat-banner');
    expect(els.map((e) => e.id)).toEqual(adFormat('chat-banner')!.elements);
    expect(JSON.parse(JSON.stringify(els))).toEqual(els);

    const glow = els.find((e) => e.id === 'glow')!;
    expect(glow.value).toBe('ember');
    expect(glow.chosen).toBe(true);
    expect(glow.control).toBe('swatch');
    expect(glow.options.length).toBeGreaterThan(1);
    // An inherited default must not be dressed up as a choice - that is the whole point of `chosen`.
    expect(els.find((e) => e.id === 'spinner')!.chosen).toBe(false);
  });

  it('every pick-one element validates exactly what it offers', () => {
    // isValid is DERIVED from the options, so an option nobody can pick, or a value the UI offers
    // and the store then refuses, are both unrepresentable.
    for (const e of Object.values(ELEMENTS)) {
      if (e.control === 'switch') { expect(e.options).toHaveLength(0); continue; }
      expect(e.options.length, `${e.id} offers nothing to pick`).toBeGreaterThan(0);
      for (const o of e.options) expect(e.isValid(o.id), `${e.id} refuses its own option ${o.id}`).toBe(true);
      expect(e.options.some((o) => o.id === e.defaultValue), `${e.id} default is not on offer`).toBe(true);
    }
  });

  /**
   * The developer owns the FRAME an ad is drawn in, never the MESSAGE. An element that could hide
   * the sponsored line or its link would let someone keep earning while showing the advertiser
   * nothing, which is the one customization this system must never grow.
   */
  it('offers no element that could suppress the sponsored line', () => {
    for (const id of Object.keys(ELEMENTS)) {
      expect(id, `${id} sounds like it touches the ad itself`).not.toMatch(/line|text|url|link|hide/i);
    }
  });

  it('sanitizePatch keeps valid pairs and drops everything else', () => {
    const clean = sanitizePatch({
      'chat-banner.glow': 'ember',
      'chat-banner.spinner': 'not-a-spinner',   // invalid value
      'status-bar.logo': true,                  // status bar draws no logo
      'nonsense': 1,
    });
    expect(clean).toEqual({ 'chat-banner.glow': 'ember' });
  });
});
