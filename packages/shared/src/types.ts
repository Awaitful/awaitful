export type PlacementId = 'status-bar' | 'thinking-line' | 'terminal' | 'browser' | 'chat-banner';

export type AdEventType =
  | 'impression_rendered'
  | 'impression_viewable'
  | 'view_tick'
  | 'view_threshold_met'
  | 'click'
  | 'error_impression';

export interface Creative {
  adId: string;
  campaignId: string;
  line: string;
  url?: string;
  /**
   * True on the zero-bid house fallback, which serves only when NOTHING is eligible for the paid
   * draw: it bills nobody and pays nothing, and every client surface must SAY so rather than
   * implying earnings. The server states the fact; clients only render it. Absent on every
   * creative that entered the draw.
   */
  unpaid?: boolean;
  brand?: {
    name?: string;
    iconUrl?: string;
  };
}

export interface AdSlateResponse {
  slateId: string;
  rotation: Creative[];
  rotateEverySeconds: number;
  etag: string;
  killswitch: boolean;
  /**
   * Relative earning weight per placement from the active rate card
   * (e.g. { 'status-bar': 0.4, 'thinking-line': 1.0 }). Lets clients show
   * honest "earns N× the default" comparisons without a separate endpoint.
   */
  placementWeights?: Record<string, number>;
  /**
   * The account's synced-settings version. Carried on the slate because the device already polls it
   * every 60s with its token - so settings reach an editor within a minute rather than five, with
   * no new request and nothing new leaving the machine. The device compares it against the last
   * version it applied and fetches /v1/me only when they differ.
   *
   * Absent for an anonymous slate (no account to have settings).
   */
  prefsVersion?: number;
  /**
   * A separate monotonic version bumped when the SURFACE/TERMINAL preference changes (the file-touching
   * pushes). Rides the same slate so a device notices a format change within one poll, without touching
   * the prefsVersion styling ratchet. Absent for an anonymous slate.
   */
  settingsVersion?: number;
}

export interface AdEvent {
  eventId: string;
  type: AdEventType;
  adId: string;
  slateId: string;
  placement: PlacementId;
  occurredAtClientMs: number;
  visibleMs?: number;
}

export interface EventBatch {
  deviceId: string;
  events: AdEvent[];
}

export interface EventBatchAck {
  received: number;
  accepted: number;
  duplicates: number;
}

export interface KillswitchResponse {
  killed: boolean;
  reason?: string;
}

export type CampaignStatus = 'draft' | 'live' | 'paused' | 'exhausted' | 'rejected';

export type ModerationStatus = 'pending' | 'approved' | 'rejected';

export type LedgerKind =
  | 'ad_charge'
  | 'dev_earning'
  | 'platform_fee'
  | 'payout'
  | 'funding'
  | 'adjustment';

export type StatusBarState =
  | 'signin'
  | 'earning'
  | 'off'
  // No coding agent found on this machine, so no thinking event can fire and no surface can earn.
  | 'no-agent'
  | 'offline'
  | 'killed'
  | 'reload-to-earn';

export type CapKind = 'hourly' | 'daily';

export interface CapPill {
  kind: CapKind;
  resetAtMs: number;
}

export interface PlacementProvider {
  id: PlacementId;
  requiresConsent: boolean;
  detect(): Promise<Availability>;
  activate(ctx: PlacementContext): Promise<void>;
  deactivate(): Promise<void>;
}

export type AvailabilityStatus = 'available' | 'unavailable' | 'requires-consent';

export interface Availability {
  status: AvailabilityStatus;
  reason?: string;
}

export interface PlacementContext {
  show(creative: Creative): void;
  hide(): void;
  report(event: Pick<AdEvent, 'type' | 'adId' | 'slateId' | 'visibleMs'>): void;
}

export type SSEEventType = 'slate_refresh' | 'killswitch' | 'recipe_update' | 'impression_stats' | 'market_event';

export interface SSEEvent {
  type: SSEEventType;
  payload?: unknown;
}

// ── Recipe delivery (patch mode) ────────────────────────────────────────────────
// The agent whose editor Awaitful can patch. Agent-agnostic by design — the union grows
// as we add targets (e.g. 'codex'); the recipe/consensus machinery never changes, only a
// new per-agent target-detector + embedded shim is registered client-side.
export type AgentId = 'claude-code';

export type PatchStrategyId = 'append-shim' | 'csp-insert';

// Data-only per-target payload: the server ships the pristine hash + strategy, NEVER the
// executable shim (that stays embedded in the source-available client — "read what runs").
export interface RecipeTargetHash {
  file: string;
  strategy: PatchStrategyId;
  pristineSha256: string;
}

// What GET /v1/recipe returns for a build. Data only; the client assembles the full recipe
// from its embedded shim/CSP + these hashes and re-verifies every hash byte-for-byte.
export interface RecipeResponse {
  agent: AgentId;
  buildId: string;
  version: string;
  confidence: number;                  // 0..1 (from consensus device count, or 1 for admin)
  status: 'verified' | 'provisional';  // only 'verified' is ever served to the fleet
  selectors?: string[];                // optional server-hot-fixable detection selectors
  targets: RecipeTargetHash[];
}

// The client reports what it observed so the server can learn a build's pristine hashes by
// consensus. `clean` = the hashed file carried no Awaitful and no detected foreign marker —
// only clean reports vote; non-clean reports are retained as competitor-presence signal.
export type PatchOutcome =
  | 'unknown-build' | 'self-activated' | 'applied' | 'apply-failed' | 'conflict' | 'restored';

export interface PatchReportRequest {
  agent: AgentId;
  buildId: string;
  version: string;
  webSha256: string;
  extSha256: string;
  clean: boolean;
  outcome: PatchOutcome;
}

/** SSE `recipe_update` payload — nudges clients on that build to re-fetch. */
export interface RecipeUpdatePayload {
  agent: AgentId;
  buildId: string;
}

// ── Live stats ─────────────────────────────────────────────────────────────────

export interface ImpressionStat {
  placement: string;
  impsPerMin: number;  // rolling average over the last 2 complete minutes
}

// ── Market view ────────────────────────────────────────────────────────────────

export interface CampaignMarketData {
  campaignId: string;
  rank: number;              // 1 = highest bidder
  totalBidders: number;
  topBidCpm: string;         // the highest bid in the live auction
  impsPerMin: number;        // this campaign's impression delivery rate
  suggestedBidCpm: string | null;  // bid needed to reach #1 (null if already there)
}

// ── Earnings ───────────────────────────────────────────────────────────────────

/**
 * One row in the earnings history. Sourced from AdEventLog, not LedgerEntry - a house ad or an
 * over-cap event never gets a ledger row (it bills nobody), but it genuinely rendered on the
 * developer's machine and belongs in the list all the same, honestly marked `paid: false`.
 */
export interface EarningEntry {
  /** The underlying ad event's id. No longer a ledger-entry id - a $0 row has no ledger entry to
   *  key off, so the event itself (unique per view/click) is the only stable id every row has. */
  id: string;
  placement: string | null;
  createdAt: string;
  /** 'view' = a verified view (view_threshold_met); 'click' = a click on the line. */
  type: 'view' | 'click';
  /** Always present, '0.000000' when unpaid - never omitted, never a lie. */
  amountUsd: string;
  /** False for a house ad, an over-cap event, or any other reason the view rendered but did not
   *  bill (docs: "Shown but not credited"). */
  paid: boolean;
  /** Milliseconds the line was visible for this event. Null when not tracked (e.g. a click). */
  visibleMs: number | null;
  /** The sponsored line's own text, as shown. Null if the creative could not be resolved. */
  line: string | null;
  /** The advertiser's brand name, if the creative carries one. */
  brandName: string | null;
}

export interface EarningsByPlacement {
  placement: string;
  totalUsd: string;
  /** Lifetime verified billable views (view_threshold_met) served on this surface. */
  impressions: number;
  /** Lifetime clicks on ads shown on this surface. */
  clicks: number;
}

export interface EarningsSummary {
  todayUsd: string;
  lifetimeUsd: string;
  /**
   * Earned but not yet paid out: dev_earning credits minus payout debits and clawbacks. Exactly
   * `availableUsd + pendingUsd`. This is the headline "your money" figure. It is NOT all withdrawable
   * today, because recently-earned money is still clearing the holdback.
   */
  unredeemedUsd: string;
  /**
   * Withdrawable RIGHT NOW: the portion of `unredeemedUsd` that has cleared the holdback. This is the
   * exact figure the payout gate checks, so a withdrawal can never exceed it. Always >= 0.
   */
  availableUsd: string;
  /**
   * Earned but still inside the holdback window, so not yet withdrawable. Ages into `availableUsd`.
   * Equals `unredeemedUsd - availableUsd`.
   */
  pendingUsd: string;
  /** Lifetime verified billable views (view_threshold_met) across all surfaces. */
  impressions: number;
  /** Lifetime clicks on ads you showed. */
  clicks: number;
  /** Current run of consecutive UTC days with earnings (1-day grace: counts if you earned today or yesterday). */
  streakDays: number;
  byPlacement: EarningsByPlacement[];
  recent: EarningEntry[];
  /** Current rate-card weight per placement (e.g. thinking-line: 0.8), so the web can show real
   *  "N× earnings" labels without a 4th ad-serving-shaped endpoint. Same shape as
   *  `AdSlateResponse.placementWeights`. Optional only for response-shape symmetry with that type. */
  placementWeights?: Record<string, number>;
  /** The placement of the account's single most recent ad event, billed or not. Unlike `recent`
   *  (ledger-derived, so a $0 house ad never appears in it - a quiet market or deliberate house-ad
   *  testing would leave it stuck on stale data), this reads AdEventLog directly, so it reflects
   *  which surface is genuinely active right now even when nothing is billing. `null` if the account
   *  has never served an event. */
  lastActivePlacement: string | null;
  /**
   * The per-account daily earning cap and today's position against it (FINANCE.md §6). A published,
   * deterministic cap is a RULE, not silent confiscation - so the developer sees it. Beyond the cap
   * the day's further views stop earning (the advertiser is still billed).
   */
  dailyCapUsd: string;
  dailyEarnedUsd: string;
  /** True when the account is under review and cannot withdraw (still accrues). Surfaced with a reason. */
  frozen: boolean;
}

export interface EarningsChartPoint {
  date: string;
  amountUsd: string;
}

export interface EarningsChart {
  points: EarningsChartPoint[];
  period: '7d' | '30d';
}

// Advertiser performance over time — one point per UTC day. Impressions are verified
// billable views (view_threshold_met); clicks are click events. Both are returned so the
// dashboard can switch metric without a refetch.
export interface PerformanceChartPoint {
  date: string;        // yyyy-mm-dd (UTC day)
  impressions: number;
  clicks: number;
}

export interface PerformanceChart {
  points: PerformanceChartPoint[];
  period: '7d' | '30d';
}

// ── Campaign CRUD ──────────────────────────────────────────────────────────────

export interface CampaignCreative {
  id: string;
  line: string;
  url?: string;
  brandName?: string;
  /** Where the logo came from, if it was linked. Empty when the advertiser uploaded a file instead. */
  brandIconUrl?: string;
  /**
   * The logo bytes we actually ship: downscaled, re-encoded, inlined as a `data:` URI. This is what
   * renders in the ad line, so this - never the URL - is what the edit screen must preview.
   */
  brandIconData?: string;
  moderation: ModerationStatus;
}

export interface CampaignByPlacement {
  /** The surface the ad ran on (status-bar, thinking-line, terminal, browser, chat-banner). */
  placement: string;
  /** Verified billable views (view_threshold_met) for this campaign on this surface. */
  impressions: number;
  /** Clicks for this campaign on this surface. */
  clicks: number;
}

export interface CampaignWithCreative {
  id: string;
  status: CampaignStatus;
  bidCpm: string;
  dailyBudget: string;
  /** Optional lifetime cap. `null` means no cap - the ad paces daily until the wallet runs out. */
  totalBudget: string | null;
  spent: string;
  createdAt: string;
  creative: CampaignCreative | null;
  /** Lifetime verified billable views (view_threshold_met events) for this campaign. */
  impressions: number;
  /** Lifetime clicks for this campaign. */
  clicks: number;
  /** Per-surface breakdown of this campaign's lifetime impressions + clicks, busiest surface first. */
  byPlacement: CampaignByPlacement[];
}

export interface CreateCampaignInput {
  line: string;
  url?: string;
  brandName?: string;
  /** A logo to fetch and downscale. Mutually exclusive with `brandIconData`; the upload wins. */
  brandIconUrl?: string;
  /** An uploaded logo (from `POST /v1/logo`). The server re-processes it before it is stored. */
  brandIconData?: string;
  bidCpm: number;
  dailyBudget: number;
  /** Optional lifetime cap. Omit for no cap. */
  totalBudget?: number;
}

/** What a site told us about itself, so the advertiser edits instead of retypes. */
export interface SitePrefillResult {
  finalUrl: string;
  line?: string;
  brandName?: string;
  /** Already-processed WebP `data:` URI, identical in shape to an uploaded logo. Never a remote URL. */
  brandIconData?: string;
  missing: Array<'line' | 'brandName' | 'brandIconData'>;
}

export interface UpdateCampaignInput {
  line?: string;
  url?: string | null;
  brandName?: string | null;
  brandIconUrl?: string | null;
  /** An uploaded logo. `null` removes the logo entirely. */
  brandIconData?: string | null;
  bidCpm?: number;
  dailyBudget?: number;
  /** `null` clears the cap back to "no cap". */
  totalBudget?: number | null;
  status?: 'paused' | 'draft' | 'live';
}

// ── Rate card ─────────────────────────────────────────────────────────────────

export interface RateCardData {
  id: string;
  devSharePct: number;           // e.g. 0.70 → developer gets 70% of each charge
  clickMultiplier: number;       // click charge = impression charge × this factor
  weights: Record<string, number>; // placement id → weight factor (e.g. thinking-line: 1.0)
  minBidCpm: number;
  hourlyCapUsd: number;          // max developer earnings per device per hour
  dailyCapUsd: number;           // max developer earnings per device per day
}

// ── Wallet & payments ─────────────────────────────────────────────────────────

export interface WalletBalance {
  availableUsd: string; // spendable prepaid ad balance (kind-scoped; no separate reserved/total)
}

export interface PayoutOption {
  providerId: string;
  displayName: string;
  grossUsd: string;
  /** What the developer actually receives. Equals grossUsd when the platform absorbs the provider fee. */
  netUsd: string;
  /** The provider's per-payout fee. Shown for transparency; NOT deducted from the developer when the
   *  platform bears it. */
  feeUsd: string;
  /** Who pays that fee: 'platform' (Awaitful absorbs it, developer gets the full amount) or 'developer'
   *  (netted from the payout). Stripe is platform-borne today; the field lets a future rail differ. */
  feeBearer: 'platform' | 'developer';
  feeDescription: string;
  isConnected: boolean;
}

// ── Admin ──────────────────────────────────────────────────────────────────────

export type UserRole = 'advertiser' | 'developer' | 'admin';

/**
 * The three primary, mutually-exclusive VS Code surfaces a developer can set as their preferred
 * destination from the web dashboard. Terminal is excluded on purpose - its rate-card weight is
 * additive-only (it stacks on top of a webview surface, never a destination in its own right) - and
 * 'browser' is unimplemented.
 */
export type RemoteSurfaceId = 'status-bar' | 'thinking-line' | 'chat-banner';

/** Coarse, privacy-safe reason a web-requested surface could not be applied on a device (mirrors
 *  SurfaceApplyFailureSchema). No path, filename, or vendor detail ever leaves the machine. */
export type SurfaceApplyFailure =
  | 'unsupported-build'
  | 'foreign-conflict'
  | 'health-check-failed'
  | 'settings-read-only'
  | 'error';

/**
 * Ad-rendering preferences settable from the web dashboard, synced to every linked device
 * automatically - unlike `remoteSurfacePreference`, none of these touch a Claude Code file (no
 * patch, no golden-rule-2 consent gate applies), so there is nothing to confirm and no toast to
 * show. Sparse and optional field-by-field, same convention as `notificationPrefs`: an absent field
 * means "this device keeps deciding locally". Ids are validated against the live registries in
 * `adCustomization.ts` (AD_SPINNERS / GLOW_THEMES / BANNER_FRAMES) - adding an option there is the
 * only change needed for both the extension and the web to offer it.
 */
/**
 * Per-format customization, stored flat and keyed `${format}.${element}` (see syncedSettings).
 *
 * A loose record rather than an enumerated shape on purpose: the valid pairs are declared once in
 * AD_FORMATS, and a second list here would be one more thing to keep in step.
 *
 * An older row may still carry four account-wide keys (`spinner`, `brandLogo`, `chatBannerStyle`,
 * `chatBannerFrame`) from before customization was per-format. Nothing reads them: they are inert
 * data, ignored by the same rule that ignores any other unrecognised key.
 */
export type AdPreferences = Record<string, string | boolean>;

export interface UserMe {
  email: string;
  /** Display name, if the account has one set (Better Auth `User.name`, trimmed; null if blank). */
  name: string | null;
  role: UserRole[];
  deviceCount: number;
  /** external = a real user; internal = the owner's own dev/test/house accounts (wash traffic, and
   *  the only accounts allowed to create house ads). system = a reserved ledger account. */
  accountClass: 'external' | 'internal' | 'system';
  /** Account-wide preferred surface, set from the web dashboard and pushed to every linked device.
   *  `null` = unset - each device keeps deciding locally, today's unchanged behavior. */
  remoteSurfacePreference: RemoteSurfaceId | null;
  /**
   * The most recent surface a linked device confirmed it actually applied - reported by the device
   * itself, immediately on success, independent of whether an ad has rendered there yet (that can
   * take arbitrarily long: the line only exists while the agent is genuinely thinking). This is what
   * lets the web distinguish "applied, waiting for the first ad to confirm it" from "no device has
   * done anything yet" - two very different states a single ad-event-derived signal cannot tell
   * apart. `null` if no device has ever reported one.
   */
  lastAppliedSurface: RemoteSurfaceId | null;
  /**
   * Account-wide request for the terminal status line. `null` = unset, each device decides locally.
   *
   * Separate from `remoteSurfacePreference` rather than a fourth value in it, because the terminal
   * is ADDITIVE: it runs alongside whichever VS Code format is chosen, in every terminal, so it can
   * never be one of a mutually-exclusive set. It sits in the same PERMISSION category though -
   * turning it on writes `~/.claude/settings.json`, so it needs the device's own consent and can
   * only be confirmed by that device reporting back.
   */
  remoteTerminalEnabled: boolean | null;
  /** What a linked device last confirmed about its terminal line, for the same reason
   *  `lastAppliedSurface` exists: the request is not the outcome. `null` if none has reported. */
  lastAppliedTerminal: boolean | null;
  /** Account-wide ad-rendering preferences. `null` = unset, every field device-local (unchanged
   *  behavior). */
  adPreferences: AdPreferences | null;
  /**
   * How many linked editors already have the current settings.
   *
   * Inferred, never reported: a device applies these on the check-in that authenticates it, and
   * applying them cannot fail, so a check-in after the change IS the receipt. When nothing has been
   * set from the web this equals the device count, because every editor is on the defaults and
   * therefore already correct.
   */
  settingsPickedUpBy: number;
  /** When the settings last changed, or null if never set from the web. */
  settingsChangedAt: string | null;
}

export interface DeviceInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** A name the account owner typed for this machine, from the web. `null` = never named, in which
   *  case the UI falls back to the id tail. Nothing about this is read off the device. */
  label: string | null;
  /** The surface this device last CONFIRMED it ended up on (its own report), so the dashboard can show
   *  a true per-machine state instead of one account-wide value. `null` = never reported. */
  appliedSurface: RemoteSurfaceId | null;
  /** Whether the terminal status line is on for this device (its own report). `null` = never reported. */
  appliedTerminal: boolean | null;
  /** Coarse reason the web-requested surface could not be applied here; `null` = the last apply
   *  succeeded, or none was attempted. Lets the dashboard show WHY, not an indefinite "confirm in your
   *  editor". */
  applyFailure: SurfaceApplyFailure | null;
  /** When this device last reported its apply-state (ISO), or `null` if never. */
  appliedAt: string | null;
  /** This device's own "Control from web" opt-in (reported up, never web-set): true = a web-set format
   *  applies here without a local confirm. Lets the dashboard show which editors will honor a push. */
  autoApply: boolean;
}

export interface AdminCampaignItem extends CampaignWithCreative {
  advertiserEmail: string;
}

// ── Patch governance & health (admin read model) ─────────────────────────────────
// A read model over the append-only PatchHashReport log joined with Recipe/RecipeHashBlock.
// Admin-only. Reputation-weighted consensus decides which build hash the fleet trusts; the
// same per-build shape powers both the governance panel and the patch-health dashboard.

export type RecipeChannel = 'stable' | 'canary';
export type RecipeGovernanceStatus = 'verified' | 'pending'; // DB truth (cf. RecipeResponse.status)
export type RecipeSource = 'consensus' | 'admin';

/** Tally of patch outcomes reported for a build. */
export type OutcomeCounts = Record<PatchOutcome, number>;

/** The live recipe row for a build, as governance sees it. */
export interface RecipeGovernanceState {
  status: RecipeGovernanceStatus;
  source: RecipeSource;
  channel: RecipeChannel;
  confidence: number;
  webSha256: string;
  extSha256: string;
  updatedAt: string; // ISO
}

/** Reputation-weighted consensus snapshot for a build (clean, tokened votes only). */
export interface ConsensusState {
  winner: { webSha256: string; extSha256: string; devices: number; weight: number } | null;
  contested: boolean;
  quorum: number;
  distinctCleanDevices: number;
}

/** One build's combined health + governance state — the row shared by both admin pages. */
export interface BuildHealth {
  agent: AgentId;
  buildId: string;
  version: string;
  totalReports: number;
  distinctDevices: number;
  cleanReports: number;
  outcomes: OutcomeCounts;
  applyFailureRate: number; // (apply-failed + conflict) / patch attempts, 0..1
  lastReportAt: string; // ISO
  recipe: RecipeGovernanceState | null;
  consensus: ConsensusState;
}

/**
 * Public install counts from a registry the extension ships to. Not user data of any kind - both
 * numbers are published by the registry itself and are read server-side.
 *
 * `installs` is unique installs where the registry exposes it (the Marketplace does, Open VSX does
 * not, so it is null there). `downloads` is raw and counts updates. The two registries count
 * differently, so these must never be summed into one figure.
 */
export interface RegistryStat {
  registry: 'marketplace' | 'open-vsx';
  label: string;
  /** Which editors install from this registry - the whole reason the split is interesting. */
  editors: string;
  installs: number | null;
  downloads: number | null;
  url: string;
  /** Set when this registry could not be read, so the UI never implies the other is the whole picture. */
  error?: string;
}

export interface MarketplaceStats {
  fetchedAt: string; // ISO
  registries: RegistryStat[];
}

/** Top-level patch-health summary — the dashboard and the governance list share this. */
export interface PatchHealthSummary {
  generatedAt: string; // ISO
  totals: OutcomeCounts;
  builds: BuildHealth[];
}

/** A competing hash pair for a build, with reputation-weighted device support. */
export interface HashPairTally {
  webSha256: string;
  extSha256: string;
  devices: number;
  weight: number;
  isLive: boolean; // equals the currently-served recipe's pair
  isBlocked: boolean;
}

export interface HashBlockInfo {
  webSha256: string;
  extSha256: string;
  reason: string | null;
  createdAt: string; // ISO
}

/** Per-build governance detail: every competing hash pair + blocks + the live recipe. */
export interface BuildGovernanceDetail {
  build: BuildHealth;
  tallies: HashPairTally[];
  blocks: HashBlockInfo[];
}

// ── Finance: reconciliation & the admin overview (FINANCE.md §8/§9) ───────────

/** One asserted invariant. `detail` is a full sentence even when it passes: a green tick nobody can
 *  read is not evidence. */
export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
  /** A few offending transaction ids, when there are any. Never the whole list. */
  breaches?: string[];
}

/**
 * The payout demand map (docs/FINANCE.md §4.4): for each region where developers registered interest in
 * a payout rail that does not serve them yet, how many are waiting and how much unpaid USD is stacked up
 * behind them. This is the READ side of the Phase A demand instrument - the signal that decides which
 * rail to build next, instead of guessing. One row per country, balances joined LIVE from the ledger.
 */
export interface PayoutDemandRow {
  /** ISO 3166-1 alpha-2 of the region developers are waiting on. */
  country: string;
  /** How many developers named this region. */
  developers: number;
  /** Their combined unredeemed (earned-but-unpaid) balance - the money a rail here would unlock. */
  unpaidUsd: number;
  /** The earliest wait in this region, ISO timestamp - how long the demand has gone unmet. */
  oldestWaitAt: string;
  /** True if a rail now serves this region after all (stale demand: they can onboard now). */
  nowSupported: boolean;
}

export interface PayoutDemand {
  /** Regions, ordered by unpaid balance then developer count - the build-this-next ranking. */
  rows: PayoutDemandRow[];
  totalDevelopers: number;
  totalUnpaidUsd: number;
  generatedAt: string;
}

/**
 * The W-8BEN a developer submits so Awaitful can document their FOREIGN status on a remittance rail
 * (Wise) whose KYC is not an IRS Chapter-3 form (docs/FINANCE.md §4.4). Structured fields + an electronic
 * attestation; the server stamps `signedAt` and derives the statutory expiry. It never carries a US TIN -
 * a W-8BEN is for a NON-US person (a US person files a W-9), so US citizenship is refused up front.
 */
export interface W8BenAddress {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  /** ISO-2. A permanent residence address, never a US address for a foreign person. */
  country: string;
}

export interface W8BenInput {
  name: string;
  /** ISO-2 country of citizenship; must not be 'US'. */
  countryOfCitizenship: string;
  permanentAddress: W8BenAddress;
  mailingAddress?: W8BenAddress;
  /** Foreign tax identifying number (line 6). Never a US TIN/SSN. */
  foreignTin?: string;
  /** ISO date YYYY-MM-DD (line 8). */
  dateOfBirth?: string;
  /** ISO-2, an optional treaty-benefit claim. */
  treatyCountry?: string;
  /** The typed signature, made under penalties of perjury. */
  signedName: string;
  /** Must be true: the developer attests the certification. */
  certified: boolean;
}

/** Whether a valid (non-expired) W-8BEN is on file, and when it lapses. */
export interface W8BenStatus {
  onFile: boolean;
  name: string | null;
  signedAt: string | null;
  expiresAt: string | null;
  /** True when a form exists but has passed its expiry (re-collection needed). */
  expired: boolean;
}

/** What the platform earned, owes, and holds. Every figure is derived from the ledger. */
export interface FinanceFigures {
  // ── Revenue, split three ways ───────────────────────────────────────────────
  // Once real funding runs, the processor fee the platform ABSORBS (FINANCE.md §5, "you load what you
  // pay") is a real cost. Collapsed into one "revenue" number it would be invisible, and the first
  // month of real cash would silently look more profitable than it is.
  /** SUM(platform_fee): the margin actually taken on real advertiser spend. */
  grossMarginUsd: number;
  /** SUM(processing_fee): the pay-in fee we swallowed so the advertiser's wallet credits in full. Negative. */
  processingFeesUsd: number;
  /** What is left. EXCLUDES the phase-7A opening balance, which sits on the same account and is an
   *  accounting artifact, not income. */
  netRevenueUsd: number;
  /** The pre-double-entry imbalance, absorbed once and shown for what it is. */
  openingBalanceUsd: number;

  // ── What we owe ─────────────────────────────────────────────────────────────
  /** Everything real developers have earned and not yet been paid. */
  liabilityUsd: number;
  /** The slice of that a developer could withdraw right now (past the holdback). */
  payableUsd: number;
  /** The rest: earned, still clearing. `pending = liability - payable`, by construction. */
  pendingUsd: number;

  // ── Cash and payouts ────────────────────────────────────────────────────────
  // The block that becomes the point of this page the day real cash is enabled.
  /** Real money we are holding: -SUM(system:cash). */
  cashOnHandUsd: number;
  /** GROSS actually settled to developers, net of reversals. Money that has left the building. */
  paidOutUsd: number;
  /** Requested, debited, and not yet confirmed by the provider. Neither ours nor theirs yet. */
  inFlightUsd: number;
  /** What we can cover a payout with: cash on hand + the subsidy we have committed to funding. */
  coverageUsd: number;
  /** coverage - liability. The solvency margin, as a number rather than a sentence. */
  headroomUsd: number;

  // ── Subsidy ─────────────────────────────────────────────────────────────────
  subsidyBudgetUsd: number;
  subsidySpentUsd: number;
  subsidyAvailableUsd: number;
}

/**
 * Whether cash can move at all.
 *
 * The single most important fact on the page once payouts are enabled, and it is deliberately two
 * independent switches: `paused` is an admin brake that only ever STOPS money, and `enabledByEnv` is a
 * server env var that no panel can flip. A UI bug can therefore halt payouts but can never start them.
 */
export interface PayoutRail {
  enabledByEnv: boolean;
  paused: boolean;
  live: boolean;
  minPayoutUsd: number;
  holdbackDays: number;
}

/** What triggered a pass. A boot run is attributable to the deploy that caused it; a scheduled one is not. */
export type ReconciliationTrigger = 'boot' | 'scheduled' | 'manual';

export interface ReconciliationReport {
  /** When this pass ran. */
  at: string; // ISO
  /** When the next SCHEDULED pass will run. The page shows it, so a stale verdict is obviously stale. */
  nextRunAt: string; // ISO
  trigger: ReconciliationTrigger;
  /** How long the pass took. Surfaced so a slow drift is visible long before it is a problem. */
  tookMs: number;
  /** When double-entry began. Null on a database that never needed an opening balance. */
  booksOpenedAt: string | null;
  ok: boolean;
  invariants: InvariantResult[];
  figures: FinanceFigures;
  payoutRail: PayoutRail;
}

// ── The auction, as an admin sees it (one page, every ad) ─────────────────────

/** Why an ad is not in the draw. Ordered by how early the gate rejects it. */
export type IneligibleReason =
  | 'not-live'         // the campaign is draft / paused / rejected / exhausted
  | 'not-approved'     // the creative has not cleared moderation
  | 'budget-spent'     // today's spend has reached the daily budget (pacing)
  | 'subsidy-off'      // a house ad, and there is no subsidy budget left to pay a real developer with
  | 'zero-bid';        // a $0 bid has zero weight in the draw, so it can never be picked

export interface AuctionAd {
  campaignId: string;
  line: string;
  brandName: string | null;
  advertiserEmail: string | null;
  /** `internal` = a house ad, paid for by the platform's subsidy rather than by an advertiser. */
  accountClass: 'external' | 'internal' | 'system';

  bidCpm: number;
  dailyBudgetUsd: number;
  spentTodayUsd: number;

  status: string;
  moderation: string | null;

  eligible: boolean;
  ineligibleReason: IneligibleReason | null;

  /**
   * The ad's share of the draw: its bid over the total bid of every ELIGIBLE ad. This is the number
   * that answers "how much delivery am I getting", and it is a probability per slot, not a ranking.
   */
  shareOfVoice: number;
  /** shareOfVoice x rotationSize. What the ad wins, on average, out of each slate's slots. */
  expectedSlotsPerSlate: number;
  /** Actually in a slate that is cached and being served RIGHT NOW. */
  inRotationNow: boolean;
  /**
   * The last-resort creative, shown when the auction produces no winner at all. It reaches a developer
   * by BYPASSING the draw, so it can be on screen (`inRotationNow`) while being unable to win a slot
   * (`zero-bid`). Without this flag those two facts look like a contradiction; with it, they are one
   * sentence.
   */
  isFallbackCreative: boolean;

  impressions: number;
  clicks: number;
}

/** One slate that is cached and being served right now. There is one per placement per audience, plus
 *  a variant per advertiser whose own ads are being excluded from their own feed. */
export interface LiveSlate {
  key: string;
  placement: string;
  audience: string;
  /** The advertiser whose own ads this variant excludes, if it is an exclusion variant. */
  excludingAdvertiserId: string | null;
  /** The campaign in each slot, in order. A campaign can appear more than once: the draw is WITH
   *  replacement, which is how a dominant bidder takes more than one slot. */
  slots: string[];
  ttlSeconds: number;
}

export interface AuctionOverview {
  /** How many slots a slate has. Every ad competes for these, however many ads there are. */
  rotationSize: number;
  /** How long a slate is cached before the draw is re-run. */
  slateTtlSeconds: number;
  /** House ads can only be shown to real developers while there is subsidy left to pay them with. */
  subsidyAvailable: boolean;
  /** The denominator of every shareOfVoice on the page. */
  totalEligibleBidCpm: number;
  ads: AuctionAd[];
  liveSlates: LiveSlate[];
}

// ── The public marketplace pulse (Home, and one day the landing page) ─────────

/** One live ad in the public order book. Line, brand and bid ONLY: these are already public by
 *  nature (the ad is served into strangers' editors, and the market strip shows the top bid to any
 *  advertiser). The owner's identity is not, and never rides on this type. */
export interface PulseAd {
  line: string;
  brandName: string | null;
  bidCpm: number;
}

/**
 * The marketplace, churning, with no user data in it - safe to show any signed-in account and, one
 * day, the landing page. Three time horizons on purpose: "right now" proves it is alive, "today"
 * and "all time" carry the page honestly through the quiet hours when right-now reads zero.
 */
export interface MarketPulse {
  /** The live order book, sorted by bid, highest first. */
  ads: PulseAd[];
  /** Σ of every live bid: the size of the pot being competed for. */
  totalBidPoolCpm: number;
  /** Verified views per minute, per placement, right now. */
  impressions: ImpressionStat[];
  /** Real ledger sums of dev_earning on external accounts. Only ever grow. */
  paidLastHourUsd: number;
  paidTodayUsd: number;
  paidAllTimeUsd: number;
}

// ── The market's recent past (the admin bid-market gallery; one day a public variant) ──────────

/**
 * One verified view or click, as the market saw it. Identity-free BY CONSTRUCTION, exactly like
 * PulseAd: no campaign id, no account id, no account class rides on this type - so the day a
 * variant of this feed goes public, the shape itself cannot leak who is behind an ad.
 *
 * `kind` is the honest money story of the event:
 *  - 'charged'    a real advertiser paid its own bid (this is a first-price market)
 *  - 'subsidized' a house ad was shown to a real developer and the platform paid their share
 *  - 'unpaid'     the $0 house fallback served - bills nobody, pays nothing, and says so
 */
export interface MarketEvent {
  /** Server receipt time, ISO. */
  at: string;
  /** The exact bid that priced this event. 0 for unpaid house serves. */
  bidCpm: number;
  /** The money that actually moved: the charge, or the subsidized dev share. 0 when unpaid. */
  amountUsd: number;
  brandName: string | null;
  /** The sponsored line, already public by nature (it is served into strangers' editors). */
  line: string;
  placement: string;
  kind: 'charged' | 'subsidized' | 'unpaid';
  click: boolean;
}

/**
 * The auction's standing state at one moment, recorded every ~60s by the snapshot job. This table
 * exists because nothing else remembers standing bids: `Campaign.bidCpm` is overwritten on edit
 * and the Redis set only knows "now". A quiet minute writes an honest quiet row - zero bidders is
 * a fact worth recording, never a gap to paper over.
 */
export interface AuctionSnapshotPoint {
  at: string;
  /** Σ of every live bid at that moment - the size of the pot. */
  potCpm: number;
  bidderCount: number;
  /** The standing order book, identity-free: brand + bid only. */
  bids: { brandName: string | null; bidCpm: number }[];
  /** placement -> the slot labels actually being served (brand name, or 'house' for the fallback). */
  slots: Record<string, string[]>;
}

/** The bid market over the recent past: what was served (events) and what stood (snapshots). */
export interface MarketHistory {
  events: MarketEvent[];
  snapshots: AuctionSnapshotPoint[];
  /** True when the event cap cut the oldest part of the window. */
  truncated: boolean;
  /** The instant events are complete from - the window start, or the cut point when truncated. */
  coverageFrom: string;
}

/**
 * The PUBLIC bid-market history: strictly aggregate, one point per snapshot. Unlike the admin
 * AuctionSnapshotPoint it carries NO per-brand `bids` array and NO `slots`, only the three numbers
 * a line chart needs. This is deliberate: a time series of (brand, bid) would let a stranger track a
 * named advertiser's bid trajectory, which the admin market route warns is not public. Aggregates
 * over the whole book reveal no single advertiser, exactly like the pulse's top-bid quote.
 */
export interface PublicMarketPoint {
  /** Snapshot time, ISO. */
  at: string;
  /** The highest live bid at that moment (per 1,000 views) - the market-clearing price line. */
  topBidCpm: number;
  /** Σ of every live bid at that moment - the size of the pot. */
  potCpm: number;
  bidderCount: number;
}

export interface PublicMarketHistory {
  points: PublicMarketPoint[];
  /** The window's newest snapshot time, ISO - the "as of" that proves the market is alive now. */
  asOf: string | null;
}

/* ── Docs feedback ──────────────────────────────────────────────────────────── */

export type DocFeedbackKind = 'helpful' | 'unhelpful' | 'outdated';

/** Per-article feedback counts for the admin view. Identity-free by construction. */
export interface DocFeedbackSummary {
  slug: string;
  helpful: number;
  unhelpful: number;
  outdated: number;
}

/** One reader note, newest first in the admin list. */
export interface DocFeedbackNote {
  slug: string;
  kind: DocFeedbackKind;
  note: string;
  at: string;
}

/** GET /v1/admin/docs/feedback - the staleness loop's admin surface. */
export interface DocFeedbackAdminResponse {
  summaries: DocFeedbackSummary[];
  notes: DocFeedbackNote[];
}
