import type { PlaySessionInfo, PlaytimeEntry } from '@gameblade/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { games, playSessions, userGameStats, userLibrary } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow, secondsBetween } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import type { PresenceService } from './presence.js';

/**
 * A session left open past this is assumed to be a client that crashed or lost
 * power. It is closed at its last known length rather than being credited with
 * however long the process has been dead.
 */
const ABANDONED_SESSION_HOURS = 12;

export class PlaytimeService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly presence: PresenceService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Opens a session and marks the user in-game. Any session still open for this
   * user is closed first — one person cannot be playing two things at once, and
   * leaving strays open would double-count the next close.
   */
  start(userId: string, gameId: string, deviceId: string | null): PlaySessionInfo {
    const game = this.db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get();
    if (!game) throw ApiError.notFound('Game not found');

    this.closeOpenSessions(userId);

    const record = {
      id: newId('ply'),
      userId,
      gameId,
      deviceId,
      startedAt: isoNow(),
      endedAt: null,
      seconds: 0,
    };
    this.db.insert(playSessions).values(record).run();

    // Launching implies ownership; adding it here means a game handed over by a
    // friend still lands in the library without a separate call.
    this.db
      .insert(userLibrary)
      .values({ userId, gameId, addedAt: isoNow() })
      .onConflictDoNothing()
      .run();

    this.db
      .insert(userGameStats)
      .values({ userId, gameId, totalSeconds: 0, launchCount: 1, lastPlayedAt: isoNow() })
      .onConflictDoUpdate({
        target: [userGameStats.userId, userGameStats.gameId],
        set: {
          launchCount: sql`${userGameStats.launchCount} + 1`,
          lastPlayedAt: isoNow(),
        },
      })
      .run();

    this.presence.update(userId, 'in-game', gameId);

    return {
      id: record.id,
      gameId,
      startedAt: record.startedAt,
      endedAt: null,
      seconds: 0,
    };
  }

  /**
   * Closes a session and folds its duration into the rolling totals.
   *
   * The client reports how long the game ran, but that number is clamped to the
   * wall-clock time since the session opened: a client with a wrong clock, or a
   * modified one, must not be able to inflate a playtime leaderboard.
   */
  end(userId: string, sessionId: string, reportedSeconds: number): PlaySessionInfo {
    const session = this.db
      .select()
      .from(playSessions)
      .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
      .get();

    if (!session) throw ApiError.notFound('That play session does not exist');
    if (session.endedAt) {
      return {
        id: session.id,
        gameId: session.gameId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        seconds: session.seconds,
      };
    }

    const endedAt = isoNow();
    const elapsed = secondsBetween(session.startedAt, endedAt);
    const seconds = Math.max(0, Math.min(reportedSeconds, elapsed));

    this.db
      .update(playSessions)
      .set({ endedAt, seconds })
      .where(eq(playSessions.id, sessionId))
      .run();

    this.applySeconds(userId, session.gameId, seconds, endedAt);
    this.presence.update(userId, 'online', null);
    this.activity.record({ userId, kind: 'played', gameId: session.gameId, seconds });

    return {
      id: session.id,
      gameId: session.gameId,
      startedAt: session.startedAt,
      endedAt,
      seconds,
    };
  }

  /**
   * Periodic keep-alive from a running game. It both refreshes presence and
   * banks the time so far, so a client that dies mid-session still keeps most
   * of its playtime.
   */
  heartbeat(userId: string, sessionId: string, secondsSoFar: number): void {
    const session = this.db
      .select()
      .from(playSessions)
      .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
      .get();
    if (!session || session.endedAt) return;

    const elapsed = secondsBetween(session.startedAt, isoNow());
    const seconds = Math.max(0, Math.min(secondsSoFar, elapsed));
    const delta = seconds - session.seconds;
    if (delta <= 0) {
      this.presence.update(userId, 'in-game', session.gameId);
      return;
    }

    this.db.update(playSessions).set({ seconds }).where(eq(playSessions.id, sessionId)).run();
    this.applySeconds(userId, session.gameId, delta, isoNow());
    this.presence.update(userId, 'in-game', session.gameId);
  }

  openSession(userId: string): PlaySessionInfo | null {
    const row = this.db
      .select()
      .from(playSessions)
      .where(and(eq(playSessions.userId, userId), isNull(playSessions.endedAt)))
      .orderBy(desc(playSessions.startedAt))
      .get();

    if (!row) return null;
    return {
      id: row.id,
      gameId: row.gameId,
      startedAt: row.startedAt,
      endedAt: null,
      seconds: row.seconds,
    };
  }

  /** Most-played games, backing the profile page and the Library sort. */
  top(userId: string, limit: number): PlaytimeEntry[] {
    const rows = this.db
      .select({
        gameId: userGameStats.gameId,
        title: games.title,
        coverImageId: games.coverImageId,
        totalSeconds: userGameStats.totalSeconds,
        lastPlayedAt: userGameStats.lastPlayedAt,
        launchCount: userGameStats.launchCount,
      })
      .from(userGameStats)
      .innerJoin(games, eq(games.id, userGameStats.gameId))
      .where(eq(userGameStats.userId, userId))
      .orderBy(desc(userGameStats.totalSeconds))
      .limit(limit)
      .all();

    return rows.map((row) => ({
      game: {
        id: row.gameId,
        title: row.title,
        coverUrl: row.coverImageId
          ? `${this.config.basePath}/api/images/${row.coverImageId}`
          : null,
      },
      totalSeconds: row.totalSeconds,
      lastPlayedAt: row.lastPlayedAt,
      launchCount: row.launchCount,
    }));
  }

  /** Per-game totals for a set of games, used to decorate listings. */
  statsFor(userId: string, gameIds: string[]): Map<string, { seconds: number; last: string | null }> {
    if (gameIds.length === 0) return new Map();
    const rows = this.db
      .select()
      .from(userGameStats)
      .where(eq(userGameStats.userId, userId))
      .all();
    const wanted = new Set(gameIds);
    return new Map(
      rows
        .filter((r) => wanted.has(r.gameId))
        .map((r) => [r.gameId, { seconds: r.totalSeconds, last: r.lastPlayedAt }]),
    );
  }

  /** Total hours played across the whole server, for the Home stat strip. */
  totalHours(): number {
    const row = this.db
      .select({ total: sql<number>`coalesce(sum(${userGameStats.totalSeconds}), 0)` })
      .from(userGameStats)
      .get();
    return Math.round((row?.total ?? 0) / 3600);
  }

  /**
   * Closes sessions abandoned by a crashed client. Run on a timer so a machine
   * that never came back does not leave its owner permanently "in-game".
   */
  closeAbandoned(): number {
    const cutoff = new Date(Date.now() - ABANDONED_SESSION_HOURS * 3_600_000).toISOString();
    const stale = this.db
      .select()
      .from(playSessions)
      .where(and(isNull(playSessions.endedAt), sql`${playSessions.startedAt} < ${cutoff}`))
      .all();

    for (const session of stale) {
      this.db
        .update(playSessions)
        .set({ endedAt: isoNow(), seconds: session.seconds })
        .where(eq(playSessions.id, session.id))
        .run();
    }
    return stale.length;
  }

  private closeOpenSessions(userId: string): void {
    const open = this.db
      .select()
      .from(playSessions)
      .where(and(eq(playSessions.userId, userId), isNull(playSessions.endedAt)))
      .all();

    for (const session of open) {
      // Whatever the heartbeat last banked is all this session gets credited.
      this.db
        .update(playSessions)
        .set({ endedAt: isoNow(), seconds: session.seconds })
        .where(eq(playSessions.id, session.id))
        .run();
    }
  }

  private applySeconds(userId: string, gameId: string, seconds: number, at: string): void {
    if (seconds <= 0) return;
    this.db
      .insert(userGameStats)
      .values({ userId, gameId, totalSeconds: seconds, launchCount: 0, lastPlayedAt: at })
      .onConflictDoUpdate({
        target: [userGameStats.userId, userGameStats.gameId],
        set: {
          totalSeconds: sql`${userGameStats.totalSeconds} + ${seconds}`,
          lastPlayedAt: at,
        },
      })
      .run();
  }
}
