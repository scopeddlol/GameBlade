import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Where the node image expects a single library to be mounted.
 *
 * The one-library case, which is most of them: mount the games here and the
 * node needs no configuration at all.
 */
export const DEFAULT_LIBRARY_ROOT = '/library';

/**
 * Where a node with more than one library mounts each of them.
 *
 * A node holding two drives is ordinary — one archive on a spinning 3 TB disk
 * and another on an SSD — and there was no way to say so. `LIBRARY_PATHS` could
 * carry a list, but the node image set it to `/library` and nothing in the
 * compose file suggested it could be anything else, so a second `:ro` mount
 * simply went unread and the node reported one library while holding two.
 *
 * Every immediate subdirectory of this is a library root, named after the
 * directory. So two drives is two mounts and nothing else:
 *
 *     - /mnt/3TB:/libraries/3TB:ro
 *     - /mnt/E:/libraries/E:ro
 *
 * A directory rather than a variable because the mount is the thing an
 * operator was already going to write, and it names the library at the same
 * time. `LIBRARY_PATHS` still overrides all of this for anyone who wants paths
 * of their own.
 */
export const MULTI_LIBRARY_ROOT = '/libraries';

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
  /**
   * Library roots, comma- or semicolon-separated.
   *
   * Set here it is exactly what gets scanned, in every role. Left empty on a
   * node, the mounts decide instead — see `discoverLibraryRoots`.
   */
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
   * Optional override. Coordinators otherwise use the request hostname and
   * the relay's default UDP port, matching docker-compose.coordinator.yml.
   */
  RELAY_ENDPOINT: z.string().optional(),
  /** One-time code from Admin → Nodes. Only needed once. */
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

  /**
   * Whether a node hashes what it scanned without being asked.
   *
   * On by default and only acted on by the `node` role, because a node cannot
   * be asked: it has no API. Turning it off is for an operator who would rather
   * schedule hours of disk reads themselves than have them start after a scan.
   */
  AUTO_CHUNK_HASH: booleanish.default(true),

  /**
   * How many files are hashed at once.
   *
   * Zero means "work it out from the machine", which is what almost every
   * deployment should leave it as. It is here for the two cases the default
   * cannot know about: an archive on a single spinning disk, where parallel
   * reads turn a sequential scan into seek thrash and one is genuinely faster,
   * and a box whose cores are wanted for something else.
   */
  HASH_CONCURRENCY: z.coerce.number().int().min(0).max(32).default(0),

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

/**
 * A node's library roots, when the operator has not listed them.
 *
 * Reads the mounts rather than asking for them a second time. `/library` is
 * the single-library case the node image has always documented; every
 * immediate subdirectory of `/libraries` is one root each, which is how a node
 * holding two drives says so.
 *
 * Both are looked at, so an operator who already had `/library` and then adds
 * `/libraries/E` keeps the first one — the alternative would silently drop the
 * catalog they already had and orphan everything attached to it.
 *
 * Unreadable entries are skipped rather than fatal: a mount that failed is a
 * thing to say on the node's page, not a reason to refuse to start.
 */
export function discoverLibraryRoots(
  single: string = DEFAULT_LIBRARY_ROOT,
  many: string = MULTI_LIBRARY_ROOT,
): string[] {
  const roots: string[] = [];

  const isDirectory = (candidate: string): boolean => {
    try {
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  };

  if (isDirectory(single)) roots.push(path.resolve(single));

  try {
    for (const entry of readdirSync(many, { withFileTypes: true })) {
      // Symlinked mounts are ordinary, so `isDirectory()` alone would miss
      // them; the stat below follows the link and answers for the target.
      if (entry.name.startsWith('.')) continue;
      const candidate = path.join(many, entry.name);
      if (isDirectory(candidate)) roots.push(path.resolve(candidate));
    }
  } catch {
    // No /libraries at all is the ordinary single-library node.
  }

  return roots;
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
  const declaredPaths = e.LIBRARY_PATHS.split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));

  /*
   * A node with nothing declared reads its own mounts.
   *
   * Only a node: a standalone server's libraries are rows an administrator
   * adds in the panel, and a coordinator has no disk to look at. Declaring
   * `LIBRARY_PATHS` still wins everywhere, so an operator who wants exact
   * paths has them and nothing is guessed underneath them.
   */
  const libraryPaths =
    e.ROLE === 'node' && declaredPaths.length === 0 ? discoverLibraryRoots() : declaredPaths;

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
    /** Whether the list above was read off the mounts rather than declared. */
    libraryPathsDiscovered: e.ROLE === 'node' && declaredPaths.length === 0,

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

    /** Only meaningful on a node; see the schema above. */
    autoChunkHash: e.AUTO_CHUNK_HASH,

    scanOnStart: e.SCAN_ON_START,
    scanIntervalMinutes: e.SCAN_INTERVAL_MINUTES,
    scanConcurrency: e.SCAN_CONCURRENCY,
    /** Zero means "decide from the machine"; see the schema above. */
    hashConcurrency: e.HASH_CONCURRENCY,

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
