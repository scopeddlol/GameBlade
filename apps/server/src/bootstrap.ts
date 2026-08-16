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
  const { config, auth, db } = app.gameblade;

  await seedLibraries(app);

  if (config.bootstrapAdmin) {
    const existing = auth.findByUsername(config.bootstrapAdmin.username);
    if (!existing) {
      if (auth.countUsers() === 0) {
        await auth.createUser({
          username: config.bootstrapAdmin.username,
          password: config.bootstrapAdmin.password,
          role: 'admin',
        });
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

/** Periodic background work: rescans plus expiry cleanup. */
export function startSchedules(app: FastifyInstance): () => void {
  const { config, scanner, auth } = app.gameblade;
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
    const interval = setInterval(
      () => {
        if (scanner.isRunning) return;
        app.log.info('starting scheduled library scan');
        void scanner.scan({ fetchMetadata: true });
      },
      config.scanIntervalMinutes * 60_000,
    );
    interval.unref();
    timers.push(interval);
  }

  const cleanup = setInterval(
    () => {
      try {
        auth.pruneExpired();
      } catch (error) {
        app.log.warn({ err: error }, 'failed to prune expired sessions');
      }
    },
    60 * 60_000,
  );
  cleanup.unref();
  timers.push(cleanup);

  return () => {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
  };
}
