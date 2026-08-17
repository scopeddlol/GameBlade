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

/**
 * Playtime the way a game client says it: minutes below an hour, then hours to
 * one decimal. "0.4 hours" reads worse than "24 minutes" for a short session.
 */
export function formatPlaytime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Never played';
  if (seconds < 60) return 'Under a minute';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  const hours = seconds / 3600;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`;
}

export function formatRelative(value: string | null): string {
  if (!value) return 'Never';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'Never';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'Just now';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const divisions: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];

  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  let divisor = 60;
  for (const [limit, candidate] of divisions) {
    if (seconds < limit * 60 || candidate === 'year') {
      unit = candidate;
      divisor = limit;
      break;
    }
  }
  return formatter.format(-Math.round(seconds / divisor), unit);
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatYear(value: string | null): string | null {
  if (!value) return null;
  const year = new Date(value).getFullYear();
  return Number.isNaN(year) ? null : String(year);
}
