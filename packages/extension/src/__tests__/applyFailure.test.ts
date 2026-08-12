import { describe, it, expect } from 'vitest';
import { mapApplyFailure } from '../core/applyFailure.js';

describe('mapApplyFailure', () => {
  it('maps a contested / foreign-held file to foreign-conflict', () => {
    expect(mapApplyFailure('blocked')).toBe('foreign-conflict');
  });

  it('maps build / recipe / target gaps to unsupported-build', () => {
    expect(mapApplyFailure('no-recipe')).toBe('unsupported-build');
    expect(mapApplyFailure('no-target')).toBe('unsupported-build');
    expect(mapApplyFailure('no-pristine')).toBe('unsupported-build');
  });

  it('maps a failed post-write health check to health-check-failed', () => {
    expect(mapApplyFailure('health-failed')).toBe('health-check-failed');
  });

  it('maps an explicit error to error', () => {
    expect(mapApplyFailure('error')).toBe('error');
  });

  it('falls to error for an unknown or absent reason, never leaking the raw string', () => {
    expect(mapApplyFailure('some-new-internal-reason')).toBe('error');
    expect(mapApplyFailure(undefined)).toBe('error');
  });
});
