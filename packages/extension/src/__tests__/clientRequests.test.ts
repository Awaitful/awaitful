/**
 * The URLs this client actually builds.
 *
 * `egress.test.ts` proves the wrappers add nothing to the wire, and the shared whitelist proves what
 * each query MAY contain. Neither notices if a caller stops sending something it should - and the
 * thing at stake here is the platform scope, whose whole job is to let one client be stopped without
 * stopping the others. Drop it and the failure is silent in the worst way: a macOS-only kill would
 * leave this client serving, and a vscode-only kill would never reach it through the fast poll.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SlateCache } from '../core/slateCache.js';
import { KillswitchMonitor } from '../killswitch/monitor.js';
import { CLIENT_PLATFORM } from '../lib/config.js';

vi.mock('vscode', () => ({
  window: {}, commands: {}, workspace: { getConfiguration: () => ({ get: () => undefined }) },
  Uri: {}, ViewColumn: {}, StatusBarAlignment: {}, extensions: { all: [] },
}));

function mockFetch(body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('what this client says it is', () => {
  /// `vscode` is the whole family, not the app: the same build runs in Cursor, Devin, VSCodium and
  /// VS Code Insiders, and one platform switch covers all of them.
  it('identifies as vscode', () => {
    expect(CLIENT_PLATFORM).toBe('vscode');
  });
});

describe('GET /v1/killswitch', () => {
  it('names this platform, so a scoped kill reaches this client', async () => {
    const fetchMock = mockFetch({ killed: false });
    await new KillswitchMonitor('https://api.test').check();

    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe('/v1/killswitch');
    expect(url.searchParams.get('platform')).toBe('vscode');
  });

  /// This poll is unauthenticated on purpose - a kill must reach a signed-out client too - so unlike
  /// the slate there is no token for the server to read the platform from. The parameter is the only
  /// signal, which is why its absence would be invisible rather than an error.
  it('sends no token, so the parameter is the only thing identifying the client', async () => {
    const fetchMock = mockFetch({ killed: false });
    await new KillswitchMonitor('https://api.test').check();

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBeUndefined();
  });
});

describe('GET /v1/ad', () => {
  const slate = {
    slateId: 's1', rotation: [], rotateEverySeconds: 30, etag: 'e', killswitch: false,
  };

  it('sends the placement and the platform together', async () => {
    const fetchMock = mockFetch(slate);
    await new SlateCache('https://api.test', 'status-bar').refresh();

    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe('/v1/ad');
    expect(url.searchParams.get('placement')).toBe('status-bar');
    expect(url.searchParams.get('platform')).toBe('vscode');
  });

  /// One URL shape whether or not the device is linked. The platform is only READ for an anonymous
  /// request - a linked device is resolved from the platform stamped on its token, which this client
  /// cannot rewrite - but sending it conditionally would mean two shapes to reason about and a gap
  /// that only ever appears in the state hardest to notice.
  it('sends it whether or not there is a token', async () => {
    const fetchMock = mockFetch(slate);
    await new SlateCache('https://api.test', 'status-bar').refresh('tok-123');

    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('platform')).toBe('vscode');
  });

  it('carries nothing else', async () => {
    const fetchMock = mockFetch(slate);
    await new SlateCache('https://api.test', 'terminal').refresh();

    const keys = [...new URL(fetchMock.mock.calls[0]![0]).searchParams.keys()].sort();
    expect(keys).toEqual(['placement', 'platform']);
  });
});
