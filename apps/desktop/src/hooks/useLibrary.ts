import type { GameDetail, GameSummary, Paginated } from '@gameblade/shared';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ipc } from '../lib/ipc.js';

/** Every cached page that could be holding this game, plus its detail record. */
type Snapshot = Array<[readonly unknown[], unknown]>;

/** True for a page of games; false for the detail record under the same prefix. */
function isPage(data: unknown): data is Paginated<GameSummary> {
  return Boolean(data) && Array.isArray((data as Paginated<GameSummary>).items);
}

/**
 * Rewrites `inLibrary` on every cached copy of one game.
 *
 * The same game is in the store list, the library list and possibly an open
 * detail panel at once. Patching them all in place is what makes the button
 * flip instantly; invalidating instead would blank every list on screen while
 * it refetched.
 */
function patchCaches(client: QueryClient, gameId: string, inLibrary: boolean): void {
  for (const [key, data] of client.getQueriesData({ queryKey: ['games'] })) {
    if (!isPage(data)) continue;
    client.setQueryData(key, {
      ...data,
      items: data.items.map((game) => (game.id === gameId ? { ...game, inLibrary } : game)),
    });
  }

  // The detail panel shares the `games` prefix but holds a single record, not
  // a page, so it is patched by its own key rather than by the loop above.
  const detail = client.getQueryData<GameDetail>(['games', gameId]);
  if (detail) client.setQueryData(['games', gameId], { ...detail, inLibrary });
}

/**
 * Adds a game to the caller's library, optimistically.
 *
 * The round trip used to gate the whole grid: one shared `isPending` disabled
 * every card at once, and the success handler invalidated every `['games']`
 * query, so the list flickered as it refetched. Neither is needed — the server
 * either accepts the add or it does not, and a failure rolls the one card back.
 */
export function useAddToLibrary() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (gameId: string) => ipc.post(`/games/${gameId}/library`),

    onMutate: async (gameId: string) => {
      // An in-flight list refetch would otherwise land on top of the patch and
      // put the button back to "Add".
      await client.cancelQueries({ queryKey: ['games'] });

      const snapshot: Snapshot = client.getQueriesData({ queryKey: ['games'] });
      patchCaches(client, gameId, true);
      return { snapshot };
    },

    onError: (_error, _gameId, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },

    onSettled: () => {
      // Only the views the add actually changes: the store page the user is
      // looking at is already correct, and refetching it is the flicker.
      void client.invalidateQueries({ queryKey: ['games', 'library'] });
      void client.invalidateQueries({ queryKey: ['home'] });
    },
  });
}

/** The mirror image, used by the detail panel's "remove from library". */
export function useRemoveFromLibrary() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (gameId: string) => ipc.del(`/games/${gameId}/library`),

    onMutate: async (gameId: string) => {
      await client.cancelQueries({ queryKey: ['games'] });
      const snapshot: Snapshot = client.getQueriesData({ queryKey: ['games'] });
      patchCaches(client, gameId, false);
      return { snapshot };
    },

    onError: (_error, _gameId, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },

    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['games', 'library'] });
      void client.invalidateQueries({ queryKey: ['home'] });
    },
  });
}
