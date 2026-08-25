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

/**
 * Where an admin-defined button shows up in the desktop client.
 *
 * A button is a link, not a script: the client opens the URL in the user's
 * browser. Anything richer would mean shipping admin-authored code to every
 * player's machine, which is a very different trust model from "the operator
 * can add a link to their Discord".
 */
export const CLIENT_BUTTON_PLACEMENT = ['sidebar', 'home', 'game-menu'] as const;

/** Icons an admin can pick for a custom button, mapped to lucide names client-side. */
export const CLIENT_BUTTON_ICONS = [
  'link',
  'message-circle',
  'life-buoy',
  'book-open',
  'gift',
  'shield',
  'star',
  'megaphone',
  'wrench',
  'globe',
] as const;

/**
 * What an API key is allowed to do.
 *
 * Deliberately fine-grained around users: a provisioning integration needs to
 * create accounts, and almost none of them need to be able to mint
 * administrators — so that is its own scope rather than something `users:write`
 * quietly includes.
 */
export const API_SCOPES = [
  'users:read',
  'users:write',
  'users:admin',
  'invites:write',
  'games:read',
  'stats:read',
] as const;

/** Human descriptions, shown beside each checkbox in the admin panel. */
export const API_SCOPE_DESCRIPTIONS: Record<(typeof API_SCOPES)[number], string> = {
  'users:read': 'List and read accounts.',
  'users:write': 'Create, update and deactivate non-admin accounts.',
  'users:admin': 'Create or promote administrators. Grant sparingly.',
  'invites:write': 'Generate invite codes.',
  'games:read': 'List the catalog.',
  'stats:read': 'Read server and usage statistics.',
};

/** Every key is issued with this prefix, so one is recognisable if leaked. */
export const API_KEY_PREFIX = 'gbk_';

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

/**
 * `announcement` is written by an operator and read by everyone; the other
 * three are ordinary posts. Keeping it in the same table is what gives
 * announcements comments, edits and reactions without building any of it twice.
 */
export const POST_KIND = ['text', 'image', 'clip', 'announcement'] as const;

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
  'bug-report',
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

/* -------------------------------------------------------------- requests */

/**
 * Where a player's game request sits in the operator's queue.
 *
 * `pending` is the inbox; the other three are decisions. Kept as a status on
 * one row rather than as separate tables so a request that is denied and later
 * reconsidered keeps its votes and its original wording.
 */
export const GAME_REQUEST_STATUS = ['pending', 'coming-soon', 'added', 'denied'] as const;

export const GAME_REQUEST_STATUS_LABELS: Record<(typeof GAME_REQUEST_STATUS)[number], string> = {
  pending: 'Pending',
  'coming-soon': 'Coming soon',
  added: 'Added',
  denied: 'Denied',
};

/** How many requests one account may have open at once, so the queue stays a queue. */
export const MAX_OPEN_REQUESTS_PER_USER = 20;

/* ----------------------------------------------------------- collections */

/**
 * Colours a player can tag a group with. A fixed set rather than a colour
 * picker: these are rendered as chips against the client's own surfaces, and an
 * arbitrary hex is how you end up with an unreadable one.
 */
export const COLLECTION_COLORS = [
  'blade',
  'violet',
  'emerald',
  'amber',
  'rose',
  'cyan',
  'slate',
] as const;

/** Ceiling on groups per account; the sidebar lists them all. */
export const MAX_COLLECTIONS_PER_USER = 40;

/* ------------------------------------------------------------ client UI */

/** How the desktop library lays its games out. */
export const LIBRARY_VIEW = ['grid', 'list'] as const;

/**
 * Where a bug report has got to.
 *
 * `acknowledged` exists because the most common reason people stop reporting
 * bugs is hearing nothing back; it costs an operator one click and tells the
 * reporter a human has read it.
 */
export const BUG_STATUS = ['open', 'acknowledged', 'fixed', 'not-a-bug', 'duplicate'] as const;

export const BUG_STATUS_LABELS: Record<(typeof BUG_STATUS)[number], string> = {
  open: 'Open',
  acknowledged: 'Looking into it',
  fixed: 'Fixed',
  'not-a-bug': 'Working as intended',
  duplicate: 'Duplicate',
};

/** How severe the reporter says it is. Their words, not a triage decision. */
export const BUG_SEVERITY = ['crash', 'broken', 'annoying', 'cosmetic'] as const;

export const BUG_SEVERITY_LABELS: Record<(typeof BUG_SEVERITY)[number], string> = {
  crash: 'It crashed',
  broken: "Something doesn't work",
  annoying: 'It works but it is painful',
  cosmetic: 'It looks wrong',
};

/* ------------------------------------------------------------------ Discord */

/**
 * What the bot says it is doing, as Discord's own activity types.
 *
 * The numbers are Discord's and cannot be renamed: they are what goes on the
 * wire in a presence update. Type 4 is the odd one — a custom status puts its
 * text in `state` rather than `name`, which the gateway handles rather than
 * making the operator care.
 */
export const DISCORD_ACTIVITY_TYPES = [0, 1, 2, 3, 4, 5] as const;
export type DiscordActivityType = (typeof DISCORD_ACTIVITY_TYPES)[number];

export const DISCORD_ACTIVITY_LABELS: Record<DiscordActivityType, string> = {
  0: 'Playing',
  1: 'Streaming',
  2: 'Listening to',
  3: 'Watching',
  4: 'Custom',
  5: 'Competing in',
};

/** The four presences Discord will show for a bot. */
export const DISCORD_PRESENCE_STATUS = ['online', 'idle', 'dnd', 'invisible'] as const;
export type DiscordPresenceStatus = (typeof DISCORD_PRESENCE_STATUS)[number];

export const DISCORD_PRESENCE_LABELS: Record<DiscordPresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  invisible: 'Invisible',
};

/** Where a running bot is in its connection lifecycle. */
export const DISCORD_BOT_STATES = [
  'stopped',
  'connecting',
  'ready',
  'reconnecting',
  'failed',
] as const;
export type DiscordBotState = (typeof DISCORD_BOT_STATES)[number];

/** Whether a ticket is still being worked. */
export const DISCORD_TICKET_STATUS = ['open', 'closed'] as const;
export type DiscordTicketStatus = (typeof DISCORD_TICKET_STATUS)[number];

/**
 * The largest attachment the panel will send to Discord.
 *
 * Discord's own ceiling for an unboosted server is 25 MB, but an announcement
 * image has no business being anywhere near that, and the cap is what stops a
 * mis-picked video sitting in the request body for a minute before Discord
 * refuses it.
 */
export const MAX_DISCORD_ATTACHMENT_BYTES = 8 * 1024 * 1024;
