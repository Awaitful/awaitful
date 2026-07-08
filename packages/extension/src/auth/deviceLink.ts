import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { apiBaseUrl } from '../lib/config.js';
import { postJson, getJson } from '../lib/http.js';

const SECRET_TOKEN = 'awaitful.deviceToken';
const SECRET_DEVICE_ID = 'awaitful.deviceId';

const POLL_INTERVAL_MS = 2_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1_000;

export class DeviceLink {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async token(): Promise<string | undefined> {
    return this.secrets.get(SECRET_TOKEN);
  }

  async deviceId(): Promise<string | undefined> {
    return this.secrets.get(SECRET_DEVICE_ID);
  }

  // Returns an existing device ID or creates and persists a fresh one.
  // Anonymous devices get an ID immediately so events can be tracked pre-signin.
  async ensureDeviceId(): Promise<string> {
    const existing = await this.secrets.get(SECRET_DEVICE_ID);
    if (existing) return existing;
    const fresh = randomUUID();
    await this.secrets.store(SECRET_DEVICE_ID, fresh);
    return fresh;
  }

  // Opens the browser to the web link-confirmation page, then polls the server every 2 s
  // until the user approves the link there (via their existing web/Google session). Returns
  // the raw device token, or null on timeout.
  async signIn(): Promise<string | null> {
    let base: string;
    try {
      base = apiBaseUrl();
    } catch {
      await vscode.window.showErrorMessage(
        'Awaitful: server URL is not configured. Set awaitful.apiBaseUrl in VS Code settings.',
      );
      return null;
    }

    const state = randomUUID();

    // Register the pending state on the server (Redis-backed, 10-min TTL).
    try {
      await postJson(`${base}/v1/auth/link/start`, { state });
    } catch {
      await vscode.window.showErrorMessage(
        'Awaitful: could not reach the server. Check your connection and try again.',
      );
      return null;
    }

    // Open the web link-confirmation page (SPA) in the user's browser. It uses their existing
    // browser session (email or Google) to approve the link — no separate password form.
    await vscode.env.openExternal(
      vscode.Uri.parse(`${base}/link?state=${encodeURIComponent(state)}`),
    );

    // Poll /v1/auth/link/poll?state=... until the user completes sign-in or we time out.
    return new Promise<string | null>((resolve) => {
      const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;

      const interval = setInterval(async () => {
        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve(null);
          return;
        }
        try {
          const res = await getJson<{ token?: string; pending?: boolean }>(
            `${base}/v1/auth/link/poll?state=${encodeURIComponent(state)}`,
          );
          if (res.token) {
            clearInterval(interval);
            resolve(res.token);
          }
        } catch {
          // Network hiccup — keep polling until deadline.
        }
      }, POLL_INTERVAL_MS);
    });
  }

  async saveToken(token: string): Promise<void> {
    await this.secrets.store(SECRET_TOKEN, token);
  }

  async signOut(): Promise<void> {
    await Promise.all([
      this.secrets.delete(SECRET_TOKEN),
      this.secrets.delete(SECRET_DEVICE_ID),
    ]);
  }
}
