import type { GameSummary, MetadataCandidate, Paginated, ServerSettings } from '@gameblade/shared';
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ArrowRight, Check, Search, Sparkles } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Badge, EmptyState, FormError, Notice, RowSkeleton, Spinner } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';

const PAGE_SIZE = 30;
type MatchFilter = 'all' | 'unmatched' | 'auto' | 'manual' | 'skipped';

/**
 * A catalog-wide metadata workbench.
 *
 * The old workflow hid candidate matching inside one game's editor. That is a
 * fine escape hatch and a terrible way to review a large import. This keeps the
 * current catalog title on the left and IGDB's ranked answer on the right, with
 * the alternatives in the same row and one explicit action that adopts the
 * canonical title as well as the metadata.
 */
export function AdminMetadataMatchesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [filter, setFilter] = useState<MatchFilter>('all');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<ServerSettings>('/admin/settings'),
    staleTime: 60_000,
  });
  const igdbConfigured =
    settingsQuery.data?.providers.find((provider) => provider.name === 'igdb')?.configured ?? false;

  const params = new URLSearchParams({
    scope: 'all',
    includeMissing: 'true',
    sort: 'title',
    order: 'asc',
    offset: String(offset),
    limit: String(PAGE_SIZE),
  });
  if (deferredSearch) params.set('search', deferredSearch);
  if (filter !== 'all') params.set('matchStatus', filter);

  const gamesQuery = useQuery({
    queryKey: ['admin', 'metadata-games', filter, deferredSearch, offset],
    queryFn: () => api.get<Paginated<GameSummary>>(`/games?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  const games = gamesQuery.data?.items ?? [];
  const candidateQueries = useQueries({
    queries: games.map((game) => ({
      queryKey: ['admin', 'candidates', game.id],
      queryFn: () => api.get<MetadataCandidate[]>(`/games/${game.id}/candidates`),
      enabled: igdbConfigured,
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });

  const accept = useMutation({
    mutationFn: ({ gameId, candidate }: { gameId: string; candidate: MetadataCandidate }) =>
      api.post(`/games/${gameId}/match`, {
        igdbId: candidate.id,
        refreshArtwork: true,
        setTitle: true,
      }),
    onSuccess: async (_result, variables) => {
      setError(null);
      setNotice(`Matched and renamed to “${variables.candidate.title}”. Metadata is up to date.`);
      queryClient.removeQueries({ queryKey: ['admin', 'candidates', variables.gameId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'metadata-games'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] }),
        queryClient.invalidateQueries({ queryKey: ['games'] }),
      ]);
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not apply that metadata match. Try again.',
      ),
  });

  const total = gamesQuery.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="gb-page">
      <div className="gb-card flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-blade-400 text-xs font-semibold tracking-[0.14em] uppercase">
            Catalog identity
          </p>
          <h2 className="mt-1 text-xl font-semibold">Review what each game really is</h2>
          <p className="text-ink-300 mt-1 max-w-2xl text-sm">
            GameBlade ranks possible IGDB matches from the filename-derived title. Choose another
            result when needed, then accept it to pull metadata, artwork, and the canonical title.
          </p>
        </div>
        <div className="bg-ink-800/70 border-ink-700 flex shrink-0 items-center gap-3 rounded-xl border px-4 py-3">
          <Sparkles className="text-blade-400 h-5 w-5" aria-hidden />
          <div>
            <p className="text-ink-400 text-xs">Games in this view</p>
            <p className="font-semibold">{total.toLocaleString()}</p>
          </div>
        </div>
      </div>

      <FormError message={error} />
      <Notice message={notice} />

      {!settingsQuery.isLoading && !igdbConfigured ? (
        <div className="gb-note-danger">
          IGDB is not configured. Add its client credentials in Settings before reviewing matches.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search
            className="text-ink-400 pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            className="gb-input pl-9"
            value={search}
            placeholder="Find a game in the catalog…"
            aria-label="Search catalog games"
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Match status">
          {(
            [
              ['all', 'Every game'],
              ['unmatched', 'Needs review'],
              ['auto', 'Auto matched'],
              ['manual', 'Confirmed'],
              ['skipped', 'Skipped'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'gb-btn-primary' : 'gb-btn-ghost'}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {gamesQuery.isLoading || settingsQuery.isLoading ? (
        <RowSkeleton rows={8} />
      ) : games.length === 0 ? (
        <EmptyState
          title="No games match this view"
          message="Try another status or a shorter title search."
        />
      ) : (
        <div className="gb-card divide-ink-700/70 divide-y overflow-hidden">
          {games.map((game, index) => {
            const query = candidateQueries[index];
            const candidates = query?.data ?? [];
            const selectedId = selected[game.id] ?? candidates[0]?.id;
            const candidate = candidates.find((item) => item.id === selectedId) ?? candidates[0];
            const pending = accept.isPending && accept.variables?.gameId === game.id;

            return (
              <MetadataMatchRow
                key={game.id}
                game={game}
                candidates={candidates}
                candidate={candidate}
                loading={Boolean(query?.isLoading)}
                failed={Boolean(query?.isError)}
                pending={pending}
                providerReady={igdbConfigured}
                onSelect={(id) => setSelected((current) => ({ ...current, [game.id]: id }))}
                onAccept={() => {
                  if (!candidate) return;
                  setNotice(null);
                  setError(null);
                  accept.mutate({ gameId: game.id, candidate });
                }}
              />
            );
          })}
        </div>
      )}

      {games.length > 0 ? (
        <div className="flex items-center justify-between">
          <p className="text-ink-400 text-xs">
            Page {page} of {pages} · {total.toLocaleString()} game{total === 1 ? '' : 's'}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="gb-btn-ghost"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              className="gb-btn-ghost"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MetadataMatchRow({
  game,
  candidates,
  candidate,
  loading,
  failed,
  pending,
  providerReady,
  onSelect,
  onAccept,
}: {
  game: GameSummary;
  candidates: MetadataCandidate[];
  candidate: MetadataCandidate | undefined;
  loading: boolean;
  failed: boolean;
  pending: boolean;
  providerReady: boolean;
  onSelect: (id: number) => void;
  onAccept: () => void;
}) {
  return (
    <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,0.85fr)_24px_minmax(0,1.15fr)_auto] lg:items-center">
      <div className="flex min-w-0 items-center gap-3">
        {game.art.cover ? (
          <img src={game.art.cover} alt="" className="h-16 w-11 shrink-0 rounded-md object-cover" />
        ) : (
          <div className="bg-ink-800 text-ink-500 grid h-16 w-11 shrink-0 place-items-center rounded-md text-xs">
            ZIP
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{game.title}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge
              tone={
                game.matchStatus === 'manual'
                  ? 'success'
                  : game.matchStatus === 'unmatched'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {game.matchStatus === 'manual'
                ? 'Confirmed'
                : game.matchStatus === 'auto'
                  ? 'Auto matched'
                  : game.matchStatus === 'skipped'
                    ? 'Skipped'
                    : 'Unmatched'}
            </Badge>
            {game.isMissing ? <Badge tone="danger">Source missing</Badge> : null}
          </div>
        </div>
      </div>

      <ArrowRight className="text-ink-600 hidden h-5 w-5 lg:block" aria-hidden />

      <div className="min-w-0">
        {!providerReady ? (
          <p className="text-ink-400 text-sm">IGDB credentials required</p>
        ) : loading ? (
          <p className="text-ink-400 flex items-center gap-2 text-sm">
            <Spinner className="h-4 w-4" /> Finding likely matches…
          </p>
        ) : failed ? (
          <p className="text-sm text-red-400">Could not load possible matches.</p>
        ) : !candidate ? (
          <p className="text-ink-400 text-sm">
            No likely match found. Use the game editor for a custom search.
          </p>
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            {candidate.coverUrl ? (
              <img
                src={candidate.coverUrl}
                alt=""
                className="h-16 w-11 shrink-0 rounded-md object-cover"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-semibold">{candidate.title}</p>
                <Badge
                  tone={
                    candidate.confidence >= 85
                      ? 'success'
                      : candidate.confidence >= 65
                        ? 'info'
                        : 'warning'
                  }
                >
                  {candidate.confidence}% title match
                </Badge>
              </div>
              <p className="text-ink-400 mt-0.5 truncate text-xs">
                {candidate.releaseDate?.slice(0, 4) ?? 'Unknown year'} ·{' '}
                {candidate.platforms.join(', ') || 'Platforms not listed'}
              </p>
              {candidates.length > 1 ? (
                <select
                  className="gb-input mt-2 max-w-full py-1 text-xs"
                  value={candidate.id}
                  aria-label={`Possible matches for ${game.title}`}
                  onChange={(event) => onSelect(Number(event.target.value))}
                >
                  {candidates.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.title} · {option.releaseDate?.slice(0, 4) ?? 'unknown year'} ·{' '}
                      {option.confidence}%
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        className="gb-btn-primary justify-center lg:min-w-36"
        disabled={!candidate || pending || !providerReady}
        onClick={onAccept}
        title="Pull all metadata and rename the catalog entry to this title"
      >
        {pending ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4" aria-hidden />}
        {pending ? 'Applying…' : 'Accept & rename'}
      </button>
    </div>
  );
}
