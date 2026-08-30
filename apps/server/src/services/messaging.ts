import {
  MAX_GROUP_MEMBERS,
  REPLY_EXCERPT_LENGTH,
  type AddMembersInput,
  type ConversationInfo,
  type ConversationMemberInfo,
  type CreateConversationInput,
  type MessageAttachmentInfo,
  type MessageInfo,
  type MessageQuery,
  type MessageReactionInfo,
  type MessageReplyInfo,
  type SendMessageInput,
  type SharedGameInfo,
} from '@gameblade/shared';
import { and, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  conversationMembers,
  conversations,
  games,
  media,
  messageMedia,
  messageReactions,
  messages,
  mutedUsers,
  userProfiles,
  users,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { FriendService } from './friends.js';
import type { MediaStore } from './media.js';
import type { ProfileService } from './profiles.js';
import type { RealtimeGateway } from './realtime.js';

/** How much of a message the sidebar shows beside a conversation. */
const PREVIEW_LENGTH = 80;

/**
 * Direct messages and group chats.
 *
 * Access control is the entire security model here, and it is the half that was
 * always doing the work: who may start a conversation, who may read one, who
 * may write into it, and who may withdraw a message. An earlier version wrapped
 * every body in a key the server could not open, which protected nothing on a
 * server whose operator already holds every save file and password hash — and
 * broke in a way nothing could recover from when a device had no wrap.
 */
export class MessagingService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly profiles: ProfileService,
    private readonly friends: FriendService,
    private readonly mediaStore: MediaStore,
    private readonly realtime: RealtimeGateway,
  ) {}

  /* ------------------------------------------------------- conversations */

  /**
   * Starts a conversation, or hands back the direct one that already exists.
   *
   * The second half matters more than it looks: without it, opening a chat with
   * the same friend twice would create two conversations, and half the history
   * would be in the one you are not looking at.
   */
  create(userId: string, input: CreateConversationInput): ConversationInfo {
    const members = new Set(input.memberIds.filter(Boolean));
    members.add(userId);

    if (input.kind === 'direct' && members.size !== 2) {
      throw ApiError.badRequest('A direct conversation is between exactly two people');
    }
    if (members.size > MAX_GROUP_MEMBERS) {
      throw ApiError.badRequest(`A group can hold ${MAX_GROUP_MEMBERS} people at most`);
    }

    const others = [...members].filter((id) => id !== userId);
    this.assertReachable(userId, others);

    if (input.kind === 'direct') {
      const existing = this.findDirect(userId, others[0] as string);
      if (existing) return this.describe(existing, userId);
    }

    const id = newId('cnv');
    const now = isoNow();

    this.db.transaction((tx) => {
      tx.insert(conversations)
        .values({
          id,
          kind: input.kind,
          title: input.kind === 'group' ? (input.title ?? null) : null,
          createdBy: userId,
          createdAt: now,
          lastMessageAt: null,
          lastMessagePreview: null,
        })
        .run();

      for (const memberId of members) {
        tx.insert(conversationMembers)
          .values({
            id: newId('cmb'),
            conversationId: id,
            userId: memberId,
            // Whoever started it can rename it and add people; in a direct
            // conversation the distinction never comes up.
            role: memberId === userId ? 'owner' : 'member',
            joinedAt: now,
            lastReadAt: memberId === userId ? now : null,
            leftAt: null,
          })
          .run();
      }
    });

    // Everyone else finds out immediately rather than on their next refresh —
    // a conversation somebody has to reload to discover is one they miss.
    this.notify(id, userId, { type: 'conversation', conversationId: id });
    return this.describe(this.load(id), userId);
  }

  /** Every conversation the caller is still in, most recent first. */
  list(userId: string): ConversationInfo[] {
    const rows = this.db
      .select({ conversation: conversations })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(and(eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt)))
      .orderBy(desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`))
      .all();

    return rows.map((row) => this.describe(row.conversation, userId));
  }

  get(userId: string, conversationId: string): ConversationInfo {
    this.assertMember(userId, conversationId);
    return this.describe(this.load(conversationId), userId);
  }

  /** Adds people to a group. */
  addMembers(userId: string, conversationId: string, input: AddMembersInput): ConversationInfo {
    const conversation = this.load(conversationId);
    if (conversation.kind !== 'group') {
      throw ApiError.badRequest('Only a group can take more people');
    }
    this.assertMember(userId, conversationId);
    this.assertReachable(userId, input.memberIds);

    const current = new Set(this.memberIds(conversationId));
    const joining = input.memberIds.filter((id) => !current.has(id));
    if (current.size + joining.length > MAX_GROUP_MEMBERS) {
      throw ApiError.badRequest(`A group can hold ${MAX_GROUP_MEMBERS} people at most`);
    }

    const now = isoNow();
    this.db.transaction((tx) => {
      for (const memberId of joining) {
        // A previous member rejoining gets their old row back rather than a
        // second one, which the unique index would refuse anyway.
        const previous = tx
          .select({ id: conversationMembers.id })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, memberId),
            ),
          )
          .get();

        if (previous) {
          tx.update(conversationMembers)
            .set({ leftAt: null, joinedAt: now })
            .where(eq(conversationMembers.id, previous.id))
            .run();
        } else {
          tx.insert(conversationMembers)
            .values({
              id: newId('cmb'),
              conversationId,
              userId: memberId,
              role: 'member',
              joinedAt: now,
              lastReadAt: null,
              leftAt: null,
            })
            .run();
        }
      }
    });

    this.notify(conversationId, null, { type: 'conversation', conversationId });
    return this.describe(this.load(conversationId), userId);
  }

  /**
   * Leaves a group, or removes somebody from one.
   *
   * The membership row is kept with `leftAt` set rather than deleted: the
   * messages they sent are still in the history, and the thread needs a name to
   * put against them.
   */
  removeMember(userId: string, conversationId: string, targetId: string): void {
    const conversation = this.load(conversationId);
    const self = this.assertMember(userId, conversationId);

    if (conversation.kind !== 'group') {
      throw ApiError.badRequest('A direct conversation cannot be left');
    }
    if (targetId !== userId && self.role !== 'owner') {
      throw ApiError.forbidden('Only the group owner can remove somebody else');
    }

    this.db
      .update(conversationMembers)
      .set({ leftAt: isoNow() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, targetId),
        ),
      )
      .run();

    this.notify(conversationId, null, { type: 'conversation', conversationId });
  }

  rename(userId: string, conversationId: string, title: string | null): ConversationInfo {
    const conversation = this.load(conversationId);
    if (conversation.kind !== 'group') {
      throw ApiError.badRequest('Only a group has a name');
    }
    const self = this.assertMember(userId, conversationId);
    if (self.role !== 'owner') {
      throw ApiError.forbidden('Only the group owner can rename it');
    }

    this.db
      .update(conversations)
      .set({ title: title || null })
      .where(eq(conversations.id, conversationId))
      .run();

    this.notify(conversationId, null, { type: 'conversation', conversationId });
    return this.describe(this.load(conversationId), userId);
  }

  /* ------------------------------------------------------------ messages */

  /** Stores one message and pushes it to everybody else in the room. */
  send(userId: string, conversationId: string, input: SendMessageInput): MessageInfo {
    this.assertMember(userId, conversationId);

    if (input.mediaIds.length > 0) {
      // The uploader owns them, so nobody can attach somebody else's file and
      // make it look like it belongs to this conversation.
      this.mediaStore.assertOwned(userId, input.mediaIds);
    }

    // A reply has to point at a message in *this* conversation. Without the
    // check, an id from a room the sender is not in would be quoted into one
    // they are — which is a way to read a private thread one line at a time.
    let replyToId: string | null = null;
    if (input.replyToId) {
      const target = this.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, input.replyToId), eq(messages.conversationId, conversationId)))
        .get();
      if (!target) throw ApiError.badRequest('That message is not in this conversation');
      replyToId = target.id;
    }

    let sharedGameId: string | null = null;
    if (input.gameId) {
      const game = this.db
        .select({ id: games.id })
        .from(games)
        .where(eq(games.id, input.gameId))
        .get();
      if (!game) throw ApiError.badRequest('That game is not in the catalog');
      sharedGameId = game.id;
    }

    const id = newId('msg');
    const now = isoNow();

    this.db.transaction((tx) => {
      tx.insert(messages)
        .values({
          id,
          conversationId,
          senderId: userId,
          body: input.body,
          createdAt: now,
          editedAt: null,
          deletedAt: null,
          replyToId,
          sharedGameId,
        })
        .run();

      input.mediaIds.forEach((mediaId, index) => {
        tx.insert(messageMedia).values({ messageId: id, mediaId, sortOrder: index }).run();
      });

      tx.update(conversations)
        .set({ lastMessageAt: now, lastMessagePreview: preview(input) })
        .where(eq(conversations.id, conversationId))
        .run();

      // The sender has, by definition, read their own message.
      tx.update(conversationMembers)
        .set({ lastReadAt: now })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        )
        .run();
    });

    const info = this.messageInfo(id, userId);
    // Pushed per recipient rather than broadcast: `muted` is the reader's own
    // answer, and one frame cannot carry two.
    for (const memberId of this.memberIds(conversationId)) {
      if (memberId === userId) continue;
      this.realtime.send(memberId, { type: 'message', message: this.messageInfo(id, memberId) });
    }
    return info;
  }

  /* ------------------------------------------------------------ reactions */

  /**
   * Adds a reaction, or takes it back when it is already there.
   *
   * One call rather than an add and a remove: the gesture in the client is one
   * click on an emoji that is either lit or not, and splitting it into two
   * routes means the client has to know which — from state that may be stale by
   * the time the click lands.
   */
  react(userId: string, messageId: string, emoji: string): MessageReactionInfo[] {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row) throw ApiError.notFound('That message no longer exists');
    this.assertMember(userId, row.conversationId);

    const existing = this.db
      .select({ emoji: messageReactions.emoji })
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, userId),
          eq(messageReactions.emoji, emoji),
        ),
      )
      .get();

    if (existing) {
      this.db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, userId),
            eq(messageReactions.emoji, emoji),
          ),
        )
        .run();
    } else {
      this.db
        .insert(messageReactions)
        .values({ messageId, userId, emoji, createdAt: isoNow() })
        .run();
    }

    // Everyone gets the same tallies; only `mine` differs, and each client
    // knows whether it was the one that just clicked.
    for (const memberId of this.memberIds(row.conversationId)) {
      this.realtime.send(memberId, {
        type: 'message-reactions',
        conversationId: row.conversationId,
        messageId,
        reactions: this.reactionsFor([messageId], memberId).get(messageId) ?? [],
      });
    }

    return this.reactionsFor([messageId], userId).get(messageId) ?? [];
  }

  /* ---------------------------------------------------------------- mutes */

  /** Everyone this account has muted. */
  mutedIds(userId: string): Set<string> {
    return new Set(
      this.db
        .select({ mutedUserId: mutedUsers.mutedUserId })
        .from(mutedUsers)
        .where(eq(mutedUsers.userId, userId))
        .all()
        .map((row) => row.mutedUserId),
    );
  }

  /** Who is muted, with enough to render a list of them in settings. */
  listMuted(userId: string): Array<{ userId: string; username: string; displayName: string }> {
    return this.db
      .select({
        userId: mutedUsers.mutedUserId,
        username: users.username,
        displayName: userProfiles.displayName,
      })
      .from(mutedUsers)
      .innerJoin(users, eq(users.id, mutedUsers.mutedUserId))
      .leftJoin(userProfiles, eq(userProfiles.userId, mutedUsers.mutedUserId))
      .where(eq(mutedUsers.userId, userId))
      .all()
      .map((row) => ({
        userId: row.userId,
        username: row.username,
        displayName: row.displayName ?? row.username,
      }));
  }

  /**
   * Mutes somebody, or unmutes them.
   *
   * Silent on their side, always. A mute that the muted person can detect is a
   * mute nobody uses, because using it becomes a statement — and the point of
   * having this beside blocking is that it is not one.
   */
  setMuted(userId: string, targetId: string, muted: boolean): void {
    if (targetId === userId) throw ApiError.badRequest('You cannot mute yourself');

    if (muted) {
      const exists = this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, targetId))
        .get();
      if (!exists) throw ApiError.notFound('That account does not exist');

      this.db
        .insert(mutedUsers)
        .values({ userId, mutedUserId: targetId, createdAt: isoNow() })
        // Muting twice is the same as muting once, and the second click should
        // not be an error the UI has to explain.
        .onConflictDoNothing()
        .run();
    } else {
      this.db
        .delete(mutedUsers)
        .where(and(eq(mutedUsers.userId, userId), eq(mutedUsers.mutedUserId, targetId)))
        .run();
    }
  }

  /** A page of history, newest last so the client can append without sorting. */
  history(userId: string, conversationId: string, query: MessageQuery): MessageInfo[] {
    this.assertMember(userId, conversationId);

    const conditions = [eq(messages.conversationId, conversationId)];
    if (query.before) {
      // Keyed on the id rather than the timestamp: ids are monotonic here and
      // two messages in the same millisecond would otherwise page badly.
      conditions.push(lt(messages.id, query.before));
    }

    const rows = this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(query.limit)
      .all();

    const ids = rows.map((row) => row.id);
    const attachments = this.attachmentsFor(ids);
    const reactions = this.reactionsFor(ids, userId);
    const replies = this.repliesFor(rows.map((row) => row.replyToId));
    const shared = this.sharedGamesFor(rows.map((row) => row.sharedGameId));
    const muted = this.mutedIds(userId);

    return rows.reverse().map((row) =>
      this.toMessageInfo(row, {
        attachments: attachments.get(row.id) ?? [],
        reactions: reactions.get(row.id) ?? [],
        replyTo: row.replyToId ? (replies.get(row.replyToId) ?? null) : null,
        game: row.sharedGameId ? (shared.get(row.sharedGameId) ?? null) : null,
        muted: row.senderId !== null && muted.has(row.senderId),
      }),
    );
  }

  /**
   * Withdraws a message.
   *
   * The body is cleared rather than the row deleted, so every client agrees it
   * is gone — one that missed the event would otherwise go on showing text it
   * had already rendered. Worth being plain about the limit: anybody who
   * already read it still has, and this does not reach into their screen.
   */
  remove(userId: string, messageId: string): void {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row) throw ApiError.notFound('That message no longer exists');
    if (row.senderId !== userId) {
      throw ApiError.forbidden('You can only withdraw your own messages');
    }

    this.db
      .update(messages)
      .set({ deletedAt: isoNow(), body: '' })
      .where(eq(messages.id, messageId))
      .run();

    this.notify(row.conversationId, null, {
      type: 'message-removed',
      conversationId: row.conversationId,
      messageId,
    });
  }

  /** Marks everything up to now as read, for the sidebar's badge. */
  markRead(userId: string, conversationId: string): void {
    this.assertMember(userId, conversationId);
    this.db
      .update(conversationMembers)
      .set({ lastReadAt: isoNow() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .run();
  }

  /**
   * Unread across every conversation, for the tab's badge.
   *
   * Muted senders do not count. A mute that still lights the badge is a mute
   * that does nothing: the whole reason to reach for it is to stop being
   * pulled back to a conversation.
   */
  unreadTotal(userId: string): number {
    const muted = [...this.mutedIds(userId)];

    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(
        conversationMembers,
        eq(conversationMembers.conversationId, messages.conversationId),
      )
      .where(
        and(
          eq(conversationMembers.userId, userId),
          isNull(conversationMembers.leftAt),
          isNull(messages.deletedAt),
          ne(messages.senderId, userId),
          ...(muted.length > 0 ? [notInArray(messages.senderId, muted)] : []),
          or(
            isNull(conversationMembers.lastReadAt),
            sql`${messages.createdAt} > ${conversationMembers.lastReadAt}`,
          ),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  /* -------------------------------------------------------------- shared */

  /**
   * Whether these two can message at all.
   *
   * Friends only, and deliberately so: an archive with open messaging is one
   * where any account can send anything to any other, which is the shape every
   * spam and harassment problem takes. Adding somebody is already the gesture
   * that says "I want to hear from you".
   */
  private assertReachable(userId: string, others: string[]): void {
    if (others.length === 0) return;

    const known = this.profiles.friendIds(userId);
    const strangers = others.filter((id) => id !== userId && !known.has(id));
    if (strangers.length === 0) return;

    const blocked = this.friends.isBlocked(userId, strangers[0] as string);
    throw blocked
      ? ApiError.forbidden('You cannot message that person')
      : ApiError.forbidden('You can only message people on your friends list');
  }

  private load(conversationId: string) {
    const row = this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (!row) throw ApiError.notFound('That conversation no longer exists');
    return row;
  }

  private assertMember(userId: string, conversationId: string) {
    const row = this.db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
          isNull(conversationMembers.leftAt),
        ),
      )
      .get();
    // "Not found" rather than "forbidden" on purpose: a stranger probing ids
    // should not be able to tell an existing conversation from a made-up one.
    if (!row) throw ApiError.notFound('That conversation no longer exists');
    return row;
  }

  private memberIds(conversationId: string): string[] {
    return this.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          isNull(conversationMembers.leftAt),
        ),
      )
      .all()
      .map((row) => row.userId);
  }

  private describe(
    conversation: {
      id: string;
      kind: 'direct' | 'group';
      title: string | null;
      createdAt: string;
      lastMessageAt: string | null;
      lastMessagePreview: string | null;
    },
    viewerId: string,
  ): ConversationInfo {
    const memberRows = this.db
      .select({
        userId: conversationMembers.userId,
        role: conversationMembers.role,
        joinedAt: conversationMembers.joinedAt,
        leftAt: conversationMembers.leftAt,
        lastReadAt: conversationMembers.lastReadAt,
        username: users.username,
        displayName: userProfiles.displayName,
        avatarMediaId: userProfiles.avatarMediaId,
        accentColor: userProfiles.accentColor,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .leftJoin(userProfiles, eq(userProfiles.userId, conversationMembers.userId))
      .where(eq(conversationMembers.conversationId, conversation.id))
      .all();

    const members: ConversationMemberInfo[] = memberRows.map((row) => ({
      userId: row.userId,
      username: row.username,
      displayName: row.displayName ?? row.username,
      avatarUrl: row.avatarMediaId ? this.profiles.mediaUrl(row.avatarMediaId) : null,
      accentColor: row.accentColor ?? '#7c5cff',
      role: row.role,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
    }));

    const self = memberRows.find((row) => row.userId === viewerId);
    const muted = [...this.mutedIds(viewerId)];

    const unread =
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            isNull(messages.deletedAt),
            ne(messages.senderId, viewerId),
            // Same reasoning as `unreadTotal`: a muted sender should not put a
            // number on the sidebar row either.
            ...(muted.length > 0 ? [notInArray(messages.senderId, muted)] : []),
            self?.lastReadAt ? sql`${messages.createdAt} > ${self.lastReadAt}` : sql`1 = 1`,
          ),
        )
        .get()?.count ?? 0;

    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      createdAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
      members,
      unreadCount: unread,
    };
  }

  private findDirect(userId: string, otherId: string) {
    return this.db
      .select({ conversation: conversations })
      .from(conversations)
      .where(
        and(
          eq(conversations.kind, 'direct'),
          sql`EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = ${conversations.id} AND m.user_id = ${userId} AND m.left_at IS NULL)`,
          sql`EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = ${conversations.id} AND m.user_id = ${otherId} AND m.left_at IS NULL)`,
        ),
      )
      .get()?.conversation;
  }

  private attachmentsFor(messageIds: string[]) {
    const grouped = new Map<string, MessageAttachmentInfo[]>();
    if (messageIds.length === 0) return grouped;

    const rows = this.db
      .select({
        messageId: messageMedia.messageId,
        mediaId: messageMedia.mediaId,
        sortOrder: messageMedia.sortOrder,
        kind: media.kind,
        sizeBytes: media.sizeBytes,
        width: media.width,
        height: media.height,
      })
      .from(messageMedia)
      .innerJoin(media, eq(media.id, messageMedia.mediaId))
      .where(inArray(messageMedia.messageId, messageIds))
      .all();

    for (const row of rows.sort((a, b) => a.sortOrder - b.sortOrder)) {
      const list = grouped.get(row.messageId) ?? [];
      list.push({
        mediaId: row.mediaId,
        url: this.mediaStore.url(row.mediaId),
        kind: row.kind === 'clip' ? 'clip' : 'image',
        sizeBytes: row.sizeBytes,
        width: row.width,
        height: row.height,
      });
      grouped.set(row.messageId, list);
    }
    return grouped;
  }

  /**
   * Tallies per message, for a specific reader.
   *
   * `mine` is the reader's own answer, so this takes a viewer rather than being
   * cached once per message — two people looking at the same reaction see a
   * different button.
   */
  private reactionsFor(messageIds: string[], viewerId: string): Map<string, MessageReactionInfo[]> {
    const grouped = new Map<string, MessageReactionInfo[]>();
    if (messageIds.length === 0) return grouped;

    const rows = this.db
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emoji,
        count: sql<number>`count(*)`,
        mine: sql<number>`sum(case when ${messageReactions.userId} = ${viewerId} then 1 else 0 end)`,
      })
      .from(messageReactions)
      .where(inArray(messageReactions.messageId, messageIds))
      .groupBy(messageReactions.messageId, messageReactions.emoji)
      .all();

    for (const row of rows) {
      const list = grouped.get(row.messageId) ?? [];
      list.push({ emoji: row.emoji, count: Number(row.count), mine: Number(row.mine) > 0 });
      grouped.set(row.messageId, list);
    }
    return grouped;
  }

  /** The quoted lines above each reply, keyed by the message being answered. */
  private repliesFor(replyToIds: Array<string | null>): Map<string, MessageReplyInfo> {
    const wanted = [...new Set(replyToIds.filter((id): id is string => id !== null))];
    const found = new Map<string, MessageReplyInfo>();
    if (wanted.length === 0) return found;

    const rows = this.db
      .select({
        id: messages.id,
        senderId: messages.senderId,
        body: messages.body,
        deletedAt: messages.deletedAt,
        sharedGameId: messages.sharedGameId,
        username: users.username,
        displayName: userProfiles.displayName,
        attachments: sql<number>`(SELECT count(*) FROM message_media m WHERE m.message_id = ${messages.id})`,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
      .where(inArray(messages.id, wanted))
      .all();

    for (const row of rows) {
      found.set(row.id, {
        id: row.id,
        senderId: row.senderId,
        senderName: row.displayName ?? row.username ?? 'Someone',
        excerpt: excerpt(row),
        deleted: row.deletedAt !== null,
      });
    }
    return found;
  }

  /** The cards for games shared into a thread. */
  private sharedGamesFor(gameIds: Array<string | null>): Map<string, SharedGameInfo> {
    const wanted = [...new Set(gameIds.filter((id): id is string => id !== null))];
    const found = new Map<string, SharedGameInfo>();
    if (wanted.length === 0) return found;

    for (const row of this.db
      .select({
        id: games.id,
        title: games.title,
        coverImageId: games.coverImageId,
        releaseDate: games.releaseDate,
        genres: games.genres,
      })
      .from(games)
      .where(inArray(games.id, wanted))
      .all()) {
      found.set(row.id, {
        gameId: row.id,
        title: row.title,
        coverUrl: row.coverImageId
          ? `${this.config.basePath}/api/images/${row.coverImageId}`
          : null,
        releaseYear: row.releaseDate ? Number(row.releaseDate.slice(0, 4)) || null : null,
        genres: (row.genres ?? []).slice(0, 3),
      });
    }
    return found;
  }

  private messageInfo(messageId: string, viewerId: string): MessageInfo {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row) throw ApiError.notFound('That message no longer exists');

    return this.toMessageInfo(row, {
      attachments: this.attachmentsFor([messageId]).get(messageId) ?? [],
      reactions: this.reactionsFor([messageId], viewerId).get(messageId) ?? [],
      replyTo: row.replyToId ? (this.repliesFor([row.replyToId]).get(row.replyToId) ?? null) : null,
      game: row.sharedGameId
        ? (this.sharedGamesFor([row.sharedGameId]).get(row.sharedGameId) ?? null)
        : null,
      muted: row.senderId !== null && this.mutedIds(viewerId).has(row.senderId),
    });
  }

  private toMessageInfo(
    row: {
      id: string;
      conversationId: string;
      senderId: string | null;
      body: string;
      createdAt: string;
      editedAt: string | null;
      deletedAt: string | null;
    },
    extras: {
      attachments: MessageAttachmentInfo[];
      reactions: MessageReactionInfo[];
      replyTo: MessageReplyInfo | null;
      game: SharedGameInfo | null;
      muted: boolean;
    },
  ): MessageInfo {
    return {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      body: row.body,
      attachments: extras.attachments,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      deleted: row.deletedAt !== null,
      reactions: extras.reactions,
      replyTo: extras.replyTo,
      game: extras.game,
      muted: extras.muted,
    };
  }

  /** Pushes an event to everyone in the room except, optionally, the sender. */
  private notify(
    conversationId: string,
    except: string | null,
    event: Parameters<RealtimeGateway['send']>[1],
  ): void {
    for (const memberId of this.memberIds(conversationId)) {
      if (memberId === except) continue;
      this.realtime.send(memberId, event);
    }
  }
}

/** The line the sidebar shows beside a conversation. */
function preview(input: SendMessageInput): string {
  if (input.body) {
    const collapsed = input.body.replace(/\s+/g, ' ').trim();
    return collapsed.length > PREVIEW_LENGTH
      ? `${collapsed.slice(0, PREVIEW_LENGTH - 1)}…`
      : collapsed;
  }
  if (input.gameId) return 'Shared a game';
  // A message that is only attachments still needs a line, and "sent a
  // picture" is what every other chat says because it is what happened.
  const count = input.mediaIds.length;
  return count === 1 ? 'Sent an attachment' : `Sent ${count} attachments`;
}

/**
 * The line quoted above a reply.
 *
 * A withdrawn message, a picture and a shared game all have to say something —
 * a blank quote reads as a rendering bug rather than as "they sent a picture".
 */
function excerpt(row: {
  body: string;
  deletedAt: string | null;
  sharedGameId: string | null;
  attachments: number;
}): string {
  if (row.deletedAt !== null) return 'Message withdrawn';

  const flat = row.body.replace(/\s+/g, ' ').trim();
  if (flat) {
    return flat.length > REPLY_EXCERPT_LENGTH
      ? `${flat.slice(0, REPLY_EXCERPT_LENGTH - 1)}…`
      : flat;
  }

  if (row.sharedGameId) return 'Shared a game';
  if (row.attachments > 1) return `${row.attachments} attachments`;
  return row.attachments === 1 ? 'An attachment' : 'Empty message';
}
