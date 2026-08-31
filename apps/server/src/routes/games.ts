import {
  achievementRulesSchema,
  reportUnlocksSchema,
  artworkSearchSchema,
  editGameSchema,
  gameQuerySchema,
  launchRuleSchema,
  matchGameSchema,
  matchLocalSchema,
  saveRuleSchema,
  setArtworkSchema,
  setScreenshotSchema,
  type ArtKind,
  type ClientButtonPlacement,
  type DownloadManifest,
  type LocalGameMatch,
  type GameFileEntry,
  type SaveRule,
  MESH_CHUNK_BYTES,
} from '@gameblade/shared';
import { eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireUser } from '../auth/middleware.js';
import {
  achievements as achievementDefinitions,
  gameAchievementRules,
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
import { similarity } from '../services/metadata/service.js';
import { parseTitle } from '../lib/titles.js';
import { toAchievementRule, toGameDetail, toLaunchRule, toSaveRule } from './mappers.js';

/** Which column on `games` backs each artwork slot. */
const ART_COLUMNS = {
  cover: 'coverImageId',
  banner: 'bannerImageId',
  hero: 'heroImageId',
  logo: 'logoImageId',
  icon: 'iconImageId',
} as const satisfies Record<ArtKind, keyof typeof games.$inferInsert>;

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  const {
    db,
    config,
    metadata,
    downloadTokens,
    catalog,
    achievements,
    images,
    clientButtons,
    chunks,
    mesh,
  } = app.gameblade;
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
    if (game.kind !== 'archive' || !game.relPath.toLowerCase().endsWith('.zip')) {
      throw ApiError.conflict(
        'GameBlade installs ZIP packages only. Store this game as a .zip archive and rescan the Node.',
      );
    }

    // The store already shows this one as coming soon rather than offering a
    // button, so reaching here means a stale page or a scripted client. Saying
    // exactly what is missing beats the ENOENT or empty-sources failure that
    // used to happen several minutes into a download.
    const availability = catalog.availabilityOf(game.id);
    if (availability.state !== 'ready') {
      throw ApiError.conflict(availability.note ?? 'This game cannot be installed yet');
    }

    const files = db.select().from(gameFiles).where(eq(gameFiles.gameId, id)).all();
    if (files.length !== 1 || !files[0]?.relPath.toLowerCase().endsWith('.zip')) {
      throw ApiError.conflict('This game does not have one valid ZIP package to install');
    }
    const issued = downloadTokens.issue({ userId: context.user.id, gameId: id });

    // Installing implies wanting it in the library, so the two never drift.
    catalog.addToLibrary(context.user.id, id);

    // Chunk hashes are only advertised when the whole game has them on the
    // current grid. A partly chunked game would leave the downloader deciding
    // per file whether a piece can be verified, and the answer to "can I trust
    // bytes from a stranger" should not vary within one download.
    const chunked = chunks.isGameChunked(id);
    const chunksByFile = chunked ? chunks.chunksForGame(id) : new Map();

    const body: DownloadManifest = {
      gameId: game.id,
      title: game.title,
      kind: 'archive',
      totalBytes: files[0].sizeBytes,
      files: files.map((file) => ({
        id: file.id,
        path: file.relPath,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        sha256: file.sha256,
        ...(chunked ? { chunks: chunksByFile.get(file.id) ?? [] } : {}),
      })),
      token: issued.token,
      expiresAt: issued.expiresAt,
      ...(chunked ? { chunkBytes: MESH_CHUNK_BYTES } : {}),
      // The Coordinator download route is always the Desktop's HTTPS origin.
      // In split deployments it obtains each requested chunk from a Node
      // before streaming it onward; that transport detail is deliberately
      // invisible to the client.
      originAvailable: true,
      sources: mesh.sourcesFor(id, {
        chunked,
        includeOrigin: config.servesLocalFiles,
        excludeOwnerId: context.user.id,
      }),
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
      // The client reads the game's own files against these after a session;
      // it needs them in the same call it already makes before launching.
      achievements: db
        .select()
        .from(gameAchievementRules)
        .where(eq(gameAchievementRules.gameId, id))
        .all()
        .map(toAchievementRule),
    };
  });

  /**
   * Writes the rules an operator was never going to type by hand.
   *
   * Achievements were definable and never unlocked, because using the rule
   * engine meant one hand-written rule per achievement per game — fifty
   * imported Steam achievements meant fifty rules requiring knowledge of that
   * game's save internals. Nobody was going to do that, so nothing ever fired.
   *
   * A DRM-free build almost always carries a Steam emulator in place of Steam,
   * and each emulator records unlocks at a predictable path in a predictable
   * shape, keyed by the same API names the importer already pulled down. So
   * every rule can be derived from what is already known.
   *
   * Rules are generated for *every* applicable layout at once, on purpose: one
   * whose file does not exist reads as nothing and unlocks nothing, so the
   * layouts that do not apply are silent and whichever the player's copy
   * actually uses is the one that fires.
   */
  app.post('/games/:id/achievement-rules/generate', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const { sources, replace = true } = (request.body ?? {}) as {
      sources?: string[];
      replace?: boolean;
    };

    // The work itself lives on the service, so the bulk importer writes rules
    // through exactly the same path this button does.
    return achievements.generateRules(id, { sources, replace });
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

  /** Operator-defined links the desktop client renders. Active rows only. */
  app.get('/client-buttons', async (request) => {
    requireUser(request);
    const { placement } = request.query as { placement?: ClientButtonPlacement };
    return clientButtons.listActive(placement);
  });

  /**
   * Matches folder names found on a player's machine against catalog titles,
   * so an already-installed copy can be linked rather than downloaded again.
   *
   * Scoring lives here rather than in the client because the normalisation and
   * similarity functions the scanner and the admin matcher already use are
   * here; a second implementation in Rust or TypeScript is just somewhere for
   * the two to disagree about what counts as a match.
   */
  app.post('/games/match-local', async (request) => {
    requireUser(request);
    const input = matchLocalSchema.parse(request.body);

    // One pass over the catalog for the whole batch: a player importing a
    // drive full of games would otherwise mean a query per folder.
    const catalogRows = db
      .select({ id: games.id, title: games.title, searchTitle: games.searchTitle })
      .from(games)
      .where(isNull(games.missingAt))
      .all();

    // Save rules for the whole catalog, in one pass for the same reason the
    // titles are: the importer wants to know where every match keeps its saves,
    // and a query per candidate would undo the point of batching at all.
    const saveRules = new Map<string, SaveRule>();
    for (const row of db.select().from(gameSaveRules).all()) {
      // One rule per game is what the editor writes; if an older database has
      // two, the first is the one every other reader here takes.
      if (!saveRules.has(row.gameId)) saveRules.set(row.gameId, toSaveRule(row));
    }

    const results: LocalGameMatch[] = input.names.map((name) => {
      // A folder is named the way a release is named — version tags, repack
      // group, bracketed junk — so it goes through the same parser the
      // scanner uses on a library directory before anything is compared.
      const cleaned = parseTitle(name, false);
      const scored = catalogRows
        .map((row) => ({
          gameId: row.id,
          title: row.title,
          // Both the display title and the parsed search title are tried; a
          // folder is as likely to be named after either.
          score: Math.max(similarity(cleaned, row.title), similarity(cleaned, row.searchTitle)),
        }))
        .filter((candidate) => candidate.score >= input.threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit)
        .map((candidate) => ({ ...candidate, saveRule: saveRules.get(candidate.gameId) ?? null }));

      return { name, matches: scored };
    });

    return { results };
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
    // Hand curation is exactly what the automatic pass must not undo.
    patch.metadataLockedAt = isoNow();

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
    const { kind, q, style } = request.query as { kind?: string; q?: string; style?: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const parsed = artworkSearchSchema.parse({
      kind,
      query: q?.trim() || game.searchTitle,
      style: style?.trim() || null,
    });
    return metadata.searchArtwork(parsed.kind, parsed.query, { style: parsed.style });
  });

  /** Replaces one artwork slot with an operator-supplied image. */
  app.put('/games/:id/artwork', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = setArtworkSchema.parse(request.body);

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const imageId = input.url ? await images.cache(input.url, input.kind) : null;
    if (input.url && !imageId) {
      throw ApiError.badRequest('That image could not be downloaded. Check the URL and try again.');
    }

    const column = ART_COLUMNS[input.kind];

    db.update(games)
      .set({ [column]: imageId, updatedAt: isoNow() })
      .where(eq(games.id, id))
      .run();

    return { ok: true, imageId };
  });

  /**
   * Adds one screenshot from the picker. Appending through its own route (and
   * not the metadata PATCH) is what keeps the existing shots addressable: the
   * PATCH takes provider URLs and re-downloads every one it is given, and the
   * screenshots already on a game are local cache URLs it could not re-fetch.
   */
  app.post('/games/:id/screenshots', async (request, reply) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = setScreenshotSchema.parse(request.body);

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const imageId = await images.cache(input.url, 'screenshot');
    if (!imageId) {
      throw ApiError.badRequest('That image could not be downloaded. Check the URL and try again.');
    }

    const existing = game.screenshots ?? [];
    if (!existing.includes(imageId)) {
      db.update(games)
        .set({ screenshots: [...existing, imageId], updatedAt: isoNow() })
        .where(eq(games.id, id))
        .run();
    }
    return reply.code(201).send({ ok: true, imageId });
  });

  app.delete('/games/:id/screenshots/:imageId', async (request) => {
    requireAdmin(request);
    const { id, imageId } = request.params as { id: string; imageId: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const remaining = (game.screenshots ?? []).filter((value) => value !== imageId);
    db.update(games)
      .set({ screenshots: remaining, updatedAt: isoNow() })
      .where(eq(games.id, id))
      .run();

    // The cached file itself stays: another game may well have been matched to
    // the same provider image, and orphans are cheap next to a broken thumbnail.
    return { ok: true };
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

  /**
   * The rules that decide when this game's achievements are earned.
   *
   * Replaced wholesale rather than edited one at a time: an operator works
   * these out by looking at one save file, and a partial update leaves rules
   * that were written against a different reading of it.
   */
  app.put('/games/:id/achievement-rules', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = achievementRulesSchema.parse(request.body);

    const game = db.select({ id: games.id }).from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    // Every rule must name an achievement this game actually has, or it could
    // never unlock anything and the operator would have no way to tell.
    const known = new Set(
      db
        .select({ key: achievementDefinitions.key })
        .from(achievementDefinitions)
        .where(eq(achievementDefinitions.gameId, id))
        .all()
        .map((row) => row.key),
    );
    const unknown = input.rules.filter((rule) => !known.has(rule.achievementKey));
    if (unknown.length > 0) {
      throw ApiError.badRequest(
        `No achievement on this game with ${unknown.length === 1 ? 'key' : 'keys'} ${unknown
          .map((rule) => rule.achievementKey)
          .join(', ')}`,
      );
    }

    db.transaction((tx) => {
      tx.delete(gameAchievementRules).where(eq(gameAchievementRules.gameId, id)).run();
      for (const rule of input.rules) {
        tx.insert(gameAchievementRules)
          .values({
            id: newId('achr'),
            gameId: id,
            achievementKey: rule.achievementKey,
            sourceTemplate: rule.sourceTemplate,
            format: rule.format,
            selector: rule.selector,
            comparator: rule.comparator,
            value: rule.value ?? null,
            // Stored as null rather than [] so a rule with no labels reads the
            // same as every rule written before tags existed.
            tags: rule.tags && rule.tags.length > 0 ? rule.tags : null,
            createdAt: isoNow(),
          })
          .run();
      }
    });

    return db
      .select()
      .from(gameAchievementRules)
      .where(eq(gameAchievementRules.gameId, id))
      .all()
      .map(toAchievementRule);
  });

  /**
   * What the client found after reading a game's files.
   *
   * The reading happens on the player's machine — the files are theirs and
   * never leave it — so the server is told only which achievements came out of
   * it. Keys with no matching rule are ignored rather than trusted: unlocking
   * is otherwise a matter of asking.
   */
  app.post('/games/:id/achievements/report', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = reportUnlocksSchema.parse(request.body);

    const ruled = new Set(
      db
        .select({ key: gameAchievementRules.achievementKey })
        .from(gameAchievementRules)
        .where(eq(gameAchievementRules.gameId, id))
        .all()
        .map((row) => row.key),
    );

    const unlocked = [];
    for (const key of input.keys) {
      if (!ruled.has(key)) continue;
      try {
        // unlock() is idempotent, so a client re-reporting the same save on
        // every launch cannot fill the activity feed with duplicates.
        unlocked.push(achievements.unlock(context.user.id, id, key, null));
      } catch (error) {
        // One key that cannot be unlocked must not lose the rest of the
        // report. `unlock` throws when a rule names an achievement whose
        // definition is gone, which used to fail the whole request — so a
        // single deleted definition silently stopped every achievement for
        // that game from ever unlocking, with the client swallowing the error.
        request.log.warn({ err: error, gameId: id, key }, 'could not unlock a reported key');
      }
    }
    return { unlocked };
  });

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

  /**
   * Compute per-chunk hashes, which is what makes a game fetchable from a mesh
   * node rather than only from here.
   *
   * Separate from the checksum route above even though both read every byte,
   * because they answer different questions: checksums tell an operator whether
   * the archive is still intact, chunk hashes tell a client whether a piece
   * that arrived from somewhere else is genuine. This pass writes the
   * whole-file hash too, so running it makes the checksum pass redundant.
   */
  app.post('/games/:id/chunks', async (request, reply) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const { force } = (request.body ?? {}) as { force?: boolean };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    if (chunks.isRunning) {
      return reply.code(409).send({
        error: { code: 'chunking_in_progress', message: 'Chunk hashes are already being computed' },
      });
    }

    void chunks.start(id, { force: force ?? false });
    return reply.code(202).send({ started: true });
  });

  app.get('/games/chunks/progress', async (request) => {
    requireAdmin(request);
    return chunks.getProgress();
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
