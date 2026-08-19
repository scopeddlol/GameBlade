import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
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
  const { db, downloadTokens, bandwidth } = app.gameblade;

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

  function recordEvent(userId: string, gameId: string, fileId: string | null, client: string) {
    const id = newId('dle');
    db.insert(downloadEvents)
      .values({
        id,
        userId,
        gameId,
        fileId,
        client,
        startedAt: new Date().toISOString(),
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
