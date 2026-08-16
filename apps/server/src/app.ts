import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { ApiErrorBody } from '@gameblade/shared';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { createAuthHook } from './auth/middleware.js';
import type { Config } from './config.js';
import { createContext } from './context.js';
import { createDb } from './db/index.js';
import { ApiError } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { downloadRoutes } from './routes/downloads.js';
import { gameRoutes } from './routes/games.js';
import { healthRoutes } from './routes/health.js';
import { imageRoutes } from './routes/images.js';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    // Behind Pangolin (or any proxy) this makes request.ip and request.protocol
    // reflect the real client instead of the proxy.
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      ...(config.isProduction
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }),
    },
    // Large file transfers must never be cut short by a server-side timer.
    connectionTimeout: 0,
    requestTimeout: 0,
    keepAliveTimeout: 76_000,
    bodyLimit: 1024 * 1024,
    logController: new LogController({
      // A poster grid pulls dozens of images and a desktop download opens many
      // parallel connections; logging each would bury everything that matters.
      // Unless debugging, only non-asset routes produce request logs.
      disableRequestLogging: (request) => {
        if (config.logLevel === 'debug' || config.logLevel === 'trace') return false;
        return request.url.includes('/api/images/') || request.url.includes('/api/download/');
      },
    }),
  });

  const { db } = createDb(config.databasePath, app.log);
  const context = createContext(config, db, app.log);
  app.decorate('gameblade', context);
  await context.images.init();

  await app.register(cookie);

  await app.register(helmet, {
    // The SPA is same-origin; artwork and media come from this server only.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", 'https://www.youtube.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // Would otherwise block the YouTube trailer embeds on a game page.
    crossOriginEmbedderPolicy: false,
    // Downloads are served from this origin to this origin.
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: config.isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: `${config.rateLimitWindowMinutes} minutes`,
    // With trustProxy set, request.ip is the real client behind the proxy.
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({
      error: { code: 'too_many_requests', message: 'Too many requests. Please slow down.' },
    }),
  });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', createAuthHook(context.auth));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = {
        error: { code: error.code, message: error.message, details: error.details },
      };
      return reply.code(error.statusCode).send(body);
    }

    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: 'validation_error',
          message: error.issues[0]?.message ?? 'The submitted data is invalid',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      };
      return reply.code(400).send(body);
    }

    // Fastify's own errors (payload too large, bad JSON, rate limit) carry a status.
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }

    const body: ApiErrorBody = {
      error: {
        code: error.code ?? 'internal_error',
        // Never leak internals of a 500 to the client.
        message: status >= 500 ? 'Something went wrong on the server' : error.message,
      },
    };
    return reply.code(status).send(body);
  });

  const apiPrefix = `${config.basePath}/api`;

  await app.register(
    async (api) => {
      await healthRoutes(api);
      await authRoutes(api);
      await gameRoutes(api);
      await imageRoutes(api);
      await downloadRoutes(api);
      await api.register(async (adminScope) => {
        await adminRoutes(adminScope);
      });
    },
    { prefix: apiPrefix },
  );

  await registerWebClient(app, config);

  return app;
}

/**
 * Serve the built SPA and fall back to index.html for client-side routes, so a
 * deep link or a refresh does not 404.
 */
async function registerWebClient(app: FastifyInstance, config: Config): Promise<void> {
  if (!config.webRoot) {
    app.log.warn(
      'no built web client found — serving the API only (run "pnpm --filter @gameblade/web build")',
    );
    return;
  }

  const prefix = config.basePath === '' ? '/' : `${config.basePath}/`;

  await app.register(fastifyStatic, {
    root: config.webRoot,
    prefix,
    index: false,
    // Hashed asset filenames are safe to cache hard; index.html must not be.
    maxAge: '1y',
    immutable: true,
    setHeaders: (res, filePath) => {
      if (path.basename(filePath) === 'index.html') {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });

  const apiPrefix = `${config.basePath}/api`;

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith(apiPrefix)) {
      const body: ApiErrorBody = {
        error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
      };
      return reply.code(404).send(body);
    }
    if (request.method !== 'GET') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}
