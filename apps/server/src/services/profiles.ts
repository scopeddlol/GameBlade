import type {
  FriendshipView,
  MemberQuery,
  Paginated,
  ProfileDetail,
  ProfileSummary,
  UpdateProfileInput,
} from '@gameblade/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { DiscordService } from './discord.js';
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
    /**
     * Only ever consulted for handles somebody chose to publish. Injected
     * rather than read from the table here so the default-off rule stays in
     * one method and cannot drift between call sites.
     */
    private readonly discord: DiscordService,
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
      pronouns: null,
      tagline: null,
      bannerPosition: 50,
      links: null,
      favoriteGameId: null,
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
  summarize(row: ProfileRow, options: { viewerId: string; areFriends: boolean }): ProfileSummary {
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

  /**
   * Adds each profile's Discord handle, for the ones who have chosen to show it.
   *
   * A single batched lookup rather than one inside `summarize`, which runs per
   * row on lists of hundreds. Every path that builds summaries goes through
   * here now — the toggle used to be honoured only by `summarizeMany`, so
   * turning "Show Discord on my profile" on changed the friends rail and
   * nothing else, including the profile page it names.
   */
  private withDiscordHandles<T extends ProfileSummary>(summaries: T[]): T[] {
    if (summaries.length === 0) return summaries;
    const handles = this.discord.visibleHandlesFor(summaries.map((entry) => entry.userId));
    return summaries.map((entry) => ({
      ...entry,
      discordUsername: handles.get(entry.userId) ?? null,
    }));
  }

  /** Batch variant that resolves friendship once for the whole set. */
  summarizeMany(userIds: string[], viewerId: string): Map<string, ProfileSummary> {
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
    const summaries = this.withDiscordHandles(
      rows.map((row) => this.summarize(row, { viewerId, areFriends: friends.has(row.userId) })),
    );

    return new Map(summaries.map((summary) => [summary.userId, summary]));
  }

  summarizeOne(userId: string, viewerId: string): ProfileSummary | null {
    return this.summarizeMany([userId], viewerId).get(userId) ?? null;
  }

  /**
   * The game somebody pinned to their profile.
   *
   * Nulls out silently for a game that has gone from the catalog: a pin is a
   * decoration, and a profile that will not load because a game was removed is
   * a far worse outcome than one that quietly stops showing it.
   */
  private favoriteGame(
    gameId: string | null,
  ): { id: string; title: string; coverUrl: string | null } | null {
    if (!gameId) return null;
    const row = this.db
      .select({ id: games.id, title: games.title, coverImageId: games.coverImageId })
      .from(games)
      .where(eq(games.id, gameId))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      coverUrl: row.coverImageId ? `${this.config.basePath}/api/images/${row.coverImageId}` : null,
    };
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

    // Through the decorator rather than `summarize` alone: this path built its
    // own summary and skipped the Discord lookup entirely, which is why turning
    // "Show Discord on my profile" on changed nothing on the profile page.
    const summary = this.withDiscordHandles([
      this.summarize(
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
      ),
    ])[0] as ProfileSummary;

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
      // Pronouns are how somebody wants to be addressed, which is the one
      // thing a stranger looking at a locked-down profile still needs — the
      // "add friend" screen names them. Withholding it would make a private
      // profile misgender its owner to everyone who visits.
      pronouns: row.profile.pronouns,
      tagline: canViewDetail ? row.profile.tagline : null,
      bannerPosition: row.profile.bannerPosition,
      links: canViewDetail ? (row.profile.links ?? []) : [],
      favoriteGame: canViewDetail ? this.favoriteGame(row.profile.favoriteGameId) : null,
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
    if (input.pronouns !== undefined) patch.pronouns = input.pronouns || null;
    if (input.tagline !== undefined) patch.tagline = input.tagline || null;
    if (input.bannerPosition !== undefined) patch.bannerPosition = input.bannerPosition;
    // An empty list is stored as null rather than `[]`, so "has no links" is
    // one state on the row instead of two that read the same.
    if (input.links !== undefined) {
      patch.links = input.links && input.links.length > 0 ? input.links : null;
    }
    if (input.favoriteGameId !== undefined) {
      // Checked rather than trusted: a game id that does not exist would fail
      // on the foreign key with an error nobody can act on, and one that has
      // since been removed should clear the pin rather than reject the save.
      patch.favoriteGameId = input.favoriteGameId
        ? (this.db
            .select({ id: games.id })
            .from(games)
            .where(eq(games.id, input.favoriteGameId))
            .get()?.id ?? null)
        : null;
    }

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
    const found = rows
      .filter((row) => row.userId !== viewerId)
      // A private account is unlisted: it can only be added by exact username.
      .filter(
        (row) =>
          row.visibility !== 'private' || row.username.toLowerCase() === term.trim().toLowerCase(),
      )
      .map((row) => this.summarize(row, { viewerId, areFriends: friends.has(row.userId) }));

    return this.withDiscordHandles(found);
  }

  /**
   * Every member on the server, for the browsable list rather than the
   * "add a friend" box. A private profile is unlisted here — it never shows
   * up unless the viewer already knows its exact username, which this does
   * not accept — so browsing never doubles as a way to find someone who
   * opted out of being found.
   */
  listMembers(viewerId: string, options: MemberQuery): Paginated<ProfileSummary> {
    const pattern = options.query ? `%${options.query.replace(/[%_]/g, '')}%` : null;
    const conditions = [eq(users.isActive, true), sql`${userProfiles.visibility} != 'private'`];
    if (pattern) {
      conditions.push(
        sql`(${users.username} LIKE ${pattern} OR ${userProfiles.displayName} LIKE ${pattern})`,
      );
    }
    const where = and(...conditions);

    const totalRow = this.db
      .select({ count: sql<number>`count(*)` })
      .from(userProfiles)
      .innerJoin(users, eq(users.id, userProfiles.userId))
      .where(where)
      .get();

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
      .where(where)
      .orderBy(userProfiles.displayName)
      .limit(options.limit)
      .offset(options.offset)
      .all();

    const friends = this.friendIds(viewerId);
    const items = this.withDiscordHandles(
      rows.map((row) => this.summarize(row, { viewerId, areFriends: friends.has(row.userId) })),
    );

    return { items, total: totalRow?.count ?? 0, offset: options.offset, limit: options.limit };
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
