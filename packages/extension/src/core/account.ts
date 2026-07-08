import type { UserMe, EarningsSummary } from '@awaitful/shared';
import { getJson } from '../lib/http.js';

/**
 * Read-only account info for the panel header: whose account is earning,
 * and how much today. Both routes accept the device bearer token and
 * grant nothing write-capable (see docs/CONTRACT.md §2).
 */
export class AccountClient {
  constructor(private readonly apiUrl: string) {}

  fetchMe(token: string): Promise<UserMe> {
    return getJson<UserMe>(`${this.apiUrl}/v1/me`, token);
  }

  fetchEarnings(token: string): Promise<EarningsSummary> {
    return getJson<EarningsSummary>(`${this.apiUrl}/v1/earnings/summary`, token);
  }
}
