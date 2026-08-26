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
  })
  // An empty message with nothing attached is a stray Enter, not something to
  // store and show everybody.
  .refine(
    (input) => input.body.length > 0 || input.mediaIds.length > 0,
    'Write something, or attach a picture',
  );
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

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
