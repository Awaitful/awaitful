import { z } from 'zod';

export const PlacementIdSchema = z.enum(['status-bar', 'thinking-line', 'terminal', 'browser', 'chat-banner']);

export const AdEventTypeSchema = z.enum([
  'impression_rendered',
  'impression_viewable',
  'view_tick',
  'view_threshold_met',
  'click',
  'error_impression',
]);

export const CreativeSchema = z.object({
  adId: z.string().min(1),
  campaignId: z.string().min(1),
  line: z.string().min(3).max(60),
  url: z.string().url().optional(),
  brand: z
    .object({
      name: z.string().optional(),
      iconUrl: z.string().url().optional(),
    })
    .optional(),
});

export const AdSlateResponseSchema = z.object({
  slateId: z.string().min(1),
  rotation: z.array(CreativeSchema).min(1),
  rotateEverySeconds: z.number().int().positive(),
  etag: z.string().min(1),
  killswitch: z.boolean(),
  placementWeights: z.record(z.string(), z.number()).optional(),
});

export const AdEventSchema = z.object({
  eventId: z.string().uuid(),
  type: AdEventTypeSchema,
  adId: z.string().min(1),
  slateId: z.string().min(1),
  placement: PlacementIdSchema,
  occurredAtClientMs: z.number().int().positive(),
  visibleMs: z.number().int().nonnegative().optional(),
});

export const EventBatchSchema = z.object({
  deviceId: z.string().min(1),
  events: z.array(AdEventSchema).min(1).max(100),
});

export const EventBatchAckSchema = z.object({
  received: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});

export const KillswitchResponseSchema = z.object({
  killed: z.boolean(),
  reason: z.string().optional(),
});

export const GetAdQuerySchema = z.object({
  placement: PlacementIdSchema,
  hints: z.string().optional(),
});

export type PlacementIdInput = z.input<typeof PlacementIdSchema>;
export type AdEventTypeInput = z.input<typeof AdEventTypeSchema>;
export type CreativeInput = z.input<typeof CreativeSchema>;
export type AdSlateResponseInput = z.input<typeof AdSlateResponseSchema>;
export type AdEventInput = z.input<typeof AdEventSchema>;
export type EventBatchInput = z.input<typeof EventBatchSchema>;
export type EventBatchAckInput = z.input<typeof EventBatchAckSchema>;
export type KillswitchResponseInput = z.input<typeof KillswitchResponseSchema>;
export type GetAdQueryInput = z.input<typeof GetAdQuerySchema>;

// ── Campaign CRUD ──────────────────────────────────────────────────────────────

export const CreateCampaignSchema = z.object({
  line: z.string().min(3, 'At least 3 characters').max(60, 'At most 60 characters'),
  url: z.string().url('Must be a valid URL').optional(),
  brandName: z.string().max(40).optional(),
  brandIconUrl: z.string().url('Must be a valid URL').optional(),
  bidCpm: z.number().positive().min(0.01, 'Minimum bid is $0.01'),
  dailyBudget: z.number().positive().min(1, 'Minimum budget is $1.00'),
});

export const UpdateCampaignSchema = z.object({
  line: z.string().min(3).max(60).optional(),
  url: z.string().url().nullable().optional(),
  brandName: z.string().max(40).nullable().optional(),
  brandIconUrl: z.string().url().nullable().optional(),
  bidCpm: z.number().positive().min(0.01).optional(),
  dailyBudget: z.number().positive().min(1).optional(),
  status: z.enum(['paused', 'draft', 'live']).optional(),
});

export type CreateCampaignInputZod = z.infer<typeof CreateCampaignSchema>;
export type UpdateCampaignInputZod = z.infer<typeof UpdateCampaignSchema>;

// ── Recipe delivery (patch mode) ────────────────────────────────────────────────

export const AgentIdSchema = z.enum(['claude-code']);
export const PatchStrategyIdSchema = z.enum(['append-shim', 'csp-insert']);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-char hex sha256');

export const RecipeTargetHashSchema = z.object({
  file: z.string().min(1),
  strategy: PatchStrategyIdSchema,
  pristineSha256: Sha256Schema,
});

export const RecipeResponseSchema = z.object({
  agent: AgentIdSchema,
  buildId: z.string().min(1),
  version: z.string().min(1),
  confidence: z.number().min(0).max(1),
  status: z.enum(['verified', 'provisional']),
  selectors: z.array(z.string().min(1)).optional(),
  targets: z.array(RecipeTargetHashSchema).min(1),
});

export const RecipeChannelSchema = z.enum(['stable', 'canary']);

export const GetRecipeQuerySchema = z.object({
  agent: AgentIdSchema,
  build: z.string().min(1),
  // Which rollout channel to serve. Absent = 'stable' (broad fleet). A canary-opted client asks
  // for 'canary' and receives a canary-staged recipe too; canary recipes stay invisible to stable.
  channel: RecipeChannelSchema.optional(),
});

export const PatchOutcomeSchema = z.enum([
  'unknown-build', 'self-activated', 'applied', 'apply-failed', 'conflict', 'restored',
]);

export const PatchReportRequestSchema = z.object({
  agent: AgentIdSchema,
  buildId: z.string().min(1),
  version: z.string().min(1),
  webSha256: Sha256Schema,
  extSha256: Sha256Schema,
  clean: z.boolean(),
  outcome: PatchOutcomeSchema,
});

export type RecipeResponseInput = z.input<typeof RecipeResponseSchema>;
export type GetRecipeQueryInput = z.input<typeof GetRecipeQuerySchema>;
export type PatchReportRequestInput = z.input<typeof PatchReportRequestSchema>;
