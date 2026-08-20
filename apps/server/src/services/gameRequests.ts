import {
  MAX_OPEN_REQUESTS_PER_USER,
  type CreateGameRequestInput,
  type DecideGameRequestInput,
  type GameRequestCounts,
  type GameRequestDigest,
  type CreatedGameRequest,
  type GameRequestInfo,
  type GameRequestQuery,
  type GameRequestStatus,
} from '@gameblade/shared';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameRequests, gameRequestVotes, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';

/** How many rows each digest panel carries. Small: this is a glance, not a list. */
const DIGEST_LIMIT = 6;

/**
 * Collapses a title to the key two people asking for the same game will share.
 *
 * Deliberately blunt — case, punctuation and spacing go, everything else stays.
 * Aggressive normalisation (dropping subtitles, edition names) would merge
 * "Halo" with "Halo Wars", and an operator can always merge two rows by hand
 * where this misses.
 */
export function requestKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

interface RequestRow {
  id: string;
  userId: string | null;
  title: string;
  note: string | null;
  status: GameRequestStatus;
  adminNote: string | null;
  gameId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  username: string | null;
}

/**
 * The request queue: what players want, and what the operator has said about it.
 *
 * Votes live in their own table rather than as a counter column so a player can
 * take one back, and so "has the caller voted" is answerable without a second
 * source of truth that can drift from the count.
 */
export class GameRequestService {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- writes */

  /**
   * Files a request, or backs an existing one for the same title.
   *
   * Two people asking for the same game is the common case, and it should
   * strengthen one row rather than produce two the operator has to reconcile.
   * A title that was previously denied comes back as pending: the second asker
   * has not seen that decision, and a request nobody can re-raise is a dead end.
   */
  create(userId: string, input: CreateGameRequestInput): CreatedGameRequest {
    const key = requestKey(input.title);
    if (key.length === 0) throw ApiError.badRequest('Name the game you want');

    const existing = this.db
      .select()
      .from(gameRequests)
      .where(eq(gameRequests.titleKey, key))
      .get();

    if (existing) {
      if (existing.status === 'denied') {
        this.db
          .update(gameRequests)
          .set({ status: 'pending', decidedAt: null, updatedAt: isoNow() })
          .where(eq(gameRequests.id, existing.id))
          .run();
      }
      this.vote(userId, existing.id, true);
      // Backing somebody else's row is a different outcome from filing a new
      // one, and the client says so rather than pretending the ask was new.
      return { ...this.get(existing.id, userId, false), created: false };
    }

    const open = this.db
      .select({ count: sql<number>`count(*)` })
      .from(gameRequests)
      .where(and(eq(gameRequests.userId, userId), eq(gameRequests.status, 'pending')))
      .get();

    if (Number(open?.count ?? 0) >= MAX_OPEN_REQUESTS_PER_USER) {
      throw ApiError.badRequest(
        `You already have ${MAX_OPEN_REQUESTS_PER_USER} requests waiting. Wait for one to be answered before adding another.`,
      );
    }

    const now = isoNow();
    const id = newId('req');
    this.db
      .insert(gameRequests)
      .values({
        id,
        userId,
        title: input.title,
        titleKey: key,
        note: input.note ?? null,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // The requester counts as a backer, so "votes" is one number rather than
    // "one, plus everyone who agreed".
    this.vote(userId, id, true);
    return { ...this.get(id, userId, false), created: true };
  }

  /** Adds or removes the caller's backing. Returns the new vote count. */
  vote(userId: string, requestId: string, wanted: boolean): number {
    const request = this.db
      .select({ id: gameRequests.id })
      .from(gameRequests)
      .where(eq(gameRequests.id, requestId))
      .get();
    if (!request) throw ApiError.notFound('That request no longer exists');

    if (wanted) {
      this.db
        .insert(gameRequestVotes)
        .values({ requestId, userId, createdAt: isoNow() })
        .onConflictDoNothing()
        .run();
    } else {
      this.db
        .delete(gameRequestVotes)
        .where(and(eq(gameRequestVotes.requestId, requestId), eq(gameRequestVotes.userId, userId)))
        .run();
    }

    return this.voteCounts([requestId]).get(requestId) ?? 0;
  }

  /** An operator's decision. */
  decide(adminId: string, requestId: string, input: DecideGameRequestInput): GameRequestInfo {
    const existing = this.db
      .select({ id: gameRequests.id })
      .from(gameRequests)
      .where(eq(gameRequests.id, requestId))
      .get();
    if (!existing) throw ApiError.notFound('That request no longer exists');

    const now = isoNow();
    this.db
      .update(gameRequests)
      .set({
        status: input.status,
        adminNote: input.adminNote ?? null,
        gameId: input.gameId ?? null,
        decidedBy: adminId,
        // Moving a row back to the inbox is not a decision, so it clears the
        // timestamp rather than stamping "decided: pending".
        decidedAt: input.status === 'pending' ? null : now,
        updatedAt: now,
      })
      .where(eq(gameRequests.id, requestId))
      .run();

    return this.get(requestId, adminId, true);
  }

  remove(requestId: string): void {
    this.db.delete(gameRequests).where(eq(gameRequests.id, requestId)).run();
  }

  /* ----------------------------------------------------------------- reads */

  get(id: string, viewerId: string, includeRequester: boolean): GameRequestInfo {
    const row = this.selectBase().where(eq(gameRequests.id, id)).get();
    if (!row) throw ApiError.notFound('That request no longer exists');
    return this.decorate([row as RequestRow], viewerId, includeRequester)[0] as GameRequestInfo;
  }

  list(query: GameRequestQuery, viewerId: string, includeRequester: boolean): GameRequestInfo[] {
    const conditions = [];
    if (query.status) conditions.push(eq(gameRequests.status, query.status));
    if (query.search) {
      conditions.push(like(gameRequests.titleKey, `%${requestKey(query.search)}%`));
    }

    const rows = this.selectBase()
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      // Newest-first is the tiebreak for `votes` too, which is re-sorted in
      // memory below once the counts are known.
      .orderBy(query.sort === 'title' ? gameRequests.title : desc(gameRequests.createdAt))
      .limit(query.limit)
      .offset(query.offset)
      .all() as RequestRow[];

    const decorated = this.decorate(rows, viewerId, includeRequester);
    // Vote counts come from a second query, so ordering by them has to happen
    // here rather than in SQL. The page size is capped at 200, so this is a
    // sort of a small array rather than of the table.
    if (query.sort === 'votes') {
      decorated.sort((a, b) => b.votes - a.votes || b.createdAt.localeCompare(a.createdAt));
    }
    return decorated;
  }

  counts(): GameRequestCounts {
    const rows = this.db
      .select({ status: gameRequests.status, count: sql<number>`count(*)` })
      .from(gameRequests)
      .groupBy(gameRequests.status)
      .all();

    const counts: GameRequestCounts = { pending: 0, 'coming-soon': 0, added: 0, denied: 0 };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /**
   * The panels the desktop client shows.
   *
   * One method rather than four endpoints: the client draws all of it on the
   * Home tab at once, and every panel comes out of the same two tables.
   *
   * Each panel is its own bounded query rather than one pass over the whole
   * table sorted in memory. `/home` is the client's cold-start request and is
   * re-read every half minute it stays open, so a queue that has accumulated a
   * few thousand rows must not turn it into a full scan plus two more queries
   * over every id.
   */
  digest(viewerId: string): GameRequestDigest {
    // Ranking by votes has to happen in SQL for the limit to mean anything,
    // so this panel joins the counts in rather than reading them afterwards.
    const mostRequested = this.selectBase()
      .leftJoin(gameRequestVotes, eq(gameRequestVotes.requestId, gameRequests.id))
      .where(eq(gameRequests.status, 'pending'))
      .groupBy(gameRequests.id)
      .orderBy(desc(sql`count(${gameRequestVotes.userId})`), desc(gameRequests.createdAt))
      .limit(DIGEST_LIMIT)
      .all() as RequestRow[];

    const comingSoon = this.selectBase()
      .where(eq(gameRequests.status, 'coming-soon'))
      .orderBy(desc(gameRequests.updatedAt))
      .limit(DIGEST_LIMIT)
      .all() as RequestRow[];

    const recentlyAdded = this.selectBase()
      .where(eq(gameRequests.status, 'added'))
      .orderBy(desc(gameRequests.decidedAt))
      .limit(DIGEST_LIMIT)
      .all() as RequestRow[];

    const yours = this.selectBase()
      .innerJoin(gameRequestVotes, eq(gameRequestVotes.requestId, gameRequests.id))
      .where(eq(gameRequestVotes.userId, viewerId))
      .orderBy(desc(gameRequests.updatedAt))
      .limit(DIGEST_LIMIT)
      .all() as RequestRow[];

    // Decorated in one pass over the union, so the vote counts and the
    // caller's own votes are still two queries in total rather than eight.
    const seen = new Map<string, GameRequestInfo>();
    for (const entry of this.decorate(
      [...mostRequested, ...comingSoon, ...recentlyAdded, ...yours],
      viewerId,
      false,
    )) {
      seen.set(entry.id, entry);
    }
    const take = (rows: RequestRow[]) =>
      rows.flatMap((row) => {
        const entry = seen.get(row.id);
        return entry ? [entry] : [];
      });

    return {
      comingSoon: take(comingSoon),
      mostRequested: take(mostRequested),
      recentlyAdded: take(recentlyAdded),
      yours: take(yours),
      counts: this.counts(),
    };
  }

  /* --------------------------------------------------------------- helpers */

  private selectBase() {
    return this.db
      .select({
        id: gameRequests.id,
        userId: gameRequests.userId,
        title: gameRequests.title,
        note: gameRequests.note,
        status: gameRequests.status,
        adminNote: gameRequests.adminNote,
        gameId: gameRequests.gameId,
        decidedAt: gameRequests.decidedAt,
        createdAt: gameRequests.createdAt,
        updatedAt: gameRequests.updatedAt,
        username: users.username,
      })
      .from(gameRequests)
      .leftJoin(users, eq(users.id, gameRequests.userId));
  }

  /** Vote totals for a set of requests, in one grouped pass. */
  private voteCounts(ids: string[]): Map<string, number> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .select({ requestId: gameRequestVotes.requestId, count: sql<number>`count(*)` })
      .from(gameRequestVotes)
      .where(inArray(gameRequestVotes.requestId, ids))
      .groupBy(gameRequestVotes.requestId)
      .all();
    return new Map(rows.map((row) => [row.requestId, Number(row.count)]));
  }

  private decorate(
    rows: RequestRow[],
    viewerId: string,
    includeRequester: boolean,
  ): GameRequestInfo[] {
    const ids = rows.map((row) => row.id);
    const counts = this.voteCounts(ids);

    const mine =
      ids.length === 0
        ? new Set<string>()
        : new Set(
            this.db
              .select({ requestId: gameRequestVotes.requestId })
              .from(gameRequestVotes)
              .where(
                and(
                  eq(gameRequestVotes.userId, viewerId),
                  inArray(gameRequestVotes.requestId, ids),
                ),
              )
              .all()
              .map((row) => row.requestId),
          );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      note: row.note,
      status: row.status,
      votes: counts.get(row.id) ?? 0,
      hasVoted: mine.has(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      adminNote: row.adminNote,
      // Who asked is admin-only: a wish list should not become a public record
      // of who wants what.
      requestedBy:
        includeRequester && row.userId ? { id: row.userId, username: row.username ?? '—' } : null,
      decidedAt: row.decidedAt,
      gameId: row.gameId,
    }));
  }
}
