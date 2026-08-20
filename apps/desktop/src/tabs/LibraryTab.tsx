import type { GameSummary, Paginated } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { FolderSearch, LayoutGrid, List, Rows3, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CollectionPicker } from '../components/CollectionPicker.js';
import { ContextMenu, useContextMenu } from '../components/ContextMenu.js';
import { GameCard, GameDetailedRow, GameRow } from '../components/GameCard.js';
import { useGameMenuItems } from '../components/GameContextMenu.js';
import { ImportGames } from '../components/ImportGames.js';
import { InstallDialog, useInstallDialog } from '../components/InstallDialog.js';
import { Empty, ErrorNote, Loading } from '../components/ui.js';
import { useCollections } from '../hooks/useCollections.js';
import {
  errorMessage,
  ipc,
  queryString,
  type ClientSettings,
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
  const [grouping, setGrouping] = useState<GameSummary | null>(null);
  const [collectionId, setCollectionId] = useState('');

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const collectionsQuery = useCollections();
  const collections = collectionsQuery.data ?? [];

  /**
   * The layout lives in the client's own settings file rather than in
   * component state, so the choice survives a restart — a view mode that
   * resets every launch is one nobody bothers to set.
   */
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => ipc.getSettings(),
  });
  const view = settingsQuery.data?.libraryView ?? 'grid';

  const viewMutation = useMutation({
    mutationFn: (next: ClientSettings['libraryView']) => {
      const current = settingsQuery.data;
      if (!current) throw new Error('Settings are still loading');
      return ipc.updateSettings({ ...current, libraryView: next });
    },
    onSuccess: (saved) => queryClient.setQueryData(['settings'], saved),
    onError: (caught) => setError(errorMessage(caught)),
  });

  const gamesQuery = useQuery({
    queryKey: ['games', 'library', debounced, filter, sort, collectionId],
    queryFn: () =>
      ipc.get<Paginated<GameSummary>>(
        `/games${queryString({
          scope: 'library',
          search: debounced,
          favoritesOnly: filter === 'favourites',
          collectionId,
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

  // Where a game goes is asked, not assumed; the dialog owns the download.
  const installDialog = useInstallDialog();

  const menu = useContextMenu<GameSummary>();
  const buildMenuItems = useGameMenuItems({
    onOpen: onOpenGame,
    onError: setError,
    onManageGroups: setGrouping,
    onInstall: installDialog.request,
  });

  const installedIds = new Set(installed.map((game) => game.gameId));
  const items = (gamesQuery.data?.items ?? []).filter(
    (game) => filter !== 'installed' || installedIds.has(game.id),
  );

  const activeCollection = collections.find((entry) => entry.id === collectionId);

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

        {/* Three shapes for the same list, chosen here rather than in Settings
            because which one is right changes with what you are doing: posters
            to browse by artwork, a dense list to find a known title, panels to
            decide what to play. */}
        <div className="segmented" role="group" aria-label="Layout">
          {(
            [
              { id: 'grid', label: 'Grid', Icon: LayoutGrid },
              { id: 'list', label: 'List', Icon: List },
              { id: 'detailed', label: 'Detailed', Icon: Rows3 },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              className={clsx('segment icon-segment', view === option.id && 'active')}
              aria-pressed={view === option.id}
              aria-label={`${option.label} view`}
              title={`${option.label} view`}
              onClick={() => viewMutation.mutate(option.id)}
            >
              <option.Icon size={15} aria-hidden />
            </button>
          ))}
        </div>

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

      {collections.length > 0 ? (
        <div className="chip-row">
          <button
            type="button"
            className={clsx('chip', collectionId === '' && 'active')}
            onClick={() => setCollectionId('')}
          >
            All games
          </button>
          {collections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              className={clsx('chip', collectionId === collection.id && 'active')}
              onClick={() => setCollectionId(collectionId === collection.id ? '' : collection.id)}
            >
              <span className={`collection-dot ${collection.color}`} aria-hidden />
              {collection.name}
              <span className="muted small"> {collection.gameCount}</span>
            </button>
          ))}
        </div>
      ) : null}

      <ErrorNote message={error} />

      {gamesQuery.isLoading ? (
        <Loading label="Loading your library" />
      ) : items.length === 0 ? (
        <Empty
          title={
            activeCollection
              ? `Nothing in ${activeCollection.name}`
              : debounced
                ? 'Nothing matches'
                : 'Your library is empty'
          }
          message={
            activeCollection
              ? 'Right-click a game and choose "Add to group…" to file it here.'
              : debounced
                ? 'Try a different search.'
                : 'Head to the Store tab and add a few games to get started.'
          }
        />
      ) : view === 'list' ? (
        <div className="game-rows">
          {/* Seven cells, one per column of the row grid below — including the
              two the rows fill with an installed chip and an action button. */}
          <div className="game-row-head muted small">
            <span />
            <span>Title</span>
            <span>Size</span>
            <span>Played</span>
            <span>Achievements</span>
            <span />
            <span />
          </div>
          {items.map((game) => {
            const isInstalled = installedIds.has(game.id);
            return (
              <GameRow
                key={game.id}
                game={game}
                installed={isInstalled}
                onOpen={onOpenGame}
                primaryLabel={isInstalled ? 'play' : 'install'}
                busy={running?.gameId === game.id}
                onPrimary={() =>
                  isInstalled ? launchMutation.mutate(game.id) : installDialog.request(game)
                }
                onContextMenu={menu.open}
              />
            );
          })}
        </div>
      ) : view === 'detailed' ? (
        <div className="game-detailed-list">
          {items.map((game) => {
            const isInstalled = installedIds.has(game.id);
            return (
              <GameDetailedRow
                key={game.id}
                game={game}
                installed={isInstalled}
                onOpen={onOpenGame}
                primaryLabel={isInstalled ? 'play' : 'install'}
                busy={running?.gameId === game.id}
                onPrimary={() =>
                  isInstalled ? launchMutation.mutate(game.id) : installDialog.request(game)
                }
                onContextMenu={menu.open}
              />
            );
          })}
        </div>
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
                  isInstalled ? launchMutation.mutate(game.id) : installDialog.request(game)
                }
                onContextMenu={menu.open}
              />
            );
          })}
        </div>
      )}

      {installDialog.game ? (
        <InstallDialog game={installDialog.game} onClose={installDialog.close} />
      ) : null}

      {importing ? <ImportGames installed={installed} onClose={() => setImporting(false)} /> : null}

      {grouping ? <CollectionPicker game={grouping} onClose={() => setGrouping(null)} /> : null}

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
