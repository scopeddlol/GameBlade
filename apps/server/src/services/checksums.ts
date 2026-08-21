import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFiles, games, libraries } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { assertRealPathWithin, resolveWithin } from '../lib/paths.js';
import type { Logger } from './metadata/service.js';

export interface ChecksumProgress {
  gameId: string | null;
  state: 'idle' | 'hashing' | 'error';
  processed: number;
  total: number;
  currentFile: string | null;
  error: string | null;
}

/**
 * Computes SHA-256 for a game's files so the desktop client can verify what it
 * downloaded.
 *
 * Hashing is deliberately opt-in per game rather than part of a scan: it reads
 * every byte in the library, which is far too expensive to do automatically for
 * a multi-terabyte archive that is usually only browsed.
 */
export class ChecksumService {
  private progress: ChecksumProgress = {
    gameId: null,
    state: 'idle',
    processed: 0,
    total: 0,
    currentFile: null,
    error: null,
  };

  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  getProgress(): ChecksumProgress {
    return { ...this.progress };
  }

  get isRunning(): boolean {
    return this.running !== null;
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
      gameId,
      state: 'hashing',
      processed: 0,
      total: pending.length,
      currentFile: null,
      error: null,
    };

    const gameRoot = resolveWithin(row.libraryPath, row.game.relPath);

    for (const file of pending) {
      this.progress = { ...this.progress, currentFile: file.relPath };

      try {
        const candidate =
          row.game.kind === 'archive' ? gameRoot : resolveWithin(gameRoot, file.relPath);
        const absolute = await assertRealPathWithin(row.libraryPath, candidate);
        const digest = await hashFile(absolute);

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

      this.progress = { ...this.progress, processed: this.progress.processed + 1 };
    }

    this.progress = {
      ...this.progress,
      state: 'idle',
      currentFile: null,
    };
  }
}

function hashFile(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    // Streamed so a 50 GB file never lands in memory.
    const stream = createReadStream(absolutePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
