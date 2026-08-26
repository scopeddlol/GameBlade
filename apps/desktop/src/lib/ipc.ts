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
  /**
   * The account's own id.
   *
   * Anything that has to recognise the caller in what the server returns
   * compares this — "is this message mine" answered by username instead would
   * be one rename away from wrong.
   */
  userId: string;
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
  /** The master switch: with it off nothing syncs without a button press. */
  syncSaves: boolean;
  /** Upload the save once the game closes. */
  autoSyncOnExit: boolean;
  /** Upload every this many minutes while playing; 0 is off. */
  autoSyncIntervalMinutes: number;
  /** On sign-in, upload anything this machine is ahead on. */
  autoSyncOnStart: boolean;
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

  /**
   * Turns a server-relative artwork path into one the webview can load.
   *
   * The result goes through the client's own image scheme rather than straight
   * at the server, so artwork is on local disk after the first look — faster on
   * every launch after that, and still there when the server is not.
   */
  imageUrl: (path: string) => invoke<string>('image_url', { path }),

  /* -------------------------------------------------------------- offline */

  /** Whether the server answered the last time anything asked it. */
  connectivity: () => invoke<{ online: boolean; cachedAtMs: number | null }>('connectivity'),

  /** Asks the server whether it is back. The only deliberate probe there is. */
  recheckConnection: () => invoke<boolean>('recheck_connection'),

  /** Reads one of a game's own files, for evaluating achievement rules. */
  readRuleFile: (gameId: string, template: string) =>
    invoke<string | null>('read_rule_file', { gameId, template }),

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
  /** `deleteFiles` removes the bytes already written; the user is asked first. */
  cancelDownload: (gameId: string, deleteFiles = false) =>
    invoke<boolean>('cancel_download', { gameId, deleteFiles }),
  pauseDownload: (gameId: string) => invoke<boolean>('pause_download', { gameId }),
  /** Dismisses a stopped download, optionally taking what it left on disk. */
  clearDownload: (gameId: string, deleteFiles = false) =>
    invoke<void>('clear_download', { gameId, deleteFiles }),
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

  /**
   * Closes the running game from here.
   *
   * Asks first and kills after a few seconds, so a game that handles the
   * request gets to save. Omitting the id means "whatever is running", which
   * is the only thing the title bar's Stop button can mean.
   */
  stopGame: (gameId?: string) => invoke<boolean>('stop_game', { gameId }),

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

  uploadMedia: (filePath: string, kind: 'image' | 'clip' | 'avatar' | 'banner' | 'sealed') =>
    invoke<{ id: string; url: string; kind: string }>('upload_media', { filePath, kind }),

  /* ------------------------------------------------------------ messages */

  /**
   * This device's message identity.
   *
   * Only ever the public half. The private key is generated in Rust, kept in
   * the OS credential store, and never crosses into the webview — which is
   * what stops a compromised page from being able to leak it.
   */
  messageIdentity: () => invoke<{ publicKey: string; fingerprint: string }>('message_identity'),

  /** The readable digest of somebody else's key, for comparing out loud. */
  keyFingerprint: (publicKey: string) => invoke<string>('key_fingerprint', { publicKey }),

  /** A new conversation key, already sealed for each device that should hold it. */
  sealConversationKey: (recipients: string[]) =>
    invoke<{ key: string; wraps: WrappedKey[] }>('seal_conversation_key', { recipients }),

  /** Re-seals a key this device can open, for devices that could not. */
  rewrapConversationKey: (conversationKey: string, recipients: string[]) =>
    invoke<WrappedKey[]>('rewrap_conversation_key', { conversationKey, recipients }),

  openConversationKey: (wrapped: { ephemeralPublic: string; nonce: string; ciphertext: string }) =>
    invoke<string>('open_conversation_key', { wrapped }),

  sealMessage: (conversationKey: string, plaintext: string) =>
    invoke<SealedBody>('seal_message', { conversationKey, plaintext }),

  openMessage: (conversationKey: string, sealed: SealedBody) =>
    invoke<string>('open_message', { conversationKey, sealed }),

  /** Encrypts a file and stages the ciphertext for upload. */
  sealFile: (conversationKey: string, filePath: string) =>
    invoke<{ path: string; name: string; sizeBytes: number; contentType: string }>('seal_file', {
      conversationKey,
      filePath,
    }),

  /** Fetches and opens an attachment, answering with a local file path. */
  openAttachment: (conversationKey: string, mediaId: string, url: string, contentType: string) =>
    invoke<string>('open_attachment', { conversationKey, mediaId, url, contentType }),
};

/** One conversation key sealed for one device. */
export interface WrappedKey {
  publicKey: string;
  ephemeralPublic: string;
  nonce: string;
  ciphertext: string;
}

/** A sealed body: a nonce and a ciphertext, both base64. */
export interface SealedBody {
  nonce: string;
  ciphertext: string;
}

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
