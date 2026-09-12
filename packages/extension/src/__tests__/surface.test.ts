import { describe, it, expect, afterEach } from 'vitest';
import type { AdEvent } from '@awaitful/shared';
import { SurfaceSession } from '../core/surfaceSession.js';
import { HookServer, type SurfaceCreative } from '../hooks/server.js';

const CREATIVE: SurfaceCreative = { adId: 'ad-1', slateId: 'slate-1', line: 'Try Acme', url: 'https://acme.test' };
const beacon = (over: Partial<{ adId: string; slateId: string; visibleMs: number }> = {}) =>
  ({ adId: 'ad-1', slateId: 'slate-1', ...over });

// ── SurfaceSession: verified billing ─────────────────────────────────────────

describe('SurfaceSession', () => {
  function make(thresholdMs = 5000) {
    const events: Array<{ type: AdEvent['type']; visibleMs?: number | undefined }> = [];
    const s = new SurfaceSession((type, visibleMs) => events.push({ type, visibleMs }), thresholdMs);
    return { s, events };
  }

  /**
   * Two open Claude Code webviews - two windows, or VS Code and Cursor side by side - both fetch
   * the same creative and both post `visible {visibleMs:1000}` at 1 Hz. Without shim binding they
   * accumulate into ONE counter, so view_threshold_met fires after half the visible time it claims
   * to represent: billing for time nobody watched. Invisible in any single-window test.
   */
  it('does not double-accrue visible time when a SECOND shim beacons the same creative', () => {
    const { s, events } = make(5000);
    s.begin(CREATIVE);
    s.rendered({ adId: CREATIVE.adId, slateId: CREATIVE.slateId, shimId: 'window-a' });
    for (let i = 0; i < 3; i++) {
      s.visible({ adId: CREATIVE.adId, slateId: CREATIVE.slateId, visibleMs: 1000, shimId: 'window-a' });
      s.visible({ adId: CREATIVE.adId, slateId: CREATIVE.slateId, visibleMs: 1000, shimId: 'window-b' });
    }
    // Three seconds of real viewing, six beacons. The threshold is five seconds: it must not fire.
    expect(events.filter((e) => e.type === 'view_threshold_met')).toHaveLength(0);
    const ticks = events.filter((e) => e.type === 'view_tick');
    expect(ticks[ticks.length - 1]?.visibleMs).toBe(3000);
  });

  it('ignores beacons from a shim other than the one that painted', () => {
    const { s, events } = make();
    s.begin(CREATIVE);
    s.rendered({ adId: CREATIVE.adId, slateId: CREATIVE.slateId, shimId: 'window-a' });
    s.rendered({ adId: CREATIVE.adId, slateId: CREATIVE.slateId, shimId: 'window-b' });
    expect(events.filter((e) => e.type === 'impression_rendered')).toHaveLength(1);
    expect(s.click({ adId: CREATIVE.adId, slateId: CREATIVE.slateId, shimId: 'window-b' })).toBeUndefined();
  });

  it('bills NOTHING when no beacon ever arrives (golden rule 3)', () => {
    const { s, events } = make();
    s.begin(CREATIVE);
    // ...agent thinks, but the shim never confirms a paint...
    s.end();
    expect(events).toHaveLength(0);
  });

  it('emits impression_rendered exactly once, only on a matching beacon', () => {
    const { s, events } = make();
    s.begin(CREATIVE);
    s.rendered(beacon());
    s.rendered(beacon()); // duplicate
    expect(events.filter(e => e.type === 'impression_rendered')).toHaveLength(1);
  });

  it('ignores beacons that do not match the active creative', () => {
    const { s, events } = make();
    s.begin(CREATIVE);
    s.rendered(beacon({ adId: 'someone-else' }));
    s.visible(beacon({ slateId: 'stale' }));
    expect(events).toHaveLength(0);
  });

  it('accrues visible time and fires view_threshold_met once at the threshold', () => {
    const { s, events } = make(5000);
    s.begin(CREATIVE);
    for (let i = 0; i < 6; i++) s.visible(beacon({ visibleMs: 1000 }));
    const ticks = events.filter(e => e.type === 'view_tick');
    const thresholds = events.filter(e => e.type === 'view_threshold_met');
    expect(ticks.length).toBe(6);
    expect(thresholds.length).toBe(1);
    expect(thresholds[0]!.visibleMs).toBeGreaterThanOrEqual(5000);
  });

  it('clamps a misbehaving beacon so visible time cannot be inflated', () => {
    const { s, events } = make(5000);
    s.begin(CREATIVE);
    s.visible(beacon({ visibleMs: 999999 })); // one giant beacon
    // clamped to <= 2000, so the threshold is NOT reached on a single beacon
    expect(events.filter(e => e.type === 'view_threshold_met')).toHaveLength(0);
  });

  it('returns the sponsor URL and bills a click only on a matching beacon', () => {
    const { s, events } = make();
    s.begin(CREATIVE);
    expect(s.click(beacon({ adId: 'nope' }))).toBeUndefined();
    expect(s.click(beacon())).toBe('https://acme.test');
    expect(events.filter(e => e.type === 'click')).toHaveLength(1);
  });

  it('does not bill for a stale creative after end()', () => {
    const { s, events } = make();
    s.begin(CREATIVE);
    s.end();
    s.rendered(beacon());
    s.visible(beacon({ visibleMs: 5000 }));
    expect(events).toHaveLength(0);
  });

  it('exposes placement + bannerStyle on the served creative (so the shim renders the right mode)', () => {
    const { s } = make();
    const banner: SurfaceCreative = { adId: 'ad-2', slateId: 'slate-2', line: 'Try Beta', placement: 'chat-banner', bannerStyle: 'aurora' };
    s.begin(banner);
    expect(s.current).toEqual(banner);
    expect(s.current?.placement).toBe('chat-banner');
    expect(s.current?.bannerStyle).toBe('aurora');
  });

  it('restyle() swaps glow/frame live without touching billing (same ad, no re-fire)', () => {
    const { s, events } = make();
    s.begin({ adId: 'ad-1', slateId: 'slate-1', line: 'x', placement: 'chat-banner', bannerStyle: 'aurora', bannerFrame: 'banner' });
    s.rendered(beacon());
    s.restyle({ bannerStyle: 'comet' });
    s.restyle({ bannerFrame: 'full' });
    expect(s.current?.bannerStyle).toBe('comet');
    expect(s.current?.bannerFrame).toBe('full');
    expect(s.current?.adId).toBe('ad-1');      // same ad — not a rotation
    s.rendered(beacon());                        // must NOT re-fire (rendered already counted)
    expect(events.filter((e) => e.type === 'impression_rendered')).toHaveLength(1);
  });

  /**
   * The developer owns the FRAME an ad is drawn in (spinner, logo); they never get to suppress the
   * MESSAGE. So switching brand logos off must strip the logo from the ad already on screen WITHOUT
   * ending the impression - the ad is still there, still read, still billable. If this reset billing
   * state, flipping the switch mid-ad would either lose the advertiser a paid impression or hand the
   * developer a second one.
   */
  it('restyle() strips the logo live, and the impression keeps counting', () => {
    const { s, events } = make();
    s.begin({ adId: 'ad-1', slateId: 'slate-1', line: 'x', iconUrl: 'data:image/webp;base64,AAA' });
    s.rendered(beacon());

    s.restyle({ iconUrl: undefined });           // developer turned logos off
    expect(s.current?.iconUrl).toBeUndefined();
    expect(s.current?.adId).toBe('ad-1');        // same ad — the message is untouched
    expect(s.current?.line).toBe('x');

    s.restyle({ iconUrl: 'data:image/webp;base64,AAA' });  // and back on
    expect(s.current?.iconUrl).toBe('data:image/webp;base64,AAA');

    s.rendered(beacon());
    expect(events.filter((e) => e.type === 'impression_rendered')).toHaveLength(1);
  });

  // A logo is OPTIONAL for the advertiser, so most ads simply have none. Turning the setting on must
  // never invent one: "show logos" means "show it when there is one", not "put something there".
  it('has no logo for an ad that never carried one, however the setting is set', () => {
    const { s } = make();
    s.begin({ adId: 'ad-2', slateId: 'slate-1', line: 'no logo here' });
    expect(s.current?.iconUrl).toBeUndefined();
    s.restyle({ iconUrl: undefined });           // "logos on" restores the ad's own logo: nothing
    expect(s.current?.iconUrl).toBeUndefined();
    expect('iconUrl' in (s.current ?? {})).toBe(true); // present-but-undefined; JSON drops the key
  });
});

// ── HookServer: HTTP routing + CORS + beacon dispatch ────────────────────────

describe('HookServer', () => {
  let server: HookServer | undefined;
  afterEach(() => { server?.dispose(); server = undefined; });

  function start(overrides: { creative?: SurfaceCreative; terminalLine?: string | null } = {}) {
    const rec = { start: 0, stop: 0, pause: 0, resume: 0, rendered: 0, visible: 0, click: 0, terminalTick: 0, hello: 0, attest: 0 };
    const cbs = makeCallbacks(rec, overrides);
    server = new HookServer(cbs);
    return server.start().then((port) => ({ port, rec }));
  }

  it('serves /surface/hello for port discovery with CORS', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/surface/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const hello = await res.json() as { awaitful: boolean; hostId: string; serving: boolean };
    expect(hello.awaitful).toBe(true);
    expect(hello.hostId).toMatch(/[0-9a-f-]{36}/); // identity, so beacons are attributable
  });

  it('returns the current creative, or 204 when none', async () => {
    const { port } = await start({ creative: CREATIVE });
    const res = await fetch(`http://127.0.0.1:${port}/surface/creative`);
    expect(res.status).toBe(200);
    expect((await res.json()).line).toBe('Try Acme');
  });

  it('dispatches rendered/visible/click beacons to the callbacks', async () => {
    const { port, rec } = await start();
    // A real shim learns the host's identity from /surface/hello and echoes it on every beacon.
    const hello = await (await fetch(`http://127.0.0.1:${port}/surface/hello?shim=s1&v=26`)).json() as { hostId: string };
    const post = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adId: 'ad-1', slateId: 'slate-1', hostId: hello.hostId, shimId: 's1' }),
    });
    await post('/surface/rendered');
    await post('/surface/visible');
    await post('/surface/click');
    expect(rec).toMatchObject({ rendered: 1, visible: 1, click: 1 });
  });

  /**
   * Every window's shim scans the same loopback range, so a shim can reach a host that did not
   * issue its creative. Billing another window's impression is a golden-rule-3 violation, and it is
   * invisible in any single-window test.
   */
  it('drops a beacon addressed to a DIFFERENT host', async () => {
    const { port, rec } = await start();
    await fetch(`http://127.0.0.1:${port}/surface/rendered`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adId: 'ad-1', slateId: 'slate-1', hostId: 'some-other-window', shimId: 's9' }),
    });
    expect(rec.rendered).toBe(0);
  });

  it('records a shim hello and a no-anchor attestation', async () => {
    const { port, rec } = await start();
    const hello = await (await fetch(`http://127.0.0.1:${port}/surface/hello?shim=s1&v=26`)).json() as { hostId: string };
    expect(rec.hello).toBe(1);
    await fetch(`http://127.0.0.1:${port}/surface/attest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'no-anchor', adId: 'ad-1', hostId: hello.hostId, shimId: 's1', v: 26 }),
    });
    // Attestation has no slateId, so it must dispatch ABOVE the billing beacons' adId/slateId gate.
    expect(rec.attest).toBe(1);
  });

  it('dispatches thinking start/stop/pause/resume hooks to the callbacks', async () => {
    const { port, rec } = await start();
    const post = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST' });
    await post('/thinking/start');
    await post('/thinking/pause');
    await post('/thinking/resume');
    await post('/thinking/stop');
    expect(rec).toMatchObject({ start: 1, pause: 1, resume: 1, stop: 1 });
  });

  it('serves /surface/terminal with the line and records a verified tick', async () => {
    const { port, rec } = await start({ terminalLine: 'SPONSORED' });
    const res = await fetch(`http://127.0.0.1:${port}/surface/terminal`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('SPONSORED');
    expect(rec.terminalTick).toBe(1); // the GET is the render tick
  });

  it('returns 204 for /surface/terminal when idle, without a billing tick', async () => {
    const { port, rec } = await start({ terminalLine: null });
    const res = await fetch(`http://127.0.0.1:${port}/surface/terminal`);
    expect(res.status).toBe(204);
    expect(rec.terminalTick).toBe(0); // nothing shown → nothing billed
  });

  it('answers CORS preflight (OPTIONS) with 204', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/surface/rendered`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('binds a port in the fixed discovery range', async () => {
    const { port } = await start();
    expect(port).toBeGreaterThanOrEqual(51789);
    expect(port).toBeLessThan(51789 + 12);
  });
});

function makeCallbacks(
  rec: { start: number; stop: number; pause: number; resume: number; rendered: number; visible: number; click: number; terminalTick?: number; hello?: number; attest?: number; agents?: (string | undefined)[] },
  overrides: { creative?: SurfaceCreative; terminalLine?: string | null } = {},
) {
  return {
    onStart: (agent?: string) => { rec.start++; rec.agents?.push(agent); },
    onStop: () => { rec.stop++; },
    onPause: () => { rec.pause++; },
    onResume: () => { rec.resume++; },
    getCreative: () => overrides.creative ?? null,
    onRendered: () => { rec.rendered++; },
    onVisible: () => { rec.visible++; },
    onClick: () => { rec.click++; },
    getTerminalLine: () => overrides.terminalLine ?? null,
    onTerminalTick: () => { rec.terminalTick = (rec.terminalTick ?? 0) + 1; },
    onShimHello: () => { rec.hello = (rec.hello ?? 0) + 1; },
    onAttest: () => { rec.attest = (rec.attest ?? 0) + 1; },
  };
}

/**
 * The thinking callback names the agent that fired it.
 *
 * The host cannot tell one agent from another - every agent's hook is an identical shell command
 * arriving on the same port - so without this, a machine running two agents would attribute every
 * impression to whichever one happened to be registered.
 *
 * The compatibility case matters as much as the feature: hooks already written into developers'
 * settings.json carry no agent, and are rewritten only when the extension reinstalls them. Absent
 * has to keep meaning "we do not know" rather than being filled in with the one agent we support.
 */
describe('HookServer agent attribution', () => {
  let server: HookServer | undefined;
  afterEach(() => { server?.dispose(); server = undefined; });

  async function startWithAgents() {
    const rec = {
      start: 0, stop: 0, pause: 0, resume: 0, rendered: 0, visible: 0, click: 0,
      terminalTick: 0, hello: 0, attest: 0, agents: [] as (string | undefined)[],
    };
    server = new HookServer(makeCallbacks(rec));
    const port = await server.start();
    return { port, rec };
  }

  it('passes through the agent a hook names', async () => {
    const { port, rec } = await startWithAgents();
    const res = await fetch(`http://127.0.0.1:${port}/thinking/start?agent=claude-code`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(rec.agents).toEqual(['claude-code']);
  });

  it('reports no agent for a hook installed before the callback named one', async () => {
    const { port, rec } = await startWithAgents();
    const res = await fetch(`http://127.0.0.1:${port}/thinking/start`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(rec.start).toBe(1);
    expect(rec.agents).toEqual([undefined]);
  });

  it('ignores an agent it does not recognise rather than forwarding it', async () => {
    // Not this build's agent. Passing the raw string on would put an unvalidated value on the wire,
    // where the server's closed enum rejects the whole batch it travels in.
    const { port, rec } = await startWithAgents();
    await fetch(`http://127.0.0.1:${port}/thinking/start?agent=some-future-agent`, { method: 'POST' });
    expect(rec.start).toBe(1);
    expect(rec.agents).toEqual([undefined]);
  });

  it('still routes stop, pause and resume with a query attached', async () => {
    const { port, rec } = await startWithAgents();
    for (const signal of ['stop', 'pause', 'resume']) {
      const res = await fetch(`http://127.0.0.1:${port}/thinking/${signal}?agent=claude-code`, { method: 'POST' });
      expect(res.status).toBe(200);
    }
    expect([rec.stop, rec.pause, rec.resume]).toEqual([1, 1, 1]);
  });
});
