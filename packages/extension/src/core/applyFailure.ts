import type { SurfaceApplyFailure } from '@awaitful/shared';

/**
 * Map the patch engine's internal apply-failure reason (ApplyResult.reason) down to the coarse,
 * privacy-safe wire enum the dashboard shows (SurfaceApplyFailure). An unknown or absent reason falls
 * to 'error', so a new internal reason can never leak an unmapped raw string onto the wire. Pure and
 * unit-tested; the egress-whitelist test pins that the wire enum stays closed.
 */
export function mapApplyFailure(reason: string | undefined): SurfaceApplyFailure {
  switch (reason) {
    case 'blocked':
      return 'foreign-conflict'; // another tool is holding Claude Code's files
    case 'health-failed':
      return 'health-check-failed'; // patched, but did not verify and was rolled back
    case 'no-pristine':
    case 'no-target':
    case 'no-recipe':
      return 'unsupported-build'; // clean file but no verified recipe / nothing to attach to in this window
    default:
      return 'error';
  }
}
