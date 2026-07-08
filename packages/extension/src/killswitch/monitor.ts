import type { KillswitchResponse } from '@awaitful/shared';
import { KillswitchResponseSchema } from '@awaitful/shared';
import { getJson } from '../lib/http.js';

export class KillswitchMonitor {
  private killed = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private changeHandler: ((killed: boolean) => void) | undefined;

  constructor(private readonly apiUrl: string) {}

  onKillswitchChange(handler: (killed: boolean) => void): void {
    this.changeHandler = handler;
  }

  async check(): Promise<boolean> {
    const raw = await getJson<KillswitchResponse>(`${this.apiUrl}/v1/killswitch`);
    const { killed } = KillswitchResponseSchema.parse(raw);
    if (killed !== this.killed) {
      this.killed = killed;
      this.changeHandler?.(killed);
    }
    return killed;
  }

  startPolling(intervalMs = 30_000): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.check().catch(() => {/* keep last known state on network failure */});
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  get isKilled(): boolean {
    return this.killed;
  }

  dispose(): void {
    this.stopPolling();
  }
}
