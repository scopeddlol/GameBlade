import type { ActivityEntry, ActivityKind } from '@gameblade/shared';
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { achievements, activityEvents, games, posts } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { isoNow, isoSecondsAgo } from '../lib/time.js';
import type { ProfileService } from './profiles.js';
import type { RealtimeGateway } from './realtime.js';

export interface RecordActivity {
  userId: string;
  kind: ActivityKind;
  gameId?: string | null;
  achievementId?: string | null;
  postId?: string | null;
  seconds?: number | null;
}

/** Play sessions shorter than this are launch mistakes, not something to post. */
const MIN_PLAY_SECONDS_FOR_FEED = 120;

/** Window in which repeated play of the same game folds into one entry. */
const PLAY_DEDUPE_SECONDS = 6 * 60 * 60;

/**
 * Writes the append-only feed that Home and Social read.
 *
 * Deriving a feed on read would mean unioning play sessions, unlocks and posts
 * across every friend on every request. Writing one row at the moment something
 * happens turns that into a single indexed range scan.
 */
export class ActivityService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly profiles: ProfileService,
    private readonly realtime: RealtimeGateway,
  ) {}

  record(input: RecordActivity): void {
    if (input.kind === 'played') {
      const seconds = input.seconds ?? 0;
      if (seconds < MIN_PLAY_SECONDS_FOR_FEED) return;
      // Three sessions of the same game in an evening should read as one line,
      // so an existing recent entry absorbs the extra time instead.
      if (input.gameId && this.absorbRecentPlay(input.userId, input.gameId, seconds)) return;
    }

    const record = {
      id: newId('act'),
      userId: input.userId,
      kind: input.kind,
      gameId: input.gameId ?? null,
      achievementId: input.achievementId ?? null,
      postId: input.postId ?? null,
      seconds: input.seconds ?? null,
      createdAt: isoNow(),
    };
    this.db.insert(activityEvents).values(record).run();

    const friends = this.profiles.friendIds(input.userId);
    if (friends.size === 0) return;

    for (const friendId of friends) {
      const [entry] = this.hydrate([record], friendId);
      if (entry) this.realtime.send(friendId, { type: 'activity', entry });
    }
  }

  /**
   * @param scope `friends` is the default social view; `mine` backs a profile
   * page; `everyone` is the server-wide firehose, admin dashboards aside.
   */
  list(
    viewerId: string,
    options: {
      scope: 'friends' | 'mine' | 'everyone';
      before?: string;
      limit: number;
      userId?: string;
    },
  ): ActivityEntry[] {
    const conditions = [];

    if (options.userId) {
      conditions.push(eq(activityEvents.userId, options.userId));
    } else if (options.scope === 'mine') {
      conditions.push(eq(activityEvents.userId, viewerId));
    } else if (options.scope === 'friends') {
      const friends = [...this.profiles.friendIds(viewerId), viewerId];
      conditions.push(inArray(activityEvents.userId, friends));
    }

    if (options.before) conditions.push(lt(activityEvents.createdAt, options.before));

    const rows = this.db
      .select()
      .from(activityEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(activityEvents.createdAt))
      .limit(options.limit)
      .all();

    return this.hydrate(rows, viewerId);
  }

  /** Drops feed rows past the retention window so the table stays bounded. */
  prune(olderThanIso: string): void {
    this.db.delete(activityEvents).where(lt(activityEvents.createdAt, olderThanIso)).run();
  }

  /**
   * Resolve the referenced game, achievement and post for a batch of rows in
   * three queries rather than three per row.
   */
  private hydrate(
    rows: Array<{
      id: string;
      userId: string;
      kind: string;
      gameId: string | null;
      achievementId: string | null;
      postId: string | null;
      seconds: number | null;
      createdAt: string;
    }>,
    viewerId: string,
  ): ActivityEntry[] {
    if (rows.length === 0) return [];

    const profiles = this.profiles.summariseMany(
      rows.map((r) => r.userId),
      viewerId,
    );

    const gameIds = rows.map((r) => r.gameId).filter((id): id is string => Boolean(id));
    const gameRows =
      gameIds.length > 0
        ? this.db
            .select({ id: games.id, title: games.title, coverImageId: games.coverImageId })
            .from(games)
            .where(inArray(games.id, [...new Set(gameIds)]))
            .all()
        : [];
    const gameMap = new Map(gameRows.map((g) => [g.id, g]));

    const achievementIds = rows
      .map((r) => r.achievementId)
      .filter((id): id is string => Boolean(id));
    const achievementRows =
      achievementIds.length > 0
        ? this.db
            .select({ id: achievements.id, name: achievements.name, iconUrl: achievements.iconUrl })
            .from(achievements)
            .where(inArray(achievements.id, [...new Set(achievementIds)]))
            .all()
        : [];
    const achievementMap = new Map(achievementRows.map((a) => [a.id, a]));

    const postIds = rows.map((r) => r.postId).filter((id): id is string => Boolean(id));
    const postRows =
      postIds.length > 0
        ? this.db
            .select({ id: posts.id, title: posts.title, body: posts.body })
            .from(posts)
            .where(inArray(posts.id, [...new Set(postIds)]))
            .all()
        : [];
    const postMap = new Map(postRows.map((p) => [p.id, p]));

    const coverUrl = (id: string | null) =>
      id ? `${this.config.basePath}/api/images/${id}` : null;

    return rows.flatMap((row) => {
      const actor = profiles.get(row.userId);
      // A profile that vanished mid-page (deleted account) drops out rather
      // than rendering as a blank row.
      if (!actor) return [];

      const game = row.gameId ? gameMap.get(row.gameId) : undefined;
      const achievement = row.achievementId ? achievementMap.get(row.achievementId) : undefined;
      const post = row.postId ? postMap.get(row.postId) : undefined;

      return [
        {
          id: row.id,
          kind: row.kind as ActivityKind,
          actor,
          createdAt: row.createdAt,
          game: game
            ? { id: game.id, title: game.title, coverUrl: coverUrl(game.coverImageId) }
            : null,
          achievement: achievement
            ? { id: achievement.id, name: achievement.name, iconUrl: achievement.iconUrl }
            : null,
          post: post ? { id: post.id, title: post.title, excerpt: excerpt(post.body) } : null,
          seconds: row.seconds,
        },
      ];
    });
  }

  /** Adds time to a recent `played` row, returning true when one was found. */
  private absorbRecentPlay(userId: string, gameId: string, seconds: number): boolean {
    const existing = this.db
      .select({ id: activityEvents.id, seconds: activityEvents.seconds })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.userId, userId),
          eq(activityEvents.gameId, gameId),
          eq(activityEvents.kind, 'played'),
          gte(activityEvents.createdAt, isoSecondsAgo(PLAY_DEDUPE_SECONDS)),
        ),
      )
      .orderBy(desc(activityEvents.createdAt))
      .get();

    if (!existing) return false;

    this.db
      .update(activityEvents)
      .set({ seconds: (existing.seconds ?? 0) + seconds, createdAt: isoNow() })
      .where(eq(activityEvents.id, existing.id))
      .run();
    return true;
  }
}

function excerpt(body: string | null): string | null {
  if (!body) return null;
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}
