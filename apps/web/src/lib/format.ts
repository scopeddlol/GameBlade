const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Binary sizes, since that is what a file manager will show for the download. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : decimals)} ${UNITS[index]}`;
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatYear(value: string | null): string | null {
  if (!value) return null;
  const year = new Date(value).getFullYear();
  return Number.isNaN(year) ? null : String(year);
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
