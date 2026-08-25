import {
  BULK_ACHIEVEMENT_BATCH,
  type AchievementDefinitionInput,
  type BulkImportResult,
  type CatalogGap,
  type GameSummary,
  type Paginated,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  ListPlus,
  Search,
  Square,
  SquareCheckBig,
  Trophy,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  Badge,
  EmptyState,
  Field,
  FormError,
  Notice,
  RowSkeleton,
  Spinner,
} from '../../components/ui.js';
import { api, ApiRequestError, queryString } from '../../lib/api.js';

/**
 * Achievements, for more than one game at a time.
 *
 * Every other route into achievements is one game deep: open the catalog
 * editor, find the tab, press Find & import, close it, do it again. That is
 * fine for a correction and unusable as a way to get a catalog of several
 * hundred games from nothing to covered — which is the actual job, and the one
 * that had no tool at all.
 *
 * Two of them, because there are two reasons a game has no achievements. Most
 * are on Steam and just have not been imported, so the first tool picks a set
 * of games and works through them. The rest are not on Steam in any usable
 * form — a fan translation, an itch-only release, a version whose store entry
 * predates its achievements — and no amount of searching will find them, so
 * the second tool takes a pasted list.
 */
export function AdminAchievementsPage() {
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="gb-page">
      <Notice message={notice} />
      <BulkSteamImport onNotice={setNotice} />
      <PasteDefinitions onNotice={setNotice} />
    </div>
  );
}

/* -------------------------------------------------------------- from Steam */

/** How the game list is narrowed before anything is selected. */
type Scope = 'missing' | 'all';

interface Progress {
  done: number;
  total: number;
  /** Set while a batch is in flight, so the button can say "stop" and mean it. */
  running: boolean;
}

function BulkSteamImport({ onNotice }: { onNotice: (message: string | null) => void }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>('missing');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState({
    generateRules: true,
    skipExisting: true,
    replace: false,
  });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [results, setResults] = useState<BulkImportResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Both, and they mean different things. The ref is what the loop reads
  // between batches — it is the only copy that is up to date inside an async
  // function that closed over its state a batch ago — and the state is what
  // re-renders the button so it says so.
  const stopRequested = useRef(false);
  const [stopping, setStopping] = useState(false);

  const listQuery = useQuery({
    queryKey: ['admin', 'achievements-bulk', scope, search],
    queryFn: () =>
      api.get<Paginated<GameSummary>>(
        `/games${queryString({
          search: search.trim(),
          // The same gap the catalog's "No achievements" chip filters on, so
          // the two screens can never disagree about what is missing.
          missing: scope === 'missing' ? ('achievements' satisfies CatalogGap) : undefined,
          includeMissing: false,
          sort: 'title',
          // The API's ceiling. A bigger catalog is worked through a page at a
          // time, which the count under the list says plainly — a run of two
          // hundred games takes minutes anyway, so this is not the bottleneck.
          limit: 200,
        })}`,
      ),
  });

  const statsQuery = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api.get<{ gaps: Record<CatalogGap, number> }>('/admin/stats'),
  });

  const games = useMemo(() => listQuery.data?.items ?? [], [listQuery.data]);
  const chosen = games.filter((game) => selected.has(game.id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allShownSelected = games.length > 0 && games.every((game) => selected.has(game.id));

  /**
   * Walks the selection in batches, keeping the results as they land.
   *
   * The alternative — one request carrying every game — is what makes a tool
   * like this useless in practice: it holds a connection open for minutes,
   * says nothing while it does, and throws the whole run away if anything
   * drops. Batching means the operator watches it go, can stop it, and keeps
   * whatever finished.
   */
  const run = async () => {
    const queue = chosen.map((game) => game.id);
    if (queue.length === 0) return;

    setError(null);
    setResults([]);
    stopRequested.current = false;
    setStopping(false);
    onNotice(null);
    setProgress({ done: 0, total: queue.length, running: true });

    const collected: BulkImportResult[] = [];
    let stopped = false;

    for (let at = 0; at < queue.length; at += BULK_ACHIEVEMENT_BATCH) {
      if (stopRequested.current) {
        stopped = true;
        break;
      }

      const batch = queue.slice(at, at + BULK_ACHIEVEMENT_BATCH);
      try {
        const response = await api.post<{ results: BulkImportResult[] }>(
          '/admin/achievements/bulk-import',
          { gameIds: batch, ...options },
        );
        collected.push(...response.results);
      } catch (caught) {
        // A batch that failed outright — the server went away, the key was
        // pulled — ends the run rather than repeating the same failure down
        // the rest of the list.
        setError(
          caught instanceof ApiRequestError
            ? caught.message
            : 'The import stopped: the server did not answer.',
        );
        stopped = true;
        break;
      }

      setResults([...collected]);
      setProgress({ done: collected.length, total: queue.length, running: true });
    }

    setProgress({ done: collected.length, total: queue.length, running: false });
    stopRequested.current = false;
    setStopping(false);

    const imported = collected.filter((entry) => entry.status === 'imported');
    const failed = collected.filter((entry) => entry.status === 'failed');
    const total = imported.reduce((sum, entry) => sum + entry.imported, 0);

    onNotice(
      imported.length === 0
        ? `${stopped ? 'Stopped. ' : ''}Nothing was imported.`
        : `${stopped ? 'Stopped. ' : ''}Imported ${total} achievements across ${imported.length} ${
            imported.length === 1 ? 'game' : 'games'
          }${failed.length > 0 ? `; ${failed.length} could not be done automatically.` : '.'}`,
    );

    // The games that gained achievements have left the "No achievements"
    // filter, and the counts behind every chip on the catalog page are stale.
    setSelected(new Set());
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'achievements-bulk'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'catalog'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] }),
    ]);
  };

  const missingCount = statsQuery.data?.gaps.achievements;
  const busy = progress?.running ?? false;

  return (
    <section className="gb-card space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Import from Steam in bulk</h2>
        {missingCount === undefined ? null : (
          <Badge tone={missingCount > 0 ? 'warning' : 'success'}>
            {missingCount} without achievements
          </Badge>
        )}
      </div>

      <p className="text-ink-400 text-xs leading-relaxed">
        Finds each game on Steam, reads its published achievement list, and writes the unlock rules
        that make them fire. Published metadata only — no player data is requested and no account is
        linked, so this works for a DRM-free copy of a game that also ships there. Needs a Steam Web
        API key in Settings.
      </p>

      <FormError message={error} />

      {/* ------------------------------------------------------------ scope */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <Field label="Search" htmlFor="bulkSearch">
            <div className="relative">
              <Search
                className="text-ink-400 pointer-events-none absolute top-2.5 left-3 h-4 w-4"
                aria-hidden
              />
              <input
                id="bulkSearch"
                className="gb-input pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Title…"
                disabled={busy}
              />
            </div>
          </Field>
        </div>

        <Field label="Show" htmlFor="bulkScope">
          <select
            id="bulkScope"
            className="gb-input w-auto"
            value={scope}
            disabled={busy}
            onChange={(e) => setScope(e.target.value as Scope)}
          >
            <option value="missing">Games with no achievements</option>
            <option value="all">Every game</option>
          </select>
        </Field>
      </div>

      {/* ---------------------------------------------------------- options */}
      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={options.generateRules}
            disabled={busy}
            onChange={(e) => setOptions({ ...options, generateRules: e.target.checked })}
          />
          <span>
            Write the unlock rules too
            <span className="text-ink-400 block text-xs">
              An imported achievement is only a name until something says when it is earned. Leave
              this on unless you intend to write them by hand.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={options.skipExisting}
            disabled={busy}
            onChange={(e) => setOptions({ ...options, skipExisting: e.target.checked })}
          />
          <span>
            Skip games that already have achievements
            <span className="text-ink-400 block text-xs">
              Off re-imports them, which is how you refresh a set after Steam changed it.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={options.replace}
            disabled={busy || options.skipExisting}
            onChange={(e) => setOptions({ ...options, replace: e.target.checked })}
          />
          <span>
            Replace what Steam imported before
            <span className="text-ink-400 block text-xs">
              Only relevant when re-importing. Hand-added achievements are never touched — merging
              by key is the default, and it keeps them.
            </span>
          </span>
        </label>
      </div>

      {/* ------------------------------------------------------------- list */}
      {listQuery.isLoading ? (
        <RowSkeleton rows={5} />
      ) : games.length === 0 ? (
        <EmptyState
          title={scope === 'missing' ? 'Every game has achievements' : 'Nothing matches'}
          message={
            scope === 'missing'
              ? 'Nothing left to import. Switch to every game to re-import a set.'
              : 'Adjust the search.'
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="gb-btn-ghost"
              disabled={busy}
              onClick={() =>
                setSelected(allShownSelected ? new Set() : new Set(games.map((g) => g.id)))
              }
            >
              {allShownSelected ? (
                <Square className="h-4 w-4" aria-hidden />
              ) : (
                <SquareCheckBig className="h-4 w-4" aria-hidden />
              )}
              {allShownSelected ? 'Clear' : `Select all ${games.length}`}
            </button>
            <span className="text-ink-400 text-xs">
              {selected.size} selected
              {selected.size > BULK_ACHIEVEMENT_BATCH
                ? ` · ${Math.ceil(selected.size / BULK_ACHIEVEMENT_BATCH)} batches`
                : ''}
            </span>
            {(listQuery.data?.total ?? 0) > games.length ? (
              <span className="text-ink-500 ml-auto text-xs">
                Showing the first {games.length} of {listQuery.data?.total.toLocaleString()} — run
                this again for the rest.
              </span>
            ) : null}
          </div>

          <div className="divide-ink-700/70 gb-card max-h-96 divide-y overflow-y-auto">
            {games.map((game) => (
              <label
                key={game.id}
                className="hover:bg-ink-800/60 flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(game.id)}
                  disabled={busy}
                  onChange={() => toggle(game.id)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{game.title}</span>
                {game.achievementCount > 0 ? (
                  <Badge tone="success">{game.achievementCount}</Badge>
                ) : (
                  <span className="text-ink-500 text-xs">none</span>
                )}
              </label>
            ))}
          </div>
        </>
      )}

      {/* ---------------------------------------------------------- running */}
      {progress ? (
        <div className="space-y-1">
          <div className="bg-ink-800 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-blade-500 h-full transition-[width]"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
          <p className="text-ink-400 text-xs">
            {progress.done} of {progress.total} done
            {progress.running ? ' — this takes a moment per game.' : '.'}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="gb-btn-primary"
          disabled={busy || selected.size === 0}
          onClick={() => void run()}
        >
          {busy ? <Spinner className="h-4 w-4" /> : <Trophy className="h-4 w-4" aria-hidden />}
          {busy
            ? 'Importing…'
            : `Import ${selected.size || ''} ${selected.size === 1 ? 'game' : 'games'}`.trim()}
        </button>

        {busy ? (
          <button
            type="button"
            className="gb-btn-ghost"
            disabled={stopping}
            onClick={() => {
              stopRequested.current = true;
              setStopping(true);
            }}
          >
            {stopping ? 'Stopping after this batch…' : 'Stop'}
          </button>
        ) : null}
      </div>

      {results.length > 0 ? <ResultTable results={results} /> : null}
    </section>
  );
}

/**
 * What happened to each game.
 *
 * Failures are what this list is for, so they sort to the top: a run of two
 * hundred games where six could not be placed is a success plus a six-item
 * worklist, and the six must not be somewhere in the middle of two hundred
 * green ticks.
 */
function ResultTable({ results }: { results: BulkImportResult[] }) {
  const rank = { failed: 0, skipped: 1, imported: 2 } as const;
  const ordered = [...results].sort((a, b) => rank[a.status] - rank[b.status]);

  return (
    <div className="divide-ink-700/70 gb-card max-h-80 divide-y overflow-y-auto">
      {ordered.map((entry) => (
        <div key={entry.gameId} className="flex items-start gap-2 px-3 py-2">
          {entry.status === 'imported' ? (
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
          ) : entry.status === 'skipped' ? (
            <CircleSlash className="text-ink-500 mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{entry.title}</span>
            <span className="text-ink-400 block text-xs leading-relaxed">{entry.message}</span>
          </span>
          {entry.steamAppId ? (
            <span className="text-ink-500 shrink-0 font-mono text-xs">{entry.steamAppId}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- pasted list */

/**
 * One achievement, parsed out of a line the operator pasted.
 *
 * Tab-separated first, because that is what a spreadsheet and a copied wiki
 * table both produce and neither needs explaining. Comma and pipe are accepted
 * as well, and a line with no separator at all is taken as just a name — which
 * is the shape of the list somebody types out by hand.
 */
function parseLine(line: string, index: number): AchievementDefinitionInput | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const cells = (
    trimmed.includes('\t')
      ? trimmed.split('\t')
      : trimmed.includes('|')
        ? trimmed.split('|')
        : splitCsv(trimmed)
  ).map((cell) => cell.trim());

  const name = cells[0] ?? '';
  if (!name) return null;

  const description = cells[1] ?? '';
  const points = Number(cells[2]);

  return {
    // A key is what a rule matches on, so it has to be stable and unique. When
    // the paste does not supply one, it is derived from the name rather than
    // from the row number: a list re-pasted with one row inserted would
    // otherwise renumber everything below it and orphan every rule.
    key: cells[3]?.trim() || slug(name) || `achievement-${index + 1}`,
    name,
    description: description || null,
    points: Number.isFinite(points) && points > 0 ? Math.min(Math.round(points), 1000) : 10,
    hidden: false,
    globalPercent: null,
    source: 'manual',
    sortOrder: index,
  };
}

/** Splits on commas, respecting the quotes a spreadsheet puts round a comma. */
function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === '"') {
      // A doubled quote inside a quoted cell is one literal quote.
      if (quoted && line[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 190);
}

function PasteDefinitions({ onNotice }: { onNotice: (message: string | null) => void }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [gameId, setGameId] = useState('');
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gamesQuery = useQuery({
    queryKey: ['admin', 'achievements-paste', search],
    queryFn: () =>
      api.get<Paginated<GameSummary>>(
        `/games${queryString({ search: search.trim(), sort: 'title', limit: 50 })}`,
      ),
  });

  const parsed = useMemo(
    () =>
      text
        .split('\n')
        .map((line, index) => parseLine(line, index))
        .filter((entry): entry is AchievementDefinitionInput => entry !== null),
    [text],
  );

  const save = useMutation({
    mutationFn: () =>
      api.post<{ written: number; total: number }>(`/admin/games/${gameId}/achievements/bulk`, {
        achievements: parsed,
        replace,
      }),
    onSuccess: async (result) => {
      setError(null);
      setText('');
      onNotice(
        `Wrote ${result.written} ${result.written === 1 ? 'achievement' : 'achievements'}; the game now has ${result.total}.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'achievements', gameId] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'achievements-bulk'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'catalog'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] }),
      ]);
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save the list.'),
  });

  const games = gamesQuery.data?.items ?? [];

  return (
    <section className="gb-card space-y-4 p-5">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Paste a list</h2>

      <p className="text-ink-400 text-xs leading-relaxed">
        For the games Steam cannot help with. One achievement per line:{' '}
        <code className="font-mono">name</code>, then optionally{' '}
        <code className="font-mono">description</code>, <code className="font-mono">points</code>{' '}
        and <code className="font-mono">key</code>, separated by tabs, commas or pipes — so a column
        copied straight out of a spreadsheet or a wiki table works as it is. Lines starting with{' '}
        <code className="font-mono">#</code> are ignored. A missing key is derived from the name and
        stays stable if you paste the list again.
      </p>

      <FormError message={error} />

      <Field label="Find the game" htmlFor="pasteSearch">
        <div className="relative">
          <Search
            className="text-ink-400 pointer-events-none absolute top-2.5 left-3 h-4 w-4"
            aria-hidden
          />
          <input
            id="pasteSearch"
            className="gb-input pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Title…"
          />
        </div>
      </Field>

      <Field label="Game" htmlFor="pasteGame">
        <select
          id="pasteGame"
          className="gb-input"
          value={gameId}
          onChange={(e) => setGameId(e.target.value)}
        >
          <option value="">Choose a game…</option>
          {games.map((game) => (
            <option key={game.id} value={game.id}>
              {game.title}
              {game.achievementCount > 0 ? ` (${game.achievementCount} already)` : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Achievements"
        htmlFor="pasteBody"
        hint={
          parsed.length === 0
            ? 'Nothing to write yet.'
            : `${parsed.length} ${parsed.length === 1 ? 'achievement' : 'achievements'} read from what you pasted.`
        }
      >
        <textarea
          id="pasteBody"
          className="gb-input min-h-40 font-mono text-xs"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            'First Blood\tWin your first duel\t10\nThe Long Way\tFinish without fast travel\t50'
          }
        />
      </Field>

      {parsed.length > 0 ? (
        <div className="divide-ink-700/70 bg-ink-800/50 max-h-56 divide-y overflow-y-auto rounded-lg">
          {parsed.slice(0, 50).map((entry) => (
            <div key={entry.key} className="px-3 py-1.5">
              <p className="truncate text-sm">
                {entry.name}
                <span className="text-ink-500 ml-2 text-xs">{entry.points} pts</span>
              </p>
              <p className="text-ink-500 truncate font-mono text-[11px]">{entry.key}</p>
            </div>
          ))}
          {parsed.length > 50 ? (
            <p className="text-ink-500 px-3 py-1.5 text-xs">
              …and {parsed.length - 50} more, all of which will be written.
            </p>
          ) : null}
        </div>
      ) : null}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={replace}
          onChange={(e) => setReplace(e.target.checked)}
        />
        <span>
          Replace everything this game has
          <span className="text-ink-400 block text-xs">
            Removes its existing achievements and their unlock rules first. Off merges by key, which
            is what you want for a correction.
          </span>
        </span>
      </label>

      <button
        type="button"
        className="gb-btn-primary"
        disabled={!gameId || parsed.length === 0 || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <ListPlus className="h-4 w-4" aria-hidden />
        )}
        Add {parsed.length || ''} {parsed.length === 1 ? 'achievement' : 'achievements'}
      </button>
    </section>
  );
}
