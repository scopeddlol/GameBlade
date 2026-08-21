import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { downloadEvents, games, playSessions, userGameStats, users } from '../db/schema.js';
import { BandwidthService } from './bandwidth.js';

/** Everything the analytics page renders, assembled in one request. */
export interface AnalyticsReport {
  rangeDays: number;
  since: string;
  summary: {
    downloads: number;
    bytes: number;
    completedDownloads: number;
    activeUsers: number;
    playSeconds: number;
    /** Bytes served since the start of the current calendar month. */
    monthBytes: number;
    /** Bytes served over all time, for the "total transferred" tile. */
    allTimeBytes: number;
  };
  /** One point per day across the range, oldest first. */
  daily: Array<{ date: string; bytes: number; downloads: number }>;
  /** Bytes per calendar month, oldest first — the last 12 that have data. */
  monthly: Array<{ month: string; bytes: number; downloads: number }>;
  topGamesByDownloads: Array<{ gameId: string; title: string; downloads: number; bytes: number }>;
  topGamesByPlaytime: Array<{ gameId: string; title: string; seconds: number; players: number }>;
  topUsers: Array<{ userId: string; username: string; downloads: number; bytes: number }>;
  recentDownloads: Array<{
    id: string;
    at: string;
    username: string | null;
    title: string | null;
    bytes: number;
    /** How many files the download covered. */
    files: number;
    completed: boolean;
    client: string;
  }>;
  /** Per-account quota usage this month, for the accounts that have one. */
  quotas: Array<{
    userId: string;
    username: string;
    usedBytes: number;
    quotaBytes: number;
  }>;
}

/**
 * Reads the download log and play history for the admin analytics page.
 *
 * Everything is derived from rows that were already being written — download
 * events and play sessions — rather than from counters maintained alongside
 * them. A counter is a second source of truth, and the one that silently
 * disagrees.
 */
export class AnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly bandwidth: BandwidthService,
  ) {}

  report(rangeDays: number): AnalyticsReport {
    const since = new Date(Date.now() - rangeDays * 86_400_000).toISOString();
    const monthStart = BandwidthService.periodStart();

    const inRange = gte(downloadEvents.startedAt, since);

    const summaryRow = this.db
      .select({
        downloads: sql<number>`count(distinct ${downloadEvents.sessionId})`,
        bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)`,
        completed: sql<number>`sum(case when ${downloadEvents.completed} then 1 else 0 end)`,
        users: sql<number>`count(distinct ${downloadEvents.userId})`,
      })
      .from(downloadEvents)
      .where(inRange)
      .get();

    const monthRow = this.db
      .select({ bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)` })
      .from(downloadEvents)
      .where(gte(downloadEvents.startedAt, monthStart))
      .get();

    const allTimeRow = this.db
      .select({ bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)` })
      .from(downloadEvents)
      .get();

    const playRow = this.db
      .select({ seconds: sql<number>`coalesce(sum(${playSessions.seconds}), 0)` })
      .from(playSessions)
      .where(gte(playSessions.startedAt, since))
      .get();

    // Dates are stored as ISO strings, so the day and month keys are a prefix
    // of the value — no date parsing per row, and it sorts correctly as text.
    const dailyRows = this.db
      .select({
        date: sql<string>`substr(${downloadEvents.startedAt}, 1, 10)`,
        bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)`,
        downloads: sql<number>`count(distinct ${downloadEvents.sessionId})`,
      })
      .from(downloadEvents)
      .where(inRange)
      .groupBy(sql`substr(${downloadEvents.startedAt}, 1, 10)`)
      .all();

    const monthlyRows = this.db
      .select({
        month: sql<string>`substr(${downloadEvents.startedAt}, 1, 7)`,
        bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)`,
        downloads: sql<number>`count(distinct ${downloadEvents.sessionId})`,
      })
      .from(downloadEvents)
      .groupBy(sql`substr(${downloadEvents.startedAt}, 1, 7)`)
      .orderBy(sql`substr(${downloadEvents.startedAt}, 1, 7) desc`)
      .limit(12)
      .all();

    const topGamesByDownloads = this.db
      .select({
        gameId: downloadEvents.gameId,
        title: games.title,
        downloads: sql<number>`count(distinct ${downloadEvents.sessionId})`,
        bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)`,
      })
      .from(downloadEvents)
      .innerJoin(games, eq(games.id, downloadEvents.gameId))
      .where(inRange)
      .groupBy(downloadEvents.gameId, games.title)
      .orderBy(sql`count(distinct ${downloadEvents.sessionId}) desc`)
      .limit(10)
      .all();

    const topGamesByPlaytime = this.db
      .select({
        gameId: userGameStats.gameId,
        title: games.title,
        seconds: sql<number>`coalesce(sum(${userGameStats.totalSeconds}), 0)`,
        players: sql<number>`count(distinct ${userGameStats.userId})`,
      })
      .from(userGameStats)
      .innerJoin(games, eq(games.id, userGameStats.gameId))
      .groupBy(userGameStats.gameId, games.title)
      .orderBy(sql`coalesce(sum(${userGameStats.totalSeconds}), 0) desc`)
      .limit(10)
      .all();

    const topUsers = this.db
      .select({
        userId: downloadEvents.userId,
        username: users.username,
        downloads: sql<number>`count(distinct ${downloadEvents.sessionId})`,
        bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)`,
      })
      .from(downloadEvents)
      .innerJoin(users, eq(users.id, downloadEvents.userId))
      .where(inRange)
      .groupBy(downloadEvents.userId, users.username)
      .orderBy(sql`coalesce(sum(${downloadEvents.bytesSent}), 0) desc`)
      .limit(10)
      .all();

    // One row per download rather than per file. A game arrives as dozens of
    // files and each writes its own event, so an ungrouped log showed the same
    // game over and over and buried everything else.
    const recentRows = this.db
      .select({
        id: downloadEvents.sessionId,
        at: sql<string>`min(${downloadEvents.startedAt})`,
        username: sql<string | null>`max(${users.username})`,
        title: sql<string | null>`max(${games.title})`,
        bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)`,
        files: sql<number>`count(*)`,
        finished: sql<number>`sum(case when ${downloadEvents.completed} then 1 else 0 end)`,
        client: sql<string>`max(${downloadEvents.client})`,
      })
      .from(downloadEvents)
      .leftJoin(users, eq(users.id, downloadEvents.userId))
      .leftJoin(games, eq(games.id, downloadEvents.gameId))
      .groupBy(downloadEvents.sessionId)
      .orderBy(sql`min(${downloadEvents.startedAt}) desc`)
      .limit(25)
      .all();

    const recentDownloads = recentRows.map((row) => ({
      id: row.id ?? '',
      at: row.at,
      username: row.username,
      title: row.title,
      bytes: Number(row.bytes),
      files: Number(row.files),
      // Complete only when every file in it finished; a download that stopped
      // halfway has completed files in it but is not itself complete.
      completed: Number(row.finished) === Number(row.files),
      client: row.client,
    }));

    return {
      rangeDays,
      since,
      summary: {
        downloads: Number(summaryRow?.downloads ?? 0),
        bytes: Number(summaryRow?.bytes ?? 0),
        completedDownloads: Number(summaryRow?.completed ?? 0),
        activeUsers: Number(summaryRow?.users ?? 0),
        playSeconds: Number(playRow?.seconds ?? 0),
        monthBytes: Number(monthRow?.bytes ?? 0),
        allTimeBytes: Number(allTimeRow?.bytes ?? 0),
      },
      daily: fillDailyGaps(dailyRows, rangeDays),
      monthly: monthlyRows.reverse().map((row) => ({
        month: row.month,
        bytes: Number(row.bytes),
        downloads: Number(row.downloads),
      })),
      topGamesByDownloads: topGamesByDownloads.map((row) => ({
        gameId: row.gameId ?? '',
        title: row.title,
        downloads: Number(row.downloads),
        bytes: Number(row.bytes),
      })),
      topGamesByPlaytime: topGamesByPlaytime.map((row) => ({
        gameId: row.gameId,
        title: row.title,
        seconds: Number(row.seconds),
        players: Number(row.players),
      })),
      topUsers: topUsers.map((row) => ({
        userId: row.userId ?? '',
        username: row.username,
        downloads: Number(row.downloads),
        bytes: Number(row.bytes),
      })),
      recentDownloads,
      quotas: this.quotaUsage(),
    };
  }

  /**
   * Month-to-date usage for every account that actually has an allowance.
   *
   * Two plain queries — usage grouped by user, then the accounts — rather than
   * a correlated subquery per row. The subquery this replaced silently
   * reported zero for everyone while enforcement, which reads the same table
   * through a normal query, saw the real figure; two ways of asking the same
   * question is exactly how that goes unnoticed.
   */
  /**
   * Month-to-date usage for every account that has an allowance.
   *
   * Public because the health page needs the same answer, and a second
   * implementation of it is how the two come to disagree — this one already
   * silently reported zero for everybody once.
   */
  quotaUsage(): AnalyticsReport['quotas'] {
    const monthStart = BandwidthService.periodStart();

    const usage = new Map(
      this.db
        .select({
          userId: downloadEvents.userId,
          bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)`,
        })
        .from(downloadEvents)
        .where(gte(downloadEvents.startedAt, monthStart))
        .groupBy(downloadEvents.userId)
        .all()
        .map((row) => [row.userId ?? '', Number(row.bytes)] as const),
    );

    return (
      this.db
        .select({ userId: users.id, username: users.username })
        .from(users)
        .where(eq(users.isActive, true))
        .all()
        .map((row) => ({
          userId: row.userId,
          username: row.username,
          usedBytes: usage.get(row.userId) ?? 0,
          quotaBytes: this.bandwidth.quotaBytesFor(row.userId),
        }))
        .filter((row) => row.quotaBytes > 0)
        // Closest to their limit first — that is who an operator needs to see.
        .sort((a, b) => b.usedBytes / b.quotaBytes - a.usedBytes / a.quotaBytes)
        .slice(0, 25)
    );
  }
}

/**
 * Fills in the days nothing was downloaded.
 *
 * A chart drawn straight from grouped rows silently omits quiet days, which
 * compresses the x-axis and makes a week of inactivity look like it never
 * happened.
 */
function fillDailyGaps(
  rows: Array<{ date: string; bytes: number; downloads: number }>,
  rangeDays: number,
): Array<{ date: string; bytes: number; downloads: number }> {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const out: Array<{ date: string; bytes: number; downloads: number }> = [];

  for (let offset = rangeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const row = byDate.get(date);
    out.push({
      date,
      bytes: Number(row?.bytes ?? 0),
      downloads: Number(row?.downloads ?? 0),
    });
  }
  return out;
}
