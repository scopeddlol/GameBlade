import path from 'node:path';
import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { maintain } from './db/index.js';
import { libraries } from './db/schema.js';
import { newId } from './lib/ids.js';
import { CatalogReporter } from './services/catalogReporter.js';
import { MESH_HEARTBEAT_TIMEOUT_SECONDS } from '@gameblade/shared';

/**
 * First-run setup driven by environment variables.
 *
 * Everything here is idempotent, so restarting the container never duplicates a
 * library or resets an account an administrator has since changed.
 */
export async function bootstrap(app: FastifyInstance): Promise<void> {
  const { config, auth, profiles, discord, discordBot } = app.gameblade;

  await seedLibraries(app);

  // Announcements use Discord's HTTP API, so authenticating the configured
  // bot here is its real startup and catches an invalid token immediately.
  try {
    const bot = await discord.startBot();
    if (bot) app.log.info({ username: bot.username, id: bot.id }, 'Discord bot started');
  } catch (error) {
    app.log.error({ err: error }, 'Discord bot failed to start; check its token and permissions');
  }

  // The gateway connection is separate and only comes up if the operator left
  // it switched on. Not awaited: connecting, identifying and registering
  // commands is several round trips to Discord, and none of them is a reason
  // for this server to be slow to accept its first request.
  discordBot.restore();

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

/** What one pass over the configured roots did. */
export interface LibrarySyncResult {
  /** Roots that became libraries on this pass. */
  added: string[];
  /** Libraries whose mount came back and which are scanned again. */
  restored: string[];
  /** Libraries whose mount is gone; kept, but skipped by the scanner. */
  unmounted: string[];
  /** Every root currently configured, whether or not it is readable. */
  configured: string[];
}

/**
 * Bring the library table in line with what is actually mounted.
 *
 * Run at boot, and again whenever an operator asks a node to look — because a
 * drive appearing is a thing that happens after the container started, and
 * telling somebody to restart a node to have a mount noticed is a poor answer
 * when the node is right there with a page open.
 *
 * Additive in the direction that matters. A root that has gone is *disabled*,
 * never deleted: deleting it would take the catalog with it, and a mount that
 * failed on this boot is far more often a mount that will be back than a drive
 * anybody meant to remove. Disabled means the scanner skips it, which is what
 * stops one unmounted drive flagging its entire catalog as missing.
 */
export async function syncLibraryRoots(app: FastifyInstance): Promise<LibrarySyncResult> {
  const { config, db } = app.gameblade;
  const result: LibrarySyncResult = {
    added: [],
    restored: [],
    unmounted: [],
    configured: config.libraryPaths,
  };

  const readable = async (candidate: string): Promise<boolean> => {
    const info = await stat(candidate).catch(() => null);
    return Boolean(info?.isDirectory());
  };

  /*
   * Discovery order, made durable.
   *
   * Which root is the *primary* one decides which games keep unprefixed paths
   * upstream, and that is answered by whichever library row is oldest. Rows
   * added in one pass would otherwise all carry the same millisecond, leaving
   * the answer to the tiebreak — and `/libraries/E` sorts before `/library`,
   * so a node mounting both at once would have made the secondary drive the
   * primary and prefixed the main one. Staggering by discovery index makes
   * `/library` older than anything under `/libraries`, always, and makes a tie
   * impossible rather than merely unlikely.
   */
  const discoveredAt = Date.now();
  let index = 0;

  for (const libraryPath of config.libraryPaths) {
    const resolved = path.resolve(libraryPath);
    const present = await readable(resolved);
    const existing = db.select().from(libraries).where(eq(libraries.path, resolved)).get();
    const rank = index;
    index += 1;

    if (existing) {
      if (present && !existing.enabled) {
        db.update(libraries).set({ enabled: true }).where(eq(libraries.id, existing.id)).run();
        result.restored.push(resolved);
        app.log.info({ path: resolved }, 'library mount is back; scanning it again');
      } else if (!present && existing.enabled) {
        db.update(libraries).set({ enabled: false }).where(eq(libraries.id, existing.id)).run();
        result.unmounted.push(resolved);
        app.log.warn(
          { path: resolved },
          'library mount has gone; skipping it rather than flagging its whole catalog missing',
        );
      } else if (!present) {
        result.unmounted.push(resolved);
      }
      continue;
    }

    if (!present) {
      result.unmounted.push(resolved);
      app.log.warn(
        { path: resolved },
        'configured library is not a readable directory inside the container — check the volume mount',
      );
      continue;
    }

    db.insert(libraries)
      .values({
        id: newId('lib'),
        name: path.basename(resolved) || 'Library',
        path: resolved,
        enabled: true,
        createdAt: new Date(discoveredAt + rank).toISOString(),
        lastScanAt: null,
        lastScanStatus: null,
      })
      .run();
    result.added.push(resolved);
    app.log.info(
      { path: resolved, discovered: config.libraryPathsDiscovered },
      'registered a library root',
    );
  }

  return result;
}

async function seedLibraries(app: FastifyInstance): Promise<void> {
  await syncLibraryRoots(app);
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
    nodeStatus,
    chunks,
    sqlite,
  } = app.gameblade;
  const timers: NodeJS.Timeout[] = [];
  /**
   * Extra teardown for work that reschedules itself.
   *
   * Clearing a timer is not enough for a chained timeout: one already in flight
   * would go on to schedule the next, after teardown, on a closed database.
   */
  const stoppers: (() => void)[] = [];

  /**
   * A node's whole job, once its files are scanned: tell the coordinator.
   *
   * Runs on its own timer rather than hanging off the end of a scan, so a
   * coordinator that was unreachable when the scan finished is retried without
   * needing another scan to trigger it — and so a node that restarts reports
   * what it already knows straight away instead of waiting for the next walk.
   */
  if (config.reportsCatalogUpstream) {
    // No coordinator yet is a state, not an error.
    //
    // A node can be given one from the setup page it serves, so the reporter is
    // built either way and resolves where to report on each attempt. It says
    // "waiting" until somebody answers and starts the moment they do, without
    // this container being restarted underneath the person answering.
    const reporter = new CatalogReporter(
      db,
      {
        coordinatorUrl: config.coordinatorUrl,
        enrolmentToken: config.enrolmentToken,
        statePath: config.nodeStatePath,
      },
      app.log,
    );

    /** Steady state, once this node is enrolled and reporting. */
    const SETTLED_INTERVAL_MS = 5 * 60_000;
    /**
     * While it is not.
     *
     * Somebody is watching the setup page for this to turn green, and five
     * minutes of nothing reads as "it did not work" long before it is. The
     * request is small and only happens while a node is not yet doing its job.
     */
    const WAITING_INTERVAL_MS = 10_000;

    /*
     * Asked once per pairing, before this node reads a single byte.
     *
     * Anything the coordinator already has hashes for is a game this node does
     * not have to spend an hour on, and on a coordinator split off a standalone
     * server that is the entire library. Guarded so a node that has already
     * asked does not ask again on every report.
     */
    let adopted = false;
    const adoptOnce = async () => {
      if (adopted) return;
      adopted = true;
      try {
        await reporter.adoptKnownHashes();
      } catch (error) {
        // Not fatal in any way: whatever this could not take, the local
        // hashing sweep computes instead.
        app.log.warn({ err: error }, 'could not take hashes from the coordinator');
      }
    };

    const publish = async (): Promise<number> => {
      try {
        if (!(await reporter.ensureRegistered())) return WAITING_INTERVAL_MS;
        await adoptOnce();

        const games = reporter.collect().length;
        const ok = await reporter.report();
        nodeStatus.record({
          ok,
          games,
          detail: ok ? 'accepted' : 'the coordinator refused the catalog — see the log',
        });
        return ok ? SETTLED_INTERVAL_MS : WAITING_INTERVAL_MS;
      } catch (error) {
        app.log.warn({ err: error }, 'catalog report failed');
        nodeStatus.record({
          ok: false,
          games: 0,
          detail: error instanceof Error ? error.message : 'could not reach the coordinator',
        });
        return WAITING_INTERVAL_MS;
      }
    };

    /*
     * Self-scheduling rather than a fixed interval, so the cadence follows the
     * state: fast while a node is being set up or has lost its coordinator,
     * slow once it is settled. A fixed interval has to be one or the other, and
     * either choice is wrong half the time.
     *
     * Chained timeouts also cannot overlap. A report of a large catalog over a
     * slow link can outlast its own interval, and `setInterval` would have
     * started the next one on top of it.
     */
    let stopped = false;
    const schedule = (delay: number) => {
      const timer = setTimeout(() => {
        if (stopped) return;
        void publish().then(schedule);
      }, delay);
      timer.unref();
      timers.push(timer);
    };
    stoppers.push(() => {
      stopped = true;
    });

    // The first attempt is delayed enough for the mesh agent beside this
    // process to have written its key.
    schedule(8_000);
  }

  /**
   * Hash what the scan found, because nothing else on a node will.
   *
   * A game is only servable over the mesh once every one of its files has
   * per-chunk hashes, and a node has no API for an operator to ask for them
   * through — so on a node the pass has to run itself or it never runs at all,
   * and the machine sits there holding a library the coordinator will never
   * offer anyone. Deliberately not the default elsewhere: a standalone server
   * can always serve the file itself, so there hashing stays the explicit,
   * per-game decision it has always been.
   *
   * On its own timer rather than inside the reporter, because it takes hours on
   * a real archive the first time and the catalog report has to keep happening
   * meanwhile. It waits for the scanner rather than competing with it for the
   * same disk, and hashes are read from file contents, so whatever it finishes
   * is reported by the next publish and survives every one after that.
   */
  if (config.reportsCatalogUpstream && config.autoChunkHash) {
    // The service owns the run, so this timer only ever asks. An operator who
    // started one from the node's page is already sweeping, and this returns
    // false rather than starting a second pass over the same disk.
    const hashSweep = () => {
      if (scanner.isRunning) return;
      chunks.startSweep(() => scanner.isRunning);
    };

    const firstSweep = setTimeout(hashSweep, 30_000);
    firstSweep.unref();
    timers.push(firstSweep);

    const repeatSweep = setInterval(hashSweep, 10 * 60_000);
    repeatSweep.unref();
    timers.push(repeatSweep);
  }

  /**
   * Scanning, but only where there is a disk to scan.
   *
   * A coordinator's libraries are rows describing what its nodes hold, not
   * folders it can read. Scanning them was not merely pointless: a library
   * whose path happens to exist and be empty reads as a library whose games
   * have all been deleted, so the scan flagged the entire catalog its nodes had
   * just reported. The role knows better than the operator does here, so it
   * decides rather than leaving two more variables to get right.
   */
  if (config.servesLocalFiles) {
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
  } else if (config.scanOnStart || config.scanIntervalMinutes > 0) {
    app.log.info(
      'this is a coordinator, so it holds no files to scan; scanning settings are ignored',
    );
  }

  /*
   * A coordinator with no relay address, said once, at boot.
   *
   * It is not a reason to refuse to start: most players' connections can be
   * punched and for them this changes nothing. But for the ones behind a
   * symmetric or carrier-grade NAT it is the difference between downloading
   * and not, and a coordinator has no game files to fall back on — so it is
   * worth a line here and a finding on the health page, rather than being
   * found out by somebody who cannot install anything.
   */
  if (!config.servesLocalFiles && !config.relayEndpoint) {
    app.log.warn(
      'RELAY_ENDPOINT is not set, so clients are never told a relay exists. ' +
        'Players whose network refuses a direct connection to a node will not be able to ' +
        'download at all. Set it to this host’s public name and the relay’s port.',
    );
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
    for (const stop of stoppers) stop();
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
  };
}
