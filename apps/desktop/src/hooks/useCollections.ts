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

/** The membership cache's raw shape: game id to the groups it is filed under. */
type Membership = Record<string, string[]>;

export function useCollectionMutations() {
  const client = useQueryClient();
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['collections'] });
    // A group filter is part of the library's query key, so its page has to
    // come back too once membership changes.
    void client.invalidateQueries({ queryKey: ['games', 'library'] });
    void client.invalidateQueries({ queryKey: ['collection-membership'] });
  };

  /**
   * Files games into a group, or takes them out, in the cache alone.
   *
   * Filing a game is a tick and a number moving by one, and waiting for a
   * round trip to draw either of them is what made clicking a group feel
   * unresponsive. The cached copies move first and are put back if the server
   * refuses.
   */
  const patch = (gameIds: string[], collectionId: string, member: boolean) => {
    for (const gameId of gameIds) {
      client.setQueriesData<Membership>(
        { queryKey: ['collection-membership', gameId] },
        (current) => {
          if (!current) return current;
          const groups = current[gameId] ?? [];
          const already = groups.includes(collectionId);
          if (already === member) return current;
          return {
            ...current,
            [gameId]: member
              ? [...groups, collectionId]
              : groups.filter((entry) => entry !== collectionId),
          };
        },
      );
    }

    // The count on the row is part of the same answer, so it moves with it.
    client.setQueryData<CollectionInfo[]>(['collections'], (current) =>
      current?.map((entry) =>
        entry.id === collectionId
          ? {
              ...entry,
              gameCount: Math.max(0, entry.gameCount + (member ? gameIds.length : -gameIds.length)),
            }
          : entry,
      ),
    );
  };

  /**
   * Snapshots what `patch` is about to touch so a failure can undo it.
   *
   * Taken before the write and replayed wholesale on error: reversing the
   * patch instead would clobber a second toggle that landed in between.
   */
  const snapshot = (gameIds: string[]) => {
    const membership = gameIds.map(
      (gameId) =>
        [gameId, client.getQueryData<Membership>(['collection-membership', gameId])] as const,
    );
    return { membership, collections: client.getQueryData<CollectionInfo[]>(['collections']) };
  };

  const restore = (saved: ReturnType<typeof snapshot> | undefined) => {
    if (!saved) return;
    for (const [gameId, data] of saved.membership) {
      if (data) client.setQueryData(['collection-membership', gameId], data);
    }
    if (saved.collections) client.setQueryData(['collections'], saved.collections);
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
    onMutate: async (input) => {
      // Without this an in-flight read can land after the patch and undo it.
      await client.cancelQueries({ queryKey: ['collection-membership'] });
      const saved = snapshot(input.gameIds);
      patch(input.gameIds, input.id, true);
      return saved;
    },
    onError: (_error, _input, saved) => restore(saved),
    onSettled: invalidate,
  });

  const removeGames = useMutation({
    mutationFn: (input: { id: string; gameIds: string[] }) =>
      // A body on a DELETE is what keeps this symmetrical with the add; the
      // ids are a list, and a query string is the wrong place for one.
      ipc.post<void>(`/collections/${input.id}/games/remove`, { gameIds: input.gameIds }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: ['collection-membership'] });
      const saved = snapshot(input.gameIds);
      patch(input.gameIds, input.id, false);
      return saved;
    },
    onError: (_error, _input, saved) => restore(saved),
    onSettled: invalidate,
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
