import type { ConversationInfo, MessageInfo, MessageReactionInfo } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../lib/ipc.js';

/** An image on the clipboard, held in memory until the message is sent. */
export interface PastedImage {
  /** Only for the composer's own thumbnail; never written anywhere. */
  previewUrl: string;
  /**
   * The image as base64.
   *
   * Not a byte array: the IPC bridge serialises arguments as JSON, and a
   * two-megabyte screenshot becomes two million array elements — slow to
   * encode and several times the size as text. A string is neither.
   */
  data: string;
  contentType: string;
}

/** Everybody this account has muted, for the chat and the settings list. */
export function useMutedUsers(enabled = true) {
  return useQuery({
    queryKey: ['messages', 'mutes'],
    queryFn: () =>
      ipc.get<{ muted: Array<{ userId: string; username: string; displayName: string }> }>(
        '/messages/mutes',
      ),
    enabled,
    select: (data) => data.muted,
    staleTime: 5 * 60_000,
  });
}

/** Mutes somebody, or unmutes them. Never visible on their side. */
export function useMuteMutations() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, muted }: { userId: string; muted: boolean }) =>
      muted ? ipc.put(`/messages/mutes/${userId}`) : ipc.del(`/messages/mutes/${userId}`),
    onSuccess: () => {
      // Muting changes what every thread and every badge should say, so all of
      // it is refetched rather than patched in three places.
      void client.invalidateQueries({ queryKey: ['messages'] });
    },
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

export function useMessageMutations(conversationId: string | null) {
  const client = useQueryClient();

  const refreshThread = () => {
    void client.invalidateQueries({ queryKey: ['messages', 'thread', conversationId] });
    void client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
    void client.invalidateQueries({ queryKey: ['messages', 'unread'] });
  };

  const start = useMutation({
    mutationFn: (input: { kind: 'direct' | 'group'; memberIds: string[]; title?: string | null }) =>
      ipc
        .post<{ conversation: ConversationInfo }>('/messages/conversations', input)
        .then((result) => result.conversation),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['messages', 'conversations'] });
    },
  });

  const send = useMutation({
    mutationFn: async (input: {
      body: string;
      attachments?: string[];
      /** Images pasted from the clipboard, which were never files. */
      pasted?: PastedImage[];
      replyToId?: string | null;
      gameId?: string | null;
    }) => {
      // Uploaded first, because the message names the ids it carries.
      const mediaIds: string[] = [];
      for (const filePath of input.attachments ?? []) {
        const uploaded = await ipc.uploadMedia(filePath, isClip(filePath) ? 'clip' : 'image');
        mediaIds.push(uploaded.id);
      }
      for (const image of input.pasted ?? []) {
        const uploaded = await ipc.uploadMediaBytes(image.data, image.contentType, 'image');
        mediaIds.push(uploaded.id);
      }

      return ipc.post<{ message: MessageInfo }>(
        `/messages/conversations/${conversationId}/messages`,
        {
          body: input.body,
          mediaIds,
          replyToId: input.replyToId ?? null,
          gameId: input.gameId ?? null,
        },
      );
    },
    onSuccess: refreshThread,
  });

  /**
   * Adds a reaction, or takes it back when it is already there.
   *
   * Optimistic, because a reaction that waits on a round trip to light up feels
   * broken — it is the one gesture in a chat with no other acknowledgement.
   */
  const react = useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      ipc.post<{ reactions: MessageReactionInfo[] }>(`/messages/${messageId}/reactions`, { emoji }),
    onMutate: ({ messageId, emoji }) => {
      const key = ['messages', 'thread', conversationId];
      const previous = client.getQueryData<{ messages: MessageInfo[] }>(key);

      client.setQueryData<{ messages: MessageInfo[] }>(key, (current) =>
        current
          ? {
              messages: current.messages.map((message) =>
                message.id === messageId
                  ? { ...message, reactions: toggleReaction(message.reactions, emoji) }
                  : message,
              ),
            }
          : current,
      );

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        client.setQueryData(['messages', 'thread', conversationId], context.previous);
      }
    },
    onSuccess: (result, variables) => {
      // The server's tallies replace the guess; they differ whenever somebody
      // else reacted between the click and the answer.
      client.setQueryData<{ messages: MessageInfo[] }>(
        ['messages', 'thread', conversationId],
        (current) =>
          current
            ? {
                messages: current.messages.map((message) =>
                  message.id === variables.messageId
                    ? { ...message, reactions: result.reactions }
                    : message,
                ),
              }
            : current,
      );
    },
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
    mutationFn: (memberIds: string[]) =>
      ipc.post<{ conversation: ConversationInfo }>(
        `/messages/conversations/${conversationId}/members`,
        { memberIds },
      ),
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

  return { start, send, react, withdraw, markRead, addMembers, rename, leave };
}

/** Which upload kind a chosen file is, from its extension. */
function isClip(filePath: string): boolean {
  return /\.(mp4|webm|m4v)$/i.test(filePath);
}

/** What the tallies look like the instant after a click, before the server answers. */
function toggleReaction(reactions: MessageReactionInfo[], emoji: string): MessageReactionInfo[] {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (!existing) return [...reactions, { emoji, count: 1, mine: true }];

  if (existing.mine) {
    // Taking back the only reaction leaves no row rather than a zero.
    return existing.count <= 1
      ? reactions.filter((reaction) => reaction.emoji !== emoji)
      : reactions.map((reaction) =>
          reaction.emoji === emoji
            ? { ...reaction, count: reaction.count - 1, mine: false }
            : reaction,
        );
  }

  return reactions.map((reaction) =>
    reaction.emoji === emoji ? { ...reaction, count: reaction.count + 1, mine: true } : reaction,
  );
}
