import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MESH_CHUNK_BYTES } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DbHandle } from '../db/index.js';
import { gameFileChunks, gameFiles, games, libraries } from '../db/schema.js';
import { ScannerService } from './scanner.js';
import type { Db } from '../db/index.js';
import type { Game } from '../db/schema.js';
import type { MetadataService } from './metadata/service.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/**
 * The scanner reaches the database through a long drizzle chain, and enrichment
 * is the only part of it these tests exercise. A stub that answers the queries
 * `runMatchPending` makes is enough, and keeps the test about progress rather
 * than about SQL.
 *
 * Two shapes go through `select`: a bare one that claims a batch of rows, and
 * a projected one that counts how many are outstanding. They are told apart by
 * whether a projection was passed, which is the only thing distinguishing them
 * at this level.
 */
function stubDb(pending: Game[]): Db {
  const chain = (rows: unknown[], single: unknown) => {
    const link: Record<string, unknown> = {
      all: () => rows,
      get: () => single,
    };
    for (const method of ['from', 'where', 'limit', 'orderBy']) {
      link[method] = () => link;
    }
    return link;
  };

  return {
    select: (projection?: unknown) =>
      projection === undefined
        ? // The batch query, and the per-row re-read that follows each title.
          // `get` answering undefined is what marks a row as having had its
          // turn, so a stubbed run does not re-claim the same batch for ever.
          chain(pending, undefined)
        : chain([], { count: pending.length }),
  } as unknown as Db;
}

function stubMetadata(
  overrides: Partial<{
    hasIgdb: boolean;
    hasSteamGridDb: boolean;
    enrich: (game: Game, signal?: AbortSignal) => Promise<void>;
  }> = {},
): MetadataService {
  return {
    hasIgdb: true,
    hasSteamGridDb: false,
    enrich: async () => {},
    ...overrides,
  } as unknown as MetadataService;
}

const game = (id: string): Game => ({ id, title: id }) as Game;

/**
 * Enrichment started from the admin panel rather than by a scan.
 *
 * The bug this pins down: `matchPending` set the state to `matching` and left
 * it there. The admin UI reads that as a run still in flight, so the progress
 * readout sat on its final count — "25 / 25" — and every scan button stayed
 * disabled until the server was restarted.
 */
describe('matchPending on its own', () => {
  it('returns to idle when it finishes', async () => {
    const scanner = new ScannerService(
      stubDb([game('a'), game('b')]),
      stubMetadata(),
      silentLogger,
    );

    await scanner.matchPending();

    const progress = scanner.getProgress();
    expect(progress.state).toBe('idle');
    expect(progress.finishedAt).not.toBeNull();
  });

  it('reports itself finished rather than running', async () => {
    const scanner = new ScannerService(stubDb([game('a')]), stubMetadata(), silentLogger);

    await scanner.matchPending();

    // `isRunning` gates the route; a run that never clears it locks out scans.
    expect(scanner.isRunning).toBe(false);
  });

  it('does not strand the state when a provider throws', async () => {
    const scanner = new ScannerService(
      stubDb([game('a')]),
      stubMetadata({
        enrich: () => {
          throw new Error('provider exploded');
        },
      }),
      silentLogger,
    );

    await scanner.matchPending();

    // Per-game failures are caught and logged, so the run still completes.
    expect(scanner.getProgress().state).toBe('idle');
    expect(scanner.isRunning).toBe(false);
  });

  it('settles at idle with nothing pending', async () => {
    const scanner = new ScannerService(stubDb([]), stubMetadata(), silentLogger);

    await scanner.matchPending();

    expect(scanner.getProgress().state).toBe('idle');
  });

  it('settles at idle when no provider is configured', async () => {
    const scanner = new ScannerService(
      stubDb([game('a')]),
      stubMetadata({ hasIgdb: false, hasSteamGridDb: false }),
      silentLogger,
    );

    await scanner.matchPending();

    expect(scanner.getProgress().state).toBe('idle');
  });

  it('records what it did in the activity log', async () => {
    const scanner = new ScannerService(stubDb([game('a')]), stubMetadata(), silentLogger);

    await scanner.matchPending();

    // The panel reads this; an empty log is what "no logs to send you" was.
    const log = scanner.getProgress().log;
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((line) => line.message.includes('metadata'))).toBe(true);
  });

  it('does not start a second run while one is in flight', async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scanner = new ScannerService(
      stubDb([game('a')]),
      stubMetadata({ enrich: () => blocked }),
      silentLogger,
    );

    const first = scanner.matchPending();
    const second = scanner.matchPending();
    expect(scanner.isRunning).toBe(true);
    // The in-flight run is handed back rather than a duplicate being queued.
    expect(second).toBe(first);

    release();
    await first;
    expect(scanner.getProgress().state).toBe('idle');
  });
});

/**
 * Moving past a title the run is stuck on.
 *
 * The point of the abort is that the skip lands immediately rather than once
 * the provider request finishes on its own, so the test holds `enrich` open
 * until its signal fires.
 */
describe('skipping the current item', () => {
  it('says so when there is nothing to skip', () => {
    const scanner = new ScannerService(stubDb([]), stubMetadata(), silentLogger);
    expect(scanner.skipCurrent()).toBe(false);
  });

  it('aborts the in-flight provider call and moves on', async () => {
    let sawAbort = false;
    const scanner = new ScannerService(
      stubDb([game('stuck'), game('next')]),
      stubMetadata({
        enrich: (_game, signal) =>
          new Promise((_resolve, reject) => {
            if (!signal) return;
            signal.addEventListener('abort', () => {
              sawAbort = true;
              reject(new Error('aborted'));
            });
          }),
      }),
      silentLogger,
    );

    const run = scanner.matchPending();
    // Let the loop reach the first game and start waiting on the provider.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scanner.skipCurrent()).toBe(true);

    // The second game hangs too, so skip it as well to let the run finish.
    await new Promise((resolve) => setTimeout(resolve, 10));
    scanner.skipCurrent();
    await run;

    expect(sawAbort).toBe(true);
    const progress = scanner.getProgress();
    expect(progress.skipped).toBeGreaterThan(0);
    expect(progress.state).toBe('idle');
  });
});

/**
 * Stopping the run outright.
 *
 * Skip is the wrong tool when the problem is the run rather than one title in
 * it; before this the only way out of a wedged scan was restarting the server.
 */
describe('cancelling a run', () => {
  it('says so when there is nothing to cancel', () => {
    const scanner = new ScannerService(stubDb([]), stubMetadata(), silentLogger);
    expect(scanner.cancel()).toBe(false);
  });

  it('stops the run and settles on canceled', async () => {
    const scanner = new ScannerService(
      stubDb([game('a'), game('b'), game('c')]),
      stubMetadata({
        enrich: (_game, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      }),
      silentLogger,
    );

    const run = scanner.matchPending();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scanner.cancel()).toBe(true);
    await run;

    const progress = scanner.getProgress();
    expect(progress.state).toBe('canceled');
    expect(progress.canceling).toBe(false);
    expect(scanner.isRunning).toBe(false);
  });
});

/**
 * The readout that sent this whole rewrite: a run part-way through its second
 * library reported "25 / 25" — the first library's finished tally — for as long
 * as the second one took to read.
 */
describe('progress counters', () => {
  it('stamps a heartbeat as it works', async () => {
    const scanner = new ScannerService(stubDb([game('a')]), stubMetadata(), silentLogger);

    await scanner.matchPending();

    expect(scanner.getProgress().heartbeatAt).not.toBeNull();
  });

  it('counts the enrichment pass against the pending total, not a leftover one', async () => {
    const scanner = new ScannerService(
      stubDb([game('a'), game('b')]),
      stubMetadata(),
      silentLogger,
    );

    await scanner.matchPending();

    const progress = scanner.getProgress();
    expect(progress.total).toBe(2);
    expect(progress.processed).toBe(2);
  });
});

/**
 * A network mount may briefly exist as an empty directory during boot.
 *
 * The first scan marks its games missing; the next sees the share again. The
 * package fingerprint decides whether that is the same game coming back or new
 * bytes under the old name. Only the latter may discard persisted hashes.
 */
describe('a library returning after a temporary empty mount', () => {
  let base: string;
  let libraryPath: string;
  let handle: DbHandle;
  let scanner: ScannerService;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'gameblade-scanner-mount-test-'));
    libraryPath = path.join(base, 'library');
    await mkdir(libraryPath);
    handle = createDb(path.join(base, 'test.db'));
    handle.db.insert(libraries).values({ id: 'lib_nas', name: 'NAS', path: libraryPath }).run();
    scanner = new ScannerService(handle.db, stubMetadata(), silentLogger);
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(base, { recursive: true, force: true });
  });

  async function scanAndMarkHashed(bytes: Buffer) {
    const archive = path.join(libraryPath, 'Network Game.zip');
    await writeFile(archive, bytes);
    await scanner.scan({ fetchMetadata: false });

    const game = handle.db.select().from(games).get()!;
    const file = handle.db.select().from(gameFiles).where(eq(gameFiles.gameId, game.id)).get()!;
    handle.db
      .update(gameFiles)
      .set({
        sha256: 'whole-file-hash',
        chunkedAt: new Date().toISOString(),
        chunkBytes: MESH_CHUNK_BYTES,
      })
      .where(eq(gameFiles.id, file.id))
      .run();
    handle.db
      .insert(gameFileChunks)
      .values({
        fileId: file.id,
        chunkIndex: 0,
        sizeBytes: bytes.length,
        sha256: 'chunk-hash',
      })
      .run();

    return { archive, fileId: file.id, gameId: game.id };
  }

  it('keeps completed hashes through a database reopen and startup scan', async () => {
    const seeded = await scanAndMarkHashed(Buffer.from('a stable package'));

    handle.sqlite.close();
    handle = createDb(path.join(base, 'test.db'));
    scanner = new ScannerService(handle.db, stubMetadata(), silentLogger);
    await scanner.scan({ fetchMetadata: false });

    const file = handle.db
      .select()
      .from(gameFiles)
      .where(eq(gameFiles.gameId, seeded.gameId))
      .get()!;
    expect(file.id).toBe(seeded.fileId);
    expect(file.sha256).toBe('whole-file-hash');
    expect(file.chunkBytes).toBe(MESH_CHUNK_BYTES);
    expect(handle.db.select().from(gameFileChunks).all()).toHaveLength(1);
  });

  it('revives an unchanged ZIP without deleting its persisted hashes', async () => {
    const seeded = await scanAndMarkHashed(Buffer.from('a stable package'));
    const parked = path.join(base, 'Network Game.zip');

    // The directory remains readable, as a CIFS mount point does before the
    // remote share is ready, but the package briefly disappears from it.
    await rename(seeded.archive, parked);
    await scanner.scan({ fetchMetadata: false });
    expect(
      handle.db.select().from(games).where(eq(games.id, seeded.gameId)).get()!.missingAt,
    ).not.toBeNull();

    await rename(parked, seeded.archive);
    await scanner.scan({ fetchMetadata: false });

    const revived = handle.db
      .select()
      .from(gameFiles)
      .where(eq(gameFiles.gameId, seeded.gameId))
      .get()!;
    expect(revived.id).toBe(seeded.fileId);
    expect(revived.sha256).toBe('whole-file-hash');
    expect(revived.chunkBytes).toBe(MESH_CHUNK_BYTES);
    expect(handle.db.select().from(gameFileChunks).all()).toHaveLength(1);
    expect(
      handle.db.select().from(games).where(eq(games.id, seeded.gameId)).get()!.missingAt,
    ).toBeNull();
  });

  it('invalidates hashes when different package bytes return', async () => {
    const seeded = await scanAndMarkHashed(Buffer.from('old package'));
    const parked = path.join(base, 'old-package.zip');

    await rename(seeded.archive, parked);
    await scanner.scan({ fetchMetadata: false });
    await writeFile(seeded.archive, Buffer.from('different and larger package'));
    await scanner.scan({ fetchMetadata: false });

    const replaced = handle.db
      .select()
      .from(gameFiles)
      .where(eq(gameFiles.gameId, seeded.gameId))
      .get()!;
    expect(replaced.id).not.toBe(seeded.fileId);
    expect(replaced.sha256).toBeNull();
    expect(replaced.chunkBytes).toBeNull();
    expect(handle.db.select().from(gameFileChunks).all()).toHaveLength(0);
  });
});
