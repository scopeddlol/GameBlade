/** Cookie holding the opaque web session token. */
export const SESSION_COOKIE = 'gb_session';

/**
 * Required on every state-changing request from the browser. Its mere presence
 * defeats cross-origin form posts, which cannot set custom headers without a
 * successful CORS preflight.
 */
export const CSRF_HEADER = 'x-gameblade-csrf';

/** Desktop clients identify themselves so the server can issue a device token. */
export const CLIENT_HEADER = 'x-gameblade-client';

/** Archive extensions treated as a single-file game during a library scan. */
export const ARCHIVE_EXTENSIONS = [
  '.zip',
  '.7z',
  '.rar',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.tar.zst',
  '.tar.xz',
  '.iso',
  '.gz',
  '.xz',
  '.zst',
] as const;

/** Files ignored while walking a library. */
export const IGNORED_ENTRIES = [
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '@eadir',
  '#recycle',
  '.recycle',
  'lost+found',
  '$recycle.bin',
  'system volume information',
] as const;

export const ROLES = ['admin', 'user'] as const;

export const MATCH_STATUS = ['unmatched', 'auto', 'manual', 'skipped'] as const;

export const GAME_KIND = ['folder', 'archive'] as const;

export const ART_KIND = ['cover', 'hero', 'logo', 'icon'] as const;

/** Default lifetime of a browser session, in days. */
export const SESSION_TTL_DAYS = 30;

/** Default lifetime of a desktop device token, in days. */
export const DEVICE_TOKEN_TTL_DAYS = 90;

/** Download tokens are single-purpose and short lived. */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 60 * 60 * 6;
