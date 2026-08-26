import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatElements, GLOW_KEYFRAMES, AD_FORMATS } from '@awaitful/shared';
import { buildHtml, type PanelState } from '../ui/panel.js';

vi.mock('vscode', () => ({ window: {}, commands: {}, workspace: {}, Uri: {}, ViewColumn: { One: 1 } }));

/**
 * panel.test.ts proves the client script PARSES. This one RUNS it.
 *
 * Everything below `const JS =` is a template literal, so TypeScript checks none of it: a state
 * field renamed in PanelState and missed in the script compiles perfectly and renders an empty box
 * in a webview whose console nobody watches. Parsing catches a typo; only rendering catches a
 * field that no longer exists - which is exactly the mistake this file was added after.
 *
 * The shim below is deliberately the smallest DOM the script actually touches. It is not a browser
 * and is not trying to be: if a future control needs more of one, add the method, not a dependency.
 */
class ClassList {
  private set = new Set<string>();
  add(...c: string[]) { c.forEach((x) => x && this.set.add(x)); }
  remove(...c: string[]) { c.forEach((x) => this.set.delete(x)); }
  toggle(c: string, on?: boolean) {
    const next = on === undefined ? !this.set.has(c) : on;
    if (next) this.set.add(c); else this.set.delete(c);
    return next;
  }
  contains(c: string) { return this.set.has(c); }
  get list() { return [...this.set]; }
}

class El {
  children: (El | TextNode)[] = [];
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new ClassList();
  parentElement: El | null = null;
  onclick: ((e?: unknown) => void) | undefined;
  onkeydown: ((e: unknown) => void) | undefined;
  onmouseenter: (() => void) | undefined;
  onmouseleave: (() => void) | undefined;
  tabIndex = -1;
  title = '';
  disabled = false;
  src = '';
  private ownText = '';
  private html = '';
  constructor(public tag: string) {}
  set className(v: string) { this.classList = new ClassList(); this.classList.add(...String(v).split(/\s+/)); }
  set textContent(v: string) { this.ownText = String(v); this.children = []; }
  get textContent(): string {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    // Several blocks set their copy as innerHTML (it carries <strong>), and a page-wide text search
    // that could not see it would happily pass on a panel rendering nothing.
    return this.ownText || this.html.replace(/<[^>]*>/g, '');
  }
  set innerHTML(v: string) { this.html = v; if (v === '') this.children = []; }
  get innerHTML() { return this.html; }
  append(...n: (El | TextNode | null | undefined)[]) {
    for (const x of n) { if (!x) continue; if (x instanceof El) x.parentElement = this; this.children.push(x); }
  }
  appendChild(n: El | TextNode) { this.append(n); return n; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener() {}
  focus() {}
  querySelectorAll(sel: string): El[] {
    const cls = sel.replace('.', '');
    const out: El[] = [];
    const walk = (n: El) => { for (const c of n.children) { if (c instanceof El) { if (c.classList.contains(cls)) out.push(c); walk(c); } } };
    walk(this);
    return out;
  }
  /** Every node in this subtree, for whole-page assertions. */
  all(): (El | TextNode)[] {
    const out: (El | TextNode)[] = [this];
    for (const c of this.children) out.push(...(c instanceof El ? c.all() : [c]));
    return out;
  }
}
class TextNode {
  constructor(private t: string) {}
  get textContent() { return this.t; }
}

const STATE: PanelState = {
  version: '0.0.0-test', appName: 'Cursor', signedIn: true, email: 'dev@example.com', name: 'Dev',
  earningsToday: '0.0100', unredeemedUsd: '1.20', disabled: false,
  everThoughtSeen: true, anyAgentCli: true, anyAgentEditor: true,
  agentCleanupFailed: false, pauseRestoreFailed: false,
  showEarningsInStatusBar: true, remoteControlAllowed: false,
  activeAdLine: undefined, activeAdUnpaid: false, activeAdUrl: undefined,
  // A machine where two formats hold DIFFERENT values for the same element - the capability the
  // per-format model exists for, and the one a shared global would silently flatten.
  customize: Object.fromEntries(AD_FORMATS.map((f) => [f.id, formatElements(
    { 'chat-banner.spinner': 'dots', 'thinking-line.spinner': 'pulse', 'chat-banner.glow': 'ember', 'chat-banner.logo': false },
    f.id,
  )])),
  glowKeyframes: GLOW_KEYFRAMES,
  vsSurfaces: [
    { id: 'status-bar', active: true, available: true, consentGranted: true, modifiesFiles: false, earnRate: 1 },
    { id: 'chat-banner', active: false, available: true, consentGranted: false, modifiesFiles: true, earnRate: 3, supported: true },
    { id: 'thinking-line', active: false, available: true, consentGranted: false, modifiesFiles: true, earnRate: 2, supported: true },
  ],
  terminalEnabled: true, terminalConsentGranted: true, terminalEarnRate: 1.5,
  // Dismissed by default so the base fixture is the steady-state panel; the stepper tests opt back in.
  onboardingDismissed: true, bestUpgrade: 'chat-banner', justUpdated: false, remoteSurfacePref: null,
};

const SCRIPT = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(buildHtml(STATE))![1]!;

/** Controls that sit inside a clickable card stop the click from also opening the page. */
const FAKE_EVENT = { stopPropagation: () => {}, preventDefault: () => {} };

let root: El;
let posted: Record<string, unknown>[];

/** Run the panel script for real and hand back a way to navigate it. */
function mount(state: PanelState = STATE) {
  root = new El('div');
  posted = [];
  const registry: Record<string, unknown> = { root, 'initial-state': { textContent: JSON.stringify(state) } };
  (globalThis as Record<string, unknown>)['document'] = {
    createElement: (t: string) => new El(t),
    createTextNode: (t: string) => new TextNode(t),
    getElementById: (id: string) => registry[id] ?? null,
    // updateHighlight() aims the illustration through this. Nothing calls it during a mount today
    // (only the hover listeners do, and addEventListener here is a no-op), but leaving it off would
    // turn any future mount-time call into a confusing "not a function" rather than a real failure.
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    head: new El('head'),
  };
  (globalThis as Record<string, unknown>)['requestAnimationFrame'] = () => 0;
  (globalThis as Record<string, unknown>)['window'] = { addEventListener: () => {} };
  (globalThis as Record<string, unknown>)['acquireVsCodeApi'] = () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
  });
  // The script ends by rendering; the returned handle lets a test open a format's page.
  return new Function(`${SCRIPT}\nreturn { openDetail };`)() as { openDetail: (id: string) => void };
}

/** Text anywhere on the page - the cheapest way to catch a field that stopped existing. */
const pageText = () => root.all().map((n) => n.textContent).join(' ');

beforeEach(() => { mount(); });

describe('the panel renders', () => {
  it('builds the format list with no undefined leaking into any label', () => {
    expect(root.querySelectorAll('card').length).toBeGreaterThan(0);
    // A removed state field renders as the literal string "undefined" rather than throwing.
    expect(pageText()).not.toMatch(/undefined|NaN|\[object Object\]/);
  });

  it('gives all four formats the same gesture: one click, their own page', () => {
    const cards = root.querySelectorAll('card');
    expect(cards).toHaveLength(4); // status bar, chat banner, thinking line, terminal
    for (const c of cards) {
      expect(c.getAttribute('role'), c.getAttribute('aria-label')).toBe('button');
      expect(typeof c.onclick, c.getAttribute('aria-label')).toBe('function');
      // Every card leads to its page, and none of them is missing its state glyph.
      expect(c.querySelectorAll('card-go'), `${c.getAttribute('aria-label')} does not lead anywhere`).toHaveLength(1);
      const state = c.querySelectorAll('pick').length + c.querySelectorAll('toggle').length;
      expect(state, `${c.getAttribute('aria-label')} shows no state`).toBe(1);
    }
  });

  /**
   * The kind of glyph is the claim about how the format relates to the others: a ring means "one of
   * these three", a switch means "this runs alongside whichever you picked". The terminal wearing a
   * ring would say it competes for a slot only one thing can hold, in every terminal you open.
   */
  it('rings the three that are pick-one and switches the one that stacks', () => {
    const byName = (n: string) => root.querySelectorAll('card')
      .find((c) => (c.getAttribute('aria-label') ?? '').startsWith(n))!;
    for (const n of ['Status bar', 'Thinking line', 'Chat banner']) {
      expect(byName(n).querySelectorAll('pick'), n).toHaveLength(1);
      expect(byName(n).querySelectorAll('toggle'), n).toHaveLength(0);
    }
    const term = byName('Terminal');
    expect(term.querySelectorAll('pick')).toHaveLength(0);
    const sw = term.querySelectorAll('toggle')[0]!;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true'); // terminalEnabled in the fixture
  });

  it('turns the terminal off from its switch without opening anything', () => {
    root.querySelectorAll('card')
      .find((c) => (c.getAttribute('aria-label') ?? '').startsWith('Terminal'))!
      .querySelectorAll('toggle')[0]!.onclick!(FAKE_EVENT);
    expect(posted).toEqual([{ type: 'toggle-terminal' }]);
  });

  it('marks the active format on the card that is actually on', () => {
    const active = root.querySelectorAll('card').filter((c) => c.getAttribute('aria-current') === 'true');
    // The status bar is the chosen VS Code format here, and the terminal earns alongside it.
    expect(active.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Status bar, active, base earning rate',
      'Terminal status line, active, about 1.5 times the base rate',
    ]);
  });
});

/**
 * The onboarding stepper. Its whole point is that every step's state is DERIVED - so these mount real
 * states and assert the stepper reads them, and that each button reuses an existing message rather than
 * a new activation path. The ✕ appears only after sign-in; dismissing is device-local.
 */
describe('the onboarding stepper', () => {
  const stepperOf = () => root.querySelectorAll('stepper')[0];

  it('is the sign-in surface when signed out: step one, no dismiss', () => {
    mount({ ...STATE, signedIn: false, terminalEnabled: false, remoteControlAllowed: false, onboardingDismissed: false });
    const box = stepperOf();
    expect(box, 'no stepper when signed out').toBeTruthy();
    expect(root.querySelectorAll('stepper-x'), 'no ✕ before sign-in').toHaveLength(0);
    const btn = box!.querySelectorAll('btn-primary')[0]!;
    expect(btn.textContent).toBe('Sign in');
    posted = [];
    btn.onclick!();
    expect(posted).toEqual([{ type: 'sign-in' }]);
  });

  it('offers the best format as the current step, through the existing consent message', () => {
    mount({
      ...STATE, onboardingDismissed: false, terminalEnabled: false, remoteControlAllowed: false,
      bestUpgrade: 'chat-banner',
      vsSurfaces: STATE.vsSurfaces.map((s) => ({ ...s, active: s.id === 'status-bar' })),
    });
    const box = stepperOf()!;
    expect(box.querySelectorAll('stepper-x'), '✕ appears once signed in').toHaveLength(1);
    const btn = box.querySelectorAll('btn-primary')[0]!;
    expect(btn.textContent).toBe('Turn on chat banner');
    posted = [];
    btn.onclick!();
    expect(posted).toEqual([{ type: 'consent-grant', id: 'chat-banner' }]);
  });

  it('turns on sync as the last step, once a format is already on', () => {
    mount({ ...STATE, onboardingDismissed: false, terminalEnabled: true, remoteControlAllowed: false });
    const btn = stepperOf()!.querySelectorAll('btn-primary')[0]!;
    expect(btn.textContent).toBe('Turn on sync');
    posted = [];
    btn.onclick!();
    expect(posted).toEqual([{ type: 'toggle-remote-control' }]);
  });

  it('dismisses with the ✕', () => {
    mount({ ...STATE, onboardingDismissed: false, remoteControlAllowed: false });
    posted = [];
    stepperOf()!.querySelectorAll('stepper-x')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'dismiss-onboarding' }]);
  });

  it('is gone once dismissed, and once every step is done', () => {
    mount({ ...STATE, onboardingDismissed: true });
    expect(root.querySelectorAll('stepper')).toHaveLength(0);
    mount({ ...STATE, onboardingDismissed: false, terminalEnabled: true, remoteControlAllowed: true });
    expect(root.querySelectorAll('stepper'), 'nothing left to do').toHaveLength(0);
  });

  // Regression: a status-bar dashboard choice reverted the device and the stepper kept nagging to turn
  // the chat banner back on - fighting the very choice it should respect.
  it('treats a deliberate web format choice as settled, even status-bar', () => {
    mount({
      ...STATE, onboardingDismissed: false, remoteSurfacePref: 'status-bar',
      remoteControlAllowed: true, terminalEnabled: false,
      vsSurfaces: STATE.vsSurfaces.map((s) => ({ ...s, active: s.id === 'status-bar' })),
    });
    // Signed in + a dashboard format choice + sync on = nothing left to do, so no stepper and no nag.
    expect(root.querySelectorAll('stepper')).toHaveLength(0);
  });

  it('with a web format choice but sync off, only sync remains - never a format nag', () => {
    mount({
      ...STATE, onboardingDismissed: false, remoteSurfacePref: 'status-bar',
      remoteControlAllowed: false, terminalEnabled: false,
      vsSurfaces: STATE.vsSurfaces.map((s) => ({ ...s, active: s.id === 'status-bar' })),
    });
    const btn = stepperOf()!.querySelectorAll('btn-primary')[0]!;
    expect(btn.textContent).toBe('Turn on sync');
  });

  it('points a contested webview at resolving the conflict, never the terminal', () => {
    // A competitor holds Claude Code's webview during onboarding: bestUpgrade is undefined (status-bar
    // fallback) and step 2 offers to resolve the conflict, not "Turn on terminal".
    mount({
      ...STATE, onboardingDismissed: false, terminalEnabled: false, remoteControlAllowed: false,
      remoteSurfacePref: null, bestUpgrade: undefined,
      vsSurfaces: STATE.vsSurfaces.map((s) =>
        s.id === 'status-bar' ? { ...s, active: true } : { ...s, active: false, available: true, conflict: true }),
    });
    const btn = stepperOf()!.querySelectorAll('btn-primary')[0]!;
    expect(btn.textContent).toBe('Resolve the conflict');
  });

  it('says sync, never the old "control from web"', () => {
    mount();
    expect(pageText()).toContain('Sync across devices');
    expect(pageText()).not.toContain('Control from web');
  });
});

/** The one-time post-update banner: absent in steady state, present after an update, both actions clear it. */
describe("the what's-new banner", () => {
  it('does not show unless the version changed', () => {
    mount();
    expect(root.querySelectorAll('whatsnew')).toHaveLength(0);
  });

  it('appears after an update; "see what s new" opens the notes and marks seen', () => {
    mount({ ...STATE, justUpdated: true });
    const bar = root.querySelectorAll('whatsnew')[0];
    expect(bar, 'no banner after an update').toBeTruthy();
    expect(pageText()).toContain('Updated to v');
    posted = [];
    bar!.querySelectorAll('whatsnew-cta')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'whats-new' }]);
  });

  it('dismisses with the ✕, marking seen without opening anything', () => {
    mount({ ...STATE, justUpdated: true });
    posted = [];
    root.querySelectorAll('whatsnew-x')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'dismiss-whats-new' }]);
  });
});

describe('each format customizes itself', () => {
  // What each page must offer, straight from what the format declares it can draw.
  const expected: Record<string, { spinner: boolean; logo: boolean; glow: boolean }> = {
    'status-bar': { spinner: true, logo: false, glow: false },
    'terminal': { spinner: true, logo: false, glow: false },
    'thinking-line': { spinner: true, logo: true, glow: false },
    'chat-banner': { spinner: true, logo: true, glow: true },
  };

  for (const [id, want] of Object.entries(expected)) {
    it(`${id} offers exactly the elements it draws`, () => {
      const api = mount();
      api.openDetail(id);
      const tiles = root.querySelectorAll('spin-tile').length;
      const switches = root.querySelectorAll('opt-row').length;
      const chips = root.querySelectorAll('theme-chip').length;

      expect(tiles > 0, 'spinner gallery').toBe(want.spinner);
      expect(switches > 0, 'logo switch').toBe(want.logo);
      expect(chips > 0, 'glow + outline chips').toBe(want.glow);
      // Every page previews the ad line; only the chat banner wraps it in the banner's own chrome.
      expect(root.querySelectorAll('ad-eg').length, 'line preview').toBe(1);
      expect(root.querySelectorAll('bp-preview').length > 0, 'banner chrome').toBe(want.glow);
      expect(pageText()).not.toMatch(/undefined|NaN/);
    });
  }

  it('shows each format its OWN value, not another format s', () => {
    // The two formats hold different spinners. If the panel ever renders one value for both, this
    // is where it shows: the selected tile would be at the same index on both pages.
    const selectedOn = (id: string) => {
      const api = mount();
      api.openDetail(id);
      return root.querySelectorAll('spin-tile').findIndex((t) => t.classList.contains('on'));
    };
    const cb = selectedOn('chat-banner');
    const tl = selectedOn('thinking-line');
    expect(cb).toBeGreaterThanOrEqual(0);
    expect(tl).toBeGreaterThanOrEqual(0);
    expect(cb).not.toBe(tl);
  });

  it('writes the format it was clicked on, and only that one', () => {
    const api = mount();
    api.openDetail('thinking-line');
    const tiles = root.querySelectorAll('spin-tile');
    posted = [];
    tiles[1]!.onclick!();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'set-element', format: 'thinking-line', element: 'spinner' });
    expect(typeof (posted[0] as { value: unknown }).value).toBe('string');
  });

  it('sends a boolean for a switch, so the store does not read it as a string', () => {
    const api = mount();
    api.openDetail('chat-banner');
    posted = [];
    root.querySelectorAll('toggle')[0]!.onclick!();
    expect(posted[0]).toMatchObject({ type: 'set-element', element: 'logo', value: true }); // was false
  });
});

describe("a format's page leads with its one decision", () => {
  /**
   * Turning the format on used to sit past the styling controls, the file disclosure and the backup
   * notes - a long scroll for the only decision on the page. It now sits beside the heading, aligned
   * with the illustration above it.
   */
  it.each(['status-bar', 'thinking-line', 'chat-banner', 'terminal'])('%s puts it at the top', id => {
    const api = mount();
    api.openDetail(id);
    const head = root.querySelectorAll('detail-head')[0];
    expect(head, `${id} has no action beside its heading`).toBeTruthy();
    expect(head!.querySelectorAll('btn-primary')).toHaveLength(1);
    // ...and exactly once on the page. Two copies of one action is how a button and the copy that
    // explains it drift apart.
    expect(root.querySelectorAll('btn-primary')).toHaveLength(1);
  });

  it('offers nothing to press on a format that is already on', () => {
    const api = mount({
      ...STATE,
      vsSurfaces: STATE.vsSurfaces.map(s => (s.id === 'chat-banner' ? { ...s, active: true } : s)),
    });
    api.openDetail('chat-banner');
    const b = root.querySelectorAll('btn-primary')[0]!;
    expect(b.textContent).toBe('Showing now');
    expect(b.disabled).toBe(true);
  });

  // A blocked format's guidance box owns the conversation; a second button beside the heading would
  // invite a click that cannot do anything.
  it('offers nothing on a blocked format', () => {
    const api = mount({
      ...STATE,
      anyAgentEditor: false,
      vsSurfaces: STATE.vsSurfaces.map(s => (s.id === 'status-bar' ? s : {
        ...s, blockedReason: 'no-agent-editor' as const, agentFilesPresent: false,
      })),
    });
    api.openDetail('chat-banner');
    expect(root.querySelectorAll('detail-head')).toHaveLength(0);
  });
});

/**
 * The privacy panel is this product's strongest claim, so what it says has to be exactly true.
 * Naming one format as the safe one invites the reader to assume the others are a privacy trade.
 * They are not - the promise is identical across all four, and whether a format edits a file is a
 * different question, answered in full on that format's own page.
 */
describe('the privacy panel', () => {
  it('makes the promise once, for every format', () => {
    expect(pageText()).toContain('the same on every format');
    expect(pageText()).not.toContain('Status bar format modifies nothing');
  });

  // Reassurance with no next move leaves the reader nowhere. The panel exists to be acted on.
  it('ends on what to do about it', () => {
    expect(pageText()).toContain('Pick where your sponsored line appears');
  });

  // The mark carries the claim visually; it used to be a 14px glyph inline with the sentence.
  it('gives the mark its own plate rather than inlining it with the copy', () => {
    expect(root.querySelectorAll('privacy-mark')).toHaveLength(1);
    expect(root.querySelectorAll('privacy-col')).toHaveLength(1);
  });
});

describe('a competitor is holding Claude Code', () => {
  /** Both webview formats conflicted, with the other extension installed and nameable. */
  const contested = (extra: Record<string, unknown> = {}): PanelState => ({
    ...STATE,
    vsSurfaces: STATE.vsSurfaces.map(s => (s.id === 'status-bar' ? s : {
      ...s,
      conflict: true,
      conflictVendor: 'Kickbacks AI',
      conflictVendorId: 'kickbacksai.kickbacks-ai',
      conflictVendorInstalled: 'yes' as const,
      conflictToken: 'VIBE-ADS',
      canTakeOver: false,
      ...extra,
    })),
  });

  /** Open a format's page on a contested machine and hand back its step rows. */
  const stepsFor = (extra: Record<string, unknown> = {}) => {
    const api = mount(contested(extra));
    api.openDetail('chat-banner');
    return root.querySelectorAll('conflict-step');
  };

  /**
   * One shared cause is not one shared card. This used to render on the first conflicted card only,
   * so the chat banner looked perfectly fine while being just as blocked - and nothing told the
   * developer to go read the thinking line's card instead.
   */
  it('tells every affected card, not just the first', () => {
    mount(contested());
    const withHint = root.querySelectorAll('card').filter(c => c.querySelectorAll('card-conflict').length > 0);
    expect(withHint.map(c => c.getAttribute('aria-label'))).toEqual([
      'Thinking line, about 2 times the base rate',
      'Chat banner, about 3 times the base rate',
    ]);
  });

  /**
   * The reason a format cannot run has to come before the controls for styling it. It used to sit
   * below them, so the page opened on "pick a spinner" while the thing that actually needed doing
   * was off screen.
   */
  it.each(['thinking-line', 'chat-banner'])('puts the warning above the styling controls on %s', id => {
    const api = mount(contested());
    api.openDetail(id);
    const page = root.children[0] as El;
    const at = (cls: string) => page.children.findIndex(c => c instanceof El && c.classList.contains(cls));
    const conflict = at('conflict');
    const customize = page.children.findIndex(
      c => c instanceof El && c.querySelectorAll('info-label').some(l => l.textContent === 'Customize'),
    );
    expect(conflict, 'no conflict box rendered').toBeGreaterThan(-1);
    expect(customize, 'no customize block rendered').toBeGreaterThan(-1);
    expect(conflict).toBeLessThan(customize);
  });

  /**
   * "Already modified" reads as though Awaitful did it. And blaming another extension is a claim
   * about evidence: it may only be made when a foreign marker or a named vendor was actually found.
   */
  it('says who changed the file, and never "already"', () => {
    const api = mount(contested());
    api.openDetail('chat-banner');
    expect(pageText()).toContain('Claude Code was modified by another extension');
    expect(pageText()).not.toContain('already modified');
  });

  it('will not blame an extension when nothing identifies one', () => {
    const api = mount(contested({ conflictVendor: undefined, conflictVendorId: undefined, conflictToken: undefined }));
    api.openDetail('chat-banner');
    expect(pageText()).toContain('Claude Code was modified outside Awaitful');
    expect(pageText()).not.toContain('by another extension');
  });

  /**
   * Each step is one click that really does the thing. The remove buttons run VS Code's own
   * uninstall on an explicit click - Awaitful still never removes or disables anything on its own
   * initiative, which is the distinction that actually matters (unilateral versus requested).
   */
  it('walks through the whole fix, one button per step', () => {
    const steps = stepsFor();
    expect(steps).toHaveLength(5);

    posted = [];
    for (const st of steps) st.querySelectorAll('conflict-act')[0]?.onclick?.();
    // Two reloads, each doing different work. The first unloads the removed extensions and lets VS
    // Code sweep their files. The second is what makes Claude Code load the bytes Awaitful writes -
    // it may already have loaded its webview from the unpatched file by then.
    // The reload sits SECOND now, because it is what makes the removal stick: measured on a real
    // machine, the competitor's own uninstall hook put Claude Code's file back and the still-loaded
    // instance re-patched it within seconds. Everything after step two is the fallback for a tool
    // that does NOT clean up after itself.
    expect(posted).toEqual([
      { type: 'uninstall-extension', id: 'kickbacksai.kickbacks-ai', from: 'chat-banner' },
      { type: 'reload-window', view: 'detail', detailId: 'chat-banner' },
      { type: 'uninstall-extension', id: 'anthropic.claude-code', from: 'chat-banner' },
      { type: 'reload-window', view: 'detail', detailId: 'chat-banner' },
      { type: 'install-extension', id: 'anthropic.claude-code' },
    ]);
  });

  /**
   * Switched off is not gone. VS Code lists only ENABLED extensions, so a disabled tool used to look
   * identical to a removed one - and the panel quoted a raw marker token at someone whose extension
   * was sitting right there in their list. Its change is still in the file either way.
   */
  /**
   * A switched-off extension is still on disk with a real display name and a page to open, so the
   * host must send both. It did not: the name was gated on the vendor being ACTIVE, so the moment a
   * developer did the reasonable thing and disabled the tool, the panel said "undefined is switched
   * off" and offered no way to act on it. Guarded here as well as fixed at the source, because a
   * panel that can render "undefined" at a user is a worse bug than a vaguer sentence.
   */
  it('never prints undefined when the name is missing', () => {
    stepsFor({ conflictVendorInstalled: 'disabled', conflictVendor: undefined, conflictVendorId: undefined });
    expect(pageText()).not.toMatch(/undefined/);
    expect(pageText()).toContain('is switched off');
  });

  it('names a switched-off extension instead of quoting its marker', () => {
    const steps = stepsFor({ conflictVendorInstalled: 'disabled' });
    expect(pageText()).toContain('Kickbacks AI is switched off');
    expect(pageText()).toContain('turning a tool off never undoes what it wrote');
    expect(steps[0]!.textContent).toContain('Switching it off is not enough');
    // Still actionable, and still the same one-click removal.
    posted = [];
    steps[0]!.querySelectorAll('conflict-act')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'uninstall-extension', id: 'kickbacksai.kickbacks-ai', from: 'chat-banner' }]);
  });

  /**
   * THE REMOVE BUTTON HAS TO TICK WHEN IT WORKS.
   *
   * An editor drops the registry entry the instant you uninstall and keeps the code alive until the
   * window reloads. The running extension used to overwrite its own registry absence, so the moment
   * the developer clicked Remove the tool read as fully installed again: the step stayed undone, the
   * file kept changing back, and the click looked like it had done nothing at all.
   */
  it('ticks the remove step the moment the uninstall lands, before any reload', () => {
    const steps = stepsFor({ conflictVendorInstalled: 'removing', conflictVendorId: undefined });
    expect(steps.map(st => st.classList.contains('done'))).toEqual([true, false, false, false, false]);
    expect(pageText()).toContain('still running in this window until you reload');
    // The reload is now the live step, and it no longer rides on the removal.
    expect(steps[1]!.querySelectorAll('conflict-act')[0]!.textContent).toBe('Reload window');
  });

  /**
   * The two used to tick together, reasoning that a swept folder proved a restart had happened. The
   * registry is faster than the sweep - it drops the entry immediately - so tying them together
   * would tick a reload the developer still has to do.
   */
  it('does not tick the reload until it has actually stopped running', () => {
    expect(stepsFor({ conflictVendorInstalled: 'removing', conflictVendorId: undefined })[1]!
      .classList.contains('done')).toBe(false);
    expect(stepsFor({ conflictVendorInstalled: 'no', conflictVendorId: undefined })[1]!
      .classList.contains('done')).toBe(true);
  });

  /**
   * The state that made this checklist unwinnable.
   *
   * A patch tool walks $HOME and edits the agent wherever it finds it, so a copy installed only in
   * another editor keeps changing the file this window loads. From here it looked uninstalled, so
   * the steps read "removed", the file changed back, and the developer went round the reinstall loop
   * with the actual fix sitting in a different application. Its own steps, because not one step of
   * the ordinary repair applies.
   */
  const ELSEWHERE = {
    conflictVendorInstalled: 'elsewhere' as const,
    conflictVendorId: undefined,   // nothing here can remove another editor's extension
    conflictVendorHost: {
      label: 'VSCodium',
      dir: '~/.vscode-oss/extensions/kickbacksai.kickbacks-ai-2.3.1',
    },
  };

  it('sends you to the editor that actually holds it', () => {
    const steps = stepsFor(ELSEWHERE);
    expect(pageText()).toContain('Kickbacks AI is not installed in this window');
    // The name a developer calls it, never the dot directory it lives in.
    expect(pageText()).toContain('VSCodium');
    expect(pageText()).not.toContain('.vscode-oss/extensions.');
    // The extension's OWN folder, since deleting it is the one route that does not depend on that
    // editor's uninstall doing what it says.
    expect(pageText()).toContain('~/.vscode-oss/extensions/kickbacksai.kickbacks-ai-2.3.1');
    expect(steps).toHaveLength(3);
    expect(steps[0]!.textContent).toContain('uninstall');
    expect(steps[1]!.textContent).toContain('Quit');
    expect(steps[2]!.textContent).toContain('reload');
  });

  /**
   * The restart is the step an editor never mentions, and leaving it out made the guidance look
   * wrong: an editor drops the registry entry the instant you uninstall and sweeps the folder only
   * at its next start, so between those moments the tool is still loaded and still writing. The
   * developer does exactly what step one asks, watches the file change back, and concludes the
   * instructions were wrong.
   */
  it('says the uninstall over there does not count until that editor restarts', () => {
    const steps = stepsFor(ELSEWHERE);
    expect(steps[1]!.textContent).toContain('does not take effect until it restarts');
  });

  it('drops the spent step once it has been uninstalled over there, and asks for the restart', () => {
    const steps = stepsFor({
      ...ELSEWHERE,
      conflictVendorHost: { ...ELSEWHERE.conflictVendorHost, pendingRemoval: true },
    });
    expect(pageText()).toContain('is uninstalled in VSCodium');
    expect(pageText()).toContain('has not restarted since');
    expect(steps).toHaveLength(2);
    expect(steps[0]!.textContent).toContain('Quit VSCodium');
  });

  /**
   * Reinstalling Claude Code is exactly the loop this state exists to name: the other editor patches
   * the fresh copy within the minute. Offering it anywhere on this page, including under "do it
   * yourself", is sending someone round again.
   */
  it('never offers the Claude Code reinstall that cannot work here', () => {
    stepsFor(ELSEWHERE);
    expect(pageText()).not.toContain('Remove Claude Code');
    expect(pageText()).not.toContain('Install Claude Code');
  });

  // Every button here acts on THIS window, and there is no extension here to act on. A remove button
  // built from an id we cannot reach would fail on the click.
  it('offers no remove button for an extension this window does not have', () => {
    const steps = stepsFor(ELSEWHERE);
    posted = [];
    steps[0]!.querySelectorAll('conflict-act')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'show-conflict-host' }]);
    // The middle step is the one thing no button can do for you.
    expect(steps[1]!.querySelectorAll('conflict-act')).toHaveLength(0);
  });

  /**
   * Progress is DERIVED, never remembered: the step ticks because the extension is genuinely gone,
   * so it is equally right when the developer removed it in VS Code's own view, or had already
   * removed it before ever opening this panel.
   */
  it('ticks the remove step off once the extension is really gone', () => {
    const steps = stepsFor({ conflictVendorInstalled: 'no', conflictVendorId: undefined });
    expect(steps).toHaveLength(5);
    // Both the removal AND the reload beside it: the competitor's folder is only swept at startup,
    // so it being gone is itself the evidence that a reload happened.
    expect(steps.map(st => st.classList.contains('done'))).toEqual([true, true, false, false, false]);
    // A completed step offers no button - there is nothing left to press.
    expect(steps[0]!.querySelectorAll('conflict-act')).toHaveLength(0);
    expect(steps.slice(2).every(st => st.querySelectorAll('conflict-act').length === 1)).toBe(true);
    // The file is still contested, and the copy has to say why that is not a contradiction.
    expect(pageText()).toContain('removing a tool never undoes what it wrote');
  });

  /**
   * Nothing identifies a culprit, so the step cannot name one - but it still renders. Dropping it
   * would shift every step below up by one, which is the renumbering the fixed-number rule exists to
   * prevent, and it stays followable through the installed list.
   */
  it('keeps the list the same length when it cannot name the extension', () => {
    const steps = stepsFor({ conflictVendor: undefined, conflictVendorId: undefined, conflictToken: undefined });
    expect(steps).toHaveLength(5);
    expect(steps[0]!.querySelectorAll('conflict-act')[0]!.textContent).toBe('Show extensions');
    expect(steps[1]!.textContent).toContain('Reload the window');
    expect(steps[2]!.textContent).toContain('Remove Claude Code');
  });

  /**
   * The alternative path, for anyone who would rather not let an ad extension press buttons for
   * them. It has to be a real route - the same destinations as the steps above, none of the actions
   * - rather than a link that drops them in a list with no further help.
   */
  it('unfolds a do-it-yourself path that only ever opens pages', () => {
    stepsFor();
    const toggle = () => root.querySelectorAll('more-link')
      .find(b => b.textContent.startsWith('Or do it yourself') || b.textContent.startsWith('Hide'))!;
    expect(root.querySelectorAll('manual-box')).toHaveLength(0);

    toggle()!.onclick!();
    const box = root.querySelectorAll('manual-box')[0]!;
    expect(box, 'the disclosure did not unfold').toBeTruthy();

    posted = [];
    for (const b of box.querySelectorAll('conflict-act')) b.onclick!();
    expect(posted).toEqual([
      { type: 'open-extension', id: 'kickbacksai.kickbacks-ai' },
      { type: 'open-extension', id: 'anthropic.claude-code' },
      { type: 'open-extensions', query: '@installed' },
      { type: 'reload-window', view: 'detail', detailId: 'chat-banner' },
    ]);
    // Not one of these removes or installs anything: that is the whole difference between the two
    // paths, and the reason this one exists.
    expect(posted.some(m => String(m['type']).match(/uninstall|install/))).toBe(false);

    toggle()!.onclick!();
    expect(root.querySelectorAll('manual-box')).toHaveLength(0);
  });

  // A row whose button does nothing is the one row a developer stops trusting. Without an id there
  // is nothing to remove FOR them, but the installed list is still where they would go looking.
  it('keeps step one actionable even when it cannot name the extension', () => {
    const steps = stepsFor({ conflictVendorId: undefined });
    const btn = steps[0]!.querySelectorAll('conflict-act')[0];
    expect(btn, 'step one has no button').toBeTruthy();
    expect(btn!.textContent).toBe('Show extensions');
    posted = [];
    btn!.onclick!();
    expect(posted).toEqual([{ type: 'open-extensions', query: '@installed' }]);
  });
});

/** A machine where a competitor holds Claude Code, with that competitor still installed. */
const contestedFixture = (extra: Record<string, unknown> = {}): PanelState => ({
  ...STATE,
  vsSurfaces: STATE.vsSurfaces.map(s => (s.id === 'status-bar' ? s : {
    ...s,
    conflict: true,
    conflictVendor: 'Kickbacks AI',
    conflictVendorId: 'kickbacksai.kickbacks-ai',
    conflictVendorInstalled: 'yes' as const,
    conflictToken: 'VIBE-ADS',
    canTakeOver: false,
    agentFilesPresent: true,
    ...extra,
  })),
});

/**
 * Removing Claude Code is step two of the conflict fix, and the moment it lands the state stops
 * being "contested" - so the conflict box correctly disappears, and used to take steps three and
 * four with it. The developer was left mid-sequence on a page that had stopped explaining anything,
 * having done exactly what they were told.
 */
describe('mid-fix, with Claude Code removed', () => {
  const noEditor = (extra: Record<string, unknown> = {}): PanelState => ({
    ...STATE,
    anyAgentEditor: false,
    vsSurfaces: STATE.vsSurfaces.map(s => (s.id === 'status-bar' ? s : {
      ...s, conflict: false, supported: false, blockedReason: 'no-agent-editor' as const,
      agentInstalled: false, agentFilesPresent: false, ...extra,
    })),
  });

  /**
   * THE regression this whole model exists for. Removing Claude Code is step two, and it is also
   * what stops the file being contested - so the checklist used to hand over to a different box with
   * different numbering at exactly the moment the developer did what it asked. Software losing its
   * place mid-instruction reads as software that was not thought through.
   *
   * One list, fixed numbers, ticks filling in. `repairing` is the only remembered bit in the flow,
   * because a machine with no Claude Code looks identical whether someone is half way through a
   * repair or never installed it.
   */
  it('keeps ONE checklist across the step that removes Claude Code', () => {
    // Before: four live steps, none done.
    const api = mount(contestedFixture());
    api.openDetail('chat-banner');
    const before = root.querySelectorAll('conflict-step');
    expect(before).toHaveLength(5);
    expect(before.filter(st => st.classList.contains('done'))).toHaveLength(0);
    const numbers = (rows: El[]) => rows.map(r => r.querySelectorAll('num')[0]!.textContent);

    // After removing Claude Code: the SAME four steps, same numbering, first two ticked.
    // The exact instant after the click: removed on DISK, but the window still has them loaded -
    // the other tool is still drawing its status bar item. That gap is what the reload step closes,
    // and it is why the reload is a step rather than a footnote.
    const api2 = mount({
      ...STATE,
      anyAgentEditor: true,
      vsSurfaces: STATE.vsSurfaces.map(s => (s.id === 'status-bar' ? s : {
        ...s, conflict: false, repairing: true, agentInstalled: false, agentFilesPresent: false,
        blockedReason: 'no-agent-editor' as const,
        conflictVendor: 'Kickbacks AI', conflictVendorId: 'kickbacksai.kickbacks-ai',
        conflictVendorInstalled: 'no' as const, conflictToken: 'VIBE-ADS', canTakeOver: false,
      })),
    });
    api2.openDetail('chat-banner');
    const after = root.querySelectorAll('conflict-step');
    expect(after, 'the checklist vanished mid-repair').toHaveLength(5);
    // Removed on disk, but the window still has them loaded - so the reload step is the live one.
    expect(after.map(st => st.classList.contains('done'))).toEqual([true, true, true, false, false]);
    // Step three is still step three: renumbering under someone is the same disorientation, quieter.
    // Step three is still step three. A done step shows a tick in place of its digit, so the
    // invariant is that the steps still to do kept their positions - renumbering under someone
    // working down a list is the same disorientation as the list disappearing, just quieter.
    expect(numbers(before)).toEqual(['1', '2', '3', '4', '5']);
    // Steps still to do keep their positions; a done one shows a tick in place of its digit.
    expect(numbers(after).slice(3)).toEqual(['4', '5']);
    // ONE heading for the whole repair. It used to change as the state moved underneath, so a
    // developer who did exactly what step two asked watched the box become a different box.
    expect(pageText()).toContain('Claude Code was modified by another extension');

    // A done step drops its button - there is nothing left to press - so only the three still to do
    // are actionable, and they are the three that finish the job.
    // A done step drops its button - there is nothing left to press - so only the two still to do
    // are actionable, and they are the two that finish the job.
    posted = [];
    for (const st of after) st.querySelectorAll('conflict-act')[0]?.onclick?.();
    expect(posted).toEqual([
      { type: 'reload-window', view: 'detail', detailId: 'chat-banner' },
      { type: 'install-extension', id: 'anthropic.claude-code' },
    ]);
  });

  /**
   * Every guidance box must carry its own action. The take-over branch said "click below to do
   * that" and then returned with no button, because the button lived in the page FOOTER behind a
   * not-blocked guard - so the moment Claude Code was removed and the format became blocked, the
   * instruction pointed at nothing. Copy and control have to live together or they drift apart.
   */
  /**
   * A one-click restore that a still-running competitor undoes within seconds is not a shortcut - it
   * is a promise that cannot hold. The engine reclaims a bounded number of times and then yields, so
   * offering the restore on its own was offering something we knew would be taken back. Removal is
   * step one now, and the restore is step two behind it.
   */
  it('makes removing the competitor step one of the one-click path', () => {
    const api = mount(contestedFixture({ canTakeOver: true }));
    api.openDetail('thinking-line');
    const steps = root.querySelectorAll('conflict-step');

    // Two steps, not five: with a verified original of our own, nothing needs reinstalling.
    expect(steps).toHaveLength(2);
    expect(steps[0]!.textContent).toContain('Remove Kickbacks AI');
    expect(steps[1]!.textContent).toContain('would only be undone');

    posted = [];
    for (const st of steps) st.querySelectorAll('conflict-act')[0]!.onclick!();
    expect(posted).toEqual([
      { type: 'uninstall-extension', id: 'kickbacksai.kickbacks-ai', from: 'thinking-line' },
      { type: 'consent-grant', id: 'thinking-line', takeover: true },
    ]);
  });

  it('stops warning about order once the competitor is gone', () => {
    const api = mount(contestedFixture({ canTakeOver: true, conflictVendorInstalled: 'no' }));
    api.openDetail('thinking-line');
    const steps = root.querySelectorAll('conflict-step');
    expect(steps[0]!.classList.contains('done')).toBe(true);
    expect(steps[1]!.textContent).not.toContain('would only be undone');
    expect(steps[1]!.textContent).toContain('turn on');
  });

  /**
   * A take-over rewrites Claude Code's file, so it may only be offered while there IS one. Mid
   * repair the file is gone - offering to restore it would be an offer we cannot keep, and it left
   * the developer on a dead-end box instead of the two steps that actually finish the job.
   */
  it('drops the take-over offer once the file it would rewrite is gone', () => {
    const api = mount(noEditor({
      conflict: false, repairing: true, canTakeOver: true, blockedReason: 'no-agent-editor' as const,
    }));
    api.openDetail('thinking-line');
    expect(root.querySelectorAll('conflict-cta')).toHaveLength(0);
    expect(root.querySelectorAll('conflict-step')).toHaveLength(5);
  });

  /**
   * The state the panel is ACTUALLY in the instant Claude Code is removed: its files are gone, so
   * the engine reports `no-target`. That used to map to 'unsupported-build' - a sentence about
   * versions, and the one reason the guidance box ignores - so the page went blank with two steps
   * left to give. Pinned here at the render layer as well as at the map, because this is where the
   * developer felt it.
   */
  it('never leaves the page blank when Claude Code files are gone', () => {
    for (const reason of ['no-agent-editor', 'no-agent-cli'] as const) {
      const api = mount(noEditor({ blockedReason: reason }));
      api.openDetail('chat-banner');
      expect(root.querySelectorAll('conflict-step').length, `${reason} offers no steps`).toBeGreaterThan(0);
      expect(pageText()).not.toContain('Not supported on this Claude Code version yet');
    }
  });

  /**
   * A machine that never had Claude Code is not a machine half way through a repair, and must never
   * be told it is. The latch had no expiry - it cleared only when Claude Code came BACK - so an
   * abandoned repair, or a machine where that can never happen, kept the flag forever and a fresh
   * install was greeted with "Claude Code is removed, finish the steps to put a clean copy back".
   */
  it('never claims a removal it did not observe', () => {
    // Files absent, but no repair under way: the copy may describe the state, never an action.
    const api = mount(noEditor({ conflict: true, repairing: false }));
    api.openDetail('thinking-line');
    expect(pageText()).not.toContain('Claude Code is removed');
    expect(pageText()).toContain('Claude Code is not installed here');

    // ...and with a repair genuinely in flight, it says so.
    const api2 = mount(noEditor({ conflict: true, repairing: true }));
    api2.openDetail('thinking-line');
    expect(pageText()).toContain('Claude Code is removed');
  });

  /**
   * Installing Claude Code makes it present immediately, so completing the repair on that event tore
   * the guidance away before the reload could be read - let alone clicked. That step is
   * load-bearing: Claude Code may already have loaded its webview from the unpatched file, so the
   * bytes Awaitful writes only reach the screen after a reload. The reload IS the completion.
   *
   * But the CONFLICT box is the wrong thing to keep for it. Held open by the latch on a clean file,
   * it drew a checklist for a conflict that no longer existed: "remove the other extension" with
   * nothing left to remove, and an offer to restore a file that was already clean - with the
   * activate button hidden behind the lot. The reload survives; the conflict steps do not.
   */
  it('survives the install as a finish note, not as a dead conflict checklist', () => {
    const api = mount({
      ...STATE,
      anyAgentEditor: true,
      vsSurfaces: STATE.vsSurfaces.map(s => (s.id === 'status-bar' ? s : {
        ...s, conflict: false, repairing: true, agentFilesPresent: true,
        conflictVendorInstalled: 'no' as const, conflictToken: 'VIBE-ADS', canTakeOver: true,
      })),
    });
    api.openDetail('chat-banner');
    expect(root.querySelectorAll('conflict-step'), 'conflict steps on a clean file').toHaveLength(0);
    expect(pageText()).not.toContain('Remove the other extension');
    expect(pageText()).not.toContain('Restore original');
    // What does survive: the reload, and the button the whole repair was for.
    expect(pageText()).toContain('Reload the window to finish');
    posted = [];
    root.querySelectorAll('conflict-act')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'reload-window', view: 'detail', detailId: 'chat-banner' }]);
    expect(root.querySelectorAll('btn-primary').map(b => b.textContent)).toContain('Turn on');
  });

  /**
   * Removing the COMPETITOR is not removing Claude Code. The repair latch was set by any uninstall,
   * so taking the competitor off - with Claude Code still perfectly present - read as "removed and
   * reinstalled" and ticked all four steps at once, having done one.
   */
  it('does not tick the Claude Code steps when only the competitor went', () => {
    const api = mount(contestedFixture({
      conflictVendorInstalled: 'no',   // the competitor is gone
      agentFilesPresent: true,         // Claude Code never left
      repairing: false,                // ...so no Claude Code removal was latched
    }));
    api.openDetail('chat-banner');
    expect(root.querySelectorAll('conflict-step').map(st => st.classList.contains('done')))
      .toEqual([true, true, false, false, false]);
  });

  /**
   * A tool that re-applies its change on a timer re-patches a fresh Claude Code within a minute of it
   * appearing - so finishing the reinstall while it is installed lands the developer straight back at
   * the top of the list. That is the loop, and the checklist has to name it rather than show a tidy
   * row of ticks above a file that is contested again.
   */
  it('says so when the competitor came back and the reinstall is about to be undone', () => {
    const api = mount(contestedFixture({
      conflictVendorInstalled: 'yes',  // it is installed and running again
      agentFilesPresent: true,         // and Claude Code was just put back
      repairing: true,
    }));
    api.openDetail('chat-banner');
    expect(pageText()).toContain('is installed and running again');
    expect(pageText()).toContain('however many times you reinstall it');
  });

  /**
   * The end of the list is not the end of the problem, and the page used to pretend otherwise.
   *
   * Five ticks, no buttons left, and a warning box saying the format is blocked - with the activate
   * button (correctly) withheld because the file is still contested. So the checklist read as
   * finished while nothing was fixed, which looks like software that has lost track of its own
   * state. A spent list has to say it failed and hand over the next real action.
   */
  const STALLED = {
    conflictVendorInstalled: 'no' as const,  // the competitor is gone from this window
    conflictVendorId: undefined,
    agentFilesPresent: true,                 // Claude Code is back
    repairing: true,                         // ...and it was this repair that took it off
  };

  it('admits it when every step is done and the file changed back anyway', () => {
    const api = mount(contestedFixture(STALLED));
    api.openDetail('chat-banner');
    const steps = root.querySelectorAll('conflict-step');
    expect(steps.map(st => st.classList.contains('done'))).toEqual([true, true, true, true, true]);
    expect(pageText()).toContain('These steps did not hold');
    // The most likely cause, measured on a real machine: the old bytes were never deleted, because
    // an editor only removes an uninstalled extension's folder when the whole app restarts. Naming
    // it beats leaving someone staring at a completed list.
    expect(pageText()).toContain('when the whole app restarts');
    expect(pageText()).toContain('Quit Cursor');
  });

  // A sixth numbered step would say the same sequence is still running, right after showing it did
  // not work. The way out is separate from the list that failed.
  it('hands over a real action rather than a sixth step', () => {
    const api = mount(contestedFixture(STALLED));
    api.openDetail('chat-banner');
    expect(root.querySelectorAll('conflict-step')).toHaveLength(5);
    const acts = root.querySelectorAll('stalled-acts')[0]!.querySelectorAll('conflict-act');
    expect(acts.map(b => b.textContent)).toEqual(['Reload window', 'Show all extensions']);
    posted = [];
    acts[0]!.onclick!();
    expect(posted).toEqual([{ type: 'reload-window', view: 'detail', detailId: 'chat-banner' }]);
  });

  /**
   * A step may tick for the ACTION it asked for and must claim nothing about bytes it has not
   * checked. "Claude Code is installed again, on a clean file" was read in the only place it could
   * never be true: this box renders only while the file IS contested, so the last step congratulated
   * the developer on a clean file directly above the warning that the file was not clean.
   */
  it('never calls the file clean inside a box that exists because it is not', () => {
    const api = mount(contestedFixture(STALLED));
    api.openDetail('chat-banner');
    expect(pageText()).toContain('Claude Code is installed again');
    expect(pageText()).not.toContain('on a clean file');
  });

  /**
   * A reload is a real step in this flow, and the window used to come back with the panel closed -
   * so the developer had to find their way back to the format they were half way through setting
   * up, with nothing on screen to say the step had landed. Every reload button reports the page it
   * was clicked from; the host validates it and reopens there.
   */
  it('tells the host which page to come back to', () => {
    // 'removing' leaves the reload as the live step, which is exactly where this button matters.
    const api = mount(contestedFixture({ conflictVendorInstalled: 'removing', conflictVendorId: undefined }));
    api.openDetail('chat-banner');
    posted = [];
    root.querySelectorAll('conflict-step')[1]!.querySelectorAll('conflict-act')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'reload-window', view: 'detail', detailId: 'chat-banner' }]);
  });

  /**
   * The connector between the numbers is drawn per row, from one dot's bottom edge to the bottom of
   * that row's padding box - so it only joins up if every row lives in ONE column. The steps used to
   * be split across two sibling containers with the explanatory note between them, which started a
   * second rail: the line died after step two and began again at step three, and the sequence read
   * as two unrelated lists. The note is a row in the same column now.
   */
  it('keeps every step and the note in one column, so the rail can join up', () => {
    const api = mount(contestedFixture({ conflictVendorInstalled: 'no', conflictVendorId: undefined }));
    api.openDetail('chat-banner');
    const columns = root.querySelectorAll('conflict-actions');
    expect(columns, 'the steps are split across columns again').toHaveLength(1);
    const note = root.querySelectorAll('step-note')[0]!;
    expect(note.parentElement!.classList.contains('conflict-actions')).toBe(true);
    // And it sits BETWEEN the two groups, not before or after them.
    const kids = columns[0]!.children;
    expect(kids.indexOf(note)).toBe(2);
    expect(kids).toHaveLength(6);   // 5 steps + the note
  });

  /**
   * THE DEFECT THAT MADE THE WHOLE SEQUENCE A NO-OP.
   *
   * An editor drops the registry entry the instant you uninstall and deletes the folder only when
   * the whole app restarts. So "Remove Claude Code" leaves the patched file exactly where it is -
   * and the ladder read those surviving bytes as proof Claude Code had been put BACK, jumping
   * straight to the last phase. All three remaining steps ticked on the click, nothing had happened,
   * the file was untouched, and the box then reported that the steps had not held. They had not been
   * taken. Measured on a real machine: only quitting and reopening the app ever cleared it.
   */
  it('does not read a folder awaiting deletion as Claude Code being back', () => {
    const api = mount(contestedFixture({
      conflictVendorInstalled: 'no', conflictVendorId: undefined,
      agentInstalled: false,       // uninstalled: the registry entry is gone
      agentFilesPresent: true,     // ...but the patched bytes are still on disk
      repairing: true,
    }));
    api.openDetail('chat-banner');
    const steps = root.querySelectorAll('conflict-step');
    // Removed, and NOT yet reloaded or reinstalled. The last two must not tick off a stale folder.
    expect(steps.map(st => st.classList.contains('done'))).toEqual([true, true, true, false, false]);
    expect(pageText()).toContain('its files are still on disk until Cursor restarts');
  });

  /**
   * A window reload restarts the extension host but deletes nothing. Telling someone to reload here
   * left the patched bytes in place, and the next step reinstalled Claude Code on top of them - so
   * the sequence completed with the file byte-for-byte as it started.
   */
  it('asks for a real restart, not a reload, when the bytes are what must go', () => {
    const api = mount(contestedFixture({
      conflictVendorInstalled: 'no', conflictVendorId: undefined,
      agentInstalled: false, agentFilesPresent: true, repairing: true,
    }));
    api.openDetail('chat-banner');
    const steps = root.querySelectorAll('conflict-step');
    expect(steps[3]!.textContent).toContain('Quit Cursor completely and open it again');
    expect(steps[3]!.textContent).toContain('a window reload leaves it on disk');
    // No button: we cannot quit the editor for them, and a button that did nothing would be worse.
    expect(steps[3]!.querySelectorAll('conflict-act')).toHaveLength(0);
    // And the reinstall must wait for that restart rather than landing on the old folder.
    expect(steps[4]!.textContent).toContain('after the restart above');
  });

  /**
   * THE REPAIR ENDS WHEN THE WORLD SAYS SO, NEVER WHEN A LATCH EXPIRES.
   *
   * The latch means "Claude Code was taken off as part of a fix", and that stays true after the fix
   * has WORKED. So a finished repair kept the box up - drawing "remove the other extension" with
   * nothing left to remove, on a file that was already clean - and kept the activate button hidden
   * behind it. The developer had done everything asked, everywhere, and had no way to turn the
   * format on. Worse, the latch outlived its own clearing whenever that clearing was skipped, so the
   * page stayed wrong for hours.
   */
  it('gets out of the way once the file is clean and Claude Code is back', () => {
    const api = mount(contestedFixture({ ...STALLED, conflict: false }));
    api.openDetail('chat-banner');
    expect(root.querySelectorAll('conflict-step'), 'a finished repair still shows steps').toHaveLength(0);
    expect(pageText()).not.toContain('Remove the other extension');
    expect(pageText()).not.toContain('did not hold');
    // And the thing the whole repair was for comes back.
    const primary = root.querySelectorAll('btn-primary');
    expect(primary.map(b => b.textContent)).toContain('Turn on');
  });

  // Mid-repair is the one thing the disk cannot tell us: a machine with no Claude Code looks the
  // same whether someone is half way through a fix or never had it. There the latch still rules.
  it('keeps the box while Claude Code is still missing', () => {
    const api = mount(contestedFixture({
      ...STALLED, conflict: false, agentFilesPresent: false,
    }));
    api.openDetail('chat-banner');
    expect(root.querySelectorAll('conflict-step').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('btn-primary')).toHaveLength(0);
  });

  /**
   * Monotonic progress is right for the Claude Code steps: reinstalling genuinely makes the files
   * present again, and un-ticking "remove it" would be progress running backwards. It is WRONG for
   * the competitor - nothing later in this list puts it back, so if it is present again the work
   * really was undone. Reinstalling Claude Code was ticking step one on a machine where the
   * competitor had returned, which is a checklist telling the developer a lie.
   */
  it('un-ticks the competitor step when the competitor comes back', () => {
    const api = mount(contestedFixture({
      conflictVendorInstalled: 'yes', agentFilesPresent: true, repairing: true,
    }));
    api.openDetail('chat-banner');
    const done = root.querySelectorAll('conflict-step').map(st => st.classList.contains('done'));
    // Claude Code's own steps stay done; the competitor's does not.
    expect(done[0], 'step one claims a removal that was undone').toBe(false);
    expect(done.slice(2, 5)).toEqual([true, true, true]);
  });

  /**
   * Progress never runs backwards. Each step used to read its own fact, so reinstalling Claude Code
   * made the files present again and un-ticked "Remove Claude Code" and the reload after it - the
   * two steps the developer had just completed. A checklist that loses ticks is worse than one that
   * renumbers, so a later phase now implies every earlier one.
   */
  it('never un-ticks a step the developer already finished', () => {
    const at = (extra: Record<string, unknown>) => {
      const api = mount({
        ...STATE,
        anyAgentEditor: (extra['anyAgentEditor'] as boolean | undefined) ?? true,
        vsSurfaces: STATE.vsSurfaces.map(s => (s.id === 'status-bar' ? s : {
          ...s, conflict: false, repairing: true, conflictToken: 'VIBE-ADS', canTakeOver: false, ...extra,
        })),
      });
      api.openDetail('chat-banner');
      return root.querySelectorAll('conflict-step').map(st => st.classList.contains('done'));
    };

    // Uninstalled, folder already swept, window still stale -> three done.
    expect(at({ agentInstalled: false, agentFilesPresent: false, anyAgentEditor: true, conflictVendorInstalled: 'no' }))
      .toEqual([true, true, true, false, false]);
    // Restarted -> four done.
    expect(at({ agentInstalled: false, agentFilesPresent: false, anyAgentEditor: false, conflictVendorInstalled: 'no' }))
      .toEqual([true, true, true, true, false]);
    // Reinstalled on a clean file -> the repair is over, so the checklist gives way to the finish
    // note rather than standing there fully ticked with nothing left to do.
    expect(at({ agentInstalled: true, agentFilesPresent: true, anyAgentEditor: true, conflictVendorInstalled: 'no' }))
      .toEqual([]);
    expect(pageText()).toContain('Reload the window to finish');
  });

  it('carries on with the remaining steps instead of going silent', () => {
    const api = mount(noEditor());
    api.openDetail('chat-banner');
    expect(pageText()).toContain('Claude Code is not installed in this window');
    // The bridge back to the sequence the developer was following.
    expect(pageText()).toContain('this is the rest of that fix');

    // ONE step. Installing needs no reload - VS Code registers a new extension immediately and this
    // box clears itself; a reload is only ever needed to unload something that was removed.
    const steps = root.querySelectorAll('conflict-step');
    expect(steps).toHaveLength(1);
    posted = [];
    for (const st of steps) st.querySelectorAll('conflict-act')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'install-extension', id: 'anthropic.claude-code' }]);
  });

  // Same slot as the conflict box it replaces: the reason a page cannot do anything comes before
  // the controls for styling it.
  it('puts the guidance above the styling controls', () => {
    const api = mount(noEditor());
    api.openDetail('chat-banner');
    const page = root.children[0] as El;
    const guidance = page.children.findIndex(c => c instanceof El && c.classList.contains('conflict'));
    const customize = page.children.findIndex(
      c => c instanceof El && c.querySelectorAll('info-label').some(l => l.textContent === 'Customize'),
    );
    expect(guidance).toBeGreaterThan(-1);
    expect(guidance).toBeLessThan(customize);
  });

  it('points a machine with no Claude Code at all to setup, not to install-from-marketplace', () => {
    const api = mount({
      ...STATE,
      anyAgentCli: false,
      vsSurfaces: STATE.vsSurfaces.map(s => ({ ...s, conflict: false, blockedReason: 'no-agent-cli' as const })),
    });
    api.openDetail('chat-banner');
    expect(pageText()).toContain('Claude Code is not on this machine');
    posted = [];
    root.querySelectorAll('conflict-step')[0]!.querySelectorAll('conflict-act')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'open-setup-docs' }]);
  });
});

describe('a machine with no agent', () => {
  /**
   * A stopped card LEADS somewhere and offers nothing in place. It used to be inert, on the
   * reasoning that opening the page was not the next step for a format that cannot run - but that
   * page now carries the whole fix, so it is exactly the next step. What must stay impossible is
   * turning the format ON from here, and the page withholds its own button for that.
   */
  it('opens its page from anywhere on the card, and still turns nothing on', () => {
    const api = mount({ ...STATE, anyAgentCli: false, anyAgentEditor: false, terminalBlockedReason: 'no-agent-cli',
      vsSurfaces: STATE.vsSurfaces.map((s) => ({ ...s, active: false, blockedReason: 'no-agent-cli' as const })) });
    for (const c of root.querySelectorAll('card')) {
      expect(typeof c.onclick, 'a stopped card leads nowhere').toBe('function');
      expect(c.getAttribute('aria-disabled'), 'it does something, so it is not disabled').toBeUndefined();
    }
    // The whole card is the target: the warning carries no second control to aim at.
    expect(root.querySelectorAll('card-conflict')[0]!.querySelectorAll('more-link')).toHaveLength(0);
    expect(pageText()).toContain('No agent found');

    api.openDetail('chat-banner');
    expect(root.querySelectorAll('detail-head'), 'a blocked page must offer no way to turn it on').toHaveLength(0);
  });

  /**
   * The status bar's card says "Fix it →" like the other three, and its page was the only one with
   * nothing behind that promise: a description, no reason, no way out. It cannot be contested or
   * unsupported - the single thing that stops it is a machine with no Claude Code on it - so it owes
   * the page exactly the guidance the other three already carry, from the same box.
   */
  it('gives the status bar page the reason it is stopped, and the fix', () => {
    const api = mount({
      ...STATE,
      anyAgentCli: false, anyAgentEditor: false, terminalBlockedReason: 'no-agent-cli',
      vsSurfaces: STATE.vsSurfaces.map(s => ({ ...s, active: false, blockedReason: 'no-agent-cli' as const })),
    });
    api.openDetail('status-bar');
    expect(pageText()).toContain('Claude Code is not on this machine');
    // Still nothing to turn on here - the box owns the page, and the format cannot run yet.
    expect(root.querySelectorAll('detail-head')).toHaveLength(0);

    // The reason without the steps is the same dead end in fewer words.
    const steps = root.querySelectorAll('conflict-step');
    expect(steps.length, 'the reason arrives with no fix under it').toBeGreaterThan(0);
    posted = [];
    steps[0]!.querySelectorAll('conflict-act')[0]!.onclick!();
    expect(posted).toEqual([{ type: 'open-setup-docs' }]);
  });

  /**
   * One voice for every stopped format. A missing Claude Code used to render as grey caption text
   * while a competitor's conflict got an amber callout - the same problem looking like two different
   * classes of thing depending on which reason stopped it.
   */
  /**
   * Cursor, Windsurf and VS Codium all run this. The section header was hardcoded to "Visual Studio
   * Code", telling most of the editors it actually runs in that their formats live somewhere else.
   */
  it('calls the editor by its own name', () => {
    mount();
    expect(pageText()).toContain('Cursor');
    expect(pageText()).not.toContain('Visual Studio Code');
  });

  it('warns the same way whatever stopped it', () => {
    const seen = new Set<string>();
    for (const reason of ['no-agent-cli', 'no-agent-editor', 'changed-unknown', 'foreign-conflict'] as const) {
      mount({ ...STATE, vsSurfaces: STATE.vsSurfaces.map(s => ({ ...s, active: false, blockedReason: reason })) });
      const w = root.querySelectorAll('card-conflict');
      expect(w.length, `${reason} does not use the shared warning`).toBeGreaterThan(0);
      expect(w[0]!.textContent, `${reason} offers no way in`).toContain('Fix it');
      seen.add(reason);
    }
    expect(seen.size).toBe(4);
  });
});
