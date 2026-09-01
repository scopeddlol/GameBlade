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
  {
    id: '0015_discord_tickets',
    sql: `
      -- A ticket outlives its channel on purpose.
      --
      -- Closing deletes the channel, because a Discord that accumulates two
      -- hundred dead #ticket-0042 channels is worse than no ticket system at
      -- all. That makes the channel the wrong place to keep the record of who
      -- asked for what, so it is kept here instead.
      --
      -- opener_discord_id is required and user_id is not: anybody in the
      -- server can open a ticket whether or not they have ever linked a
      -- GameBlade account, and a linked account may be deleted later.
      CREATE TABLE discord_tickets (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        opener_discord_id TEXT NOT NULL,
        opener_name TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        closed_at TEXT,
        closed_by TEXT
      );
      CREATE INDEX discord_tickets_status_idx ON discord_tickets(status, opened_at);
      CREATE UNIQUE INDEX discord_tickets_number_idx ON discord_tickets(number);
    `,
  },
  {
    id: '0016_metadata_lock',
    sql: /* sql */ `
      -- Enrichment is a first-time job, not something every scan redoes.
      --
      -- Without this the automatic pass re-ran on anything still flagged
      -- unmatched or missing a cover, and happily overwrote a title, summary
      -- or artwork that had been corrected by hand. The stamp records that a
      -- provider has already written to this row; the scan then leaves it
      -- alone until somebody clears it or re-matches on purpose.
      ALTER TABLE games ADD COLUMN metadata_locked_at TEXT;

      -- Existing libraries are locked on the way in, so the first scan after
      -- this upgrade does not go and redo everything it already did.
      UPDATE games
         SET metadata_locked_at = COALESCE(updated_at, added_at)
       WHERE match_status <> 'unmatched' OR cover_image_id IS NOT NULL;

      CREATE INDEX games_metadata_lock_idx ON games(metadata_locked_at);
    `,
  },
  {
    id: '0017_password_resets',
    sql: /* sql */ `
      -- An admin-issued, single-use link for a player who cannot sign in.
      --
      -- The token is stored hashed for the same reason a session token is: a
      -- leaked database should not hand out working reset links. Nothing here
      -- identifies the user to whoever holds the link beyond the row it points
      -- at, so the link alone is the credential and it expires.
      CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX password_resets_user_idx ON password_resets(user_id);
      CREATE INDEX password_resets_expires_idx ON password_resets(expires_at);
    `,
  },
  {
    id: '0018_achievement_rule_tags',
    sql: /* sql */ `
      -- Labels on an unlock rule, not on the achievement it unlocks.
      --
      -- A game needs one rule per candidate emulator or save layout, all of
      -- them naming the same achievement, and they are otherwise told apart
      -- only by a long path. A tag is what lets an operator say which is which
      -- — "goldberg", "rune", "needs testing" — and filter on it later.
      ALTER TABLE game_achievement_rules ADD COLUMN tags TEXT;
    `,
  },
  {
    id: '0019_discord_roles',
    sql: /* sql */ `
      -- Emoji-on-a-message to role, the way every other server does it.
      --
      -- Keyed on the message and the emoji together: one message usually
      -- carries several choices. The emoji is stored in the form the gateway
      -- reports it — a bare unicode character, or name:id for a custom one —
      -- so the comparison at dispatch time is a string equality and not a
      -- guess about which half Discord will send.
      CREATE TABLE discord_reaction_roles (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        role_id TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX discord_reaction_roles_key_idx
        ON discord_reaction_roles(message_id, emoji);
      CREATE INDEX discord_reaction_roles_message_idx ON discord_reaction_roles(message_id);
    `,
  },
  {
    id: '0020_query_indexes',
    sql: /* sql */ `
      -- Indexes for the queries this server actually runs, rather than for the
      -- columns that looked worth indexing when the tables were written.
      --
      -- Every shelf, every library page and every filter starts with
      -- "missing_at IS NULL" and then sorts. A single-column index on
      -- missing_at satisfies only the first half of that: SQLite finds the
      -- live rows and then sorts them itself, which on a catalog of thousands
      -- is a temporary B-tree built per request. Leading each of these with
      -- missing_at means the index is already in the order the query wants,
      -- so the sort disappears.
      CREATE INDEX IF NOT EXISTS games_live_sort_title_idx ON games(missing_at, sort_title);
      CREATE INDEX IF NOT EXISTS games_live_added_idx ON games(missing_at, added_at DESC);
      CREATE INDEX IF NOT EXISTS games_live_rating_idx ON games(missing_at, rating DESC);
      CREATE INDEX IF NOT EXISTS games_live_size_idx ON games(missing_at, size_bytes DESC);
      CREATE INDEX IF NOT EXISTS games_live_released_idx ON games(missing_at, release_date DESC);

      -- The enrichment queue's exact filter. Without it the pass that runs at
      -- the end of every scan reads the whole catalog to find the handful of
      -- rows still waiting on a provider.
      CREATE INDEX IF NOT EXISTS games_pending_meta_idx
        ON games(missing_at, metadata_locked_at, match_status);

      -- Matching an imported achievement schema back to a game.
      CREATE INDEX IF NOT EXISTS games_igdb_idx ON games(igdb_id);
      CREATE INDEX IF NOT EXISTS games_steam_app_idx ON games(steam_app_id);

      -- "How many people have this one?" reads by achievement, but the only
      -- index on that table leads with the user, so the count scanned every
      -- unlock on the server.
      CREATE INDEX IF NOT EXISTS user_achievements_achievement_idx
        ON user_achievements(achievement_id);

      -- The most-played shelf groups playtime by game across every account;
      -- the two existing indexes both lead with the user.
      CREATE INDEX IF NOT EXISTS user_game_stats_game_idx ON user_game_stats(game_id);

      -- Sweeping expired rows, which otherwise walks the whole table.
      CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices(last_seen_at);
      CREATE INDEX IF NOT EXISTS save_versions_created_idx ON save_versions(created_at);
    `,
  },
  {
    id: '0021_profile_customisation',
    sql: /* sql */ `
      -- Room for a profile to be somebody's rather than a name and an avatar.
      --
      -- Pronouns are free text rather than an enum on purpose: no fixed list
      -- is complete, and one that is not gets it wrong for exactly the people
      -- it matters most to.
      ALTER TABLE user_profiles ADD COLUMN pronouns TEXT;

      -- One line under the name — "what, right now", as distinct from the bio.
      ALTER TABLE user_profiles ADD COLUMN tagline TEXT;

      -- Which band of a tall image survives the banner's wide crop, 0-100.
      ALTER TABLE user_profiles ADD COLUMN banner_position INTEGER NOT NULL DEFAULT 50;

      -- A handful of labelled links, as JSON. They are only ever read as a
      -- set and never queried across, so a table would buy a join on every
      -- profile read for something capped at five rows.
      ALTER TABLE user_profiles ADD COLUMN links TEXT;

      -- A game they want on their profile, whatever their playtime says.
      -- Nullable and cleared rather than cascading: losing a game from the
      -- catalog should not delete somebody's profile.
      ALTER TABLE user_profiles ADD COLUMN favorite_game_id TEXT
        REFERENCES games(id) ON DELETE SET NULL;
    `,
  },
  {
    id: '0022_messaging',
    sql: /* sql */ `
      -- Private conversations, which the server routes and cannot read.
      --
      -- Everything here is either ciphertext or metadata. What the server
      -- knows: who is in a conversation, when a message was sent, and how
      -- large it was. What it does not: a single word of any of them.

      -- One published key per device, so a message can be sealed for each
      -- machine somebody uses rather than for an account in the abstract.
      CREATE TABLE device_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- Ties a key to the device that owns it, so signing out on one laptop
        -- retires that key and leaves the phone's alone.
        device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        -- The operator-visible label, for a "your devices" list that can say
        -- which key is which.
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen_at TEXT
      );
      CREATE UNIQUE INDEX device_keys_public_idx ON device_keys(user_id, public_key);
      CREATE INDEX device_keys_user_idx ON device_keys(user_id);

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'direct',
        -- Only groups carry one. A direct conversation is named by whoever is
        -- in it, which each side renders for itself.
        title TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        -- Denormalised so the conversation list sorts without touching the
        -- messages table, which is by far the largest thing here.
        last_message_at TEXT
      );
      CREATE INDEX conversations_recent_idx ON conversations(last_message_at DESC);

      CREATE TABLE conversation_members (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        -- How far this member has read, so an unread count needs no per-user
        -- row per message.
        last_read_at TEXT,
        left_at TEXT
      );
      CREATE UNIQUE INDEX conversation_members_pk
        ON conversation_members(conversation_id, user_id);
      CREATE INDEX conversation_members_user_idx ON conversation_members(user_id, left_at);

      -- The conversation key, sealed once per member device.
      --
      -- Separate from the membership row because one member may have several
      -- devices, each needing its own wrap, and because a new device joining
      -- must not disturb the membership record.
      CREATE TABLE conversation_keys (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- The device public key this wrap was made for; the client matches on
        -- it to find the one it can open.
        public_key TEXT NOT NULL,
        ephemeral_public TEXT NOT NULL,
        nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX conversation_keys_pk
        ON conversation_keys(conversation_id, public_key);
      CREATE INDEX conversation_keys_user_idx ON conversation_keys(conversation_id, user_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        -- The sealed body: a nonce and a ciphertext, both base64. The server
        -- stores these and never looks inside.
        nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        edited_at TEXT,
        -- Tombstoned rather than deleted, so every client agrees the message
        -- is gone instead of one that missed the event still showing it.
        deleted_at TEXT
      );
      CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

      -- Attachments, which are rows in "media" holding ciphertext.
      CREATE TABLE message_media (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_id, media_id)
      );
      CREATE INDEX message_media_media_idx ON message_media(media_id);
    `,
  },
  {
    id: '0023_plain_messages',
    sql: /* sql */ `
      -- Messages go back to being text the server can read.
      --
      -- The end-to-end encryption this replaces cost more than it bought. This
      -- is a small archive where the operator already holds every save file,
      -- every screenshot and every password hash, so wrapping message bodies
      -- protected nothing that was not already readable — while adding a
      -- failure mode that was very real: a device with no key wrap for a
      -- conversation could not read a word of it, and there was no way to
      -- recover one from the client side.
      --
      -- Existing message bodies are dropped rather than migrated. They are
      -- ciphertext under keys these tables are about to delete, so there is
      -- nothing to convert them into.
      DROP TABLE IF EXISTS conversation_keys;
      DROP TABLE IF EXISTS device_keys;

      DROP TABLE IF EXISTS message_media;
      DROP TABLE IF EXISTS messages;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        edited_at TEXT,
        -- Tombstoned rather than deleted, so every client agrees the message is
        -- gone instead of one that missed the event still showing it.
        deleted_at TEXT
      );
      CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

      CREATE TABLE message_media (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_id, media_id)
      );
      CREATE INDEX message_media_media_idx ON message_media(media_id);

      -- A one-line preview, so the conversation list draws without reading the
      -- messages table at all.
      ALTER TABLE conversations ADD COLUMN last_message_preview TEXT;
    `,
  },
  {
    id: '0024_mesh_chunks',
    sql: /* sql */ `
      -- Per-chunk hashes, so a file can be fetched from more than one place.
      --
      -- A whole-file SHA-256 only tells you the download was wrong once every
      -- byte has arrived. To stitch one file out of several sources you have to
      -- be able to reject a bad piece on arrival, which means addressing pieces
      -- by content rather than by offset.
      --
      -- The grid is fixed (see MESH_CHUNK_BYTES) and the offset is implied by
      -- the index, so this table stores no offsets: an offset column could
      -- disagree with the index, and there would be no way to tell which was
      -- right.
      CREATE TABLE game_file_chunks (
        file_id TEXT NOT NULL REFERENCES game_files(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (file_id, chunk_index)
      ) WITHOUT ROWID;

      -- Answering "who has this chunk" is the mesh's hot query, and it arrives
      -- as a hash rather than as a file.
      CREATE INDEX game_file_chunks_sha_idx ON game_file_chunks(sha256);

      -- Chunk hashing is per-file and resumable, so the file has to remember
      -- whether it is done. A null means never hashed; a size that disagrees
      -- with the current MESH_CHUNK_BYTES means hashed on a different grid and
      -- due to be redone.
      ALTER TABLE game_files ADD COLUMN chunked_at TEXT;
      ALTER TABLE game_files ADD COLUMN chunk_bytes INTEGER;
    `,
  },
  {
    id: '0025_mesh_nodes',
    sql: /* sql */ `
      -- The coordinator's whole state: who the nodes are, how to reach them,
      -- and what they hold.
      --
      -- All of it is small on purpose. The VPS running this has 75 GB and a
      -- thin pipe, so it stores keys, addresses and counters — never game
      -- bytes. Relaying costs bandwidth when a direct path cannot be made, but
      -- it never costs disk.
      CREATE TABLE mesh_nodes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'mirror',
        status TEXT NOT NULL DEFAULT 'pending',
        -- Base64url Ed25519 public key. This is the node's identity: the
        -- coordinator knows a node by its key, not by its address, because the
        -- address changes every time a residential lease renews.
        public_key TEXT NOT NULL,
        -- The node's API credential, hashed. Issued fresh on every
        -- registration and returned in plaintext exactly once.
        --
        -- It cannot be derived from anything else the node holds: the public
        -- key is handed to clients so they can check who they are talking to,
        -- so a token derived from it would be a credential every client could
        -- compute for every node.
        token_hash TEXT NOT NULL,
        -- Set when a client's session belongs to a node it is seeding from, so
        -- a peer node dies with the account that offered it.
        owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        agent_version TEXT,
        last_seen_at TEXT,
        bytes_served INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX mesh_nodes_public_key_idx ON mesh_nodes(public_key);
      CREATE INDEX mesh_nodes_status_idx ON mesh_nodes(status);
      CREATE INDEX mesh_nodes_owner_idx ON mesh_nodes(owner_id);

      -- Every address a node believes it might be reachable on.
      --
      -- Replaced wholesale on each heartbeat rather than accumulated: a stale
      -- candidate is not harmless, it is a connection attempt that has to time
      -- out before a working one is tried.
      CREATE TABLE mesh_node_endpoints (
        node_id TEXT NOT NULL REFERENCES mesh_nodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        address TEXT NOT NULL,
        port INTEGER NOT NULL,
        PRIMARY KEY (node_id, address, port)
      ) WITHOUT ROWID;

      -- Which games a node claims a complete, verified copy of.
      --
      -- A claim is per game rather than per chunk. Per-chunk would be more
      -- precise and is what a real CDN does, but it is also a row per 8 MiB —
      -- millions of them for one archive — on the machine with the least disk.
      -- Whole games keep the index small enough to stay in memory, and the
      -- chunk hashes already make a wrong claim harmless: bytes that do not
      -- verify are rejected whatever the index said.
      CREATE TABLE mesh_node_games (
        node_id TEXT NOT NULL REFERENCES mesh_nodes(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        -- The manifest the node verified against, so a game that changed on
        -- the origin stops being served from stale mirrors.
        content_hash TEXT NOT NULL,
        announced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (node_id, game_id)
      ) WITHOUT ROWID;
      CREATE INDEX mesh_node_games_game_idx ON mesh_node_games(game_id);

      -- One-time codes that turn a machine into a node.
      --
      -- Hashed, like every other credential here: the plaintext is shown once
      -- when an operator generates it and never stored.
      CREATE TABLE mesh_enrollments (
        token_hash TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'mirror',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL,
        used_at TEXT,
        node_id TEXT REFERENCES mesh_nodes(id) ON DELETE SET NULL
      );

      -- What a node reported serving, against the grant that authorised it.
      --
      -- This is how a byte allowance survives transfers the server never sees.
      -- The row is keyed by the grant's nonce so a node replaying a report
      -- cannot inflate its own numbers or double-charge an account.
      CREATE TABLE mesh_transfers (
        nonce TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES mesh_nodes(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
        bytes_served INTEGER NOT NULL DEFAULT 0,
        issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        reported_at TEXT
      );
      CREATE INDEX mesh_transfers_user_idx ON mesh_transfers(user_id, issued_at);
      CREATE INDEX mesh_transfers_node_idx ON mesh_transfers(node_id);
    `,
  },
  {
    id: '0026_node_catalog_reports',
    sql: /* sql */ `
      -- Which library a node's catalog reports belong to.
      --
      -- This column is what makes moving the coordinator off the machine
      -- holding the games a move rather than a migration. Games are matched
      -- within a library by their relative path, so a node reporting into the
      -- *existing* library updates the rows that are already there — keeping
      -- every game id, and with it every achievement, save rule, artwork
      -- match, favourite and playtime record hanging off that id.
      --
      -- Pointing a node at a new library instead would re-add the entire
      -- catalog as strangers and orphan all of it, which is precisely the
      -- outcome this exists to prevent. So it is assigned deliberately by an
      -- administrator and reports are refused until it is.
      ALTER TABLE mesh_nodes ADD COLUMN library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL;

      -- When this node last reported its catalog, and what came of it.
      ALTER TABLE mesh_nodes ADD COLUMN catalog_reported_at TEXT;
      ALTER TABLE mesh_nodes ADD COLUMN catalog_status TEXT;
    `,
  },
  {
    id: '0027_enrolment_library',
    sql: /* sql */ `
      -- Which library a code's node should report into, chosen at the moment
      -- the code is generated rather than after the node has registered.
      --
      -- A node now gets a library created for it automatically, which removes
      -- the step where an operator had to make one by hand and remember to
      -- assign it. That is right for a new node and wrong for one taking over
      -- a library that already exists: there, the fresh library is a race the
      -- operator loses, because the node reports into it before anybody can
      -- retarget, and every achievement, save rule and playtime record is left
      -- hanging off a catalog nothing references. Naming the destination on
      -- the code settles it before the node exists.
      ALTER TABLE mesh_enrollments ADD COLUMN library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL;
    `,
  },
  {
    id: '0028_chat_replies_reactions_mutes',
    sql: /* sql */ `
      -- Replying to a message, rather than answering into the void and hoping
      -- everyone still remembers which line you meant.
      --
      -- SET NULL rather than CASCADE: a reply is a message somebody wrote, and
      -- deleting it because the thing it answered was withdrawn would remove
      -- their words on the author's behalf.
      ALTER TABLE messages ADD COLUMN reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL;

      -- A game recommended into a conversation, rendered as a card the other
      -- person can open. The reference is nulled rather than cascaded so a
      -- game leaving the catalog does not delete the conversation about it.
      ALTER TABLE messages ADD COLUMN shared_game_id TEXT REFERENCES games(id) ON DELETE SET NULL;

      CREATE INDEX messages_reply_idx ON messages(reply_to_id);

      -- One person's reaction to one message. All three columns are the key,
      -- so reacting twice with the same emoji is a no-op here rather than
      -- something every caller has to remember to check.
      CREATE TABLE message_reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE INDEX message_reactions_message_idx ON message_reactions(message_id);

      -- Somebody whose messages this account would rather not see.
      --
      -- Deliberately not a block. A block ends a friendship and is a statement
      -- about a relationship; a mute is about a feed — the group chat carries
      -- on, everyone else in it is unaffected, and the muted person is never
      -- told. Per account rather than per conversation, because "I do not want
      -- to read this person" is a fact about the person.
      CREATE TABLE muted_users (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        muted_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (user_id, muted_user_id)
      );
    `,
  },
  {
    id: '0029_zip_download_packages',
    sql: /* sql */ `
      -- A Coordinator does not have the ZIPs stored on its Nodes, but launch
      -- rule setup still needs to know which executables are inside them. The
      -- Node reads only the ZIP central directory and reports this small index
      -- with the ordinary catalog; no package bytes are retained here.
      CREATE TABLE game_archive_executables (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        PRIMARY KEY (game_id, path)
      ) WITHOUT ROWID;
      CREATE INDEX game_archive_executables_game_idx ON game_archive_executables(game_id);
    `,
  },
  {
    id: '0030_node_entry_policies',
    sql: /* sql */ `
      -- A Node reads the policy before walking a top-level game candidate.
      -- Paths are scoped to the library because two mounted drives may carry
      -- the same name and the operator may intentionally treat them differently.
      CREATE TABLE node_entry_policies (
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'ignored')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (library_id, rel_path)
      ) WITHOUT ROWID;
      CREATE INDEX node_entry_policies_decision_idx
        ON node_entry_policies(library_id, decision);
    `,
  },
  {
    id: '0031_archive_inspection_state',
    sql: /* sql */ `
      -- An empty executable report is meaningful: it says the Node inspected
      -- the ZIP and found nothing launchable. Without a separate timestamp the
      -- Coordinator cannot distinguish that from "the Node has not looked yet"
      -- and the Admin UI either polls forever or gives up too early.
      ALTER TABLE games ADD COLUMN archive_inspected_at TEXT;
    `,
  },
];
