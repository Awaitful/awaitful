import { describe, it, expect, beforeEach, vi } from 'vitest';

// vscode is not available in the test runner — provide a minimal stub.
// vi.mock() calls are hoisted by vitest so this runs before the module import below.
vi.mock('vscode', () => ({
  env: { uriScheme: 'vscode', asExternalUri: vi.fn(), openExternal: vi.fn() },
  window: { showErrorMessage: vi.fn(), registerUriHandler: vi.fn() },
  Uri: { parse: (s: string) => ({ toString: () => s, query: '' }) },
}));

import { DeviceLink } from '../auth/deviceLink.js';

// Minimal in-memory implementation of VS Code's SecretStorage API.
class FakeSecretStorage {
  private data = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.data.get(key); }
  async store(key: string, value: string): Promise<void> { this.data.set(key, value); }
  async delete(key: string): Promise<void> { this.data.delete(key); }
}

let secrets: FakeSecretStorage;
let link: DeviceLink;

beforeEach(() => {
  secrets = new FakeSecretStorage();
  link = new DeviceLink(secrets as never);
});

describe('ensureDeviceId', () => {
  it('creates a UUID on first call', async () => {
    const id = await link.ensureDeviceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns the same ID on subsequent calls', async () => {
    const a = await link.ensureDeviceId();
    const b = await link.ensureDeviceId();
    expect(a).toBe(b);
  });

  it('persists across new DeviceLink instances sharing the same storage', async () => {
    const id = await link.ensureDeviceId();
    const link2 = new DeviceLink(secrets as never);
    expect(await link2.ensureDeviceId()).toBe(id);
  });
});

describe('saveToken / token', () => {
  it('stores the token and retrieves it', async () => {
    await link.saveToken('tok-abc123');
    expect(await link.token()).toBe('tok-abc123');
  });
});

describe('signOut', () => {
  it('clears both token and deviceId', async () => {
    await link.ensureDeviceId();
    await link.saveToken('tok-abc123');
    await link.signOut();
    expect(await link.token()).toBeUndefined();
    expect(await link.deviceId()).toBeUndefined();
  });
});
