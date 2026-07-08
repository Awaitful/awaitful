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
});

// ── HookServer: HTTP routing + CORS + beacon dispatch ────────────────────────

describe('HookServer', () => {
  let server: HookServer | undefined;
  afterEach(() => { server?.dispose(); server = undefined; });

  function start(overrides: { creative?: SurfaceCreative; terminalLine?: string | null } = {}) {
    const rec = { start: 0, stop: 0, pause: 0, resume: 0, rendered: 0, visible: 0, click: 0, terminalTick: 0 };
    const cbs = makeCallbacks(rec, overrides);
    server = new HookServer(cbs);
    return server.start().then((port) => ({ port, rec }));
  }

  it('serves /surface/hello for port discovery with CORS', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/surface/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ awaitful: true });
  });

  it('returns the current creative, or 204 when none', async () => {
    const { port } = await start({ creative: CREATIVE });
    const res = await fetch(`http://127.0.0.1:${port}/surface/creative`);
    expect(res.status).toBe(200);
    expect((await res.json()).line).toBe('Try Acme');
  });

  it('dispatches rendered/visible/click beacons to the callbacks', async () => {
    const { port, rec } = await start();
    const post = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adId: 'ad-1', slateId: 'slate-1' }),
    });
    await post('/surface/rendered');
    await post('/surface/visible');
    await post('/surface/click');
    expect(rec).toMatchObject({ rendered: 1, visible: 1, click: 1 });
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
  rec: { start: number; stop: number; pause: number; resume: number; rendered: number; visible: number; click: number; terminalTick?: number },
  overrides: { creative?: SurfaceCreative; terminalLine?: string | null } = {},
) {
  return {
    onStart: () => { rec.start++; },
    onStop: () => { rec.stop++; },
    onPause: () => { rec.pause++; },
    onResume: () => { rec.resume++; },
    getCreative: () => overrides.creative ?? null,
    onRendered: () => { rec.rendered++; },
    onVisible: () => { rec.visible++; },
    onClick: () => { rec.click++; },
    getTerminalLine: () => overrides.terminalLine ?? null,
    onTerminalTick: () => { rec.terminalTick = (rec.terminalTick ?? 0) + 1; },
  };
}
