import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { MESH_CHUNK_BYTES, chunkCountFor, type ChunkRef } from '@gameblade/shared';
import { and, eq, gt, inArray, isNull, or, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFileChunks, gameFiles, games, libraries } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { assertRealPathWithin, resolveWithin } from '../lib/paths.js';
import type { Logger } from './metadata/service.js';

export interface ChunkProgress {
  gameId: string | null;
  state: 'idle' | 'hashing' | 'error';
  processed: number;
  total: number;
  currentFile: string | null;
  error: string | null;
}

/** What one pass over a file produced. */
interface FileDigest {
  whole: string;
  chunks: ChunkRef[];
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
  private progress: ChunkProgress = {
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

  getProgress(): ChunkProgress {
    return { ...this.progress };
  }

  get isRunning(): boolean {
    return this.running !== null;
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
          // A zero-byte file has no chunks and never will, so a game made only
          // of those is finished rather than pending.
          gt(gameFiles.sizeBytes, 0),
          or(isNull(gameFiles.chunkBytes), ne(gameFiles.chunkBytes, MESH_CHUNK_BYTES)),
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
  async hashUnhashed(shouldStop: () => boolean = () => false): Promise<{
    hashed: number;
    failed: number;
  }> {
    let hashed = 0;
    let failed = 0;

    for (const gameId of this.unhashedGameIds()) {
      // An operator-triggered pass owns the service while it runs. Yielding to
      // it rather than queueing behind it: this sweep will come round again.
      if (shouldStop() || this.running) break;

      try {
        await this.start(gameId);
        if (this.isGameChunked(gameId)) hashed += 1;
        else failed += 1;
      } catch (error) {
        this.logger.warn({ err: error, gameId }, 'could not chunk-hash game');
        failed += 1;
      }
    }

    return { hashed, failed };
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

    const files = this.db.select().from(gameFiles).where(eq(gameFiles.gameId, gameId)).all();

    // A file already hashed on this grid is skipped; one hashed on a different
    // grid is not, because its rows describe boundaries nobody uses any more.
    const pending = force ? files : files.filter((file) => file.chunkBytes !== MESH_CHUNK_BYTES);

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
        const digest = await hashFileByChunk(absolute);
        this.store(file.id, digest);
      } catch (error) {
        // One unreadable file should not abandon the rest of the game; it just
        // stays unchunked, which keeps the game off the mesh until it is fixed.
        this.logger.warn({ err: error, file: file.relPath }, 'could not chunk-hash file');
      }

      this.progress = { ...this.progress, processed: this.progress.processed + 1 };
    }

    this.progress = { ...this.progress, state: 'idle', currentFile: null };
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
 * One streamed pass producing the whole-file hash and every chunk hash.
 *
 * The read stream's buffers have nothing to do with the chunk grid, so the
 * bytes are cut here rather than trusted to arrive aligned. Getting this wrong
 * is not a crash — it is a set of hashes that look fine and match nothing any
 * other implementation computes, so the split is deliberately explicit.
 */
export function hashFileByChunk(absolutePath: string): Promise<FileDigest> {
  return new Promise((resolve, reject) => {
    const whole = createHash('sha256');
    let chunkHash = createHash('sha256');
    let chunkFilled = 0;
    let index = 0;
    const chunks: ChunkRef[] = [];

    const closeChunk = () => {
      chunks.push({ index, sha256: chunkHash.digest('hex'), sizeBytes: chunkFilled });
      index += 1;
      chunkHash = createHash('sha256');
      chunkFilled = 0;
    };

    // Streamed, and never larger than one chunk in memory, so a 50 GB file
    // costs the same as a 50 MB one.
    const stream = createReadStream(absolutePath, { highWaterMark: 1024 * 1024 });

    stream.on('data', (buffer: string | Buffer) => {
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      whole.update(bytes);

      let consumed = 0;
      while (consumed < bytes.length) {
        const room = MESH_CHUNK_BYTES - chunkFilled;
        const take = Math.min(room, bytes.length - consumed);
        chunkHash.update(bytes.subarray(consumed, consumed + take));
        chunkFilled += take;
        consumed += take;

        if (chunkFilled === MESH_CHUNK_BYTES) closeChunk();
      }
    });

    stream.on('error', reject);

    stream.on('end', () => {
      // A trailing partial chunk still counts. An empty file gets none at all,
      // which is what `chunkCountFor` says it should have.
      if (chunkFilled > 0) closeChunk();
      resolve({ whole: whole.digest('hex'), chunks });
    });
  });
}

/** Exported for tests: what the grid says a file of this size should produce. */
export const expectedChunkCount = chunkCountFor;
