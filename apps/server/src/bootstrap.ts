import path from 'node:path';
import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { maintain } from './db/index.js';
import { libraries } from './db/schema.js';
import { newId } from './lib/ids.js';
import { MESH_HEARTBEAT_TIMEOUT_SECONDS } from '@gameblade/shared';

/**
 * First-run setup driven by environment variables.
 *
 * Everything here is idempotent, so restarting the container never duplicates a
 * library or resets an account an administrator has since changed.
 */
export async function bootstrap(app: FastifyInstance): Promise<void> {
  const { config, auth, profiles, discord, discordBot, nodeRuntime, relayRuntime, caddyRuntime } =
    app.gameblade;

  await seedLibraries(app);

  if (config.role === 'node') {
    await nodeRuntime.start();
  } else {
    // Announcements use Discord's HTTP API, so authenticating the configured
    // bot here is its real startup and catches an invalid token immediately.
    try {
      const bot = await discord.startBot();
      if (bot) app.log.info({ username: bot.username, id: bot.id }, 'Discord bot started');
    } catch (error) {
      app.log.error({ err: error }, 'Discord bot failed to start; check its token and permissions');
    }

    discordBot.restore();
    relayRuntime.start();
    caddyRuntime.start();
  }

  if (config.bootstrapAdmin) {
    const existing = auth.findByUsername(config.bootstrapAdmin.username);
    if (!existing) {
      if (auth.countUsers() === 0) {
        const admin = await auth.createUser({
          username: config.bootstrapAdmin.username,
          password: config.bootstrapAdmin.password,
          role: 'admin',
        });
        profiles.ensure(admin.id, admin.username);
        app.log.info(
          { username: config.bootstrapAdmin.username },
          'created the initial administrator from ADMIN_USERNAME/ADMIN_PASSWORD',
        );
      } else {
        app.log.warn(
          'ADMIN_USERNAME is set but other accounts already exist — skipping. Remove the variable or use an invite.',
        );
      }
    }
  } else if (auth.countUsers() === 0) {
    app.log.info(
      'no accounts yet — open the web UI to create the first administrator, or set ADMIN_USERNAME and ADMIN_PASSWORD',
    );
  }
}

async function seedLibraries(app: FastifyInstance): Promise<void> {
  const { config, db } = app.gameblade;

  for (const libraryPath of config.libraryPaths) {
    const resolved = path.resolve(libraryPath);
    const existing = db.select().from(libraries).where(eq(libraries.path, resolved)).get();
    if (existing) continue;

    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) {
      app.log.warn(
        { path: resolved },
        'LIBRARY_PATHS entry is not a readable directory inside the container — check the volume mount',
      );
      continue;
    }

    db.insert(libraries)
      .values({
        id: newId('lib'),
        name: path.basename(resolved) || 'Library',
        path: resolved,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastScanAt: null,
        lastScanStatus: null,
      })
      .run();
    app.log.info({ path: resolved }, 'registered library from LIBRARY_PATHS');
  }
}

/** Retention for feed rows and read notifications, in days. */
const ACTIVITY_RETENTION_DAYS = 120;
const NOTIFICATION_RETENTION_DAYS = 60;

/** Grace period before an unattached upload is treated as an abandoned draft. */
const ORPHAN_MEDIA_GRACE_HOURS = 6;

/** Periodic background work: rescans plus expiry cleanup. */
export function startSchedules(app: FastifyInstance): () => void {
  const {
    config,
    db,
    scanner,
    mesh,
    auth,
    activity,
    notifications,
    media,
    playtime,
    settings,
    backups,
    saveManifest,
    discord,
    sqlite,
  } = app.gameblade;
  const timers: NodeJS.Timeout[] = [];

  // A Node has one narrow workload: scan, chunk-hash, publish. It must not run
  // Coordinator backups, Discord announcements, save-manifest pulls or stale
  // node sweeps against its private working database.
  if (config.role === 'node') {
    const runSync = () => {
      try {
        void app.gameblade.nodeRuntime.sync().catch((error: unknown) => {
          app.log.debug({ err: error }, 'scheduled node sync skipped');
        });
      } catch (error) {
        // A concurrent manual sync is ordinary and already visible in the UI.
        app.log.debug({ err: error }, 'scheduled node sync skipped');
      }
    };

    if (config.scanOnStart) {
      const first = setTimeout(runSync, 3_000);
      first.unref();
      timers.push(first);
    }

    if (config.scanIntervalMinutes > 0) {
      const interval = setInterval(runSync, config.scanIntervalMinutes * 60_000);
      interval.unref();
      timers.push(interval);
    }

    // Keep retrying catalog publication even when a full disk walk is not due.
    const report = setInterval(() => void app.gameblade.nodeRuntime.report(), 5 * 60_000);
    report.unref();
    timers.push(report);

    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    };
  }

  if (config.scanOnStart) {
    // Delay slightly so the server starts answering requests immediately.
    const timer = setTimeout(() => {
      app.log.info('starting initial library scan');
      void scanner.scan({ fetchMetadata: true });
    }, 3_000);
    timer.unref();
    timers.push(timer);
  }

  if (config.scanIntervalMinutes > 0) {
    const interval = setInterval(() => {
      if (scanner.isRunning) return;
      app.log.info('starting scheduled library scan');
      void scanner.scan({ fetchMetadata: true });
    }, config.scanIntervalMinutes * 60_000);
    interval.unref();
    timers.push(interval);
  }

  /**
   * Scheduled archives of the data directory.
   *
   * Checked hourly against a setting rather than scheduled once at boot, so
   * changing the interval takes effect without a restart. A run that overlaps
   * the previous one is skipped rather than queued — two zips of the same
   * directory at once is only ever slower.
   */
  let backupRunning = false;
  let lastBackupAt = 0;
  const backupTimer = setInterval(() => {
    const { backupKeep, backupEveryHours, backupIncludeImages } = settings.get();
    if (backupEveryHours <= 0 || backupRunning) return;
    if (Date.now() - lastBackupAt < backupEveryHours * 3_600_000) return;

    backupRunning = true;
    lastBackupAt = Date.now();
    void backups
      .create({
        keep: backupKeep,
        everyHours: backupEveryHours,
        includeImages: backupIncludeImages,
      })
      .then((info) => app.log.info({ backup: info.name, bytes: info.sizeBytes }, 'backup written'))
      .catch((error: unknown) => app.log.error({ err: error }, 'scheduled backup failed'))
      .finally(() => {
        backupRunning = false;
      });
  }, 60 * 60_000);
  backupTimer.unref();
  timers.push(backupTimer);

  /**
   * A daily pull of the save-path manifest.
   *
   * Upstream publishes continuously, so an index nobody presses the button for
   * quietly stops suggesting paths for anything released since it was last
   * fetched — the operator sees no error, only suggestions that never appear.
   *
   * Checked hourly against the index's own age rather than run on a
   * twenty-four hour timer: a server restarted every evening would never reach
   * the end of a daily interval, and one up for months would drift. The service
   * decides whether anything is actually due, so this fetches 17 MB once a day
   * at most however often the check runs.
   */
  let manifestRunning = false;
  const pullManifest = () => {
    if (manifestRunning) return;
    manifestRunning = true;
    void saveManifest
      .refreshIfStale()
      .then((status) => {
        if (status) app.log.info({ games: status.games }, 'refreshed the save-path manifest');
      })
      .catch((error: unknown) => {
        // A failed pull keeps the existing index, so this is worth a line in
        // the log and nothing more — the next hourly check tries again.
        app.log.warn({ err: error }, 'scheduled save-manifest refresh failed');
      })
      .finally(() => {
        manifestRunning = false;
      });
  };

  // Behind the initial scan, so a cold start serves requests before it spends
  // bandwidth on something no one is waiting for.
  const manifestStart = setTimeout(pullManifest, 30_000);
  manifestStart.unref();
  timers.push(manifestStart);

  const manifestTimer = setInterval(pullManifest, 60 * 60_000);
  manifestTimer.unref();
  timers.push(manifestTimer);

  /**
   * Announces newly added games to Discord.
   *
   * On its own timer rather than hooked into the scanner, for two reasons: a
   * game is worth announcing only once its metadata has landed, which happens
   * after it is inserted; and a Discord outage must not be able to fail a
   * scan. The service keeps a watermark, so nothing is announced twice and a
   * restart mid-run picks up where it stopped.
   */
  const announceTimer = setInterval(() => {
    void discord.announceNewGames().catch((error: unknown) => {
      app.log.warn({ err: error }, 'could not announce new games to Discord');
    });
  }, 15 * 60_000);
  announceTimer.unref();
  timers.push(announceTimer);

  /**
   * Mark nodes that have stopped heartbeating.
   *
   * Runs on its own short timer rather than with the hourly cleanup below: a
   * node that dropped an hour ago is a node clients have been queuing
   * connection attempts against all that time, and the whole point of a direct
   * path is that it is faster than the tunnel, not slower.
   */
  const meshSweep = setInterval(() => {
    try {
      const stale = mesh.pruneStale();
      if (stale > 0) app.log.info({ stale }, 'mesh nodes went stale');
    } catch (error) {
      app.log.warn({ err: error }, 'mesh sweep failed');
    }
  }, MESH_HEARTBEAT_TIMEOUT_SECONDS * 1000);
  meshSweep.unref();
  timers.push(meshSweep);

  /**
   * Statistics and a WAL checkpoint, hourly.
   *
   * Both matter more here than they would on an SSD. SQLite plans from
   * statistics it only gathers when asked, so a catalog that grew from fifty
   * games to five thousand is still being planned as if it were small — and on
   * a disk that charges milliseconds per seek, a plan that scans instead of
   * seeking is the difference between a page load and a wait. The checkpoint
   * folds the write-ahead log back into the database so reads stop having to
   * consult both files.
   *
   * VACUUM is deliberately not part of this: it needs room for a second copy
   * of the database and holds a write lock for as long as it takes, which is
   * not something to do to somebody's server unasked. It is a button in the
   * panel instead.
   */
  const maintenance = setInterval(() => {
    try {
      const result = maintain(sqlite);
      app.log.debug({ walPages: result.walPages }, 'database maintenance');
    } catch (error) {
      app.log.warn({ err: error }, 'database maintenance failed');
    }
  }, 60 * 60_000);
  maintenance.unref();
  timers.push(maintenance);

  const cleanup = setInterval(() => {
    try {
      auth.pruneExpired();

      const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

      activity.prune(daysAgo(ACTIVITY_RETENTION_DAYS));
      notifications.prune(daysAgo(NOTIFICATION_RETENTION_DAYS));

      // A client that died mid-game would otherwise leave its owner showing as
      // in-game forever, and its session credited with no time at all.
      const closed = playtime.closeAbandoned();
      if (closed > 0) {
        app.log.info({ closed }, 'closed abandoned play sessions');
      }

      // The desktop client uploads attachments before the post is submitted,
      // so an abandoned composer leaves a file with nothing pointing at it.
      void media
        .collectOrphans(new Date(Date.now() - ORPHAN_MEDIA_GRACE_HOURS * 3_600_000).toISOString())
        .catch((error: unknown) => {
          app.log.warn({ err: error }, 'failed to collect orphaned uploads');
        });
    } catch (error) {
      app.log.warn({ err: error }, 'periodic cleanup failed');
    }
  }, 60 * 60_000);
  cleanup.unref();
  timers.push(cleanup);

  return () => {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
  };
}
