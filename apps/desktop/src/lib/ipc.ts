import { invoke } from '@tauri-apps/api/core';

/**
 * Deliberately without the server address.
 *
 * The client only ever talks to one server, so naming it on screen tells a
 * user nothing they can act on. Keeping it out of the payload entirely is what
 * stops it reappearing in the UI — or in a screenshot — by accident; the Rust
 * side still holds it and puts it on every request.
 */
export interface SessionInfo {
  username: string;
  role: string;
}

export interface UserInfo {
  id: string;
  username: string;
  role: string;
}

export type DownloadStatus =
  'queued' | 'downloading' | 'verifying' | 'completed' | 'failed' | 'canceled' | 'paused';

/** Mirrors the Rust `DownloadState` struct, which serialises with snake_case. */
export interface DownloadState {
  game_id: string;
  title: string;
  status: DownloadStatus;
  total_bytes: number;
  downloaded_bytes: number;
  bytes_per_second: number;
  files_total: number;
  files_completed: number;
  current_file: string | null;
  destination: string;
  error: string | null;
}

export interface InstalledGame {
  gameId: string;
  title: string;
  installPath: string;
  executable: string | null;
  sizeBytes: number;
  installedAt: string;
  saveBaseSha256: string | null;
}

/** A folder on this machine that might already hold a game from the catalog. */
export interface InstallCandidate {
  path: string;
  name: string;
  sizeBytes: number;
  executable: string | null;
  executableCount: number;
}

export interface RunningGame {
  gameId: string;
  title: string;
  sessionId: string;
  startedAt: string;
  seconds: number;
}

export interface ClientSettings {
  installDir: string;
  extraInstallDirs: string[];
  syncSaves: boolean;
  promptOnSaveConflict: boolean;
  shareActivity: boolean;
  minimizeOnLaunch: boolean;
  downloadConcurrency: number;
  verifyDownloads: boolean;
  /** Null follows whatever theme the server is set to. */
  themePreset: string | null;
  /** A `#rrggbb` accent overriding the theme's own; only used with a preset. */
  themeAccent: string | null;
  libraryView: 'grid' | 'list' | 'detailed';
  /** Prefer a game's logo artwork over its title on the detail page. */
  useLogoTitles: boolean;
}

/** Mirrors the Rust `StorageLocation` struct, which serialises with snake_case. */
export interface StorageLocation {
  path: string;
  is_default: boolean;
  available_bytes: number;
  total_bytes: number;
}

export interface SaveRulePayload {
  pathTemplate: string;
  include: string | null;
  exclude: string | null;
}

export interface LocalSave {
  root: string;
  fileCount: number;
  sizeBytes: number;
  sha256: string;
  capturedAt: string;
}

export interface DiskUsage {
  available_bytes: number;
  total_bytes: number;
}

/**
 * The bridge to the Rust side.
 *
 * HTTP calls go through generic pass-throughs rather than one command per
 * endpoint: the server already owns validation and response shapes, so
 * mirroring each route in Rust would only create somewhere for the two to
 * drift apart. Anything that touches the filesystem, a process or the
 * credential store gets a real command, because only Rust can do it.
 */
export const ipc = {
  currentSession: () => invoke<SessionInfo | null>('current_session'),

  signIn: (username: string, password: string) =>
    invoke<UserInfo>('sign_in', { username, password }),

  signOut: () => invoke<void>('sign_out'),

  verifySession: () => invoke<UserInfo>('verify_session'),

  /* ------------------------------------------------------------------ api */

  get: <T>(path: string) => invoke<T>('api_get', { path }),
  post: <T>(path: string, body?: unknown) => invoke<T>('api_post', { path, body }),
  put: <T>(path: string, body?: unknown) => invoke<T>('api_put', { path, body }),
  patch: <T>(path: string, body?: unknown) => invoke<T>('api_patch', { path, body }),
  del: <T>(path: string) => invoke<T>('api_delete', { path }),

  /** Artwork paths need the device token appended before an <img> can load them. */
  imageUrl: (path: string) => invoke<string>('image_url', { path }),

  /* --------------------------------------------------------------- updates */

  /** The version this client was built as. */
  clientVersion: () => invoke<string>('client_version'),
  /** Downloads the published installer and hands off to it. */
  runClientInstaller: () => invoke<string>('run_client_installer'),

  /* ------------------------------------------------------------- settings */

  getSettings: () => invoke<ClientSettings>('get_settings'),
  updateSettings: (patch: ClientSettings) => invoke<ClientSettings>('update_settings', { patch }),

  /* ------------------------------------------------------------ downloads */

  startDownload: (gameId: string, destination?: string) =>
    invoke<void>('start_download', { gameId, destination }),
  cancelDownload: (gameId: string) => invoke<boolean>('cancel_download', { gameId }),
  pauseDownload: (gameId: string) => invoke<boolean>('pause_download', { gameId }),
  clearDownload: (gameId: string) => invoke<void>('clear_download', { gameId }),
  listDownloads: () => invoke<DownloadState[]>('list_downloads'),
  diskUsage: () => invoke<DiskUsage>('disk_usage'),
  listStorageLocations: () => invoke<StorageLocation[]>('list_storage_locations'),

  /* ------------------------------------------------------------- installs */

  listInstalled: () => invoke<InstalledGame[]>('list_installed'),
  finishInstall: (gameId: string, title: string, downloadedPath: string) =>
    invoke<InstalledGame>('finish_install', { gameId, title, downloadedPath }),
  uninstall: (gameId: string) => invoke<void>('uninstall_game', { gameId }),

  /** Folders that look like games, for linking a copy the user already has. */
  scanInstallCandidates: (roots?: string[]) =>
    invoke<InstallCandidate[]>('scan_install_candidates', { roots }),
  /** Registers a folder already on disk; nothing is copied or moved. */
  linkInstalled: (gameId: string, title: string, path: string) =>
    invoke<InstalledGame>('link_installed', { gameId, title, path }),
  /** Forgets a linked folder without deleting it. */
  unlinkInstalled: (gameId: string) => invoke<void>('unlink_installed', { gameId }),

  openInstallFolder: (gameId: string) => invoke<void>('open_install_folder', { gameId }),
  openExternal: (url: string) => invoke<void>('open_external', { url }),

  /* -------------------------------------------------------------- playing */

  launch: (
    gameId: string,
    options?: { executableOverride?: string; args?: string; workingDir?: string },
  ) =>
    invoke<RunningGame>('launch_game', {
      gameId,
      executableOverride: options?.executableOverride,
      args: options?.args,
      workingDir: options?.workingDir,
    }),
  runningGame: () => invoke<RunningGame | null>('running_game'),

  /* ---------------------------------------------------------- cloud saves */

  saveStatus: (gameId: string, rule: SaveRulePayload) =>
    invoke<{ remote: SaveSyncStatusPayload; local: LocalSave | null }>('save_status', {
      gameId,
      rule,
    }),
  pushSave: (gameId: string, rule: SaveRulePayload, force = false) =>
    invoke<unknown>('push_save', { gameId, rule, force }),
  pullSave: (gameId: string, rule: SaveRulePayload, slotId: string, versionId?: string) =>
    invoke<string>('pull_save', { gameId, rule, slotId, versionId }),

  uploadMedia: (filePath: string, kind: 'image' | 'clip' | 'avatar' | 'banner') =>
    invoke<{ id: string; url: string; kind: string }>('upload_media', { filePath, kind }),
};

/** The server's own sync verdict, echoed back through the Rust side. */
export interface SaveSyncStatusPayload {
  slotId: string | null;
  gameId: string;
  state: 'in-sync' | 'local-newer' | 'remote-newer' | 'conflict' | 'no-remote' | 'no-local';
  remote: {
    id: string;
    sizeBytes: number;
    fileCount: number;
    sha256: string;
    deviceName: string | null;
    createdAt: string;
    capturedAt: string;
  } | null;
}

/** Builds a query string, omitting empty values so URLs stay readable. */
export function queryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/** Tauri rejects with a plain string; surface it rather than "[object Object]". */
export function errorMessage(caught: unknown): string {
  if (typeof caught === 'string') return caught;
  if (caught instanceof Error) return caught.message;
  return 'Something went wrong.';
}
