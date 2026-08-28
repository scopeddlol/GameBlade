import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const booleanish = z.union([z.boolean(), z.string()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
});

/**
 * `TRUST_PROXY` accepts the same values Fastify does: a boolean, a hop count,
 * or a comma-separated list of trusted addresses/CIDRs. Behind Pangolin or any
 * other reverse proxy this must be set, otherwise every client looks like the
 * proxy and rate limiting buckets everyone together.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim();
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalizes `/gameblade/` and `gameblade` alike to `/gameblade`; root is ''. */
function normalizeBasePath(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATA_DIR: z.string().default('/data'),
  LIBRARY_PATHS: z.string().default(''),

  /**
   * What this instance is.
   *
   * One image, three roles, rather than an image per role. The versions of a
   * coordinator and its nodes have to agree about the catalog they exchange,
   * and separate images are how they quietly stop agreeing — somebody updates
   * one and not the other. Shipping one artifact makes matching versions the
   * default rather than a thing to remember.
   *
   * `standalone` is everything in one process reading games off local disk —
   * exactly what GameBlade has always been, and the default, so an existing
   * deployment that upgrades behaves identically.
   *
   * `coordinator` holds the database, the panel and the API but no game files.
   * It does not scan; its catalog is reported to it by nodes.
   *
   * `node` is the opposite half: it holds the game files, scans them and
   * reports what it found upward. It has no database, no panel and no API of
   * its own.
   */
  ROLE: z.enum(['standalone', 'coordinator', 'node']).default('standalone'),

  /** Where a node reports its catalog. Required when ROLE is `node`. */
  COORDINATOR_URL: z.string().url().optional(),

  /**
   * The relay's public address, as `host:port`.
   *
   * Unset means there is no relay, and a client that cannot reach a node
   * directly simply cannot download from it — which is the honest answer, and
   * better than handing out an address nothing is listening on.
   */
  RELAY_ENDPOINT: z.string().optional(),
  /** One-time code from Admin → Settings → Nodes. Only needed once. */
  ENROLMENT_TOKEN: z.string().optional(),

  BASE_PATH: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  SECURE_COOKIES: z.union([booleanish, z.literal('auto')]).default('auto'),
  CORS_ORIGINS: z.string().default(''),

  SESSION_SECRET: z.string().optional(),
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ALLOW_SELF_REGISTRATION: booleanish.default(false),

  IGDB_CLIENT_ID: z.string().optional(),
  IGDB_CLIENT_SECRET: z.string().optional(),
  STEAMGRIDDB_API_KEY: z.string().optional(),
  STEAM_API_KEY: z.string().optional(),

  CLIENT_DOWNLOAD_URL: z.string().optional(),

  /** Ceiling on user uploads (avatars, screenshots, clips, saves) on disk. */
  MEDIA_QUOTA_MB: z.coerce.number().int().min(0).default(20_480),
  SAVE_QUOTA_MB: z.coerce.number().int().min(0).default(10_240),

  SCAN_ON_START: booleanish.default(true),
  SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(10080).default(360),
  SCAN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

  RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(300),
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(1),
});

export type Config = ReturnType<typeof loadConfig>;

/**
 * Split `host:port` into parts, or nothing if it is not one.
 *
 * Refuses rather than half-accepting: an endpoint with no port would be handed
 * to clients as somewhere to connect, and they would all fail at it.
 */
function parseEndpoint(value: string | undefined): { address: string; port: number } | null {
  if (!value) return null;

  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;

  const address = value.slice(0, separator).replace(/^\[|\]$/g, '');
  const port = Number(value.slice(separator + 1));
  if (!address || !Number.isInteger(port) || port < 1 || port > 65_535) return null;

  return { address, port };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  const dataDir = path.resolve(e.DATA_DIR);
  const libraryPaths = e.LIBRARY_PATHS.split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));

  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,

    role: e.ROLE,
    /** Whether this instance reads game files from its own disk. */
    servesLocalFiles: e.ROLE !== 'coordinator',
    /** Whether this instance owns a database, a panel and an API. */
    servesApi: e.ROLE !== 'node',
    /** Whether this instance scans local disk and reports what it found up. */
    reportsCatalogUpstream: e.ROLE === 'node',
    /** Where a node sends its catalog. Only meaningful in the `node` role. */
    coordinatorUrl: e.COORDINATOR_URL?.replace(/\/+$/, '') ?? null,
    /** Spent on first enrolment; absent afterwards is normal. */
    enrolmentToken: e.ENROLMENT_TOKEN ?? null,
    nodeStatePath: path.join(dataDir, 'node-state.json'),
    relayEndpoint: parseEndpoint(e.RELAY_ENDPOINT),
    dataDir,
    databasePath: path.join(dataDir, 'gameblade.db'),
    imageCacheDir: path.join(dataDir, 'images'),
    /** User uploads: avatars, banners, screenshots and clips. */
    mediaDir: path.join(dataDir, 'media'),
    /** Cloud save archives, one immutable zip per version. */
    savesDir: path.join(dataDir, 'saves'),
    /** The Windows client installer an administrator uploads, if any. */
    installerDir: path.join(dataDir, 'client'),
    libraryPaths,

    mediaQuotaBytes: e.MEDIA_QUOTA_MB * 1024 * 1024,
    saveQuotaBytes: e.SAVE_QUOTA_MB * 1024 * 1024,

    basePath: normalizeBasePath(e.BASE_PATH),
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    secureCookies: e.SECURE_COOKIES as boolean | 'auto',
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    sessionSecret: e.SESSION_SECRET ?? null,
    bootstrapAdmin:
      e.ADMIN_USERNAME && e.ADMIN_PASSWORD
        ? { username: e.ADMIN_USERNAME, password: e.ADMIN_PASSWORD }
        : null,
    allowSelfRegistration: e.ALLOW_SELF_REGISTRATION,

    igdb:
      e.IGDB_CLIENT_ID && e.IGDB_CLIENT_SECRET
        ? { clientId: e.IGDB_CLIENT_ID, clientSecret: e.IGDB_CLIENT_SECRET }
        : null,
    steamGridDbKey: e.STEAMGRIDDB_API_KEY ?? null,
    steamApiKey: e.STEAM_API_KEY ?? null,
    clientDownloadUrl: e.CLIENT_DOWNLOAD_URL?.trim() ? e.CLIENT_DOWNLOAD_URL.trim() : null,

    scanOnStart: e.SCAN_ON_START,
    scanIntervalMinutes: e.SCAN_INTERVAL_MINUTES,
    scanConcurrency: e.SCAN_CONCURRENCY,

    rateLimitMax: e.RATE_LIMIT_MAX,
    rateLimitWindowMinutes: e.RATE_LIMIT_WINDOW_MINUTES,

    /** Directory holding the built web client; absent during API-only dev. */
    webRoot: resolveWebRoot(),
  };
}

function resolveWebRoot(): string | null {
  const candidates = [
    process.env.WEB_ROOT,
    path.resolve(process.cwd(), 'public'),
    path.resolve(process.cwd(), '../web/dist'),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return path.resolve(candidate);
  }
  return null;
}
