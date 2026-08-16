import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    heroImageId: text('hero_image_id'),
    logoImageId: text('logo_image_id'),
    iconImageId: text('icon_image_id'),

    addedAt: text('added_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    scannedAt: text('scanned_at'),
    /** Set when the files vanish; kept so metadata survives a temporary unmount. */
    missingAt: text('missing_at'),
  },
  (t) => [
    uniqueIndex('games_library_relpath_idx').on(t.libraryId, t.relPath),
    index('games_sort_title_idx').on(t.sortTitle),
    index('games_match_status_idx').on(t.matchStatus),
    index('games_missing_idx').on(t.missingAt),
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
  },
  (t) => [
    uniqueIndex('game_files_game_relpath_idx').on(t.gameId, t.relPath),
    index('game_files_game_idx').on(t.gameId),
  ],
);

/** Locally cached provider artwork, addressed by content hash. */
export const images = sqliteTable(
  'images',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['cover', 'hero', 'logo', 'icon', 'screenshot'] }).notNull(),
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
    client: text('client').notNull().default('web'),
    bytesSent: integer('bytes_sent').notNull().default(0),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
    completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('download_events_user_idx').on(t.userId),
    index('download_events_game_idx').on(t.gameId),
  ],
);

/** Free-form key/value store for runtime settings and provider credentials. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

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
