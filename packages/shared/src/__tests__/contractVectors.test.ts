import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AdEventSchema,
  AdSlateResponseSchema,
  CreativeSchema,
  EventBatchSchema,
  KillswitchResponseSchema,
} from '../schemas.js';

/**
 * The TypeScript half of the cross-language contract suite. Its Swift twin lives at
 * packages/macos/Tests/AwaitfulKitTests/ContractVectorTests.swift and reads THE SAME FILES.
 *
 * There are two clients speaking this protocol now, in two languages, and nothing else would notice
 * them drifting apart: a field renamed here and not there shows up as a 400 in production, months
 * later, on whichever client moved. These vectors are the thing that fails first instead.
 *
 * The files in fixtures/contract are hand-written specifications — see the README there. Never
 * regenerate them from an implementation: that makes the test agree with whatever the code happens
 * to do today, which is exactly the drift it is supposed to catch.
 */

const DIR = fileURLToPath(new URL('../../../../fixtures/contract/', import.meta.url));

function vector(name: string): unknown {
  return JSON.parse(readFileSync(`${DIR}${name}`, 'utf8'));
}

describe('contract vectors — slates', () => {
  it('decodes an ordinary paid slate, side-channels and all', () => {
    const slate = AdSlateResponseSchema.parse(vector('slate-basic.json'));
    expect(slate.rotation).toHaveLength(2);
    expect(slate.rotation[0]?.brand?.name).toBe('Acme');
    expect(slate.placementWeights?.['menu-bar']).toBe(0.5);
    expect(slate.prefsVersion).toBe(7);
    expect(slate.settingsVersion).toBe(3);
  });

  /**
   * "Nothing to show" is a legal answer, not a malformed slate — it is what /v1/ad returns for a
   * placement whose platform has not been released. While this was rejected, a client built for a
   * gated format threw on every poll and could never show an ad.
   */
  it('accepts an empty rotation', () => {
    const slate = AdSlateResponseSchema.parse(vector('slate-empty-rotation.json'));
    expect(slate.rotation).toEqual([]);
  });

  /**
   * The zero-bid house ad bills nobody and pays nothing, and AUCTION.md requires every surface to
   * say so. `unpaid` went undeclared for a long time, so zod stripped it and no client ever saw it.
   */
  it('carries the house ad\'s `unpaid` flag through', () => {
    const slate = AdSlateResponseSchema.parse(vector('slate-unpaid-house.json'));
    expect(slate.rotation[0]?.unpaid).toBe(true);
  });

  it('leaves the account side-channels absent on an anonymous slate', () => {
    const slate = AdSlateResponseSchema.parse(vector('slate-anonymous.json'));
    // Absent, not zero. A client that read these as 0 would think the account had version 0 of its
    // settings and re-apply them on every poll.
    expect(slate.prefsVersion).toBeUndefined();
    expect(slate.settingsVersion).toBeUndefined();
    expect(slate.placementWeights).toBeUndefined();
    expect(slate.rotation[0]?.unpaid).toBeUndefined();
  });

  it('holds the ad line to 3–60 characters at both ends', () => {
    const { shortest, longest } = vector('creative-line-bounds.json') as Record<string, unknown>;
    expect(CreativeSchema.parse(shortest).line).toHaveLength(3);
    expect(CreativeSchema.parse(longest).line).toHaveLength(60);
  });
});

describe('contract vectors — events', () => {
  /**
   * Every published extension build predates `platform` and `agent` and will never send them.
   * Those copies upgrade on their users' schedule, not ours, so making either required is an
   * instant outage for the installed fleet rather than a migration.
   */
  it('accepts an event with neither platform nor agent', () => {
    const event = AdEventSchema.parse(vector('event-minimal.json'));
    expect(event.platform).toBeUndefined();
    expect(event.agent).toBeUndefined();
    expect(event.visibleMs).toBeUndefined();
  });

  it('accepts a desktop event naming its platform and agent', () => {
    const event = AdEventSchema.parse(vector('event-desktop.json'));
    expect(event.platform).toBe('macos');
    expect(event.agent).toBe('claude-code');
    expect(event.placement).toBe('menu-bar');
    expect(event.visibleMs).toBe(5000);
  });

  it('accepts the batch envelope, which carries a device id and events and nothing else', () => {
    const batch = EventBatchSchema.parse(vector('event-batch.json'));
    expect(Object.keys(batch).sort()).toEqual(['deviceId', 'events']);
    expect(batch.events).toHaveLength(2);
  });

  /**
   * `visibleMs` must be OMITTED when unknown, never null — the schema takes a number or nothing,
   * so a client that helpfully serialised null would have every such event rejected. Both clients
   * omit the key; this is the assertion a JSON fixture cannot make on its own.
   */
  it('rejects a null visibleMs, which is why clients omit the key entirely', () => {
    const base = vector('event-minimal.json') as Record<string, unknown>;
    expect(() => AdEventSchema.parse({ ...base, visibleMs: null })).toThrow();
    expect(() => AdEventSchema.parse({ ...base })).not.toThrow();
  });
});

describe('contract vectors — killswitch', () => {
  it('decodes both states, with reason optional', () => {
    expect(KillswitchResponseSchema.parse(vector('killswitch-off.json')).killed).toBe(false);
    const on = KillswitchResponseSchema.parse(vector('killswitch-on.json'));
    expect(on.killed).toBe(true);
    expect(on.reason).toBe('Investigating a serving incident');
  });
});
