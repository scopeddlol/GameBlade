import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CloudDownload, Eye, EyeOff, Search, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, EmptyState, FormError, Notice, Spinner, RowSkeleton } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';

interface ManifestStatus {
  games: number;
  fetchedAt: string | null;
  stale: boolean;
}

interface SavePath {
  pathTemplate: string;
  include: string | null;
}

interface Suggestion {
  gameId: string;
  title: string;
  matchedTitle: string;
  hasExistingRule: boolean;
  saves: SavePath[];
}

/** How a path reads once both halves are put back together. */
function describe(save: SavePath): string {
  return save.include ? `${save.pathTemplate}\\${save.include}` : save.pathTemplate;
}

/**
 * Save paths, suggested rather than hunted for.
 *
 * Finding where a game saves by hand means installing it, playing it, making a
 * save and going looking — for every title. This matches the catalog against a
 * public database of save locations and proposes the rules instead.
 *
 * Nothing is written without a tick. A title match is occasionally confident
 * and wrong, and these paths are where the client will read and write a
 * player's saves, so the manifest's own title is shown beside the archive's for
 * every row.
 */
export function AdminSavePathsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState<number | null>(null);
  // Defaults to hiding them: a title that already has a rule is settled work,
  // and on a large catalog those rows are most of the list — the ones worth
  // looking at are the ones with nothing set.
  const [hideSettled, setHideSettled] = useState(true);

  const statusQuery = useQuery({
    queryKey: ['admin', 'save-manifest'],
    queryFn: () => api.get<ManifestStatus>('/admin/save-manifest'),
  });

  const suggestionsQuery = useQuery({
    queryKey: ['admin', 'save-manifest', 'suggestions'],
    queryFn: () =>
      api.get<{ suggestions: Suggestion[]; needsRefresh: boolean }>(
        '/admin/save-manifest/suggestions',
      ),
  });

  const refresh = useMutation({
    mutationFn: () => api.post<ManifestStatus>('/admin/save-manifest/refresh'),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'save-manifest'] });
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not fetch the save manifest.',
      ),
  });

  const apply = useMutation({
    mutationFn: (rules: Array<{ gameId: string; pathTemplate: string; include: string | null }>) =>
      api.post<{ applied: number }>('/admin/save-manifest/apply', { rules }),
    onSuccess: (result) => {
      setApplied(result.applied);
      setTicked({});
      void queryClient.invalidateQueries({ queryKey: ['admin', 'save-manifest', 'suggestions'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save the rules.'),
  });

  const suggestions = suggestionsQuery.data?.suggestions ?? [];

  const settledCount = useMemo(
    () => suggestions.filter((s) => s.hasExistingRule).length,
    [suggestions],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return suggestions.filter((s) => {
      if (hideSettled && s.hasExistingRule) return false;
      if (!term) return true;
      return s.title.toLowerCase().includes(term) || s.matchedTitle.toLowerCase().includes(term);
    });
  }, [suggestions, search, hideSettled]);

  const pathFor = (s: Suggestion) =>
    chosen[s.gameId] ?? describe(s.saves[0] ?? { pathTemplate: '', include: null });

  const selectedRules = suggestions
    .filter((s) => ticked[s.gameId])
    .map((s) => {
      const picked = s.saves.find((save) => describe(save) === pathFor(s)) ?? s.saves[0];
      return {
        gameId: s.gameId,
        pathTemplate: picked?.pathTemplate ?? '',
        include: picked?.include ?? null,
      };
    })
    .filter((rule) => rule.pathTemplate !== '');

  const status = statusQuery.data;

  return (
    <div className="gb-page">
      <p className="text-ink-300 text-sm">
        Where each game keeps its saves, matched against a public database of save locations rather
        than found by playing every title. Nothing is written until you tick it.
      </p>

      <AchievementGaps />

      <FormError message={error} />
      <Notice
        message={
          applied === null ? null : `${applied} save ${applied === 1 ? 'rule' : 'rules'} written.`
        }
      />

      <section className="gb-card flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {status?.games ? `${status.games.toLocaleString()} games indexed` : 'No data yet'}
          </p>
          <p className="text-ink-400 text-xs">
            {status?.fetchedAt
              ? `Updated ${new Date(status.fetchedAt).toLocaleDateString()}${status.stale ? ' — worth refreshing' : ''}`
              : 'Fetch the index to start getting suggestions.'}
          </p>
        </div>
        <button
          type="button"
          className="gb-btn-ghost"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <CloudDownload className="h-4 w-4" aria-hidden />
          )}
          {status?.games ? 'Refresh index' : 'Fetch index'}
        </button>
      </section>

      {suggestionsQuery.isLoading ? (
        <RowSkeleton rows={5} />
      ) : suggestions.length === 0 ? (
        <EmptyState
          title="No suggestions"
          message={
            status?.games
              ? 'None of the games in your catalog appear in the index by name.'
              : 'Fetch the index above, then come back.'
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search
                className="text-ink-400 pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
                aria-hidden
              />
              <input
                className="gb-input pl-9"
                value={search}
                placeholder="Filter…"
                aria-label="Filter suggestions"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {/* The pile of already-settled titles is the noise this page
                accumulates as it gets used. Hiding them is the default, and
                the count is on the button so nothing is silently missing. */}
            <button
              type="button"
              className="gb-btn-ghost"
              aria-pressed={!hideSettled}
              onClick={() => setHideSettled((current) => !current)}
            >
              {hideSettled ? (
                <EyeOff className="h-4 w-4" aria-hidden />
              ) : (
                <Eye className="h-4 w-4" aria-hidden />
              )}
              {hideSettled
                ? `Show the ${settledCount} with a rule`
                : `Hide the ${settledCount} with a rule`}
            </button>
            <button
              type="button"
              className="gb-btn-ghost"
              onClick={() =>
                setTicked(
                  Object.fromEntries(
                    visible.filter((s) => !s.hasExistingRule).map((s) => [s.gameId, true]),
                  ),
                )
              }
            >
              Select all without a rule
            </button>
            <button
              type="button"
              className="gb-btn-primary"
              disabled={selectedRules.length === 0 || apply.isPending}
              onClick={() => {
                setError(null);
                setApplied(null);
                apply.mutate(selectedRules);
              }}
            >
              {apply.isPending ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <Check className="h-4 w-4" aria-hidden />
              )}
              Apply {selectedRules.length > 0 ? selectedRules.length : ''}
            </button>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title={search ? 'Nothing matches that' : 'Every match already has a rule'}
              message={
                search
                  ? 'Try a shorter search term.'
                  : 'Nothing here is waiting on you. Show the settled ones above to review or replace them.'
              }
            />
          ) : (
            <div className="divide-ink-700/70 gb-card divide-y">
              {visible.map((suggestion) => (
                <div key={suggestion.gameId} className="flex gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={Boolean(ticked[suggestion.gameId])}
                    aria-label={`Apply a save rule for ${suggestion.title}`}
                    onChange={(event) =>
                      setTicked((current) => ({
                        ...current,
                        [suggestion.gameId]: event.target.checked,
                      }))
                    }
                  />

                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {suggestion.title}
                      {suggestion.hasExistingRule ? (
                        <Badge tone="warning">Would replace an existing rule</Badge>
                      ) : null}
                    </p>

                    {/* The manifest's own title, so a confident wrong match is
                      obvious without opening anything. */}
                    {suggestion.matchedTitle !== suggestion.title ? (
                      <p className="text-ink-400 text-xs">matched “{suggestion.matchedTitle}”</p>
                    ) : null}

                    {suggestion.saves.length === 1 ? (
                      <p className="text-ink-300 mt-1 font-mono text-xs break-all">
                        {describe(suggestion.saves[0]!)}
                      </p>
                    ) : (
                      <select
                        className="gb-input mt-1.5 font-mono text-xs"
                        value={pathFor(suggestion)}
                        aria-label={`Save location for ${suggestion.title}`}
                        onChange={(event) =>
                          setChosen((current) => ({
                            ...current,
                            [suggestion.gameId]: event.target.value,
                          }))
                        }
                      >
                        {suggestion.saves.map((save) => (
                          <option key={describe(save)} value={describe(save)}>
                            {describe(save)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface SaveGap {
  gameId: string;
  title: string;
  achievementCount: number;
  candidates: Array<{ pathTemplate: string; ruleCount: number }>;
}

/**
 * Games whose achievements are read out of a folder nothing is syncing.
 *
 * This is the same information as the manifest suggester below, arrived at
 * from the opposite direction and far more reliably. The manifest can only
 * help with titles it recognises; this reads what an operator has already
 * written down. An unlock rule points at a file the game wrote into its own
 * save folder, so every one of these games has had its save location recorded
 * — in the achievement column, where nothing syncs it.
 *
 * Left alone, those players lose their achievements along with their saves the
 * first time they move machine, which is the worse half of the bug: a save can
 * be copied back by hand, and an unlock cannot.
 */
function AchievementGaps() {
  const queryClient = useQueryClient();
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [written, setWritten] = useState<number | null>(null);

  const gapsQuery = useQuery({
    queryKey: ['admin', 'save-gaps'],
    queryFn: () =>
      api.get<{ gaps: SaveGap[]; gamesWithoutSaveRule: number }>('/admin/save-rules/gaps'),
  });

  const apply = useMutation({
    mutationFn: (rules: Array<{ gameId: string; pathTemplate: string; include: null }>) =>
      api.post<{ applied: number }>('/admin/save-rules/from-achievements', { rules }),
    onSuccess: (result) => {
      setWritten(result.applied);
      setTicked({});
      setFailure(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'save-gaps'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'save-manifest', 'suggestions'] });
    },
    onError: (caught) =>
      setFailure(
        caught instanceof ApiRequestError ? caught.message : 'Could not write those rules.',
      ),
  });

  const gaps = gapsQuery.data?.gaps ?? [];
  const orphaned = gapsQuery.data?.gamesWithoutSaveRule ?? 0;

  const pathFor = (gap: SaveGap) => chosen[gap.gameId] ?? gap.candidates[0]?.pathTemplate ?? '';

  const selected = gaps
    .filter((gap) => ticked[gap.gameId])
    .map((gap) => ({ gameId: gap.gameId, pathTemplate: pathFor(gap), include: null as null }))
    .filter((rule) => rule.pathTemplate !== '');

  if (gapsQuery.isLoading) return <SectionSkeletonFallback />;
  if (gaps.length === 0) {
    return orphaned > 0 ? (
      <section className="gb-card p-4">
        <p className="text-ink-400 text-xs">
          {orphaned} {orphaned === 1 ? 'game has' : 'games have'} no save rule, and none of them has
          achievement rules to derive one from. The suggestions below are where to start.
        </p>
      </section>
    ) : null;
  }

  return (
    <section className="gb-card space-y-3 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
          <Trophy className="h-4 w-4" aria-hidden />
          Achievements without cloud saves
        </h2>
        <p className="text-ink-400 mt-1 text-xs leading-relaxed">
          These {gaps.length === 1 ? 'game reads its' : `${gaps.length} games read their`}{' '}
          achievements out of a folder nothing is syncing — so the unlocks live on one machine and
          vanish with it. The folder is taken from the unlock rules themselves, which is where it
          was already written down.
          {orphaned > gaps.length
            ? ` ${orphaned} games have no save rule in total; these are the ones that can be fixed from what is already here.`
            : ''}
        </p>
      </div>

      <FormError message={failure} />
      <Notice
        message={written === null ? null : `${written} save ${written === 1 ? 'rule' : 'rules'} written.`}
      />

      <div className="divide-ink-700/70 divide-y">
        {gaps.map((gap) => (
          <label key={gap.gameId} className="flex items-start gap-3 py-2.5">
            <input
              type="checkbox"
              className="mt-1"
              checked={Boolean(ticked[gap.gameId])}
              onChange={(event) =>
                setTicked((current) => ({ ...current, [gap.gameId]: event.target.checked }))
              }
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {gap.title}{' '}
                <Badge tone="warning">
                  {gap.achievementCount}{' '}
                  {gap.achievementCount === 1 ? 'achievement' : 'achievements'}
                </Badge>
              </p>
              {gap.candidates.length === 1 ? (
                <p className="text-ink-400 mt-1 font-mono text-xs break-all">
                  {gap.candidates[0]?.pathTemplate}
                </p>
              ) : (
                // Two layouts — a retail install and an emulator, usually. The
                // operator picks; guessing here writes a rule that syncs the
                // wrong folder and looks like it worked.
                <select
                  className="gb-input mt-1.5 font-mono text-xs"
                  value={pathFor(gap)}
                  aria-label={`Save location for ${gap.title}`}
                  onChange={(event) =>
                    setChosen((current) => ({ ...current, [gap.gameId]: event.target.value }))
                  }
                >
                  {gap.candidates.map((candidate) => (
                    <option key={candidate.pathTemplate} value={candidate.pathTemplate}>
                      {candidate.pathTemplate} ({candidate.ruleCount}{' '}
                      {candidate.ruleCount === 1 ? 'rule' : 'rules'})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="gb-btn-primary"
          disabled={selected.length === 0 || apply.isPending}
          onClick={() => apply.mutate(selected)}
        >
          {apply.isPending ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          Create {selected.length} save {selected.length === 1 ? 'rule' : 'rules'}
        </button>
        <button
          type="button"
          className="gb-btn-ghost"
          onClick={() =>
            setTicked(Object.fromEntries(gaps.map((gap) => [gap.gameId, true])))
          }
        >
          Select all
        </button>
      </div>
    </section>
  );
}

function SectionSkeletonFallback() {
  return (
    <section className="gb-card p-5">
      <RowSkeleton rows={3} />
    </section>
  );
}
