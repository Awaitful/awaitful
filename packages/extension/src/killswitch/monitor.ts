import type { KillswitchResponse } from '@awaitful/shared';
import { KillswitchResponseSchema } from '@awaitful/shared';
import { getJson } from '../lib/http.js';
import { CLIENT_PLATFORM } from '../lib/config.js';

export class KillswitchMonitor {
  private killed = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private changeHandler: ((killed: boolean) => void) | undefined;

  constructor(private readonly apiUrl: string) {}

  onKillswitchChange(handler: (killed: boolean) => void): void {
    this.changeHandler = handler;
  }

  async check(): Promise<boolean> {
    // Naming the platform is what lets one client be stopped without stopping the others. This poll
    // is unauthenticated - a kill must reach a signed-out client too - so unlike the slate there is
    // no token to read it from, and saying nothing means asking only about the global switch.
    const raw = await getJson<KillswitchResponse>(
      `${this.apiUrl}/v1/killswitch?platform=${encodeURIComponent(CLIENT_PLATFORM)}`,
    );
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
