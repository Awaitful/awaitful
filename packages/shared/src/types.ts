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
   * Earned but not yet paid out: dev_earning credits minus payout debits
   * (including payout platform fees). Equals lifetime until payouts go live.
   * Withdrawable amount at cashout may be less (threshold + holdback).
   */
  unredeemedUsd: string;
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
  brandIconUrl?: string;
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
  brandIconUrl?: string;
  bidCpm: number;
  dailyBudget: number;
}

export interface UpdateCampaignInput {
  line?: string;
  url?: string | null;
  brandName?: string | null;
  brandIconUrl?: string | null;
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
  balanceUsd: string;
  reservedUsd: string;
  availableUsd: string;
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
