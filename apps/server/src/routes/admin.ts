import {
  createInviteSchema,
  createLibrarySchema,
  providerSettingsSchema,
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
  const { db, auth, settings, metadata, scanner, config } = app.gameblade;

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
    return reply.code(201).send({ ...invite, isValid: true, createdByUsername: context.user.username });
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
    // Only the catalogue rows are removed; the mounted files are never touched.
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

  app.get('/admin/settings', async () => {
    const current = settings.get();
    const body: ServerSettings = {
      serverName: current.serverName,
      allowSelfRegistration: current.allowSelfRegistration,
      providers: metadata.status(),
      igdbClientId: current.igdbClientId,
      // Secrets are never echoed back — only whether one is set.
      igdbClientSecretSet: Boolean(current.igdbClientSecret),
      steamGridDbKeySet: Boolean(current.steamGridDbKey),
    };
    return body;
  });

  app.patch('/admin/settings', async (request) => {
    const input = providerSettingsSchema.parse(request.body);
    settings.update({
      ...(input.serverName !== undefined ? { serverName: input.serverName } : {}),
      ...(input.allowSelfRegistration !== undefined
        ? { allowSelfRegistration: input.allowSelfRegistration }
        : {}),
      ...(input.igdbClientId !== undefined ? { igdbClientId: input.igdbClientId } : {}),
      ...(input.igdbClientSecret !== undefined
        ? { igdbClientSecret: input.igdbClientSecret }
        : {}),
      ...(input.steamGridDbKey !== undefined ? { steamGridDbKey: input.steamGridDbKey } : {}),
    });

    const current = settings.get();
    const body: ServerSettings = {
      serverName: current.serverName,
      allowSelfRegistration: current.allowSelfRegistration,
      providers: metadata.status(),
      igdbClientId: current.igdbClientId,
      igdbClientSecretSet: Boolean(current.igdbClientSecret),
      steamGridDbKeySet: Boolean(current.steamGridDbKey),
    };
    return body;
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
      db.select({ count: sql<number>`count(*)` }).from(users).get()?.count ?? 0;

    return {
      games: gameStats?.total ?? 0,
      totalBytes: gameStats?.totalBytes ?? 0,
      matched: gameStats?.matched ?? 0,
      missing: gameStats?.missing ?? 0,
      users: userCount,
      libraries: db.select({ count: sql<number>`count(*)` }).from(libraries).get()?.count ?? 0,
      basePath: config.basePath,
      scan: scanner.getProgress(),
    };
  });
}
