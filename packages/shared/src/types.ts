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
  | 'incompatible'
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

export type SSEEventType = 'slate_refresh' | 'killswitch' | 'recipe_update' | 'impression_stats';

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

export interface EarningEntry {
  id: string;
  amountUsd: string;
  placement: string | null;
  createdAt: string;
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

export interface CampaignWithCreative {
  id: string;
  status: CampaignStatus;
  bidCpm: string;
  dailyBudget: string;
  spent: string;
  createdAt: string;
  creative: CampaignCreative | null;
  /** Lifetime verified billable views (view_threshold_met events) for this campaign. */
  impressions: number;
  /** Lifetime clicks for this campaign. */
  clicks: number;
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
  feeUsd: string;
  platformFeeUsd: string;
  netUsd: string;
  feeDescription: string;
  isConnected: boolean;
}

// ── Admin ──────────────────────────────────────────────────────────────────────

export type UserRole = 'advertiser' | 'developer' | 'admin';

export interface UserMe {
  email: string;
  role: UserRole[];
  deviceCount: number;
  /** external = a real user; internal = the owner's own dev/test/house accounts (wash traffic, and
   *  the only accounts allowed to create house ads). system = a reserved ledger account. */
  accountClass: 'external' | 'internal' | 'system';
}

export interface DeviceInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
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
