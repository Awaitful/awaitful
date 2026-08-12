export const DEFAULTS = {
  viewThresholdSeconds: 5,
  viewTickSeconds: 1,
  stuckSessionSeconds: 5,
  clickMultiplier: 50,
  minPollSeconds: 3,
  // Per-ACCOUNT fraud caps on a developer's daily earnings, summed across all their devices (a
  // complement to the per-device rate-card caps). Beyond the daily cap, the developer stops earning
  // for the UTC day but the advertiser is still billed (as unlinked) - excess dropped, never a free
  // impression. Cross the ceiling and the account auto-freezes for review (still accrues nothing,
  // cannot withdraw). Deliberate round numbers, tunable; a real number a developer can hit honestly
  // sits well below the ceiling a fraud ring would race toward.
  accountDailyCapUsd: 25,
  accountDailyCeilingUsd: 100,
  // The two-tier withdrawal minimum: a developer's FIRST payout unlocks at firstPayoutMinUsd (the cheap
  // early trust win), every one after at minPayoutUsd. Admin-tunable at runtime (PlatformConfig); this
  // is the shipped default AND the single number the landing/docs advertise, so a policy change here
  // propagates to the marketing copy and the server fallback together (a runtime admin override is
  // operational - the logged-in earnings page shows the live per-developer threshold).
  firstPayoutMinUsd: 5,
  minPayoutUsd: 10,
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

/**
 * Every public URL the product points a user at, in one place.
 *
 * This is the PUBLIC CLIENT MIRROR (`Awaitful/awaitful`), not the private monorepo this file lives
 * in. It carries the extension, the shared contract and PRIVACY.md, and it is the thing a sceptical
 * developer actually reads. The distinction matters enough to state: linking the private repo would
 * 404 for every user but the owner.
 *
 * Deep links pin `/blob/HEAD/`, never `/blob/main/`. The mirror's default branch is `master`, so a
 * hardcoded `main` 404s - and a dead link on a page whose whole argument is "do not trust us, go and
 * check" is worse than having no page at all. HEAD always follows the default branch, so it also
 * survives a future rename.
 */
export const LINKS = {
  sourceCode: 'https://github.com/Awaitful/awaitful',
  /** The plain-English list of what leaves the machine. */
  egressManifest: 'https://github.com/Awaitful/awaitful/blob/HEAD/PRIVACY.md',
  /** The CI test that fails the build if the client contacts an unpublished host. */
  egressTest:
    'https://github.com/Awaitful/awaitful/blob/HEAD/packages/shared/src/__tests__/egress.test.ts',
  issues: 'https://github.com/Awaitful/awaitful/issues',
  /** User-facing release notes, opened from the post-update "what's new" banner in the panel. */
  changelog: 'https://github.com/Awaitful/awaitful/blob/HEAD/packages/extension/CHANGELOG.md',

  vscodeMarketplace: 'https://marketplace.visualstudio.com/items?itemName=awaitful.awaitful',
  openVsx: 'https://open-vsx.org/extension/awaitful/awaitful',
  extensionId: 'awaitful.awaitful',
  /**
   * The one-command install: detects the editor (VS Code, Cursor, Devin, VSCodium) and runs its
   * `--install-extension`. Published from the public mirror with npm provenance; the package is
   * dependency-free and makes no network calls of its own, both enforced by its tests.
   */
  npxInstall: 'npx awaitful',
  npmPackage: 'https://www.npmjs.com/package/awaitful',

  /** Live uptime, independently hosted (BetterStack) - a receipt nobody has to take our word for. */
  statusPage: 'https://status.awaitful.com',

  /**
   * A live third-party scan of this site's security headers. The grade is never printed in copy -
   * it would drift like a version number; the link IS the grade, whatever it is today.
   */
  securityScan: 'https://securityheaders.com/?q=https%3A%2F%2Fawaitful.com',

  /**
   * Protocol deep links: clicked in a browser, the OS hands them to the editor, which opens the
   * extension's install page directly - no marketplace hop. Each scheme was verified by hand
   * (Devin is the editor formerly named Windsurf; it registers `devin:`). They fail SILENTLY when
   * the editor is not installed, so every surface that uses one must keep an https fallback nearby.
   */
  vscodeDeepLink: 'vscode:extension/awaitful.awaitful',
  cursorDeepLink: 'cursor:extension/awaitful.awaitful',
  devinDeepLink: 'devin:extension/awaitful.awaitful',
  vscodiumDeepLink: 'vscodium:extension/awaitful.awaitful',
} as const;

/**
 * The brand's social profiles, in footer display order. Kept as plain data (id + label + href) so
 * this package stays UI-free; the web maps each id to its icon. Handles are written to match each
 * platform's real URL: Instagram and Threads lowercase them (so `getawaitful`, not `getAwaitful`),
 * and Threads runs off the same handle as Instagram. A separate export from LINKS on purpose - these
 * are a render list, not the trust-receipt map the links test pins.
 */
export const SOCIAL = [
  { id: 'x', label: 'X', href: 'https://x.com/Awaitful' },
  { id: 'linkedin', label: 'LinkedIn', href: 'https://www.linkedin.com/company/awaitful/' },
  { id: 'bluesky', label: 'Bluesky', href: 'https://bsky.app/profile/awaitful.com' },
  { id: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/@awaitful' },
  { id: 'reddit', label: 'Reddit', href: 'https://www.reddit.com/r/Awaitful' },
  { id: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/getawaitful' },
  { id: 'threads', label: 'Threads', href: 'https://www.threads.net/@getawaitful' },
  { id: 'facebook', label: 'Facebook', href: 'https://www.facebook.com/Awaitful' },
] as const;

export type SocialId = (typeof SOCIAL)[number]['id'];

/**
 * The registered legal entity behind the Awaitful brand. Surfaced as an understated trust signal - the
 * footer copyright line, the operator / data controller named in the legal pages, and the email footer -
 * from this ONE place so web and server never retype it. Kept minimal on purpose: just the name. A state
 * of formation or a mailing address is added here only when it belongs (legal / contact context), never
 * as a badge or a claim.
 */
export const COMPANY = {
  legalName: 'Awaitful LLC',
} as const;

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
