import * as http from 'node:http';
import type { PlacementId } from '@awaitful/shared';

/** What the shim needs to paint the sponsored line. Host-internal (not the server contract). */
export interface SurfaceCreative {
  adId: string;
  slateId: string;
  line: string;
  url?: string;
  /**
   * Optional sponsor logo shown before the ad text; the shim hides the slot when absent.
   * MUST be a `data:` URI — Claude Code's webview CSP is `img-src <cspSource> data:`, so an
   * external https logo is blocked. The server inlines the advertiser's logo as a data: URI.
   */
  iconUrl?: string;
  /**
   * Which webview placement the shim should render this as. `thinking-line` covers the
   * spinner verb (the default when absent); `chat-banner` docks a fixed banner above the
   * composer and hides CC's spinner. Both are mutually exclusive and billed only while thinking.
   */
  placement?: PlacementId;
  /** Glow-theme id for the chat-banner (see recipe.ts GLOW_THEMES); ignored in thinking-line mode. */
  bannerStyle?: string;
  /** Chat-banner outline frame: 'banner' (outline the ad, connected to the box) or 'full' (wrap ad+chat). */
  bannerFrame?: string;
}

export interface SurfaceBeacon {
  adId: string;
  slateId: string;
  visibleMs?: number;
}

type Callbacks = {
  onStart(): void;
  onStop(): void;
  /** Claude paused mid-turn to wait for the user (permission prompt / elicitation). */
  onPause(): void;
  /** The agent resumed work after the user answered (a tool ran). */
  onResume(): void;
  /** Current creative for the active webview (thinking-line / chat-banner) session, or null. */
  getCreative(): SurfaceCreative | null;
  onRendered(b: SurfaceBeacon): void;
  onVisible(b: SurfaceBeacon): void;
  onClick(b: SurfaceBeacon): void;
  /**
   * The formatted terminal status-line string to print right now, or null when the terminal
   * surface should show nothing (not thinking / disabled / paused). Agent-neutral — every agent's
   * status-line script hits the same endpoint. Called each time an agent re-runs its status line.
   */
  getTerminalLine(): string | null;
  /** A verified render tick: an agent actually re-ran its status line while eligible (bills time). */
  onTerminalTick(): void;
};

// The shim discovers the host by scanning this fixed 127.0.0.1 range (it cannot
// read the port file). Keep in sync with PORT_BASE/PORT_SPAN in the recipe shim.
const PORT_BASE = 51789;
const PORT_SPAN = 12;

export class HookServer {
  private readonly server: http.Server;
  private _port = 0;

  constructor(private readonly cb: Callbacks) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  private cors(res: http.ServerResponse): void {
    // The Claude Code webview is a different origin; allow it to reach us.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    // No keep-alive: these are infrequent control requests, and closing each
    // socket avoids stale-pool resets if the host restarts on the same port.
    res.setHeader('Connection', 'close');
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.cors(res);
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // Drain the request stream for everything except the beacon POSTs we read
    // below — an unconsumed stream on a keep-alive socket triggers ECONNRESET.
    const isBeaconPost = method === 'POST' && url.startsWith('/surface/');
    if (!isBeaconPost) req.resume();

    if (method === 'OPTIONS') { res.writeHead(204).end(); return; }

    // Thinking hooks (fired by Claude Code's settings.json curl commands).
    if (method === 'POST' && url === '/thinking/start') { res.writeHead(200).end('ok'); this.cb.onStart(); return; }
    if (method === 'POST' && url === '/thinking/stop') { res.writeHead(200).end('ok'); this.cb.onStop(); return; }
    if (method === 'POST' && url === '/thinking/pause') { res.writeHead(200).end('ok'); this.cb.onPause(); return; }
    if (method === 'POST' && url === '/thinking/resume') { res.writeHead(200).end('ok'); this.cb.onResume(); return; }

    // Surface channel (fired by the in-webview shim).
    if (method === 'GET' && url === '/surface/hello') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"awaitful":true}');
      return;
    }
    if (method === 'GET' && url === '/surface/creative') {
      const c = this.cb.getCreative();
      res.writeHead(c ? 200 : 204, { 'content-type': 'application/json' }).end(c ? JSON.stringify(c) : '');
      return;
    }
    // Terminal status line: fired by an agent's statusLine script (see hooks/statusLineScript.ts).
    // Returns the ready-to-print line while thinking; the GET itself is the verified render tick.
    if (method === 'GET' && url === '/surface/terminal') {
      const line = this.cb.getTerminalLine();
      if (line != null) this.cb.onTerminalTick();
      res.writeHead(line != null ? 200 : 204, { 'content-type': 'text/plain; charset=utf-8' }).end(line ?? '');
      return;
    }
    if (method === 'POST' && url.startsWith('/surface/')) {
      readBody(req, (body) => {
        // Dispatch (cheap, synchronous) then ack. Beacons are fire-and-forget for
        // the shim, so this ordering costs nothing and keeps behaviour deterministic.
        try {
          const b = body as SurfaceBeacon;
          if (b && b.adId && b.slateId) {
            if (url === '/surface/rendered') this.cb.onRendered(b);
            else if (url === '/surface/visible') this.cb.onVisible(b);
            else if (url === '/surface/click') this.cb.onClick(b);
          }
        } catch { /* ignore malformed beacons */ }
        res.writeHead(200).end('ok');
      });
      return;
    }

    res.writeHead(404).end();
  }

  /** Bind the first free port in the fixed range so the shim can find us. */
  start(): Promise<number> {
    return this.tryBind(0);
  }

  private tryBind(i: number): Promise<number> {
    return new Promise((resolve, reject) => {
      if (i >= PORT_SPAN) {
        // Range exhausted: fall back to a random port. Thinking hooks still work
        // (they read the port file); only the surface channel degrades.
        this.server.listen(0, '127.0.0.1', () => resolve(this.done()));
        this.server.once('error', reject);
        return;
      }
      const onError = (err: NodeJS.ErrnoException) => {
        this.server.removeListener('error', onError);
        if (err.code === 'EADDRINUSE') resolve(this.tryBind(i + 1));
        else reject(err);
      };
      this.server.once('error', onError);
      this.server.listen(PORT_BASE + i, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        resolve(this.done());
      });
    });
  }

  private done(): number {
    const addr = this.server.address();
    this._port = addr && typeof addr === 'object' ? addr.port : 0;
    return this._port;
  }

  get port(): number {
    return this._port;
  }

  dispose(): void {
    this.server.close();
  }
}

function readBody(req: http.IncomingMessage, done: (body: unknown) => void): void {
  let data = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 8192) { tooBig = true; req.destroy(); } // beacons are tiny
  });
  req.on('end', () => { if (tooBig) { done(null); return; } try { done(JSON.parse(data || '{}')); } catch { done(null); } });
  req.on('error', () => done(null));
}
