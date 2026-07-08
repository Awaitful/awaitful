import { describe, expect, it } from 'vitest';
import {
  AdEventSchema,
  AdSlateResponseSchema,
  EventBatchSchema,
  GetAdQuerySchema,
  KillswitchResponseSchema,
  PlacementIdSchema,
  RecipeResponseSchema,
  PatchReportRequestSchema,
  GetRecipeQuerySchema,
} from '../schemas.js';
import { DEFAULTS } from '../constants.js';

describe('PlacementIdSchema', () => {
  it('accepts valid placement ids', () => {
    const valid = ['status-bar', 'thinking-line', 'terminal', 'browser'] as const;
    for (const id of valid) {
      expect(PlacementIdSchema.parse(id)).toBe(id);
    }
  });

  it('rejects unknown placement id', () => {
    expect(() => PlacementIdSchema.parse('unknown')).toThrow();
  });
});

describe('AdSlateResponseSchema', () => {
  const validSlate = {
    slateId: 'slate-1',
    rotation: [
      {
        adId: 'ad-1',
        campaignId: 'camp-1',
        line: 'Try our amazing product',
      },
    ],
    rotateEverySeconds: 30,
    etag: 'abc123',
    killswitch: false,
  };

  it('accepts a valid slate', () => {
    expect(() => AdSlateResponseSchema.parse(validSlate)).not.toThrow();
  });

  it('rejects a creative with line shorter than 3 chars', () => {
    const bad = { ...validSlate, rotation: [{ adId: 'a', campaignId: 'b', line: 'Hi' }] };
    expect(() => AdSlateResponseSchema.parse(bad)).toThrow();
  });

  it('rejects a creative with line longer than 60 chars', () => {
    const bad = {
      ...validSlate,
      rotation: [{ adId: 'a', campaignId: 'b', line: 'A'.repeat(61) }],
    };
    expect(() => AdSlateResponseSchema.parse(bad)).toThrow();
  });

  it('rejects empty rotation', () => {
    expect(() => AdSlateResponseSchema.parse({ ...validSlate, rotation: [] })).toThrow();
  });
});

describe('AdEventSchema', () => {
  const validEvent = {
    eventId: '550e8400-e29b-41d4-a716-446655440000',
    type: 'view_threshold_met',
    adId: 'ad-1',
    slateId: 'slate-1',
    placement: 'status-bar',
    occurredAtClientMs: Date.now(),
    visibleMs: 5000,
  };

  it('accepts a valid billable event', () => {
    expect(() => AdEventSchema.parse(validEvent)).not.toThrow();
  });

  it('requires eventId to be a uuid', () => {
    expect(() => AdEventSchema.parse({ ...validEvent, eventId: 'not-a-uuid' })).toThrow();
  });

  it('accepts all defined event types', () => {
    const types = [
      'impression_rendered',
      'impression_viewable',
      'view_tick',
      'view_threshold_met',
      'click',
      'error_impression',
    ] as const;
    for (const type of types) {
      expect(() => AdEventSchema.parse({ ...validEvent, type })).not.toThrow();
    }
  });

  it('rejects unknown event type', () => {
    expect(() => AdEventSchema.parse({ ...validEvent, type: 'phantom_billing' })).toThrow();
  });

  it('accepts event without optional visibleMs', () => {
    const { visibleMs: _, ...noVisible } = validEvent;
    expect(() => AdEventSchema.parse(noVisible)).not.toThrow();
  });
});

describe('EventBatchSchema', () => {
  const validEvent = {
    eventId: '550e8400-e29b-41d4-a716-446655440000',
    type: 'view_threshold_met' as const,
    adId: 'ad-1',
    slateId: 'slate-1',
    placement: 'status-bar' as const,
    occurredAtClientMs: Date.now(),
  };

  it('accepts a valid batch', () => {
    const batch = { deviceId: 'device-abc', events: [validEvent] };
    expect(() => EventBatchSchema.parse(batch)).not.toThrow();
  });

  it('rejects empty events array', () => {
    expect(() => EventBatchSchema.parse({ deviceId: 'dev', events: [] })).toThrow();
  });

  it('rejects batches over 100 events', () => {
    const manyEvents = Array.from({ length: 101 }, (_, i) => ({
      ...validEvent,
      eventId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`,
    }));
    expect(() => EventBatchSchema.parse({ deviceId: 'dev', events: manyEvents })).toThrow();
  });
});

describe('KillswitchResponseSchema', () => {
  it('accepts killed with reason', () => {
    expect(() =>
      KillswitchResponseSchema.parse({ killed: true, reason: 'maintenance' }),
    ).not.toThrow();
  });

  it('accepts not-killed without reason', () => {
    expect(() => KillswitchResponseSchema.parse({ killed: false })).not.toThrow();
  });
});

describe('GetAdQuerySchema', () => {
  it('requires placement', () => {
    expect(() => GetAdQuerySchema.parse({ placement: 'status-bar' })).not.toThrow();
    expect(() => GetAdQuerySchema.parse({})).toThrow();
  });

  it('accepts optional hints', () => {
    expect(() =>
      GetAdQuerySchema.parse({ placement: 'status-bar', hints: 'hour=14' }),
    ).not.toThrow();
  });
});

describe('DEFAULTS', () => {
  it('has the correct viewThresholdSeconds', () => {
    expect(DEFAULTS.viewThresholdSeconds).toBe(5);
  });

  it('has the correct clickMultiplier', () => {
    expect(DEFAULTS.clickMultiplier).toBe(50);
  });

  it('enforces minPollSeconds to prevent bot rejection', () => {
    expect(DEFAULTS.minPollSeconds).toBeGreaterThan(0);
  });
});

describe('Recipe delivery schemas', () => {
  const hash = 'a'.repeat(64);
  const recipe = {
    agent: 'claude-code', buildId: 'anthropic.claude-code-2.1.200-darwin-x64', version: '2.1.200',
    confidence: 0.6, status: 'verified',
    targets: [
      { file: 'webview/index.js', strategy: 'append-shim', pristineSha256: hash },
      { file: 'extension.js', strategy: 'csp-insert', pristineSha256: 'b'.repeat(64) },
    ],
  };

  it('accepts a well-formed RecipeResponse', () => {
    expect(RecipeResponseSchema.parse(recipe).confidence).toBe(0.6);
  });

  it('rejects a bad hash length and out-of-range confidence', () => {
    expect(() => RecipeResponseSchema.parse({ ...recipe, targets: [{ ...recipe.targets[0], pristineSha256: 'abc' }, recipe.targets[1]] })).toThrow();
    expect(() => RecipeResponseSchema.parse({ ...recipe, confidence: 2 })).toThrow();
  });

  it('validates the recipe query and the report payload', () => {
    expect(GetRecipeQuerySchema.parse({ agent: 'claude-code', build: 'x' }).build).toBe('x');
    const report = { agent: 'claude-code', buildId: 'x', version: '1', webSha256: hash, extSha256: 'b'.repeat(64), clean: true, outcome: 'self-activated' };
    expect(PatchReportRequestSchema.parse(report).clean).toBe(true);
    expect(() => PatchReportRequestSchema.parse({ ...report, outcome: 'bogus' })).toThrow();
    expect(() => PatchReportRequestSchema.parse({ ...report, webSha256: 'short' })).toThrow();
  });
});
