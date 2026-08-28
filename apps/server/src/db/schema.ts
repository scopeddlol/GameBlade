import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    /** Lower-cased username, kept unique so logins are case-insensitive. */
    usernameLower: text('username_lower').notNull(),
    email: text('email'),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
    lastLoginAt: text('last_login_at'),
    /**
     * Monthly download allowance in MB, overriding the server default.
     * Null means "use the default"; 0 means "unlimited for this account".
     */
    monthlyQuotaMb: integer('monthly_quota_mb'),
  },
  (t) => [uniqueIndex('users_username_lower_idx').on(t.usernameLower)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 of the opaque token; the raw token never touches the database. */
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: text('created_at').notNull().default(now),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at'),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/** Long-lived, individually revocable tokens issued to desktop clients. */
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull(),
    platform: text('platform'),
    createdAt: text('created_at').notNull().default(now),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (t) => [
    uniqueIndex('devices_token_hash_idx').on(t.tokenHash),
    index('devices_user_idx').on(t.userId),
    /** Sweeping devices that have not checked in, without a table scan. */
    index('devices_last_seen_idx').on(t.lastSeenAt),
  ],
);

export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    note: text('note'),
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(now),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [uniqueIndex('invites_code_idx').on(t.code)],
);

/**
 * A single-use password reset an admin hands to a player who cannot sign in.
 *
 * Stored hashed, like a session token: the link is the credential, so a copy of
 * the database must not yield working ones.
 */
export const passwordResets = sqliteTable(
  'password_resets',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(now),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
  },
  (t) => [
    index('password_resets_user_idx').on(t.userId),
    index('password_resets_expires_idx').on(t.expiresAt),
  ],
);

export const libraries = sqliteTable(
  'libraries',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
    lastScanAt: text('last_scan_at'),
    lastScanStatus: text('last_scan_status'),
  },
  (t) => [uniqueIndex('libraries_path_idx').on(t.path)],
);

export const games = sqliteTable(
  'games',
  {
    id: text('id').primaryKey(),
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    /** Path relative to the library root, forward-slashed. */
    relPath: text('rel_path').notNull(),
    kind: text('kind', { enum: ['folder', 'archive'] }).notNull(),

    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    /** Cleaned name used for provider lookups. */
    searchTitle: text('search_title').notNull(),

    sizeBytes: integer('size_bytes').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    /** Newest mtime across the game's files, used to skip unchanged entries. */
    contentMtime: text('content_mtime'),

    matchStatus: text('match_status', {
      enum: ['unmatched', 'auto', 'manual', 'skipped'],
    })
      .notNull()
      .default('unmatched'),
    igdbId: integer('igdb_id'),
    sgdbId: integer('sgdb_id'),
    /** Enables importing the public Steam achievement schema for this game. */
    steamAppId: integer('steam_app_id'),

    summary: text('summary'),
    storyline: text('storyline'),
    releaseDate: text('release_date'),
    rating: integer('rating'),
    developers: text('developers', { mode: 'json' }).$type<string[]>(),
    publishers: text('publishers', { mode: 'json' }).$type<string[]>(),
    genres: text('genres', { mode: 'json' }).$type<string[]>(),
    platforms: text('platforms', { mode: 'json' }).$type<string[]>(),
    screenshots: text('screenshots', { mode: 'json' }).$type<string[]>(),
    videos: text('videos', { mode: 'json' }).$type<string[]>(),

    coverImageId: text('cover_image_id'),
    /** Wide Steam-style capsule; the portrait cover lives in coverImageId. */
    bannerImageId: text('banner_image_id'),
    heroImageId: text('hero_image_id'),
    logoImageId: text('logo_image_id'),
    iconImageId: text('icon_image_id'),

    addedAt: text('added_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    scannedAt: text('scanned_at'),
    /** Set when the files vanish; kept so metadata survives a temporary unmount. */
    missingAt: text('missing_at'),
    /**
     * Set the moment a provider writes metadata onto this game.
     *
     * Enrichment is a first-time job, not something every scan redoes. Once
     * this is stamped the automatic pass leaves the row alone, so a title
     * corrected by hand — or artwork chosen deliberately — survives the next
     * scan. Clearing it puts the game back in the queue.
     */
    metadataLockedAt: text('metadata_locked_at'),
  },
  (t) => [
    uniqueIndex('games_library_relpath_idx').on(t.libraryId, t.relPath),
    index('games_sort_title_idx').on(t.sortTitle),
    index('games_match_status_idx').on(t.matchStatus),
    index('games_missing_idx').on(t.missingAt),
    index('games_metadata_lock_idx').on(t.metadataLockedAt),
    // Every shelf and every library page filters on "not missing" and then
    // sorts. Leading each of these with missingAt is what lets the index
    // supply the ordering too, instead of SQLite sorting the survivors itself.
    index('games_live_sort_title_idx').on(t.missingAt, t.sortTitle),
    index('games_live_added_idx').on(t.missingAt, t.addedAt),
    index('games_live_rating_idx').on(t.missingAt, t.rating),
    index('games_live_size_idx').on(t.missingAt, t.sizeBytes),
    index('games_live_released_idx').on(t.missingAt, t.releaseDate),
    /** The enrichment queue's exact filter, run at the end of every scan. */
    index('games_pending_meta_idx').on(t.missingAt, t.metadataLockedAt, t.matchStatus),
    index('games_igdb_idx').on(t.igdbId),
    index('games_steam_app_idx').on(t.steamAppId),
  ],
);

export const gameFiles = sqliteTable(
  'game_files',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    /** Path relative to the game root; a single '.'-free name for archives. */
    relPath: text('rel_path').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    modifiedAt: text('modified_at').notNull(),
    /** Computed lazily on first desktop download so scans stay fast. */
    sha256: text('sha256'),
    /**
     * What the last verification run concluded, or null if none has run.
     *
     * `ok` the bytes still hash to what was recorded; `mismatch` they do not,
     * which for an archive is corruption rather than an edit; `missing` the
     * file is gone.
     */
    integrity: text('integrity', { enum: ['ok', 'mismatch', 'missing'] }),
    verifiedAt: text('verified_at'),
    /** When per-chunk hashes were last computed; null means never. */
    chunkedAt: text('chunked_at'),
    /**
     * The grid those hashes were computed on.
     *
     * Recorded rather than assumed: if the constant ever changes, rows hashed
     * on the old grid are identifiable and re-hashable instead of silently
     * verifying arriving bytes against boundaries nobody uses any more.
     */
    chunkBytes: integer('chunk_bytes'),
  },
  (t) => [
    uniqueIndex('game_files_game_relpath_idx').on(t.gameId, t.relPath),
    index('game_files_game_idx').on(t.gameId),
  ],
);

/**
 * Content-addressed pieces of a file, on the fixed `MESH_CHUNK_BYTES` grid.
 *
 * There is deliberately no offset column: the index times the grid size is the
 * offset, and a stored offset is one more thing that can contradict it.
 */
export const gameFileChunks = sqliteTable(
  'game_file_chunks',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => gameFiles.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fileId, t.chunkIndex] }),
    index('game_file_chunks_sha_idx').on(t.sha256),
  ],
);

/** Locally cached provider artwork, addressed by content hash. */
export const images = sqliteTable(
  'images',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: ['cover', 'banner', 'hero', 'logo', 'icon', 'screenshot'],
    }).notNull(),
    sourceUrl: text('source_url').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('images_source_url_idx').on(t.sourceUrl)],
);

export const userGameState = sqliteTable(
  'user_game_state',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
    lastDownloadedAt: text('last_downloaded_at'),
  },
  (t) => [uniqueIndex('user_game_state_pk').on(t.userId, t.gameId)],
);

export const downloadEvents = sqliteTable(
  'download_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    gameId: text('game_id').references(() => games.id, { onDelete: 'set null' }),
    fileId: text('file_id'),
    /**
     * The download this file belongs to.
     *
     * A game is fetched as many files, one event each. Without this every
     * count over the table measured files rather than downloads.
     */
    sessionId: text('session_id'),
    client: text('client').notNull().default('web'),
    bytesSent: integer('bytes_sent').notNull().default(0),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
    completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('download_events_user_idx').on(t.userId),
    index('download_events_game_idx').on(t.gameId),
    index('download_events_session_idx').on(t.sessionId),
  ],
);

/* ---------------------------------------------------------------------- mesh */

/**
 * A machine that can serve game bytes directly to a client.
 *
 * A node is known by its public key rather than by its address: the address of
 * a machine on a residential connection changes whenever the lease renews, and
 * an identity that changed with it would be no identity at all.
 */
export const meshNodes = sqliteTable(
  'mesh_nodes',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    role: text('role', { enum: ['origin', 'mirror', 'peer'] })
      .notNull()
      .default('mirror'),
    status: text('status', { enum: ['pending', 'online', 'stale', 'blocked'] })
      .notNull()
      .default('pending'),
    /** Base64url Ed25519 public key; the node's identity on the wire. */
    publicKey: text('public_key').notNull(),
    /**
     * The node's API credential, hashed.
     *
     * Not derived from the public key: that is published to clients so they can
     * check who they are talking to, and a credential computable from it would
     * be no credential at all.
     */
    tokenHash: text('token_hash').notNull(),
    /** Set for peer nodes, so somebody's seeding dies with their account. */
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    agentVersion: text('agent_version'),
    lastSeenAt: text('last_seen_at'),
    bytesServed: integer('bytes_served').notNull().default(0),
    /**
     * Which library this node's catalog reports land in.
     *
     * Games are matched within a library by relative path, so reporting into
     * the existing library updates the rows already there and preserves every
     * game id — and everything attached to one. Assigned by an administrator
     * rather than guessed, because guessing wrong re-adds the whole catalog as
     * new games and orphans the metadata on the old ones.
     */
    libraryId: text('library_id').references(() => libraries.id, { onDelete: 'set null' }),
    catalogReportedAt: text('catalog_reported_at'),
    catalogStatus: text('catalog_status'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('mesh_nodes_public_key_idx').on(t.publicKey),
    index('mesh_nodes_status_idx').on(t.status),
    index('mesh_nodes_owner_idx').on(t.ownerId),
  ],
);

/** Every address a node believes it might be reachable on. */
export const meshNodeEndpoints = sqliteTable(
  'mesh_node_endpoints',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => meshNodes.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['local', 'observed', 'configured'] }).notNull(),
    address: text('address').notNull(),
    port: integer('port').notNull(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.address, t.port] })],
);

/**
 * Which games a node claims a complete copy of.
 *
 * Deliberately per game rather than per chunk: per-chunk would be a row per
 * 8 MiB on the machine with the least disk, and the chunk hashes already make
 * an over-claim harmless — bytes that do not verify are rejected regardless of
 * what the index promised.
 */
export const meshNodeGames = sqliteTable(
  'mesh_node_games',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => meshNodes.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    /** The manifest this copy was verified against. */
    contentHash: text('content_hash').notNull(),
    announcedAt: text('announced_at').notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.gameId] }),
    index('mesh_node_games_game_idx').on(t.gameId),
  ],
);

/** One-time codes that turn a machine into a node. Hashed, never stored raw. */
export const meshEnrollments = sqliteTable('mesh_enrollments', {
  tokenHash: text('token_hash').primaryKey(),
  label: text('label').notNull(),
  role: text('role', { enum: ['origin', 'mirror', 'peer'] })
    .notNull()
    .default('mirror'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(now),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  nodeId: text('node_id').references(() => meshNodes.id, { onDelete: 'set null' }),
});

/**
 * What a node reported serving, against the grant that authorised it.
 *
 * Keyed by the grant's nonce so a replayed report cannot double-charge an
 * account or inflate a node's numbers.
 */
export const meshTransfers = sqliteTable(
  'mesh_transfers',
  {
    nonce: text('nonce').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => meshNodes.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    gameId: text('game_id').references(() => games.id, { onDelete: 'set null' }),
    bytesServed: integer('bytes_served').notNull().default(0),
    issuedAt: text('issued_at').notNull().default(now),
    reportedAt: text('reported_at'),
  },
  (t) => [
    index('mesh_transfers_user_idx').on(t.userId, t.issuedAt),
    index('mesh_transfers_node_idx').on(t.nodeId),
  ],
);

/** Free-form key/value store for runtime settings and provider credentials. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

/* ------------------------------------------------------------------ profiles */

/**
 * One row per account, created alongside the user. Split from `users` so the
 * social surface can be read without touching password hashes.
 */
export const userProfiles = sqliteTable(
  'user_profiles',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    bio: text('bio'),
    accentColor: text('accent_color').notNull().default('#7c5cff'),
    country: text('country'),
    avatarMediaId: text('avatar_media_id'),
    bannerMediaId: text('banner_media_id'),
    /**
     * How they would like to be referred to. Free text rather than a fixed
     * list: no list is complete, and one that is not gets it wrong for
     * exactly the people it matters most to.
     */
    pronouns: text('pronouns'),
    /** One line, under the name. Not the bio — this is "what, right now". */
    tagline: text('tagline'),
    /**
     * Where the banner is cropped, 0–100, as a CSS `object-position` share.
     *
     * A banner is a wide crop of a much taller image, and which band of it
     * survives is the whole difference between a good one and a beheading.
     */
    bannerPosition: integer('banner_position').notNull().default(50),
    /**
     * Up to a handful of labelled links.
     *
     * JSON on the row rather than a table: they are read only as a set, never
     * queried across, and a table would mean a join on every profile read for
     * something with a hard cap of five.
     */
    links: text('links', { mode: 'json' }).$type<Array<{ label: string; url: string }>>(),
    /** A game they want on their profile, whatever their playtime says. */
    favoriteGameId: text('favorite_game_id').references(() => games.id, { onDelete: 'set null' }),
    visibility: text('visibility', { enum: ['public', 'friends', 'private'] })
      .notNull()
      .default('friends'),
    /** When false, friends see the profile but never what is being played. */
    showActivity: integer('show_activity', { mode: 'boolean' }).notNull().default(true),
    /** Persisted so an offline friend still shows "last seen 2h ago". */
    lastSeenAt: text('last_seen_at'),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('user_profiles_display_name_idx').on(t.displayName)],
);

/**
 * Directional request that becomes a symmetric friendship once accepted. The
 * pair is stored with the lower id first so the unique index rejects duplicate
 * requests sent in opposite directions.
 */
export const friendships = sqliteTable(
  'friendships',
  {
    id: text('id').primaryKey(),
    /** Lower of the two user ids; keeps the pair index canonical. */
    userAId: text('user_a_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userBId: text('user_b_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which side sent the request, since the pair itself is order-free. */
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'accepted', 'blocked'] })
      .notNull()
      .default('pending'),
    createdAt: text('created_at').notNull().default(now),
    respondedAt: text('responded_at'),
  },
  (t) => [
    uniqueIndex('friendships_pair_idx').on(t.userAId, t.userBId),
    index('friendships_user_a_idx').on(t.userAId),
    index('friendships_user_b_idx').on(t.userBId),
    index('friendships_status_idx').on(t.status),
  ],
);

/* ------------------------------------------------------- library and playtime */

/** Games a user has added from the Store. The Store is everything else. */
export const userLibrary = sqliteTable(
  'user_library',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('user_library_pk').on(t.userId, t.gameId),
    index('user_library_user_idx').on(t.userId),
  ],
);

export const playSessions = sqliteTable(
  'play_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    deviceId: text('device_id'),
    startedAt: text('started_at').notNull().default(now),
    endedAt: text('ended_at'),
    seconds: integer('seconds').notNull().default(0),
  },
  (t) => [
    index('play_sessions_user_idx').on(t.userId),
    index('play_sessions_game_idx').on(t.gameId),
    index('play_sessions_open_idx').on(t.userId, t.endedAt),
  ],
);

/**
 * Rolling totals maintained as sessions close. Denormalized on purpose: Home
 * and Library sort by playtime on every render and must not aggregate live.
 */
export const userGameStats = sqliteTable(
  'user_game_stats',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    totalSeconds: integer('total_seconds').notNull().default(0),
    launchCount: integer('launch_count').notNull().default(0),
    lastPlayedAt: text('last_played_at'),
  },
  (t) => [
    uniqueIndex('user_game_stats_pk').on(t.userId, t.gameId),
    index('user_game_stats_last_played_idx').on(t.userId, t.lastPlayedAt),
    // The most-played shelf groups by game across every account; both of the
    // indexes above lead with the user, so neither helps it.
    index('user_game_stats_game_idx').on(t.gameId),
  ],
);

/* -------------------------------------------------------------- achievements */

export const achievements = sqliteTable(
  'achievements',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    /** Provider-stable identifier; re-imports match on this rather than name. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    iconUrl: text('icon_url'),
    points: integer('points').notNull().default(10),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    globalPercent: integer('global_percent'),
    source: text('source', { enum: ['steam', 'retroachievements', 'manual'] })
      .notNull()
      .default('manual'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('achievements_game_key_idx').on(t.gameId, t.key),
    index('achievements_game_idx').on(t.gameId),
  ],
);

export const userAchievements = sqliteTable(
  'user_achievements',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    achievementId: text('achievement_id')
      .notNull()
      .references(() => achievements.id, { onDelete: 'cascade' }),
    /** Null while only partial progress has been reported. */
    unlockedAt: text('unlocked_at'),
    progress: integer('progress'),
  },
  (t) => [
    uniqueIndex('user_achievements_pk').on(t.userId, t.achievementId),
    index('user_achievements_user_idx').on(t.userId, t.unlockedAt),
    /** "How many people have this one?", which reads by achievement. */
    index('user_achievements_achievement_idx').on(t.achievementId),
  ],
);

/* --------------------------------------------------------------- cloud saves */

export const saveSlots = sqliteTable(
  'save_slots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('default'),
    currentVersionId: text('current_version_id'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('save_slots_user_game_name_idx').on(t.userId, t.gameId, t.name),
    index('save_slots_user_idx').on(t.userId),
  ],
);

/**
 * Each upload is an immutable zip on disk. Keeping history is what makes a bad
 * sync recoverable, so versions are pruned by count rather than overwritten.
 */
export const saveVersions = sqliteTable(
  'save_versions',
  {
    id: text('id').primaryKey(),
    slotId: text('slot_id')
      .notNull()
      .references(() => saveSlots.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    fileCount: integer('file_count').notNull().default(0),
    deviceId: text('device_id'),
    /** Newest mtime inside the archive, which orders local against remote. */
    capturedAt: text('captured_at').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('save_versions_slot_idx').on(t.slotId, t.createdAt),
    index('save_versions_sha_idx').on(t.sha256),
    /** Retention sweeps read by age across every slot. */
    index('save_versions_created_idx').on(t.createdAt),
  ],
);

/** Admin-authored hint for where a game keeps its saves on Windows. */
export const gameSaveRules = sqliteTable(
  'game_save_rules',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    pathTemplate: text('path_template').notNull(),
    include: text('include'),
    exclude: text('exclude'),
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('game_save_rules_game_idx').on(t.gameId)],
);

/** Admin-authored hint for what to run once a game is installed. */
export const gameLaunchRules = sqliteTable(
  'game_launch_rules',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    executable: text('executable'),
    args: text('args'),
    workingDir: text('working_dir'),
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('game_launch_rules_game_idx').on(t.gameId)],
);

/* ------------------------------------------------------------ social content */

/** User-uploaded avatars, banners, screenshots and clips. */
export const media = sqliteTable(
  'media',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['avatar', 'banner', 'image', 'clip'] }).notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('media_owner_idx').on(t.ownerId), index('media_sha_idx').on(t.sha256)],
);

export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['text', 'image', 'clip', 'announcement'] })
      .notNull()
      .default('text'),
    title: text('title'),
    body: text('body'),
    gameId: text('game_id').references(() => games.id, { onDelete: 'set null' }),
    visibility: text('visibility', { enum: ['public', 'friends', 'private'] })
      .notNull()
      .default('friends'),
    createdAt: text('created_at').notNull().default(now),
    editedAt: text('edited_at'),
  },
  (t) => [
    index('posts_author_idx').on(t.authorId),
    index('posts_created_idx').on(t.createdAt),
    index('posts_game_idx').on(t.gameId),
  ],
);

export const postMedia = sqliteTable(
  'post_media',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('post_media_pk').on(t.postId, t.mediaId)],
);

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: text('created_at').notNull().default(now),
    editedAt: text('edited_at'),
  },
  (t) => [index('comments_post_idx').on(t.postId, t.createdAt)],
);

export const reactions = sqliteTable(
  'reactions',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reaction: text('reaction').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('reactions_pk').on(t.postId, t.userId)],
);

/* ------------------------------------------------------- discovery and alerts */

export const featuredGames = sqliteTable(
  'featured_games',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    headline: text('headline'),
    blurb: text('blurb'),
    heroImageId: text('hero_image_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('featured_games_game_idx').on(t.gameId),
    index('featured_games_order_idx').on(t.active, t.sortOrder),
  ],
);

/**
 * Keys for the external HTTP API.
 *
 * Only the SHA-256 of the token is stored, exactly as with sessions: a database
 * that leaks must not hand the reader working credentials. The prefix is kept
 * in the clear purely so a key can be told apart from its siblings in a list.
 */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(now),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [uniqueIndex('api_keys_token_hash_idx').on(t.tokenHash)],
);

/**
 * Operator-defined links the desktop client renders — a Discord invite, a
 * wiki, a support page.
 *
 * Deliberately links and not actions: the client opens the URL in the user's
 * browser. Letting an operator push anything executable to every player's
 * machine is a different trust model entirely.
 */
export const clientButtons = sqliteTable(
  'client_buttons',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    url: text('url').notNull(),
    icon: text('icon').notNull().default('link'),
    placement: text('placement', { enum: ['sidebar', 'home', 'game-menu'] })
      .notNull()
      .default('sidebar'),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('client_buttons_order_idx').on(t.active, t.placement, t.sortOrder)],
);

/**
 * Append-only feed rows. Written once and read by friends, which is far cheaper
 * than deriving a feed by unioning play sessions, unlocks and posts per request.
 */
export const activityEvents = sqliteTable(
  'activity_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['played', 'added-game', 'unlocked-achievement', 'posted', 'friended'],
    }).notNull(),
    gameId: text('game_id').references(() => games.id, { onDelete: 'cascade' }),
    achievementId: text('achievement_id').references(() => achievements.id, {
      onDelete: 'cascade',
    }),
    postId: text('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    seconds: integer('seconds'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('activity_events_user_idx').on(t.userId, t.createdAt),
    index('activity_events_created_idx').on(t.createdAt),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    /** An admin-sent announcement's custom icon (an emoji); other kinds are null. */
    icon: text('icon'),
    readAt: text('read_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
);

/**
 * Games players have asked for.
 *
 * One row per wanted title with a status the operator moves through, rather
 * than a table per outcome: a request that is denied and later reconsidered
 * keeps its votes, its original wording and its history.
 */
export const gameRequests = sqliteTable(
  'game_requests',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** Lower-cased and squashed, so two people asking for the same game collide. */
    titleKey: text('title_key').notNull(),
    note: text('note'),
    status: text('status', { enum: ['pending', 'coming-soon', 'added', 'denied'] })
      .notNull()
      .default('pending'),
    adminNote: text('admin_note'),
    /** The catalog entry that fulfilled this, once one exists. */
    gameId: text('game_id').references(() => games.id, { onDelete: 'set null' }),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: text('decided_at'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('game_requests_title_key_idx').on(t.titleKey),
    index('game_requests_status_idx').on(t.status, t.createdAt),
  ],
);

/**
 * Who is backing a request. The requester gets one automatically, so "votes"
 * is a single count rather than "1 + everyone who agreed".
 */
export const gameRequestVotes = sqliteTable(
  'game_request_votes',
  {
    requestId: text('request_id')
      .notNull()
      .references(() => gameRequests.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('game_request_votes_idx').on(t.requestId, t.userId),
    index('game_request_votes_user_idx').on(t.userId),
  ],
);

/**
 * A player's own grouping of games — "Co-op night", "Finished", "Install next".
 *
 * Per-account rather than server-wide: an operator already has genres and the
 * featured rail to shape the catalog, and a shared group would need its own
 * permissions model to answer "who may rename this".
 */
export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('blade'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('collections_user_idx').on(t.userId, t.sortOrder),
    uniqueIndex('collections_user_name_idx').on(t.userId, t.name),
  ],
);

export const collectionGames = sqliteTable(
  'collection_games',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('collection_games_idx').on(t.collectionId, t.gameId),
    index('collection_games_game_idx').on(t.gameId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type Library = typeof libraries.$inferSelect;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type GameFile = typeof gameFiles.$inferSelect;
export type ImageRecord = typeof images.$inferSelect;
export type UserProfile = typeof userProfiles.$inferSelect;
export type Friendship = typeof friendships.$inferSelect;
export type Achievement = typeof achievements.$inferSelect;
export type UserAchievement = typeof userAchievements.$inferSelect;
export type SaveSlot = typeof saveSlots.$inferSelect;
export type SaveVersion = typeof saveVersions.$inferSelect;
export type MediaRecord = typeof media.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type FeaturedGame = typeof featuredGames.$inferSelect;
export type ClientButtonRow = typeof clientButtons.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type PlaySession = typeof playSessions.$inferSelect;
export type GameRequestRow = typeof gameRequests.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;

/** How to tell, from a file the game wrote, that an achievement was earned. */
export const gameAchievementRules = sqliteTable(
  'game_achievement_rules',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    achievementKey: text('achievement_key').notNull(),
    sourceTemplate: text('source_template').notNull(),
    format: text('format', { enum: ['json', 'ini', 'text'] })
      .notNull()
      .default('json'),
    selector: text('selector').notNull(),
    comparator: text('comparator', { enum: ['present', 'truthy', 'equals', 'at-least'] })
      .notNull()
      .default('truthy'),
    value: text('value'),
    /**
     * Operator labels for this rule.
     *
     * On the rule rather than the achievement on purpose: one achievement
     * needs a rule per save layout it might be found in, and the tag is what
     * distinguishes them.
     */
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('game_achievement_rules_game_idx').on(t.gameId),
    // Includes the source: a game needs one rule per candidate emulator
    // layout, since which one a given copy uses is not knowable up front.
    uniqueIndex('game_achievement_rules_key_idx').on(t.gameId, t.achievementKey, t.sourceTemplate),
  ],
);

/**
 * One emoji on one message, granting one role.
 *
 * Keyed on message and emoji together, because a single message normally
 * carries several choices. The emoji is kept in the shape the gateway reports:
 * a bare unicode character, or `name:id` for a custom one.
 */
export const discordReactionRoles = sqliteTable(
  'discord_reaction_roles',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id').notNull(),
    emoji: text('emoji').notNull(),
    roleId: text('role_id').notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('discord_reaction_roles_key_idx').on(t.messageId, t.emoji),
    index('discord_reaction_roles_message_idx').on(t.messageId),
  ],
);

/**
 * A player's linked Discord account.
 *
 * One row per user, keyed on the user: a Discord account belongs to one
 * GameBlade account and vice versa, which is what lets it be a sign-in method
 * rather than only a decoration.
 *
 * The refresh token is kept because membership of the operator's server has to
 * be re-checkable later — a link that was valid the day it was made says
 * nothing about whether they are still in the Discord a week on.
 */
export const discordLinks = sqliteTable(
  'discord_links',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    discordId: text('discord_id').notNull(),
    /** The @handle. Discord usernames change, so this is refreshed on sign-in. */
    username: text('username').notNull(),
    /** The display name, which may differ from the handle and may be unset. */
    globalName: text('global_name'),
    avatar: text('avatar'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    tokenExpiresAt: text('token_expires_at'),
    /**
     * Whether other players may see the handle. Off by default: linking is
     * for signing in and finding people, and neither requires publishing a
     * name the player did not ask to publish.
     */
    showUsername: integer('show_username', { mode: 'boolean' }).notNull().default(false),
    /** Whether they were in the operator's guild at the last check. */
    inGuild: integer('in_guild', { mode: 'boolean' }).notNull().default(false),
    guildCheckedAt: text('guild_checked_at'),
    linkedAt: text('linked_at').notNull().default(now),
  },
  (t) => [uniqueIndex('discord_links_discord_id_idx').on(t.discordId)],
);

/**
 * One support ticket, as a channel in the operator's Discord.
 *
 * The row exists so a ticket outlives its channel. Closing deletes the
 * channel — which is what makes a ticket system usable rather than a server
 * that accumulates hundreds of dead channels — and without a record of who
 * asked for what and when, closing would also destroy the only history the
 * operator has.
 *
 * `user_id` is nullable and separate from `opener_discord_id`: anyone in the
 * Discord can open a ticket, whether or not they have linked a GameBlade
 * account, and a linked account may later be deleted.
 */
export const discordTickets = sqliteTable(
  'discord_tickets',
  {
    id: text('id').primaryKey(),
    /** Human-facing sequence, the number in `ticket-0007`. */
    number: integer('number').notNull(),
    guildId: text('guild_id').notNull(),
    /** Null once the channel has been deleted on close. */
    channelId: text('channel_id'),
    openerDiscordId: text('opener_discord_id').notNull(),
    openerName: text('opener_name').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    subject: text('subject').notNull(),
    status: text('status', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
    openedAt: text('opened_at').notNull().default(now),
    closedAt: text('closed_at'),
    closedBy: text('closed_by'),
  },
  (t) => [
    index('discord_tickets_status_idx').on(t.status, t.openedAt),
    uniqueIndex('discord_tickets_number_idx').on(t.number),
  ],
);

/** A bug report, with the diagnostics the client gathered alongside it. */
export const bugReports = sqliteTable(
  'bug_reports',
  {
    id: text('id').primaryKey(),
    /** Null once the reporter's account is gone; the report still stands. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    severity: text('severity', { enum: ['crash', 'broken', 'annoying', 'cosmetic'] })
      .notNull()
      .default('broken'),
    status: text('status', {
      enum: ['open', 'acknowledged', 'fixed', 'not-a-bug', 'duplicate'],
    })
      .notNull()
      .default('open'),
    reply: text('reply'),
    gameId: text('game_id').references(() => games.id, { onDelete: 'set null' }),
    clientVersion: text('client_version'),
    platform: text('platform'),
    diagnostics: text('diagnostics'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('bug_reports_status_idx').on(t.status, t.createdAt),
    index('bug_reports_user_idx').on(t.userId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ messages */

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['direct', 'group'] })
      .notNull()
      .default('direct'),
    /** Only groups carry one; a direct conversation is named by who is in it. */
    title: text('title'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(now),
    /**
     * Denormalised so the conversation list sorts and previews without touching
     * `messages`, which is by far the largest table here and the one nobody
     * should scan to draw a sidebar.
     */
    lastMessageAt: text('last_message_at'),
    lastMessagePreview: text('last_message_preview'),
  },
  (t) => [index('conversations_recent_idx').on(t.lastMessageAt)],
);

export const conversationMembers = sqliteTable(
  'conversation_members',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] })
      .notNull()
      .default('member'),
    joinedAt: text('joined_at').notNull().default(now),
    /** How far they have read, so an unread count needs no row per message. */
    lastReadAt: text('last_read_at'),
    leftAt: text('left_at'),
  },
  (t) => [
    uniqueIndex('conversation_members_pk').on(t.conversationId, t.userId),
    index('conversation_members_user_idx').on(t.userId, t.leftAt),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull().default(''),
    createdAt: text('created_at').notNull().default(now),
    editedAt: text('edited_at'),
    /**
     * Tombstoned rather than deleted, so every client agrees the message is
     * gone — one that missed the event would otherwise go on showing it.
     */
    deletedAt: text('deleted_at'),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const messageMedia = sqliteTable(
  'message_media',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.mediaId] }),
    index('message_media_media_idx').on(t.mediaId),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type ConversationMember = typeof conversationMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
