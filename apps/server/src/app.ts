import type { IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { ApiErrorBody } from '@gameblade/shared';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';
import { createAuthHook } from './auth/middleware.js';
import type { Config } from './config.js';
import { createContext } from './context.js';
import { createDb } from './db/index.js';
import { ApiError } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { apiV1Routes } from './routes/api-v1.js';
import { authRoutes } from './routes/auth.js';
import { discordRoutes } from './routes/discord.js';
import { downloadRoutes } from './routes/downloads.js';
import { gameRoutes } from './routes/games.js';
import { healthRoutes } from './routes/health.js';
import { homeRoutes } from './routes/home.js';
import { imageRoutes } from './routes/images.js';
import { installerRoutes } from './routes/installer.js';
import { playRoutes } from './routes/play.js';
import { realtimeRoutes } from './routes/realtime.js';
import { requestRoutes } from './routes/requests.js';
import { socialRoutes } from './routes/social.js';

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

  const { db, sqlite } = createDb(config.databasePath, app.log);
  const context = createContext(config, db, sqlite, app.log);
  app.decorate('gameblade', context);
  await context.images.init();
  await context.media.init();
  await context.saves.init();
  await context.installer.init();
  context.realtime.start();

  app.addHook('onClose', async () => {
    context.realtime.stop();
    // Closed cleanly rather than left to time out, so the bot goes offline in
    // Discord the moment the server does instead of lingering as a ghost.
    context.discordBot.shutdown();
    // Closing the handle checkpoints the WAL and releases the file. Windows
    // refuses to unlink a database that is still open, which made every test
    // that deletes its temp data directory fail there.
    sqlite.close();
  });

  await app.register(cookie);
  await app.register(websocket, {
    options: {
      // Presence frames are tiny; anything larger is a client bug or an abuse
      // attempt, and rejecting it early keeps the socket cheap.
      maxPayload: 16 * 1024,
    },
  });

  await app.register(helmet, {
    // The SPA is same-origin; artwork and media come from this server only.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Discord serves linked players' avatars from its own CDN, and the
        // account page, the friends list and the social tab all render one.
        // Without this they are blocked by the policy and every linked player
        // shows a broken image.
        imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.discordapp.com'],
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

  registerBinaryUploads(app);

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
      await homeRoutes(api);
      await gameRoutes(api);
      await imageRoutes(api);
      await installerRoutes(api);
      await discordRoutes(api);
      await downloadRoutes(api);
      await socialRoutes(api);
      await playRoutes(api);
      await realtimeRoutes(api);
      await requestRoutes(api);
      // Its own scope: the /v1 surface authenticates with an API key and
      // nothing else, so its onRequest guard must not run for any other route.
      await api.register(async (v1Scope) => {
        await apiV1Routes(v1Scope);
      });
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
 * Lets save archives, screenshots and clips be posted as a raw body.
 *
 * Fastify answers 415 for any content type it has no parser for, and its
 * built-in parsers all buffer the whole body first. These hand the untouched
 * stream to the route instead, which is what allows a half-gigabyte clip to be
 * hashed and written to disk without ever being held in memory. Every one of
 * these routes enforces its own byte ceiling while streaming.
 */
function registerBinaryUploads(app: FastifyInstance): void {
  const passthrough = (
    _request: FastifyRequest,
    payload: IncomingMessage,
    done: (error: Error | null, body?: unknown) => void,
  ) => done(null, payload);

  app.addContentTypeParser(['application/zip', 'application/octet-stream'], passthrough);
  // What a browser labels a picked .exe or .msi varies by platform and by
  // whatever the OS has registered, so every plausible label is accepted; the
  // installer route validates the extension rather than trusting any of them.
  app.addContentTypeParser(
    [
      'application/x-msdownload',
      'application/x-msi',
      'application/x-ms-installer',
      'application/vnd.microsoft.portable-executable',
      'application/exe',
      'application/x-exe',
    ],
    passthrough,
  );
  app.addContentTypeParser(/^image\//, passthrough);
  app.addContentTypeParser(/^video\//, passthrough);
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

  // The client ships relative asset URLs and reads its own base path from
  // <base href>. Rewriting it here is what lets one build serve both "/" and a
  // sub-path like "/gameblade" behind a reverse proxy, with no rebuild.
  const indexPath = path.join(config.webRoot, 'index.html');
  const rawIndex = await readFile(indexPath, 'utf8');
  const baseHref = config.basePath === '' ? '/' : `${config.basePath}/`;
  const indexHtml = rawIndex.replace(/<base\s+href="[^"]*"\s*\/?>/i, `<base href="${baseHref}" />`);

  if (!/<base\s+href=/i.test(rawIndex)) {
    app.log.warn('index.html has no <base href> tag — sub-path hosting will not work');
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

  const sendIndex = (reply: FastifyReply) =>
    reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(indexHtml);

  // Explicit index routes; @fastify/static is registered with index:false so the
  // rewritten HTML is always what gets served.
  app.get(prefix, async (_request, reply) => sendIndex(reply));
  if (config.basePath !== '') {
    app.get(config.basePath, async (_request, reply) => sendIndex(reply));
  }

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
    // Any other GET is a client-side route, so hand back the SPA shell.
    return sendIndex(reply);
  });
}
