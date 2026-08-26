import {
  MAX_GROUP_MEMBERS,
  type AddMembersInput,
  type ConversationInfo,
  type ConversationMemberInfo,
  type CreateConversationInput,
  type MessageInfo,
  type MessageQuery,
  type PublishedDeviceKey,
  type SendMessageInput,
  type WrappedKeyInput,
} from '@gameblade/shared';
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import {
  conversationKeys,
  conversationMembers,
  conversations,
  deviceKeys,
  media,
  messageMedia,
  messages,
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

/**
 * Conversations the server routes and cannot read.
 *
 * Everything that arrives here is either ciphertext or metadata. The bodies are
 * two opaque base64 columns; the attachments are media rows whose bytes are
 * ciphertext and whose recorded content type is deliberately meaningless. The
 * server holds no key that opens any of it, and — importantly — is never asked
 * to make one: a conversation key is generated and wrapped on a client, because
 * the moment the server could seal it, it could read it.
 *
 * What it does know, and what no amount of encryption hides: who is talking to
 * whom, when, and how much. That is the shape of the thing, not an oversight,
 * and it is said out loud in the client rather than left to be discovered.
 */
export class MessagingService {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileService,
    private readonly friends: FriendService,
    private readonly mediaStore: MediaStore,
    private readonly realtime: RealtimeGateway,
  ) {}

  /* ------------------------------------------------------------- devices */

  /**
   * Publishes this device's public key.
   *
   * Idempotent on the key itself: a client calls this every time it starts, and
   * re-registering the same key must not create a second row that everyone then
   * has to seal for a second time.
   */
  publishDeviceKey(
    userId: string,
    input: { publicKey: string; label?: string | null },
  ): PublishedDeviceKey {
    const existing = this.db
      .select()
      .from(deviceKeys)
      .where(and(eq(deviceKeys.userId, userId), eq(deviceKeys.publicKey, input.publicKey)))
      .get();

    if (existing) {
      this.db
        .update(deviceKeys)
        .set({ lastSeenAt: isoNow(), ...(input.label ? { label: input.label } : {}) })
        .where(eq(deviceKeys.id, existing.id))
        .run();
      return this.toDeviceKey({ ...existing, label: input.label ?? existing.label });
    }

    const record = {
      id: newId('dvk'),
      userId,
      deviceId: null,
      publicKey: input.publicKey,
      label: input.label ?? null,
      createdAt: isoNow(),
      lastSeenAt: isoNow(),
    };
    this.db.insert(deviceKeys).values(record).run();
    return this.toDeviceKey(record);
  }

  /** Every key belonging to one account. */
  deviceKeysFor(userIds: string[]): PublishedDeviceKey[] {
    const unique = [...new Set(userIds)].filter(Boolean);
    if (unique.length === 0) return [];
    return this.db
      .select()
      .from(deviceKeys)
      .where(inArray(deviceKeys.userId, unique))
      .all()
      .map((row) => this.toDeviceKey(row));
  }

  /**
   * Retires one key.
   *
   * Called when a client signs out, because the private half is destroyed at
   * the same moment — leaving the public key published would mean everybody
   * going on sealing conversation keys for a device that can no longer open
   * them.
   */
  retireDeviceKey(userId: string, publicKey: string): boolean {
    const result = this.db
      .delete(deviceKeys)
      .where(and(eq(deviceKeys.userId, userId), eq(deviceKeys.publicKey, publicKey)))
      .run();
    return result.changes > 0;
  }

  private toDeviceKey(row: {
    id: string;
    userId: string;
    publicKey: string;
    label: string | null;
    createdAt: string;
  }): PublishedDeviceKey {
    return {
      id: row.id,
      userId: row.userId,
      publicKey: row.publicKey,
      label: row.label,
      createdAt: row.createdAt,
      fingerprint: fingerprint(row.publicKey),
    };
  }

  /* ------------------------------------------------------- conversations */

  /**
   * Starts a conversation, or hands back the direct one that already exists.
   *
   * The second half matters more than it looks: without it, opening a chat with
   * the same friend twice would create two conversations with two different
   * keys, and half your history would be in the one you are not looking at.
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

      this.storeKeys(tx, id, input.keys, members);
    });

    const created = this.load(id);
    // Everyone else finds out immediately rather than on their next refresh —
    // a conversation somebody has to reload to discover is one they miss.
    this.notify(id, userId, { type: 'conversation', conversationId: id });
    return this.describe(created, userId);
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

  /**
   * Seals the key for devices that did not exist when the conversation started.
   *
   * A member who signs in on a second machine has a key nobody has wrapped for.
   * Any existing member can supply the wrap, because any of them can already
   * read the conversation — the server only checks that they are one.
   */
  backfillKeys(userId: string, conversationId: string, keys: WrappedKeyInput[]): number {
    this.assertMember(userId, conversationId);
    const members = new Set(this.memberIds(conversationId));

    let stored = 0;
    this.db.transaction((tx) => {
      stored = this.storeKeys(tx, conversationId, keys, members);
    });
    return stored;
  }

  /** Adds people to a group, with the key already sealed for their devices. */
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

      this.storeKeys(tx, conversationId, input.keys, new Set([...current, ...joining]));
    });

    this.notify(conversationId, null, { type: 'conversation', conversationId });
    return this.describe(this.load(conversationId), userId);
  }

  /**
   * Leaves a group, or removes somebody from one.
   *
   * The membership row is kept with `leftAt` set rather than deleted: the
   * messages they sent are still in the history, and the sidebar needs a name
   * to put against them.
   *
   * Deliberately does *not* re-key. Doing so would suggest the conversation's
   * past is now closed to them, and it is not — they held the key and could
   * have kept a copy of everything they read. Saying otherwise would be a
   * security promise this design cannot keep.
   */
  removeMember(userId: string, conversationId: string, targetId: string): void {
    const conversation = this.load(conversationId);
    const self = this.assertMember(userId, conversationId);

    if (conversation.kind !== 'group') {
      throw ApiError.badRequest('A direct conversation cannot be left; delete it instead');
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

  /**
   * Stores one sealed message and pushes it to everybody else in the room.
   *
   * Both columns are opaque. The only thing validated about them is their
   * shape and their size — there is nothing else the server could check, since
   * it cannot tell a well-formed message from noise.
   */
  send(userId: string, conversationId: string, input: SendMessageInput): MessageInfo {
    this.assertMember(userId, conversationId);

    if (input.mediaIds.length > 0) {
      // The uploader owns them, so nobody can attach somebody else's file and
      // make it look like it belongs to this conversation.
      this.mediaStore.assertOwned(userId, input.mediaIds);
    }

    const id = newId('msg');
    const now = isoNow();

    this.db.transaction((tx) => {
      tx.insert(messages)
        .values({
          id,
          conversationId,
          senderId: userId,
          nonce: input.body.nonce,
          ciphertext: input.body.ciphertext,
          createdAt: now,
          editedAt: null,
          deletedAt: null,
        })
        .run();

      input.mediaIds.forEach((mediaId, index) => {
        tx.insert(messageMedia).values({ messageId: id, mediaId, sortOrder: index }).run();
      });

      tx.update(conversations)
        .set({ lastMessageAt: now })
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

    const info = this.messageInfo(id);
    this.notify(conversationId, userId, { type: 'message', message: info });
    return info;
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

    const attachments = this.attachmentsFor(rows.map((row) => row.id));

    return rows.reverse().map((row) => this.toMessageInfo(row, attachments.get(row.id) ?? []));
  }

  /**
   * Withdraws a message.
   *
   * The ciphertext is cleared rather than the row deleted, so every client
   * agrees it is gone — one that missed the event would otherwise go on showing
   * a body it had already decrypted. Worth being plain about the limit: anybody
   * who had already read it still has, and this does not reach into their
   * screen.
   */
  remove(userId: string, messageId: string): void {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row) throw ApiError.notFound('That message no longer exists');
    if (row.senderId !== userId) {
      throw ApiError.forbidden('You can only withdraw your own messages');
    }

    this.db
      .update(messages)
      .set({ deletedAt: isoNow(), nonce: '', ciphertext: '' })
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

  /** Unread across every conversation, for the tab's badge. */
  unreadTotal(userId: string): number {
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

  /**
   * Writes wrapped keys, ignoring any addressed to somebody outside the room.
   *
   * A client builds the wrap list from the member list the server gave it, so a
   * stray entry is a bug rather than an attack — but storing one would leave a
   * key blob addressed to a device with no business holding it.
   */
  private storeKeys(
    tx: Db,
    conversationId: string,
    keys: WrappedKeyInput[],
    members: Set<string>,
  ): number {
    if (keys.length === 0) return 0;

    const owners = new Map(
      tx
        .select({ publicKey: deviceKeys.publicKey, userId: deviceKeys.userId })
        .from(deviceKeys)
        .where(
          inArray(
            deviceKeys.publicKey,
            keys.map((key) => key.publicKey),
          ),
        )
        .all()
        .map((row) => [row.publicKey, row.userId]),
    );

    let stored = 0;
    for (const key of keys) {
      const owner = owners.get(key.publicKey);
      if (!owner || !members.has(owner)) continue;

      tx.insert(conversationKeys)
        .values({
          id: newId('cvk'),
          conversationId,
          userId: owner,
          publicKey: key.publicKey,
          ephemeralPublic: key.ephemeralPublic,
          nonce: key.nonce,
          ciphertext: key.ciphertext,
          createdAt: isoNow(),
        })
        // Already sealed for that device: the first wrap is as good as the
        // second, and replacing it would invalidate nothing.
        .onConflictDoNothing()
        .run();
      stored += 1;
    }
    return stored;
  }

  private describe(
    conversation: {
      id: string;
      kind: 'direct' | 'group';
      title: string | null;
      createdAt: string;
      lastMessageAt: string | null;
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

    const keys = this.db
      .select()
      .from(conversationKeys)
      .where(
        and(
          eq(conversationKeys.conversationId, conversation.id),
          eq(conversationKeys.userId, viewerId),
        ),
      )
      .all()
      .map((row) => ({
        publicKey: row.publicKey,
        ephemeralPublic: row.ephemeralPublic,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
      }));

    const unread =
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            isNull(messages.deletedAt),
            ne(messages.senderId, viewerId),
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
      members,
      keys,
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
    const grouped = new Map<string, MessageInfo['attachments']>();
    if (messageIds.length === 0) return grouped;

    const rows = this.db
      .select({
        messageId: messageMedia.messageId,
        mediaId: messageMedia.mediaId,
        sortOrder: messageMedia.sortOrder,
        sizeBytes: media.sizeBytes,
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
        sizeBytes: row.sizeBytes,
      });
      grouped.set(row.messageId, list);
    }
    return grouped;
  }

  private messageInfo(messageId: string): MessageInfo {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row) throw ApiError.notFound('That message no longer exists');
    return this.toMessageInfo(row, this.attachmentsFor([messageId]).get(messageId) ?? []);
  }

  private toMessageInfo(
    row: {
      id: string;
      conversationId: string;
      senderId: string | null;
      nonce: string;
      ciphertext: string;
      createdAt: string;
      editedAt: string | null;
      deletedAt: string | null;
    },
    attachments: MessageInfo['attachments'],
  ): MessageInfo {
    return {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      body: { nonce: row.nonce, ciphertext: row.ciphertext },
      attachments,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      deleted: row.deletedAt !== null,
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

/**
 * The same eight groups of four the client shows.
 *
 * Computed here as well so the fingerprint on a key somebody is *about* to
 * trust does not depend on that same client having computed it honestly.
 */
function fingerprint(publicKey: string): string {
  const digest = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
  return (digest.slice(0, 32).match(/.{4}/g) ?? []).join(' ');
}
