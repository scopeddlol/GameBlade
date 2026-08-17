import {
  artworkSearchSchema,
  editGameSchema,
  gameQuerySchema,
  launchRuleSchema,
  matchGameSchema,
  saveRuleSchema,
  setArtworkSchema,
  type DownloadManifest,
  type GameFileEntry,
} from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireUser } from '../auth/middleware.js';
import {
  gameFiles,
  gameLaunchRules,
  games,
  gameSaveRules,
  libraries,
  userGameState,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import { toGameDetail, toLaunchRule, toSaveRule } from './mappers.js';

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, metadata, downloadTokens, catalog, achievements, images } = app.gameblade;
  const basePath = config.basePath;

  app.get('/games', async (request) => {
    const context = requireUser(request);
    return catalog.search(context.user.id, gameQuerySchema.parse(request.query));
  });

  /** Distinct genres, platforms and developers, for the Store filter rail. */
  app.get('/games/filters', async (request) => {
    requireUser(request);
    const facets = catalog.facets();
    const libraryRows = db.select().from(libraries).all();
    return { ...facets, libraries: libraryRows.map((l) => ({ id: l.id, name: l.name })) };
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

    const [summary] = catalog.decorate([row.game], context.user.id);
    if (!summary) throw ApiError.notFound('Game not found');

    return toGameDetail(row.game, summary, { basePath, libraryName: row.libraryName });
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

    // Installing implies wanting it in the library, so the two never drift.
    catalog.addToLibrary(context.user.id, id);

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

  app.get('/games/:id/achievements', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    return achievements.listForGame(id, context.user.id);
  });

  /**
   * The rules the desktop client needs to actually run and back up a game:
   * where its executable lives and where it keeps its saves.
   */
  app.get('/games/:id/rules', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };

    return {
      save: db
        .select()
        .from(gameSaveRules)
        .where(eq(gameSaveRules.gameId, id))
        .all()
        .map(toSaveRule),
      launch: db
        .select()
        .from(gameLaunchRules)
        .where(eq(gameLaunchRules.gameId, id))
        .all()
        .map(toLaunchRule),
    };
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

  /**
   * Hand edits to a game's metadata. Saving marks the entry `manual`, which is
   * what stops the next library scan from overwriting the curation.
   */
  app.patch('/games/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = editGameSchema.parse(request.body);

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const patch: Partial<typeof games.$inferInsert> = { updatedAt: isoNow() };

    if (input.title !== undefined) patch.title = input.title;
    if (input.sortTitle !== undefined)
      patch.sortTitle = input.sortTitle ?? input.title ?? game.title;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.storyline !== undefined) patch.storyline = input.storyline;
    if (input.releaseDate !== undefined) patch.releaseDate = input.releaseDate;
    if (input.rating !== undefined) patch.rating = input.rating;
    if (input.developers !== undefined) patch.developers = input.developers;
    if (input.publishers !== undefined) patch.publishers = input.publishers;
    if (input.genres !== undefined) patch.genres = input.genres;
    if (input.platforms !== undefined) patch.platforms = input.platforms;
    if (input.videos !== undefined) patch.videos = input.videos;
    if (input.steamAppId !== undefined) patch.steamAppId = input.steamAppId;

    // Supplied screenshot URLs are downloaded into the local cache first, so
    // the client keeps loading them even if the origin disappears.
    if (input.screenshots !== undefined) {
      patch.screenshots = input.screenshots
        ? await images.cacheMany(input.screenshots, 'screenshot')
        : null;
    }

    patch.matchStatus = input.matchStatus ?? 'manual';

    db.update(games).set(patch).where(eq(games.id, id)).run();
    return { ok: true };
  });

  /**
   * Every image both providers have for a title, so an administrator can pick
   * one by eye rather than accepting whatever the automatic pass chose.
   */
  app.get('/games/:id/artwork/search', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const { kind, q } = request.query as { kind?: string; q?: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const parsed = artworkSearchSchema.parse({ kind, query: q?.trim() || game.searchTitle });
    return metadata.searchArtwork(parsed.kind, parsed.query);
  });

  /** Replaces one artwork slot with an operator-supplied image. */
  app.put('/games/:id/artwork', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = setArtworkSchema.parse(request.body);

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const imageId = input.url ? await images.cache(input.url, input.kind) : null;
    const column = {
      cover: 'coverImageId',
      hero: 'heroImageId',
      logo: 'logoImageId',
      icon: 'iconImageId',
    }[input.kind] as 'coverImageId' | 'heroImageId' | 'logoImageId' | 'iconImageId';

    db.update(games)
      .set({ [column]: imageId, updatedAt: isoNow() })
      .where(eq(games.id, id))
      .run();

    return { ok: true, imageId };
  });

  app.post('/games/:id/refresh-artwork', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    await metadata.fetchArtwork(id, game.searchTitle);
    return { ok: true };
  });

  // ---- Launch and save rules (administrators only) ----

  app.put('/games/:id/save-rule', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = saveRuleSchema.parse(request.body);

    const game = db.select({ id: games.id }).from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    // One rule per game keeps the client's job unambiguous, so a save replaces
    // whatever was there rather than accumulating.
    db.delete(gameSaveRules).where(eq(gameSaveRules.gameId, id)).run();
    const record = {
      id: newId('svr'),
      gameId: id,
      pathTemplate: input.pathTemplate,
      include: input.include ?? null,
      exclude: input.exclude ?? null,
      note: input.note ?? null,
      createdAt: isoNow(),
    };
    db.insert(gameSaveRules).values(record).run();
    return toSaveRule(record);
  });

  app.delete('/games/:id/save-rule', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    db.delete(gameSaveRules).where(eq(gameSaveRules.gameId, id)).run();
    return { ok: true };
  });

  app.put('/games/:id/launch-rule', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = launchRuleSchema.parse(request.body);

    const game = db.select({ id: games.id }).from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    db.delete(gameLaunchRules).where(eq(gameLaunchRules.gameId, id)).run();
    const record = {
      id: newId('lnr'),
      gameId: id,
      executable: input.executable ?? null,
      args: input.args ?? null,
      workingDir: input.workingDir ?? null,
      note: input.note ?? null,
      createdAt: isoNow(),
    };
    db.insert(gameLaunchRules).values(record).run();
    return toLaunchRule(record);
  });

  app.delete('/games/:id/launch-rule', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    db.delete(gameLaunchRules).where(eq(gameLaunchRules.gameId, id)).run();
    return { ok: true };
  });

  /**
   * Compute SHA-256 for a game's files, enabling end-to-end verification in the
   * desktop client. Opt-in per game because it reads every byte from disk.
   */
  app.post('/games/:id/checksums', async (request, reply) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const { force } = (request.body ?? {}) as { force?: boolean };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    if (app.gameblade.checksums.isRunning) {
      return reply.code(409).send({
        error: { code: 'checksums_in_progress', message: 'Checksums are already being computed' },
      });
    }

    // Runs in the background; the client polls progress.
    void app.gameblade.checksums.start(id, { force: force ?? false });
    return reply.code(202).send({ started: true });
  });

  app.get('/games/checksums/progress', async (request) => {
    requireAdmin(request);
    return app.gameblade.checksums.getProgress();
  });

  /** Exclude a game from future auto-matching without deleting it. */
  app.post('/games/:id/skip-match', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    db.update(games).set({ matchStatus: 'skipped' }).where(eq(games.id, id)).run();
    return { ok: true };
  });

  /** Removes a game from the caller's library without touching the archive. */
  app.delete('/games/:id/library', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    catalog.removeFromLibrary(context.user.id, id);
    return { ok: true };
  });

  app.post('/games/:id/library', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    catalog.addToLibrary(context.user.id, id);
    return { ok: true };
  });
}
