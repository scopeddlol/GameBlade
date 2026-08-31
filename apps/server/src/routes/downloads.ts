import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { MESH_CHUNK_BYTES } from '@gameblade/shared';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZipFile } from 'yazl';
import { downloadEvents, gameFiles, games, libraries, type Game } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertRealPathWithin, contentDisposition, resolveWithin } from '../lib/paths.js';
import { ifRangeMatches, makeETag, parseRange } from '../lib/range.js';
import { createThrottle } from '../lib/throttle.js';

/** Bounded parallel stat so a folder game with thousands of files stays quick. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  const { db, downloadTokens, bandwidth, chunks, config, mesh } = app.gameblade;

  /**
   * Applies the configured per-stream speed limit.
   *
   * Returns the source untouched when no limit is set, so the default
   * configuration keeps the zero-copy path a plain file stream has.
   */
  function meter(source: Readable): Readable {
    const limit = bandwidth.speedLimitBytesPerSecond();
    if (limit <= 0) return source;

    const throttle = createThrottle(limit);
    // Without this, destroying the source on a quota cutoff would leave the
    // throttle open and the response hanging.
    source.on('error', (error) => throttle.destroy(error));
    return source.pipe(throttle);
  }

  /**
   * Downloads accept either normal authentication or a signed token, because a
   * desktop downloader opening many parallel connections should not have to
   * replay credentials on each one.
   */
  function resolveDownloadUser(request: FastifyRequest, gameId: string, fileId?: string): string {
    const token = (request.query as { token?: string }).token;
    if (token) {
      const claims = downloadTokens.verify(token);
      if (claims.gameId !== gameId) {
        throw ApiError.forbidden('This download token is for a different game');
      }
      if (claims.fileId && claims.fileId !== fileId) {
        throw ApiError.forbidden('This download token is for a different file');
      }
      return claims.userId;
    }

    if (!request.auth) throw ApiError.unauthorized();
    return request.auth.user.id;
  }

  function loadGame(gameId: string): { game: Game; libraryPath: string } {
    const row = db
      .select({ game: games, libraryPath: libraries.path })
      .from(games)
      .innerJoin(libraries, eq(libraries.id, games.libraryId))
      .where(eq(games.id, gameId))
      .get();

    if (!row) throw ApiError.notFound('Game not found');
    if (row.game.missingAt) throw ApiError.gone('This game is no longer present on disk');
    return row;
  }

  /**
   * How long after the last file a further one still counts as the same
   * download. Generous, because a slow link or a paused transfer should not
   * split one game into several, and two genuine downloads of the same game by
   * the same person within half an hour are rare enough not to matter.
   */
  const SESSION_GAP_MS = 30 * 60_000;

  /**
   * The download this file belongs to, or a new one.
   *
   * A game arrives as many files and each gets its own row, so without this
   * every count over the table measures files. The server cannot be told where
   * a download begins — the web client just requests files — so it is inferred
   * from the last event for the same game by the same person.
   */
  function sessionFor(userId: string, gameId: string, startedAt: string): string {
    const cutoff = new Date(Date.parse(startedAt) - SESSION_GAP_MS).toISOString();

    const recent = db
      .select({ sessionId: downloadEvents.sessionId })
      .from(downloadEvents)
      .where(
        and(
          eq(downloadEvents.userId, userId),
          eq(downloadEvents.gameId, gameId),
          gte(downloadEvents.startedAt, cutoff),
        ),
      )
      .orderBy(desc(downloadEvents.startedAt))
      .limit(1)
      .get();

    return recent?.sessionId ?? newId('dls');
  }

  function recordEvent(userId: string, gameId: string, fileId: string | null, client: string) {
    const id = newId('dle');
    const startedAt = new Date().toISOString();
    db.insert(downloadEvents)
      .values({
        id,
        userId,
        gameId,
        fileId,
        sessionId: sessionFor(userId, gameId, startedAt),
        client,
        startedAt,
      })
      .run();
    return id;
  }

  function finishEvent(eventId: string, bytesSent: number, completed: boolean) {
    db.update(downloadEvents)
      .set({ bytesSent, completed, finishedAt: new Date().toISOString() })
      .where(eq(downloadEvents.id, eventId))
      .run();
  }

  /**
   * Stream a single file with full byte-range support. This is the workhorse for
   * archive games and for every file the desktop client fetches.
   */
  async function streamFile(
    request: FastifyRequest,
    reply: FastifyReply,
    options: {
      absolutePath: string;
      downloadName: string;
      userId: string;
      gameId: string;
      fileId: string | null;
    },
  ): Promise<FastifyReply> {
    const info = await stat(options.absolutePath).catch(() => null);
    if (!info?.isFile()) {
      throw ApiError.gone('That file is no longer available');
    }

    // Refused before any header is written, so the client sees a JSON error
    // rather than a truncated octet-stream.
    const quota = bandwidth.assertWithinQuota(options.userId);

    const etag = makeETag(info.size, info.mtime.toISOString());
    const ifRange = request.headers['if-range'];
    const rangeHeader = ifRangeMatches(Array.isArray(ifRange) ? ifRange[0] : ifRange, etag)
      ? request.headers.range
      : undefined;
    const parsed = parseRange(rangeHeader, info.size);

    // Answered before the octet-stream headers below, so the error body is still
    // serialised as JSON rather than rejected as an invalid binary payload.
    if (parsed.type === 'unsatisfiable') {
      return reply
        .code(416)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Range', `bytes */${info.size}`)
        .type('application/json')
        .send({ error: { code: 'range_not_satisfiable', message: 'Requested range is invalid' } });
    }

    reply
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', contentDisposition(options.downloadName))
      .header('ETag', etag)
      .header('Last-Modified', info.mtime.toUTCString())
      // Nothing between here and the client should transform or buffer the body.
      .header('Cache-Control', 'private, no-transform')
      .header('X-Accel-Buffering', 'no');

    const start = parsed.type === 'satisfiable' ? parsed.range.start : 0;
    const end = parsed.type === 'satisfiable' ? parsed.range.end : Math.max(0, info.size - 1);
    const length = parsed.type === 'satisfiable' ? parsed.range.length : info.size;

    if (parsed.type === 'satisfiable') {
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    reply.header('Content-Length', String(length));

    if (request.method === 'HEAD') {
      return reply.send();
    }

    const eventId = recordEvent(
      options.userId,
      options.gameId,
      options.fileId,
      request.headers.authorization ? 'desktop' : 'web',
    );

    // An empty range would make createReadStream emit nothing but still needs a body.
    const source =
      info.size === 0
        ? createReadStream(options.absolutePath)
        : createReadStream(options.absolutePath, { start, end });

    let sent = 0;
    source.on('data', (chunk) => {
      sent += chunk.length;
      // Usage is only recorded when a stream closes, so a single transfer
      // larger than the whole allowance would otherwise sail past the check
      // above. Cutting it off here is what makes the quota an actual ceiling.
      if (quota.quotaBytes > 0 && quota.usedBytes + sent >= quota.quotaBytes) {
        source.destroy(new Error('monthly download quota reached'));
      }
    });
    source.on('close', () => {
      finishEvent(eventId, sent, sent >= length);
    });
    source.on('error', (error) => {
      request.log.warn({ err: error, path: options.absolutePath }, 'download stream failed');
      reply.raw.destroy();
    });

    return reply.send(meter(source));
  }

  /**
   * Stream a file held by a Node through the Coordinator.
   *
   * The Desktop already asks for fixed 8 MiB ranges concurrently. Each range
   * becomes a small authenticated HTTPS job for a Node, and the Coordinator
   * verifies the full chunk before forwarding it. Whole-file requests use a
   * four-chunk read-ahead window so browsers also receive a continuous stream
   * instead of a pause between files or chunks.
   */
  async function streamNodeFile(
    request: FastifyRequest,
    reply: FastifyReply,
    options: {
      gameId: string;
      fileId: string;
      filePath: string;
      sizeBytes: number;
      modifiedAt: string;
      userId: string;
    },
  ): Promise<FastifyReply> {
    const refs = chunks.chunksForGame(options.gameId).get(options.fileId) ?? [];
    const expectedChunks = Math.ceil(options.sizeBytes / MESH_CHUNK_BYTES);
    if (refs.length !== expectedChunks) {
      throw ApiError.gone('This game is still being prepared by its Node');
    }

    const quota = bandwidth.assertWithinQuota(options.userId);
    const etag = makeETag(options.sizeBytes, options.modifiedAt);
    const ifRange = request.headers['if-range'];
    const rangeHeader = ifRangeMatches(Array.isArray(ifRange) ? ifRange[0] : ifRange, etag)
      ? request.headers.range
      : undefined;
    const parsed = parseRange(rangeHeader, options.sizeBytes);
    if (parsed.type === 'unsatisfiable') {
      return reply
        .code(416)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Range', `bytes */${options.sizeBytes}`)
        .type('application/json')
        .send({ error: { code: 'range_not_satisfiable', message: 'Requested range is invalid' } });
    }

    const start = parsed.type === 'satisfiable' ? parsed.range.start : 0;
    const end =
      parsed.type === 'satisfiable' ? parsed.range.end : Math.max(0, options.sizeBytes - 1);
    const length = parsed.type === 'satisfiable' ? parsed.range.length : options.sizeBytes;

    reply
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', contentDisposition(path.basename(options.filePath)))
      .header('ETag', etag)
      .header('Last-Modified', new Date(options.modifiedAt).toUTCString())
      .header('Cache-Control', 'private, no-transform')
      .header('X-Accel-Buffering', 'no')
      .header('Content-Length', String(length));

    if (parsed.type === 'satisfiable') {
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${options.sizeBytes}`);
    }
    if (request.method === 'HEAD' || options.sizeBytes === 0) return reply.send();

    const firstIndex = Math.floor(start / MESH_CHUNK_BYTES);
    const lastIndex = Math.floor(end / MESH_CHUNK_BYTES);
    const fetch = (index: number) => {
      const ref = refs[index];
      if (!ref || ref.index !== index) {
        return Promise.reject(new Error(`Chunk ${index} is not available`));
      }
      const chunkStart = index * MESH_CHUNK_BYTES;
      const expectedBytes = Math.min(MESH_CHUNK_BYTES, options.sizeBytes - chunkStart);
      return mesh.fetchNodeChunk({
        userId: options.userId,
        gameId: options.gameId,
        fileId: options.fileId,
        chunkIndex: index,
        expectedBytes,
        sha256: ref.sha256,
      });
    };

    // Fetch the first piece before committing binary headers. An offline Node
    // then produces a useful 503 JSON response instead of a truncated download.
    const first = await fetch(firstIndex);
    reply.header('X-GameBlade-Node', encodeURIComponent(first.nodeLabel));

    const eventId = recordEvent(
      options.userId,
      options.gameId,
      options.fileId,
      request.headers.authorization ? 'desktop' : 'web',
    );

    const source = Readable.from(
      (async function* () {
        const pending = new Map<number, ReturnType<typeof fetch>>([
          [firstIndex, Promise.resolve(first)],
        ]);
        let next = firstIndex + 1;
        const fill = () => {
          while (next <= lastIndex && pending.size < 4) {
            pending.set(next, fetch(next));
            next += 1;
          }
        };
        fill();

        for (let index = firstIndex; index <= lastIndex; index += 1) {
          const delivered = await pending.get(index)!;
          pending.delete(index);
          fill();

          const chunkStart = index * MESH_CHUNK_BYTES;
          const from = Math.max(0, start - chunkStart);
          const through = Math.min(delivered.bytes.length, end - chunkStart + 1);
          yield delivered.bytes.subarray(from, through);
        }
      })(),
    );

    let sent = 0;
    source.on('data', (piece: Buffer) => {
      sent += piece.length;
      if (quota.quotaBytes > 0 && quota.usedBytes + sent >= quota.quotaBytes) {
        source.destroy(new Error('monthly download quota reached'));
      }
    });
    source.on('close', () => finishEvent(eventId, sent, sent >= length));
    source.on('error', (error) => {
      request.log.warn({ err: error, gameId: options.gameId }, 'proxied Node stream failed');
      reply.raw.destroy();
    });

    return reply.send(meter(source));
  }

  /** Archive games, and folder games requested as a single ZIP. */
  app.route({
    method: ['GET', 'HEAD'],
    url: '/download/:gameId',
    // A desktop client opens many parallel connections per game on purpose;
    // the global request limiter would read that as abuse.
    config: { rateLimit: false },
    handler: async (request, reply) => {
      const { gameId } = request.params as { gameId: string };
      const userId = resolveDownloadUser(request, gameId);
      const { game, libraryPath } = loadGame(gameId);

      if (!config.servesLocalFiles) {
        if (game.kind !== 'archive') {
          throw ApiError.conflict(
            'Folder games are installed through the GameBlade Desktop app so they can resume safely.',
          );
        }
        const file = db.select().from(gameFiles).where(eq(gameFiles.gameId, gameId)).get();
        if (!file) throw ApiError.gone('This game has no downloadable file');
        return streamNodeFile(request, reply, {
          gameId,
          fileId: file.id,
          filePath: file.relPath,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          userId,
        });
      }

      const gameRoot = resolveWithin(libraryPath, game.relPath);

      if (game.kind === 'archive') {
        const absolute = await assertRealPathWithin(libraryPath, gameRoot);
        return streamFile(request, reply, {
          absolutePath: absolute,
          downloadName: path.basename(game.relPath),
          userId,
          gameId,
          fileId: null,
        });
      }

      return streamFolderAsZip(request, reply, { game, gameRoot, libraryPath, userId });
    },
  });

  /** One file out of a folder game — resumable, and the desktop client's path. */
  app.route({
    method: ['GET', 'HEAD'],
    url: '/download/:gameId/files/:fileId',
    config: { rateLimit: false },
    handler: async (request, reply) => {
      const { gameId, fileId } = request.params as { gameId: string; fileId: string };
      const userId = resolveDownloadUser(request, gameId, fileId);
      const { game, libraryPath } = loadGame(gameId);

      const file = db.select().from(gameFiles).where(eq(gameFiles.id, fileId)).get();
      if (!file || file.gameId !== gameId) {
        throw ApiError.notFound('File not found');
      }

      if (!config.servesLocalFiles) {
        return streamNodeFile(request, reply, {
          gameId,
          fileId: file.id,
          filePath: file.relPath,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          userId,
        });
      }

      const gameRoot = resolveWithin(libraryPath, game.relPath);
      const candidate = game.kind === 'archive' ? gameRoot : resolveWithin(gameRoot, file.relPath);
      const absolute = await assertRealPathWithin(libraryPath, candidate);

      return streamFile(request, reply, {
        absolutePath: absolute,
        downloadName: path.basename(file.relPath),
        userId,
        gameId,
        fileId,
      });
    },
  });

  /**
   * A fresh signed token for a game the caller can already authenticate for.
   *
   * Manifest tokens expire after six hours, which a paused-over-the-weekend or
   * very slow transfer can outlive. Rather than refetching the whole manifest
   * and re-deriving what is already on disk, the downloader exchanges its
   * device token for a new download token here and keeps streaming.
   */
  app.post('/download/:gameId/token', async (request) => {
    if (!request.auth) throw ApiError.unauthorized();
    const { gameId } = request.params as { gameId: string };
    const game = db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get();
    if (!game) throw ApiError.notFound('Game not found');

    return downloadTokens.issue({ userId: request.auth.user.id, gameId });
  });

  /**
   * Package a folder game into a ZIP on the fly.
   *
   * Entries are stored, never deflated: game data is already compressed, so
   * deflate would burn CPU for nothing, and storing lets yazl compute the exact
   * archive size up front. That gives a real Content-Length, which is what turns
   * a browser download into one with a progress bar and an ETA.
   *
   * A generated ZIP is deliberately not resumable — clients that need resume use
   * the per-file routes above via the manifest.
   */
  async function streamFolderAsZip(
    request: FastifyRequest,
    reply: FastifyReply,
    options: { game: Game; gameRoot: string; libraryPath: string; userId: string },
  ): Promise<FastifyReply> {
    const { game, gameRoot, libraryPath, userId } = options;

    const quota = bandwidth.assertWithinQuota(userId);

    const files = db.select().from(gameFiles).where(eq(gameFiles.gameId, game.id)).all();
    if (files.length === 0) {
      throw ApiError.gone('This game has no files to download');
    }

    // Sizes must match the bytes we actually stream, so re-stat rather than
    // trusting a scan that may predate an update on disk.
    const resolved = await mapWithConcurrency(files, 16, async (file) => {
      try {
        const candidate = resolveWithin(gameRoot, file.relPath);
        const absolute = await assertRealPathWithin(libraryPath, candidate);
        const info = await stat(absolute);
        if (!info.isFile()) return null;
        return { absolute, relPath: file.relPath, size: info.size, mtime: info.mtime };
      } catch {
        return null;
      }
    });

    const usable = resolved.filter((f): f is NonNullable<typeof f> => f !== null);
    if (usable.length === 0) {
      throw ApiError.gone('None of this game’s files are readable');
    }

    const zip = new ZipFile();
    for (const file of usable) {
      // yazl stats each file itself; passing an explicit size is not supported
      // by addFile and would be ignored.
      zip.addFile(file.absolute, file.relPath, {
        compress: false,
        mtime: file.mtime,
      });
    }

    // yazl can only report a final size once every entry has been stat-ed, and
    // it stays silent if it cannot work one out. Bound the wait so a slow or
    // unusual filesystem degrades to a chunked response instead of hanging.
    const finalSize = await new Promise<number>((resolve) => {
      let settled = false;
      const done = (size: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(size);
      };
      const timer = setTimeout(() => done(-1), 10_000);
      timer.unref?.();
      zip.end({ forceZip64Format: false }, (size: number) => done(size));
    });

    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition(`${game.title}.zip`))
      .header('Cache-Control', 'private, no-transform')
      .header('X-Accel-Buffering', 'no')
      // Resuming a generated archive is not supported; say so explicitly.
      .header('Accept-Ranges', 'none');

    // yazl reports -1 when it cannot predict the size; fall back to chunked.
    if (finalSize >= 0) {
      reply.header('Content-Length', String(finalSize));
    }

    const output: Readable = zip.outputStream;

    if (request.method === 'HEAD') {
      output.destroy();
      return reply.send();
    }

    const eventId = recordEvent(
      userId,
      game.id,
      null,
      request.headers.authorization ? 'desktop' : 'web',
    );

    let sent = 0;
    output.on('data', (chunk: Buffer) => {
      sent += chunk.length;
      if (quota.quotaBytes > 0 && quota.usedBytes + sent >= quota.quotaBytes) {
        output.destroy(new Error('monthly download quota reached'));
      }
    });
    output.on('close', () => {
      finishEvent(eventId, sent, finalSize < 0 ? true : sent >= finalSize);
    });
    output.on('error', (error: Error) => {
      request.log.warn({ err: error, game: game.id }, 'zip stream failed');
      reply.raw.destroy();
    });

    return reply.send(meter(output));
  }
}
