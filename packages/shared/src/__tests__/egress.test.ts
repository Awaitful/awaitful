import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AdEventSchema,
  EventBatchSchema,
  GetAdQuerySchema,
  GetRecipeQuerySchema,
  KillswitchQuerySchema,
  PatchReportRequestSchema,
  DeviceLinkStartRequestSchema,
  DeviceLinkPollQuerySchema,
  SurfaceAppliedRequestSchema,
  TerminalAppliedRequestSchema,
  AutoApplyReportSchema,
  RemoteSurfacePreferenceRequestSchema,
} from '../schemas.js';

/**
 * EGRESS WHITELIST — the trust guard.
 *
 * These are the ONLY payloads the client ever sends to the Awaitful server. Golden rule 1:
 * we never read or transmit user code, prompts, files, or agent output. This test pins the
 * exact field set of every request body/query the extension puts on the wire, so a field
 * that could carry user content cannot be added silently — adding or renaming a key here
 * fails CI and forces a review + a matching update to PRIVACY.md.
 *
 * Coverage is every request the client makes that carries a body or query:
 *   GET  /v1/ad               — GetAdQuerySchema
 *   GET  /v1/killswitch       — KillswitchQuerySchema
 *   GET  /v1/recipe           — GetRecipeQuerySchema
 *   POST /v1/events           — EventBatchSchema (each event: AdEventSchema)
 *   POST /v1/patch/report     — PatchReportRequestSchema
 *   POST /v1/me/surface-applied — SurfaceAppliedRequestSchema
 *   POST /v1/me/terminal-applied — TerminalAppliedRequestSchema
 *   POST /v1/me/auto-apply    — AutoApplyReportSchema
 *   POST /v1/me/surface-choice — RemoteSurfacePreferenceRequestSchema (two-way sync; synced devices only)
 *   POST /v1/auth/link/start  — DeviceLinkStartRequestSchema
 *   GET  /v1/auth/link/poll   — DeviceLinkPollQuerySchema
 * The remaining calls — GET /v1/me, /v1/earnings/summary — are parameterless: no body, no query,
 * just the Bearer token. That there is no body on ANY GET is pinned separately by the chokepoint
 * test at packages/extension/src/__tests__/http.egress.test.ts, so those two cannot smuggle content
 * either.
 *
 * If you are changing this test, you are changing what leaves a developer's machine.
 * Update PRIVACY.md in the same change and keep the field list honest.
 */

/** Read the top-level keys a zod object schema accepts. */
function keysOf(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape).sort();
}

describe('egress whitelist — what leaves the machine', () => {
  it('GET /v1/ad query carries only placement, coarse opt-in hints, and which client is asking', () => {
    // hints is coarse + opt-in (e.g. hour-of-day) — never user content.
    //
    // `platform` is a closed enum of three constants ('vscode' | 'macos' | 'browser') naming which
    // of our own clients is running. It reveals nothing about the developer or their work that the
    // server does not already hold: a linked device's platform is stamped on its device token at
    // link time, and every ad event already carries the same field. It is here so a platform-scoped
    // killswitch can be enforced server-side for an ANONYMOUS client too — one that has no token to
    // read it from — and stopping a misbehaving client is precisely the case where its own
    // cooperation cannot be assumed.
    expect(keysOf(GetAdQuerySchema)).toEqual(['hints', 'placement', 'platform']);
  });

  it('GET /v1/killswitch query carries only which client is asking', () => {
    // Same closed enum, same reasoning, and the poll is unauthenticated - so naming the platform is
    // the only way the answer can be scoped to the client asking for it.
    expect(keysOf(KillswitchQuerySchema)).toEqual(['platform']);
  });

  it('GET /v1/recipe query carries only the agent + build id + rollout channel', () => {
    // channel is a coarse rollout selector ('stable' | 'canary') — never user content.
    expect(keysOf(GetRecipeQuerySchema)).toEqual(['agent', 'build', 'channel']);
  });

  it('POST /v1/events batch carries only a device id + ad events', () => {
    expect(keysOf(EventBatchSchema)).toEqual(['deviceId', 'events']);
  });

  it('an ad event carries only render/visibility accounting — no content', () => {
    // `platform` and `agent` are coarse closed enums ('vscode' | 'macos' | 'browser';
    // 'claude-code'), added so earnings and caps can be broken down per client and per agent.
    // Both are constrained by z.enum, so neither can carry a free-text value — the rejection is
    // pinned in schemas.test.ts.
    expect(keysOf(AdEventSchema)).toEqual([
      'adId',
      'agent',
      'eventId',
      'occurredAtClientMs',
      'placement',
      'platform',
      'slateId',
      'type',
      'visibleMs',
    ]);
  });

  it('POST /v1/patch/report carries only build hashes + a patch outcome', () => {
    // Build-identifying SHA-256s of Claude Code's OWN files + the applied/failed result.
    // No path, no bytes of user content.
    expect(keysOf(PatchReportRequestSchema)).toEqual([
      'agent',
      'buildId',
      'clean',
      'extSha256',
      'outcome',
      'version',
      'webSha256',
    ]);
  });

  it('POST /v1/me/surface-applied carries only which surface a device ended on + a coarse failure reason', () => {
    // `surface` is one of the fixed RemoteSurfaceIds; `failure` is a CLOSED, coarse enum (no path,
    // filename, or vendor detail), so neither field can carry user content.
    expect(keysOf(SurfaceAppliedRequestSchema)).toEqual(['failure', 'surface']);
    // The failure reason is a bounded whitelist, never a free-form string that could smuggle content…
    expect(() => SurfaceAppliedRequestSchema.parse({ surface: 'chat-banner', failure: 'unsupported-build' })).not.toThrow();
    expect(() => SurfaceAppliedRequestSchema.parse({ surface: 'chat-banner', failure: '/Users/me/secret/path' })).toThrow();
    // …and it is optional/nullable, so an older client that omits it still reads as a plain success.
    expect(() => SurfaceAppliedRequestSchema.parse({ surface: 'chat-banner' })).not.toThrow();
  });

  it('POST /v1/me/terminal-applied carries only whether the line is on — no content', () => {
    // One boolean about this device's own state. Same narrow write a device token already had for
    // the surface it applied, and the same reason it exists: the request is not the outcome.
    expect(keysOf(TerminalAppliedRequestSchema)).toEqual(['enabled']);
  });

  it('POST /v1/me/auto-apply carries only this device\'s own Control-from-web opt-in — no content', () => {
    // One boolean about this device's own consent state, reported up so the dashboard can show it.
    // The web can never SET it; a device only ever tells the server a fact about itself.
    expect(keysOf(AutoApplyReportSchema)).toEqual(['enabled']);
  });

  it('POST /v1/me/surface-choice carries only the coarse surface a synced device chose — no content', () => {
    // Two-way sync: a synced device writes the shared surface preference when the developer changes the
    // format there. The same coarse surface id the applied-surface report already sends - no path, no
    // filename, no content - and the server accepts it only under this device's own sync opt-in.
    expect(keysOf(RemoteSurfacePreferenceRequestSchema)).toEqual(['surface']);
  });

  it('POST /v1/auth/link/start carries only a random state nonce — no account, no content', () => {
    expect(keysOf(DeviceLinkStartRequestSchema)).toEqual(['state']);
  });

  it('GET /v1/auth/link/poll carries only a random state nonce — no account, no content', () => {
    expect(keysOf(DeviceLinkPollQuerySchema)).toEqual(['state']);
  });

  it('an ad event rejects unknown extra keys (strict wire shape)', () => {
    const base = {
      eventId: '00000000-0000-4000-8000-000000000000',
      type: 'view_threshold_met',
      adId: 'ad-1',
      slateId: 'slate-1',
      placement: 'chat-banner',
      occurredAtClientMs: 1,
    };
    // A sanctioned event parses…
    expect(() => AdEventSchema.parse(base)).not.toThrow();
    // …but zod strips unknown keys rather than transmitting them: the parsed
    // output must never carry a field we did not whitelist.
    const parsed = AdEventSchema.parse({ ...base, promptText: 'secret user prompt' }) as Record<
      string,
      unknown
    >;
    expect(parsed.promptText).toBeUndefined();
  });
});
