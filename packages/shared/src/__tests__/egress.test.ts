import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AdEventSchema,
  EventBatchSchema,
  GetAdQuerySchema,
  GetRecipeQuerySchema,
  PatchReportRequestSchema,
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
 * If you are changing this test, you are changing what leaves a developer's machine.
 * Update docs/PRIVACY.md in the same change and keep the field list honest.
 */

/** Read the top-level keys a zod object schema accepts. */
function keysOf(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape).sort();
}

describe('egress whitelist — what leaves the machine', () => {
  it('GET /v1/ad query carries only placement + coarse opt-in hints', () => {
    // hints is coarse + opt-in (e.g. hour-of-day) — never user content.
    expect(keysOf(GetAdQuerySchema)).toEqual(['hints', 'placement']);
  });

  it('GET /v1/recipe query carries only the agent + build id + rollout channel', () => {
    // channel is a coarse rollout selector ('stable' | 'canary') — never user content.
    expect(keysOf(GetRecipeQuerySchema)).toEqual(['agent', 'build', 'channel']);
  });

  it('POST /v1/events batch carries only a device id + ad events', () => {
    expect(keysOf(EventBatchSchema)).toEqual(['deviceId', 'events']);
  });

  it('an ad event carries only render/visibility accounting — no content', () => {
    expect(keysOf(AdEventSchema)).toEqual([
      'adId',
      'eventId',
      'occurredAtClientMs',
      'placement',
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
