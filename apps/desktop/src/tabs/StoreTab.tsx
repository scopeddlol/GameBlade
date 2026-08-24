import type { GameSummary, Paginated, StoreFacets } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { MessageSquarePlus, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CollectionPicker } from '../components/CollectionPicker.js';
import { InstallDialog, useInstallDialog } from '../components/InstallDialog.js';
import { ContextMenu, useContextMenu } from '../components/ContextMenu.js';
import { GameCard } from '../components/GameCard.js';
import { useGameMenuItems } from '../components/GameContextMenu.js';
import { RequestsDialog } from '../components/GameRequests.js';
import { Empty, ErrorNote, GridSkeleton } from '../components/ui.js';
import { useAddToLibrary } from '../hooks/useLibrary.js';
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
export function StoreTab({
  onOpenGame,
  onOpenGameId,
}: {
  onOpenGame: (game: GameSummary) => void;
  /** Opens a game the user has never seen in a list — a fulfilled request. */
  onOpenGameId?: (gameId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [genre, setGenre] = useState('');
  const [sort, setSort] = useState<(typeof SORTS)[number]['id']>('added');
  const [showFilters, setShowFilters] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [grouping, setGrouping] = useState<GameSummary | null>(null);

  const menu = useContextMenu<GameSummary>();
  const installDialog = useInstallDialog();

  const buildMenuItems = useGameMenuItems({
    onOpen: onOpenGame,
    onError: setError,
    onManageGroups: setGrouping,
    onInstall: installDialog.request,
  });

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

  // Optimistic: the card flips the moment it is clicked and rolls back only if
  // the server refuses. One shared pending flag used to grey out every card in
  // the grid at once, which made adding several games feel like a queue.
  const addMutation = useAddToLibrary();

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

        {/* Asking for something is the natural next step from failing to find
            it, so the entry point lives on the screen where that happens. */}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setRequesting(true)}
          title="Ask for a game that is not in the archive"
        >
          <MessageSquarePlus size={15} aria-hidden />
          Request
        </button>
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
        <GridSkeleton />
      ) : (gamesQuery.data?.items ?? []).length === 0 ? (
        <Empty
          title="Nothing matches"
          message="Try a different search, or clear the genre filter."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setRequesting(true)}>
              <MessageSquarePlus size={15} aria-hidden />
              Request {debounced ? `"${debounced}"` : 'a game'}
            </button>
          }
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
                busy={game.inLibrary}
                onPrimary={() => {
                  setError(null);
                  addMutation.mutate(game.id, {
                    onError: (caught) => setError(errorMessage(caught)),
                  });
                }}
                onContextMenu={menu.open}
              />
            ))}
          </div>
        </>
      )}

      {requesting ? (
        <RequestsDialog onClose={() => setRequesting(false)} onOpenGame={onOpenGameId} />
      ) : null}

      {installDialog.game ? (
        <InstallDialog game={installDialog.game} onClose={installDialog.close} />
      ) : null}

      {grouping ? <CollectionPicker game={grouping} onClose={() => setGrouping(null)} /> : null}

      {menu.state ? (
        <ContextMenu
          position={menu.state.position}
          onClose={menu.close}
          items={buildMenuItems(menu.state.target, {})}
        />
      ) : null}
    </div>
  );
}
