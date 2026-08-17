import type {
  AchievementDefinition,
  ArtKind,
  ArtworkSearchResult,
  GameDetail,
  GameSummary,
  LaunchRule,
  MetadataCandidate,
  Paginated,
  SaveRule,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Image as ImageIcon, Search, Trash2, Trophy, Wand2, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, EmptyState, Field, FormError, PageLoader, Spinner } from '../../components/ui.js';
import { api, ApiRequestError, queryString } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';

/**
 * The catalogue browser and metadata editor.
 *
 * Players never see this page — they browse from the desktop client — so it is
 * built as a dense worklist: find the entries that need attention, fix them,
 * move on.
 */
export function AdminCatalogPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [selected, setSelected] = useState<string | null>(null);

  const matchStatus = params.get('matchStatus') ?? '';

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (search.trim()) next.set('search', search.trim());
          else next.delete('search');
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [search, setParams]);

  const listQuery = useQuery({
    queryKey: ['admin', 'catalog', params.toString()],
    queryFn: () =>
      api.get<Paginated<GameSummary>>(
        `/games${queryString({
          search: params.get('search') ?? '',
          matchStatus: matchStatus || undefined,
          includeMissing: true,
          sort: 'title',
          limit: 100,
        })}`,
      ),
  });

  // The server-wide count, not the count on this page: the bulk action clears
  // every flagged entry regardless of the search and status filters above, so
  // counting the visible rows would understate what the button actually does.
  const statsQuery = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api.get<{ missing: number }>('/admin/stats'),
  });
  const missingCount = statsQuery.data?.missing ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Catalogue</h1>
        <span className="text-ink-400 text-sm">
          {listQuery.data ? `${listQuery.data.total.toLocaleString()} games` : ''}
        </span>
        <div className="ml-auto">
          <PurgeMissingButton missing={missingCount} />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Field label="Search" htmlFor="catalogSearch">
            <div className="relative">
              <Search
                className="text-ink-400 pointer-events-none absolute top-2.5 left-3 h-4 w-4"
                aria-hidden
              />
              <input
                id="catalogSearch"
                className="gb-input pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Title…"
              />
            </div>
          </Field>
        </div>

        <Field label="Match status" htmlFor="catalogStatus">
          <select
            id="catalogStatus"
            className="gb-input w-auto"
            value={matchStatus}
            onChange={(e) =>
              setParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  if (e.target.value) next.set('matchStatus', e.target.value);
                  else next.delete('matchStatus');
                  return next;
                },
                { replace: true },
              )
            }
          >
            <option value="">Any</option>
            <option value="unmatched">Unmatched</option>
            <option value="auto">Auto-matched</option>
            <option value="manual">Hand-edited</option>
            <option value="skipped">Skipped</option>
          </select>
        </Field>
      </div>

      {listQuery.isLoading ? (
        <PageLoader label="Loading catalogue" />
      ) : (listQuery.data?.items ?? []).length === 0 ? (
        <EmptyState
          title="Nothing matches"
          message="Adjust the filters, or scan a library to bring games in."
        />
      ) : (
        <div className="divide-ink-700/70 gb-card divide-y">
          {(listQuery.data?.items ?? []).map((game) => (
            // A row is a button plus a sibling delete button rather than one
            // nested inside the other, which is invalid and unreachable by
            // keyboard.
            <div key={game.id} className="hover:bg-ink-800/60 flex items-center transition-colors">
              <button
                type="button"
                onClick={() => setSelected(game.id)}
                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left"
              >
                {game.art.cover ? (
                  <img
                    src={game.art.cover}
                    alt=""
                    className="bg-ink-800 h-12 w-9 shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="bg-ink-800 text-ink-500 flex h-12 w-9 shrink-0 items-center justify-center rounded">
                    <ImageIcon className="h-4 w-4" aria-hidden />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{game.title}</p>
                  <p className="text-ink-400 text-xs">
                    {formatBytes(game.sizeBytes)} · {game.fileCount} files
                    {game.achievementCount > 0 ? ` · ${game.achievementCount} achievements` : ''}
                  </p>
                </div>

                {game.isMissing ? <Badge tone="danger">Missing</Badge> : null}
                <MatchBadge status={game.matchStatus} />
              </button>

              <div className="pr-3 pl-2">
                <DeleteGameButton game={game} />
              </div>
            </div>
          ))}
        </div>
      )}

      {selected ? <GameEditor gameId={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

/**
 * Removes one catalogue entry.
 *
 * Files on disk are never touched, so the wording has to be explicit about
 * that — "delete" next to a game is otherwise easy to read as "delete the
 * download". A game still present on disk needs the extra confirmation,
 * because a scan will simply add it back without its metadata.
 */
function DeleteGameButton({ game }: { game: GameSummary }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (force: boolean) =>
      api.delete<{ ok: boolean }>(`/admin/games/${game.id}${force ? '?force=true' : ''}`),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not remove the game');
    },
  });

  return (
    <button
      type="button"
      title={
        game.isMissing
          ? 'Remove this entry — the game is gone from disk'
          : 'Remove this entry from the catalogue'
      }
      aria-label={`Remove ${game.title} from the catalogue`}
      className="text-ink-500 rounded p-2 transition-colors hover:bg-red-950/60 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={remove.isPending}
      onClick={() => {
        const question = game.isMissing
          ? `Remove "${game.title}" from the catalogue? It is already gone from disk, and its playtime and achievements go with it.`
          : `"${game.title}" is still on disk, so the next scan will add it back without its metadata. Remove the entry anyway?`;
        if (!confirm(question)) return;
        remove.mutate(!game.isMissing);
      }}
    >
      {remove.isPending ? (
        <Spinner className="h-4 w-4" />
      ) : (
        <Trash2 className="h-4 w-4" aria-hidden />
      )}
      {error ? <span className="sr-only">{error}</span> : null}
    </button>
  );
}

/** Bulk clean-up for everything a scan has flagged as gone. */
function PurgeMissingButton({ missing }: { missing: number }) {
  const queryClient = useQueryClient();

  const purge = useMutation({
    mutationFn: () => api.post<{ removed: number }>('/admin/games/purge-missing', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });

  if (missing === 0) return null;

  return (
    <button
      type="button"
      className="gb-btn-danger"
      disabled={purge.isPending}
      onClick={() => {
        if (
          !confirm(
            `Remove ${missing} game${missing === 1 ? '' : 's'} that ${
              missing === 1 ? 'is' : 'are'
            } no longer on disk? Playtime and achievements for ${
              missing === 1 ? 'it' : 'them'
            } are removed too. Files on disk are not touched.`,
          )
        ) {
          return;
        }
        purge.mutate();
      }}
    >
      {purge.isPending ? (
        <Spinner className="h-4 w-4" />
      ) : (
        <Trash2 className="h-4 w-4" aria-hidden />
      )}
      Remove {missing} missing
    </button>
  );
}

function MatchBadge({ status }: { status: GameSummary['matchStatus'] }) {
  if (status === 'manual') return <Badge tone="success">Hand-edited</Badge>;
  if (status === 'auto') return <Badge tone="info">Auto</Badge>;
  if (status === 'skipped') return <Badge tone="neutral">Skipped</Badge>;
  return <Badge tone="warning">Unmatched</Badge>;
}

/* ------------------------------------------------------------------ editor */

const EDITOR_TABS = [
  { id: 'metadata', label: 'Metadata' },
  { id: 'artwork', label: 'Artwork' },
  { id: 'achievements', label: 'Achievements' },
  { id: 'rules', label: 'Launch & saves' },
] as const;

type EditorTab = (typeof EDITOR_TABS)[number]['id'];

function GameEditor({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const [tab, setTab] = useState<EditorTab>('metadata');

  const gameQuery = useQuery({
    queryKey: ['admin', 'game', gameId],
    queryFn: () => api.get<GameDetail>(`/games/${gameId}`),
  });

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-ink-900 border-ink-700 flex h-full w-full max-w-2xl flex-col border-l shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-ink-800 flex items-center gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold">
              {gameQuery.data?.title ?? 'Loading…'}
            </h2>
            <p className="text-ink-400 truncate font-mono text-xs">{gameQuery.data?.relPath}</p>
          </div>
          <button type="button" className="gb-btn-ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="border-ink-800 flex gap-1 border-b px-5" role="tablist">
          {EDITOR_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={
                tab === t.id
                  ? 'border-blade-500 text-ink-100 -mb-px border-b-2 px-3 py-2.5 text-sm font-medium'
                  : 'text-ink-400 hover:text-ink-200 -mb-px border-b-2 border-transparent px-3 py-2.5 text-sm font-medium'
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {gameQuery.isLoading || !gameQuery.data ? (
            <PageLoader label="Loading game" />
          ) : tab === 'metadata' ? (
            <MetadataTab game={gameQuery.data} />
          ) : tab === 'artwork' ? (
            <ArtworkTab game={gameQuery.data} />
          ) : tab === 'achievements' ? (
            <AchievementsTab game={gameQuery.data} />
          ) : (
            <RulesTab gameId={gameId} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Comma-separated text is the fastest way to edit a short list by hand. */
function listToText(values: string[]): string {
  return values.join(', ');
}

function textToList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function MetadataTab({ game }: { game: GameDetail }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    title: game.title,
    summary: game.summary ?? '',
    storyline: game.storyline ?? '',
    releaseDate: game.releaseDate?.slice(0, 10) ?? '',
    rating: game.rating === null ? '' : String(game.rating),
    developers: listToText(game.developers),
    publishers: listToText(game.publishers),
    genres: listToText(game.genres),
    platforms: listToText(game.platforms),
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidateQuery, setCandidateQuery] = useState('');

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'game', game.id] });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'catalog'] });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/games/${game.id}`, {
        title: form.title,
        summary: form.summary || null,
        storyline: form.storyline || null,
        releaseDate: form.releaseDate || null,
        rating: form.rating === '' ? null : Number(form.rating),
        developers: textToList(form.developers),
        publishers: textToList(form.publishers),
        genres: textToList(form.genres),
        platforms: textToList(form.platforms),
      }),
    onSuccess: async () => {
      setNotice('Saved. This entry is now marked hand-edited, so a rescan will leave it alone.');
      setError(null);
      await invalidate();
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save.'),
  });

  const candidatesQuery = useQuery({
    queryKey: ['admin', 'candidates', game.id, candidateQuery],
    queryFn: () =>
      api.get<MetadataCandidate[]>(
        `/games/${game.id}/candidates${queryString({ q: candidateQuery })}`,
      ),
    enabled: candidateQuery.length > 0,
  });

  const matchMutation = useMutation({
    mutationFn: (igdbId: number) =>
      api.post(`/games/${game.id}/match`, { igdbId, refreshArtwork: true }),
    onSuccess: async () => {
      setNotice('Matched. Metadata and artwork have been pulled in.');
      await invalidate();
    },
  });

  return (
    <div className="space-y-6">
      <FormError message={error} />
      {notice ? (
        <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </p>
      ) : null}

      <section className="gb-card space-y-3 p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">Pull from IGDB</h3>
        <div className="flex gap-2">
          <input
            className="gb-input"
            value={candidateQuery}
            onChange={(e) => setCandidateQuery(e.target.value)}
            placeholder={game.title}
          />
          <button
            type="button"
            className="gb-btn-ghost shrink-0"
            onClick={() => setCandidateQuery(candidateQuery || game.title)}
          >
            <Wand2 className="h-4 w-4" aria-hidden />
            Search
          </button>
        </div>

        {candidatesQuery.isLoading ? <Spinner className="h-4 w-4" /> : null}
        {(candidatesQuery.data ?? []).map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className="hover:bg-ink-800 flex w-full items-center gap-3 rounded-lg p-2 text-left"
            onClick={() => matchMutation.mutate(candidate.id)}
          >
            {candidate.coverUrl ? (
              <img src={candidate.coverUrl} alt="" className="h-14 w-10 rounded object-cover" />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{candidate.title}</span>
              <span className="text-ink-400 block truncate text-xs">
                {candidate.releaseDate?.slice(0, 4) ?? 'Unknown year'} ·{' '}
                {candidate.platforms.join(', ') || 'No platforms listed'}
              </span>
            </span>
          </button>
        ))}
      </section>

      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          saveMutation.mutate();
        }}
      >
        <Field label="Title" htmlFor="gTitle">
          <input
            id="gTitle"
            className="gb-input"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
        </Field>

        <Field label="Summary" htmlFor="gSummary">
          <textarea
            id="gSummary"
            className="gb-input min-h-24"
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
          />
        </Field>

        <Field label="Storyline" htmlFor="gStory">
          <textarea
            id="gStory"
            className="gb-input min-h-20"
            value={form.storyline}
            onChange={(e) => setForm({ ...form, storyline: e.target.value })}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Release date" htmlFor="gDate">
            <input
              id="gDate"
              type="date"
              className="gb-input"
              value={form.releaseDate}
              onChange={(e) => setForm({ ...form, releaseDate: e.target.value })}
            />
          </Field>
          <Field label="Rating (0–100)" htmlFor="gRating">
            <input
              id="gRating"
              type="number"
              min={0}
              max={100}
              className="gb-input"
              value={form.rating}
              onChange={(e) => setForm({ ...form, rating: e.target.value })}
            />
          </Field>
        </div>

        {(
          [
            ['developers', 'Developers'],
            ['publishers', 'Publishers'],
            ['genres', 'Genres'],
            ['platforms', 'Platforms'],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label} htmlFor={`g_${key}`} hint="Separate with commas">
            <input
              id={`g_${key}`}
              className="gb-input"
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </Field>
        ))}

        <button type="submit" className="gb-btn-primary" disabled={saveMutation.isPending}>
          {saveMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
          Save metadata
        </button>
      </form>
    </div>
  );
}

const ART_SLOTS = [
  { kind: 'cover', label: 'Cover', aspect: 'aspect-[2/3] w-28' },
  { kind: 'hero', label: 'Hero', aspect: 'aspect-[16/6] w-full' },
  { kind: 'logo', label: 'Logo', aspect: 'aspect-[16/9] w-40' },
  { kind: 'icon', label: 'Icon', aspect: 'aspect-square w-16' },
] as const;

function ArtworkTab({ game }: { game: GameDetail }) {
  const queryClient = useQueryClient();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<ArtKind | null>(null);

  const setMutation = useMutation({
    mutationFn: ({ kind, url }: { kind: string; url: string | null }) =>
      api.put(`/games/${game.id}/artwork`, { kind, url }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'game', game.id] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'catalog'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not set artwork.'),
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.post(`/games/${game.id}/refresh-artwork`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'game', game.id] }),
  });

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <button
        type="button"
        className="gb-btn-ghost"
        onClick={() => refreshMutation.mutate()}
        disabled={refreshMutation.isPending}
      >
        {refreshMutation.isPending ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <Wand2 className="h-4 w-4" />
        )}
        Re-fetch from SteamGridDB
      </button>

      {ART_SLOTS.map((slot) => {
        const current = game.art[slot.kind];
        return (
          <section key={slot.kind} className="gb-card space-y-3 p-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold tracking-wide uppercase">{slot.label}</h3>
              {current ? (
                <button
                  type="button"
                  className="gb-btn-danger ml-auto"
                  onClick={() => setMutation.mutate({ kind: slot.kind, url: null })}
                >
                  Clear
                </button>
              ) : null}
            </div>

            {current ? (
              <img
                src={current}
                alt=""
                className={`bg-ink-800 rounded-lg object-cover ${slot.aspect}`}
              />
            ) : (
              <div
                className={`border-ink-700 text-ink-500 flex items-center justify-center rounded-lg border border-dashed ${slot.aspect}`}
              >
                <ImageIcon className="h-5 w-5" aria-hidden />
              </div>
            )}

            <div className="flex gap-2">
              <input
                className="gb-input"
                placeholder="https://…"
                value={urls[slot.kind] ?? ''}
                onChange={(e) => setUrls({ ...urls, [slot.kind]: e.target.value })}
              />
              <button
                type="button"
                className="gb-btn-ghost shrink-0"
                disabled={!urls[slot.kind]}
                onClick={() =>
                  setMutation.mutate({ kind: slot.kind, url: urls[slot.kind] ?? null })
                }
              >
                <Download className="h-4 w-4" aria-hidden />
                Fetch
              </button>
            </div>
          </section>
        );
      })}

      {picking ? (
        <ArtworkPicker
          game={game}
          kind={picking}
          onClose={() => setPicking(null)}
          onChoose={(url) => {
            setMutation.mutate({ kind: picking, url });
            setPicking(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Browses every image both providers have for a title so a slot can be filled
 * by eye. The automatic pass picks the highest-scoring asset, which is usually
 * right and occasionally very wrong — this is the escape hatch for the latter.
 */
function ArtworkPicker({
  game,
  kind,
  onClose,
  onChoose,
}: {
  game: GameDetail;
  kind: ArtKind;
  onClose: () => void;
  onChoose: (url: string) => void;
}) {
  const [query, setQuery] = useState(game.title);
  const [submitted, setSubmitted] = useState(game.title);

  const searchQuery = useQuery({
    queryKey: ['admin', 'artwork', game.id, kind, submitted],
    queryFn: () =>
      api.get<ArtworkSearchResult>(
        `/games/${game.id}/artwork/search${queryString({ kind, q: submitted })}`,
      ),
  });

  const candidates = searchQuery.data?.candidates ?? [];
  const providerErrors = searchQuery.data?.errors ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-ink-900 border-ink-700 flex h-full max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-ink-800 flex items-center gap-3 border-b px-5 py-4">
          <h2 className="text-lg font-semibold capitalize">{kind} artwork</h2>
          <button type="button" className="gb-btn-ghost ml-auto" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
            Close
          </button>
        </header>

        <div className="border-ink-800 flex gap-2 border-b px-5 py-3">
          <input
            className="gb-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSubmitted(query.trim() || game.title);
            }}
            placeholder="Search both providers…"
          />
          <button
            type="button"
            className="gb-btn-primary shrink-0"
            onClick={() => setSubmitted(query.trim() || game.title)}
          >
            <Search className="h-4 w-4" aria-hidden />
            Search
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* A provider that failed is named, so a half-empty grid does not
              read as "there is no artwork for this game". */}
          {providerErrors.map((failure) => (
            <p
              key={failure.provider}
              className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200"
            >
              {failure.provider === 'igdb' ? 'IGDB' : 'SteamGridDB'} could not be reached:{' '}
              {failure.message}
            </p>
          ))}

          {searchQuery.isLoading ? (
            <PageLoader label="Searching for artwork" />
          ) : candidates.length === 0 ? (
            <EmptyState
              title="Nothing found"
              message="Try a different search term — the providers match on their own titles, not your filename."
            />
          ) : (
            <div
              className={
                kind === 'cover'
                  ? 'grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3'
                  : 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3'
              }
            >
              {candidates.map((candidate) => (
                <button
                  key={`${candidate.provider}-${candidate.url}`}
                  type="button"
                  className="group border-ink-700 hover:border-blade-500 overflow-hidden rounded-lg border text-left transition-colors"
                  onClick={() => onChoose(candidate.url)}
                  title={candidate.label ?? undefined}
                >
                  <img
                    src={candidate.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className={
                      kind === 'cover'
                        ? 'bg-ink-800 aspect-[2/3] w-full object-cover'
                        : 'bg-ink-800 aspect-video w-full object-contain'
                    }
                  />
                  <span className="text-ink-400 flex items-center gap-1.5 px-2 py-1.5 text-[11px]">
                    <Badge tone={candidate.provider === 'igdb' ? 'info' : 'success'}>
                      {candidate.provider === 'igdb' ? 'IGDB' : 'SGDB'}
                    </Badge>
                    {candidate.width && candidate.height ? (
                      <span>
                        {candidate.width}×{candidate.height}
                      </span>
                    ) : null}
                    {candidate.label ? <span className="truncate">{candidate.label}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AchievementsTab({ game }: { game: GameDetail }) {
  const queryClient = useQueryClient();
  const [steamAppId, setSteamAppId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['admin', 'achievements', game.id],
    queryFn: () => api.get<AchievementDefinition[]>(`/admin/games/${game.id}/achievements`),
  });

  const importMutation = useMutation({
    mutationFn: () =>
      api.post<{ imported: number; skipped: number }>(
        `/admin/games/${game.id}/achievements/import`,
        { steamAppId: Number(steamAppId), replace: false },
      ),
    onSuccess: async (result) => {
      setNotice(`Imported ${result.imported} achievements.`);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'achievements', game.id] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Import failed.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/games/${game.id}/achievements/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'achievements', game.id] }),
  });

  return (
    <div className="space-y-5">
      <FormError message={error} />
      {notice ? (
        <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </p>
      ) : null}

      <section className="gb-card space-y-3 p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">Import from Steam</h3>
        <p className="text-ink-400 text-xs leading-relaxed">
          Reads the game&rsquo;s published achievement list from Steam. No player data is requested
          and no account is linked — this works for a DRM-free copy of a game that also ships there.
          Needs a Steam Web API key in Settings.
        </p>
        <div className="flex gap-2">
          <input
            className="gb-input"
            inputMode="numeric"
            placeholder="Steam app id, e.g. 200900"
            value={steamAppId}
            onChange={(e) => setSteamAppId(e.target.value.replace(/\D/g, ''))}
          />
          <button
            type="button"
            className="gb-btn-primary shrink-0"
            disabled={!steamAppId || importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Trophy className="h-4 w-4" />
            )}
            Import
          </button>
        </div>
      </section>

      {listQuery.isLoading ? (
        <PageLoader label="Loading achievements" />
      ) : (listQuery.data ?? []).length === 0 ? (
        <EmptyState title="No achievements yet" message="Import a set, or add them by hand." />
      ) : (
        <div className="divide-ink-700/70 gb-card divide-y">
          {(listQuery.data ?? []).map((achievement) => (
            <div key={achievement.id} className="flex items-center gap-3 px-4 py-2.5">
              {achievement.iconUrl ? (
                <img src={achievement.iconUrl} alt="" className="h-9 w-9 rounded" loading="lazy" />
              ) : (
                <div className="bg-ink-800 text-ink-500 flex h-9 w-9 items-center justify-center rounded">
                  <Trophy className="h-4 w-4" aria-hidden />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{achievement.name}</p>
                <p className="text-ink-400 truncate text-xs">
                  {achievement.points} pts
                  {achievement.globalPercent !== null
                    ? ` · ${achievement.globalPercent}% of players`
                    : ''}
                  {achievement.hidden ? ' · hidden' : ''}
                </p>
              </div>
              <button
                type="button"
                className="gb-btn-danger"
                onClick={() => deleteMutation.mutate(achievement.id)}
                aria-label={`Delete ${achievement.name}`}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Launch and save rules are what let the desktop client actually run a game and
 * back it up. Without them a title still installs, but the client has to guess
 * which executable to start and has nothing to sync.
 */
function RulesTab({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: ['admin', 'rules', gameId],
    queryFn: () => api.get<{ save: SaveRule[]; launch: LaunchRule[] }>(`/games/${gameId}/rules`),
  });

  const [launch, setLaunch] = useState({ executable: '', args: '', workingDir: '' });
  const [save, setSave] = useState({ pathTemplate: '', include: '', exclude: '' });

  // Seed the forms once the existing rules arrive.
  useEffect(() => {
    const data = rulesQuery.data;
    if (!data) return;
    const l = data.launch[0];
    const s = data.save[0];
    if (l)
      setLaunch({
        executable: l.executable ?? '',
        args: l.args ?? '',
        workingDir: l.workingDir ?? '',
      });
    if (s)
      setSave({ pathTemplate: s.pathTemplate, include: s.include ?? '', exclude: s.exclude ?? '' });
  }, [rulesQuery.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'rules', gameId] });

  const saveLaunch = useMutation({
    mutationFn: () =>
      api.put(`/games/${gameId}/launch-rule`, {
        executable: launch.executable || null,
        args: launch.args || null,
        workingDir: launch.workingDir || null,
      }),
    onSuccess: invalidate,
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save.'),
  });

  const saveSave = useMutation({
    mutationFn: () =>
      api.put(`/games/${gameId}/save-rule`, {
        pathTemplate: save.pathTemplate,
        include: save.include || null,
        exclude: save.exclude || null,
      }),
    onSuccess: invalidate,
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save.'),
  });

  if (rulesQuery.isLoading) return <PageLoader label="Loading rules" />;

  return (
    <div className="space-y-6">
      <FormError message={error} />

      <section className="gb-card space-y-4 p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">Launch</h3>
        <Field
          label="Executable"
          htmlFor="rExe"
          hint="Relative to the install folder. Leave blank to let the client pick the only .exe it finds."
        >
          <input
            id="rExe"
            className="gb-input font-mono"
            value={launch.executable}
            onChange={(e) => setLaunch({ ...launch, executable: e.target.value })}
            placeholder="bin\\game.exe"
          />
        </Field>
        <Field label="Arguments" htmlFor="rArgs">
          <input
            id="rArgs"
            className="gb-input font-mono"
            value={launch.args}
            onChange={(e) => setLaunch({ ...launch, args: e.target.value })}
            placeholder="-windowed"
          />
        </Field>
        <Field label="Working directory" htmlFor="rCwd" hint="Relative to the install folder.">
          <input
            id="rCwd"
            className="gb-input font-mono"
            value={launch.workingDir}
            onChange={(e) => setLaunch({ ...launch, workingDir: e.target.value })}
          />
        </Field>
        <button type="button" className="gb-btn-primary" onClick={() => saveLaunch.mutate()}>
          Save launch rule
        </button>
      </section>

      <section className="gb-card space-y-4 p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">Cloud saves</h3>
        <Field
          label="Save location"
          htmlFor="rSave"
          hint="Placeholders: {userprofile} {appdata} {localappdata} {documents} {savedgames} {public} {install}"
        >
          <input
            id="rSave"
            className="gb-input font-mono"
            value={save.pathTemplate}
            onChange={(e) => setSave({ ...save, pathTemplate: e.target.value })}
            placeholder="{appdata}\\MyGame\\Saves"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Include glob" htmlFor="rInc" hint="Optional. Defaults to everything.">
            <input
              id="rInc"
              className="gb-input font-mono"
              value={save.include}
              onChange={(e) => setSave({ ...save, include: e.target.value })}
              placeholder="*.sav"
            />
          </Field>
          <Field label="Exclude glob" htmlFor="rExc">
            <input
              id="rExc"
              className="gb-input font-mono"
              value={save.exclude}
              onChange={(e) => setSave({ ...save, exclude: e.target.value })}
              placeholder="*.log"
            />
          </Field>
        </div>
        <button
          type="button"
          className="gb-btn-primary"
          disabled={!save.pathTemplate}
          onClick={() => saveSave.mutate()}
        >
          Save sync rule
        </button>
      </section>
    </div>
  );
}
