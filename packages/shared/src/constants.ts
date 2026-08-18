/** Cookie holding the opaque web session token. */
export const SESSION_COOKIE = 'gb_session';

/**
 * Required on every state-changing request from the browser. Its mere presence
 * defeats cross-origin form posts, which cannot set custom headers without a
 * successful CORS preflight.
 */
export const CSRF_HEADER = 'x-gameblade-csrf';

/** Desktop clients identify themselves so the server can issue a device token. */
export const CLIENT_HEADER = 'x-gameblade-client';

/** Archive extensions treated as a single-file game during a library scan. */
export const ARCHIVE_EXTENSIONS = [
  '.zip',
  '.7z',
  '.rar',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.tar.zst',
  '.tar.xz',
  '.iso',
  '.gz',
  '.xz',
  '.zst',
] as const;

/** Files ignored while walking a library. */
export const IGNORED_ENTRIES = [
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '@eadir',
  '#recycle',
  '.recycle',
  'lost+found',
  '$recycle.bin',
  'system volume information',
] as const;

export const ROLES = ['admin', 'user'] as const;

export const MATCH_STATUS = ['unmatched', 'auto', 'manual', 'skipped'] as const;

export const GAME_KIND = ['folder', 'archive'] as const;

/**
 * Every image slot a game has. `banner` is the wide Steam-style capsule, kept
 * separate from `cover` because the two are different shapes with different
 * artwork on SteamGridDB — asking for one and getting the other is exactly the
 * mismatch the picker exists to fix.
 */
export const ART_KIND = ['cover', 'banner', 'hero', 'logo', 'icon'] as const;

/**
 * SteamGridDB publishes a style per asset, and which styles exist depends on
 * the asset type. Offering them as a filter is what makes the picker usable
 * for a specific look — a text-only wordmark, or a capsule with no logo baked
 * in — rather than an undifferentiated wall of images.
 */
export const ART_STYLES: Record<(typeof ART_KIND)[number], readonly string[]> = {
  cover: ['alternate', 'blurred', 'white_logo', 'material', 'no_logo'],
  banner: ['alternate', 'blurred', 'white_logo', 'material', 'no_logo'],
  hero: ['alternate', 'blurred', 'material'],
  logo: ['official', 'white', 'black', 'custom'],
  icon: ['official', 'custom'],
};

/** Human labels for the styles above; anything unlisted falls back to its key. */
export const ART_STYLE_LABELS: Record<string, string> = {
  alternate: 'Alternate',
  blurred: 'Blurred',
  white_logo: 'White logo',
  material: 'Material',
  no_logo: 'No logo',
  official: 'Official',
  white: 'White text',
  black: 'Black text',
  custom: 'Custom',
};

/**
 * The gaps an administrator hunts for in the catalog: a game nobody can launch,
 * one whose saves are never synced, one with no art. Each maps to a filter on
 * the admin catalog and to an indicator on every row, so the same vocabulary
 * describes "show me what is broken" and "what is broken about this one".
 */
export const CATALOG_GAP = [
  'launch-rule',
  'save-rule',
  'cover',
  'banner',
  'hero',
  'logo',
  'icon',
  'artwork',
  'achievements',
  'metadata',
] as const;

/** Default lifetime of a browser session, in days. */
export const SESSION_TTL_DAYS = 30;

/** Default lifetime of a desktop device token, in days. */
export const DEVICE_TOKEN_TTL_DAYS = 90;

/** Download tokens are single-purpose and short lived. */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 60 * 60 * 6;

/** Who may see a profile, its activity and its posts. */
export const VISIBILITY = ['public', 'friends', 'private'] as const;

/**
 * A friendship row is directional (requester → addressee) but `accepted` and
 * `blocked` are read in both directions, so queries always match on either side.
 */
export const FRIENDSHIP_STATUS = ['pending', 'accepted', 'blocked'] as const;

/** What the desktop client reports it is doing, broadcast to friends. */
export const PRESENCE_STATUS = ['offline', 'online', 'away', 'in-game'] as const;

export const POST_KIND = ['text', 'image', 'clip'] as const;

export const MEDIA_KIND = ['avatar', 'banner', 'image', 'clip'] as const;

/** Everything that can land in a friend's activity feed. */
export const ACTIVITY_KIND = [
  'played',
  'added-game',
  'unlocked-achievement',
  'posted',
  'friended',
] as const;

export const NOTIFICATION_KIND = [
  'friend-request',
  'friend-accepted',
  'post-comment',
  'post-reaction',
  'achievement',
  'announcement',
] as const;

/** Where an achievement definition came from, shown in the admin editor. */
export const ACHIEVEMENT_SOURCE = ['steam', 'retroachievements', 'manual'] as const;

/**
 * How a save conflict was settled. `local`/`remote` are user choices; `merged`
 * means both sides were kept as separate versions for manual recovery.
 */
export const SAVE_CONFLICT_RESOLUTION = ['local', 'remote', 'merged'] as const;

/** Reactions the social tab offers; a fixed set keeps rendering cheap. */
export const REACTIONS = ['like', 'love', 'fire', 'laugh', 'wow', 'sad'] as const;

/** Ceiling on a single uploaded image, in bytes. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Ceiling on a single uploaded clip, in bytes. */
export const MAX_CLIP_BYTES = 512 * 1024 * 1024;

/**
 * Ceiling on the Windows client installer an admin uploads. Generous, because
 * an NSIS bundle with a webview runtime folded in is not small.
 */
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

/** Ceiling on one uploaded save archive, in bytes. */
export const MAX_SAVE_BYTES = 512 * 1024 * 1024;

/** Save versions retained per slot before the oldest is pruned. */
export const SAVE_VERSIONS_KEPT = 10;

/** WebSocket path used for presence, activity and notifications. */
export const REALTIME_PATH = '/api/realtime';

/**
 * Clients ping this often; the server drops a connection that misses two in a
 * row, so presence never sticks at "online" after a hard disconnect.
 */
export const REALTIME_HEARTBEAT_SECONDS = 25;
