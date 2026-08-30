import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFiles, games, libraries } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { assertRealPathWithin, resolveWithin } from '../lib/paths.js';
import {
  HashPool,
  RateMeter,
  defaultHashConcurrency,
  etaFrom,
  idleHashProgress,
  type HashProgress,
} from './hashing.js';
import type { Logger } from './metadata/service.js';

/** What the integrity pass is doing, in the same shape the chunk pass reports. */
export type ChecksumProgress = HashProgress;

/**
 * Computes SHA-256 for a game's files so the desktop client can verify what it
 * downloaded.
 *
 * Hashing is deliberately opt-in per game rather than part of a scan: it reads
 * every byte in the library, which is far too expensive to do automatically for
 * a multi-terabyte archive that is usually only browsed. What it does not have
 * to be is sequential — the files are read several at a time, on worker threads
 * where there are any, so the pass is limited by the disk rather than by one
 * core of one process.
 */
export class ChecksumService {
  private progress: ChecksumProgress = idleHashProgress();

  private running: Promise<void> | null = null;

  private readonly concurrency: number;
  private readonly pool: HashPool;
  private readonly rate = new RateMeter();

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

  getProgress(): ChecksumProgress {
    const remaining = Math.max(0, this.progress.bytesTotal - this.progress.bytesProcessed);
    const bytesPerSecond = this.progress.state === 'hashing' ? this.rate.rate() : 0;
    return {
      ...this.progress,
      bytesPerSecond,
      etaSeconds: this.progress.state === 'hashing' ? etaFrom(remaining, bytesPerSecond) : null,
      currentFiles: [...this.progress.currentFiles],
    };
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Releases the worker threads. Called when the server shuts down. */
  async close(): Promise<void> {
    await this.pool.close();
  }

  /**
   * Hash a game's files, or check the ones already hashed against the disk.
   *
   * Verifying is the same walk with the answer compared rather than stored. For
   * an archive a file whose contents no longer match what was recorded is
   * almost always corruption rather than an edit, and nothing else here would
   * ever notice it.
   */
  start(gameId: string, options: { force?: boolean; verify?: boolean } = {}): Promise<void> {
    if (this.running) {
      throw ApiError.conflict('Checksums are already being computed');
    }

    this.running = this.run(gameId, options.force ?? false, options.verify ?? false)
      .catch((error: unknown) => {
        this.logger.error({ err: error, gameId }, 'checksum computation failed');
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

  private async run(gameId: string, force: boolean, verify: boolean): Promise<void> {
    const row = this.db
      .select({ game: games, libraryPath: libraries.path })
      .from(games)
      .innerJoin(libraries, eq(libraries.id, games.libraryId))
      .where(eq(games.id, gameId))
      .get();

    if (!row) throw ApiError.notFound('Game not found');
    if (row.game.missingAt) throw ApiError.gone('This game is no longer present on disk');

    const files = this.db.select().from(gameFiles).where(eq(gameFiles.gameId, gameId)).all();

    // Verifying only has something to say about files that were hashed once
    // already; there is nothing to compare the rest against.
    const pending = verify
      ? files.filter((file) => file.sha256 !== null)
      : force
        ? files
        : files.filter((file) => file.sha256 === null);

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

    const gameRoot = resolveWithin(row.libraryPath, row.game.relPath);

    const hashOne = async (file: (typeof pending)[number]): Promise<void> => {
      this.openFile(file.relPath);

      try {
        const candidate =
          row.game.kind === 'archive' ? gameRoot : resolveWithin(gameRoot, file.relPath);
        const absolute = await assertRealPathWithin(row.libraryPath, candidate);
        const digest = await this.pool.whole(absolute, (bytes) => this.readBytes(bytes));

        if (verify) {
          this.db
            .update(gameFiles)
            .set({
              integrity: digest === file.sha256 ? 'ok' : 'mismatch',
              verifiedAt: new Date().toISOString(),
            })
            .where(eq(gameFiles.id, file.id))
            .run();
        } else {
          this.db.update(gameFiles).set({ sha256: digest }).where(eq(gameFiles.id, file.id)).run();
        }
      } catch (error) {
        // One unreadable file should not abandon the rest of the game. While
        // verifying, being unable to read it is itself the finding.
        if (verify) {
          this.db
            .update(gameFiles)
            .set({ integrity: 'missing', verifiedAt: new Date().toISOString() })
            .where(eq(gameFiles.id, file.id))
            .run();
        }
        this.logger.warn({ err: error, file: file.relPath }, 'could not hash file');
      }

      this.closeFile(file.relPath);
    };

    await runWithConcurrency(pending, this.concurrency, hashOne);

    this.progress = {
      ...this.progress,
      state: 'idle',
      currentFiles: [],
      currentFile: null,
      bytesPerSecond: 0,
      etaSeconds: null,
    };
  }

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

  private readBytes(bytes: number): void {
    this.rate.add(bytes);
    this.progress = { ...this.progress, bytesProcessed: this.progress.bytesProcessed + bytes };
  }
}

/** Runs `fn` over every item, `limit` at a time. */
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
