import { describe, it, expect, vi } from 'vitest';
import { buildHtml } from '../ui/panel.js';

// panel.ts imports the VS Code API at module scope, but buildHtml is a pure function of PanelState
// and never touches it. A bare stub is enough to get the module loaded. (vi.mock is hoisted above
// the import above, which is the only reason that import resolves at all.)
vi.mock('vscode', () => ({ window: {}, commands: {}, workspace: {}, Uri: {}, ViewColumn: { One: 1 } }));

/**
 * The panel's entire client script lives inside a template literal, which means TypeScript never
 * looks at it: a typo there compiles perfectly and breaks the panel at runtime, in a webview whose
 * console nobody is watching. The shim has the same shape and the same guard (patch.test.ts parses
 * every embedded shim); this is that guard for the panel.
 */
const html = buildHtml({
  adSpinner: 'claude',
  adSpinners: [{ id: 'claude', label: 'Claude', frames: ['·', '✢', '✳', '∗'], intervalMs: 120 }],
  adBrandLogo: true,
} as never);

function scriptBody(source: string): string {
  const m = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(source);
  expect(m, 'the panel must carry exactly one nonced script').toBeTruthy();
  return m![1]!;
}

describe('panel webview', () => {
  it('embeds a script that parses as valid JS', () => {
    // A parse error throws here; valid JS constructs a function without running it.
    expect(() => new Function(scriptBody(html))).not.toThrow();
  });

  /**
   * The logo preview is an <img src="data:...">, and the panel's CSP is `default-src 'none'`. Without
   * an explicit img-src, that <img> is BLOCKED and the preview silently renders nothing.
   *
   * This is not a hypothetical. It is exactly the bug that kept advertiser logos invisible in Claude
   * Code's webview for months: the slot existed, the bytes existed, and a CSP nobody had tested threw
   * them away. Once is enough.
   */
  it('allows data: images, or the logo preview renders nothing at all', () => {
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(csp, 'the panel must declare a CSP').not.toBe('');
    expect(csp).toContain('img-src data:');
  });

  // ...and only data:. A panel that can fetch a remote image is a panel that can leak that it was
  // opened, and to whom. The extension never talks to an advertiser (PRIVACY.md).
  it('permits no remote image host', () => {
    expect(html).not.toMatch(/img-src[^;"]*https?:/);
  });

  it('offers the brand-logo switch, and never a way to hide the sponsored line itself', () => {
    const body = scriptBody(html);
    expect(body).toContain("send('toggle-ad-logo')");
    // The developer controls the frame, never the message. If a switch for the LINE ever appears,
    // this test should fail and someone should have to argue for it out loud.
    expect(body).not.toMatch(/toggle-ad-(line|text|url)/);
  });

  // The preview claims to show what the editor will show. If it invented its own spinner cadence it
  // would drift from the real surfaces, and a preview that lies is worse than no preview.
  it('animates the example from the same wall-clock loop as every real surface', () => {
    const body = scriptBody(html);
    expect(body).toContain('spinCells.push({ frames: chosen.frames');
    expect(body).toMatch(/Math\.floor\(Date\.now\(\) \/ c\.intervalMs\) % c\.frames\.length/);
  });
});
