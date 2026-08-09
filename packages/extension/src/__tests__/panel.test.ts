import { describe, it, expect, vi } from 'vitest';
import { formatElements, GLOW_KEYFRAMES, AD_FORMATS } from '@awaitful/shared';
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
  customize: { 'status-bar': formatElements(null, 'status-bar'), 'chat-banner': formatElements(null, 'chat-banner') },
  glowKeyframes: GLOW_KEYFRAMES,
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

  it('writes every customization through one message, and never one that hides the line', () => {
    const body = scriptBody(html);
    // Four element-specific messages (spinner, logo, banner style, banner frame) collapsed into one
    // validated write. A second write path is a second place to forget the validation.
    expect(body).toContain("send('set-element'");
    expect(body).not.toMatch(/send\('(set-ad-spinner|toggle-ad-logo|set-banner-(style|frame))'/);
    // The developer controls the frame, never the message. If a control for the LINE ever appears,
    // this test should fail and someone should have to argue for it out loud.
    expect(body).not.toMatch(/toggle-ad-(line|text|url)/);
  });

  /**
   * The status bar activated on click while the other formats opened a page, so one gesture meant
   * two things - and the status bar had nowhere to put its own settings. Every card now opens its
   * format's page, which is the only place a format is turned on, turned off, or styled.
   */
  it('opens a page from every card rather than activating one of them in place', () => {
    const body = scriptBody(html);
    expect(body).toContain('cardOpens(card');
    // No card commits a format directly any more; that button lives on the page it opens.
    expect(body).not.toContain('handleEnable');
  });

  // The account-wide Customize ad page is gone: its settings belong to the format that draws them.
  it('has no account-wide customize page left to route to', () => {
    const body = scriptBody(html);
    expect(body).not.toMatch(/_view\s*===\s*'ad'/);
    expect(body).not.toContain('buildAdView');
  });

  /**
   * The panel must not carry its own idea of what a spinner or a glow is. Everything drawable comes
   * from the shared catalogue via state.customize, so adding an element there is the whole change.
   */
  it('renders controls from the shared catalogue, not from a list of its own', () => {
    const body = scriptBody(html);
    expect(body).toContain('state.customize');
    for (const control of ['switch', 'gallery', 'swatch']) {
      expect(body, `no branch renders the ${control} control`).toContain(control);
    }
  });

  /**
   * "Coming soon" claimed the FEATURE was unbuilt. In the only place it ever fired, the truth was
   * that Claude Code was not installed on this machine - so it sent developers away to wait for
   * something that had already shipped, instead of telling them what to install.
   */
  it('never badges a surface "Coming soon" - a blocked surface names its real reason', () => {
    expect(html).not.toContain('Coming soon');
  });

  /**
   * One spelling per format. The catalogue and the web dashboard say "Thinking line"; the panel
   * hyphenated it, so a developer reading both saw the same format named two ways. Tied by a test
   * rather than by code, because the panel's META also carries an icon and a description the shared
   * catalogue has no business knowing about.
   */
  it('names every format exactly as the shared catalogue does', () => {
    const body = scriptBody(html);
    for (const f of AD_FORMATS) {
      if (f.id === 'terminal') continue; // its card is built separately, with its own longer label
      expect(body, `${f.id} is not labelled ${f.label}`).toContain(`label:'${f.label}'`);
    }
  });

  it('carries copy for every blocked reason the orchestrator can send', () => {
    const body = scriptBody(html);
    for (const reason of [
      'no-agent-cli', 'no-agent-editor', 'foreign-conflict',
      'changed-unknown', 'ours-unverified', 'unreadable',
    ]) {
      expect(body, `no branch renders ${reason}`).toContain(reason);
    }
  });

  /**
   * "Not supported on this Claude Code version yet" was shown to a user whose Claude Code version
   * was fine - a competitor was holding the file. It sent them to wait for a release that was never
   * the problem. That sentence may only appear on the one state it is true for.
   */
  it('never blames the Claude Code version in a conflict branch', () => {
    const body = scriptBody(html);
    const versionClaims = body.match(/[^;]*this Claude Code version[^;]*/g) ?? [];
    for (const claim of versionClaims) {
      const conflicty = /foreign-conflict|changed-unknown|conflictVendor|conflictToken/.test(claim);
      expect(conflicty, `a conflict branch blames the version: ${claim.slice(0, 120)}`).toBe(false);
    }
  });

  /**
   * The worst failure this panel can have is telling a developer they are earning while nothing is
   * on screen. Every "showing"-style claim must be gated on a proven paint, and the not-yet-proven
   * states must have their own copy.
   */
  it('carries copy for every liveness state, so a dead surface can say so', () => {
    const body = scriptBody(html);
    for (const stage of ['reload-needed', 'not-rendering', 'silent']) {
      expect(body, `no branch renders liveness ${stage}`).toContain(stage);
    }
  });

  it('gates the liveness note on a proven paint, never on the patch being present', () => {
    const body = scriptBody(html);
    expect(body).toMatch(/sv\.live\s*&&\s*sv\.live\s*!==\s*'live'/);
  });

  // Whether a format is ON is the user's choice; liveness is a separate fact about what is on
  // screen. Rendering the badge instead of the dot would make a chosen format look unchosen.
  it('keeps the pick indicator when a chosen format is not confirmed', () => {
    const body = scriptBody(html);
    const at = body.indexOf('pickGlyph(active), goChevron()');
    expect(at, 'the action slot no longer shows a pick indicator').toBeGreaterThan(-1);
    expect(body.slice(at - 700, at)).toContain('badge-blocked');
  });

  /**
   * The three VS Code formats are pick-one; the terminal runs ALONGSIDE whichever you picked, in
   * every terminal you open. Dressing it in the same ring would say it is a fourth contender for a
   * slot only one thing can hold, so it wears a switch and they wear a ring.
   */
  it('gives the additive terminal a switch, never the pick-one ring', () => {
    const body = scriptBody(html);
    const term = body.slice(body.indexOf('function buildTerminalCard'));
    expect(term).toContain("role', 'switch'");
    expect(term.slice(0, term.indexOf('function buildDetailView'))).not.toContain('pickGlyph');
  });

  // We may only name a tool we can see installed. Telling someone to turn off an extension they
  // removed months ago sends them hunting for something that is not there.
  it('names a conflicting vendor only behind an installed check', () => {
    const body = scriptBody(html);
    expect(body).toContain('sv.conflictVendor');
    expect(body).toContain('sv.conflictToken');
  });

  /**
   * Every reload goes through one helper, so a reload button added later cannot forget to say where
   * it was clicked from - and the window comes back to the page the developer was on rather than to
   * a closed panel.
   */
  it('routes every reload through the helper that remembers the page', () => {
    const body = scriptBody(html);
    expect(body).toContain('function reloadHere()');
    const bare = body.match(/send\('reload-window'\)/g) ?? [];
    expect(bare, 'a reload button bypasses reloadHere and loses the page').toHaveLength(0);
  });

  it('offers a way out of the no-agent dead end', () => {
    expect(scriptBody(html)).toContain("send('open-setup-docs')");
  });

  /**
   * The block explaining a $0 machine must NOT sit behind the everThought latch. That latch flips on
   * the first thinking hook, so on a machine with no agent it never flips at all and the message
   * never appears - which is how the silent $0 stayed silent. A refactor could quietly put it back.
   */
  it('gates the no-agent block on presence, not on the thinking latch', () => {
    const body = scriptBody(html);
    expect(body).toMatch(/!state\.anyAgentCli\s*&&\s*!state\.disabled/);
  });

  // The preview claims to show what the editor will show. If it invented its own spinner cadence it
  // would drift from the real surfaces, and a preview that lies is worse than no preview.
  it('animates the example from the same wall-clock loop as every real surface', () => {
    const body = scriptBody(html);
    expect(body).toContain('spinCells.push(cell)');
    expect(body).toMatch(/Math\.floor\(Date\.now\(\) \/ c\.intervalMs\) % c\.frames\.length/);
    // "None" has no frames and a zero interval: ticking it divides by zero and writes undefined
    // into the glyph, which renders as the literal text "undefined" next to the ad line.
    expect(body).toMatch(/if \(!c\.frames\.length \|\| !c\.intervalMs\) continue/);
  });
});
