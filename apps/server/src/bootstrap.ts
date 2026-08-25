import path from 'node:path';
import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { libraries } from './db/schema.js';
import { newId } from './lib/ids.js';

/**
 * First-run setup driven by environment variables.
 *
 * Everything here is idempotent, so restarting the container never duplicates a
 * library or resets an account an administrator has since changed.
 */
export async function bootstrap(app: FastifyInstance): Promise<void> {
  const { config, auth, profiles, discord } = app.gameblade;

  await seedLibraries(app);

  // Announcements use Discord's HTTP API, so authenticating the configured
  // bot here is its real startup and catches an invalid token immediately.
  try {
    const bot = await discord.startBot();
    if (bot) app.log.info({ username: bot.username, id: bot.id }, 'Discord bot started');
  } catch (error) {
    app.log.error({ err: error }, 'Discord bot failed to start; check its token and permissions');
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
    scanner,
    auth,
    activity,
    notifications,
    media,
    playtime,
    settings,
    backups,
    saveManifest,
    discord,
  } = app.gameblade;
  const timers: NodeJS.Timeout[] = [];

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
