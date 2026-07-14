import { describe, expect, it } from 'vitest';
import { LINKS } from '../constants.js';

/**
 * The trust receipts are the product's whole differentiator: every competitor writes "we never read
 * your code", and the only thing that separates a promise from a proof is that our sentence ends in
 * a link that opens.
 *
 * So these URLs are load-bearing, and they are exactly the kind of string that rots silently. This
 * pins the two ways they have already gone wrong once:
 *
 *   1. the WRONG REPO - the source lives in the public client mirror (Awaitful/awaitful), not in the
 *      private monorepo that this file sits in, which resolves for nobody but the owner;
 *   2. the WRONG BRANCH - the mirror's default branch is `master`, so a `/blob/main/` deep link 404s.
 *      `/blob/HEAD/` follows the default branch whatever it is called.
 *
 * A dead receipt is worse than no receipt. It turns a sceptic into someone who has caught us.
 */
describe('public links', () => {
  const deepLinks = [LINKS.egressManifest, LINKS.egressTest];

  it('points at the public client mirror, never the private monorepo', () => {
    for (const url of Object.values<string>(LINKS)) {
      expect(url.includes('doctopus/'), `${url} points at the private repo`).toBe(false);
    }
    expect(LINKS.sourceCode).toBe('https://github.com/Awaitful/awaitful');
  });

  it('pins deep links to HEAD, so a branch rename cannot 404 them', () => {
    for (const url of deepLinks) {
      expect(url, `${url} must deep-link via /blob/HEAD/`).toContain('/blob/HEAD/');
      expect(url).not.toContain('/blob/main/');
      expect(url).not.toContain('/blob/master/');
    }
  });

  it('resolves every link to a real, absolute https URL', () => {
    // Not https by nature: an extension id, a terminal command, and the editor protocol links.
    const notHttps = new Set(['extensionId', 'npxInstall']);
    for (const [name, url] of Object.entries<string>(LINKS)) {
      if (notHttps.has(name) || name.endsWith('DeepLink')) continue;
      expect(() => new URL(url), `${name} is not a URL`).not.toThrow();
      expect(url.startsWith('https://'), `${name} is not https`).toBe(true);
    }
  });

  it('every editor deep link targets the published extension id', () => {
    const deepLinks = Object.entries<string>(LINKS).filter(([name]) => name.endsWith('DeepLink'));
    expect(deepLinks.length).toBeGreaterThan(0);
    for (const [name, url] of deepLinks) {
      expect(url, `${name} must open the extension page`).toMatch(/^[a-z-]+:extension\/awaitful\.awaitful$/);
    }
  });

  it('the npx command is exactly the published package name', () => {
    expect(LINKS.npxInstall).toBe('npx awaitful');
  });
});
