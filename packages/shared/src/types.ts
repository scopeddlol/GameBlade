import type { LandingBlock } from './landing.js';
import type { ThemePreset, ThemeTokens } from './theme.js';
import type {
  ACHIEVEMENT_SOURCE,
  ACTIVITY_KIND,
  BUG_SEVERITY,
  BUG_STATUS,
  API_SCOPES,
  ART_KIND,
  CATALOG_GAP,
  CLIENT_BUTTON_PLACEMENT,
  COLLECTION_COLORS,
  FRIENDSHIP_STATUS,
  GAME_KIND,
  GAME_REQUEST_STATUS,
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
export type CatalogGap = (typeof CATALOG_GAP)[number];
export type ClientButtonPlacement = (typeof CLIENT_BUTTON_PLACEMENT)[number];
export type ApiScope = (typeof API_SCOPES)[number];
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
  /** Wide Steam-style capsule, distinct from the portrait cover. */
  banner: string | null;
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
  /**
   * A short blurb for the detailed library layout, trimmed server-side.
   *
   * The full text lives on GameDetail; a list of 200 games does not want to
   * carry 200 full descriptions to render three lines of each.
   */
  summary: string | null;
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

  /** Whether an admin has told the client what to run once this is installed. */
  hasLaunchRule: boolean;
  /** Whether this game's saves are covered by a cloud-sync rule. */
  hasSaveRule: boolean;
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
  /**
   * The cached-image ids behind `screenshots`, positionally aligned with it.
   * The admin editor needs them to remove one; every other client only ever
   * renders the URLs.
   */
  screenshotIds: string[];
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
  state: 'idle' | 'scanning' | 'matching' | 'error' | 'canceled';
  /**
   * What the run is doing right now, which `state` alone does not say.
   *
   * `reading` is the walk of a library root. It used to report no count at
   * all — and, worse, left the previous library's finished tally on screen, so
   * a run part-way through its second root read "25 / 25" for as long as the
   * walk took. It now counts the entries it has found so far, which is a real
   * number that moves.
   */
  phase: 'reading' | 'indexing' | 'matching' | null;
  /** Name of the library being worked on, for a run covering several. */
  library: string | null;
  /** Which library of how many, so a multi-root run says where it is. */
  libraryIndex: number;
  libraryCount: number;
  /**
   * Progress within the current phase, reset whenever the phase or the library
   * changes. Carrying one phase's totals into the next is what produced counts
   * that were already complete before the work started.
   */
  processed: number;
  total: number;
  currentItem: string | null;
  /**
   * When a counter last moved.
   *
   * A scan that is working and a scan that is wedged look identical from a
   * progress readout alone. This is what lets the panel say "no progress for
   * four minutes" instead of leaving somebody watching a spinner.
   */
  heartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  added: number;
  updated: number;
  removed: number;
  /** Most recent activity lines, newest last, for the admin panel to show. */
  log: ScanLogEntry[];
  /** How many items the operator has skipped in this run. */
  skipped: number;
  /** How many items failed on their own — a provider error, an unreadable folder. */
  failed: number;
  /** True between asking to stop and the run actually stopping. */
  canceling: boolean;
}

export interface ScanLogEntry {
  at: string;
  level: 'info' | 'warn';
  message: string;
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
  /** Ceiling on one download stream, in KB/s. 0 disables the limit. */
  downloadSpeedLimitKbps?: number;
  /** Default monthly transfer allowance per account, in MB. 0 disables it. */
  monthlyQuotaMb?: number;
  /** The uploaded Windows installer, when one has been stored. */
  installer?: ClientInstallerInfo | null;
}

/**
 * An operator-defined link rendered by the desktop client — a Discord invite,
 * a wiki, a support page.
 */
export interface ClientButton {
  id: string;
  label: string;
  url: string;
  /** One of CLIENT_BUTTON_ICONS; the client maps it to an icon component. */
  icon: string;
  placement: ClientButtonPlacement;
  /** Shown as a tooltip in the client. */
  description: string | null;
  sortOrder: number;
  active: boolean;
}

/**
 * One folder on a player's machine that might already hold a game from the
 * catalog, offered for linking rather than re-downloading.
 */
export interface LocalGameMatch {
  /** The folder name that was searched for. */
  name: string;
  matches: Array<{ gameId: string; title: string; score: number }>;
}

/**
 * An API key as the admin panel sees it. The secret itself is never included —
 * it exists in plaintext exactly once, in the response that created it.
 */
export interface ApiKeyInfo {
  id: string;
  name: string;
  /** The leading characters of the token, so a key can be identified in a list. */
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  createdByUsername: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** False once revoked or expired. */
  isValid: boolean;
}

/** The one and only time the plaintext token is returned. */
export interface CreatedApiKey extends ApiKeyInfo {
  token: string;
}

/** A Windows client installer held on the server rather than linked elsewhere. */
export interface ClientInstallerInfo {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  /** Where the landing page's Download button points once this exists. */
  url: string;
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
  /** Set when the installer is hosted here, so the button can show its size. */
  downloadFileName: string | null;
  downloadSizeBytes: number | null;
  /** Colours for the whole app, resolved server-side so both clients agree. */
  theme: {
    preset: ThemePreset;
    accent: string | null;
    tokens: ThemeTokens;
  };
  /** The landing page's sections, in order. */
  landingBlocks: LandingBlock[];
}

/** One image an admin can choose for a game, from either provider. */
export interface ArtworkCandidate {
  provider: 'igdb' | 'steamgriddb';
  /** Full-size image, downloaded and cached locally when chosen. */
  url: string;
  /**
   * Smaller preview so a picker grid does not pull megabytes per thumbnail.
   * Served through this server rather than the provider's CDN, so the browser
   * never talks to IGDB or SteamGridDB directly.
   */
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
  /** The SteamGridDB style the results were narrowed to, if any. */
  style: string | null;
  /**
   * Which providers were actually consulted. An empty list means none are
   * configured, which a picker must not report as "this game has no artwork".
   */
  providers: Array<'igdb' | 'steamgriddb'>;
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
  /** Their Discord handle — only when they have chosen to show it. */
  discordUsername?: string | null;
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

/** The public-facing view of a profile: detail plus a slice of their activity. */
export interface ProfileShowcase {
  profile: ProfileDetail;
  posts: PostInfo[];
  topGames: PlaytimeEntry[];
  recentAchievements: AchievementProgress[];
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

/** An .exe found inside a game's files, offered as a launch-rule pick instead of free-typed. */
export interface ExecutableCandidate {
  path: string;
  sizeBytes: number;
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
  /** Custom emoji on an admin announcement; null falls back to a per-kind icon. */
  icon: string | null;
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
  /** True when `heroUrl` is a hand-picked override rather than the game's art. */
  hasHeroOverride: boolean;
  sortOrder: number;
}

/** Everything the Home tab needs, in one round trip. */
export interface HomeFeed {
  featured: FeaturedEntry[];
  continuePlaying: GameSummary[];
  recentlyAdded: GameSummary[];
  /** Most total playtime across everyone here — this catalog, these players. */
  popularHere: GameSummary[];
  /** The best-reviewed things on the shelf. */
  acclaimed: GameSummary[];
  /** A random handful, so the middle of a large archive is reachable at all. */
  surprise: GameSummary[];
  friendsPlaying: Array<{ profile: ProfileSummary; game: GameSummary }>;
  friendActivity: ActivityEntry[];
  recentAchievements: AchievementProgress[];
  /** What the operator has promised, and what players are asking for. */
  requests: GameRequestDigest;
  /** Server-wide counts shown as a small stat strip. */
  stats: {
    games: number;
    users: number;
    totalPlayHours: number;
    /** Games added in the last seven days, so "recently added" has a number. */
    newThisWeek: number;
    /** Bytes in the archive, for the "how big is this place" line. */
    archiveBytes: number;
  };
  /** The caller's own totals, so the greeting can say something true. */
  you: {
    libraryCount: number;
    playSeconds: number;
    unlockedCount: number;
    friendCount: number;
  };
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

/* ------------------------------------------------------------------- requests */

export type GameRequestStatus = (typeof GAME_REQUEST_STATUS)[number];

/**
 * A game somebody wants added to the archive.
 *
 * The requester is kept for the admin view but exposed to other players only
 * as a count — a request list is a wish list, not a public record of who
 * wants what.
 */
export interface GameRequestInfo {
  id: string;
  title: string;
  note: string | null;
  status: GameRequestStatus;
  /** How many accounts have backed it, including the original requester. */
  votes: number;
  /** True when the caller is one of them. */
  hasVoted: boolean;
  createdAt: string;
  updatedAt: string;
  /** The operator's reply, shown to everyone once a decision is made. */
  adminNote: string | null;
  /** Only populated for administrators. */
  requestedBy: { id: string; username: string } | null;
  decidedAt: string | null;
  /** Set once a request is fulfilled and matched to a catalog entry. */
  gameId: string | null;
}

/**
 * What came back from filing a request.
 *
 * `created` distinguishes a new row from a vote added to somebody else's —
 * the same call does both, and only the client can say which one happened in
 * words the person will understand.
 */
export interface CreatedGameRequest extends GameRequestInfo {
  created: boolean;
}

/** Counts per status, for the admin triage chips. */
export type GameRequestCounts = Record<GameRequestStatus, number>;

/** The digest the desktop client shows: what is coming, and what is wanted. */
export interface GameRequestDigest {
  comingSoon: GameRequestInfo[];
  mostRequested: GameRequestInfo[];
  recentlyAdded: GameRequestInfo[];
  /** The caller's own open requests, whatever their status. */
  yours: GameRequestInfo[];
  counts: GameRequestCounts;
}

/* ---------------------------------------------------------------- collections */

export type CollectionColor = (typeof COLLECTION_COLORS)[number];

/** A player's own grouping of games. Private to that account. */
export interface CollectionInfo {
  id: string;
  name: string;
  color: CollectionColor;
  sortOrder: number;
  gameCount: number;
  createdAt: string;
}

/**
 * A trending title offered on the request page, already checked against this
 * archive so the button can say what it will actually do.
 */
export interface GameRequestSuggestion {
  title: string;
  /** A provider URL, fetched through the server's image proxy. */
  coverUrl: string | null;
  releaseYear: number | null;
  /** One line of blurb, so a card says what the game is rather than only naming it. */
  summary: string | null;
  /** IGDB's aggregate score out of 100, or null when too few people have rated it. */
  rating: number | null;
  /** Already on the shelf: asking for it would be pointless. */
  inCatalog: boolean;
  /** Set when somebody has already asked, so the button becomes a vote. */
  requestId: string | null;
  status: GameRequestStatus | null;
  hasVoted: boolean;
}

/** The discovery shelves the request page browses, in the order they are shown. */
export const DISCOVERY_SHELVES = ['trending', 'anticipated', 'recent', 'acclaimed'] as const;
export type DiscoveryShelfId = (typeof DISCOVERY_SHELVES)[number];

/**
 * One row of the request page's browser.
 *
 * Shelves rather than a single "most popular" strip: what a player wants to ask
 * for is often not what happens to be peaking on Steam this week, and one list
 * of twelve gives them no way to look for anything else.
 */
export interface DiscoveryShelf {
  id: DiscoveryShelfId;
  label: string;
  hint: string;
  items: GameRequestSuggestion[];
}

/* -------------------------------------------------------------------- bugs */

export type BugStatus = (typeof BUG_STATUS)[number];
export type BugSeverity = (typeof BUG_SEVERITY)[number];

export interface BugReportInfo {
  id: string;
  title: string;
  body: string;
  severity: BugSeverity;
  status: BugStatus;
  /** The operator's answer, shown to the reporter. */
  reply: string | null;
  gameId: string | null;
  gameTitle: string | null;
  clientVersion: string | null;
  platform: string | null;
  /** Admin-only: recent client errors gathered at report time. */
  diagnostics: string | null;
  /** Admin-only: who reported it. */
  reporter: ProfileSummary | null;
  createdAt: string;
  updatedAt: string;
}
