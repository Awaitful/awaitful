import type { AdSlateResponse } from '@awaitful/shared';
import { AdSlateResponseSchema } from '@awaitful/shared';
import { getJson, HttpError } from '../lib/http.js';
import { CLIENT_PLATFORM } from '../lib/config.js';
import { Rotation } from './rotation.js';

export class SlateCache {
  private slate: AdSlateResponse | undefined;
  private rotation: Rotation | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly placement: string,
  ) {}

  async refresh(token?: string): Promise<void> {
    // `platform` matters only for an anonymous fetch: once this device is linked, the server reads
    // the platform stamped on its token instead, which the client cannot rewrite. Sent on every
    // request regardless, so there is one URL shape rather than two.
    const url =
      `${this.apiUrl}/v1/ad?placement=${encodeURIComponent(this.placement)}` +
      `&platform=${encodeURIComponent(CLIENT_PLATFORM)}`;
    const raw = await getJson<unknown>(url, token);
    // Double-cast: Zod's inferred type uses `url: string | undefined` but our TypeScript
    // interface uses `url?: string` (exactOptionalPropertyTypes). The parse guarantees
    // correctness; the cast reconciles the two representations.
    const slate = AdSlateResponseSchema.parse(raw) as unknown as AdSlateResponse;
    this.slate = slate;
    this.rotation = new Rotation(slate.rotation);
  }

  startPolling(
    intervalMs = 60_000,
    getToken: () => string | undefined,
    onUnauthorized?: () => void,
    onSuccess?: () => void,
  ): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      // Read token at call time so sign-in after startup is reflected immediately.
      this.refresh(getToken()).then(() => {
        onSuccess?.();
      }).catch((err) => {
        if (err instanceof HttpError && err.status === 401) {
          onUnauthorized?.();
        }
        // network / 5xx: keep serving stale slate, leave auth streak untouched
      });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  nextCreative() {
    return this.rotation?.next();
  }

  get isKilled(): boolean {
    return this.slate?.killswitch ?? false;
  }

  get slateId(): string | undefined {
    return this.slate?.slateId;
  }

  /** Rate-card weights per placement, when the server provides them. */
  get placementWeights(): Record<string, number> | undefined {
    return this.slate?.placementWeights;
  }

  /** The account's synced-settings version, when the slate was fetched with a token. */
  get prefsVersion(): number | undefined {
    return this.slate?.prefsVersion;
  }

  get settingsVersion(): number | undefined {
    return this.slate?.settingsVersion;
  }

  dispose(): void {
    this.stopPolling();
  }
}
