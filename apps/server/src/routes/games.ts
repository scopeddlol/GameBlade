import {
  gameQuerySchema,
  matchGameSchema,
  type DownloadManifest,
  type GameFileEntry,
  type Paginated,
} from '@gameblade/shared';
import { and, asc, desc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireUser } from '../auth/middleware.js';
import { gameFiles, games, libraries, userGameState } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { toGameDetail, toGameSummary } from './mappers.js';

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, metadata, downloadTokens } = app.gameblade;
  const basePath = config.basePath;

  /** Favourite flags are per-user, so they are fetched alongside every listing. */
  function favouriteIds(userId: string, gameIds: string[]): Set<string> {
    if (gameIds.length === 0) return new Set();
    const rows = db
      .select({ gameId: userGameState.gameId })
      .from(userGameState)
      .where(and(eq(userGameState.userId, userId), eq(userGameState.isFavorite, true)))
      .all();
    const favourites = new Set(rows.map((r) => r.gameId));
    return new Set(gameIds.filter((id) => favourites.has(id)));
  }

  app.get('/games', async (request) => {
    const context = requireUser(request);
    const query = gameQuerySchema.parse(request.query);

    const conditions: SQL[] = [];

    if (!query.includeMissing) {
      conditions.push(isNull(games.missingAt));
    }
    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '')}%`;
      const searchCondition = or(like(games.title, term), like(games.searchTitle, term));
      if (searchCondition) conditions.push(searchCondition);
    }
    if (query.libraryId) {
      conditions.push(eq(games.libraryId, query.libraryId));
    }
    if (query.matchStatus) {
      conditions.push(eq(games.matchStatus, query.matchStatus));
    }
    // Genres and platforms are JSON arrays; matching the quoted value avoids
    // "Action" also matching "Action-Adventure".
    if (query.genre) {
      conditions.push(sql`${games.genres} LIKE ${`%"${query.genre}"%`}`);
    }
    if (query.platform) {
      conditions.push(sql`${games.platforms} LIKE ${`%"${query.platform}"%`}`);
    }
    if (query.favoritesOnly) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM user_game_state ugs
              WHERE ugs.game_id = ${games.id}
                AND ugs.user_id = ${context.user.id}
                AND ugs.is_favorite = 1)`,
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const sortColumn = {
      title: games.sortTitle,
      added: games.addedAt,
      released: games.releaseDate,
      size: games.sizeBytes,
      rating: games.rating,
    }[query.sort];

    const direction = query.order === 'desc' ? desc : asc;

    const rows = db
      .select()
      .from(games)
      .where(where)
      // Secondary sort keeps pagination stable when the primary key ties or is null.
      .orderBy(direction(sortColumn), asc(games.sortTitle))
      .limit(query.limit)
      .offset(query.offset)
      .all();

    const totalRow = db
      .select({ count: sql<number>`count(*)` })
      .from(games)
      .where(where)
      .get();

    const favourites = favouriteIds(
      context.user.id,
      rows.map((r) => r.id),
    );

    const body: Paginated<ReturnType<typeof toGameSummary>> = {
      items: rows.map((game) =>
        toGameSummary(game, { basePath, isFavorite: favourites.has(game.id) }),
      ),
      total: totalRow?.count ?? 0,
      offset: query.offset,
      limit: query.limit,
    };
    return body;
  });

  /** Distinct genres and platforms present in the library, for filter menus. */
  app.get('/games/filters', async (request) => {
    requireUser(request);
    const rows = db
      .select({ genres: games.genres, platforms: games.platforms })
      .from(games)
      .where(isNull(games.missingAt))
      .all();

    const genres = new Set<string>();
    const platforms = new Set<string>();
    for (const row of rows) {
      for (const g of row.genres ?? []) genres.add(g);
      for (const p of row.platforms ?? []) platforms.add(p);
    }

    const libraryRows = db.select().from(libraries).all();

    return {
      genres: [...genres].sort((a, b) => a.localeCompare(b)),
      platforms: [...platforms].sort((a, b) => a.localeCompare(b)),
      libraries: libraryRows.map((l) => ({ id: l.id, name: l.name })),
    };
  });

  app.get('/games/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };

    const row = db
      .select({ game: games, libraryName: libraries.name })
      .from(games)
      .innerJoin(libraries, eq(libraries.id, games.libraryId))
      .where(eq(games.id, id))
      .get();

    if (!row) throw ApiError.notFound('Game not found');

    const favourite = db
      .select()
      .from(userGameState)
      .where(and(eq(userGameState.userId, context.user.id), eq(userGameState.gameId, id)))
      .get();

    return toGameDetail(row.game, {
      basePath,
      libraryName: row.libraryName,
      isFavorite: favourite?.isFavorite ?? false,
    });
  });

  app.get('/games/:id/files', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };

    const files = db.select().from(gameFiles).where(eq(gameFiles.gameId, id)).all();
    const body: GameFileEntry[] = files.map((file) => ({
      id: file.id,
      path: file.relPath,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      sha256: file.sha256,
    }));
    return body;
  });

  /**
   * The manifest is what makes desktop downloads reliable: it hands the client
   * every file with its size plus one signed token, so the downloader can open
   * parallel connections and resume any of them without re-authenticating.
   */
  app.get('/games/:id/manifest', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');
    if (game.missingAt) {
      throw ApiError.gone('This game is no longer present on disk');
    }

    const files = db.select().from(gameFiles).where(eq(gameFiles.gameId, id)).all();
    const issued = downloadTokens.issue({ userId: context.user.id, gameId: id });

    const body: DownloadManifest = {
      gameId: game.id,
      title: game.title,
      kind: game.kind,
      totalBytes: game.sizeBytes,
      files: files.map((file) => ({
        id: file.id,
        path: file.relPath,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        sha256: file.sha256,
      })),
      token: issued.token,
      expiresAt: issued.expiresAt,
    };
    return body;
  });

  app.post('/games/:id/favorite', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const { favorite } = (request.body ?? {}) as { favorite?: boolean };

    const exists = db.select({ id: games.id }).from(games).where(eq(games.id, id)).get();
    if (!exists) throw ApiError.notFound('Game not found');

    db.insert(userGameState)
      .values({ userId: context.user.id, gameId: id, isFavorite: favorite ?? true })
      .onConflictDoUpdate({
        target: [userGameState.userId, userGameState.gameId],
        set: { isFavorite: favorite ?? true },
      })
      .run();

    return { ok: true, favorite: favorite ?? true };
  });

  // ---- Metadata management (administrators only) ----

  app.get('/games/:id/candidates', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const { q } = request.query as { q?: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    return metadata.searchCandidates(q?.trim() || game.searchTitle, 12);
  });

  app.post('/games/:id/match', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = matchGameSchema.parse(request.body);

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    if (input.igdbId === null) {
      metadata.clearMatch(id);
      return { ok: true, matchStatus: 'unmatched' };
    }

    await metadata.applyIgdbGame(id, input.igdbId, 'manual', {
      refreshArtwork: input.refreshArtwork,
    });
    return { ok: true, matchStatus: 'manual' };
  });

  app.post('/games/:id/refresh-artwork', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    await metadata.fetchArtwork(id, game.searchTitle);
    return { ok: true };
  });

  /** Exclude a game from future auto-matching without deleting it. */
  app.post('/games/:id/skip-match', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    db.update(games).set({ matchStatus: 'skipped' }).where(eq(games.id, id)).run();
    return { ok: true };
  });
}
