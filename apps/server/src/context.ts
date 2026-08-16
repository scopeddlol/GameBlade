import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyBaseLogger } from 'fastify';
import { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { DownloadTokenService } from './services/downloads.js';
import { ImageCache } from './services/metadata/images.js';
import { MetadataService } from './services/metadata/service.js';
import { ScannerService } from './services/scanner.js';
import { SettingsService } from './services/settings.js';

export interface GamebladeContext {
  config: Config;
  db: Db;
  auth: AuthService;
  settings: SettingsService;
  metadata: MetadataService;
  scanner: ScannerService;
  downloadTokens: DownloadTokenService;
  images: ImageCache;
  /** Cookie path, so a sub-path deployment does not leak cookies to siblings. */
  cookiePath: string;
  cookieOptions: (secure: boolean) => CookieSerializeOptions;
}

declare module 'fastify' {
  interface FastifyInstance {
    gameblade: GamebladeContext;
  }
}

export function createContext(
  config: Config,
  db: Db,
  logger: FastifyBaseLogger,
): GamebladeContext {
  const settings = new SettingsService(db, config);
  const images = new ImageCache(db, config.imageCacheDir, logger);
  const metadata = new MetadataService(db, settings, images, logger);
  const scanner = new ScannerService(db, metadata, logger);
  const auth = new AuthService(db);
  const downloadTokens = new DownloadTokenService(db, config.sessionSecret);

  const cookiePath = config.basePath === '' ? '/' : config.basePath;

  return {
    config,
    db,
    auth,
    settings,
    metadata,
    scanner,
    downloadTokens,
    images,
    cookiePath,
    cookieOptions: (secure: boolean) => ({
      path: cookiePath,
      httpOnly: true,
      sameSite: 'lax',
      secure,
    }),
  };
}
