import type {
  ACHIEVEMENT_SOURCE,
  ACTIVITY_KIND,
  ART_KIND,
  FRIENDSHIP_STATUS,
  GAME_KIND,
  MATCH_STATUS,
  MEDIA_KIND,
  NOTIFICATION_KIND,
  POST_KIND,
  PRESENCE_STATUS,
  REACTIONS,
  ROLES,
  VISIBILITY,
} from './constants.js';

export type Role = (typeof ROLES)[number];
export type MatchStatus = (typeof MATCH_STATUS)[number];
export type GameKind = (typeof GAME_KIND)[number];
export type ArtKind = (typeof ART_KIND)[number];
export type Visibility = (typeof VISIBILITY)[number];
export type FriendshipStatus = (typeof FRIENDSHIP_STATUS)[number];
export type PresenceStatus = (typeof PRESENCE_STATUS)[number];
export type PostKind = (typeof POST_KIND)[number];
export type MediaKind = (typeof MEDIA_KIND)[number];
export type ActivityKind = (typeof ACTIVITY_KIND)[number];
export type NotificationKind = (typeof NOTIFICATION_KIND)[number];
export type AchievementSource = (typeof ACHIEVEMENT_SOURCE)[number];
export type ReactionKind = (typeof REACTIONS)[number];

export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  user: PublicUser;
  /** Token echoed back in the CSRF header on state-changing requests. */
  csrfToken: string;
}

export interface GameArt {
  cover: string | null;
  hero: string | null;
  logo: string | null;
  icon: string | null;
}

export interface GameSummary {
  id: string;
  title: string;
  sortTitle: string;
  kind: GameKind;
  sizeBytes: number;
  fileCount: number;
  releaseDate: string | null;
  rating: number | null;
  genres: string[];
  platforms: string[];
  art: GameArt;
  matchStatus: MatchStatus;
  isFavorite: boolean;
  addedAt: string;
  isMissing: boolean;

  /** True once the caller has added this game from the Store. */
  inLibrary: boolean;
  /** Lifetime playtime for the caller, in seconds. */
  playSeconds: number;
  lastPlayedAt: string | null;
  achievementCount: number;
  unlockedCount: number;
}

export interface GameDetail extends GameSummary {
  libraryId: string;
  libraryName: string;
  relPath: string;
  summary: string | null;
  storyline: string | null;
  developers: string[];
  publishers: string[];
  igdbId: number | null;
  sgdbId: number | null;
  screenshots: string[];
  videos: string[];
  updatedAt: string;
  scannedAt: string | null;
}

export interface GameFileEntry {
  id: string;
  /** Path relative to the game root, always forward-slashed. */
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  sha256: string | null;
}

/**
 * Describes everything a client needs to download a game. Folder games list
 * every file so a client can fetch them in parallel and resume individually;
 * archive games contain exactly one entry.
 */
export interface DownloadManifest {
  gameId: string;
  title: string;
  kind: GameKind;
  totalBytes: number;
  files: GameFileEntry[];
  /** Short-lived token accepted in place of a session on download routes. */
  token: string;
  expiresAt: string;
}

export interface LibraryInfo {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  gameCount: number;
  totalBytes: number;
  lastScanAt: string | null;
  lastScanStatus: string | null;
}

export interface ScanProgress {
  libraryId: string | null;
  state: 'idle' | 'scanning' | 'matching' | 'error';
  processed: number;
  total: number;
  currentItem: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  added: number;
  updated: number;
  removed: number;
}

export interface InviteInfo {
  id: string;
  code: string;
  role: Role;
  note: string | null;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
  createdByUsername: string | null;
  isValid: boolean;
}

export interface ProviderStatus {
  name: 'igdb' | 'steamgriddb';
  configured: boolean;
  reachable: boolean | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

export interface ServerSettings {
  serverName: string;
  allowSelfRegistration: boolean;
  providers: ProviderStatus[];
  /** Shown on the public landing page under the server name. */
  tagline: string;
  /** Where the landing page points the "Download for Windows" button. */
  downloadUrl: string | null;
  clientVersion: string | null;
  /** Present for admins only. */
  igdbClientId?: string | null;
  igdbClientSecretSet?: boolean;
  steamGridDbKeySet?: boolean;
  steamApiKeySet?: boolean;
}

/** The unauthenticated payload the landing page and sign-in screen read. */
export interface PublicServerInfo {
  serverName: string;
  tagline: string;
  allowSelfRegistration: boolean;
  /** False until the first administrator exists, which unlocks the setup flow. */
  isConfigured: boolean;
  downloadUrl: string | null;
  clientVersion: string | null;
  gameCount: number;
}

/** One image an admin can choose for a game, from either provider. */
export interface ArtworkCandidate {
  provider: 'igdb' | 'steamgriddb';
  /** Full-size image, downloaded and cached locally when chosen. */
  url: string;
  /** Smaller preview so a picker grid does not pull megabytes per thumbnail. */
  thumbnailUrl: string;
  width: number | null;
  height: number | null;
  /** SteamGridDB style, or which IGDB asset this came from. */
  label: string | null;
  /** Community score where the provider publishes one; higher is better. */
  score: number | null;
}

export interface ArtworkSearchResult {
  kind: ArtKind;
  query: string;
  candidates: ArtworkCandidate[];
  /**
   * Providers that failed. Surfaced rather than swallowed so a half-empty
   * picker reads as "SteamGridDB is down" instead of "no artwork exists".
   */
  errors: Array<{ provider: 'igdb' | 'steamgriddb'; message: string }>;
}

export interface MetadataCandidate {
  provider: 'igdb';
  id: number;
  title: string;
  releaseDate: string | null;
  summary: string | null;
  coverUrl: string | null;
  platforms: string[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

/* ------------------------------------------------------------------ profiles */

export interface ProfileSummary {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  accentColor: string;
  presence: PresenceStatus;
  /** Set only while `presence` is `in-game` and the viewer may see activity. */
  playingGameId: string | null;
  playingGameTitle: string | null;
  playingSince: string | null;
}

export interface ProfileDetail extends ProfileSummary {
  bio: string | null;
  bannerUrl: string | null;
  country: string | null;
  visibility: Visibility;
  showActivity: boolean;
  createdAt: string;
  lastSeenAt: string | null;

  gameCount: number;
  totalPlaySeconds: number;
  achievementCount: number;
  postCount: number;
  friendCount: number;

  /** How the viewer relates to this profile; absent on your own profile. */
  friendship: FriendshipView | null;
  isSelf: boolean;
  /** False when visibility hides the detail, in which case stats are zeroed. */
  canViewDetail: boolean;
}

export interface FriendshipView {
  status: FriendshipStatus;
  /** True when the viewer sent a still-pending request. */
  outgoing: boolean;
  since: string;
}

export interface FriendEntry {
  profile: ProfileSummary;
  friendsSince: string;
  /** Games both accounts have in their library, for the "play together" hint. */
  sharedGameCount: number;
}

export interface FriendRequests {
  incoming: Array<{ profile: ProfileSummary; requestedAt: string }>;
  outgoing: Array<{ profile: ProfileSummary; requestedAt: string }>;
}

/* -------------------------------------------------------------- achievements */

export interface AchievementDefinition {
  id: string;
  gameId: string;
  key: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  points: number;
  /** Hidden achievements show their name only once unlocked. */
  hidden: boolean;
  /** Share of players worldwide who have this, when the source reports it. */
  globalPercent: number | null;
  source: AchievementSource;
  sortOrder: number;
}

export interface AchievementProgress extends AchievementDefinition {
  unlockedAt: string | null;
  /** 0–100 for achievements tracked incrementally; null when binary. */
  progress: number | null;
}

export interface AchievementSummary {
  total: number;
  unlocked: number;
  points: number;
  earnedPoints: number;
  /** Most recent unlocks first, capped by the caller's limit. */
  recent: AchievementProgress[];
}

/* --------------------------------------------------------------- cloud saves */

export interface SaveSlotInfo {
  id: string;
  gameId: string;
  name: string;
  updatedAt: string;
  currentVersion: SaveVersionInfo | null;
  versionCount: number;
}

export interface SaveVersionInfo {
  id: string;
  sizeBytes: number;
  fileCount: number;
  sha256: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: string;
  /** Newest mtime inside the archive, used to order local vs remote. */
  capturedAt: string;
}

/**
 * Returned before an upload so the client can decide whether to push, pull or
 * prompt. `conflict` means both sides changed since the last sync.
 */
export interface SaveSyncStatus {
  slotId: string | null;
  gameId: string;
  state: 'in-sync' | 'local-newer' | 'remote-newer' | 'conflict' | 'no-remote' | 'no-local';
  remote: SaveVersionInfo | null;
  localSha256: string | null;
  localCapturedAt: string | null;
}

/** Admin-authored hints telling the client where a game keeps its saves. */
export interface SaveRule {
  id: string;
  gameId: string;
  /**
   * Path with `{userprofile}`, `{appdata}`, `{localappdata}`, `{documents}`,
   * `{savedgames}`, `{public}` and `{install}` placeholders.
   */
  pathTemplate: string;
  /** Optional glob restricting which files inside the folder are captured. */
  include: string | null;
  exclude: string | null;
  note: string | null;
}

/** Admin-authored hints telling the client what to run after installing. */
export interface LaunchRule {
  id: string;
  gameId: string;
  /** Path relative to the install root; blank means "detect the only .exe". */
  executable: string | null;
  args: string | null;
  workingDir: string | null;
  note: string | null;
}

/* --------------------------------------------------------------- social feed */

export interface MediaInfo {
  id: string;
  kind: MediaKind;
  url: string;
  /** Poster frame for clips; null for images. */
  thumbnailUrl: string | null;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface PostInfo {
  id: string;
  author: ProfileSummary;
  kind: PostKind;
  title: string | null;
  body: string | null;
  media: MediaInfo[];
  game: { id: string; title: string; coverUrl: string | null } | null;
  visibility: Visibility;
  createdAt: string;
  editedAt: string | null;
  commentCount: number;
  reactions: Record<ReactionKind, number>;
  /** The reaction the caller left, if any. */
  myReaction: ReactionKind | null;
  canEdit: boolean;
}

export interface CommentInfo {
  id: string;
  postId: string;
  author: ProfileSummary;
  body: string;
  createdAt: string;
  canEdit: boolean;
}

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  actor: ProfileSummary;
  createdAt: string;
  game: { id: string; title: string; coverUrl: string | null } | null;
  achievement: { id: string; name: string; iconUrl: string | null } | null;
  post: { id: string; title: string | null; excerpt: string | null } | null;
  /** Seconds played, on `played` entries. */
  seconds: number | null;
}

export interface NotificationInfo {
  id: string;
  kind: NotificationKind;
  actor: ProfileSummary | null;
  title: string;
  body: string | null;
  /** Client route to open, e.g. `social/post/<id>` or `profile/<id>`. */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------- home and store */

export interface FeaturedEntry {
  id: string;
  game: GameSummary;
  headline: string | null;
  blurb: string | null;
  /** Overrides the game's own hero art on the Home carousel. */
  heroUrl: string | null;
  sortOrder: number;
}

/** Everything the Home tab needs, in one round trip. */
export interface HomeFeed {
  featured: FeaturedEntry[];
  continuePlaying: GameSummary[];
  recentlyAdded: GameSummary[];
  friendsPlaying: Array<{ profile: ProfileSummary; game: GameSummary }>;
  friendActivity: ActivityEntry[];
  recentAchievements: AchievementProgress[];
  /** Server-wide counts shown as a small stat strip. */
  stats: { games: number; users: number; totalPlayHours: number };
}

export interface StoreFacets {
  genres: Array<{ value: string; count: number }>;
  platforms: Array<{ value: string; count: number }>;
  developers: Array<{ value: string; count: number }>;
}

/* ------------------------------------------------------------------- playtime */

export interface PlaySessionInfo {
  id: string;
  gameId: string;
  startedAt: string;
  endedAt: string | null;
  seconds: number;
}

export interface PlaytimeEntry {
  game: { id: string; title: string; coverUrl: string | null };
  totalSeconds: number;
  lastPlayedAt: string | null;
  launchCount: number;
}

/* ------------------------------------------------------------------- realtime */

/** Frames the server pushes over the realtime socket. */
export type RealtimeEvent =
  | { type: 'hello'; userId: string; serverTime: string }
  | { type: 'presence'; profile: ProfileSummary }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'notification'; notification: NotificationInfo }
  | { type: 'friend-request'; profile: ProfileSummary }
  | { type: 'achievement'; achievement: AchievementProgress }
  | { type: 'pong'; serverTime: string };

/** Frames the client sends. */
export type RealtimeCommand =
  { type: 'ping' } | { type: 'presence'; status: PresenceStatus; gameId?: string | null };

export interface Paginated<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
