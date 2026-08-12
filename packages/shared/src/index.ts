export * from './constants.js';
export * from './types.js';
export * from './schemas.js';
export * from './notifications.js';
export * from './adCustomization.js';
export * from './syncedSettings.js';

/*
 * `./wireframe.js` is deliberately NOT re-exported here. Import it as
 * `@awaitful/shared/wireframe`.
 *
 * It is a 10 KB string, and a barrel is a reachability edge, not a lazy reference: Rollup tree-shakes
 * once for the whole build, so as soon as ONE route used it through this file the edge survived, and
 * every entry that imports this barrel - which is every entry - was then judged to reach it. The
 * artwork landed in the common chunk that `index.html` modulepreloads, putting ~1.9 KB gzipped on the
 * anonymous landing page to draw a picture only `/install` shows. Its own subpath severs the edge.
 */

