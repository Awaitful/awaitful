import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, PlacementIdSchema } from '@awaitful/shared';
import { Rotation } from '../core/rotation.js';
import { EventQueue } from '../metrics/eventQueue.js';

describe('shared contract is accessible', () => {
  it('DEFAULTS has expected values', () => {
    expect(DEFAULTS.viewThresholdSeconds).toBe(5);
    expect(DEFAULTS.stuckSessionSeconds).toBe(5);
    expect(DEFAULTS.minPollSeconds).toBe(3);
  });

  it('PlacementIdSchema validates known placements', () => {
    expect(PlacementIdSchema.parse('status-bar')).toBe('status-bar');
    expect(() => PlacementIdSchema.parse('unknown')).toThrow();
  });
});

describe('pure modules are importable', () => {
  it('Rotation initialises', () => {
    const r = new Rotation([]);
    expect(r.next()).toBeUndefined();
  });

  it('EventQueue initialises with zero pending', () => {
    const q = new EventQueue('http://localhost', () => undefined, () => undefined);
    expect(q.pendingCount).toBe(0);
    q.dispose();
  });
});

/**
 * How a format looks now lives in ONE place: the per-format store in customization.ts, seeded from
 * the account. It used to live in two - that store plus `awaitful.adSpinner` / `awaitful.adBrandLogo`,
 * which VS Code contributed as ordinary settings and which acted as an invisible fallback under it.
 * Editing one in the settings UI changed only the formats you had not explicitly chosen for, an
 * effect no reader could predict from looking at the control.
 *
 * This pins the retirement. If either key comes back as contributed configuration, an editor gains a
 * second way to set a look that the web knows nothing about - and the web will then describe a look
 * that is not the one running, which is the worst kind of wrong: specific, plausible, and false.
 */
describe('a look has exactly one source', () => {
  it('the retired account-wide look settings stay out of the manifest', () => {
    // process.cwd() rather than import.meta: this package builds to CommonJS, where tsc rejects
    // import.meta outright. Vitest's root is the package directory.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    const props = pkg.contributes.configuration.properties;

    for (const retired of ['awaitful.adSpinner', 'awaitful.adBrandLogo']) {
      expect(
        props[retired],
        `${retired} is contributed again - a look must only come from the per-format store`,
      ).toBeUndefined();
    }
  });
});
