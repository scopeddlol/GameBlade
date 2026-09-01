import { MESH_CHUNK_BYTES, chunkCountFor, type ChunkRef } from '@gameblade/shared';
import { and, eq, gt, inArray, isNull, or, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFileChunks, gameFiles, games, libraries } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { assertRealPathWithin, resolveWithin } from '../lib/paths.js';
import {
  HashPool,
  RateMeter,
  defaultHashConcurrency,
  etaFrom,
  hashFileByChunk,
  idleHashProgress,
  type FileDigest,
  type HashProgress,
} from './hashing.js';
import type { Logger } from './metadata/service.js';

/** What one game's hashing pass is doing. */
export type ChunkProgress = HashProgress;

/**
 * The state of the pass over everything that is not hashed yet.
 *
 * Distinct from `ChunkProgress`, which describes one game: this is the sweep
 * around it, and it is what an operator watching a node actually wants — how
 * many games are left, how long it has been going, and whether it is moving.
 */
export interface SweepProgress {
  running: boolean;
  /** Missing hashes only, or a deliberate verification rebuild of every ZIP. */
  mode: 'missing' | 'rebuild';
  /** Set while a stop has been asked for and the current game is finishing. */
  stopping: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Games hashed and games that could not be, this run. */
  hashed: number;
  failed: number;
  /** Games left to hash, counted live rather than at the start of the run. */
  remaining: number;
  /** Games this run set out to hash, so a percentage means something. */
  total: number;
  /** The game being read right now, named rather than left as an id. */
  currentGameId: string | null;
  currentGameTitle: string | null;
  /** Bytes read this run, and bytes the run set out to read. */
  bytesHashed: number;
  bytesTotal: number;
  /** Read speed over the last few seconds, and what is left at that rate. */
  bytesPerSecond: number;
  etaSeconds: number | null;
  /** Why the last run stopped, when it was not simply finished. */
  note: string | null;
}

/**
 * Computes per-chunk SHA-256 for a game's files, on the fixed mesh grid.
 *
 * This is what makes a file fetchable from more than one place. A whole-file
 * hash can only tell you a download was wrong after every byte has arrived,
 * which is useless for deciding whether to keep a piece that came from a node
 * you have never talked to before. Chunk hashes turn that into a per-piece
 * decision, and a bad piece costs one chunk rather than the whole game.
 *
 * The pass computes the whole-file hash at the same time, from the same read.
 * Chunk hashing has to read every byte anyway, and doing both here means
 * enabling the mesh for a game does not read a multi-terabyte archive twice.
 */
export class ChunkService {
  private progress: ChunkProgress = idleHashProgress();

  private running: Promise<void> | null = null;

  private sweep: SweepProgress = idleSweep();

  /** Set while a sweep is in flight, so a second request joins rather than races. */
  private sweeping: Promise<void> | null = null;
  private stopSweepRequested = false;

  /** Files read at once. Shared by the per-game pass and the sweep around it. */
  private readonly concurrency: number;
  private readonly pool: HashPool;

  /** Live read rate for the current game, and for the sweep as a whole. */
  private readonly gameRate = new RateMeter();
  private readonly sweepRate = new RateMeter();

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    concurrency = defaultHashConcurrency(),
  ) {
    this.concurrency = Math.max(1, concurrency);
    this.pool = new HashPool(this.concurrency, (error) =>
      this.logger.warn({ err: error }, 'a hashing worker stopped'),
    );
  }

  getProgress(): ChunkProgress {
    // The rate and the estimate are read at the moment they are asked for
    // rather than written on every buffer: the meter already holds the window,
    // and recomputing here keeps a stalled pass from reporting a stale speed.
    const remaining = Math.max(0, this.progress.bytesTotal - this.progress.bytesProcessed);
    const bytesPerSecond = this.progress.state === 'hashing' ? this.gameRate.rate() : 0;
    return {
      ...this.progress,
      bytesPerSecond,
      etaSeconds: this.progress.state === 'hashing' ? etaFrom(remaining, bytesPerSecond) : null,
      currentFiles: [...this.progress.currentFiles],
    };
  }

  /** Releases the worker threads. Called when the server shuts down. */
  async close(): Promise<void> {
    await this.pool.close();
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** How the pass over everything unhashed is going. */
  getSweepProgress(): SweepProgress {
    // Derived from this run rather than the database. During a rebuild the old
    // hashes are still present until each game is replaced, so an "unhashed"
    // query would incorrectly say there is no work left from the first second.
    const remaining = this.sweep.running
      ? Math.max(0, this.sweep.total - this.sweep.hashed - this.sweep.failed)
      : this.sweep.remaining;
    const bytesPerSecond = this.sweep.running ? this.sweepRate.rate() : 0;
    const bytesLeft = Math.max(0, this.sweep.bytesTotal - this.sweep.bytesHashed);
    return {
      ...this.sweep,
      remaining,
      bytesPerSecond,
      etaSeconds: this.sweep.running ? etaFrom(bytesLeft, bytesPerSecond) : null,
    };
  }

  /**
   * Bytes still to read across every game that is not hashed yet.
   *
   * The count of games left says nothing about how long that is: one archive
   * can be larger than four hundred small titles. This is the number an
   * estimate has to be built on, and it is one query rather than a walk.
   */
  unhashedBytes(): number {
    const row = this.db
      .select({ bytes: sql<number>`coalesce(sum(${gameFiles.sizeBytes}), 0)` })
      .from(gameFiles)
      .innerJoin(games, eq(games.id, gameFiles.gameId))
      .where(
        and(
          isNull(games.missingAt),
          eq(games.kind, 'archive'),
          sql`lower(${games.relPath}) like '%.zip'`,
          gt(gameFiles.sizeBytes, 0),
          or(isNull(gameFiles.chunkBytes), ne(gameFiles.chunkBytes, MESH_CHUNK_BYTES)),
        ),
      )
      .get();
    return Number(row?.bytes ?? 0);
  }

  /** Every byte in every present ZIP package, for a full verification pass. */
  packageBytes(): number {
    const row = this.db
      .select({ bytes: sql<number>`coalesce(sum(${gameFiles.sizeBytes}), 0)` })
      .from(gameFiles)
      .innerJoin(games, eq(games.id, gameFiles.gameId))
      .where(
        and(
          isNull(games.missingAt),
          eq(games.kind, 'archive'),
          sql`lower(${games.relPath}) like '%.zip'`,
          gt(gameFiles.sizeBytes, 0),
        ),
      )
      .get();
    return Number(row?.bytes ?? 0);
  }

  /** The chunk table for one file, in index order. Empty when never hashed. */
  chunksFor(fileId: string): ChunkRef[] {
    return this.db
      .select({
        index: gameFileChunks.chunkIndex,
        sha256: gameFileChunks.sha256,
        sizeBytes: gameFileChunks.sizeBytes,
      })
      .from(gameFileChunks)
      .where(eq(gameFileChunks.fileId, fileId))
      .orderBy(gameFileChunks.chunkIndex)
      .all();
  }

  /**
   * Chunk tables for a whole game, keyed by file id.
   *
   * One query rather than one per file: a folder game can hold thousands of
   * files and the manifest route reads them all on every install.
   */
  chunksForGame(gameId: string): Map<string, ChunkRef[]> {
    const fileIds = this.db
      .select({ id: gameFiles.id })
      .from(gameFiles)
      .where(eq(gameFiles.gameId, gameId))
      .all()
      .map((row) => row.id);

    const byFile = new Map<string, ChunkRef[]>();
    if (fileIds.length === 0) return byFile;

    // SQLite caps a statement at 999 bound parameters by default, and a folder
    // game can hold far more files than that.
    for (let offset = 0; offset < fileIds.length; offset += 500) {
      const batch = fileIds.slice(offset, offset + 500);
      const rows = this.db
        .select()
        .from(gameFileChunks)
        .where(inArray(gameFileChunks.fileId, batch))
        .orderBy(gameFileChunks.fileId, gameFileChunks.chunkIndex)
        .all();

      for (const row of rows) {
        const list = byFile.get(row.fileId) ?? [];
        list.push({ index: row.chunkIndex, sha256: row.sha256, sizeBytes: row.sizeBytes });
        byFile.set(row.fileId, list);
      }
    }

    return byFile;
  }

  /**
   * Whether every file of this game carries chunk hashes on the current grid.
   *
   * A game only becomes mesh-eligible when this is true. Serving a partly
   * chunked game from a node would mean some files could be verified per piece
   * and others could not, and the downloader would have to reason about which —
   * so the answer is all or nothing.
   */
  isGameChunked(gameId: string): boolean {
    const packageGame = this.db
      .select({ kind: games.kind, relPath: games.relPath })
      .from(games)
      .where(eq(games.id, gameId))
      .get();
    if (packageGame?.kind !== 'archive' || !packageGame.relPath.toLowerCase().endsWith('.zip')) {
      return false;
    }

    const files = this.db
      .select({
        id: gameFiles.id,
        chunkBytes: gameFiles.chunkBytes,
        sizeBytes: gameFiles.sizeBytes,
      })
      .from(gameFiles)
      .where(eq(gameFiles.gameId, gameId))
      .all();

    if (files.length === 0) return false;
    return files.every((file) => file.chunkBytes === MESH_CHUNK_BYTES || file.sizeBytes === 0);
  }

  /**
   * Every game with at least one file that is not hashed on the current grid.
   *
   * One query rather than `isGameChunked` per game, because a node runs this on
   * a timer for its whole life and a real archive is thousands of games. A game
   * made entirely of zero-byte files is not pending: it has no chunks and never
   * will, which is what `isGameChunked` already treats as finished.
   */
  unhashedGameIds(): string[] {
    return this.db
      .selectDistinct({ gameId: gameFiles.gameId })
      .from(gameFiles)
      .innerJoin(games, eq(games.id, gameFiles.gameId))
      .where(
        and(
          isNull(games.missingAt),
          eq(games.kind, 'archive'),
          sql`lower(${games.relPath}) like '%.zip'`,
          // A zero-byte file has no chunks and never will, so a game made only
          // of those is finished rather than pending.
          gt(gameFiles.sizeBytes, 0),
          or(isNull(gameFiles.chunkBytes), ne(gameFiles.chunkBytes, MESH_CHUNK_BYTES)),
        ),
      )
      .all()
      .map((row) => row.gameId);
  }

  /** Every present ZIP game, including games that already carry valid hashes. */
  packageGameIds(): string[] {
    return this.db
      .selectDistinct({ gameId: gameFiles.gameId })
      .from(gameFiles)
      .innerJoin(games, eq(games.id, gameFiles.gameId))
      .where(
        and(
          isNull(games.missingAt),
          eq(games.kind, 'archive'),
          sql`lower(${games.relPath}) like '%.zip'`,
          gt(gameFiles.sizeBytes, 0),
        ),
      )
      .all()
      .map((row) => row.gameId);
  }

  /**
   * Hash everything that is not hashed yet, one game at a time.
   *
   * On a node this is not an optimisation somebody opts into per game: a node's
   * entire job is serving bytes, it can only serve a game every one of whose
   * files carries chunk hashes, and it has no API of its own for an operator to
   * ask through. Without this a node holds a library nobody is ever offered,
   * which is indistinguishable from a node that is not working.
   *
   * Deliberately not the default anywhere else. A standalone server can always
   * serve the file itself, so there hashing stays the explicit, per-game
   * decision it has always been — it reads every byte of a multi-terabyte
   * archive, and that is a choice rather than a background job.
   *
   * Sequential, and interruptible between games. The disk this is reading is
   * the same one the scanner and the download routes are using, and the pass
   * takes hours the first time; stopping between games rather than at the end
   * means a restart resumes instead of starting again, since a game already
   * hashed is skipped by the query above.
   */
  async hashUnhashed(
    shouldStop: () => boolean = () => false,
    options: { force?: boolean } = {},
  ): Promise<{
    hashed: number;
    failed: number;
  }> {
    const force = options.force ?? false;
    const pending = force ? this.packageGameIds() : this.unhashedGameIds();

    this.sweepRate.reset();

    this.sweep = {
      ...idleSweep(),
      running: true,
      mode: force ? 'rebuild' : 'missing',
      startedAt: new Date().toISOString(),
      remaining: pending.length,
      total: pending.length,
      bytesTotal: force ? this.packageBytes() : this.unhashedBytes(),
    };

    let hashed = 0;
    let failed = 0;
    let note: string | null = null;

    try {
      for (const gameId of pending) {
        // An operator-triggered pass owns the service while it runs. Yielding to
        // it rather than queueing behind it: this sweep will come round again.
        if (this.stopSweepRequested) {
          note = 'stopped';
          break;
        }
        if (shouldStop() || this.running) {
          note = 'paused while the disk was busy';
          break;
        }

        try {
          await this.start(gameId, { force });
          if (this.isGameChunked(gameId)) hashed += 1;
          else failed += 1;
        } catch (error) {
          this.logger.warn({ err: error, gameId }, 'could not chunk-hash game');
          failed += 1;
        }

        this.sweep = {
          ...this.sweep,
          hashed,
          failed,
          currentGameId: null,
          currentGameTitle: null,
        };
      }
    } finally {
      this.stopSweepRequested = false;
      this.sweep = {
        ...this.sweep,
        running: false,
        stopping: false,
        currentGameId: null,
        currentGameTitle: null,
        finishedAt: new Date().toISOString(),
        hashed,
        failed,
        remaining: Math.max(0, pending.length - hashed - failed),
        note,
      };
    }

    return { hashed, failed };
  }

  /**
   * Start the sweep, or say that one is already going.
   *
   * Fire and forget: the pass takes hours on a real archive, so the caller gets
   * an answer immediately and watches `getSweepProgress` rather than holding a
   * request open for the length of it. Two callers — the timer a node runs and
   * an operator pressing the button on its page — drive the same one run.
   */
  startSweep(shouldPause: () => boolean = () => false, options: { force?: boolean } = {}): boolean {
    if (this.sweeping) return false;

    this.stopSweepRequested = false;
    this.sweeping = this.hashUnhashed(shouldPause, options)
      .then((result) => {
        if (result.hashed > 0 || result.failed > 0) {
          this.logger.info(result, 'hashed games so they can be served from this node');
        }
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'chunk hashing sweep failed');
      })
      .finally(() => {
        this.sweeping = null;
      });

    return true;
  }

  /**
   * Ask the sweep to stop after the game it is on.
   *
   * Between games rather than mid-file: a game already hashed is skipped next
   * time, so stopping at a boundary loses nothing, while abandoning a file
   * part-way would mean re-reading it from the beginning.
   */
  stopSweep(): boolean {
    if (!this.sweeping) return false;
    this.stopSweepRequested = true;
    this.sweep = { ...this.sweep, stopping: true };
    return true;
  }

  /** Whether a sweep is in flight right now. */
  get isSweeping(): boolean {
    return this.sweeping !== null;
  }

  start(gameId: string, options: { force?: boolean } = {}): Promise<void> {
    if (this.running) {
      throw ApiError.conflict('Chunk hashes are already being computed');
    }

    this.running = this.run(gameId, options.force ?? false)
      .catch((error: unknown) => {
        this.logger.error({ err: error, gameId }, 'chunk hashing failed');
        this.progress = {
          ...this.progress,
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        this.running = null;
      });

    return this.running;
  }

  private async run(gameId: string, force: boolean): Promise<void> {
    const row = this.db
      .select({ game: games, libraryPath: libraries.path })
      .from(games)
      .innerJoin(libraries, eq(libraries.id, games.libraryId))
      .where(eq(games.id, gameId))
      .get();

    if (!row) throw ApiError.notFound('Game not found');
    if (row.game.missingAt) throw ApiError.gone('This game is no longer present on disk');
    if (row.game.kind !== 'archive' || !row.game.relPath.toLowerCase().endsWith('.zip')) {
      throw ApiError.conflict('Only .zip game packages are chunk-hashed for downloads');
    }

    const files = this.db.select().from(gameFiles).where(eq(gameFiles.gameId, gameId)).all();

    // A rebuild is verification, not a best-effort refresh. Invalidate the old
    // answers before reading so one file that can no longer be opened cannot
    // leave the game looking healthy on hashes calculated from older bytes.
    if (force && files.length > 0) {
      this.db.transaction((tx) => {
        for (let offset = 0; offset < files.length; offset += 400) {
          const ids = files.slice(offset, offset + 400).map((file) => file.id);
          tx.delete(gameFileChunks).where(inArray(gameFileChunks.fileId, ids)).run();
          tx.update(gameFiles)
            .set({ sha256: null, chunkedAt: null, chunkBytes: null })
            .where(inArray(gameFiles.id, ids))
            .run();
        }
      });
    }

    // A file already hashed on this grid is skipped; one hashed on a different
    // grid is not, because its rows describe boundaries nobody uses any more.
    const pending = force ? files : files.filter((file) => file.chunkBytes !== MESH_CHUNK_BYTES);

    this.gameRate.reset();
    this.progress = {
      ...idleHashProgress(),
      gameId,
      gameTitle: row.game.title,
      state: 'hashing',
      total: pending.length,
      bytesTotal: pending.reduce((sum, file) => sum + file.sizeBytes, 0),
      startedAt: new Date().toISOString(),
      concurrency: this.concurrency,
      threaded: this.pool.threaded,
    };

    this.sweep = {
      ...this.sweep,
      currentGameId: gameId,
      currentGameTitle: row.game.title,
    };

    const gameRoot = resolveWithin(row.libraryPath, row.game.relPath);

    /** One file, start to finish. Several of these are in flight at once. */
    const hashOne = async (file: (typeof pending)[number]): Promise<void> => {
      this.openFile(file.relPath);

      try {
        const candidate =
          row.game.kind === 'archive' ? gameRoot : resolveWithin(gameRoot, file.relPath);
        const absolute = await assertRealPathWithin(row.libraryPath, candidate);
        const digest = await this.pool.chunked(absolute, (bytes) => this.readBytes(bytes));
        this.store(file.id, digest);
      } catch (error) {
        // One unreadable file should not abandon the rest of the game; it just
        // stays unchunked, which keeps the game off the mesh until it is fixed.
        this.logger.warn({ err: error, file: file.relPath }, 'could not chunk-hash file');
      }

      this.closeFile(file.relPath);
    };

    await runWithConcurrency(pending, this.concurrency, hashOne);

    this.progress = {
      ...this.progress,
      state: 'idle',
      currentFiles: [],
      currentFile: null,
      etaSeconds: null,
      bytesPerSecond: 0,
    };
  }

  /* --------------------------------------------------------- progress bookkeeping */

  /** Names a file as open, so the readout can say what is being read. */
  private openFile(relPath: string): void {
    const currentFiles = [...this.progress.currentFiles, relPath];
    this.progress = { ...this.progress, currentFiles, currentFile: currentFiles[0] ?? null };
  }

  private closeFile(relPath: string): void {
    const currentFiles = this.progress.currentFiles.filter((name) => name !== relPath);
    this.progress = {
      ...this.progress,
      currentFiles,
      currentFile: currentFiles[0] ?? null,
      processed: this.progress.processed + 1,
    };
  }

  /**
   * Bytes just read, counted against both the game and the sweep.
   *
   * Counted as they arrive rather than a file at a time: a game can be one
   * 60 GB archive, and a bar that only moves when a file finishes would sit
   * still for the whole of it.
   */
  private readBytes(bytes: number): void {
    this.gameRate.add(bytes);
    this.sweepRate.add(bytes);
    this.progress = { ...this.progress, bytesProcessed: this.progress.bytesProcessed + bytes };
    if (this.sweep.running) {
      this.sweep = { ...this.sweep, bytesHashed: this.sweep.bytesHashed + bytes };
    }
  }

  /**
   * Replace a file's chunk rows and mark it hashed.
   *
   * Wrapped in a transaction because the delete and the insert together are one
   * change: a crash between them would leave the file marked as hashed on the
   * current grid with no rows to back it up, and the manifest would then
   * advertise a mesh-eligible file whose pieces cannot be verified.
   */
  private store(fileId: string, digest: FileDigest): void {
    this.db.transaction((tx) => {
      tx.delete(gameFileChunks).where(eq(gameFileChunks.fileId, fileId)).run();

      for (let offset = 0; offset < digest.chunks.length; offset += 200) {
        const batch = digest.chunks.slice(offset, offset + 200);
        tx.insert(gameFileChunks)
          .values(
            batch.map((chunk) => ({
              fileId,
              chunkIndex: chunk.index,
              sizeBytes: chunk.sizeBytes,
              sha256: chunk.sha256,
            })),
          )
          .run();
      }

      tx.update(gameFiles)
        .set({
          sha256: digest.whole,
          chunkedAt: new Date().toISOString(),
          chunkBytes: MESH_CHUNK_BYTES,
        })
        .where(eq(gameFiles.id, fileId))
        .run();
    });
  }
}

/**
 * Re-exported so the chunk grid still has one obvious home.
 *
 * The implementation moved next to the worker pool that calls it; every caller
 * and every test that already knew where to find it still does.
 */
export { hashFileByChunk };

/** Exported for tests: what the grid says a file of this size should produce. */
export const expectedChunkCount = chunkCountFor;

/** A sweep that has not started, or has finished and been read. */
function idleSweep(): SweepProgress {
  return {
    running: false,
    mode: 'missing',
    stopping: false,
    startedAt: null,
    finishedAt: null,
    hashed: 0,
    failed: 0,
    remaining: 0,
    total: 0,
    currentGameId: null,
    currentGameTitle: null,
    bytesHashed: 0,
    bytesTotal: 0,
    bytesPerSecond: 0,
    etaSeconds: null,
    note: null,
  };
}

/**
 * Runs `fn` over every item, `limit` at a time.
 *
 * A plain `Promise.all` would open every file at once, which on a folder game
 * of ten thousand files is a way to run out of descriptors rather than a way
 * to go faster.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
}
