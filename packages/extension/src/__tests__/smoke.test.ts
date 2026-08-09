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
 * VS Code owns a setting's default in package.json, and a manifest cannot import from shared - so
 * the web reads DEFAULT_* to describe what an editor does absent a choice, and nothing but a test
 * keeps the two honest. If they drift, the web confidently states a default that is not the one
 * running, which is the worst kind of wrong: specific, plausible, and false.
 */
describe('synced-setting defaults match the VS Code manifest', () => {
  it('every registry default equals its package.json default', async () => {
    const { ELEMENTS } = await import('@awaitful/shared');
    // process.cwd() rather than import.meta: this package builds to CommonJS, where tsc rejects
    // import.meta outright. Vitest's root is the package directory.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    const props = pkg.contributes.configuration.properties;

    // Only the settings VS Code actually contributes as configuration; the banner style and frame
    // live in globalState, not settings.json, so they have no manifest entry to drift from.
    // Only the two VS Code contributes as configuration. They are legacy seeds now - the live value
    // is per-format - but a seed that disagrees with the element default still starts an editor off
    // on a look the web will describe wrongly.
    const manifestKey: Record<string, string> = {
      spinner: 'awaitful.adSpinner',
      logo: 'awaitful.adBrandLogo',
    };
    for (const [elementId, key] of Object.entries(manifestKey)) {
      expect(props[key], `${key} is missing from the manifest`).toBeDefined();
      expect(props[key]!.default, `${key} default drifted from ELEMENTS.${elementId}`)
        .toBe(ELEMENTS[elementId as keyof typeof ELEMENTS].defaultValue);
    }
  });
});
