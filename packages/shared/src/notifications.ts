import { z } from 'zod';
import type { UserRole } from './types.js';

/*
  The notification contract: what a notification IS, who receives it, and where it may go.

  This is the single source of truth shared by dispatch (server), the preferences API, and the
  settings UI, so a category can never mean two different things in two places. See
  docs/NOTIFICATIONS.md for the full design.

  Extending it later needs no structural change downstream:
    - a new notification -> add one member to NOTIFICATION_CATEGORY_IDS and one NOTIFICATION_CATEGORIES entry.
    - a new channel      -> add one member to NOTIFICATION_CHANNELS; each category opts in per-channel.
*/

/* ── Channels ─────────────────────────────────────────────────────────────────
   How a person receives a notification. `in_app` is the durable feed; `email` is delivered mail.
   The array is the single source: the union type, the zod enum, and the settings-grid column order
   all derive from it. */
export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/** Which sending reputation an email rides. Transactional ships on the root domain now; marketing is
 *  isolated on its own subdomain and stays deferred until that exists (docs/NOTIFICATIONS.md §0.2). */
export type EmailStream = 'transactional' | 'marketing';

/** The cluster a category sits in on the settings grid. Presentation only, no behaviour. */
export type NotificationGroup = 'security' | 'money' | 'campaigns' | 'updates';

/* ── Categories ───────────────────────────────────────────────────────────────
   Every notification kind, namespaced by domain so related ones sort together. The array drives the
   union type, the zod enum, and the grid order; the registry below must supply every id (the
   Record type enforces it). */
export const NOTIFICATION_CATEGORY_IDS = [
  'security.device_linked',
  'security.credential_changed',
  'payout.settled',
  'earnings.milestone',
  'campaign.decision',
  'campaign.paused',
  'wallet.low_balance',
  'product.update',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORY_IDS)[number];
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORY_IDS);

/**
 * A channel's policy for one category. This one field carries "supported?", "default?", and
 * "locked?" with no redundant flags:
 *   - the channel is ABSENT from a category's `channels` map -> unsupported (never offered, never sent)
 *   - 'off'    -> supported, default off, the user may turn it on
 *   - 'on'     -> supported, default on, the user may turn it off
 *   - 'locked' -> supported, always on, the user cannot turn it off
 */
export type ChannelPolicy = 'off' | 'on' | 'locked';

/** The immutable description of a notification kind. NOTIFICATION_CATEGORIES is the only place these live. */
export interface NotificationCategoryDef {
  category: NotificationCategory;
  group: NotificationGroup;
  /** Settings-grid label and one-line description. Copy travels with the category (VOICE.md applies). */
  label: string;
  description: string;
  /** Who receives it. 'all' = every signed-in user; otherwise the user's roles must intersect this. */
  roles: readonly UserRole[] | 'all';
  /** Per-channel policy. A channel absent here is unsupported for this category. See ChannelPolicy. */
  channels: Partial<Record<NotificationChannel, ChannelPolicy>>;
  /** The reputation an email of this category rides. Only consulted when `channels.email` is set. */
  emailStream: EmailStream;
}

/**
 * The v1 notification set (docs/NOTIFICATIONS.md §1). Insertion order is the settings-grid order.
 * Email is reserved for money and security; delight and "nice to know" stay in-app - the whole
 * sender-reputation strategy, expressed as data.
 */
export const NOTIFICATION_CATEGORIES: Record<NotificationCategory, NotificationCategoryDef> = {
  'security.device_linked': {
    category: 'security.device_linked',
    group: 'security',
    label: 'New device linked',
    description: 'A new machine can now earn on your account.',
    roles: 'all',
    channels: { in_app: 'on', email: 'locked' },
    emailStream: 'transactional',
  },
  'security.credential_changed': {
    category: 'security.credential_changed',
    group: 'security',
    label: 'Password or sign-in changed',
    description: 'Your password or a connected sign-in method changed.',
    roles: 'all',
    channels: { in_app: 'on', email: 'locked' },
    emailStream: 'transactional',
  },
  'payout.settled': {
    category: 'payout.settled',
    group: 'money',
    label: 'Payout sent or failed',
    description: 'When a payout reaches your bank, or could not be sent.',
    roles: ['developer'],
    channels: { in_app: 'on', email: 'on' },
    emailStream: 'transactional',
  },
  'earnings.milestone': {
    category: 'earnings.milestone',
    group: 'money',
    label: 'Earning milestones',
    description: 'Your first earnings and earning streaks.',
    roles: ['developer'],
    // In-app delight only. Email is deliberately not offered: not something a person wants in a inbox.
    channels: { in_app: 'on' },
    emailStream: 'transactional',
  },
  'campaign.decision': {
    category: 'campaign.decision',
    group: 'campaigns',
    label: 'Campaign approved or needs changes',
    description: 'The review decision on a campaign you submitted.',
    roles: ['advertiser'],
    channels: { in_app: 'on', email: 'on' },
    emailStream: 'transactional',
  },
  'campaign.paused': {
    category: 'campaign.paused',
    group: 'campaigns',
    label: 'Campaign paused',
    description: 'A campaign stopped because its daily budget or your balance ran out.',
    roles: ['advertiser'],
    channels: { in_app: 'on', email: 'on' },
    emailStream: 'transactional',
  },
  'wallet.low_balance': {
    category: 'wallet.low_balance',
    group: 'campaigns',
    label: 'Low wallet balance',
    description: 'A heads-up before a low balance pauses your campaigns.',
    roles: ['advertiser'],
    channels: { in_app: 'on', email: 'off' },
    emailStream: 'transactional',
  },
  'product.update': {
    category: 'product.update',
    group: 'updates',
    label: 'Product updates',
    description: 'Occasional news about what is new.',
    roles: 'all',
    channels: { in_app: 'on', email: 'off' },
    emailStream: 'marketing',
  },
};

/**
 * A user's STORED overrides. Sparse on purpose: a category or channel that is absent falls back to
 * the registry default, so shipping a new category never needs a migration of everyone's prefs.
 * Locked and unsupported channels are never stored (the server strips them on write).
 */
export type NotificationPreferenceMap = Partial<
  Record<NotificationCategory, Partial<Record<NotificationChannel, boolean>>>
>;

/** Validates a preferences PATCH body. Shape only - the server still ignores locked/unsupported channels. */
export const notificationPreferenceMapSchema = z.record(
  notificationCategorySchema,
  z.record(notificationChannelSchema, z.boolean()),
);

/* ── Resolution ───────────────────────────────────────────────────────────────
   The rules that turn a registry + a user's roles + their stored overrides into concrete answers.
   Kept here (not in the server) so the dispatch decision and the settings UI can never disagree. */

export interface ResolveOptions {
  /** Whether the marketing email stream has a live sending path yet. Until true, marketing email is
   *  shown as unavailable ("Soon") and never dispatched. See docs/NOTIFICATIONS.md §0.2. */
  marketingEmailLive: boolean;
}

/** Whether a category is offered to a user with these roles. */
export function categoryAppliesToRoles(def: NotificationCategoryDef, roles: readonly UserRole[]): boolean {
  return def.roles === 'all' || def.roles.some(role => roles.includes(role));
}

/** The categories a user with these roles sees, in grid order. */
export function categoriesForRoles(roles: readonly UserRole[]): NotificationCategoryDef[] {
  return NOTIFICATION_CATEGORY_IDS.map(id => NOTIFICATION_CATEGORIES[id]).filter(def =>
    categoryAppliesToRoles(def, roles),
  );
}

/** Whether a channel exists for a category AND (for marketing email) has a live path yet. */
function channelAvailable(
  def: NotificationCategoryDef,
  channel: NotificationChannel,
  options: ResolveOptions,
): boolean {
  if (def.channels[channel] === undefined) return false;
  if (channel === 'email' && def.emailStream === 'marketing') return options.marketingEmailLive;
  return true;
}

/**
 * The effective on/off of a channel from PREFERENCES alone: the registry default, overridden by the
 * user, except a 'locked' channel which is always on. Ignores availability - use `shouldDeliver`
 * for the dispatch decision, which also respects a not-yet-live marketing stream.
 */
export function channelEnabled(
  category: NotificationCategory,
  channel: NotificationChannel,
  stored: NotificationPreferenceMap,
): boolean {
  const policy = NOTIFICATION_CATEGORIES[category].channels[channel];
  if (policy === undefined) return false;
  if (policy === 'locked') return true;
  return stored[category]?.[channel] ?? policy === 'on';
}

/** The dispatch decision: deliver this category on this channel? Availability AND preference. */
export function shouldDeliver(
  category: NotificationCategory,
  channel: NotificationChannel,
  stored: NotificationPreferenceMap,
  options: ResolveOptions,
): boolean {
  const def = NOTIFICATION_CATEGORIES[category];
  return channelAvailable(def, channel, options) && channelEnabled(category, channel, stored);
}

export interface ResolvedChannelState {
  channel: NotificationChannel;
  /** Currently on. */
  enabled: boolean;
  /** Forced on; the user cannot change it. */
  locked: boolean;
  /** Supported but not operable yet (marketing email before its subdomain). Render as "Soon". */
  available: boolean;
}

export interface ResolvedNotificationCategory {
  category: NotificationCategory;
  group: NotificationGroup;
  label: string;
  description: string;
  /** Only the channels this category supports, in channel order, with their resolved state. */
  channels: ResolvedChannelState[];
}

/**
 * The full view for the preferences API and the settings grid: the categories a user sees, each with
 * its supported channels resolved to enabled/locked/available. One function, so the API response and
 * the UI can never disagree about what a user may change.
 */
export function resolveNotificationPreferences(
  roles: readonly UserRole[],
  stored: NotificationPreferenceMap,
  options: ResolveOptions,
): ResolvedNotificationCategory[] {
  return categoriesForRoles(roles).map(def => ({
    category: def.category,
    group: def.group,
    label: def.label,
    description: def.description,
    channels: NOTIFICATION_CHANNELS.filter(channel => def.channels[channel] !== undefined).map(channel => {
      const available = channelAvailable(def, channel, options);
      return {
        channel,
        locked: def.channels[channel] === 'locked',
        available,
        enabled: available && channelEnabled(def.category, channel, stored),
      };
    }),
  }));
}

/* ── Wire types: the in-app notification feed API ───────────────────────────── */

/** One notification as GET /v1/notifications returns it: the durable row, projected for the client. */
export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  href: string | null;
  /** ISO-8601. */
  createdAt: string;
  read: boolean;
}

/** GET /v1/notifications. `nextCursor` is absent when there are no older items. */
export interface NotificationListResponse {
  items: NotificationItem[];
  unreadCount: number;
  nextCursor?: string;
}

/** POST /v1/notifications/read: mark specific ids read, or all of them. Idempotent. */
export const notificationReadRequestSchema = z.union([
  z.object({ ids: z.array(z.string().min(1)).min(1) }),
  z.object({ all: z.literal(true) }),
]);
export type NotificationReadRequest = z.infer<typeof notificationReadRequestSchema>;

/** POST /v1/notifications/read response: the new unread total, for the badge. */
export interface NotificationReadResponse {
  unreadCount: number;
}

/* ── Preferences API ────────────────────────────────────────────────────────── */

/** GET/PATCH /v1/notifications/preferences: the resolved grid the settings UI renders. */
export interface NotificationPreferencesResponse {
  categories: ResolvedNotificationCategory[];
}

/**
 * Fold a PATCH into a user's stored preferences and keep the result honest: drop channels the user may
 * not actually set (a `locked` one is always on; an absent one is unsupported) and categories outside
 * their roles. The write-side counterpart to resolveNotificationPreferences - together they guarantee
 * the stored blob can never contradict the registry.
 */
export function applyPreferencePatch(
  roles: readonly UserRole[],
  current: NotificationPreferenceMap,
  patch: NotificationPreferenceMap,
): NotificationPreferenceMap {
  const next: NotificationPreferenceMap = {};
  for (const [category, channels] of Object.entries(current) as [NotificationCategory, NotificationPreferenceMap[NotificationCategory]][]) {
    if (channels) next[category] = { ...channels };
  }
  for (const [category, channels] of Object.entries(patch) as [NotificationCategory, NotificationPreferenceMap[NotificationCategory]][]) {
    const def = NOTIFICATION_CATEGORIES[category];
    if (!def || !categoryAppliesToRoles(def, roles) || !channels) continue;
    for (const [channel, value] of Object.entries(channels) as [NotificationChannel, boolean][]) {
      const policy = def.channels[channel];
      if (policy === undefined || policy === 'locked') continue; // unsupported or forced-on: not user-settable
      next[category] = { ...next[category], [channel]: value };
    }
  }
  return next;
}
