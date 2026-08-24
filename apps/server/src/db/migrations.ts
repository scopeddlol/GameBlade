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
  {
    // Turns the catalog into a platform: profiles, friends, per-user
    // libraries, playtime, achievements, cloud saves and the social feed.
    id: '0002_platform',
    sql: /* sql */ `
      ALTER TABLE games ADD COLUMN steam_app_id INTEGER;

      CREATE TABLE user_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        bio TEXT,
        accent_color TEXT NOT NULL DEFAULT '#7c5cff',
        country TEXT,
        avatar_media_id TEXT,
        banner_media_id TEXT,
        visibility TEXT NOT NULL DEFAULT 'friends',
        show_activity INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX user_profiles_display_name_idx ON user_profiles(display_name);

      -- Backfill a profile for every account that predates this migration.
      INSERT INTO user_profiles (user_id, display_name)
        SELECT id, username FROM users;

      CREATE TABLE friendships (
        id TEXT PRIMARY KEY,
        user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        responded_at TEXT
      );
      CREATE UNIQUE INDEX friendships_pair_idx ON friendships(user_a_id, user_b_id);
      CREATE INDEX friendships_user_a_idx ON friendships(user_a_id);
      CREATE INDEX friendships_user_b_idx ON friendships(user_b_id);
      CREATE INDEX friendships_status_idx ON friendships(status);

      CREATE TABLE user_library (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX user_library_pk ON user_library(user_id, game_id);
      CREATE INDEX user_library_user_idx ON user_library(user_id);

      -- Anything a user favourited or downloaded before now counts as owned.
      INSERT OR IGNORE INTO user_library (user_id, game_id)
        SELECT user_id, game_id FROM user_game_state
        WHERE is_favorite = 1 OR last_downloaded_at IS NOT NULL;

      CREATE TABLE play_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        device_id TEXT,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ended_at TEXT,
        seconds INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX play_sessions_user_idx ON play_sessions(user_id);
      CREATE INDEX play_sessions_game_idx ON play_sessions(game_id);
      CREATE INDEX play_sessions_open_idx ON play_sessions(user_id, ended_at);

      CREATE TABLE user_game_stats (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        total_seconds INTEGER NOT NULL DEFAULT 0,
        launch_count INTEGER NOT NULL DEFAULT 0,
        last_played_at TEXT
      );
      CREATE UNIQUE INDEX user_game_stats_pk ON user_game_stats(user_id, game_id);
      CREATE INDEX user_game_stats_last_played_idx ON user_game_stats(user_id, last_played_at);

      CREATE TABLE achievements (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        icon_url TEXT,
        points INTEGER NOT NULL DEFAULT 10,
        hidden INTEGER NOT NULL DEFAULT 0,
        global_percent INTEGER,
        source TEXT NOT NULL DEFAULT 'manual',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX achievements_game_key_idx ON achievements(game_id, key);
      CREATE INDEX achievements_game_idx ON achievements(game_id);

      CREATE TABLE user_achievements (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
        unlocked_at TEXT,
        progress INTEGER
      );
      CREATE UNIQUE INDEX user_achievements_pk ON user_achievements(user_id, achievement_id);
      CREATE INDEX user_achievements_user_idx ON user_achievements(user_id, unlocked_at);

      CREATE TABLE save_slots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'default',
        current_version_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX save_slots_user_game_name_idx ON save_slots(user_id, game_id, name);
      CREATE INDEX save_slots_user_idx ON save_slots(user_id);

      CREATE TABLE save_versions (
        id TEXT PRIMARY KEY,
        slot_id TEXT NOT NULL REFERENCES save_slots(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        device_id TEXT,
        captured_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX save_versions_slot_idx ON save_versions(slot_id, created_at);
      CREATE INDEX save_versions_sha_idx ON save_versions(sha256);

      CREATE TABLE game_save_rules (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        path_template TEXT NOT NULL,
        include TEXT,
        exclude TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX game_save_rules_game_idx ON game_save_rules(game_id);

      CREATE TABLE game_launch_rules (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        executable TEXT,
        args TEXT,
        working_dir TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX game_launch_rules_game_idx ON game_launch_rules(game_id);

      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        duration_ms INTEGER,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX media_owner_idx ON media(owner_id);
      CREATE INDEX media_sha_idx ON media(sha256);

      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'text',
        title TEXT,
        body TEXT,
        game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
        visibility TEXT NOT NULL DEFAULT 'friends',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        edited_at TEXT
      );
      CREATE INDEX posts_author_idx ON posts(author_id);
      CREATE INDEX posts_created_idx ON posts(created_at);
      CREATE INDEX posts_game_idx ON posts(game_id);

      CREATE TABLE post_media (
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX post_media_pk ON post_media(post_id, media_id);

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        edited_at TEXT
      );
      CREATE INDEX comments_post_idx ON comments(post_id, created_at);

      CREATE TABLE reactions (
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reaction TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX reactions_pk ON reactions(post_id, user_id);

      CREATE TABLE featured_games (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        headline TEXT,
        blurb TEXT,
        hero_image_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX featured_games_game_idx ON featured_games(game_id);
      CREATE INDEX featured_games_order_idx ON featured_games(active, sort_order);

      CREATE TABLE activity_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
        achievement_id TEXT REFERENCES achievements(id) ON DELETE CASCADE,
        post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
        seconds INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX activity_events_user_idx ON activity_events(user_id, created_at);
      CREATE INDEX activity_events_created_idx ON activity_events(created_at);

      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        actor_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT,
        link TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX notifications_user_idx ON notifications(user_id, read_at, created_at);
    `,
  },
  {
    id: '0003_notification_icons',
    sql: `
      -- An admin-sent announcement can carry a custom icon (an emoji, kept as
      -- plain text rather than an upload — no media pipeline needed for
      -- something this small). Other kinds leave it null and the client falls
      -- back to a per-kind icon.
      ALTER TABLE notifications ADD COLUMN icon TEXT;
    `,
  },
  {
    id: '0004_banner_artwork',
    sql: `
      -- The wide Steam-style capsule is a different shape from the portrait
      -- cover and SteamGridDB publishes different artwork for each, so it gets
      -- its own slot rather than sharing one and looking wrong in both places.
      ALTER TABLE games ADD COLUMN banner_image_id TEXT;
    `,
  },
  {
    id: '0005_client_buttons',
    sql: /* sql */ `
      -- Operator-defined links rendered by the desktop client. Links only:
      -- pushing anything executable to every player's machine would be a
      -- wholly different trust model from "add a link to our Discord".
      CREATE TABLE client_buttons (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'link',
        placement TEXT NOT NULL DEFAULT 'sidebar',
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX client_buttons_order_idx
        ON client_buttons(active, placement, sort_order);
    `,
  },
  {
    id: '0006_api_keys',
    sql: /* sql */ `
      -- Keys for the external API. Only the digest is stored, as with
      -- sessions: a leaked database must not hand the reader live credentials.
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE UNIQUE INDEX api_keys_token_hash_idx ON api_keys(token_hash);
    `,
  },
  {
    id: '0007_bandwidth',
    sql: /* sql */ `
      -- Per-account monthly allowance, overriding the server default.
      -- NULL means "use the default"; 0 means "unlimited for this account".
      ALTER TABLE users ADD COLUMN monthly_quota_mb INTEGER;

      -- Monthly usage is summed per user over a date range on every quota
      -- check and on the analytics page. The existing index is on user_id
      -- alone, which makes that a scan of one user's entire download history
      -- rather than of the current month.
      CREATE INDEX download_events_user_started_idx
        ON download_events(user_id, started_at);
      CREATE INDEX download_events_started_idx ON download_events(started_at);
    `,
  },
  {
    id: '0008_requests_and_collections',
    sql: /* sql */ `
      -- Games players have asked for. One row per wanted title with a status
      -- the operator moves through: a request that is denied and later
      -- reconsidered keeps its votes and its original wording.
      CREATE TABLE game_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        title_key TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        admin_note TEXT,
        game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
        decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX game_requests_title_key_idx ON game_requests(title_key);
      CREATE INDEX game_requests_status_idx ON game_requests(status, created_at);

      -- The requester is given a vote on creation, so the count is a single
      -- number rather than "one, plus everyone who agreed".
      CREATE TABLE game_request_votes (
        request_id TEXT NOT NULL REFERENCES game_requests(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX game_request_votes_idx ON game_request_votes(request_id, user_id);
      CREATE INDEX game_request_votes_user_idx ON game_request_votes(user_id);

      -- Per-account groupings of games. Private to the account that made them:
      -- a shared group would need its own permissions model to answer "who may
      -- rename this", and the operator already has genres and the featured rail.
      CREATE TABLE collections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'blade',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX collections_user_idx ON collections(user_id, sort_order);
      CREATE UNIQUE INDEX collections_user_name_idx ON collections(user_id, name);

      CREATE TABLE collection_games (
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX collection_games_idx ON collection_games(collection_id, game_id);
      CREATE INDEX collection_games_game_idx ON collection_games(game_id);
    `,
  },
  {
    id: '0009_download_sessions',
    sql: `
      -- One row per file was being written, so every count(*) over this table
      -- reported files rather than downloads: a 47-file game read as 47
      -- downloads on every chart and in every total. Events now carry the
      -- download they belong to.
      ALTER TABLE download_events ADD COLUMN session_id TEXT;

      -- Existing rows have no session to recover, so they are bucketed by the
      -- hour they started in, per user and game. It is an approximation, and
      -- only ever applies to history recorded before this column existed.
      UPDATE download_events
         SET session_id = coalesce(user_id, 'anon') || ':' ||
                          coalesce(game_id, 'none') || ':' ||
                          substr(started_at, 1, 13);

      CREATE INDEX download_events_session_idx ON download_events(session_id);
      -- The lookup that assigns a new event to an in-flight download.
      CREATE INDEX download_events_recent_idx
        ON download_events(user_id, game_id, started_at);
    `,
  },
  {
    id: '0010_achievement_rules',
    sql: `
      -- How to tell, from a file the game itself wrote, that an achievement
      -- was earned. Achievements have been definable since the start but
      -- nothing ever unlocked one; this is the missing half.
      CREATE TABLE game_achievement_rules (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        achievement_key TEXT NOT NULL,
        -- Same template vocabulary as save rules: {install}, {appdata}, ...
        source_template TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'json',
        selector TEXT NOT NULL,
        comparator TEXT NOT NULL DEFAULT 'truthy',
        value TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX game_achievement_rules_game_idx ON game_achievement_rules(game_id);
      -- One rule per achievement: two rules racing to unlock the same thing
      -- would be a contradiction rather than a redundancy.
      CREATE UNIQUE INDEX game_achievement_rules_key_idx
        ON game_achievement_rules(game_id, achievement_key);
    `,
  },
  {
    id: '0011_file_integrity',
    sql: `
      -- What a verification run last concluded about each file. Null until one
      -- has been done, which is also the state for a library nobody has
      -- verified yet.
      ALTER TABLE game_files ADD COLUMN integrity TEXT;
      ALTER TABLE game_files ADD COLUMN verified_at TEXT;
      CREATE INDEX game_files_integrity_idx ON game_files(integrity);
    `,
  },
  {
    id: '0012_bug_reports',
    sql: `
      -- Reports from the people actually using the thing. The diagnostics
      -- columns are filled by the client so a reporter never has to know their
      -- own client version, and an operator never has to go back and ask.
      CREATE TABLE bug_reports (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'broken',
        status TEXT NOT NULL DEFAULT 'open',
        reply TEXT,
        game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
        client_version TEXT,
        platform TEXT,
        diagnostics TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX bug_reports_status_idx ON bug_reports(status, created_at);
      CREATE INDEX bug_reports_user_idx ON bug_reports(user_id, created_at);
    `,
  },
  {
    id: '0013_achievement_rules_per_source',
    sql: `
      -- One rule per achievement was too few.
      --
      -- A DRM-free build records unlocks through whichever Steam emulator it
      -- happens to ship with, and each writes to a different path. The
      -- operator usually cannot tell which from the outside, and two players
      -- may hold different copies of the same game. Allowing a rule per
      -- candidate layout means all of them can be written at once: the ones
      -- whose file is absent read as nothing and unlock nothing, and whichever
      -- the copy actually uses is the one that fires.
      --
      -- Uniqueness moves to include the source, so the same layout still
      -- cannot be recorded twice for one achievement.
      DROP INDEX IF EXISTS game_achievement_rules_key_idx;
      CREATE UNIQUE INDEX game_achievement_rules_key_idx
        ON game_achievement_rules(game_id, achievement_key, source_template);
    `,
  },
  {
    id: '0014_discord_links',
    sql: `
      -- One Discord account per player and vice versa, so it can be a way in
      -- rather than only a badge. The refresh token is kept because guild
      -- membership has to be re-checkable: a link made while they were in the
      -- operator's Discord says nothing about whether they still are.
      CREATE TABLE discord_links (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        discord_id TEXT NOT NULL,
        username TEXT NOT NULL,
        global_name TEXT,
        avatar TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at TEXT,
        show_username INTEGER NOT NULL DEFAULT 0,
        in_guild INTEGER NOT NULL DEFAULT 0,
        guild_checked_at TEXT,
        linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX discord_links_discord_id_idx ON discord_links(discord_id);
    `,
  },
];
