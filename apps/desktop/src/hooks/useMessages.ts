import type { ConversationInfo, MessageInfo } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../lib/ipc.js';

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
    mutationFn: async (input: { body: string; attachments?: string[] }) => {
      // Uploaded first, because the message names the ids it carries.
      const mediaIds: string[] = [];
      for (const filePath of input.attachments ?? []) {
        const uploaded = await ipc.uploadMedia(filePath, isClip(filePath) ? 'clip' : 'image');
        mediaIds.push(uploaded.id);
      }

      return ipc.post<{ message: MessageInfo }>(
        `/messages/conversations/${conversationId}/messages`,
        { body: input.body, mediaIds },
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

  return { start, send, withdraw, markRead, addMembers, rename, leave };
}

/** Which upload kind a chosen file is, from its extension. */
function isClip(filePath: string): boolean {
  return /\.(mp4|webm|m4v)$/i.test(filePath);
}
