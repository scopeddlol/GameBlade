import type { GameSummary, Paginated, StoreFacets } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GameCard } from '../components/GameCard.js';
import { Empty, ErrorNote, Loading } from '../components/ui.js';
import { errorMessage, ipc, queryString } from '../lib/ipc.js';

interface Filters extends StoreFacets {
  libraries: Array<{ id: string; name: string }>;
}

const SORTS = [
  { id: 'added', label: 'Newest' },
  { id: 'title', label: 'Title' },
  { id: 'rating', label: 'Best rated' },
  { id: 'released', label: 'Release date' },
  { id: 'size', label: 'Size' },
] as const;

/**
 * Everything on the server, browsable and addable.
 *
 * Games already in the library are shown rather than hidden — seeing the whole
 * archive is the point of a store, and a tick beside what you own reads better
 * than a catalog that mysteriously shrinks as you use it.
 */
export function StoreTab({ onOpenGame }: { onOpenGame: (game: GameSummary) => void }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [genre, setGenre] = useState('');
  const [sort, setSort] = useState<(typeof SORTS)[number]['id']>('added');
  const [showFilters, setShowFilters] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const filtersQuery = useQuery({
    queryKey: ['store', 'filters'],
    queryFn: () => ipc.get<Filters>('/games/filters'),
    staleTime: 5 * 60_000,
  });

  const gamesQuery = useQuery({
    queryKey: ['games', 'store', debounced, genre, sort],
    queryFn: () =>
      ipc.get<Paginated<GameSummary>>(
        `/games${queryString({
          search: debounced,
          genre,
          sort,
          order: sort === 'title' ? 'asc' : 'desc',
          limit: 120,
        })}`,
      ),
  });

  const addMutation = useMutation({
    mutationFn: (gameId: string) => ipc.post(`/games/${gameId}/library`),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['games'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const genres = filtersQuery.data?.genres ?? [];

  return (
    <div className="tab-content">
      <div className="toolbar">
        <div className="search-box">
          <Search size={15} aria-hidden />
          <input
            type="search"
            placeholder="Search the archive…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search the archive"
          />
        </div>

        <button
          type="button"
          className={clsx('btn btn-ghost', showFilters && 'active')}
          onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters}
        >
          <SlidersHorizontal size={15} aria-hidden />
          Filters
        </button>

        <select
          className="select"
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          aria-label="Sort by"
        >
          {SORTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {showFilters && genres.length > 0 ? (
        <div className="chip-row">
          <button
            type="button"
            className={clsx('chip', genre === '' && 'active')}
            onClick={() => setGenre('')}
          >
            All genres
          </button>
          {genres.slice(0, 24).map((entry) => (
            <button
              key={entry.value}
              type="button"
              className={clsx('chip', genre === entry.value && 'active')}
              onClick={() => setGenre(genre === entry.value ? '' : entry.value)}
            >
              {entry.value}
              <span className="muted small"> {entry.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <ErrorNote message={error} />

      {gamesQuery.isLoading ? (
        <Loading label="Loading the archive" />
      ) : (gamesQuery.data?.items ?? []).length === 0 ? (
        <Empty
          title="Nothing matches"
          message="Try a different search, or clear the genre filter."
        />
      ) : (
        <>
          <p className="muted small result-count">
            {gamesQuery.data?.total.toLocaleString()} games
          </p>
          <div className="grid">
            {(gamesQuery.data?.items ?? []).map((game) => (
              <GameCard
                key={game.id}
                game={game}
                onOpen={onOpenGame}
                primaryLabel="add"
                busy={game.inLibrary || addMutation.isPending}
                onPrimary={() => addMutation.mutate(game.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
