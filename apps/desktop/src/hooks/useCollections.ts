import type { CollectionColor, CollectionInfo } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../lib/ipc.js';

/**
 * The caller's own groups of games.
 *
 * Groups are per-account and small — a few dozen at most — so the list is
 * fetched once and kept warm rather than paged. Every mutation refreshes it,
 * because the counts on each group change with the membership.
 */
export function useCollections(enabled = true) {
  return useQuery({
    queryKey: ['collections'],
    queryFn: () => ipc.get<CollectionInfo[]>('/collections'),
    enabled,
    staleTime: 60_000,
  });
}

export function useCollectionMutations() {
  const client = useQueryClient();
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['collections'] });
    // A group filter is part of the library's query key, so its page has to
    // come back too once membership changes.
    void client.invalidateQueries({ queryKey: ['games', 'library'] });
    void client.invalidateQueries({ queryKey: ['collection-membership'] });
  };

  const create = useMutation({
    mutationFn: (input: { name: string; color: CollectionColor }) =>
      ipc.post<CollectionInfo>('/collections', input),
    onSuccess: invalidate,
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string; color: CollectionColor }) =>
      ipc.put<CollectionInfo>(`/collections/${input.id}`, {
        name: input.name,
        color: input.color,
      }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => ipc.del<void>(`/collections/${id}`),
    onSuccess: invalidate,
  });

  const addGames = useMutation({
    mutationFn: (input: { id: string; gameIds: string[] }) =>
      ipc.post<{ added: number }>(`/collections/${input.id}/games`, { gameIds: input.gameIds }),
    onSuccess: invalidate,
  });

  const removeGames = useMutation({
    mutationFn: (input: { id: string; gameIds: string[] }) =>
      // A body on a DELETE is what keeps this symmetrical with the add; the
      // ids are a list, and a query string is the wrong place for one.
      ipc.post<void>(`/collections/${input.id}/games/remove`, { gameIds: input.gameIds }),
    onSuccess: invalidate,
  });

  return { create, rename, remove, addGames, removeGames };
}

/** Which groups a single game already belongs to, for the context menu's ticks. */
export function useGameCollections(gameId: string | null) {
  return useQuery({
    queryKey: ['collection-membership', gameId],
    queryFn: () =>
      ipc.post<Record<string, string[]>>('/collections/membership', { gameIds: [gameId] }),
    enabled: Boolean(gameId),
    select: (data) => (gameId ? (data[gameId] ?? []) : []),
    staleTime: 30_000,
  });
}
