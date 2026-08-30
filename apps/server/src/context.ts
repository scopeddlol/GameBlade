import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyBaseLogger } from 'fastify';
import { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { AchievementService } from './services/achievements.js';
import { AnalyticsService } from './services/analytics.js';
import { ApiKeyService } from './services/apiKeys.js';
import { BandwidthService } from './services/bandwidth.js';
import { ActivityService } from './services/activity.js';
import { CatalogService } from './services/catalog.js';
import { ClientButtonService } from './services/clientButtons.js';
import { CollectionService } from './services/collections.js';
import { ChecksumService } from './services/checksums.js';
import { CatalogIngestService } from './services/catalogIngest.js';
import { NodeStatusService } from './services/nodeStatus.js';
import { ChunkService } from './services/chunks.js';
import { DownloadTokenService } from './services/downloads.js';
import { FriendService } from './services/friends.js';
import { GameRequestService } from './services/gameRequests.js';
import { InstallerService } from './services/installer.js';
import { MediaStore } from './services/media.js';
import { MeshService } from './services/mesh.js';
import { MessagingService } from './services/messaging.js';
import { ImageCache } from './services/metadata/images.js';
import { DiscordService } from './services/discord.js';
import { DiscordBotService } from './services/discordBot.js';
import { SaveManifestService } from './services/saveManifest.js';
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
import type Database from 'better-sqlite3';
import { BackupService } from './services/backups.js';
import { HealthService } from './services/health.js';
import { BugService } from './services/bugs.js';

export interface GamebladeContext {
  config: Config;
  db: Db;
  /**
   * The raw handle, for pragmas and maintenance the query builder cannot say.
   *
   * Everything that reads or writes rows goes through `db`; this is only for
   * VACUUM, ANALYZE and checkpoints — statements that act on the file rather
   * than on any table in it.
   */
  sqlite: Database.Database;
  auth: AuthService;
  settings: SettingsService;
  metadata: MetadataService;
  scanner: ScannerService;
  checksums: ChecksumService;
  /** Per-chunk hashes, which are what let a game be fetched from a node. */
  chunks: ChunkService;
  /** The coordinator: who the nodes are, how to reach them, what they hold. */
  mesh: MeshService;
  /** Folds a catalog a node scanned into this database, preserving game ids. */
  catalogIngest: CatalogIngestService;
  /** What this machine can say about itself when it is a node. */
  nodeStatus: NodeStatusService;
  downloadTokens: DownloadTokenService;
  images: ImageCache;
  installer: InstallerService;
  clientButtons: ClientButtonService;
  collections: CollectionService;
  gameRequests: GameRequestService;
  /** Save-path data pulled from upstream, for suggesting rules. */
  saveManifest: SaveManifestService;
  /** Archives of everything in the data directory that cannot be recreated. */
  backups: BackupService;
  /** What needs an operator's attention right now. */
  health: HealthService;
  /** Reports from the people using it. */
  bugs: BugService;
  apiKeys: ApiKeyService;
  /** Linking, signing in with, and posting to Discord. */
  discord: DiscordService;
  /** The live half: presence, slash commands, buttons and tickets. */
  discordBot: DiscordBotService;
  bandwidth: BandwidthService;
  analytics: AnalyticsService;

  presence: PresenceService;
  profiles: ProfileService;
  realtime: RealtimeGateway;
  notifications: NotificationService;
  activity: ActivityService;
  friends: FriendService;
  media: MediaStore;
  social: SocialService;
  /** Conversations the server routes and cannot read. */
  messaging: MessagingService;
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
export function createContext(
  config: Config,
  db: Db,
  sqlite: Database.Database,
  logger: FastifyBaseLogger,
): GamebladeContext {
  const settings = new SettingsService(db, config);
  const images = new ImageCache(db, config.imageCacheDir, logger);
  const metadata = new MetadataService(db, settings, images, logger, config.basePath);
  const saveManifest = new SaveManifestService(config.dataDir);
  const discord = new DiscordService(db, settings, config.basePath, logger);
  const backups = new BackupService(config.dataDir, sqlite);
  const scanner = new ScannerService(db, metadata, logger);
  // Zero is the "work it out" default, and `undefined` is what the services
  // read as that — passing 0 straight through would clamp to one file at a time.
  const hashConcurrency = config.hashConcurrency > 0 ? config.hashConcurrency : undefined;
  const checksums = new ChecksumService(db, logger, hashConcurrency);
  const chunks = new ChunkService(db, logger, hashConcurrency);
  const mesh = new MeshService(db, logger);
  const catalogIngest = new CatalogIngestService(db, logger);
  const nodeStatus = new NodeStatusService(db, config, scanner, chunks);
  const auth = new AuthService(db);
  const downloadTokens = new DownloadTokenService(db, config.sessionSecret);
  const installer = new InstallerService(db, config);
  const clientButtons = new ClientButtonService(db);
  const collections = new CollectionService(db);
  const gameRequests = new GameRequestService(db);
  const apiKeys = new ApiKeyService(db);
  const bandwidth = new BandwidthService(db, settings);
  const analytics = new AnalyticsService(db, bandwidth);

  const presence = new PresenceService();
  const profiles = new ProfileService(db, config, presence, discord);
  const realtime = new RealtimeGateway(presence, profiles, logger);
  const notifications = new NotificationService(db, profiles, realtime);
  const bugs = new BugService(db, profiles, notifications);
  const health = new HealthService(db, config, analytics, bugs);
  const activity = new ActivityService(db, config, profiles, realtime);
  const friends = new FriendService(db, profiles, notifications, activity, realtime);
  const media = new MediaStore(db, config, logger);
  const social = new SocialService(db, config, profiles, friends, media, notifications, activity);
  const messaging = new MessagingService(db, config, profiles, friends, media, realtime);
  // After profiles and media: `/profile` reads both.
  const discordBot = new DiscordBotService(db, settings, discord, profiles, media, logger);
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
    gameRequests,
    mesh,
  );

  const cookiePath = config.basePath === '' ? '/' : config.basePath;

  return {
    config,
    db,
    sqlite,
    auth,
    settings,
    metadata,
    scanner,
    checksums,
    chunks,
    mesh,
    catalogIngest,
    nodeStatus,
    downloadTokens,
    images,
    installer,
    clientButtons,
    collections,
    gameRequests,
    saveManifest,
    discord,
    discordBot,
    backups,
    health,
    bugs,
    apiKeys,
    bandwidth,
    analytics,

    presence,
    profiles,
    realtime,
    notifications,
    activity,
    friends,
    media,
    social,
    messaging,
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
