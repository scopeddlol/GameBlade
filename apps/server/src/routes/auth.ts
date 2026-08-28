import {
  SESSION_COOKIE,
  changePasswordSchema,
  resetPasswordSchema,
  loginSchema,
  registerSchema,
  updateAccountSchema,
  type DeviceInfo,
  type SessionInfo,
} from '@gameblade/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '../auth/middleware.js';
import { toPublicUser } from '../auth/service.js';
import { ApiError } from '../lib/errors.js';
import { normalizeInviteCode } from '../lib/ids.js';
import { eq } from 'drizzle-orm';
import { invites } from '../db/schema.js';

/** Honor `X-Forwarded-Proto` when it is trusted, so cookies get Secure behind TLS. */
function isSecureRequest(request: FastifyRequest): boolean {
  const configured = request.server.gameblade.config.secureCookies;
  if (configured !== 'auto') return configured;
  return request.protocol === 'https';
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { auth, settings, config, profiles } = app.gameblade;

  /** Tells the web client whether to show first-run setup or a login form. */
  app.get('/auth/status', async () => {
    const { serverName, allowSelfRegistration } = settings.get();
    return {
      serverName,
      needsSetup: auth.countUsers() === 0,
      allowSelfRegistration,
      role: config.role,
    };
  });

  /**
   * First-run bootstrap: creates the initial administrator. Only ever available
   * while the database has no users, so it cannot be used to add an admin later.
   */
  app.post(
    '/auth/setup',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      if (auth.countUsers() > 0) {
        throw ApiError.conflict('This server has already been set up');
      }

      const input = registerSchema.omit({ inviteCode: true }).parse(request.body);
      const user = await auth.createUser({
        username: input.username,
        password: input.password,
        email: input.email || null,
        role: 'admin',
      });
      profiles.ensure(user.id, user.username);

      const session = auth.createSession(user.id, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      reply.setCookie(SESSION_COOKIE, session.token, {
        ...app.gameblade.cookieOptions(isSecureRequest(request)),
        expires: new Date(session.expiresAt),
      });

      const body: SessionInfo = { user: toPublicUser(user), csrfToken: session.csrfToken };
      return reply.code(201).send(body);
    },
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const user = await auth.authenticate(input.username, input.password);

      // A device name means a desktop client, which gets a bearer token instead
      // of a cookie so it can be revoked individually from the web UI.
      if (input.deviceName) {
        const device = auth.createDeviceToken(user.id, input.deviceName, input.devicePlatform);
        return reply.send({
          token: device.token,
          deviceId: device.deviceId,
          expiresAt: device.expiresAt,
          user: toPublicUser(user),
        });
      }

      const session = auth.createSession(user.id, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      reply.setCookie(SESSION_COOKIE, session.token, {
        ...app.gameblade.cookieOptions(isSecureRequest(request)),
        expires: new Date(session.expiresAt),
      });

      const body: SessionInfo = { user: toPublicUser(user), csrfToken: session.csrfToken };
      return reply.send(body);
    },
  );

  app.post(
    '/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = registerSchema.parse(request.body);
      const { allowSelfRegistration } = settings.get();

      // Invite-only by default: without an invite, registration is refused
      // unless an administrator has explicitly opened the server up.
      let role: 'admin' | 'user' = 'user';
      if (input.inviteCode) {
        role = auth.claimInvite(input.inviteCode);
      } else if (!allowSelfRegistration) {
        throw ApiError.forbidden('This server is invite-only. Ask an administrator for an invite.');
      }

      const user = await auth.createUser({
        username: input.username,
        password: input.password,
        email: input.email || null,
        role,
      });
      profiles.ensure(user.id, user.username);

      const session = auth.createSession(user.id, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      reply.setCookie(SESSION_COOKIE, session.token, {
        ...app.gameblade.cookieOptions(isSecureRequest(request)),
        expires: new Date(session.expiresAt),
      });

      const body: SessionInfo = { user: toPublicUser(user), csrfToken: session.csrfToken };
      return reply.code(201).send(body);
    },
  );

  /** Public pre-flight so the registration page can show who invited you. */
  app.get('/auth/invite/:code', async (request) => {
    const { code } = request.params as { code: string };
    const invite = app.gameblade.db
      .select()
      .from(invites)
      .where(eq(invites.code, normalizeInviteCode(code)))
      .get();

    const valid =
      invite !== undefined &&
      !invite.revokedAt &&
      invite.uses < invite.maxUses &&
      (!invite.expiresAt || new Date(invite.expiresAt).getTime() > Date.now());

    // Deliberately uniform: never reveal why an invite is unusable.
    return { valid, role: valid ? invite.role : null };
  });

  app.post('/auth/logout', async (request, reply) => {
    const cookie = request.cookies[SESSION_COOKIE];
    if (cookie) auth.destroySession(cookie);
    reply.clearCookie(SESSION_COOKIE, { path: app.gameblade.cookiePath });
    return { ok: true };
  });

  app.get('/auth/session', async (request) => {
    const context = requireUser(request);
    const body: SessionInfo = {
      user: toPublicUser(context.user),
      // Desktop clients authenticate per-request and need no CSRF token.
      csrfToken: context.session?.csrfToken ?? '',
    };
    return body;
  });

  /**
   * Spend an admin-issued reset link.
   *
   * Unauthenticated on purpose: whoever holds the link is, by construction,
   * somebody who cannot sign in. The token is the whole credential.
   */
  app.post('/auth/reset-password', async (request) => {
    const input = resetPasswordSchema.parse(request.body);
    await auth.consumePasswordReset(input.token, input.newPassword);
    return { ok: true };
  });

  app.post('/auth/change-password', async (request) => {
    const context = requireUser(request);
    const input = changePasswordSchema.parse(request.body);
    await auth.changePassword(context.user.id, input.currentPassword, input.newPassword);
    return { ok: true };
  });

  /**
   * Self-service username/email change, distinct from PATCH /admin/users/:id —
   * this is what lets a member manage their own account from the web without
   * installing the desktop client, rather than needing an administrator.
   */
  app.patch('/account', async (request) => {
    const context = requireUser(request);
    const input = updateAccountSchema.parse(request.body);
    const updated = await auth.updateAccount(context.user.id, input);
    return toPublicUser(updated);
  });

  app.get('/auth/devices', async (request) => {
    const context = requireUser(request);
    const list = auth.listDevices(context.user.id);
    const body: DeviceInfo[] = list.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      lastSeenAt: device.lastSeenAt,
      createdAt: device.createdAt,
      expiresAt: device.expiresAt,
      isCurrent: context.device?.id === device.id,
    }));
    return body;
  });

  app.delete('/auth/devices/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    auth.revokeDevice(context.user.id, id);
    return { ok: true };
  });

  app.get('/auth/config', async () => {
    // Surfaced so the desktop client can adapt without hard-coding paths.
    return { basePath: config.basePath, apiPath: `${config.basePath}/api` };
  });
}
