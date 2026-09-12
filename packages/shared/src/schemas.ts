import { z } from 'zod';
import { AD_CREATIVE } from './constants.js';

export const PlacementIdSchema = z.enum([
  'status-bar',
  'thinking-line',
  'terminal',
  'browser',
  'chat-banner',
  'menu-bar',
  'hud',
]);

/** Which client is reporting (see PlatformId in types.ts for why this is its own axis). */
export const PlatformIdSchema = z.enum(['vscode', 'macos', 'browser']);

/** The same list at runtime, for anything that must enumerate every platform - the per-platform
 *  killswitch board, say. Derived from the schema so a new platform cannot be added to one and
 *  forgotten in the other. */
export const PLATFORM_IDS = PlatformIdSchema.options;

/**
 * Which agent was thinking. Declared here rather than beside the recipe schemas that also use it,
 * because `AdEventSchema` below references it and a module-level const cannot be read before it is
 * declared. Keep it above the first use.
 */
export const AgentIdSchema = z.enum(['claude-code']);

/** The same list at runtime, for validating an id that arrived as a bare string (a hook's query
 *  parameter, say). Derived from the schema so the two cannot drift apart. */
export const AGENT_IDS = AgentIdSchema.options;

/** The subset of PlacementId a developer may set as their account-wide remote surface preference. */
export const RemoteSurfaceIdSchema = z.enum(['status-bar', 'thinking-line', 'chat-banner']);

export const RemoteSurfacePreferenceRequestSchema = z.object({
  surface: RemoteSurfaceIdSchema.nullable(),
});

/** Naming one linked machine, from the web. Trimmed, capped, and an empty name means "clear it" -
 *  the row then falls back to its id tail rather than showing a blank. */
export const DeviceLabelRequestSchema = z.object({
  label: z.string().trim().max(40).nullable().transform(v => (v === null || v === '' ? null : v)),
});

/** Coarse, privacy-safe reason a web-requested surface could not be applied on a device - stored and
 *  shown so the dashboard can replace an endless "confirm in your editor" with the real cause. Never a
 *  path, filename, or vendor identifier; the device maps its internal reasons down to this small set. */
export const SurfaceApplyFailureSchema = z.enum([
  'unsupported-build',    // a clean file, but this Claude Code build has no verified recipe / no target
  'foreign-conflict',     // another tool is holding Claude Code's files
  'health-check-failed',  // the patch applied but did not verify and was rolled back
  'settings-read-only',   // (terminal) ~/.claude/settings.json could not be written
  'error',                // anything else, kept coarse on purpose
]);

/** A device reporting the surface it ended up on, and - when a web-requested surface could not be
 *  applied - the coarse reason. `surface` is never null (a device always ends on SOME surface, the
 *  status bar at worst); `failure` is absent/null on success, so an older client that omits it reads
 *  as a success, unchanged. */
export const SurfaceAppliedRequestSchema = z.object({
  surface: RemoteSurfaceIdSchema,
  failure: SurfaceApplyFailureSchema.nullish(),
});

/** The terminal is additive, so it is its own on/off request rather than a fourth surface id.
 *  `null` releases it back to each device deciding locally. */
export const RemoteTerminalPreferenceRequestSchema = z.object({
  enabled: z.boolean().nullable(),
});

/** A device reporting what its terminal status line actually ended up as. Never null: a device only
 *  reports an outcome it reached, and "did nothing" is not one. */
export const TerminalAppliedRequestSchema = z.object({
  enabled: z.boolean(),
});

/** A device reporting its own "Control from web" opt-in state (whether it will auto-apply a web-set
 *  format without a local confirm). One boolean about this device; the web reads it, never sets it. */
export const AutoApplyReportSchema = z.object({
  enabled: z.boolean(),
});

/**
 * A patch to the account's ad-rendering preferences. Every field validates against the live
 * registry in adCustomization.ts rather than a hardcoded zod enum, so adding a spinner, glow theme,
 * or banner frame there is the only change needed - this schema picks it up with no edit of its own.
 */
/**
 * A patch of per-format customization, keyed `${format}.${element}` (see syncedSettings).
 *
 * Deliberately a loose record rather than an enumerated object: the valid pairs are declared once
 * in AD_FORMATS, and restating them here would be a second list to keep in step - the exact
 * duplication the per-format model exists to avoid. `sanitizePatch` is the authority and drops
 * anything unknown or unrenderable, so this only has to keep out values of an impossible TYPE.
 *
 * The four legacy account-wide keys are still accepted so an older web build can keep writing;
 * they are read as a seed and never written back.
 */
export const AdPreferencesRequestSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean()]),
);

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
  line: z.string().min(AD_CREATIVE.lineMin).max(AD_CREATIVE.lineMax),
  url: z.string().url().optional(),
  brand: z
    .object({
      name: z.string().optional(),
      iconUrl: z.string().url().optional(),
    })
    .optional(),
  // Must be declared here or zod strips it - the same trap as prefsVersion below. The server sets
  // `unpaid: true` on the zero-bid house fallback (auction/slate-builder.ts) and AUCTION.md requires
  // every surface to SAY that ad bills nobody and pays nothing rather than implying earnings. While
  // this key was undeclared, z.object() dropped it on the way in, so the client's `activeAdUnpaid`
  // was permanently false and that disclosure never rendered once.
  unpaid: z.boolean().optional(),
});

export const AdSlateResponseSchema = z.object({
  slateId: z.string().min(1),
  // NOT `.min(1)`. An empty rotation is a legitimate server answer meaning "nothing to show": it is
  // what /v1/ad returns for a placement whose platform has not been released yet (lib/placements.ts
  // GATED_PLACEMENTS). Requiring at least one creative made that response unparseable by any client
  // built on this schema - every poll would throw and the slate would never populate. The empty case
  // is already handled downstream: Rotation.next() returns undefined for an empty list.
  rotation: z.array(CreativeSchema),
  rotateEverySeconds: z.number().int().positive(),
  etag: z.string().min(1),
  killswitch: z.boolean(),
  placementWeights: z.record(z.string(), z.number()).optional(),
  // Must be declared here or zod strips it: plain z.object() drops unknown keys, so an undeclared
  // field silently never reaches the client and the settings fast-path would quietly do nothing.
  prefsVersion: z.number().int().nonnegative().optional(),
  settingsVersion: z.number().int().nonnegative().optional(),
});

export const AdEventSchema = z.object({
  eventId: z.string().uuid(),
  type: AdEventTypeSchema,
  adId: z.string().min(1),
  slateId: z.string().min(1),
  placement: PlacementIdSchema,
  occurredAtClientMs: z.number().int().positive(),
  visibleMs: z.number().int().nonnegative().optional(),
  // Coarse closed enums, never content. OPTIONAL on purpose and permanently so: already-published
  // extension builds never send them, and a required field would reject the installed fleet's
  // events outright. See the AdEvent interface in types.ts.
  platform: PlatformIdSchema.optional(),
  agent: AgentIdSchema.optional(),
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

/**
 * What a client tells `/v1/killswitch` about itself, so the answer can be scoped to its platform.
 *
 * The scope travels as a REQUEST parameter, and the response shape above is deliberately untouched.
 * The obvious alternative - adding a `platforms: string[]` to the response - is unshippable here:
 * every published build upgrades on its users' schedule, so a client older than the field would
 * ignore the array, read `killed: false`, and a kill aimed at one platform would never reach the
 * fleet it was aimed at. A parameter degrades the other way. An old client sends nothing and gets
 * the GLOBAL answer, which is the only thing it ever understood.
 *
 * Optional, and permanently so, for that same reason.
 */
export const KillswitchQuerySchema = z.object({
  platform: PlatformIdSchema.optional(),
});

export const GetAdQuerySchema = z.object({
  placement: PlacementIdSchema,
  hints: z.string().optional(),
  // Which client is asking, so a platform-scoped kill can be enforced server-side rather than
  // trusted to the client that may be the thing being killed. Advisory only: for a linked device the
  // server prefers the platform stamped on its device token, which the client cannot rewrite. This
  // is the fallback for anonymous, pre-link requests. Optional permanently (published fleet).
  platform: PlatformIdSchema.optional(),
});

export type PlacementIdInput = z.input<typeof PlacementIdSchema>;
export type AdEventTypeInput = z.input<typeof AdEventTypeSchema>;
export type CreativeInput = z.input<typeof CreativeSchema>;
export type AdSlateResponseInput = z.input<typeof AdSlateResponseSchema>;
export type AdEventInput = z.input<typeof AdEventSchema>;
export type EventBatchInput = z.input<typeof EventBatchSchema>;
export type EventBatchAckInput = z.input<typeof EventBatchAckSchema>;
export type KillswitchResponseInput = z.input<typeof KillswitchResponseSchema>;
export type KillswitchQueryInput = z.input<typeof KillswitchQuerySchema>;
export type GetAdQueryInput = z.input<typeof GetAdQuerySchema>;

// ── Campaign CRUD ──────────────────────────────────────────────────────────────

/**
 * An image the advertiser UPLOADED, as a `data:` URI (what `POST /v1/logo` hands back). The server
 * re-processes whatever arrives here, so a hand-crafted payload cannot smuggle bytes into an ad.
 * `null` means "remove the logo". Cap is generous: it is a source image, not what we ship.
 */
const uploadedIcon = z.string().startsWith('data:', 'Not an image').max(8_000_000);

/**
 * A URL we are willing to store, hand to a browser, or fetch.
 *
 * `z.string().url()` is NOT that check. Zod delegates to `new URL()`, which happily accepts
 * `javascript:alert(1)`, `data:text/html,...` and `file:///etc/passwd` - every one of them a valid
 * URL and none of them something an advertiser should be able to put in front of a developer or
 * point our server at. The scheme is the whole security boundary here, so it is asserted explicitly.
 */
export const httpUrl = (message = 'Must be a full URL, starting with https://') =>
  z
    .string()
    .url(message)
    .refine(v => {
      try {
        const p = new URL(v).protocol;
        return p === 'https:' || p === 'http:';
      } catch {
        return false;
      }
    }, message);

/**
 * Reading a site's own metadata so an advertiser does not have to retype it.
 *
 * The URL is the advertiser's landing page. Everything in the result is a SUGGESTION the advertiser
 * edits - nothing here is authoritative, and any field the page did not offer simply comes back
 * absent rather than guessed.
 */
export const SitePrefillRequestSchema = z.object({
  url: httpUrl('Enter a full URL, starting with https://'),
});

export const SitePrefillResultSchema = z.object({
  /** The URL we actually ended up at, after redirects. Apex -> www is the common case. */
  finalUrl: z.string(),
  /** A suggested ad line, already cut to the 60-character contract. */
  line: z.string().max(AD_CREATIVE.lineMax).optional(),
  /** og:site_name, or the site's title with any trailing tagline removed. */
  brandName: z.string().max(AD_CREATIVE.brandNameMax).optional(),
  /**
   * The site's icon, ALREADY downloaded and processed into the same bounded WebP `data:` URI a
   * logo upload produces. Never a remote URL: a developer's editor must never fetch from an
   * advertiser's server (PRIVACY.md), and the webview CSP would block it anyway.
   */
  brandIconData: z.string().startsWith('data:').optional(),
  /** What we could not find, so the form can say so instead of silently leaving gaps. */
  missing: z.array(z.enum(['line', 'brandName', 'brandIconData'])),
});

export const CreateCampaignSchema = z.object({
  line: z
    .string()
    .min(AD_CREATIVE.lineMin, `At least ${AD_CREATIVE.lineMin} characters`)
    .max(AD_CREATIVE.lineMax, `At most ${AD_CREATIVE.lineMax} characters`),
  url: httpUrl('Must be a valid URL').optional(),
  brandName: z.string().max(AD_CREATIVE.brandNameMax).optional(),
  brandIconUrl: httpUrl('Must be a valid URL').optional(),
  brandIconData: uploadedIcon.optional(),
  bidCpm: z.number().positive().min(0.01, 'Minimum bid is $0.01'),
  dailyBudget: z.number().positive().min(1, 'Minimum budget is $1.00'),
  // Optional lifetime cap. Absent means "no cap" (paces daily, runs until the wallet is empty). When
  // set, the daily-vs-total and total-vs-unassigned-wallet rules are enforced in the route (which has
  // the wallet + the advertiser's other campaigns to check against).
  totalBudget: z.number().positive().min(1, 'Minimum total budget is $1.00').optional(),
});

export const UpdateCampaignSchema = z.object({
  line: z.string().min(AD_CREATIVE.lineMin).max(AD_CREATIVE.lineMax).optional(),
  url: httpUrl().nullable().optional(),
  brandName: z.string().max(AD_CREATIVE.brandNameMax).nullable().optional(),
  brandIconUrl: httpUrl().nullable().optional(),
  brandIconData: uploadedIcon.nullable().optional(),
  bidCpm: z.number().positive().min(0.01).optional(),
  dailyBudget: z.number().positive().min(1).optional(),
  // `null` clears the cap back to "no cap"; a number sets/changes it.
  totalBudget: z.number().positive().min(1).nullable().optional(),
  status: z.enum(['paused', 'draft', 'live']).optional(),
});

/**
 * House ads play by one different rule: a $0 bid is legitimate.
 *
 * For a real advertiser a $0 bid is just a confusing way to pause, so UpdateCampaignSchema floors it
 * at $0.01. A house ad may sit at $0 for exactly one reason: it takes the ad OUT OF THE AUCTION
 * while leaving the row editable. The seeded fallback creative is genuinely $0, and a paid house ad
 * has to be able to return to $0 without being deleted (there is no delete).
 *
 * $0 is NOT "filler that shows when nothing else wins", and this comment used to say it was. The
 * draw is weighted by bid, so a weight of zero is drawn NEVER: the ad does not serve, pays no
 * developer, and looks perfectly healthy while doing neither. An operator read the old wording,
 * set $0 to slow the subsidy burn, and every developer's earnings stopped for eleven hours. The one
 * creative that really does show when nothing wins is the seeded fallback, and it gets there by
 * bypassing the auction entirely rather than by bidding zero.
 */
export const UpdateHouseAdSchema = UpdateCampaignSchema.extend({
  bidCpm: z.number().min(0).optional(),
});

export type CreateCampaignInputZod = z.infer<typeof CreateCampaignSchema>;
export type UpdateCampaignInputZod = z.infer<typeof UpdateCampaignSchema>;

// ── Recipe delivery (patch mode) ────────────────────────────────────────────────

// AgentIdSchema is declared at the top of this file (AdEventSchema needs it before this point).
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

/* ── Docs feedback ──────────────────────────────────────────────────────────── */

export const DocFeedbackKindSchema = z.enum(['helpful', 'unhelpful', 'outdated']);

/**
 * A reader marking a docs page. Anonymous by construction: the request carries the page, the kind
 * and an optional note - no account, no device, no address. The slug charset is pinned so the table
 * can only ever contain plausible page names, whatever the client sends.
 */
export const DocFeedbackRequestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,64}$/),
  kind: DocFeedbackKindSchema,
  note: z.string().trim().min(1).max(500).optional(),
});

export type DocFeedbackKindInput = z.input<typeof DocFeedbackKindSchema>;
export type DocFeedbackRequestInput = z.input<typeof DocFeedbackRequestSchema>;

/**
 * The device-link handshake (VS Code extension <-> server). The extension registers a random
 * `state` nonce, opens the web SPA's /link page, and polls until the browser approves. BOTH the
 * start body and the poll query carry ONLY that nonce - never a name, an email, or any content.
 * Shared so the client, the server, and the egress whitelist test all pin one shape: the same
 * discipline the ad/event/patch payloads follow, extended to the sign-in flow.
 */
export const DeviceLinkStartRequestSchema = z.object({ state: z.string().uuid() });
export const DeviceLinkPollQuerySchema = z.object({ state: z.string().uuid() });
