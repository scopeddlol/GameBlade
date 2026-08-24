import type {
  CreatedGameRequest,
  CreateGameRequestInput,
  DiscoveryShelf,
  GameRequestDigest,
  GameRequestInfo,
  GameRequestSuggestion,
} from '@gameblade/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc, queryString } from '../lib/ipc.js';

/**
 * The request panels: what is coming, what people are asking for, and what
 * the caller has backed.
 *
 * One endpoint behind all four panels — they come out of the same two tables,
 * and the Home tab draws them together.
 */
export function useRequestDigest(enabled = true) {
  return useQuery({
    queryKey: ['requests', 'digest'],
    queryFn: () => ipc.get<GameRequestDigest>('/requests/digest'),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * The full queue, for the client's browse-and-vote screen.
 *
 * `keepPreviousData` is what makes the status filter feel like a filter: the
 * rows for the previous status stay on screen, dimmed, while the next set
 * loads, rather than the list emptying to a spinner on every chip.
 */
export function useRequestList(status: string, enabled = true) {
  return useQuery({
    queryKey: ['requests', 'list', status],
    queryFn: () =>
      ipc.get<GameRequestInfo[]>(
        `/requests?sort=votes&limit=100${status ? `&status=${status}` : ''}`,
      ),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * The shelves the request page browses.
 *
 * Held for half an hour on the client and an hour on the server: these lists
 * are the same for everyone and move slowly, so a tab switch should never cost
 * a round trip, let alone four.
 */
export function useDiscovery(enabled = true) {
  return useQuery({
    queryKey: ['requests', 'discover'],
    queryFn: () => ipc.get<{ shelves: DiscoveryShelf[] }>('/requests/discover'),
    enabled,
    staleTime: 30 * 60_000,
  });
}

/**
 * Looking a game up to ask for it.
 *
 * Only runs once there is something worth searching for — IGDB's rate limit is
 * shared across everything the server does, and a query per keystroke would
 * spend it on prefixes nobody meant to search for. The caller debounces.
 */
export function useRequestSearch(term: string) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: ['requests', 'search', trimmed],
    queryFn: () =>
      ipc.get<{ results: GameRequestSuggestion[] }>(
        `/requests/search${queryString({ q: trimmed })}`,
      ),
    enabled: trimmed.length >= 2,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useRequestMutations() {
  const client = useQueryClient();
  const invalidate = () => void client.invalidateQueries({ queryKey: ['requests'] });

  const create = useMutation({
    mutationFn: (input: CreateGameRequestInput) => ipc.post<CreatedGameRequest>('/requests', input),
    onSuccess: invalidate,
  });

  /**
   * Backing a request, optimistically.
   *
   * The count and the tick are the entire visible result, so waiting on a
   * round trip to move them is the difference between a button that feels
   * connected to the click and one that does not.
   */
  const vote = useMutation({
    mutationFn: (input: { id: string; wanted: boolean }) =>
      input.wanted
        ? ipc.post<{ votes: number }>(`/requests/${input.id}/vote`)
        : ipc.del<{ votes: number }>(`/requests/${input.id}/vote`),

    onMutate: async ({ id, wanted }) => {
      await client.cancelQueries({ queryKey: ['requests'] });
      const snapshot = client.getQueriesData({ queryKey: ['requests'] });

      const patch = (entry: GameRequestInfo) =>
        entry.id === id
          ? { ...entry, hasVoted: wanted, votes: Math.max(0, entry.votes + (wanted ? 1 : -1)) }
          : entry;

      for (const [key, data] of snapshot) {
        if (Array.isArray(data)) {
          client.setQueryData(key, (data as GameRequestInfo[]).map(patch));
        } else if (data && typeof data === 'object' && 'comingSoon' in data) {
          const digest = data as GameRequestDigest;
          client.setQueryData(key, {
            ...digest,
            comingSoon: digest.comingSoon.map(patch),
            mostRequested: digest.mostRequested.map(patch),
            recentlyAdded: digest.recentlyAdded.map(patch),
            yours: digest.yours.map(patch),
          });
        }
      }

      return { snapshot };
    },

    onError: (_error, _input, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },

    // Only the digest is refreshed. Re-fetching the list would re-sort it by
    // votes the instant a vote lands, moving every row out from under the
    // pointer — the optimistic patch already has the counts right, and the
    // ranking is re-read when the dialog is next opened or the filter changes.
    onSettled: () => void client.invalidateQueries({ queryKey: ['requests', 'digest'] }),
  });

  return { create, vote };
}
