import {
  apiCreateUserSchema,
  apiListUsersSchema,
  apiUpdateUserSchema,
  createInviteSchema,
  gameQuerySchema,
  type ApiScope,
  type PublicUser,
} from '@gameblade/shared';
import { and, eq, like, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { toPublicUser } from '../auth/service.js';
import { games, invites, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId, newInviteCode, newToken } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { ApiKeyContext } from '../services/apiKeys.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only on /v1 routes, and only once a key has been resolved. */
    apiKey: ApiKeyContext | null;
  }
}

/**
 * The external HTTP API.
 *
 * Separate from the routes the web and desktop clients use, and versioned, on
 * purpose: those two ship alongside the server and can change together, whereas
 * anything here is someone else's integration that must keep working. It
 * authenticates only with an API key — a session cookie is deliberately not
 * accepted, so a logged-in administrator's browser can never be induced into
 * making these calls on another site's behalf.
 */
export async function apiV1Routes(app: FastifyInstance): Promise<void> {
  const { db, auth, apiKeys, catalog, presence } = app.gameblade;

  app.decorateRequest('apiKey', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Provide an API key as: Authorization: Bearer <key>');
    }

    const context = apiKeys.resolve(header.slice(7).trim());
    if (!context) {
      throw ApiError.unauthorized('That API key is not valid, has been revoked, or has expired');
    }
    request.apiKey = context;
  });

  /** Throws unless the presented key carries every scope named. */
  function require(request: FastifyRequest, ...scopes: ApiScope[]): ApiKeyContext {
    const context = request.apiKey;
    if (!context) throw ApiError.unauthorized();

    const missing = scopes.filter((scope) => !context.scopes.includes(scope));
    if (missing.length > 0) {
      throw ApiError.forbidden(
        `This key is missing the ${missing.join(', ')} permission${missing.length === 1 ? '' : 's'}`,
      );
    }
    return context;
  }

  /** How many administrators remain; guards the last one against removal. */
  function adminCount(): number {
    return (
      db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
        .get()?.count ?? 0
    );
  }

  /* ---------------------------------------------------------------- meta */

  /**
   * Confirms a key works and reports what it may do. The first call any
   * integration makes, and the one that makes a permissions problem obvious
   * rather than showing up as a mystery 403 three endpoints later.
   */
  app.get('/v1/whoami', async (request) => {
    const context = require(request);
    return { name: context.name, scopes: context.scopes };
  });

  /* --------------------------------------------------------------- users */

  app.get('/v1/users', async (request) => {
    require(request, 'users:read');
    const query = apiListUsersSchema.parse(request.query);

    const conditions: SQL[] = [];
    if (query.query) {
      const term = `%${query.query.replace(/[%_]/g, '')}%`;
      const match = or(like(users.username, term), like(users.email, term));
      if (match) conditions.push(match);
    }
    if (query.role) conditions.push(eq(users.role, query.role));
    if (query.isActive !== undefined) conditions.push(eq(users.isActive, query.isActive));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = db
      .select()
      .from(users)
      .where(where)
      .orderBy(users.usernameLower)
      .limit(query.limit)
      .offset(query.offset)
      .all();

    const total =
      db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(where)
        .get()?.count ?? 0;

    return {
      items: rows.map(toPublicUser),
      total,
      offset: query.offset,
      limit: query.limit,
    };
  });

  app.get('/v1/users/:id', async (request) => {
    require(request, 'users:read');
    const { id } = request.params as { id: string };

    const user = auth.findById(id);
    if (!user) throw ApiError.notFound('User not found');
    return toPublicUser(user);
  });

  /**
   * Provisions an account.
   *
   * With no password supplied the server generates one and returns it in this
   * response only — which is what makes bulk provisioning from another system
   * practical without that system having to invent and transmit passwords.
   */
  app.post('/v1/users', async (request, reply) => {
    const context = require(request, 'users:write');
    const input = apiCreateUserSchema.parse(request.body);

    // Minting an administrator is its own scope: a provisioning integration
    // should be able to create accounts for months without ever holding the
    // ability to grant itself an admin login.
    if (input.role === 'admin' && !context.scopes.includes('users:admin')) {
      throw ApiError.forbidden('Creating an administrator requires the users:admin permission');
    }

    const generatedPassword = input.password ? null : newToken(18);
    const user = await auth.createUser({
      username: input.username,
      password: input.password ?? (generatedPassword as string),
      email: input.email ?? null,
      role: input.role,
    });

    const body: PublicUser & { generatedPassword?: string } = toPublicUser(user);
    if (generatedPassword) body.generatedPassword = generatedPassword;
    return reply.code(201).send(body);
  });

  app.patch('/v1/users/:id', async (request) => {
    const context = require(request, 'users:write');
    const { id } = request.params as { id: string };
    const input = apiUpdateUserSchema.parse(request.body);

    const target = auth.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    if (
      input.role === 'admin' &&
      target.role !== 'admin' &&
      !context.scopes.includes('users:admin')
    ) {
      throw ApiError.forbidden('Promoting to administrator requires the users:admin permission');
    }
    // Demoting or disabling an admin is equally consequential, so it needs the
    // same scope — otherwise users:write could lock every administrator out.
    if (
      target.role === 'admin' &&
      (input.role === 'user' || input.isActive === false) &&
      !context.scopes.includes('users:admin')
    ) {
      throw ApiError.forbidden('Changing an administrator requires the users:admin permission');
    }
    if (target.role === 'admin' && (input.role === 'user' || input.isActive === false)) {
      if (adminCount() <= 1) {
        throw ApiError.conflict('This is the only active administrator account');
      }
    }

    if (input.password) await auth.setPassword(id, input.password);

    const patch: Record<string, unknown> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.email !== undefined) patch.email = input.email;
    if (Object.keys(patch).length > 0) {
      db.update(users).set(patch).where(eq(users.id, id)).run();
    }

    // A disabled or demoted account must not keep an active session, exactly as
    // in the admin panel — otherwise deactivating over the API does nothing
    // until the existing session happens to expire.
    if (input.isActive === false || input.role !== undefined || input.password) {
      auth.destroyAllSessions(id);
    }

    const updated = auth.findById(id);
    return updated ? toPublicUser(updated) : null;
  });

  app.delete('/v1/users/:id', async (request) => {
    const context = require(request, 'users:write');
    const { id } = request.params as { id: string };

    const target = auth.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    if (target.role === 'admin') {
      if (!context.scopes.includes('users:admin')) {
        throw ApiError.forbidden('Deleting an administrator requires the users:admin permission');
      }
      if (adminCount() <= 1) {
        throw ApiError.conflict('This is the only active administrator account');
      }
    }

    db.delete(users).where(eq(users.id, id)).run();
    return { ok: true };
  });

  /* ------------------------------------------------------------- invites */

  /** An invite is the other way to provision: hand out a code, not an account. */
  app.post('/v1/invites', async (request, reply) => {
    const context = require(request, 'invites:write');
    const input = createInviteSchema.parse(request.body ?? {});

    if (input.role === 'admin' && !context.scopes.includes('users:admin')) {
      throw ApiError.forbidden('An administrator invite requires the users:admin permission');
    }

    const invite = {
      id: newId('inv'),
      code: newInviteCode().replace(/-/g, ''),
      role: input.role,
      note: input.note ?? null,
      maxUses: input.maxUses,
      uses: 0,
      // Keys are not people, so there is no user to attribute this to.
      createdBy: null,
      createdAt: isoNow(),
      expiresAt:
        input.expiresInDays === null
          ? null
          : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
      revokedAt: null,
    };

    db.insert(invites).values(invite).run();
    return reply.code(201).send({
      id: invite.id,
      code: invite.code,
      role: invite.role,
      maxUses: invite.maxUses,
      expiresAt: invite.expiresAt,
    });
  });

  /* --------------------------------------------------------------- games */

  app.get('/v1/games', async (request) => {
    require(request, 'games:read');
    const query = gameQuerySchema.parse(request.query);

    // The catalog reader decorates per-user state (owned, favourited, played),
    // none of which means anything for a key. An empty user id yields the
    // catalog with those flags all false, which is the honest answer.
    const page = catalog.search('', query);
    return {
      items: page.items.map((game) => ({
        id: game.id,
        title: game.title,
        sizeBytes: game.sizeBytes,
        releaseDate: game.releaseDate,
        genres: game.genres,
        platforms: game.platforms,
        matchStatus: game.matchStatus,
        isMissing: game.isMissing,
        addedAt: game.addedAt,
      })),
      total: page.total,
      offset: page.offset,
      limit: page.limit,
    };
  });

  /* --------------------------------------------------------------- stats */

  app.get('/v1/stats', async (request) => {
    require(request, 'stats:read');

    const gameStats = db
      .select({
        total: sql<number>`count(*)`,
        totalBytes: sql<number>`coalesce(sum(${games.sizeBytes}), 0)`,
        missing: sql<number>`sum(case when ${games.missingAt} is not null then 1 else 0 end)`,
      })
      .from(games)
      .get();

    const userStats = db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${users.isActive} then 1 else 0 end)`,
        admins: sql<number>`sum(case when ${users.role} = 'admin' then 1 else 0 end)`,
      })
      .from(users)
      .get();

    return {
      games: {
        total: gameStats?.total ?? 0,
        totalBytes: gameStats?.totalBytes ?? 0,
        missing: Number(gameStats?.missing ?? 0),
      },
      users: {
        total: userStats?.total ?? 0,
        active: Number(userStats?.active ?? 0),
        admins: Number(userStats?.admins ?? 0),
        online: presence.onlineCount(),
      },
    };
  });
}
