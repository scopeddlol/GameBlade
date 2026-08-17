/**
 * Every timestamp in the database is an ISO-8601 string in UTC. Storing text
 * rather than epoch integers keeps rows readable in a SQLite browser and lets
 * SQLite's lexical comparison double as chronological ordering.
 */
export function isoNow(): string {
  return new Date().toISOString();
}

export function isoIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

/** Seconds between two ISO timestamps, floored at zero. */
export function secondsBetween(from: string, to: string): number {
  const delta = (new Date(to).getTime() - new Date(from).getTime()) / 1000;
  return Number.isFinite(delta) && delta > 0 ? Math.floor(delta) : 0;
}
