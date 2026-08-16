import type { GameSummary, Paginated } from '@gameblade/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GameGrid } from '../components/GameCard.js';
import { EmptyState, ErrorState, PageLoader, Spinner } from '../components/ui.js';
import { api, queryString } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

interface Filters {
  genres: string[];
  platforms: string[];
  libraries: Array<{ id: string; name: string }>;
}

const PAGE_SIZE = 60;

const SORTS = [
  { value: 'title', label: 'Title' },
  { value: 'added', label: 'Recently added' },
  { value: 'released', label: 'Release date' },
  { value: 'size', label: 'Size' },
  { value: 'rating', label: 'Rating' },
] as const;

export function LibraryPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get('q') ?? '';
  const genre = searchParams.get('genre') ?? '';
  const platform = searchParams.get('platform') ?? '';
  const libraryId = searchParams.get('library') ?? '';
  const favoritesOnly = searchParams.get('favorites') === '1';
  const sort = searchParams.get('sort') ?? 'title';
  const order = searchParams.get('order') ?? (sort === 'title' ? 'asc' : 'desc');
  const page = Number(searchParams.get('page') ?? '0');

  // Local mirror so typing stays responsive; the URL updates after a pause.
  const [searchInput, setSearchInput] = useState(search);
  useEffect(() => setSearchInput(search), [search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput === search) return;
      updateParams({ q: searchInput || null, page: null });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  function updateParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  }

  const filtersQuery = useQuery({
    queryKey: ['games', 'filters'],
    queryFn: () => api.get<Filters>('/games/filters'),
    staleTime: 5 * 60_000,
  });

  const listKey = [
    'games',
    { search, genre, platform, libraryId, favoritesOnly, sort, order, page },
  ];

  const gamesQuery = useQuery({
    queryKey: listKey,
    queryFn: () =>
      api.get<Paginated<GameSummary>>(
        `/games${queryString({
          search,
          genre,
          platform,
          libraryId,
          favoritesOnly: favoritesOnly || undefined,
          sort,
          order,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        })}`,
      ),
    // Keeps the previous page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });

  const favoriteMutation = useMutation({
    mutationFn: (game: GameSummary) =>
      api.post(`/games/${game.id}/favorite`, { favorite: !game.isFavorite }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['games'] }),
  });

  const total = gamesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const hasActiveFilters = Boolean(genre || platform || libraryId || favoritesOnly || search);

  const totalBytes = useMemo(
    () => (gamesQuery.data?.items ?? []).reduce((sum, g) => sum + g.sizeBytes, 0),
    [gamesQuery.data],
  );

  if (gamesQuery.isLoading && !gamesQuery.data) return <PageLoader label="Loading library" />;

  if (gamesQuery.isError) {
    return (
      <ErrorState
        title="Could not load the library"
        message={(gamesQuery.error as Error).message}
        action={
          <button type="button" className="gb-btn-ghost" onClick={() => gamesQuery.refetch()}>
            Try again
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="text-ink-400 absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            type="search"
            className="gb-input pl-9"
            placeholder="Search games…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search games"
          />
        </div>

        <select
          className="gb-input w-auto"
          value={sort}
          onChange={(e) =>
            updateParams({
              sort: e.target.value,
              order: e.target.value === 'title' ? 'asc' : 'desc',
              page: null,
            })
          }
          aria-label="Sort by"
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="gb-btn-ghost"
          onClick={() => updateParams({ order: order === 'asc' ? 'desc' : 'asc', page: null })}
          aria-label={`Sort ${order === 'asc' ? 'descending' : 'ascending'}`}
        >
          {order === 'asc' ? 'A→Z' : 'Z→A'}
        </button>

        {filtersQuery.data?.genres.length ? (
          <select
            className="gb-input w-auto"
            value={genre}
            onChange={(e) => updateParams({ genre: e.target.value || null, page: null })}
            aria-label="Filter by genre"
          >
            <option value="">All genres</option>
            {filtersQuery.data.genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        ) : null}

        {filtersQuery.data && filtersQuery.data.libraries.length > 1 ? (
          <select
            className="gb-input w-auto"
            value={libraryId}
            onChange={(e) => updateParams({ library: e.target.value || null, page: null })}
            aria-label="Filter by library"
          >
            <option value="">All libraries</option>
            {filtersQuery.data.libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        ) : null}

        <button
          type="button"
          onClick={() => updateParams({ favorites: favoritesOnly ? null : '1', page: null })}
          aria-pressed={favoritesOnly}
          className={favoritesOnly ? 'gb-btn-primary' : 'gb-btn-ghost'}
        >
          <Heart className={favoritesOnly ? 'h-4 w-4 fill-current' : 'h-4 w-4'} aria-hidden />
          Favourites
        </button>

        {hasActiveFilters ? (
          <button
            type="button"
            className="gb-btn-ghost"
            onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
          >
            <X className="h-4 w-4" aria-hidden />
            Clear
          </button>
        ) : null}
      </div>

      <div className="text-ink-400 flex items-center gap-2 text-sm">
        <span>
          {total} {total === 1 ? 'game' : 'games'}
          {gamesQuery.data && gamesQuery.data.items.length < total
            ? ` · showing ${gamesQuery.data.items.length}`
            : ''}
          {totalBytes > 0 ? ` · ${formatBytes(totalBytes)} on this page` : ''}
        </span>
        {gamesQuery.isFetching ? <Spinner className="h-4 w-4" /> : null}
      </div>

      {gamesQuery.data && gamesQuery.data.items.length === 0 ? (
        <EmptyState
          title={hasActiveFilters ? 'No games match those filters' : 'The library is empty'}
          message={
            hasActiveFilters
              ? 'Try clearing the search or filters.'
              : 'Add a library folder and run a scan from the Admin page.'
          }
        />
      ) : (
        <GameGrid
          games={gamesQuery.data?.items ?? []}
          onToggleFavorite={(game) => favoriteMutation.mutate(game)}
        />
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-center gap-3 pt-4">
          <button
            type="button"
            className="gb-btn-ghost"
            disabled={page <= 0}
            onClick={() => updateParams({ page: String(page - 1) })}
          >
            Previous
          </button>
          <span className="text-ink-400 text-sm">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            className="gb-btn-ghost"
            disabled={page + 1 >= totalPages}
            onClick={() => updateParams({ page: String(page + 1) })}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
