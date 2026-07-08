import { describe, it, expect, afterEach, vi } from 'vitest';
import { AccountClient } from '../core/account.js';
import { HttpError } from '../lib/http.js';

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('AccountClient', () => {
  it('fetchMe hits /v1/me with the bearer token and returns the parsed body', async () => {
    const me = { email: 'dev@example.com', role: ['developer'], deviceCount: 2 };
    const fetchFn = mockFetchOnce(200, me);

    const client = new AccountClient('http://localhost:3000');
    await expect(client.fetchMe('tok-1')).resolves.toEqual(me);

    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:3000/v1/me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tok-1' }),
      }),
    );
  });

  it('fetchEarnings hits /v1/earnings/summary and returns todayUsd', async () => {
    const summary = { todayUsd: '0.42', lifetimeUsd: '3.10', byPlacement: [], recent: [] };
    const fetchFn = mockFetchOnce(200, summary);

    const client = new AccountClient('http://localhost:3000');
    const result = await client.fetchEarnings('tok-1');
    expect(result.todayUsd).toBe('0.42');

    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:3000/v1/earnings/summary',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tok-1' }),
      }),
    );
  });

  it('throws HttpError with the status on a revoked token', async () => {
    mockFetchOnce(401, { error: 'Token revoked or unlinked' });

    const client = new AccountClient('http://localhost:3000');
    await expect(client.fetchMe('tok-revoked')).rejects.toSatisfy(
      (err: unknown) => err instanceof HttpError && err.status === 401,
    );
  });
});
