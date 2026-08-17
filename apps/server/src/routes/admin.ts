import {
  achievementDefinitionSchema,
  announcementSchema,
  createInviteSchema,
  createLibrarySchema,
  featuredSchema,
  importAchievementsSchema,
  providerSettingsSchema,
  purgeMissingSchema,
  reorderFeaturedSchema,
  scanRequestSchema,
  updateLibrarySchema,
  updateUserSchema,
  type InviteInfo,
  type LibraryInfo,
  type PublicUser,
  type ServerSettings,
} from '@gameblade/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { requireAdmin } from '../auth/middleware.js';
import { toPublicUser } from '../auth/service.js';
import { games, invites, libraries, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId, newInviteCode } from '../lib/ids.js';

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
    });

    return describeSettings();
  });

  app.post('/admin/settings/test-providers', async () => metadata.checkHealth());

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
      actorId: context.user.id,
    });

    return { sent };
  });

  /** Profile moderation: an admin can reset a display name or hide a profile. */
  app.get('/admin/profiles/:id', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    return profiles.detail(id, context.user.id);
  });
}
