import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyBaseLogger } from 'fastify';
import { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { AchievementService } from './services/achievements.js';
import { ActivityService } from './services/activity.js';
import { CatalogService } from './services/catalog.js';
import { ChecksumService } from './services/checksums.js';
import { DownloadTokenService } from './services/downloads.js';
import { FriendService } from './services/friends.js';
import { MediaStore } from './services/media.js';
import { ImageCache } from './services/metadata/images.js';
import { MetadataService } from './services/metadata/service.js';
import { NotificationService } from './services/notifications.js';
import { PlaytimeService } from './services/playtime.js';
import { PresenceService } from './services/presence.js';
import { ProfileService } from './services/profiles.js';
import { RealtimeGateway } from './services/realtime.js';
import { SaveService } from './services/saves.js';
import { ScannerService } from './services/scanner.js';
import { SettingsService } from './services/settings.js';
import { SocialService } from './services/social.js';

export interface GamebladeContext {
  config: Config;
  db: Db;
  auth: AuthService;
  settings: SettingsService;
  metadata: MetadataService;
  scanner: ScannerService;
  checksums: ChecksumService;
  downloadTokens: DownloadTokenService;
  images: ImageCache;

  presence: PresenceService;
  profiles: ProfileService;
  realtime: RealtimeGateway;
  notifications: NotificationService;
  activity: ActivityService;
  friends: FriendService;
  media: MediaStore;
  social: SocialService;
  playtime: PlaytimeService;
  achievements: AchievementService;
  saves: SaveService;
  catalog: CatalogService;

  /** Cookie path, so a sub-path deployment does not leak cookies to siblings. */
  cookiePath: string;
  cookieOptions: (secure: boolean) => CookieSerializeOptions;
}

declare module 'fastify' {
  interface FastifyInstance {
    gameblade: GamebladeContext;
  }
}

/**
 * Services are wired here in dependency order. The order matters: presence has
 * no dependencies, profiles reads it, the realtime gateway routes on top of
 * both, and everything that notifies or records activity sits above that.
 */
export function createContext(config: Config, db: Db, logger: FastifyBaseLogger): GamebladeContext {
  const settings = new SettingsService(db, config);
  const images = new ImageCache(db, config.imageCacheDir, logger);
  const metadata = new MetadataService(db, settings, images, logger);
  const scanner = new ScannerService(db, metadata, logger);
  const checksums = new ChecksumService(db, logger);
  const auth = new AuthService(db);
  const downloadTokens = new DownloadTokenService(db, config.sessionSecret);

  const presence = new PresenceService();
  const profiles = new ProfileService(db, config, presence);
  const realtime = new RealtimeGateway(presence, profiles, logger);
  const notifications = new NotificationService(db, profiles, realtime);
  const activity = new ActivityService(db, config, profiles, realtime);
  const friends = new FriendService(db, profiles, notifications, activity, realtime);
  const media = new MediaStore(db, config, logger);
  const social = new SocialService(db, config, profiles, friends, media, notifications, activity);
  const playtime = new PlaytimeService(db, config, presence, activity);
  const achievements = new AchievementService(
    db,
    settings,
    notifications,
    activity,
    realtime,
    logger,
  );
  const saves = new SaveService(db, config, logger);
  const catalog = new CatalogService(
    db,
    config,
    playtime,
    achievements,
    profiles,
    presence,
    activity,
  );

  const cookiePath = config.basePath === '' ? '/' : config.basePath;

  return {
    config,
    db,
    auth,
    settings,
    metadata,
    scanner,
    checksums,
    downloadTokens,
    images,

    presence,
    profiles,
    realtime,
    notifications,
    activity,
    friends,
    media,
    social,
    playtime,
    achievements,
    saves,
    catalog,

    cookiePath,
    cookieOptions: (secure: boolean) => ({
      path: cookiePath,
      httpOnly: true,
      sameSite: 'lax',
      secure,
    }),
  };
}
