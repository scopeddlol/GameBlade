import type { LaunchRuleRow } from '@gameblade/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, Play, Search, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, EmptyState, FormError, Notice, RowSkeleton } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';

interface Page {
  items: LaunchRuleRow[];
  total: number;
  offset: number;
  limit: number;
}

type Status = 'missing' | 'set' | 'all';

const PAGE_SIZE = 50;

/** What a row is currently set to, before anything is written. */
interface Draft {
  executable: string;
  args: string;
  workingDir: string;
}

/** A row's draft, defaulting to whatever the server already has. */
function draftFor(row: LaunchRuleRow, drafts: Record<string, Draft>): Draft {
  return (
    drafts[row.gameId] ?? {
      executable: row.rule?.executable ?? '',
      args: row.rule?.args ?? '',
      workingDir: row.rule?.workingDir ?? '',
    }
  );
}

function isDirty(row: LaunchRuleRow, draft: Draft): boolean {
  return (
    draft.executable !== (row.rule?.executable ?? '') ||
    draft.args !== (row.rule?.args ?? '') ||
    draft.workingDir !== (row.rule?.workingDir ?? '')
  );
}

/**
 * Launch rules, picked rather than typed.
 *
 * A launch rule is one short string — which file to run once a game is
 * installed — and setting it used to mean opening a game, opening its editor,
 * and typing a path from memory. On a catalog of any size that is an afternoon,
 * and the mistakes are invisible: a path that is subtly wrong looks set and
 * fails when a player presses Play, weeks later.
 *
 * So this page is a list of dropdowns. Every row already carries the
 * executables found in that game's own files, largest and shallowest first,
 * with the one whose name matches the title pre-selected. The common case is
 * reading down the page, ticking the ones that look right, and pressing Apply
 * once. Arguments and a working directory are behind a disclosure, because
 * almost nothing needs them and a field per row nobody fills is just noise.
 */
export function AdminLaunchRulesPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('missing');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<string | null>(null);

  const key = ['admin', 'launch-rules', status, search, offset] as const;

  const pageQuery = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<Page>(
        `/admin/launch-rules?status=${status}&offset=${offset}&limit=${PAGE_SIZE}` +
          (search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''),
      ),
    // Without this the list blanks to a skeleton on every keystroke of the
    // filter, which makes typing feel like the page is reloading.
    placeholderData: keepPreviousData,
  });

  const apply = useMutation({
    mutationFn: (rules: Array<{ gameId: string } & Draft>) =>
      api.post<{ applied: number; cleared: number }>('/admin/launch-rules/apply', {
        rules: rules.map((rule) => ({
          gameId: rule.gameId,
          executable: rule.executable,
          args: rule.args || null,
          workingDir: rule.workingDir || null,
        })),
      }),
    onSuccess: (result) => {
      setError(null);
      setTicked({});
      setDrafts({});
      setWritten(
        [
          result.applied > 0
            ? `${result.applied} rule${result.applied === 1 ? '' : 's'} set`
            : null,
          result.cleared > 0 ? `${result.cleared} cleared` : null,
        ]
          .filter(Boolean)
          .join(', ') || 'Nothing changed.',
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'launch-rules'] });
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not write those launch rules.',
      ),
  });

  const items = pageQuery.data?.items ?? [];
  const total = pageQuery.data?.total ?? 0;

  const selected = useMemo(
    () =>
      items
        .filter((row) => ticked[row.gameId])
        .map((row) => ({ gameId: row.gameId, ...draftFor(row, drafts) })),
    [items, ticked, drafts],
  );

  const setDraft = (gameId: string, changes: Partial<Draft>, row: LaunchRuleRow) =>
    setDrafts((current) => ({
      ...current,
      [gameId]: { ...draftFor(row, current), ...changes },
    }));

  /** Take every visible suggestion at once — the fast path for a fresh catalog. */
  const acceptAllSuggestions = () => {
    const nextDrafts: Record<string, Draft> = { ...drafts };
    const nextTicked: Record<string, boolean> = { ...ticked };
    for (const row of items) {
      if (!row.suggestion) continue;
      nextDrafts[row.gameId] = { ...draftFor(row, nextDrafts), executable: row.suggestion };
      nextTicked[row.gameId] = true;
    }
    setDrafts(nextDrafts);
    setTicked(nextTicked);
  };

  const suggestable = items.filter((row) => row.suggestion).length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="gb-page">
      <p className="text-ink-300 text-sm">
        What the desktop client runs once a game is installed. Every row lists the executables
        actually inside that game&rsquo;s folder, so a rule is picked rather than typed — and a game
        with no rule falls back to the client&rsquo;s own guess, which is right often enough to be
        misleading.
      </p>

      <FormError message={error} />
      <Notice message={written} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="text-ink-400 pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            className="gb-input pl-9"
            value={search}
            placeholder="Filter by title…"
            aria-label="Filter games"
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
        </div>

        <div className="flex gap-1" role="group" aria-label="Which games to show">
          {(
            [
              ['missing', 'Needs a rule'],
              ['set', 'Already set'],
              ['all', 'Everything'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={value === status ? 'gb-btn-primary' : 'gb-btn-ghost'}
              aria-pressed={value === status}
              onClick={() => {
                setStatus(value);
                setOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="gb-btn-ghost"
          disabled={suggestable === 0}
          onClick={acceptAllSuggestions}
          title="Fill every row on this page with the executable that best matches its title"
        >
          <Wand2 className="h-4 w-4" aria-hidden />
          Accept {suggestable} suggestion{suggestable === 1 ? '' : 's'}
        </button>

        <button
          type="button"
          className="gb-btn-primary"
          disabled={selected.length === 0 || apply.isPending}
          onClick={() => {
            setError(null);
            setWritten(null);
            apply.mutate(selected);
          }}
        >
          <Check className="h-4 w-4" aria-hidden />
          Apply {selected.length > 0 ? selected.length : ''}
        </button>
      </div>

      {pageQuery.isLoading ? (
        <RowSkeleton rows={8} />
      ) : items.length === 0 ? (
        <EmptyState
          title={
            status === 'missing' ? 'Every game has a launch rule' : 'Nothing matches that filter'
          }
          message={
            status === 'missing'
              ? 'Nothing here is waiting on you. Switch to “Already set” to review or change one.'
              : 'Try a shorter search term.'
          }
        />
      ) : (
        <>
          <div className="divide-ink-700/70 gb-card divide-y">
            {items.map((row) => (
              <RuleRow
                key={row.gameId}
                row={row}
                draft={draftFor(row, drafts)}
                ticked={Boolean(ticked[row.gameId])}
                expanded={Boolean(expanded[row.gameId])}
                onTick={(value) => setTicked((current) => ({ ...current, [row.gameId]: value }))}
                onToggleExpanded={() =>
                  setExpanded((current) => ({ ...current, [row.gameId]: !current[row.gameId] }))
                }
                onChange={(changes) => {
                  setDraft(row.gameId, changes, row);
                  // Editing a row is the gesture that says "include this one";
                  // making the operator then also tick it is a step that only
                  // ever gets forgotten.
                  setTicked((current) => ({ ...current, [row.gameId]: true }));
                }}
              />
            ))}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-ink-400 text-xs">
              {total.toLocaleString()} game{total === 1 ? '' : 's'} · page {page} of {pages}
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
        </>
      )}
    </div>
  );
}

function RuleRow({
  row,
  draft,
  ticked,
  expanded,
  onTick,
  onToggleExpanded,
  onChange,
}: {
  row: LaunchRuleRow;
  draft: Draft;
  ticked: boolean;
  expanded: boolean;
  onTick: (value: boolean) => void;
  onToggleExpanded: () => void;
  onChange: (changes: Partial<Draft>) => void;
}) {
  /*
   * An archive's contents are not indexed, so its candidates cost a read of the
   * zip's central directory. That is fine once, on demand — and ruinous for
   * every archive on a page — so the row fetches its own list when it is opened.
   */
  const archiveQuery = useQuery({
    queryKey: ['admin', 'executables', row.gameId],
    queryFn: () =>
      api.get<{ candidates: Array<{ path: string; sizeBytes: number }> }>(
        `/admin/games/${row.gameId}/executables`,
      ),
    enabled: row.needsArchiveScan && expanded,
  });

  const candidates = row.needsArchiveScan ? (archiveQuery.data?.candidates ?? []) : row.candidates;

  // A rule pointing somewhere the scan cannot see is still a valid rule — an
  // executable produced by an installer, say — so it stays in the list rather
  // than silently resetting the dropdown to "no rule".
  const known = candidates.some((candidate) => candidate.path === draft.executable);
  const options =
    known || !draft.executable
      ? candidates
      : [{ path: draft.executable, sizeBytes: 0 }, ...candidates];

  const dirty = isDirty(row, draft);

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-2"
          checked={ticked}
          aria-label={`Include ${row.title}`}
          onChange={(event) => onTick(event.target.checked)}
        />

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {row.title}
            {row.kind === 'archive' ? <Badge tone="info">Archive</Badge> : null}
            {row.rule?.executable ? (
              <Badge tone="success">Set</Badge>
            ) : (
              <Badge tone="warning">No rule</Badge>
            )}
            {dirty ? <Badge tone="info">Unsaved</Badge> : null}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {row.needsArchiveScan && !expanded ? (
              <p className="text-ink-400 text-xs">
                Open this row to read the archive and list what is inside it.
              </p>
            ) : options.length === 0 ? (
              <p className="text-ink-400 text-xs">
                {archiveQuery.isLoading
                  ? 'Reading the archive…'
                  : 'Nothing in this game looks like an executable. Type a path below if you know it.'}
              </p>
            ) : (
              <select
                className="gb-input max-w-full font-mono text-xs"
                value={draft.executable}
                aria-label={`What to run for ${row.title}`}
                onChange={(event) => onChange({ executable: event.target.value })}
              >
                <option value="">No rule — let the client guess</option>
                {options.map((candidate) => (
                  <option key={candidate.path} value={candidate.path}>
                    {candidate.path}
                    {candidate.sizeBytes > 0
                      ? ` (${Math.round(candidate.sizeBytes / (1024 * 1024))} MB)`
                      : ''}
                  </option>
                ))}
              </select>
            )}

            {/* The suggestion is offered rather than applied, so a row that was
                deliberately set to something else is never quietly overwritten
                by opening this page. */}
            {row.suggestion && draft.executable !== row.suggestion ? (
              <button
                type="button"
                className="gb-btn-ghost text-xs"
                onClick={() => onChange({ executable: row.suggestion as string })}
                title={row.suggestion}
              >
                <Play className="h-3 w-3" aria-hidden />
                Use the suggestion
              </button>
            ) : null}

            <button
              type="button"
              className="gb-btn-ghost text-xs"
              aria-expanded={expanded}
              onClick={onToggleExpanded}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" aria-hidden />
              ) : (
                <ChevronRight className="h-3 w-3" aria-hidden />
              )}
              Advanced
            </button>
          </div>

          {expanded ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="text-ink-400 text-xs">
                Arguments
                <input
                  className="gb-input mt-1 font-mono text-xs"
                  value={draft.args}
                  placeholder="-windowed"
                  onChange={(event) => onChange({ args: event.target.value })}
                />
              </label>
              <label className="text-ink-400 text-xs">
                Working directory
                <input
                  className="gb-input mt-1 font-mono text-xs"
                  value={draft.workingDir}
                  placeholder="Defaults to the folder holding the executable"
                  onChange={(event) => onChange({ workingDir: event.target.value })}
                />
              </label>
              {/* Typing a path is still possible — a game whose entry point an
                  installer creates has nothing to pick from until it exists. */}
              <label className="text-ink-400 text-xs sm:col-span-2">
                Executable, typed
                <input
                  className="gb-input mt-1 font-mono text-xs"
                  value={draft.executable}
                  placeholder="bin/Game.exe"
                  onChange={(event) => onChange({ executable: event.target.value })}
                />
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
