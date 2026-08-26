/**
 * Private conversations, which the server routes and cannot read.
 *
 * Every shape here is either ciphertext or metadata. What the server knows is
 * who is in a conversation, when something was sent, and how large it was.
 * What it does not know is a single word of any of it — the keys are wrapped
 * for each member's device and it holds none that would open them.
 *
 * The honest limits, stated here because a security promise nobody reads is
 * worth nothing:
 *
 * * The server distributes the public keys, so an operator who has replaced
 *   the server binary could hand out one of their own and read what follows.
 *   Fingerprints exist so two people can rule that out by comparing eight
 *   groups of four characters out loud.
 * * There is no ratchet, so there is no forward secrecy: a conversation key
 *   that leaks opens that conversation's past as well as its future.
 * * Who talks to whom, and how often, is visible to the server. Encrypting
 *   content does not hide the shape of a social graph.
 */

import { z } from 'zod';

export const CONVERSATION_KIND = ['direct', 'group'] as const;
export type ConversationKind = (typeof CONVERSATION_KIND)[number];

export const CONVERSATION_ROLE = ['owner', 'member'] as const;
export type ConversationRole = (typeof CONVERSATION_ROLE)[number];

/** How many people one group may hold. */
export const MAX_GROUP_MEMBERS = 32;

/**
 * The ciphertext cap for one message body.
 *
 * Generous for text — it is base64 of an encrypted string — and deliberately
 * far short of anything that belongs in an attachment. A "message" that is
 * really a file should go through the media store, where it counts against a
 * quota and can be deleted on its own.
 */
export const MAX_MESSAGE_CIPHERTEXT = 64 * 1024;

/** How many attachments one message may carry. */
export const MAX_MESSAGE_ATTACHMENTS = 6;

/**
 * What is actually inside a sealed message body.
 *
 * A JSON envelope rather than bare text, so that everything about an
 * attachment — what it is called, and what it *is* — is encrypted along with
 * the message. The server holds the ciphertext and a media id, and can say
 * only that a file was sent, not that it was a screenshot from a particular
 * game with a filename that gives away which.
 */
export interface MessageEnvelope {
  /** The version of this shape, so a future change can be recognised. */
  v: 1;
  text: string;
  attachments?: Array<{
    mediaId: string;
    name: string;
    /** The real type, known only to the people in the conversation. */
    contentType: string;
  }>;
}

/** One sealed blob: a nonce and a ciphertext, both base64. */
export interface SealedBody {
  nonce: string;
  ciphertext: string;
}

/** A conversation key sealed for one device. */
export interface WrappedConversationKey {
  /** The device public key this was sealed for, so a client finds its own. */
  publicKey: string;
  ephemeralPublic: string;
  nonce: string;
  ciphertext: string;
}

/** One of somebody's devices, and the key messages are sealed for. */
export interface PublishedDeviceKey {
  id: string;
  userId: string;
  publicKey: string;
  label: string | null;
  createdAt: string;
  /** For reading aloud to check nobody sat in the middle. */
  fingerprint: string;
}

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
  members: ConversationMemberInfo[];
  /**
   * The wraps of this conversation's key that belong to the caller.
   *
   * One per device they have published a key for; the client opens whichever
   * matches the key it holds. Empty means nobody has sealed the key for this
   * device yet — usually a device added after the conversation started.
   */
  keys: WrappedConversationKey[];
  /** Messages since the caller last read, for the sidebar's badge. */
  unreadCount: number;
}

/** One attachment, still sealed. */
export interface MessageAttachmentInfo {
  mediaId: string;
  /** Where to fetch the ciphertext from. */
  url: string;
  sizeBytes: number;
}

export interface MessageInfo {
  id: string;
  conversationId: string;
  senderId: string | null;
  body: SealedBody;
  attachments: MessageAttachmentInfo[];
  createdAt: string;
  editedAt: string | null;
  /** True once withdrawn; the body is cleared rather than left to be decrypted. */
  deleted: boolean;
}

/* ------------------------------------------------------------------ input */

const base64 = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9+/]+=*$/, 'Expected base64');

export const sealedBodySchema = z.object({
  nonce: base64.max(64),
  ciphertext: base64.max(MAX_MESSAGE_CIPHERTEXT),
});

export const wrappedKeySchema = z.object({
  publicKey: base64.max(128),
  ephemeralPublic: base64.max(128),
  nonce: base64.max(64),
  ciphertext: base64.max(1024),
});
export type WrappedKeyInput = z.infer<typeof wrappedKeySchema>;

export const publishDeviceKeySchema = z.object({
  publicKey: base64.max(128),
  label: z.string().trim().max(64).nullable().optional(),
});
export type PublishDeviceKeyInput = z.infer<typeof publishDeviceKeySchema>;

export const createConversationSchema = z.object({
  kind: z.enum(CONVERSATION_KIND).default('direct'),
  /** Everyone in it, the caller included or not — the server adds them either way. */
  memberIds: z.array(z.string().trim().max(64)).min(1).max(MAX_GROUP_MEMBERS),
  title: z.string().trim().max(80).nullable().optional(),
  /**
   * The conversation key, already sealed for every device that should have it.
   *
   * Supplied by the client because the server cannot make one: it would have
   * to hold the plaintext key to seal it, which is the whole thing this
   * design exists to avoid.
   */
  keys: z.array(wrappedKeySchema).max(MAX_GROUP_MEMBERS * 8),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const sendMessageSchema = z.object({
  body: sealedBodySchema,
  mediaIds: z.array(z.string().trim().max(64)).max(MAX_MESSAGE_ATTACHMENTS).default([]),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const messageQuerySchema = z.object({
  /** Everything older than this message id, for scrolling back. */
  before: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessageQuery = z.infer<typeof messageQuerySchema>;

export const addMembersSchema = z.object({
  memberIds: z.array(z.string().trim().max(64)).min(1).max(MAX_GROUP_MEMBERS),
  /** Wraps of the existing conversation key for each new device. */
  keys: z.array(wrappedKeySchema).max(MAX_GROUP_MEMBERS * 8),
});
export type AddMembersInput = z.infer<typeof addMembersSchema>;

export const renameConversationSchema = z.object({
  title: z.string().trim().max(80).nullable(),
});
export type RenameConversationInput = z.infer<typeof renameConversationSchema>;

/** Sealing the key for a device that did not exist when the group was made. */
export const backfillKeysSchema = z.object({
  keys: z
    .array(wrappedKeySchema)
    .min(1)
    .max(MAX_GROUP_MEMBERS * 8),
});
export type BackfillKeysInput = z.infer<typeof backfillKeysSchema>;
