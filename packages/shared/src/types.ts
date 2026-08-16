import type { ART_KIND, GAME_KIND, MATCH_STATUS, ROLES } from './constants.js';

export type Role = (typeof ROLES)[number];
export type MatchStatus = (typeof MATCH_STATUS)[number];
export type GameKind = (typeof GAME_KIND)[number];
export type ArtKind = (typeof ART_KIND)[number];

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
  /** Present for admins only. */
  igdbClientId?: string | null;
  igdbClientSecretSet?: boolean;
  steamGridDbKeySet?: boolean;
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
