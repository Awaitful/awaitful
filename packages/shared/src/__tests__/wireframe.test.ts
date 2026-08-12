import { describe, it, expect } from 'vitest';
import { WIREFRAME_SVG } from '../wireframe.js';
import { AD_FORMATS } from '../syncedSettings.js';

/**
 * The wireframe is a STRING shared by two apps that consume it very differently: the web sets it as
 * innerHTML, and the extension interpolates it into a template literal that carries its entire
 * client script. That second path is unforgiving, and none of it is typechecked - so these are the
 * guards that stand in for a compiler.
 */
describe('the shared wireframe', () => {
  /**
   * The one that has actually bitten. `JSON.stringify` escapes quotes and newlines but NOT a
   * backtick and NOT `${`, so either one lands verbatim inside panel.ts's client-script template
   * literal and ends it mid-file. The build error that follows points at a line hundreds of rows
   * away from the real cause.
   */
  it('carries nothing that could end a template literal', () => {
    expect(WIREFRAME_SVG).not.toContain('`');
    expect(WIREFRAME_SVG).not.toContain('${');
  });

  /** Two copies on one page would otherwise share element ids, and the highlight would cross-talk. */
  it('uses no id attribute, so two mounted copies cannot collide', () => {
    expect(WIREFRAME_SVG).not.toMatch(/\sid="/);
  });

  it('is decorative: the root svg is hidden from assistive tech', () => {
    expect(WIREFRAME_SVG).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  /**
   * The picture and the catalogue must name the same four things. A format added to AD_FORMATS with
   * no region drawn for it would leave a row that highlights nothing, and a region for a format that
   * no longer exists would be dead paint nobody can reach.
   */
  it('draws exactly one region per ad format, and no others', () => {
    const drawn = [...WIREFRAME_SVG.matchAll(/data-region="([a-z-]+)"/g)].map(m => m[1]);
    expect([...drawn].sort()).toEqual(AD_FORMATS.map(f => f.id).sort());
    expect(new Set(drawn).size, 'a region is drawn twice').toBe(drawn.length);
  });

  /** One spelling of each format, across the catalogue, both panels and the picture. */
  it('labels each region exactly as AD_FORMATS names it', () => {
    for (const format of AD_FORMATS) {
      const group = regionGroup(format.id);
      const text = group.match(/<text[^>]*>([^<]+)<\/text>/)?.[1];
      expect(text, `${format.id} has no label`).toBeDefined();
      expect(text).toBe(format.label);
    }
  });

  /**
   * The highlight colour is OURS, not VS Code's, so it has to come from the consumer rather than be
   * baked in - that is the whole point of moving this here. This fails the moment someone pastes a
   * literal back in while editing the artwork.
   */
  it('paints its regions only through the --awf-* properties', () => {
    for (const format of AD_FORMATS) {
      const group = regionGroup(format.id);
      for (const match of group.matchAll(/(?:fill|stroke)="([^"]+)"/g)) {
        const value = match[1] ?? '';
        expect(
          value === 'none' || value.startsWith('var(--awf-'),
          `${format.id} paints with a literal: ${value}`,
        ).toBe(true);
      }
    }
  });

  /**
   * Every property a consumer must supply is one both consumers already set. A fourth arriving
   * unnoticed would render black in whichever app was not updated, because an undefined var() with
   * no fallback is invalid at computed value time.
   */
  it('asks the consumer for exactly the three documented properties', () => {
    const used = new Set([...WIREFRAME_SVG.matchAll(/var\((--awf-[a-z-]+)/g)].map(m => m[1]));
    expect([...used].sort()).toEqual(['--awf-hl', '--awf-hl-glyph', '--awf-hl-ink']);
  });

  /** Belt and braces on the above: each reference keeps the value the artwork was drawn with. */
  it('gives every property a fallback, so it renders with no CSS at all', () => {
    for (const [ref] of WIREFRAME_SVG.matchAll(/var\(--awf-[a-z-]+[^)]*\)/g)) {
      expect(ref, `${ref} has no fallback`).toMatch(/^var\(--awf-[a-z-]+,/);
    }
  });
});

/** The markup of one hotspot group, from its opening tag to the matching close. */
function regionGroup(id: string): string {
  const open = WIREFRAME_SVG.indexOf(`<g data-region="${id}">`);
  expect(open, `no region drawn for ${id}`).toBeGreaterThan(-1);
  const end = WIREFRAME_SVG.indexOf('</g>', open);
  return WIREFRAME_SVG.slice(open, end);
}
