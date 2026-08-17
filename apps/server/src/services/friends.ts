import type { FriendEntry, FriendRequests, ProfileSummary } from '@gameblade/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { friendships, userLibrary, userProfiles, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import type { NotificationService } from './notifications.js';
import type { ProfileService } from './profiles.js';
import type { RealtimeGateway } from './realtime.js';

/** Ceiling on accepted friends, so a runaway script cannot bloat a feed query. */
const MAX_FRIENDS = 1000;

/**
 * A friendship is one row for a pair of accounts, stored with the lower id
 * first. That canonical ordering is what lets a unique index reject the classic
 * race where two people send each other a request at the same moment.
 */
function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export class FriendService {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileService,
    private readonly notifications: NotificationService,
    private readonly activity: ActivityService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Sends a request, or accepts one the other side already sent. */
  request(requesterId: string, targetId: string): { status: 'pending' | 'accepted' } {
    if (requesterId === targetId) {
      throw ApiError.badRequest('You cannot add yourself');
    }

    const target = this.db
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, targetId))
      .get();
    if (!target || !target.isActive) throw ApiError.notFound('That account does not exist');

    if (this.profiles.friendIds(requesterId).size >= MAX_FRIENDS) {
      throw ApiError.badRequest('You have reached the friend limit');
    }

    const [userAId, userBId] = pair(requesterId, targetId);
    const existing = this.db
      .select()
      .from(friendships)
      .where(and(eq(friendships.userAId, userAId), eq(friendships.userBId, userBId)))
      .get();

    if (existing) {
      if (existing.status === 'blocked') {
        // Never disclose that a block exists — it reads as an ordinary failure.
        throw ApiError.forbidden('That request could not be sent');
      }
      if (existing.status === 'accepted') {
        return { status: 'accepted' };
      }
      if (existing.requestedBy === requesterId) {
        return { status: 'pending' };
      }
      // They asked first, so this is really an acceptance.
      this.accept(requesterId, targetId);
      return { status: 'accepted' };
    }

    this.db
      .insert(friendships)
      .values({
        id: newId('frn'),
        userAId,
        userBId,
        requestedBy: requesterId,
        status: 'pending',
        createdAt: isoNow(),
        respondedAt: null,
      })
      .run();

    const requester = this.profiles.summariseOne(requesterId, targetId);
    if (requester) {
      this.realtime.send(targetId, { type: 'friend-request', profile: requester });
      this.notifications.create({
        userId: targetId,
        kind: 'friend-request',
        actorId: requesterId,
        title: `${requester.displayName} sent you a friend request`,
        link: `profile/${requesterId}`,
      });
    }

    return { status: 'pending' };
  }

  accept(userId: string, requesterId: string): void {
    const [userAId, userBId] = pair(userId, requesterId);
    const existing = this.db
      .select()
      .from(friendships)
      .where(and(eq(friendships.userAId, userAId), eq(friendships.userBId, userBId)))
      .get();

    if (!existing || existing.status !== 'pending') {
      throw ApiError.notFound('There is no pending request from that account');
    }
    if (existing.requestedBy === userId) {
      throw ApiError.badRequest('You cannot accept your own request');
    }

    this.db
      .update(friendships)
      .set({ status: 'accepted', respondedAt: isoNow() })
      .where(eq(friendships.id, existing.id))
      .run();

    const accepter = this.profiles.summariseOne(userId, requesterId);
    if (accepter) {
      this.notifications.create({
        userId: requesterId,
        kind: 'friend-accepted',
        actorId: userId,
        title: `${accepter.displayName} accepted your friend request`,
        link: `profile/${userId}`,
      });
    }

    this.activity.record({ userId, kind: 'friended' });

    // Both sides should immediately see the other's live presence rather than
    // waiting for the next status change to route to them.
    for (const [viewer, subject] of [
      [userId, requesterId],
      [requesterId, userId],
    ] as const) {
      const profile = this.profiles.summariseOne(subject, viewer);
      if (profile) this.realtime.send(viewer, { type: 'presence', profile });
    }
  }

  /** Declines a pending request or removes an existing friend. */
  remove(userId: string, otherId: string): void {
    const [userAId, userBId] = pair(userId, otherId);
    this.db
      .delete(friendships)
      .where(
        and(
          eq(friendships.userAId, userAId),
          eq(friendships.userBId, userBId),
          // A block is cleared through `unblock`, never by removing a friend.
          sql`${friendships.status} != 'blocked'`,
        ),
      )
      .run();
  }

  block(userId: string, otherId: string): void {
    if (userId === otherId) throw ApiError.badRequest('You cannot block yourself');

    const [userAId, userBId] = pair(userId, otherId);
    this.db
      .insert(friendships)
      .values({
        id: newId('frn'),
        userAId,
        userBId,
        requestedBy: userId,
        status: 'blocked',
        createdAt: isoNow(),
        respondedAt: isoNow(),
      })
      .onConflictDoUpdate({
        target: [friendships.userAId, friendships.userBId],
        set: { status: 'blocked', requestedBy: userId, respondedAt: isoNow() },
      })
      .run();
  }

  unblock(userId: string, otherId: string): void {
    const [userAId, userBId] = pair(userId, otherId);
    this.db
      .delete(friendships)
      .where(
        and(
          eq(friendships.userAId, userAId),
          eq(friendships.userBId, userBId),
          eq(friendships.status, 'blocked'),
          // Only whoever placed the block may lift it.
          eq(friendships.requestedBy, userId),
        ),
      )
      .run();
  }

  list(userId: string): FriendEntry[] {
    const rows = this.db
      .select({
        id: friendships.id,
        a: friendships.userAId,
        b: friendships.userBId,
        since: friendships.respondedAt,
        createdAt: friendships.createdAt,
      })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'accepted'),
          or(eq(friendships.userAId, userId), eq(friendships.userBId, userId)),
        ),
      )
      .all();

    const friendIds = rows.map((r) => (r.a === userId ? r.b : r.a));
    const profiles = this.profiles.summariseMany(friendIds, userId);
    const shared = this.sharedGameCounts(userId, friendIds);

    return rows
      .flatMap((row) => {
        const friendId = row.a === userId ? row.b : row.a;
        const profile = profiles.get(friendId);
        if (!profile) return [];
        return [
          {
            profile,
            friendsSince: row.since ?? row.createdAt,
            sharedGameCount: shared.get(friendId) ?? 0,
          },
        ];
      })
      // Online first, then in-game, then alphabetical — the order a player
      // actually scans the list in.
      .sort((x, y) => {
        const rank = (entry: FriendEntry) =>
          entry.profile.presence === 'in-game' ? 0 : entry.profile.presence === 'online' ? 1 : 2;
        return (
          rank(x) - rank(y) || x.profile.displayName.localeCompare(y.profile.displayName)
        );
      });
  }

  requests(userId: string): FriendRequests {
    const rows = this.db
      .select()
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'pending'),
          or(eq(friendships.userAId, userId), eq(friendships.userBId, userId)),
        ),
      )
      .all();

    const otherIds = rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId));
    const profiles = this.profiles.summariseMany(otherIds, userId);

    const incoming: FriendRequests['incoming'] = [];
    const outgoing: FriendRequests['outgoing'] = [];

    for (const row of rows) {
      const otherId = row.userAId === userId ? row.userBId : row.userAId;
      const profile = profiles.get(otherId);
      if (!profile) continue;
      const entry = { profile, requestedAt: row.createdAt };
      if (row.requestedBy === userId) outgoing.push(entry);
      else incoming.push(entry);
    }

    return { incoming, outgoing };
  }

  blocked(userId: string): ProfileSummary[] {
    const rows = this.db
      .select()
      .from(friendships)
      .where(and(eq(friendships.status, 'blocked'), eq(friendships.requestedBy, userId)))
      .all();

    const otherIds = rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId));
    const profiles = this.profiles.summariseMany(otherIds, userId);
    return otherIds.flatMap((id) => {
      const profile = profiles.get(id);
      return profile ? [profile] : [];
    });
  }

  /** True when either side has blocked the other; gates posts and requests. */
  isBlocked(userId: string, otherId: string): boolean {
    const [userAId, userBId] = pair(userId, otherId);
    const row = this.db
      .select({ id: friendships.id })
      .from(friendships)
      .where(
        and(
          eq(friendships.userAId, userAId),
          eq(friendships.userBId, userBId),
          eq(friendships.status, 'blocked'),
        ),
      )
      .get();
    return Boolean(row);
  }

  /**
   * How many games each friend has in common with the viewer, resolved in one
   * grouped query rather than one per friend.
   */
  private sharedGameCounts(userId: string, friendIds: string[]): Map<string, number> {
    if (friendIds.length === 0) return new Map();

    const rows = this.db
      .select({
        friendId: userLibrary.userId,
        count: sql<number>`count(*)`,
      })
      .from(userLibrary)
      .where(
        and(
          inArray(userLibrary.userId, friendIds),
          sql`${userLibrary.gameId} IN (SELECT game_id FROM user_library WHERE user_id = ${userId})`,
        ),
      )
      .groupBy(userLibrary.userId)
      .all();

    return new Map(rows.map((r) => [r.friendId, r.count]));
  }

  /** Resolves a username to an id for the "add by name" flow. */
  findByUsername(username: string): string {
    const row = this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(and(eq(users.usernameLower, username.trim().toLowerCase()), eq(users.isActive, true)))
      .get();
    if (!row) throw ApiError.notFound('No account with that username');
    return row.id;
  }
}
