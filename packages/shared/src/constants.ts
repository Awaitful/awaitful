export const DEFAULTS = {
  viewThresholdSeconds: 5,
  viewTickSeconds: 1,
  stuckSessionSeconds: 5,
  clickMultiplier: 50,
  minPollSeconds: 3,
} as const;

export type Defaults = typeof DEFAULTS;

// Recipe crowd-consensus tuning (server publishes; client gates auto-apply).
export const RECIPE = {
  consensusQuorum: 3,   // distinct clean devices needed before a hash can be served
  minConfidence: 0.5,   // client auto-applies a server recipe only at/above this
  contestRatio: 0.5,    // runner-up cluster >= ratio * winner => contested (hold for admin)
  confidenceScale: 5,   // confidence = clamp(distinctDevices / scale, 0, 1)
} as const;

export type RecipeConfig = typeof RECIPE;

// Derived device-reputation weighting for consensus votes. Reputation is COMPUTED from
// signals already in the DB (account linkage, device tenure, distinct clean builds reported)
// — never stored — so it can never drift from the append-only report log and needs no
// migration or recompute job. A device's weight multiplies its vote when picking the winning
// hash and scoring confidence; quorum still counts DISTINCT devices, so weight can sharpen a
// decision but a single trusted device can never satisfy quorum alone (anti-sybil).
export const REPUTATION = {
  minWeight: 0.5, // clamp floor (safety; the formula's natural floor is anonBase)
  maxWeight: 2.0, // clamp ceiling — bounds any one device's influence
  anonBase: 0.7, // a tokened but account-less device
  accountBonus: 0.6, // linked to a real account (accountable identity)
  tenureRampDays: 21, // device age (days) to reach the full tenure bonus
  tenureBonus: 0.4,
  provenSaturation: 8, // distinct clean builds reported for the full track-record bonus
  provenBonus: 0.3,
} as const;

export type ReputationConfig = typeof REPUTATION;

// Patch-health thresholds for the admin dashboard's status signalling (colouring only —
// never gates billing or serving). Tunable server-side with no client release.
export const PATCH_HEALTH = {
  warnFailureRate: 0.1, // apply-failure rate at/above this renders as a warning
  errorFailureRate: 0.25, // …and at/above this as an error
  minAttemptsForRate: 5, // below this many patch attempts, failure rate is too noisy to colour
} as const;

export type PatchHealthConfig = typeof PATCH_HEALTH;

export const ERROR_CODES = {
  INVALID_EVENT_ID: 'INVALID_EVENT_ID',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  DEVICE_TOKEN_INVALID: 'DEVICE_TOKEN_INVALID',
  DEVICE_TOKEN_REVOKED: 'DEVICE_TOKEN_REVOKED',
  RATE_LIMITED: 'RATE_LIMITED',
  CAMPAIGN_NOT_FOUND: 'CAMPAIGN_NOT_FOUND',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  KILLSWITCH_ACTIVE: 'KILLSWITCH_ACTIVE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
