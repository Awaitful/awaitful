import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { ConsentStore } from '../core/consent.js';

// In-memory stand-in for vscode's globalState (Memento).
function makeState() {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
    keys: () => [...store.keys()],
  } as unknown as vscode.ExtensionContext['globalState'];
  return { state, store };
}

describe('ConsentStore', () => {
  it('defaults to not granted for every surface', () => {
    const { state } = makeState();
    const consent = new ConsentStore(state);
    for (const id of ['status-bar', 'thinking-line', 'terminal', 'browser', 'chat-banner'] as const) {
      expect(consent.isGranted(id)).toBe(false);
    }
  });

  it('grant persists and is readable back', async () => {
    const { state } = makeState();
    const consent = new ConsentStore(state);
    await consent.grant('chat-banner');
    expect(consent.isGranted('chat-banner')).toBe(true);
  });

  it('granting one surface does not grant any other', async () => {
    const { state } = makeState();
    const consent = new ConsentStore(state);
    await consent.grant('thinking-line');
    expect(consent.isGranted('chat-banner')).toBe(false);
    expect(consent.isGranted('terminal')).toBe(false);
    expect(consent.isGranted('status-bar')).toBe(false);
  });

  it('revoke removes a previously granted consent', async () => {
    const { state } = makeState();
    const consent = new ConsentStore(state);
    await consent.grant('terminal');
    await consent.revoke('terminal');
    expect(consent.isGranted('terminal')).toBe(false);
  });

  it('revokeAll clears every surface at once', async () => {
    const { state } = makeState();
    const consent = new ConsentStore(state);
    await consent.grant('chat-banner');
    await consent.grant('thinking-line');
    await consent.grant('terminal');
    await consent.revokeAll();
    for (const id of ['status-bar', 'thinking-line', 'terminal', 'browser', 'chat-banner'] as const) {
      expect(consent.isGranted(id)).toBe(false);
    }
  });

  it('treats non-boolean stored values as not granted', async () => {
    const { state, store } = makeState();
    const consent = new ConsentStore(state);
    store.set('awaitful.consent.chat-banner', 'yes');
    store.set('awaitful.consent.terminal', 1);
    expect(consent.isGranted('chat-banner')).toBe(false);
    expect(consent.isGranted('terminal')).toBe(false);
  });

  it('uses namespaced keys so it cannot collide with other extension state', async () => {
    const { state, store } = makeState();
    const consent = new ConsentStore(state);
    await consent.grant('chat-banner');
    expect([...store.keys()]).toEqual(['awaitful.consent.chat-banner']);
  });
});
