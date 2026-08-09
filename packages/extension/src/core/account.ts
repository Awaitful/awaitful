import type { UserMe, EarningsSummary, RemoteSurfaceId } from '@awaitful/shared';
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

  reportSurfaceApplied(token: string, surface: RemoteSurfaceId): Promise<void> {
    return postJson<void>(`${this.apiUrl}/v1/me/surface-applied`, { surface }, token);
  }

  /** The terminal is additive, so it reports its own on/off rather than being one of the surfaces.
   *  Both outcomes are reported: a device that turns it off is confirming just as much as one that
   *  turns it on, and without that the web would keep showing a stale "on". */
  reportTerminalApplied(token: string, enabled: boolean): Promise<void> {
    return postJson<void>(`${this.apiUrl}/v1/me/terminal-applied`, { enabled }, token);
  }
}
