import type { GameSummary, Paginated } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { FolderSearch, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ContextMenu, useContextMenu } from '../components/ContextMenu.js';
import { GameCard } from '../components/GameCard.js';
import { useGameMenuItems } from '../components/GameContextMenu.js';
import { ImportGames } from '../components/ImportGames.js';
import { Empty, ErrorNote, Loading } from '../components/ui.js';
import {
  errorMessage,
  ipc,
  queryString,
  type InstalledGame,
  type RunningGame,
} from '../lib/ipc.js';

type Filter = 'all' | 'installed' | 'favourites';

const SORTS = [
  { id: 'played', label: 'Recently played' },
  { id: 'title', label: 'Title' },
  { id: 'playtime', label: 'Most played' },
  { id: 'added', label: 'Recently added' },
] as const;

/**
 * The games this account owns. Distinct from the Store, which is everything
 * else on the server — adding a game moves it from one to the other.
 */
export function LibraryTab({
  onOpenGame,
  installed,
  running,
}: {
  onOpenGame: (game: GameSummary) => void;
  installed: InstalledGame[];
  running: RunningGame | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<(typeof SORTS)[number]['id']>('played');
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const gamesQuery = useQuery({
    queryKey: ['games', 'library', debounced, filter, sort],
    queryFn: () =>
      ipc.get<Paginated<GameSummary>>(
        `/games${queryString({
          scope: 'library',
          search: debounced,
          favoritesOnly: filter === 'favourites',
          sort,
          order: sort === 'title' ? 'asc' : 'desc',
          limit: 200,
        })}`,
      ),
  });

  const launchMutation = useMutation({
    mutationFn: (gameId: string) => ipc.launch(gameId),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['running'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const installMutation = useMutation({
    mutationFn: (gameId: string) => ipc.startDownload(gameId),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['downloads'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const menu = useContextMenu<GameSummary>();
  const buildMenuItems = useGameMenuItems({ onOpen: onOpenGame, onError: setError });

  const installedIds = new Set(installed.map((game) => game.gameId));
  const items = (gamesQuery.data?.items ?? []).filter(
    (game) => filter !== 'installed' || installedIds.has(game.id),
  );

  return (
    <div className="tab-content">
      <div className="toolbar">
        <div className="search-box">
          <Search size={15} aria-hidden />
          <input
            type="search"
            placeholder="Search your library…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search your library"
          />
        </div>

        <div className="segmented" role="tablist">
          {(['all', 'installed', 'favourites'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={filter === option}
              className={clsx('segment', filter === option && 'active')}
              onClick={() => setFilter(option)}
            >
              {option === 'all' ? 'All' : option === 'installed' ? 'Installed' : 'Favourites'}
            </button>
          ))}
        </div>

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

        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setImporting(true)}
          title="Link games you already have on this PC instead of downloading them again"
        >
          <FolderSearch size={15} aria-hidden />
          Import
        </button>
      </div>

      <ErrorNote message={error} />

      {gamesQuery.isLoading ? (
        <Loading label="Loading your library" />
      ) : items.length === 0 ? (
        <Empty
          title={debounced ? 'Nothing matches' : 'Your library is empty'}
          message={
            debounced
              ? 'Try a different search.'
              : 'Head to the Store tab and add a few games to get started.'
          }
        />
      ) : (
        <div className="grid">
          {items.map((game) => {
            const isInstalled = installedIds.has(game.id);
            return (
              <GameCard
                key={game.id}
                game={game}
                installed={isInstalled}
                onOpen={onOpenGame}
                primaryLabel={isInstalled ? 'play' : 'install'}
                busy={running?.gameId === game.id}
                onPrimary={() =>
                  isInstalled ? launchMutation.mutate(game.id) : installMutation.mutate(game.id)
                }
                onContextMenu={menu.open}
              />
            );
          })}
        </div>
      )}

      {importing ? <ImportGames installed={installed} onClose={() => setImporting(false)} /> : null}

      {menu.state ? (
        <ContextMenu
          position={menu.state.position}
          onClose={menu.close}
          items={buildMenuItems(menu.state.target, {
            installed: installed.find((entry) => entry.gameId === menu.state?.target.id),
            isRunning: running?.gameId === menu.state.target.id,
          })}
        />
      ) : null}
    </div>
  );
}
