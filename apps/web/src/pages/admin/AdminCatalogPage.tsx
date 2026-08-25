import type {
  AchievementDefinition,
  ArtKind,
  CatalogGap,
  ExecutableCandidate,
  GameDetail,
  GameSummary,
  LaunchRule,
  MetadataCandidate,
  Paginated,
  SaveRule,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  Image as ImageIcon,
  Images,
  Search,
  Trash2,
  Trophy,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArtworkPicker } from '../../components/ArtworkPicker.js';
import {
  Badge,
  EmptyState,
  Field,
  FormError,
  PageLoader,
  Spinner,
  Notice,
  RowSkeleton,
} from '../../components/ui.js';
import { api, ApiRequestError, queryString } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';
import {
  ACHIEVEMENT_COMPARATORS,
  ACHIEVEMENT_FORMATS,
  type AchievementRule,
} from '@gameblade/shared';

/**
 * The gaps worth filtering on, in the order they matter.
 *
 * Deliberately shorter than the full set the API accepts: a chip row that lists
 * every individual artwork slot is a wall, and "no artwork at all" is the one
 * that actually needs triage. The per-slot filters stay reachable through the
 * dropdown for the rarer cases.
 */
const GAP_FILTERS: Array<{ id: CatalogGap; label: string; hint: string }> = [
  {
    id: 'launch-rule',
    label: 'No launch exec',
    hint: 'No executable is set, so the client has to guess what to run.',
  },
  {
    id: 'save-rule',
    label: 'No cloud saving',
    hint: 'No save path is set, so nothing syncs for this game.',
  },
  { id: 'artwork', label: 'No artwork', hint: 'Not one of the five image slots is filled.' },
  { id: 'cover', label: 'No cover', hint: 'No portrait poster for the library grid.' },
  { id: 'banner', label: 'No banner', hint: 'No wide capsule.' },
  { id: 'hero', label: 'No hero', hint: 'No wide art behind the game page.' },
  { id: 'logo', label: 'No logo', hint: 'No wordmark.' },
  { id: 'icon', label: 'No icon', hint: 'No small square mark.' },
  { id: 'achievements', label: 'No achievements', hint: 'No achievement definitions imported.' },
  {
    id: 'metadata',
    label: 'No metadata',
    hint: 'Never identified, or identified but still without a description.',
  },
];

/**
 * The four things a row reports at a glance. Present reads green, absent reads
 * muted-red, so a scan down the column shows where the holes are without
 * opening anything.
 */
const ROW_INDICATORS: Array<{ label: string; title: string; has: (game: GameSummary) => boolean }> =
  [
    {
      label: 'EXE',
      title: 'Launch executable',
      has: (game) => game.hasLaunchRule,
    },
    { label: 'SAVE', title: 'Cloud save rule', has: (game) => game.hasSaveRule },
    {
      label: 'ART',
      title: 'Artwork in every slot',
      has: (game) =>
        Boolean(
          game.art.cover && game.art.banner && game.art.hero && game.art.logo && game.art.icon,
        ),
    },
    { label: 'ACH', title: 'Achievements', has: (game) => game.achievementCount > 0 },
  ];

/** One row's worth of readiness, as four compact pills. */
function ReadinessPills({ game }: { game: GameSummary }) {
  return (
    <span className="hidden shrink-0 gap-1 sm:flex" aria-label="What this entry has">
      {ROW_INDICATORS.map((indicator) => {
        const present = indicator.has(game);
        return (
          <span
            key={indicator.label}
            title={`${indicator.title}: ${present ? 'set' : 'missing'}`}
            className={
              present
                ? 'gb-pill-ok rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide'
                : 'bg-ink-800 text-ink-500 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide line-through'
            }
          >
            {indicator.label}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The catalog browser and metadata editor.
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
  const missing = params.get('missing') ?? '';
  const missingFilesOnly = params.get('missingFiles') === 'true';

  /** Every filter here is a URL parameter, so a triage view is a shareable link. */
  const setParam = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

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
          missing: missing || undefined,
          includeMissing: true,
          missingFilesOnly,
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
    queryFn: () => api.get<{ missing: number; gaps: Record<CatalogGap, number> }>('/admin/stats'),
  });
  const missingCount = statsQuery.data?.missing ?? 0;
  const gaps = statsQuery.data?.gaps;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ink-300 text-sm">
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
            onChange={(e) => setParam('matchStatus', e.target.value)}
          >
            <option value="">Any</option>
            <option value="unmatched">Unmatched</option>
            <option value="auto">Auto-matched</option>
            <option value="manual">Hand-edited</option>
            <option value="skipped">Skipped</option>
          </select>
        </Field>

        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={missingFilesOnly}
            onChange={(e) => setParam('missingFiles', e.target.checked ? 'true' : '')}
          />
          Missing game files
        </label>

        <Field
          label="Missing"
          htmlFor="catalogMissing"
          hint="Narrow to entries that still need work."
        >
          <select
            id="catalogMissing"
            className="gb-input w-auto"
            value={missing}
            onChange={(e) => setParam('missing', e.target.value)}
          >
            <option value="">Nothing in particular</option>
            {GAP_FILTERS.map((filter) => (
              <option key={filter.id} value={filter.id}>
                {filter.label}
                {gaps ? ` (${gaps[filter.id]})` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* The same filters as one-click chips. The counts are server-wide, not
          per page, so they say how much work is actually left. */}
      <div className="flex flex-wrap gap-1.5">
        {GAP_FILTERS.map((filter) => {
          const count = gaps?.[filter.id];
          return (
            <button
              key={filter.id}
              type="button"
              className={missing === filter.id ? 'gb-chip gb-chip-active' : 'gb-chip'}
              title={filter.hint}
              aria-pressed={missing === filter.id}
              onClick={() => setParam('missing', missing === filter.id ? '' : filter.id)}
            >
              {filter.label}
              {count === undefined ? '' : ` ${count}`}
            </button>
          );
        })}
      </div>

      {listQuery.isLoading ? (
        <RowSkeleton rows={6} />
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

                <ReadinessPills game={game} />
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
 * Removes one catalog entry.
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
          : 'Remove this entry from the catalog'
      }
      aria-label={`Remove ${game.title} from the catalog`}
      className="text-ink-500 gb-hover-danger rounded p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      disabled={remove.isPending}
      onClick={() => {
        const question = game.isMissing
          ? `Remove "${game.title}" from the catalog? It is already gone from disk, and its playtime and achievements go with it.`
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
      <Notice message={notice} />

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
  {
    kind: 'cover',
    label: 'Cover',
    hint: 'The portrait poster on the library grid.',
    aspect: 'aspect-[2/3] w-28',
    fit: 'object-cover',
  },
  {
    kind: 'banner',
    label: 'Banner',
    hint: 'The wide Steam-style capsule.',
    aspect: 'aspect-[92/43] w-64',
    fit: 'object-cover',
  },
  {
    kind: 'hero',
    label: 'Hero',
    hint: 'The wide art behind the game page.',
    aspect: 'aspect-[16/6] w-full',
    fit: 'object-cover',
  },
  {
    kind: 'logo',
    label: 'Logo / text',
    hint: 'The wordmark laid over the hero. Pick a style to find a text-only one.',
    aspect: 'aspect-[16/9] w-40',
    fit: 'object-contain',
  },
  {
    kind: 'icon',
    label: 'Icon',
    hint: 'The small square mark.',
    aspect: 'aspect-square w-16',
    fit: 'object-contain',
  },
] as const satisfies ReadonlyArray<{
  kind: ArtKind;
  label: string;
  hint: string;
  aspect: string;
  fit: string;
}>;

function ArtworkTab({ game }: { game: GameDetail }) {
  const queryClient = useQueryClient();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<ArtKind | null>(null);
  const [pickingScreenshots, setPickingScreenshots] = useState(false);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'game', game.id] });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'catalog'] });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
  };

  const setMutation = useMutation({
    mutationFn: ({ kind, url }: { kind: ArtKind; url: string | null }) =>
      api.put(`/games/${game.id}/artwork`, { kind, url }),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not set artwork.'),
  });

  const addScreenshot = useMutation({
    mutationFn: (url: string) => api.post(`/games/${game.id}/screenshots`, { url }),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not add that image.'),
  });

  const removeScreenshot = useMutation({
    mutationFn: (imageId: string) => api.delete(`/games/${game.id}/screenshots/${imageId}`),
    onSuccess: invalidate,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.post(`/games/${game.id}/refresh-artwork`),
    onSuccess: invalidate,
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
        Re-fetch every slot from SteamGridDB
      </button>

      {ART_SLOTS.map((slot) => {
        const current = game.art[slot.kind];
        return (
          <section key={slot.kind} className="gb-card space-y-3 p-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold tracking-wide uppercase">{slot.label}</h3>
              <button
                type="button"
                className="gb-btn-primary ml-auto"
                onClick={() => setPicking(slot.kind)}
              >
                <Images className="h-4 w-4" aria-hidden />
                Browse gallery
              </button>
              {current ? (
                <button
                  type="button"
                  className="gb-btn-danger"
                  onClick={() => setMutation.mutate({ kind: slot.kind, url: null })}
                >
                  Clear
                </button>
              ) : null}
            </div>

            <p className="text-ink-400 text-xs">{slot.hint}</p>

            {current ? (
              <img
                src={current}
                alt=""
                className={`bg-ink-800 rounded-lg ${slot.fit} ${slot.aspect}`}
              />
            ) : (
              <div
                className={`border-ink-700 text-ink-500 flex items-center justify-center rounded-lg border border-dashed ${slot.aspect}`}
              >
                <ImageIcon className="h-5 w-5" aria-hidden />
              </div>
            )}

            {/* The gallery covers almost every case; this stays for the one it
                does not — art neither provider has, pasted from anywhere. */}
            <div className="flex gap-2">
              <input
                className="gb-input"
                aria-label={`${slot.label} image URL`}
                placeholder="…or paste an image URL"
                value={urls[slot.kind] ?? ''}
                onChange={(e) => setUrls({ ...urls, [slot.kind]: e.target.value })}
              />
              <button
                type="button"
                className="gb-btn-ghost shrink-0"
                disabled={!urls[slot.kind]}
                onClick={() => {
                  setMutation.mutate({ kind: slot.kind, url: urls[slot.kind] ?? null });
                  setUrls({ ...urls, [slot.kind]: '' });
                }}
              >
                <Download className="h-4 w-4" aria-hidden />
                Fetch
              </button>
            </div>
          </section>
        );
      })}

      <section className="gb-card space-y-3 p-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold tracking-wide uppercase">Screenshots</h3>
          <button
            type="button"
            className="gb-btn-primary ml-auto"
            onClick={() => setPickingScreenshots(true)}
          >
            <Images className="h-4 w-4" aria-hidden />
            Browse gallery
          </button>
        </div>
        <p className="text-ink-400 text-xs">
          Shown on the game page in the desktop client. Pick as many as you like — the picker stays
          open until you close it.
        </p>

        {game.screenshots.length === 0 ? (
          <p className="text-ink-500 text-xs">None yet.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            {game.screenshots.map((url, index) => {
              const imageId = game.screenshotIds[index];
              return (
                <div key={url} className="group relative">
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
                    className="bg-ink-800 aspect-video w-full rounded-lg object-cover"
                  />
                  <button
                    type="button"
                    className="gb-btn-danger absolute top-1 right-1 px-2 py-1"
                    aria-label="Remove this screenshot"
                    disabled={!imageId || removeScreenshot.isPending}
                    onClick={() => imageId && removeScreenshot.mutate(imageId)}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {picking ? (
        <ArtworkPicker
          gameId={game.id}
          title={game.title}
          kind={picking}
          heading={`${ART_SLOTS.find((slot) => slot.kind === picking)?.label ?? picking} artwork`}
          onClose={() => setPicking(null)}
          onChoose={(url) => setMutation.mutate({ kind: picking, url })}
        />
      ) : null}

      {pickingScreenshots ? (
        // Screenshots come out of the same search as the hero slot: IGDB
        // contributes its screenshots and artwork there, which is exactly what
        // this list wants.
        <ArtworkPicker
          gameId={game.id}
          title={game.title}
          kind="hero"
          heading="Screenshots"
          multiple
          onClose={() => setPickingScreenshots(false)}
          onChoose={(url) => addScreenshot.mutate(url)}
        />
      ) : null}
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

  const autoImportMutation = useMutation({
    mutationFn: () =>
      api.post<{ steamAppId: number; imported: number }>(
        `/admin/games/${game.id}/achievements/auto-import`,
        { replace: false },
      ),
    onSuccess: async (result) => {
      setError(null);
      setSteamAppId(String(result.steamAppId));
      setNotice(
        `Found Steam AppID ${result.steamAppId} and imported ${result.imported} achievements.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['admin', 'achievements', game.id] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not search Steam.'),
  });

  const generateMutation = useMutation({
    mutationFn: () =>
      api.post<{ generated: number; achievements: number; stores: string[] }>(
        `/games/${game.id}/achievement-rules/generate`,
      ),
    onSuccess: (result) => {
      setError(null);
      setNotice(
        `Wrote ${result.generated} rules across ${result.stores.length} layouts, covering ${result.achievements} achievements.`,
      );
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not generate rules.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/games/${game.id}/achievements/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'achievements', game.id] }),
  });

  return (
    <div className="space-y-5">
      <FormError message={error} />
      <Notice message={notice} />

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
          <button
            type="button"
            className="gb-btn-ghost shrink-0"
            disabled={autoImportMutation.isPending || importMutation.isPending}
            onClick={() => autoImportMutation.mutate()}
          >
            {autoImportMutation.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Find & import
          </button>
        </div>
      </section>

      {/* Importing gives you the list; this is what makes any of it unlock. */}
      <section className="gb-card space-y-3 p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">Write the unlock rules</h3>
        <p className="text-ink-400 text-xs leading-relaxed">
          An imported achievement is only a name until something says when it is earned. A DRM-free
          copy records that through whichever Steam emulator it ships with, and each writes to a
          predictable file — so the rules can be generated instead of typed. One is written per
          layout: the ones that do not apply find no file and stay quiet, and whichever the
          player&rsquo;s copy actually uses is the one that fires.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="gb-btn-primary"
            disabled={generateMutation.isPending || (listQuery.data ?? []).length === 0}
            onClick={() => generateMutation.mutate()}
          >
            {generateMutation.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Wand2 className="h-4 w-4" aria-hidden />
            )}
            Generate rules
          </button>
          <p className="text-ink-500 text-xs">
            Replaces any rules this game already has. Needs its Steam app id set.
          </p>
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

/** Mirrors the placeholders `resolve_template` understands in the desktop client's saves.rs. */
const SAVE_PLACEHOLDERS: Array<{ token: string; label: string }> = [
  { token: '{appdata}', label: 'AppData\\Roaming' },
  { token: '{localappdata}', label: 'AppData\\Local' },
  { token: '{documents}', label: 'Documents' },
  { token: '{savedgames}', label: 'Saved Games' },
  { token: '{userprofile}', label: 'User profile folder' },
  { token: '{public}', label: 'Public folder' },
  { token: '{install}', label: 'Game install folder' },
];
const DEFAULT_SAVE_BASE = '{appdata}';

/** Splits a stored `{token}\rest\of\path` template back into the picker's two fields. */
function splitPathTemplate(template: string): { base: string; sub: string } {
  const match = /^(\{[a-z]+\})\\?(.*)$/.exec(template);
  const token = match?.[1];
  if (token && SAVE_PLACEHOLDERS.some((option) => option.token === token)) {
    return { base: token, sub: match?.[2] ?? '' };
  }
  // An unrecognised or hand-edited template still has to go somewhere the
  // admin can see and fix it, rather than being silently dropped.
  return { base: DEFAULT_SAVE_BASE, sub: template };
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

  const executablesQuery = useQuery({
    queryKey: ['admin', 'executables', gameId],
    queryFn: () =>
      api.get<{ candidates: ExecutableCandidate[] }>(`/admin/games/${gameId}/executables`),
  });

  const [launch, setLaunch] = useState({ executable: '', args: '', workingDir: '' });
  const [saveBase, setSaveBase] = useState(DEFAULT_SAVE_BASE);
  const [saveSub, setSaveSub] = useState('');
  const [save, setSave] = useState({ include: '', exclude: '' });

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
    if (s) {
      const { base, sub } = splitPathTemplate(s.pathTemplate);
      setSaveBase(base);
      setSaveSub(sub);
      setSave({ include: s.include ?? '', exclude: s.exclude ?? '' });
    }
  }, [rulesQuery.data]);

  const pathTemplate = saveSub ? `${saveBase}\\${saveSub.replace(/^[\\/]+/, '')}` : saveBase;

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
        pathTemplate,
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

        {executablesQuery.isLoading ? (
          <p className="text-ink-400 text-xs">Looking for .exe files…</p>
        ) : (executablesQuery.data?.candidates.length ?? 0) > 0 ? (
          <div className="space-y-1.5">
            <p className="text-ink-400 text-xs">
              Found in this game's files — pick one instead of typing the path:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {executablesQuery.data?.candidates.map((candidate) => (
                <button
                  key={candidate.path}
                  type="button"
                  className={
                    launch.executable === candidate.path ? 'gb-chip gb-chip-active' : 'gb-chip'
                  }
                  onClick={() => setLaunch({ ...launch, executable: candidate.path })}
                  title={formatBytes(candidate.sizeBytes)}
                >
                  {candidate.path}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-ink-400 text-xs">No .exe found automatically — type the path above.</p>
        )}
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
        <Field label="Save location" htmlFor="rSaveBase" hint="Where the game keeps its saves.">
          <div className="flex gap-2">
            <select
              id="rSaveBase"
              className="gb-input w-auto shrink-0"
              value={saveBase}
              onChange={(e) => setSaveBase(e.target.value)}
            >
              {SAVE_PLACEHOLDERS.map((option) => (
                <option key={option.token} value={option.token}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              id="rSave"
              className="gb-input font-mono"
              value={saveSub}
              onChange={(e) => setSaveSub(e.target.value)}
              placeholder="MyGame\\Saves"
              aria-label="Subfolder within that location"
            />
          </div>
          <p className="text-ink-500 mt-1 font-mono text-xs">{pathTemplate}</p>
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
          disabled={!pathTemplate}
          onClick={() => saveSave.mutate()}
        >
          Save sync rule
        </button>
      </section>

      <AchievementRulesSection gameId={gameId} onError={setError} />
    </div>
  );
}

/**
 * When each of this game's achievements counts as earned.
 *
 * Achievements have been importable since the start and nothing ever unlocked
 * one — there was no way to say what earning it looks like. A rule names a file
 * the game writes and what to find in it; the client reads it when a session
 * ends and reports only the keys that came out.
 *
 * The achievement list is a dropdown rather than a free-text key, because a
 * rule naming a key this game does not have can never fire and there is
 * nothing on screen to reveal that.
 */
function AchievementRulesSection({
  gameId,
  onError,
}: {
  gameId: string;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [rules, setRules] = useState<AchievementRule[] | null>(null);

  const rulesQuery = useQuery({
    queryKey: ['admin', 'game', gameId, 'rules'],
    queryFn: () => api.get<{ achievements?: AchievementRule[] }>(`/games/${gameId}/rules`),
  });

  const definitionsQuery = useQuery({
    queryKey: ['admin', 'game', gameId, 'achievements'],
    queryFn: () => api.get<{ key: string; name: string }[]>(`/admin/games/${gameId}/achievements`),
  });

  const current = rules ?? rulesQuery.data?.achievements ?? [];
  const definitions = definitionsQuery.data ?? [];

  const save = useMutation({
    mutationFn: () => api.put(`/games/${gameId}/achievement-rules`, { rules: current }),
    onSuccess: () => {
      onError(null);
      setRules(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'game', gameId, 'rules'] });
    },
    onError: (caught) =>
      onError(caught instanceof ApiRequestError ? caught.message : 'Could not save the rules.'),
  });

  const update = (index: number, patch: Partial<AchievementRule>) =>
    setRules(current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  if (definitions.length === 0) {
    return (
      <section className="gb-card space-y-2 p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">Achievements</h3>
        <p className="text-ink-400 text-sm">
          Import achievement definitions for this game first — a rule has to name one.
        </p>
      </section>
    );
  }

  return (
    <section className="gb-card space-y-4 p-4">
      <h3 className="text-sm font-semibold tracking-wide uppercase">Achievements</h3>
      <p className="text-ink-400 text-xs">
        Each rule reads a file this game writes and decides whether an achievement is earned. The
        client checks them when a session ends; the file never leaves the player's machine.
      </p>

      {current.map((rule, index) => (
        <div key={index} className="border-ink-700/70 space-y-3 rounded-lg border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Achievement" htmlFor={`ach-${index}`}>
              <select
                id={`ach-${index}`}
                className="gb-input"
                value={rule.achievementKey}
                onChange={(e) => update(index, { achievementKey: e.target.value })}
              >
                {definitions.map((definition) => (
                  <option key={definition.key} value={definition.key}>
                    {definition.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="File" htmlFor={`src-${index}`} hint="Same placeholders as the save path.">
              <input
                id={`src-${index}`}
                className="gb-input font-mono"
                value={rule.sourceTemplate}
                onChange={(e) => update(index, { sourceTemplate: e.target.value })}
                placeholder="{install}\\save\\stats.json"
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Format" htmlFor={`fmt-${index}`}>
              <select
                id={`fmt-${index}`}
                className="gb-input"
                value={rule.format}
                onChange={(e) =>
                  update(index, { format: e.target.value as AchievementRule['format'] })
                }
              >
                {ACHIEVEMENT_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Where"
              htmlFor={`sel-${index}`}
              hint={
                rule.format === 'json'
                  ? 'Dotted path'
                  : rule.format === 'ini'
                    ? 'section.key'
                    : 'Regular expression'
              }
            >
              <input
                id={`sel-${index}`}
                className="gb-input font-mono"
                value={rule.selector}
                onChange={(e) => update(index, { selector: e.target.value })}
                placeholder={rule.format === 'json' ? 'stats.kills' : 'Progress.Done'}
              />
            </Field>
            <Field label="Test" htmlFor={`cmp-${index}`}>
              <select
                id={`cmp-${index}`}
                className="gb-input"
                value={rule.comparator}
                onChange={(e) =>
                  update(index, { comparator: e.target.value as AchievementRule['comparator'] })
                }
              >
                {ACHIEVEMENT_COMPARATORS.map((comparator) => (
                  <option key={comparator} value={comparator}>
                    {comparator}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Value" htmlFor={`val-${index}`}>
              <input
                id={`val-${index}`}
                className="gb-input font-mono"
                value={rule.value ?? ''}
                disabled={rule.comparator === 'present' || rule.comparator === 'truthy'}
                onChange={(e) => update(index, { value: e.target.value || null })}
              />
            </Field>
          </div>

          <button
            type="button"
            className="gb-btn-danger"
            onClick={() => setRules(current.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="gb-btn-ghost"
          onClick={() =>
            setRules([
              ...current,
              {
                achievementKey: definitions[0]?.key ?? '',
                sourceTemplate: '',
                format: 'json',
                selector: '',
                comparator: 'truthy',
                value: null,
              },
            ])
          }
        >
          Add a rule
        </button>
        <button
          type="button"
          className="gb-btn-primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          Save achievement rules
        </button>
      </div>
    </section>
  );
}
