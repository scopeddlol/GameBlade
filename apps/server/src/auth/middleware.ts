import { CSRF_HEADER, SESSION_COOKIE } from '@gameblade/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../lib/errors.js';
import { safeEqual } from '../lib/ids.js';
import type { AuthContext, AuthService } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolve the caller from either a session cookie (browser) or a bearer device
 * token (desktop). Runs on every request; routes decide whether auth is required.
 */
export function createAuthHook(auth: AuthService) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    request.auth = null;

    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      if (token) {
        request.auth = auth.resolveDeviceToken(token);
      }
      // A bearer token never carries ambient cookie authority, so there is
      // nothing for a cross-site request to forge and no CSRF check is needed.
      return;
    }

    const cookie = request.cookies[SESSION_COOKIE];
    if (!cookie) return;

    const context = auth.resolveSession(cookie);
    if (!context) {
      // Clear a stale cookie so the browser stops sending it.
      reply.clearCookie(SESSION_COOKIE, { path: request.server.gameblade.cookiePath });
      return;
    }

    request.auth = context;

    if (!SAFE_METHODS.has(request.method)) {
      const provided = request.headers[CSRF_HEADER];
      const expected = context.session?.csrfToken;
      const value = Array.isArray(provided) ? provided[0] : provided;
      if (!expected || !value || !safeEqual(value, expected)) {
        throw ApiError.forbidden('Invalid or missing CSRF token');
      }
    }
  };
}

/** Throws unless the request carries a valid session or device token. */
export function requireUser(request: FastifyRequest): AuthContext {
  if (!request.auth) throw ApiError.unauthorized();
  return request.auth;
}

export function requireAdmin(request: FastifyRequest): AuthContext {
  const context = requireUser(request);
  if (context.user.role !== 'admin') {
    throw ApiError.forbidden('This action requires an administrator account');
  }
  return context;
}
