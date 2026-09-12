import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AGENT_IDS, type AgentId, type PlacementId } from '@awaitful/shared';
import { SHIM_VERSION } from '../patch/recipe.js';

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
   *
   * Explicitly `| undefined` so `restyle()` can CLEAR it: the developer can turn brand logos off
   * for this format, and the ad already on screen has to lose its logo without the impression
   * ending. `JSON.stringify` drops the undefined key, so the shim simply sees no logo.
   */
  iconUrl?: string | undefined;
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
  /**
   * The ad spinner, as FRAMES rather than an id: the shim renders whatever arrives, so new (or
   * future user-defined) spinners never require a shim change. Absent or empty = no spinner.
   * Frames are single-column glyphs (see ui/spinners.ts); the shim derives the current frame from
   * the wall clock, keeping every surface in sync without shared timers.
   */
  spinnerFrames?: string[];
  spinnerIntervalMs?: number;
  /** The zero-bid house fallback: bills nobody, pays nothing - and the shim says so. */
  unpaid?: boolean;
}

export interface SurfaceBeacon {
  adId: string;
  slateId: string;
  visibleMs?: number;
  /**
   * Which host issued the creative this beacon is about, and which shim instance is reporting.
   *
   * Both are required to bill honestly with more than one webview open. Every window's shim scans
   * the same loopback port range and can reach any window's host, so without identity two shims
   * fetch the same creative and both post `visible {visibleMs:1000}` at 1 Hz into one accumulator -
   * and `view_threshold_met` fires at half the wall-clock time it should. Beacons for another host
   * are dropped at the door; beacons from a shim other than the one that first painted are ignored
   * by the session.
   */
  hostId?: string;
  shimId?: string;
}

/** The shim's self-report that it could not place the overlay. See SurfaceLiveness. */
export interface SurfaceAttestation {
  hostId: string;
  shimId: string;
  /** Shim version running in the webview, so a stale bundle is distinguishable from a broken one. */
  v: number;
  /** One stage today: the shim had a creative, the agent was thinking, and no anchor could be found. */
  stage: 'no-anchor';
  adId: string;
}

type Callbacks = {
  /**
   * A turn began. `agent` is who said so, when the hook named itself.
   *
   * OPTIONAL, and permanently: hooks already written into developers' settings.json predate the
   * parameter, and those files are only rewritten when the extension reinstalls them. Absent means
   * "we do not know" - never 'claude-code', which would be a guess recorded as a fact.
   */
  onStart(agent?: AgentId): void;
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
  /** A shim introduced itself to THIS host (it may still never paint). */
  onShimHello(shimId: string, shimVersion: number): void;
  /** A shim reported it could not place the overlay. The only proof of a non-render we accept. */
  onAttest(a: SurfaceAttestation): void;
};

// The shim discovers the host by scanning this fixed 127.0.0.1 range (it cannot
// read the port file). Keep in sync with PORT_BASE/PORT_SPAN in the recipe shim.
const PORT_BASE = 51789;
const PORT_SPAN = 12;

export class HookServer {
  private readonly server: http.Server;
  private _port = 0;
  /**
   * Identity for THIS window's host, minted per session. Every shim in every window scans the same
   * port range, so "a beacon arrived" says nothing about which window it came from. This is what
   * makes a beacon attributable.
   */
  private readonly hostId = randomUUID();
  /**
   * Latched once a thinking hook fires here. A shim prefers a host that is actually being driven,
   * which is what stops window B's shim from binding to window A's host and leaving both dark.
   */
  private serving = false;

  constructor(private readonly cb: Callbacks) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  /** Called by the orchestrator on the first thinking hook of the session. */
  markServing(): void {
    this.serving = true;
  }

  get id(): string {
    return this.hostId;
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

    // Thinking hooks (fired by an agent's settings.json curl commands). The path may carry
    // ?agent=<id>; an older installed hook does not, and that is handled as unknown rather than
    // assumed. An id we do not recognise is also unknown - it is not this build's agent, and
    // forwarding it would put an unvalidated value on the wire the server's enum then rejects.
    if (method === 'POST' && url.startsWith('/thinking/')) {
      const [path, query] = url.split('?', 2);
      const raw = query ? new URLSearchParams(query).get('agent') : null;
      const agent = raw && (AGENT_IDS as readonly string[]).includes(raw) ? (raw as AgentId) : undefined;
      switch (path) {
        case '/thinking/start': res.writeHead(200).end('ok'); this.cb.onStart(agent); return;
        case '/thinking/stop': res.writeHead(200).end('ok'); this.cb.onStop(); return;
        case '/thinking/pause': res.writeHead(200).end('ok'); this.cb.onPause(); return;
        case '/thinking/resume': res.writeHead(200).end('ok'); this.cb.onResume(); return;
      }
    }

    // Surface channel (fired by the in-webview shim).
    if (method === 'GET' && url.startsWith('/surface/hello')) {
      // `serving` lets a shim prefer a host that is actually being driven. With several windows
      // open, binding to the first responder means window B's shim can latch window A's host: A
      // gets the thinking hooks but has no shim in view, B has the view but no hooks, and nothing
      // renders in either. Identity here is what makes every later beacon attributable.
      const q = url.indexOf('?') >= 0 ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : undefined;
      const shimId = q?.get('shim') ?? undefined;
      const v = Number(q?.get('v') ?? '0');
      if (shimId) this.cb.onShimHello(shimId, Number.isFinite(v) ? v : 0);
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ awaitful: true, hostId: this.hostId, serving: this.serving, shimVersion: SHIM_VERSION }));
      return;
    }
    if (method === 'GET' && url === '/surface/creative') {
      const c = this.cb.getCreative();
      // Stamp the creative with our identity so the shim can echo it back on every beacon.
      res.writeHead(c ? 200 : 204, { 'content-type': 'application/json' })
        .end(c ? JSON.stringify({ ...c, hostId: this.hostId }) : '');
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
          const b = body as SurfaceBeacon & Partial<SurfaceAttestation>;
          // A beacon naming a DIFFERENT host is another window's business. Dropping it here is the
          // single point that stops cross-window double-accrual; a beacon with no hostId at all is
          // a pre-identity shim (mid-upgrade, before the reload) and is also not ours to bill.
          if (b && b.hostId !== this.hostId) { res.writeHead(200).end('ok'); return; }
          // Attestation carries an adId but is not a billing beacon, so it is dispatched above the
          // adId/slateId gate that guards the ones that are.
          if (url === '/surface/attest') {
            if (b && b.shimId && b.stage === 'no-anchor' && b.adId) {
              this.cb.onAttest({ hostId: this.hostId, shimId: b.shimId, v: Number(b.v) || 0, stage: 'no-anchor', adId: b.adId });
            }
          } else if (b && b.adId && b.slateId) {
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
