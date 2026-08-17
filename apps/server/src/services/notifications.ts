import type { NotificationInfo, NotificationKind } from '@gameblade/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { notifications } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { ProfileService } from './profiles.js';
import type { RealtimeGateway } from './realtime.js';

export interface CreateNotification {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  /** Client-side route, e.g. `profile/usr_x` or `social/post/pst_y`. */
  link?: string | null;
  actorId?: string | null;
}

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileService,
    private readonly realtime: RealtimeGateway,
  ) {}

  create(input: CreateNotification): NotificationInfo {
    // Never notify someone about their own action; every caller would otherwise
    // need the same guard around commenting on or reacting to their own post.
    // Nothing is stored, but a shaped result is still returned so callers do
    // not have to branch on it.
    if (input.actorId && input.actorId === input.userId) {
      return this.toInfo(
        {
          id: newId('ntf'),
          kind: input.kind,
          actorId: input.actorId,
          title: input.title,
          body: input.body ?? null,
          link: input.link ?? null,
          readAt: isoNow(),
          createdAt: isoNow(),
        },
        input.userId,
      );
    }

    const record = {
      id: newId('ntf'),
      userId: input.userId,
      kind: input.kind,
      actorId: input.actorId ?? null,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      readAt: null,
      createdAt: isoNow(),
    };
    this.db.insert(notifications).values(record).run();

    const info = this.toInfo(record, input.userId);
    this.realtime.send(input.userId, { type: 'notification', notification: info });
    return info;
  }

  /** Bulk insert for announcements, which may target every account at once. */
  createMany(userIds: string[], input: Omit<CreateNotification, 'userId'>): number {
    let created = 0;
    for (const userId of userIds) {
      this.create({ ...input, userId });
      created += 1;
    }
    return created;
  }

  list(userId: string, options: { unreadOnly?: boolean; limit: number; before?: string }) {
    const conditions = [eq(notifications.userId, userId)];
    if (options.unreadOnly) conditions.push(isNull(notifications.readAt));
    if (options.before) conditions.push(lt(notifications.createdAt, options.before));

    const rows = this.db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(options.limit)
      .all();

    return rows.map((row) => this.toInfo(row, userId));
  }

  unreadCount(userId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .get();
    return row?.count ?? 0;
  }

  markRead(userId: string, id: string): void {
    this.db
      .update(notifications)
      .set({ readAt: isoNow() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .run();
  }

  markAllRead(userId: string): void {
    this.db
      .update(notifications)
      .set({ readAt: isoNow() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .run();
  }

  /** Read notifications older than the cutoff are noise; drop them. */
  prune(olderThanIso: string): void {
    this.db
      .delete(notifications)
      .where(and(lt(notifications.createdAt, olderThanIso), sql`read_at IS NOT NULL`))
      .run();
  }

  private toInfo(
    row: {
      id: string;
      kind: string;
      actorId: string | null;
      title: string;
      body: string | null;
      link: string | null;
      readAt: string | null;
      createdAt: string;
    },
    viewerId: string,
  ): NotificationInfo {
    return {
      id: row.id,
      kind: row.kind as NotificationKind,
      actor: row.actorId ? this.profiles.summariseOne(row.actorId, viewerId) : null,
      title: row.title,
      body: row.body,
      link: row.link,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }
}
