import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CloudDownload, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, EmptyState, FormError, Notice, PageLoader, Spinner } from '../../components/ui.js';
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

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return suggestions;
    return suggestions.filter(
      (s) => s.title.toLowerCase().includes(term) || s.matchedTitle.toLowerCase().includes(term),
    );
  }, [suggestions, search]);

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
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Save paths</h1>
      <p className="text-ink-300 -mt-3 text-sm">
        Where each game keeps its saves, matched against a public database of save locations rather
        than found by playing every title. Nothing is written until you tick it.
      </p>

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
        <PageLoader label="Matching your catalog" />
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
        </>
      )}
    </div>
  );
}
