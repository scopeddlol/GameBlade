import type {
  FriendshipView,
  ProfileDetail,
  ProfileSummary,
  UpdateProfileInput,
} from '@gameblade/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  friendships,
  games,
  posts,
  userGameStats,
  userLibrary,
  userProfiles,
  users,
  type UserProfile,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import type { PresenceService } from './presence.js';

/** Columns every summary needs, joined once rather than per row. */
interface ProfileRow {
  userId: string;
  username: string;
  displayName: string;
  avatarMediaId: string | null;
  accentColor: string;
  visibility: UserProfile['visibility'];
  showActivity: boolean;
}

export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly presence: PresenceService,
  ) {}

  /** Created with the account so no code path has to handle a missing profile. */
  ensure(userId: string, username: string): UserProfile {
    const existing = this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .get();
    if (existing) return existing;

    const record = {
      userId,
      displayName: username,
      bio: null,
      accentColor: '#7c5cff',
      country: null,
      avatarMediaId: null,
      bannerMediaId: null,
      visibility: 'friends' as const,
      showActivity: true,
      lastSeenAt: null,
      updatedAt: isoNow(),
    };
    this.db.insert(userProfiles).values(record).onConflictDoNothing().run();
    return record;
  }

  mediaUrl(mediaId: string | null): string | null {
    return mediaId ? `${this.config.basePath}/api/media/${mediaId}` : null;
  }

  /**
   * Build the compact profile shown on tiles, feed rows and friend lists.
   * `viewerId` decides whether live game activity is included: a profile set to
   * hide activity, or one whose visibility excludes the viewer, reports presence
   * but never what is being played.
   */
  summarise(row: ProfileRow, options: { viewerId: string; areFriends: boolean }): ProfileSummary {
    const state = this.presence.get(row.userId);
    const maySeeActivity =
      row.showActivity &&
      (row.userId === options.viewerId ||
        row.visibility === 'public' ||
        (row.visibility === 'friends' && options.areFriends));

    const playing = state.status === 'in-game' && state.gameId && maySeeActivity;
    const title = playing ? this.gameTitle(state.gameId as string) : null;

    return {
      userId: row.userId,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: this.mediaUrl(row.avatarMediaId),
      accentColor: row.accentColor,
      // Someone in a game they will not disclose still reads as online.
      presence: playing ? 'in-game' : state.status === 'in-game' ? 'online' : state.status,
      playingGameId: playing ? state.gameId : null,
      playingGameTitle: title,
      playingSince: playing ? state.since : null,
    };
  }

  /** Batch variant that resolves friendship once for the whole set. */
  summariseMany(userIds: string[], viewerId: string): Map<string, ProfileSummary> {
    const unique = [...new Set(userIds)].filter(Boolean);
    if (unique.length === 0) return new Map();

    const rows = this.db
      .select({
        userId: userProfiles.userId,
        username: users.username,
        displayName: userProfiles.displayName,
        avatarMediaId: userProfiles.avatarMediaId,
        accentColor: userProfiles.accentColor,
        visibility: userProfiles.visibility,
        showActivity: userProfiles.showActivity,
      })
      .from(userProfiles)
      .innerJoin(users, eq(users.id, userProfiles.userId))
      .where(inArray(userProfiles.userId, unique))
      .all();

    const friends = this.friendIds(viewerId);
    return new Map(
      rows.map((row) => [
        row.userId,
        this.summarise(row, { viewerId, areFriends: friends.has(row.userId) }),
      ]),
    );
  }

  summariseOne(userId: string, viewerId: string): ProfileSummary | null {
    return this.summariseMany([userId], viewerId).get(userId) ?? null;
  }

  /** Accepted friends of a user, as a set for cheap membership tests. */
  friendIds(userId: string): Set<string> {
    const rows = this.db
      .select({ a: friendships.userAId, b: friendships.userBId })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'accepted'),
          or(eq(friendships.userAId, userId), eq(friendships.userBId, userId)),
        ),
      )
      .all();
    return new Set(rows.map((r) => (r.a === userId ? r.b : r.a)));
  }

  detail(userId: string, viewerId: string): ProfileDetail {
    const row = this.db
      .select({
        profile: userProfiles,
        username: users.username,
        createdAt: users.createdAt,
      })
      .from(userProfiles)
      .innerJoin(users, eq(users.id, userProfiles.userId))
      .where(eq(userProfiles.userId, userId))
      .get();

    if (!row) throw ApiError.notFound('That profile does not exist');

    const isSelf = userId === viewerId;
    const friendship = isSelf ? null : this.friendshipView(viewerId, userId);
    const areFriends = friendship?.status === 'accepted';

    const summary = this.summarise(
      {
        userId,
        username: row.username,
        displayName: row.profile.displayName,
        avatarMediaId: row.profile.avatarMediaId,
        accentColor: row.profile.accentColor,
        visibility: row.profile.visibility,
        showActivity: row.profile.showActivity,
      },
      { viewerId, areFriends },
    );

    const canViewDetail =
      isSelf ||
      row.profile.visibility === 'public' ||
      (row.profile.visibility === 'friends' && areFriends);

    // A private profile still resolves — the client needs a name to render the
    // "add friend" screen — but every statistic is withheld rather than faked.
    const stats = canViewDetail
      ? this.stats(userId)
      : {
          gameCount: 0,
          totalPlaySeconds: 0,
          achievementCount: 0,
          postCount: 0,
          friendCount: 0,
        };

    return {
      ...summary,
      bio: canViewDetail ? row.profile.bio : null,
      bannerUrl: canViewDetail ? this.mediaUrl(row.profile.bannerMediaId) : null,
      country: canViewDetail ? row.profile.country : null,
      visibility: row.profile.visibility,
      showActivity: row.profile.showActivity,
      createdAt: row.createdAt,
      lastSeenAt: this.presence.isOnline(userId) ? isoNow() : row.profile.lastSeenAt,
      ...stats,
      friendship,
      isSelf,
      canViewDetail,
    };
  }

  update(userId: string, input: UpdateProfileInput): UserProfile {
    const patch: Partial<UserProfile> = { updatedAt: isoNow() };

    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.bio !== undefined) patch.bio = input.bio;
    if (input.accentColor !== undefined) patch.accentColor = input.accentColor;
    if (input.country !== undefined) patch.country = input.country?.toUpperCase() ?? null;
    if (input.visibility !== undefined) patch.visibility = input.visibility;
    if (input.showActivity !== undefined) patch.showActivity = input.showActivity;
    if (input.avatarMediaId !== undefined) patch.avatarMediaId = input.avatarMediaId;
    if (input.bannerMediaId !== undefined) patch.bannerMediaId = input.bannerMediaId;

    this.db.update(userProfiles).set(patch).where(eq(userProfiles.userId, userId)).run();

    const updated = this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .get();
    if (!updated) throw ApiError.notFound('That profile does not exist');
    return updated;
  }

  /** Flushed on disconnect so "last seen" survives a restart. */
  touchLastSeen(userId: string): void {
    this.db
      .update(userProfiles)
      .set({ lastSeenAt: isoNow() })
      .where(eq(userProfiles.userId, userId))
      .run();
  }

  /** Name and username search backing the "add a friend" box. */
  search(term: string, viewerId: string, limit: number): ProfileSummary[] {
    const pattern = `%${term.replace(/[%_]/g, '')}%`;
    const rows = this.db
      .select({
        userId: userProfiles.userId,
        username: users.username,
        displayName: userProfiles.displayName,
        avatarMediaId: userProfiles.avatarMediaId,
        accentColor: userProfiles.accentColor,
        visibility: userProfiles.visibility,
        showActivity: userProfiles.showActivity,
      })
      .from(userProfiles)
      .innerJoin(users, eq(users.id, userProfiles.userId))
      .where(
        and(
          eq(users.isActive, true),
          sql`(${users.username} LIKE ${pattern} OR ${userProfiles.displayName} LIKE ${pattern})`,
        ),
      )
      .limit(limit)
      .all();

    const friends = this.friendIds(viewerId);
    return rows
      .filter((row) => row.userId !== viewerId)
      // A private account is unlisted: it can only be added by exact username.
      .filter(
        (row) =>
          row.visibility !== 'private' ||
          row.username.toLowerCase() === term.trim().toLowerCase(),
      )
      .map((row) => this.summarise(row, { viewerId, areFriends: friends.has(row.userId) }));
  }

  private friendshipView(viewerId: string, otherId: string): FriendshipView | null {
    const [a, b] = viewerId < otherId ? [viewerId, otherId] : [otherId, viewerId];
    const row = this.db
      .select()
      .from(friendships)
      .where(and(eq(friendships.userAId, a), eq(friendships.userBId, b)))
      .get();

    if (!row) return null;
    return {
      status: row.status,
      outgoing: row.requestedBy === viewerId,
      since: row.respondedAt ?? row.createdAt,
    };
  }

  private stats(userId: string) {
    const library = this.db
      .select({ count: sql<number>`count(*)` })
      .from(userLibrary)
      .where(eq(userLibrary.userId, userId))
      .get();

    const play = this.db
      .select({ total: sql<number>`coalesce(sum(${userGameStats.totalSeconds}), 0)` })
      .from(userGameStats)
      .where(eq(userGameStats.userId, userId))
      .get();

    const achievements = this.db
      .select({ count: sql<number>`count(*)` })
      .from(sql`user_achievements`)
      .where(sql`user_id = ${userId} AND unlocked_at IS NOT NULL`)
      .get() as { count: number } | undefined;

    const postCount = this.db
      .select({ count: sql<number>`count(*)` })
      .from(posts)
      .where(eq(posts.authorId, userId))
      .get();

    return {
      gameCount: library?.count ?? 0,
      totalPlaySeconds: play?.total ?? 0,
      achievementCount: achievements?.count ?? 0,
      postCount: postCount?.count ?? 0,
      friendCount: this.friendIds(userId).size,
    };
  }

  private gameTitle(gameId: string): string | null {
    const row = this.db
      .select({ title: games.title })
      .from(games)
      .where(eq(games.id, gameId))
      .get();
    return row?.title ?? null;
  }
}
