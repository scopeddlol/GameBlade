import { invoke } from '@tauri-apps/api/core';
import type { GameDetail, GameSummary, Paginated } from '@gameblade/shared';

export interface SessionInfo {
  server_url: string;
  username: string;
  role: string;
}

export interface UserInfo {
  id: string;
  username: string;
  role: string;
}

export type DownloadStatus =
  'queued' | 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled';

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

export const ipc = {
  currentSession: () => invoke<SessionInfo | null>('current_session'),

  signIn: (serverUrl: string, username: string, password: string) =>
    invoke<UserInfo>('sign_in', { serverUrl, username, password }),

  signOut: () => invoke<void>('sign_out'),

  verifySession: () => invoke<UserInfo>('verify_session'),

  fetchGames: (query: string) => invoke<Paginated<GameSummary>>('fetch_games', { query }),

  fetchGame: (gameId: string) => invoke<GameDetail>('fetch_game', { gameId }),

  /** Artwork paths need the device token appended before an <img> can load them. */
  imageUrl: (path: string) => invoke<string>('image_url', { path }),

  startDownload: (gameId: string, destination: string) =>
    invoke<void>('start_download', { gameId, destination }),

  cancelDownload: (gameId: string) => invoke<boolean>('cancel_download', { gameId }),

  clearDownload: (gameId: string) => invoke<void>('clear_download', { gameId }),

  listDownloads: () => invoke<DownloadState[]>('list_downloads'),
};

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(remainingBytes: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0 || remainingBytes <= 0) return '—';
  const seconds = Math.round(remainingBytes / bytesPerSecond);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}
