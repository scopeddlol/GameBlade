/**
 * Plain-SQL migrations applied in order at boot. Keeping them here (rather than
 * generating them with drizzle-kit) means the container needs no extra tooling
 * and the schema is versioned in the same commit as the code that reads it.
 *
 * Never edit an applied migration — append a new one.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '0001_initial',
    sql: /* sql */ `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_login_at TEXT
      );
      CREATE UNIQUE INDEX users_username_lower_idx ON users(username_lower);

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL,
        last_seen_at TEXT,
        user_agent TEXT,
        ip TEXT
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id);
      CREATE INDEX sessions_expires_idx ON sessions(expires_at);

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        platform TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE UNIQUE INDEX devices_token_hash_idx ON devices(token_hash);
      CREATE INDEX devices_user_idx ON devices(user_id);

      CREATE TABLE invites (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        note TEXT,
        max_uses INTEGER NOT NULL DEFAULT 1,
        uses INTEGER NOT NULL DEFAULT 0,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE UNIQUE INDEX invites_code_idx ON invites(code);

      CREATE TABLE libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_scan_at TEXT,
        last_scan_status TEXT
      );
      CREATE UNIQUE INDEX libraries_path_idx ON libraries(path);

      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        sort_title TEXT NOT NULL,
        search_title TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0,
        content_mtime TEXT,
        match_status TEXT NOT NULL DEFAULT 'unmatched',
        igdb_id INTEGER,
        sgdb_id INTEGER,
        summary TEXT,
        storyline TEXT,
        release_date TEXT,
        rating INTEGER,
        developers TEXT,
        publishers TEXT,
        genres TEXT,
        platforms TEXT,
        screenshots TEXT,
        videos TEXT,
        cover_image_id TEXT,
        hero_image_id TEXT,
        logo_image_id TEXT,
        icon_image_id TEXT,
        added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        scanned_at TEXT,
        missing_at TEXT
      );
      CREATE UNIQUE INDEX games_library_relpath_idx ON games(library_id, rel_path);
      CREATE INDEX games_sort_title_idx ON games(sort_title);
      CREATE INDEX games_match_status_idx ON games(match_status);
      CREATE INDEX games_missing_idx ON games(missing_at);

      CREATE TABLE game_files (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        sha256 TEXT
      );
      CREATE UNIQUE INDEX game_files_game_relpath_idx ON game_files(game_id, rel_path);
      CREATE INDEX game_files_game_idx ON game_files(game_id);

      CREATE TABLE images (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_url TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX images_source_url_idx ON images(source_url);

      CREATE TABLE user_game_state (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        last_downloaded_at TEXT
      );
      CREATE UNIQUE INDEX user_game_state_pk ON user_game_state(user_id, game_id);

      CREATE TABLE download_events (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
        file_id TEXT,
        client TEXT NOT NULL DEFAULT 'web',
        bytes_sent INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        finished_at TEXT,
        completed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX download_events_user_idx ON download_events(user_id);
      CREATE INDEX download_events_game_idx ON download_events(game_id);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
];
