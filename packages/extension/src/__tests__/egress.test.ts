import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getJson, postJson } from '../lib/http.js';

/**
 * THE EGRESS CHOKEPOINT — the other half of the trust guard.
 *
 * PRIVACY.md's central claim is that the client talks to the server through exactly one place -
 * getJson / postJson in lib/http.ts - and that neither wrapper can smuggle anything onto the wire.
 * The schema whitelist (packages/shared/src/__tests__/egress.test.ts) pins WHAT each body or query
 * may contain; this test pins what the WRAPPERS themselves send.
 *
 * That matters most for the calls with no schema to pin: GET /v1/killswitch, /v1/me and
 * /v1/earnings/summary. They carry no body and no query - just the Bearer token - and this test
 * proves it structurally: getJson issues a GET with no request body at all, so those three cannot
 * carry content even in principle. postJson is proven to send byte-for-byte the caller's body and
 * nothing more, so a POST can only ever contain a whitelisted (schema-pinned) shape plus the token.
 */
describe('the egress chokepoint — what the wrappers put on the wire', () => {
  // A minimal Response stand-in with typed params, so calls[] is typed and no global fetch is needed.
  function mockFetch() {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('getJson sends NO request body — so every GET (killswitch, /me, /earnings, ad, recipe, poll) carries only its URL', async () => {
    const fetchMock = mockFetch();
    await getJson('https://api.test/v1/killswitch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/killswitch');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init && 'body' in init).toBe(false); // a GET has no request body, so no content can ride along
    expect(init?.headers).toEqual({ Accept: 'application/json' }); // no token given -> Accept only
  });

  it('getJson attaches only a Bearer token when given, and still no body', async () => {
    const fetchMock = mockFetch();
    await getJson('https://api.test/v1/me', 'tok-123');
    const init = fetchMock.mock.calls[0]![1]!;
    expect('body' in init).toBe(false);
    expect(init.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer tok-123' });
  });

  it('postJson sends exactly the caller body, byte for byte — the wrapper adds no fields', async () => {
    const fetchMock = mockFetch();
    await postJson('https://api.test/v1/auth/link/start', { state: 'a-nonce' });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ state: 'a-nonce' }));
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' });
  });

  it('postJson adds a Bearer token but still sends only the given body', async () => {
    const fetchMock = mockFetch();
    await postJson('https://api.test/v1/events', { deviceId: 'd', events: [] }, 'tok-123');
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBe(JSON.stringify({ deviceId: 'd', events: [] }));
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer tok-123',
    });
  });
});

/**
 * THE SINGLE OUTBOUND PATH — enforced, not just asserted.
 *
 * PRIVACY.md declares that the client reaches the Awaitful SERVER through exactly one place. This
 * test makes that structural: it scans the source and fails if a raw network call (fetch / XHR /
 * WebSocket / http(s).request) appears anywhere but the two sanctioned files. Adding a network call
 * elsewhere fails CI and forces a review + a PRIVACY.md update — which is exactly how a second,
 * direct fetch to /v1/recipe slipped past review before this guard existed.
 */
describe('the single outbound path — source guard', () => {
  const SRC = join(__dirname, '..'); // this file is CJS output (VS Code host), so __dirname, not import.meta
  // The ONLY files permitted to issue a network request:
  const ALLOWED = new Set([
    'lib/http.ts', // the server-egress chokepoint (getJson / postJson)
    'patch/recipe.ts', // injected webview code that talks ONLY to the 127.0.0.1 loopback helper
  ]);
  // Outbound calls only. `http.createServer` (the inbound loopback helper in hooks/server.ts) is
  // deliberately not matched — it receives connections, it does not make them.
  const OUTBOUND = /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|\bhttps?\.(request|get)\s*\(/;

  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === '__tests__' ? [] : tsFiles(p);
      return name.endsWith('.ts') ? [p] : [];
    });
  }

  const networkFiles = () =>
    tsFiles(SRC)
      .filter((p) => OUTBOUND.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p).split('\\').join('/'));

  it('a raw network call appears only in the chokepoint and the loopback webview code', () => {
    const offenders = networkFiles().filter((rel) => !ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });

  it('the matcher actually detects the known network files (so an empty result is real, not a broken regex)', () => {
    const matched = networkFiles();
    expect(matched).toContain('lib/http.ts');
    expect(matched).toContain('patch/recipe.ts');
  });

  it('the loopback webview code (recipe.ts) targets only 127.0.0.1, never a /v1 server route', () => {
    const src = readFileSync(join(SRC, 'patch', 'recipe.ts'), 'utf8');
    expect(src).toContain('127.0.0.1'); // its injected fetches go to the loopback host it discovers
    expect(src).not.toMatch(/fetch\([^)]*\/v1\//); // and never straight to a server route
  });
});
