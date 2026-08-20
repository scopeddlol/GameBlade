import type {
  CreatedGameRequest,
  CreateGameRequestInput,
  GameRequestDigest,
  GameRequestInfo,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../lib/ipc.js';

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

/** The full queue, for the client's browse-and-vote screen. */
export function useRequestList(status: string, enabled = true) {
  return useQuery({
    queryKey: ['requests', 'list', status],
    queryFn: () =>
      ipc.get<GameRequestInfo[]>(
        `/requests?sort=votes&limit=100${status ? `&status=${status}` : ''}`,
      ),
    enabled,
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
