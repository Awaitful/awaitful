import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_IDS,
  NOTIFICATION_CHANNELS,
  notificationPreferenceMapSchema,
  categoriesForRoles,
  categoryAppliesToRoles,
  channelEnabled,
  shouldDeliver,
  resolveNotificationPreferences,
  applyPreferencePatch,
  type NotificationPreferenceMap,
} from '../notifications.js';

const LIVE = { marketingEmailLive: true };
const NOT_LIVE = { marketingEmailLive: false };
const NO_PREFS: NotificationPreferenceMap = {};

describe('registry integrity', () => {
  it('defines exactly the declared categories, in order', () => {
    expect(Object.keys(NOTIFICATION_CATEGORIES)).toEqual([...NOTIFICATION_CATEGORY_IDS]);
  });

  it('every entry keys itself correctly and supports at least in-app', () => {
    for (const id of NOTIFICATION_CATEGORY_IDS) {
      const def = NOTIFICATION_CATEGORIES[id];
      expect(def.category).toBe(id);
      expect(def.channels.in_app).toBeDefined();
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('keeps user-facing copy free of em dashes (VOICE.md)', () => {
    for (const id of NOTIFICATION_CATEGORY_IDS) {
      const def = NOTIFICATION_CATEGORIES[id];
      expect(def.label).not.toContain('—');
      expect(def.description).not.toContain('—');
    }
  });

  it('reserves email for money and security, never for delight', () => {
    // earnings.milestone is the canary: in-app delight, and it must never be emailable.
    expect(NOTIFICATION_CATEGORIES['earnings.milestone'].channels.email).toBeUndefined();
  });
});

describe('channelEnabled - preferences alone', () => {
  it('uses the registry default when nothing is stored', () => {
    expect(channelEnabled('payout.settled', 'email', NO_PREFS)).toBe(true); // default on
    expect(channelEnabled('wallet.low_balance', 'email', NO_PREFS)).toBe(false); // default off
  });

  it('honours a stored override', () => {
    const off: NotificationPreferenceMap = { 'payout.settled': { email: false } };
    expect(channelEnabled('payout.settled', 'email', off)).toBe(false);
    const on: NotificationPreferenceMap = { 'wallet.low_balance': { email: true } };
    expect(channelEnabled('wallet.low_balance', 'email', on)).toBe(true);
  });

  it('keeps a locked channel on regardless of a stored override', () => {
    const tryOff: NotificationPreferenceMap = { 'security.device_linked': { email: false } };
    expect(channelEnabled('security.device_linked', 'email', tryOff)).toBe(true);
  });

  it('returns false for an unsupported channel', () => {
    expect(channelEnabled('earnings.milestone', 'email', NO_PREFS)).toBe(false);
  });
});

describe('shouldDeliver - the dispatch decision', () => {
  it('follows preferences for a transactional channel', () => {
    expect(shouldDeliver('payout.settled', 'email', NO_PREFS, LIVE)).toBe(true);
    const off: NotificationPreferenceMap = { 'payout.settled': { email: false } };
    expect(shouldDeliver('payout.settled', 'email', off, LIVE)).toBe(false);
  });

  it('never emails a not-yet-live marketing stream, even when enabled', () => {
    const wants: NotificationPreferenceMap = { 'product.update': { email: true } };
    expect(shouldDeliver('product.update', 'email', wants, NOT_LIVE)).toBe(false);
    expect(shouldDeliver('product.update', 'email', wants, LIVE)).toBe(true);
  });

  it('never delivers an unsupported channel', () => {
    expect(shouldDeliver('earnings.milestone', 'email', NO_PREFS, LIVE)).toBe(false);
  });

  it('always delivers in-app for its supported categories', () => {
    expect(shouldDeliver('earnings.milestone', 'in_app', NO_PREFS, NOT_LIVE)).toBe(true);
  });
});

describe('categoriesForRoles', () => {
  it('shows a developer money, never campaigns', () => {
    const ids = categoriesForRoles(['developer']).map(d => d.category);
    expect(ids).toContain('payout.settled');
    expect(ids).toContain('earnings.milestone');
    expect(ids).not.toContain('campaign.decision');
  });

  it('shows an advertiser campaigns, never payouts', () => {
    const ids = categoriesForRoles(['advertiser']).map(d => d.category);
    expect(ids).toContain('campaign.decision');
    expect(ids).toContain('wallet.low_balance');
    expect(ids).not.toContain('payout.settled');
  });

  it("always includes 'all' categories, and gives an admin every category", () => {
    expect(categoriesForRoles(['developer']).map(d => d.category)).toContain('security.device_linked');
    expect(categoriesForRoles(['advertiser', 'developer', 'admin'])).toHaveLength(NOTIFICATION_CATEGORY_IDS.length);
  });

  it('categoryAppliesToRoles matches the role rule', () => {
    expect(categoryAppliesToRoles(NOTIFICATION_CATEGORIES['payout.settled'], ['advertiser'])).toBe(false);
    expect(categoryAppliesToRoles(NOTIFICATION_CATEGORIES['product.update'], ['advertiser'])).toBe(true);
  });
});

describe('resolveNotificationPreferences - the settings-grid view', () => {
  it('marks security email locked and on', () => {
    const view = resolveNotificationPreferences(['developer'], NO_PREFS, LIVE);
    const email = view.find(c => c.category === 'security.device_linked')?.channels.find(ch => ch.channel === 'email');
    expect(email).toMatchObject({ enabled: true, locked: true, available: true });
  });

  it('shows only the supported channels for a category', () => {
    const view = resolveNotificationPreferences(['developer'], NO_PREFS, LIVE);
    const milestone = view.find(c => c.category === 'earnings.milestone');
    expect(milestone?.channels.map(ch => ch.channel)).toEqual(['in_app']);
  });

  it('renders marketing email as unavailable until the stream is live', () => {
    const before = resolveNotificationPreferences(['advertiser'], NO_PREFS, NOT_LIVE);
    const beforeEmail = before.find(c => c.category === 'product.update')?.channels.find(ch => ch.channel === 'email');
    expect(beforeEmail).toMatchObject({ available: false, enabled: false });

    const after = resolveNotificationPreferences(['advertiser'], { 'product.update': { email: true } }, LIVE);
    const afterEmail = after.find(c => c.category === 'product.update')?.channels.find(ch => ch.channel === 'email');
    expect(afterEmail).toMatchObject({ available: true, enabled: true });
  });

  it('reflects a stored override in the view', () => {
    const view = resolveNotificationPreferences(['advertiser'], { 'campaign.paused': { email: false } }, LIVE);
    const email = view.find(c => c.category === 'campaign.paused')?.channels.find(ch => ch.channel === 'email');
    expect(email?.enabled).toBe(false);
  });

  it('orders channels in-app before email', () => {
    expect([...NOTIFICATION_CHANNELS]).toEqual(['in_app', 'email']);
  });
});

describe('applyPreferencePatch', () => {
  it('records a valid override and merges with existing prefs', () => {
    const next = applyPreferencePatch(['advertiser'], { 'campaign.paused': { email: false } }, { 'campaign.decision': { email: false } });
    expect(next['campaign.paused']).toEqual({ email: false });
    expect(next['campaign.decision']).toEqual({ email: false });
  });

  it('drops a locked channel (security email is always on, never stored)', () => {
    const next = applyPreferencePatch(['developer'], {}, { 'security.device_linked': { email: false } });
    expect(next['security.device_linked']).toBeUndefined();
  });

  it('drops an unsupported channel and a category outside the user roles', () => {
    const next = applyPreferencePatch(['developer'], {}, {
      'earnings.milestone': { email: true }, // email unsupported for milestones
      'campaign.decision': { email: false }, // advertiser-only, this user is a developer
    });
    expect(next['earnings.milestone']).toBeUndefined();
    expect(next['campaign.decision']).toBeUndefined();
  });
});

describe('notificationPreferenceMapSchema', () => {
  it('accepts a valid partial map', () => {
    const parsed = notificationPreferenceMapSchema.safeParse({ 'payout.settled': { email: false } });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown category or channel, and a non-boolean value', () => {
    expect(notificationPreferenceMapSchema.safeParse({ 'nope.nope': { email: false } }).success).toBe(false);
    expect(notificationPreferenceMapSchema.safeParse({ 'payout.settled': { sms: true } }).success).toBe(false);
    expect(notificationPreferenceMapSchema.safeParse({ 'payout.settled': { email: 'yes' } }).success).toBe(false);
  });
});
