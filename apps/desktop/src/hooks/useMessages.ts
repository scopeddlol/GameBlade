import type {
  ConversationInfo,
  MessageEnvelope,
  MessageInfo,
  PublishedDeviceKey,
  SealedBody,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc.js';

/**
 * Conversation keys, held for as long as the app is open and no longer.
 *
 * Deliberately not persisted. The wrapped copy on the server is the durable
 * one; this is the plaintext, and writing it anywhere would undo most of what
 * wrapping it bought. A restart re-opens each key from its wrap, which costs
 * one ECDH per conversation and is not worth optimising away.
 */
const keyring = new Map<string, string>();

/** Decrypted bodies, so scrolling a thread does not re-decrypt what is on screen. */
const plaintext = new Map<string, MessageEnvelope>();

/**
 * Publishes this device's public key on sign-in.
 *
 * Every start rather than once at setup: a reinstalled client has a new
 * identity, and one that has not changed gets a cheap no-op. Until this has
 * run, nobody can seal a conversation key for this machine — so it is the
 * first thing the Messages tab depends on.
 */
export function useMessageIdentity(enabled: boolean) {
  return useQuery({
    queryKey: ['messages', 'identity'],
    queryFn: async () => {
      const identity = await ipc.messageIdentity();
      await ipc.post('/messages/devices', {
        publicKey: identity.publicKey,
        label: 'Desktop',
      });
      return identity;
    },
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export function useConversations(enabled: boolean) {
  return useQuery({
    queryKey: ['messages', 'conversations'],
    queryFn: () => ipc.get<{ conversations: ConversationInfo[] }>('/messages/conversations'),
    enabled,
    select: (data) => data.conversations,
  });
}

export function useUnreadMessages(enabled: boolean) {
  return useQuery({
    queryKey: ['messages', 'unread'],
    queryFn: () => ipc.get<{ unread: number }>('/messages/unread'),
    enabled,
    select: (data) => data.unread,
    // The realtime socket pushes new messages, so this is only the safety net
    // for a frame that never arrived.
    refetchInterval: 120_000,
  });
}

/**
 * Opens a conversation's key, from whichever wrap belongs to this device.
 *
 * A conversation with no wrap for this machine is not broken — it is one that
 * started before this device existed, and somebody else's client has to seal
 * the key for it. That is reported rather than hidden, because "no messages"
 * and "cannot read these messages" are very different things to be told.
 */
export function useConversationKey(conversation: ConversationInfo | null) {
  const [key, setKey] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'ready' | 'no-key' | 'failed'>('idle');

  useEffect(() => {
    if (!conversation) {
      setKey(null);
      setState('idle');
      return;
    }

    const cached = keyring.get(conversation.id);
    if (cached) {
      setKey(cached);
      setState('ready');
      return;
    }

    let canceled = false;

    void (async () => {
      const identity = await ipc.messageIdentity().catch(() => null);
      const mine = identity
        ? conversation.keys.find((entry) => entry.publicKey === identity.publicKey)
        : undefined;

      if (!mine) {
        if (!canceled) setState('no-key');
        return;
      }

      try {
        const opened = await ipc.openConversationKey({
          ephemeralPublic: mine.ephemeralPublic,
          nonce: mine.nonce,
          ciphertext: mine.ciphertext,
        });
        keyring.set(conversation.id, opened);
        if (!canceled) {
          setKey(opened);
          setState('ready');
        }
      } catch {
        // A wrap that will not open is a substituted or corrupted key. Neither
        // is something to paper over.
        if (!canceled) setState('failed');
      }
    })();

    return () => {
      canceled = true;
    };
  }, [conversation]);

  return { key, state };
}

/** One conversation's history, oldest first. */
export function useConversationMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ['messages', 'thread', conversationId],
    queryFn: () =>
      ipc.get<{ messages: MessageInfo[] }>(
        `/messages/conversations/${conversationId}/messages?limit=100`,
      ),
    enabled: Boolean(conversationId),
    select: (data) => data.messages,
  });
}

/**
 * Opens a message body, once.
 *
 * The plaintext is a JSON envelope rather than bare text, so an attachment's
 * name and type are encrypted along with the message — the server can say a
 * file was sent, and not that it was a screenshot whose filename gives away
 * which game.
 *
 * Cached across renders because a thread re-renders on every arriving message,
 * and re-running the cipher over everything on screen each time is work nobody
 * asked for.
 */
export function useEnvelope(
  messageId: string,
  body: SealedBody,
  conversationKey: string | null,
  deleted: boolean,
): MessageEnvelope | null {
  const [envelope, setEnvelope] = useState<MessageEnvelope | null>(
    () => plaintext.get(messageId) ?? null,
  );

  useEffect(() => {
    if (deleted || !conversationKey) return;

    const cached = plaintext.get(messageId);
    if (cached !== undefined) {
      setEnvelope(cached);
      return;
    }

    let canceled = false;
    void ipc
      .openMessage(conversationKey, body)
      .then((opened) => {
        const parsed = parseEnvelope(opened);
        plaintext.set(messageId, parsed);
        if (!canceled) setEnvelope(parsed);
      })
      .catch(() => {
        // Sent under a key this device does not have — which happens when a
        // conversation was re-keyed — or genuinely corrupt. Either way there
        // is nothing to show, and saying so is better than showing noise.
        if (!canceled) setEnvelope(null);
      });

    return () => {
      canceled = true;
    };
  }, [messageId, body, conversationKey, deleted]);

  return envelope;
}

/**
 * Reads an opened body, tolerating one that is not an envelope at all.
 *
 * Everything this client sends is JSON, but the format has a version for a
 * reason and a message from a future or older build should render as text
 * rather than as an error.
 */
function parseEnvelope(plain: string): MessageEnvelope {
  try {
    const parsed = JSON.parse(plain) as Partial<MessageEnvelope>;
    if (parsed && typeof parsed.text === 'string') {
      return { v: 1, text: parsed.text, attachments: parsed.attachments ?? [] };
    }
  } catch {
    // Not JSON; treat the whole thing as what somebody wrote.
  }
  return { v: 1, text: plain, attachments: [] };
}

/** The people the caller can start a conversation with, and their device keys. */
export function useDeviceKeys(userIds: string[]) {
  const key = [...userIds].sort().join(',');
  return useQuery({
    queryKey: ['messages', 'keys', key],
    queryFn: () => ipc.get<{ keys: PublishedDeviceKey[] }>(`/messages/keys?userIds=${key}`),
    enabled: userIds.length > 0,
    select: (data) => data.keys,
    staleTime: 60_000,
  });
}

export function useMessageMutations(conversationId: string | null) {
  const client = useQueryClient();

  const refreshThread = () => {
    void client.invalidateQueries({ queryKey: ['messages', 'thread', conversationId] });
    void client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
    void client.invalidateQueries({ queryKey: ['messages', 'unread'] });
  };

  /**
   * Starts a conversation, sealing a fresh key for every device involved.
   *
   * The key is made inside the Rust command and comes back alongside its
   * wraps, so the plaintext exists here only long enough to be put in the
   * session keyring — never on disk, never near the server.
   */
  const start = useMutation({
    mutationFn: async (input: {
      kind: 'direct' | 'group';
      memberIds: string[];
      title?: string | null;
    }) => {
      const identity = await ipc.messageIdentity();
      const theirs = await ipc.get<{ keys: PublishedDeviceKey[] }>(
        `/messages/keys?userIds=${input.memberIds.join(',')}`,
      );

      const recipients = [
        identity.publicKey,
        ...theirs.keys.map((entry) => entry.publicKey),
      ].filter((value, index, all) => all.indexOf(value) === index);

      const { key, wraps } = await ipc.sealConversationKey(recipients);

      const created = await ipc.post<{ conversation: ConversationInfo }>(
        '/messages/conversations',
        { ...input, keys: wraps },
      );

      keyring.set(created.conversation.id, key);
      return created.conversation;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
    },
  });

  const send = useMutation({
    mutationFn: async (input: {
      conversationKey: string;
      text: string;
      attachments?: Array<{ path: string; name: string; contentType: string }>;
    }) => {
      // Uploaded first, because the envelope has to name the ids — and the
      // envelope is what gets sealed, so an attachment's real name and type
      // never leave this machine in the clear.
      const described: MessageEnvelope['attachments'] = [];
      for (const attachment of input.attachments ?? []) {
        const uploaded = await ipc.uploadMedia(attachment.path, 'sealed');
        described.push({
          mediaId: uploaded.id,
          name: attachment.name,
          contentType: attachment.contentType,
        });
      }

      const envelope: MessageEnvelope = { v: 1, text: input.text, attachments: described };
      const body = await ipc.sealMessage(input.conversationKey, JSON.stringify(envelope));

      return ipc.post<{ message: MessageInfo }>(
        `/messages/conversations/${conversationId}/messages`,
        { body, mediaIds: described.map((entry) => entry.mediaId) },
      );
    },
    onSuccess: refreshThread,
  });

  const withdraw = useMutation({
    mutationFn: (messageId: string) => ipc.del(`/messages/${messageId}`),
    onSuccess: refreshThread,
  });

  const markRead = useMutation({
    mutationFn: () => ipc.post(`/messages/conversations/${conversationId}/read`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['messages', 'unread'] });
      void client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
    },
  });

  const addMembers = useMutation({
    mutationFn: async (input: { conversationKey: string; memberIds: string[] }) => {
      const theirs = await ipc.get<{ keys: PublishedDeviceKey[] }>(
        `/messages/keys?userIds=${input.memberIds.join(',')}`,
      );
      const wraps = await ipc.rewrapConversationKey(
        input.conversationKey,
        theirs.keys.map((entry) => entry.publicKey),
      );

      return ipc.post<{ conversation: ConversationInfo }>(
        `/messages/conversations/${conversationId}/members`,
        { memberIds: input.memberIds, keys: wraps },
      );
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
    },
  });

  const rename = useMutation({
    mutationFn: (title: string | null) =>
      ipc.patch(`/messages/conversations/${conversationId}`, { title }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
    },
  });

  const leave = useMutation({
    mutationFn: (userId: string) =>
      ipc.del(`/messages/conversations/${conversationId}/members/${userId}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
    },
  });

  return { start, send, withdraw, markRead, addMembers, rename, leave };
}

/**
 * Seals the conversation key for devices nobody has sealed it for yet.
 *
 * The case this exists for: somebody signs in on a second machine, which
 * publishes a new key that no existing conversation has a wrap for. Any member
 * who *can* read the conversation notices the gap and closes it — which is
 * everyone else's client, quietly, the next time they open the thread.
 */
export function useKeyBackfill(
  conversation: ConversationInfo | null,
  conversationKey: string | null,
) {
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!conversation || !conversationKey) return;
    if (attempted.current === conversation.id) return;
    attempted.current = conversation.id;

    void (async () => {
      const memberIds = conversation.members
        .filter((member) => member.leftAt === null)
        .map((member) => member.userId);

      const known = new Set(conversation.keys.map((entry) => entry.publicKey));
      const theirs = await ipc
        .get<{ keys: PublishedDeviceKey[] }>(`/messages/keys?userIds=${memberIds.join(',')}`)
        .catch(() => null);
      if (!theirs) return;

      // The server only tells each caller about their *own* wraps, so a
      // device's absence cannot be read from `conversation.keys` alone. Sealing
      // one that already exists is harmless — the insert is a no-op — so the
      // cheap correct thing is to offer a wrap for every device and let the
      // server drop the duplicates.
      const missing = theirs.keys
        .map((entry) => entry.publicKey)
        .filter((publicKey) => !known.has(publicKey));

      if (missing.length === 0) return;

      const wraps = await ipc.rewrapConversationKey(conversationKey, missing).catch(() => null);
      if (!wraps || wraps.length === 0) return;

      await ipc
        .post(`/messages/conversations/${conversation.id}/keys`, { keys: wraps })
        .catch(() => undefined);
    })();
  }, [conversation, conversationKey]);
}

/** Drops every plaintext key and body. Called on sign-out. */
export function forgetMessageSecrets(): void {
  keyring.clear();
  plaintext.clear();
}
