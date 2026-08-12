import type { UserMe, EarningsSummary, RemoteSurfaceId, SurfaceApplyFailure } from '@awaitful/shared';
import { getJson, postJson } from '../lib/http.js';

/**
 * Account info for the panel header: whose account is earning, and how much today. The two reads
 * accept the device bearer token and grant nothing write-capable (see docs/CONTRACT.md §2).
 * `reportSurfaceApplied` is the one narrow write a device token gets, alongside event/patch-health
 * reporting - a fact about this device's own state, never account-controlling.
 */
export class AccountClient {
  constructor(private readonly apiUrl: string) {}

  fetchMe(token: string): Promise<UserMe> {
    return getJson<UserMe>(`${this.apiUrl}/v1/me`, token);
  }

  fetchEarnings(token: string): Promise<EarningsSummary> {
    return getJson<EarningsSummary>(`${this.apiUrl}/v1/earnings/summary`, token);
  }

  /** `surface` is the one this device ENDED on (the fail-safe status bar when a requested surface could
   *  not be applied); `failure` is the coarse reason it could not, or null on success. */
  reportSurfaceApplied(token: string, surface: RemoteSurfaceId, failure: SurfaceApplyFailure | null): Promise<void> {
    return postJson<void>(`${this.apiUrl}/v1/me/surface-applied`, { surface, failure }, token);
  }

  /** The terminal is additive, so it reports its own on/off rather than being one of the surfaces.
   *  Both outcomes are reported: a device that turns it off is confirming just as much as one that
   *  turns it on, and without that the web would keep showing a stale "on". */
  reportTerminalApplied(token: string, enabled: boolean): Promise<void> {
    return postJson<void>(`${this.apiUrl}/v1/me/terminal-applied`, { enabled }, token);
  }

  /** Report this device's own "Control from web" opt-in, so the dashboard can show which editors will
   *  apply a web-set format on their own. Device-token write; the web never sets this. */
  reportControlAllowed(token: string, enabled: boolean): Promise<void> {
    return postJson<void>(`${this.apiUrl}/v1/me/auto-apply`, { enabled }, token);
  }
}
