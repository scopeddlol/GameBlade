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

/** Normalises `/gameblade/` and `gameblade` alike to `/gameblade`; root is ''. */
function normaliseBasePath(raw: string | undefined): string {
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

    dataDir,
    databasePath: path.join(dataDir, 'gameblade.db'),
    imageCacheDir: path.join(dataDir, 'images'),
    /** User uploads: avatars, banners, screenshots and clips. */
    mediaDir: path.join(dataDir, 'media'),
    /** Cloud save archives, one immutable zip per version. */
    savesDir: path.join(dataDir, 'saves'),
    libraryPaths,

    mediaQuotaBytes: e.MEDIA_QUOTA_MB * 1024 * 1024,
    saveQuotaBytes: e.SAVE_QUOTA_MB * 1024 * 1024,

    basePath: normaliseBasePath(e.BASE_PATH),
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
