import * as fs from 'node:fs';
import { extensionsRoot } from './targets.js';

/**
 * Watches the VS Code extensions directory and fires a debounced callback when
 * anything under it changes — a Claude Code update (new build dir) or another
 * extension re-patching a target file. The orchestrator responds by re-assessing
 * and (if consented and safe) re-applying, or restoring, the thinking-line patch.
 *
 * Fail-safe: any watch error is swallowed. On a transient error the watcher
 * re-arms a few times with backoff rather than giving up for the session; if it
 * ultimately can't watch (e.g. recursive watch unsupported), auto-heal is simply
 * off and re-apply-on-activation still converges on the next reload.
 */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 5000;

export class PatchWatcher {
  private watcher: fs.FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private disposed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly debounceMs = 1500,
  ) {}

  start(): void {
    if (this.disposed) return;
    try {
      this.watcher = fs.watch(extensionsRoot(), { recursive: true }, () => this.schedule());
      this.watcher.on('error', () => this.onError());
      this.retries = 0; // a clean start resets the budget
    } catch {
      this.onError(); // directory missing / recursive watch unsupported
    }
  }

  private onError(): void {
    try { this.watcher?.close(); } catch { /* ignore */ }
    this.watcher = undefined;
    if (this.disposed || this.retries >= MAX_RETRIES) return; // give up quietly
    this.retries++;
    this.retryTimer = setTimeout(() => this.start(), RETRY_BASE_MS * this.retries);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.onChange(); } catch { /* callback errors never crash the watcher */ }
    }, this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    try { this.watcher?.close(); } catch { /* ignore */ }
    this.watcher = undefined;
  }
}
