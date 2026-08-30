/**
 * Direct messages and group chats.
 *
 * Plain text, stored by the server like any other row. An earlier version of
 * this encrypted everything end-to-end; it was removed because the cost was all
 * out of proportion to what this is — a small archive where the operator
 * already holds every save file, every screenshot and every password hash. A
 * key-wrapping dance on top of that protected nothing it was not already
 * possible to read, and the failure modes it added were real: a device with no
 * wrap for a conversation could not read a word of it.
 *
 * What is left is what a chat needs: conversations, membership, messages,
 * attachments, and read state. Access control is the whole security model, and
 * it is the half that was always doing the work.
 */

import { z } from 'zod';

export const CONVERSATION_KIND = ['direct', 'group'] as const;
export type ConversationKind = (typeof CONVERSATION_KIND)[number];

export const CONVERSATION_ROLE = ['owner', 'member'] as const;
export type ConversationRole = (typeof CONVERSATION_ROLE)[number];

/** How many people one group may hold. */
export const MAX_GROUP_MEMBERS = 32;

/** The longest a single message may be. */
export const MAX_MESSAGE_LENGTH = 4000;

/** How many attachments one message may carry. */
export const MAX_MESSAGE_ATTACHMENTS = 6;

/**
 * The reactions offered on the right-click menu.
 *
 * A fixed set rather than a picker. An arbitrary-emoji field means storing and
 * rendering whatever anybody's keyboard produces — including sequences that
 * render as a wall of nothing on another machine — for a feature whose whole
 * value is being instant. Six covers what people actually use.
 */
export const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢'] as const;
export type MessageReactionEmoji = (typeof MESSAGE_REACTIONS)[number];

/** How much of a replied-to message is quoted above the reply. */
export const REPLY_EXCERPT_LENGTH = 120;

export interface ConversationMemberInfo {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  accentColor: string;
  role: ConversationRole;
  joinedAt: string;
  leftAt: string | null;
}

export interface ConversationInfo {
  id: string;
  kind: ConversationKind;
  /** Groups only; a direct conversation is named by whoever is in it. */
  title: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  /** A one-line preview for the sidebar, so it need not fetch every thread. */
  lastMessagePreview: string | null;
  members: ConversationMemberInfo[];
  /** Messages since the caller last read, for the sidebar's badge. */
  unreadCount: number;
}

/** One attachment on a message. */
export interface MessageAttachmentInfo {
  mediaId: string;
  url: string;
  /** Image or clip, so the client knows which element to render. */
  kind: 'image' | 'clip';
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

/** One emoji's tally on a message, and whether the reader is in it. */
export interface MessageReactionInfo {
  emoji: string;
  count: number;
  /** Whether the caller is one of the people who reacted. */
  mine: boolean;
}

/**
 * Just enough of the message being answered to render the quote above a reply.
 *
 * Not the whole `MessageInfo`: that would recurse, and a chain of fifty
 * replies would carry fifty copies of the history behind it.
 */
export interface MessageReplyInfo {
  id: string;
  senderId: string | null;
  senderName: string;
  /** Trimmed body, or a stand-in describing what the message was. */
  excerpt: string;
  /** True when the original has since been withdrawn. */
  deleted: boolean;
}

/** A game shared into a conversation, as the card renders it. */
export interface SharedGameInfo {
  gameId: string;
  title: string;
  coverUrl: string | null;
  releaseYear: number | null;
  genres: string[];
}

export interface MessageInfo {
  id: string;
  conversationId: string;
  senderId: string | null;
  body: string;
  attachments: MessageAttachmentInfo[];
  createdAt: string;
  editedAt: string | null;
  /** True once withdrawn; the body is cleared rather than merely hidden. */
  deleted: boolean;
  reactions: MessageReactionInfo[];
  /** The message this one answers, when it answers one. */
  replyTo: MessageReplyInfo | null;
  /** A game recommended into the conversation. */
  game: SharedGameInfo | null;
  /**
   * True when the sender is somebody the reader has muted.
   *
   * Sent rather than resolved client-side so every surface agrees, and shown
   * as a collapsed row rather than dropped: a thread with silent holes in it
   * reads as a bug, and a muted person's message is sometimes worth unfolding.
   */
  muted: boolean;
}

/* ------------------------------------------------------------------ input */

export const createConversationSchema = z.object({
  kind: z.enum(CONVERSATION_KIND).default('direct'),
  /** Everyone in it, the caller included or not — the server adds them either way. */
  memberIds: z.array(z.string().trim().max(64)).min(1).max(MAX_GROUP_MEMBERS),
  title: z.string().trim().max(80).nullable().optional(),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const sendMessageSchema = z
  .object({
    body: z.string().trim().max(MAX_MESSAGE_LENGTH).default(''),
    mediaIds: z.array(z.string().trim().max(64)).max(MAX_MESSAGE_ATTACHMENTS).default([]),
    /** The message being answered, if this is a reply. */
    replyToId: z.string().trim().max(64).nullable().optional(),
    /** A game to recommend, rendered as a card rather than pasted as a name. */
    gameId: z.string().trim().max(64).nullable().optional(),
  })
  // An empty message with nothing attached is a stray Enter, not something to
  // store and show everybody. A shared game counts as content in its own
  // right — "look at this" with the card under it needs no words.
  .refine(
    (input) => input.body.length > 0 || input.mediaIds.length > 0 || Boolean(input.gameId),
    'Write something, attach a picture, or share a game',
  );
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const reactToMessageSchema = z.object({
  emoji: z.enum(MESSAGE_REACTIONS),
});
export type ReactToMessageInput = z.infer<typeof reactToMessageSchema>;

export const messageQuerySchema = z.object({
  /** Everything older than this message id, for scrolling back. */
  before: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessageQuery = z.infer<typeof messageQuerySchema>;

export const addMembersSchema = z.object({
  memberIds: z.array(z.string().trim().max(64)).min(1).max(MAX_GROUP_MEMBERS),
});
export type AddMembersInput = z.infer<typeof addMembersSchema>;

export const renameConversationSchema = z.object({
  title: z.string().trim().max(80).nullable(),
});
export type RenameConversationInput = z.infer<typeof renameConversationSchema>;
