import {
  achievementDefinitionSchema,
  announcementSchema,
  bugQuerySchema,
  bugTriageSchema,
  applySaveSuggestionsSchema,
  createInviteSchema,
  clientButtonSchema,
  decideGameRequestSchema,
  gameRequestQuerySchema,
  createApiKeySchema,
  defaultLandingBlocks,
  landingPageSchema,
  createLibrarySchema,
  featuredArtworkSchema,
  featuredSchema,
  MAX_INSTALLER_BYTES,
  importAchievementsSchema,
  autoImportAchievementsSchema,
  providerSettingsSchema,
  purgeMissingSchema,
  reorderClientButtonsSchema,
  reorderFeaturedSchema,
  scanRequestSchema,
  themeSettingsSchema,
  updateLibrarySchema,
  updateUserSchema,
  resolveTheme,
  type ClientInstallerInfo,
  type LandingBlock,
  type ThemePreset,
  type InviteInfo,
  type LibraryInfo,
  type PublicUser,
  type ServerSettings,
  discordSettingsSchema,
  discordAnnounceSchema,
} from '@gameblade/shared';
import { eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { requireAdmin } from '../auth/middleware.js';
import { toPublicUser } from '../auth/service.js';
import { gameFiles, gameSaveRules, games, invites, libraries, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { isLikelyGameExecutable, listZipExecutables, sortCandidates } from '../lib/executables.js';
import { newId, newInviteCode } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import { matchCatalog } from '../services/saveManifest.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const {
    db,
    auth,
    settings,
    metadata,
    scanner,
    config,
    catalog,
    achievements,
    notifications,
    profiles,
    presence,
    images,
    installer,
    clientButtons,
    gameRequests,
    apiKeys,
    analytics,
    bandwidth,
    social,
    saveManifest,
    backups,
    health,
    checksums,
    bugs,
    discord,
  } = app.gameblade;

  app.addHook('onRequest', async (request) => {
    requireAdmin(request);
  });

  // ---- Users ----

  app.get('/admin/users', async () => {
    const rows = db.select().from(users).all();
    const body: PublicUser[] = rows.map(toPublicUser);
    return body;
  });

  app.patch('/admin/users/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = updateUserSchema.parse(request.body);
    const context = requireAdmin(request);

    const target = auth.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    // Guard against an administrator locking everyone out of the server.
    if (target.role === 'admin' && (input.role === 'user' || input.isActive === false)) {
      const adminCount =
        db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(eq(users.role, 'admin'))
          .get()?.count ?? 0;
      if (adminCount <= 1) {
        throw ApiError.conflict('This is the only administrator account');
      }
    }
    if (target.id === context.user.id && input.isActive === false) {
      throw ApiError.conflict('You cannot disable your own account');
    }

    if (input.password) {
      await auth.setPassword(id, input.password);
    }

    const patch: Record<string, unknown> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.email !== undefined) patch.email = input.email;
    if (input.monthlyQuotaMb !== undefined) patch.monthlyQuotaMb = input.monthlyQuotaMb;

    if (Object.keys(patch).length > 0) {
      db.update(users).set(patch).where(eq(users.id, id)).run();
    }
    // A disabled or demoted account must not keep an active session.
    if (input.isActive === false || input.role !== undefined) {
      auth.destroyAllSessions(id);
    }

    const updated = auth.findById(id);
    return updated ? toPublicUser(updated) : null;
  });

  app.delete('/admin/users/:id', async (request) => {
    const { id } = request.params as { id: string };
    const context = requireAdmin(request);

    if (id === context.user.id) {
      throw ApiError.conflict('You cannot delete your own account');
    }
    const target = auth.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    if (target.role === 'admin') {
      const adminCount =
        db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(eq(users.role, 'admin'))
          .get()?.count ?? 0;
      if (adminCount <= 1) {
        throw ApiError.conflict('This is the only administrator account');
      }
    }

    db.delete(users).where(eq(users.id, id)).run();
    return { ok: true };
  });

  // ---- Invites ----

  app.get('/admin/invites', async () => {
    const rows = db
      .select({ invite: invites, createdByUsername: users.username })
      .from(invites)
      .leftJoin(users, eq(users.id, invites.createdBy))
      .all();

    const body: InviteInfo[] = rows.map(({ invite, createdByUsername }) => ({
      id: invite.id,
      code: invite.code,
      role: invite.role,
      note: invite.note,
      maxUses: invite.maxUses,
      uses: invite.uses,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      createdByUsername,
      isValid:
        !invite.revokedAt &&
        invite.uses < invite.maxUses &&
        (!invite.expiresAt || new Date(invite.expiresAt).getTime() > Date.now()),
    }));
    return body;
  });

  app.post('/admin/invites', async (request, reply) => {
    const context = requireAdmin(request);
    const input = createInviteSchema.parse(request.body);

    const invite = {
      id: newId('inv'),
      code: newInviteCode().replace(/-/g, ''),
      role: input.role,
      note: input.note ?? null,
      maxUses: input.maxUses,
      uses: 0,
      createdBy: context.user.id,
      createdAt: new Date().toISOString(),
      expiresAt:
        input.expiresInDays === null
          ? null
          : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
      revokedAt: null,
    };

    db.insert(invites).values(invite).run();
    return reply
      .code(201)
      .send({ ...invite, isValid: true, createdByUsername: context.user.username });
  });

  app.delete('/admin/invites/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.update(invites).set({ revokedAt: new Date().toISOString() }).where(eq(invites.id, id)).run();
    return { ok: true };
  });

  // ---- Libraries ----

  app.get('/admin/libraries', async () => {
    const rows = db.select().from(libraries).all();
    const stats = db
      .select({
        libraryId: games.libraryId,
        gameCount: sql<number>`count(*)`,
        totalBytes: sql<number>`coalesce(sum(${games.sizeBytes}), 0)`,
      })
      .from(games)
      .groupBy(games.libraryId)
      .all();

    const byLibrary = new Map(stats.map((s) => [s.libraryId, s]));

    const body: LibraryInfo[] = rows.map((library) => ({
      id: library.id,
      name: library.name,
      path: library.path,
      enabled: library.enabled,
      gameCount: byLibrary.get(library.id)?.gameCount ?? 0,
      totalBytes: byLibrary.get(library.id)?.totalBytes ?? 0,
      lastScanAt: library.lastScanAt,
      lastScanStatus: library.lastScanStatus,
    }));
    return body;
  });

  app.post('/admin/libraries', async (request, reply) => {
    const input = createLibrarySchema.parse(request.body);
    const resolved = path.resolve(input.path);

    // Fail loudly at creation rather than silently scanning nothing later.
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) {
      throw ApiError.badRequest(
        `"${resolved}" is not a readable directory inside the container. Check the volume mount.`,
      );
    }

    const existing = db.select().from(libraries).where(eq(libraries.path, resolved)).get();
    if (existing) throw ApiError.conflict('That path is already a library');

    const library = {
      id: newId('lib'),
      name: input.name,
      path: resolved,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
      lastScanAt: null,
      lastScanStatus: null,
    };
    db.insert(libraries).values(library).run();
    return reply.code(201).send(library);
  });

  app.patch('/admin/libraries/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = updateLibrarySchema.parse(request.body);

    const existing = db.select().from(libraries).where(eq(libraries.id, id)).get();
    if (!existing) throw ApiError.notFound('Library not found');

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.path !== undefined) {
      const resolved = path.resolve(input.path);
      const info = await stat(resolved).catch(() => null);
      if (!info?.isDirectory()) {
        throw ApiError.badRequest(`"${resolved}" is not a readable directory inside the container`);
      }
      patch.path = resolved;
    }

    if (Object.keys(patch).length > 0) {
      db.update(libraries).set(patch).where(eq(libraries.id, id)).run();
    }
    return db.select().from(libraries).where(eq(libraries.id, id)).get();
  });

  app.delete('/admin/libraries/:id', async (request) => {
    const { id } = request.params as { id: string };
    // Only the catalog rows are removed; the mounted files are never touched.
    db.delete(libraries).where(eq(libraries.id, id)).run();
    return { ok: true };
  });

  // ---- Scanning ----

  app.post('/admin/scan', async (request, reply) => {
    const input = scanRequestSchema.parse(request.body ?? {});
    if (scanner.isRunning) {
      return reply.code(409).send({
        error: { code: 'scan_in_progress', message: 'A scan is already running' },
      });
    }

    // Fire and forget: the client polls progress rather than holding a request open.
    void scanner.scan(input);
    return reply.code(202).send({ started: true });
  });

  app.get('/admin/scan/progress', async () => scanner.getProgress());

  // ---- Removing catalog entries ----

  /**
   * Forget a game entirely.
   *
   * A scan only *flags* a vanished game, because an unmounted share must not
   * destroy hand-made metadata matches — but that leaves no way to clear out
   * something deleted on purpose. This is that way. Files on disk are never
   * touched; only the catalog row goes, and the foreign keys cascade it out
   * of libraries, playtime, achievements and the featured shelf.
   *
   * Deleting a game that is still on disk is refused unless forced: the next
   * scan would re-add it as a new row with none of its metadata, which almost
   * nobody means to do.
   */
  app.delete('/admin/games/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { force } = request.query as { force?: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    if (game.missingAt === null && force !== 'true') {
      throw new ApiError(
        409,
        'game_present',
        `"${game.title}" is still on disk, so a scan would add it straight back. Delete the files first, or pass force=true to remove the entry anyway.`,
      );
    }

    db.delete(games).where(eq(games.id, id)).run();
    return { ok: true, title: game.title };
  });

  /** Clear out everything a scan has flagged as gone from disk. */
  app.post('/admin/games/purge-missing', async (request) => {
    const { olderThanDays } = purgeMissingSchema.parse(request.body ?? {});
    return { removed: scanner.purgeMissing(olderThanDays) };
  });

  /**
   * .exe files found in a game's own files, so the launch rule's executable
   * field can be picked rather than hand-typed. A folder game's files were
   * already indexed by the last scan; an archive game's central directory is
   * read on demand instead, since only the archive itself — not its
   * contents — gets a `game_files` row.
   */
  app.get('/admin/games/:id/executables', async (request) => {
    const { id } = request.params as { id: string };
    const row = db
      .select({ game: games, libraryPath: libraries.path })
      .from(games)
      .innerJoin(libraries, eq(libraries.id, games.libraryId))
      .where(eq(games.id, id))
      .get();
    if (!row) throw ApiError.notFound('Game not found');

    if (row.game.kind === 'archive') {
      const absolute = path.join(row.libraryPath, row.game.relPath);
      try {
        return { candidates: sortCandidates(await listZipExecutables(absolute)) };
      } catch (error) {
        request.log.warn({ err: error, gameId: id }, 'could not read archive for executables');
        return { candidates: [] };
      }
    }

    const files = db
      .select({ relPath: gameFiles.relPath, sizeBytes: gameFiles.sizeBytes })
      .from(gameFiles)
      .where(eq(gameFiles.gameId, id))
      .all();
    const candidates = files
      .filter((file) => isLikelyGameExecutable(file.relPath))
      .map((file) => ({ path: file.relPath, sizeBytes: file.sizeBytes }));
    return { candidates: sortCandidates(candidates) };
  });

  app.post('/admin/scan/match-pending', async (request, reply) => {
    if (scanner.isRunning) {
      return reply.code(409).send({
        error: { code: 'scan_in_progress', message: 'A scan is already running' },
      });
    }
    void scanner.matchPending();
    return reply.code(202).send({ started: true });
  });

  // ---- Settings ----

  /** Secrets are never echoed back — only whether one is set. */
  function describeSettings(): ServerSettings {
    const current = settings.get();
    return {
      serverName: current.serverName,
      tagline: current.tagline,
      allowSelfRegistration: current.allowSelfRegistration,
      downloadUrl: current.downloadUrl,
      clientVersion: current.clientVersion,
      providers: metadata.status(),
      igdbClientId: current.igdbClientId,
      igdbClientSecretSet: Boolean(current.igdbClientSecret),
      steamGridDbKeySet: Boolean(current.steamGridDbKey),
      steamApiKeySet: Boolean(current.steamApiKey),
      downloadSpeedLimitKbps: current.downloadSpeedLimitKbps,
      monthlyQuotaMb: current.monthlyQuotaMb,
      installer: installer.info(),
    };
  }

  app.get('/admin/settings', async () => describeSettings());

  app.patch('/admin/settings', async (request) => {
    const input = providerSettingsSchema.parse(request.body);
    settings.update({
      ...(input.serverName !== undefined ? { serverName: input.serverName } : {}),
      ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
      ...(input.allowSelfRegistration !== undefined
        ? { allowSelfRegistration: input.allowSelfRegistration }
        : {}),
      // An empty string from a cleared form field means "unset", not "".
      ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl || null } : {}),
      ...(input.clientVersion !== undefined ? { clientVersion: input.clientVersion } : {}),
      ...(input.igdbClientId !== undefined ? { igdbClientId: input.igdbClientId } : {}),
      ...(input.igdbClientSecret !== undefined ? { igdbClientSecret: input.igdbClientSecret } : {}),
      ...(input.steamGridDbKey !== undefined ? { steamGridDbKey: input.steamGridDbKey } : {}),
      ...(input.steamApiKey !== undefined ? { steamApiKey: input.steamApiKey } : {}),
      ...(input.downloadSpeedLimitKbps !== undefined
        ? { downloadSpeedLimitKbps: input.downloadSpeedLimitKbps }
        : {}),
      ...(input.monthlyQuotaMb !== undefined ? { monthlyQuotaMb: input.monthlyQuotaMb } : {}),
    });

    return describeSettings();
  });

  app.post('/admin/settings/test-providers', async () => metadata.checkHealth());

  // ---- The Windows client installer ----

  /**
   * Uploads the installer as a raw body, streamed to disk.
   *
   * The file name rides in the query string rather than the body because there
   * is no multipart parser here: a build is hundreds of megabytes, and
   * buffering one through a form parser to recover a single string would cost
   * the whole file in memory.
   */
  app.post(
    '/admin/client-installer',
    { bodyLimit: MAX_INSTALLER_BYTES },
    async (request, reply) => {
      const { fileName } = request.query as { fileName?: string };
      if (!fileName?.trim()) {
        throw ApiError.badRequest('Include the installer file name as ?fileName=');
      }

      const body: ClientInstallerInfo = await installer.store(
        {
          fileName,
          contentType: request.headers['content-type'] ?? 'application/octet-stream',
        },
        request.raw,
        MAX_INSTALLER_BYTES,
      );

      return reply.code(201).send(body);
    },
  );

  app.delete('/admin/client-installer', async () => {
    await installer.remove();
    return { ok: true };
  });

  // ---- Overview ----

  app.get('/admin/stats', async () => {
    const gameStats = db
      .select({
        total: sql<number>`count(*)`,
        totalBytes: sql<number>`coalesce(sum(${games.sizeBytes}), 0)`,
        matched: sql<number>`sum(case when ${games.matchStatus} in ('auto','manual') then 1 else 0 end)`,
        missing: sql<number>`sum(case when ${games.missingAt} is not null then 1 else 0 end)`,
      })
      .from(games)
      .get();

    const userCount =
      db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .get()?.count ?? 0;

    return {
      games: gameStats?.total ?? 0,
      totalBytes: gameStats?.totalBytes ?? 0,
      matched: gameStats?.matched ?? 0,
      missing: gameStats?.missing ?? 0,
      // What still needs a human: no launch executable, no save rule, no art.
      // The catalog page renders these as counts on its filter chips.
      gaps: catalog.gapCounts(),
      users: userCount,
      libraries:
        db
          .select({ count: sql<number>`count(*)` })
          .from(libraries)
          .get()?.count ?? 0,
      basePath: config.basePath,
      scan: scanner.getProgress(),
      online: presence.onlineCount(),
    };
  });

  // ---- Featured games (the Home carousel) ----

  app.get('/admin/featured', async (request) => {
    const context = requireAdmin(request);
    // Admins see inactive entries too, so a slot can be staged before going live.
    return catalog.listFeatured(context.user.id, false);
  });

  app.put('/admin/featured', async (request) => {
    const context = requireAdmin(request);
    const input = featuredSchema.parse(request.body);
    catalog.upsertFeatured(input);
    return catalog.listFeatured(context.user.id, false);
  });

  app.post('/admin/featured/reorder', async (request) => {
    const context = requireAdmin(request);
    const input = reorderFeaturedSchema.parse(request.body);
    catalog.reorderFeatured(input.ids);
    return catalog.listFeatured(context.user.id, false);
  });

  app.delete('/admin/featured/:id', async (request) => {
    const { id } = request.params as { id: string };
    catalog.removeFeatured(id);
    return { ok: true };
  });

  /**
   * Overrides the hero image behind one carousel slot, or clears the override
   * so the game's own hero art shows through again.
   */
  app.put('/admin/featured/:id/artwork', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = featuredArtworkSchema.parse(request.body);

    const imageId = input.url ? await images.cache(input.url, 'hero') : null;
    if (input.url && !imageId) {
      throw ApiError.badRequest('That image could not be downloaded. Check the URL and try again.');
    }

    catalog.setFeaturedArtwork(id, imageId);
    return catalog.listFeatured(context.user.id, false);
  });

  // ---- Look and feel ----

  app.get('/admin/theme', async () => {
    const current = settings.get();
    return {
      preset: current.themePreset as ThemePreset,
      accent: current.themeAccent,
      tokens: resolveTheme(current.themePreset as ThemePreset, current.themeAccent),
    };
  });

  app.put('/admin/theme', async (request) => {
    const input = themeSettingsSchema.parse(request.body);
    settings.update({ themePreset: input.preset, themeAccent: input.accent ?? null });
    return {
      preset: input.preset,
      accent: input.accent ?? null,
      tokens: resolveTheme(input.preset, input.accent ?? null),
    };
  });

  /** The landing page's blocks. Unset falls back to the built-in page. */
  app.get('/admin/landing', async () => {
    const stored = settings.get().landingBlocks;
    const parsed = landingPageSchema.safeParse({ blocks: stored });
    const blocks: LandingBlock[] = parsed.success ? parsed.data.blocks : defaultLandingBlocks();
    return { blocks, isCustomised: stored !== null && stored !== undefined };
  });

  app.put('/admin/landing', async (request) => {
    const input = landingPageSchema.parse(request.body);
    settings.update({ landingBlocks: input.blocks });
    return { blocks: input.blocks, isCustomised: true };
  });

  /** Throws the customised page away and goes back to the shipped one. */
  app.post('/admin/landing/reset', async () => {
    settings.clear('landingBlocks');
    return { blocks: defaultLandingBlocks(), isCustomised: false };
  });

  // ---- Analytics ----

  /**
   * Everything the analytics page renders, in one request. The page shows six
   * panels; six endpoints would each pay their own round trip for data that all
   * comes out of the same two tables.
   */
  app.get('/admin/analytics', async (request) => {
    const { days } = request.query as { days?: string };
    const parsed = Number(days);
    const rangeDays = Number.isFinite(parsed) ? Math.min(365, Math.max(1, Math.floor(parsed))) : 30;
    return analytics.report(rangeDays);
  });

  /** One account's month-to-date transfer against its allowance. */
  app.get('/admin/users/:id/quota', async (request) => {
    const { id } = request.params as { id: string };
    return bandwidth.status(id);
  });

  // ---- API keys for the external API ----

  app.get('/admin/api-keys', async () => apiKeys.list());

  /**
   * Mints a key. The plaintext token comes back here and nowhere else, so the
   * UI has to show it once and tell the operator to store it.
   */
  app.post('/admin/api-keys', async (request, reply) => {
    const context = requireAdmin(request);
    const input = createApiKeySchema.parse(request.body);
    return reply.code(201).send(apiKeys.create(input, context.user.id));
  });

  /** Revoking keeps the row, so the audit trail of what existed survives. */
  app.post('/admin/api-keys/:id/revoke', async (request) => {
    const { id } = request.params as { id: string };
    apiKeys.revoke(id);
    return { ok: true };
  });

  app.delete('/admin/api-keys/:id', async (request) => {
    const { id } = request.params as { id: string };
    apiKeys.remove(id);
    return { ok: true };
  });

  // ---- Custom buttons in the desktop client ----

  /**
   * Operator-defined links the desktop client renders. Admins see inactive
   * rows too, so a button can be staged before it goes live.
   */
  app.get('/admin/client-buttons', async () => clientButtons.listAll());

  app.post('/admin/client-buttons', async (request, reply) => {
    const input = clientButtonSchema.parse(request.body);
    return reply.code(201).send(clientButtons.create(input));
  });

  app.put('/admin/client-buttons/:id', async (request) => {
    const { id } = request.params as { id: string };
    return clientButtons.update(id, clientButtonSchema.parse(request.body));
  });

  app.delete('/admin/client-buttons/:id', async (request) => {
    const { id } = request.params as { id: string };
    clientButtons.remove(id);
    return { ok: true };
  });

  app.post('/admin/client-buttons/reorder', async (request) => {
    const input = reorderClientButtonsSchema.parse(request.body);
    clientButtons.reorder(input.ids);
    return clientButtons.listAll();
  });

  // ---- Achievement definitions ----

  app.get('/admin/games/:id/achievements', async (request) => {
    const { id } = request.params as { id: string };
    return achievements.definitionsForGame(id);
  });

  app.put('/admin/games/:id/achievements', async (request) => {
    const { id } = request.params as { id: string };
    const input = achievementDefinitionSchema.parse(request.body);

    const game = db.select({ id: games.id }).from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    return achievements.upsertDefinition(id, input);
  });

  app.delete('/admin/games/:id/achievements/:achievementId', async (request) => {
    const { id, achievementId } = request.params as { id: string; achievementId: string };
    achievements.deleteDefinition(id, achievementId);
    return { ok: true };
  });

  /**
   * Pulls a game's achievement list from Steam's public schema endpoint. This
   * reads published game metadata only — no player data, no account linking —
   * which is what makes it usable for a DRM-free copy of a game that also
   * happens to ship on Steam.
   */
  app.post('/admin/games/:id/achievements/import', async (request) => {
    const { id } = request.params as { id: string };
    const input = importAchievementsSchema.parse(request.body);
    return achievements.importFromSteam(id, input.steamAppId, input.replace);
  });

  /** Finds the Steam AppID from the catalog title, then imports its achievement schema. */
  app.post('/admin/games/:id/achievements/auto-import', async (request) => {
    const { id } = request.params as { id: string };
    const input = autoImportAchievementsSchema.parse(request.body ?? {});
    return achievements.autoImportFromSteam(id, input.replace);
  });

  // ---- Bug reports ----

  app.get('/admin/bugs', async (request) => {
    const context = requireAdmin(request);
    return bugs.list(bugQuerySchema.parse(request.query), context.user.id);
  });

  /**
   * Answering a report.
   *
   * The reply and the status both reach the reporter as a notification. That
   * is the part that keeps reports coming: someone who never hears back
   * concludes that reporting does nothing.
   */
  app.put('/admin/bugs/:id', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    return bugs.triage(id, bugTriageSchema.parse(request.body), context.user.id);
  });

  // ---- Health ----

  /**
   * What needs attention right now, as opposed to what happened.
   *
   * Everything here is derived from rows already being written, so there is no
   * second source of truth to drift from the thing it describes.
   */
  app.get('/admin/health', async () => health.report());

  /**
   * Re-hashes a game's files and records whether each still matches.
   *
   * Only files that were hashed once already have anything to compare against;
   * the rest are left alone. Findings surface on the health page.
   */
  app.post('/admin/games/:id/verify', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (checksums.isRunning) {
      throw ApiError.conflict('A checksum run is already in progress');
    }
    void checksums.start(id, { verify: true });
    return reply.code(202).send({ started: true });
  });

  app.get('/admin/verify/progress', async () => checksums.getProgress());

  // ---- Backups ----

  /**
   * Archives of everything in the data directory that cannot be recreated.
   *
   * The library itself is not in them: it is enormous, an operator already has
   * it, and a scan rebuilds every catalog row from it. What is in them is the
   * database, every player's cloud saves, uploaded media and the published
   * installer — none of which exists anywhere else.
   */
  app.get('/admin/backups', async () => {
    const current = settings.get();
    return {
      backups: await backups.list(),
      settings: {
        keep: current.backupKeep,
        everyHours: current.backupEveryHours,
        includeImages: current.backupIncludeImages,
      },
    };
  });

  app.post('/admin/backups', async (request, reply) => {
    const current = settings.get();
    const info = await backups.create({
      keep: current.backupKeep,
      everyHours: current.backupEveryHours,
      includeImages: current.backupIncludeImages,
    });
    return reply.code(201).send(info);
  });

  app.get('/admin/backups/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const target = backups.pathFor(name);
    if (!target) throw ApiError.badRequest('That is not a backup name');

    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw ApiError.notFound('Backup not found');

    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', String(info.size))
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(createReadStream(target));
  });

  app.delete('/admin/backups/:name', async (request) => {
    const { name } = request.params as { name: string };
    if (!(await backups.remove(name))) throw ApiError.badRequest('That is not a backup name');
    return { ok: true };
  });

  // ---- Save-path suggestions ----

  /**
   * Where saves live, for tens of thousands of games.
   *
   * The alternative is an operator playing every title to find out where it
   * wrote, which is the job this replaces. Suggestions are never applied on
   * their own: a title match across 11,000 games is occasionally confident and
   * wrong, and these paths are where the client will later read and write a
   * player's saves.
   */
  /* -------------------------------------------------------------- Discord */

  /**
   * What the operator has configured, with the secrets write-only.
   *
   * Same shape as the rest of settings: the server says whether a secret is
   * set, never what it is, so a token cannot be read back out of the panel.
   */
  app.get('/admin/discord', async () => {
    const s = settings.get();
    return {
      clientId: s.discordClientId,
      clientSecretSet: Boolean(s.discordClientSecret),
      botTokenSet: Boolean(s.discordBotToken),
      guildId: s.discordGuildId,
      inviteUrl: s.discordInviteUrl,
      channelId: s.discordChannelId,
      publicUrl: s.discordPublicUrl,
      announceNewGames: s.discordAnnounceNewGames,
      announceRequests: s.discordAnnounceRequests,
      requireGuild: s.discordRequireGuild,
      linkedAccounts: discord.linkedCount(),
    };
  });

  app.patch('/admin/discord', async (request) => {
    const input = discordSettingsSchema.parse(request.body);

    // Turning announcements on starts the clock now rather than announcing the
    // entire back catalogue; turning them off leaves the watermark alone so a
    // brief pause does not replay everything since.
    const wasOn = settings.get().discordAnnounceNewGames;
    settings.update({
      ...(input.clientId !== undefined ? { discordClientId: input.clientId || null } : {}),
      ...(input.clientSecret ? { discordClientSecret: input.clientSecret } : {}),
      ...(input.botToken ? { discordBotToken: input.botToken } : {}),
      ...(input.guildId !== undefined ? { discordGuildId: input.guildId || null } : {}),
      ...(input.inviteUrl !== undefined ? { discordInviteUrl: input.inviteUrl || null } : {}),
      ...(input.channelId !== undefined ? { discordChannelId: input.channelId || null } : {}),
      ...(input.publicUrl !== undefined ? { discordPublicUrl: input.publicUrl || null } : {}),
      ...(input.announceNewGames !== undefined
        ? { discordAnnounceNewGames: input.announceNewGames }
        : {}),
      ...(input.announceRequests !== undefined
        ? { discordAnnounceRequests: input.announceRequests }
        : {}),
      ...(input.requireGuild !== undefined ? { discordRequireGuild: input.requireGuild } : {}),
    });

    if (!wasOn && input.announceNewGames) {
      settings.update({ discordLastAnnouncedAt: new Date().toISOString() });
    }
    // A token is write-only in settings, so validate a replacement now instead
    // of waiting for the next scheduled announcement to expose a bad token.
    const bot = input.botToken ? await discord.startBot() : null;
    return { ok: true, bot };
  });

  /** Clearing a secret needs to be possible without a way to read it back. */
  app.delete('/admin/discord/secret/:which', async (request) => {
    const { which } = request.params as { which: string };
    if (which === 'clientSecret') settings.update({ discordClientSecret: null });
    else if (which === 'botToken') settings.update({ discordBotToken: null });
    else throw ApiError.badRequest('Unknown secret');
    return { ok: true };
  });

  /**
   * Proves the bot token works before an operator relies on it.
   *
   * A token that is merely stored tells you nothing; the first sign of a wrong
   * one would otherwise be an announcement that never arrived.
   */
  app.post('/admin/discord/test', async () => {
    const identity = await discord.botIdentity();
    return { ok: true, bot: identity };
  });

  /** Posts whatever the operator typed, to the configured channel. */
  app.post('/admin/discord/announce', async (request) => {
    const input = discordAnnounceSchema.parse(request.body);

    if (input.asEmbed) {
      await discord.postEmbed({
        title: input.title || undefined,
        description: input.message,
        color: 0x7c5cff,
      });
    } else {
      await discord.post(input.title ? `**${input.title}**\n${input.message}` : input.message);
    }
    return { ok: true };
  });

  /** Runs the new-game announcer now, rather than waiting for the schedule. */
  app.post('/admin/discord/announce-new-games', async () => {
    const posted = await discord.announceNewGames();
    return { posted };
  });

  app.get('/admin/save-manifest', async () => saveManifest.status());

  app.post('/admin/save-manifest/refresh', async () => saveManifest.refresh());

  app.get('/admin/save-manifest/suggestions', async () => {
    const entries = await saveManifest.load();
    if (entries.length === 0) {
      return { suggestions: [], needsRefresh: true };
    }

    const withRules = new Set(
      db
        .select({ gameId: gameSaveRules.gameId })
        .from(gameSaveRules)
        .all()
        .map((r) => r.gameId),
    );

    const catalog = db
      .select({ id: games.id, title: games.title })
      .from(games)
      .where(isNull(games.missingAt))
      .all()
      .map((game) => ({ ...game, hasRule: withRules.has(game.id) }));

    return { suggestions: matchCatalog(catalog, entries), needsRefresh: false };
  });

  /**
   * Writes the confirmed suggestions as save rules.
   *
   * Each entry names the path the operator picked rather than the server
   * choosing again, so what is stored is what they saw on screen.
   */
  app.post('/admin/save-manifest/apply', async (request) => {
    const input = applySaveSuggestionsSchema.parse(request.body);
    let applied = 0;

    db.transaction((tx) => {
      for (const entry of input.rules) {
        const game = tx
          .select({ id: games.id })
          .from(games)
          .where(eq(games.id, entry.gameId))
          .get();
        if (!game) continue;

        // One rule per game, as elsewhere: a save replaces rather than adds.
        tx.delete(gameSaveRules).where(eq(gameSaveRules.gameId, entry.gameId)).run();
        tx.insert(gameSaveRules)
          .values({
            id: newId('svr'),
            gameId: entry.gameId,
            pathTemplate: entry.pathTemplate,
            include: entry.include ?? null,
            exclude: null,
            note: 'From the save-path manifest',
            createdAt: isoNow(),
          })
          .run();
        applied += 1;
      }
    });

    return { applied };
  });

  // ---- Announcements ----

  app.post('/admin/announcements', async (request) => {
    const context = requireAdmin(request);
    const input = announcementSchema.parse(request.body);

    // An empty target list means everyone with an active account.
    const targets =
      input.userIds.length > 0
        ? input.userIds
        : db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.isActive, true))
            .all()
            .map((r) => r.id);

    const sent = notifications.createMany(targets, {
      kind: 'announcement',
      title: input.title,
      body: input.body ?? null,
      icon: input.icon ?? null,
      actorId: context.user.id,
    });

    // A notification is read once and gone. Publishing keeps the announcement
    // somewhere people can come back to and reply to — never for one aimed at
    // named accounts, which is a message rather than a notice.
    const post =
      input.publish && input.userIds.length === 0
        ? social.publishAnnouncement(context.user.id, {
            title: input.title,
            body: input.body ?? null,
          })
        : null;

    return { sent, postId: post?.id ?? null };
  });

  // ---- Game requests ----

  /**
   * The operator's view of the request queue.
   *
   * Unlike the player-facing list this names who asked, which is what makes a
   * duplicate-looking pair of requests resolvable.
   */
  app.get('/admin/requests', async (request) => {
    const context = requireAdmin(request);
    const query = gameRequestQuerySchema.parse(request.query);
    return {
      items: gameRequests.list(query, context.user.id, true),
      counts: gameRequests.counts(),
    };
  });

  app.patch('/admin/requests/:id', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = decideGameRequestSchema.parse(request.body);

    // A request marked as added should point at something real; a stale id
    // would render as a dead "open it" link in every client.
    if (input.gameId) {
      const game = db.select({ id: games.id }).from(games).where(eq(games.id, input.gameId)).get();
      if (!game) throw ApiError.badRequest('That game is not in the catalog');
    }

    const decided = gameRequests.decide(context.user.id, id, input);

    // Telling the Discord that something people asked for has landed is the
    // most useful thing the bot does. Fire-and-forget: a Discord outage must
    // not fail the decision, which has already been recorded.
    if (input.status === 'added' && settings.get().discordAnnounceRequests) {
      void discord
        .post(`**${decided.title}** was requested and has just been added.`)
        .catch((error: unknown) =>
          request.log.warn({ err: error }, 'could not announce a granted request'),
        );
    }

    return decided;
  });

  app.delete('/admin/requests/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    gameRequests.remove(id);
    return { ok: true };
  });

  /** Profile moderation: an admin can reset a display name or hide a profile. */
  app.get('/admin/profiles/:id', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    return profiles.detail(id, context.user.id);
  });
}
