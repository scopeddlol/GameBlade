import type { LocalGameMatch } from '@gameblade/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Check, CloudUpload, FolderSearch, Link2, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatBytes } from '../lib/format.js';
import {
  errorMessage,
  ipc,
  type ImportRoot,
  type InstallCandidate,
  type InstalledGame,
  type LocalSave,
} from '../lib/ipc.js';
import { ErrorNote, Spinner } from './ui.js';

/** A scanned folder plus what the server thinks it is. */
interface Row {
  candidate: InstallCandidate;
  matches: LocalGameMatch['matches'];
  /** Empty means "skip this folder". */
  chosenGameId: string;
  linked: boolean;
  /**
   * A save found on this disk for the chosen match, if there is one.
   *
   * `undefined` while it is still being looked for, `null` once the answer is
   * "there isn't one" — the two read very differently on screen.
   */
  save?: LocalSave | null;
  /** Set once the save has been sent to the server. */
  saveUploaded: boolean;
}

/** How confident a match has to be before it is pre-selected. */
const CONFIDENT = 0.75;

/**
 * Rebuilds a library from what is already on this machine.
 *
 * Two things happen here, and the second is the one that matters after a
 * reinstall or a lost profile. The first is the old job: match folders against
 * catalog titles so a copy already on disk is played rather than downloaded
 * again. The second is the saves. A player who lost their library still has
 * their save folders — those live under AppData and Documents, not in the
 * install — and until now nothing looked for them. Every match carries its
 * save rule, so the scan can say "and there is a save here" before anything is
 * linked, and offer to put it back in the cloud.
 *
 * Nothing is written without a confirmation. A wrong match attaches the wrong
 * cloud saves to the wrong game, which is the one mistake here that destroys
 * something.
 */
export function ImportGames({
  installed,
  onClose,
}: {
  installed: InstalledGame[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [roots, setRoots] = useState<ImportRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadSaves, setUploadSaves] = useState(true);

  const alreadyLinked = new Set(installed.map((entry) => entry.gameId));

  const patch = (path: string, changes: Partial<Row>) =>
    setRows(
      (current) =>
        current?.map((row) => (row.candidate.path === path ? { ...row, ...changes } : row)) ?? null,
    );

  const scanMutation = useMutation({
    mutationFn: async (chosenRoots?: string[]) => {
      const scan = await ipc.scanForImport(chosenRoots);
      if (scan.candidates.length === 0) return { roots: scan.roots, rows: [] as Row[] };

      // One request for the whole batch; the server owns the title matching and
      // sends each match's save rule back with it.
      const { results } = await ipc.post<{ results: LocalGameMatch[] }>('/games/match-local', {
        names: scan.candidates.map((candidate) => candidate.name),
      });
      const byName = new Map(results.map((result) => [result.name, result.matches]));

      const built = scan.candidates.map<Row>((candidate) => {
        const matches = byName.get(candidate.name) ?? [];
        const best = matches[0];
        return {
          candidate,
          matches,
          // Only a confident match is pre-selected. Anything weaker starts as
          // "skip", so a careless click cannot link the wrong game.
          chosenGameId: best && best.score >= CONFIDENT ? best.gameId : '',
          linked: false,
          saveUploaded: false,
        };
      });

      return { roots: scan.roots, rows: built };
    },
    onSuccess: (result) => {
      setRoots(result.roots);
      setRows(result.rows);
      setError(null);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  // Scanning the mapped folders is what somebody opening this wants, so it
  // starts on its own rather than behind a button they have to find first.
  useEffect(() => {
    scanMutation.mutate(undefined);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Look for a save wherever each chosen match says one lives.
   *
   * Run when the selections settle rather than once up front: the rule belongs
   * to the *chosen* game, and changing a dropdown changes where to look.
   * Reading a save folder is cheap; reading the wrong one is misleading.
   *
   * The whole outstanding batch is resolved and then applied in one update.
   * Patching row by row would re-run this effect after each one, which on a
   * drive of a hundred folders is a hundred restarts to do a hundred lookups.
   */
  const awaitingLookup = (rows ?? [])
    .filter((row) => row.chosenGameId && row.save === undefined)
    .map((row) => `${row.candidate.path}\u0000${row.chosenGameId}`)
    .join('\u0001');

  useEffect(() => {
    if (!awaitingLookup) return;

    let cancelled = false;
    void (async () => {
      const pending = (rows ?? []).filter((row) => row.chosenGameId && row.save === undefined);

      const found = await Promise.all(
        pending.map(async (row) => {
          const rule = row.matches.find((match) => match.gameId === row.chosenGameId)?.saveRule;
          if (!rule) return [row.candidate.path, null] as const;

          const save = await ipc
            .inspectLocalSave(
              { pathTemplate: rule.pathTemplate, include: rule.include, exclude: rule.exclude },
              row.candidate.path,
            )
            // A save folder that cannot be read is the same answer as one that
            // is not there: nothing to offer to upload.
            .catch(() => null);
          return [row.candidate.path, save] as const;
        }),
      );

      if (cancelled) return;
      const byPath = new Map(found);
      setRows(
        (current) =>
          current?.map((row) =>
            byPath.has(row.candidate.path)
              ? { ...row, save: byPath.get(row.candidate.path) ?? null }
              : row,
          ) ?? null,
      );
    })();

    return () => {
      cancelled = true;
    };
    // Keyed on which folders are still waiting and what they were matched to,
    // so re-running on any other change to a row is not possible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingLookup]);

  const linkMutation = useMutation({
    mutationFn: async ({ row, gameId }: { row: Row; gameId: string }) => {
      const match = row.matches.find((entry) => entry.gameId === gameId);
      await ipc.linkInstalled(gameId, match?.title ?? row.candidate.name, row.candidate.path);

      // The save goes up straight after the link, while the folder is known and
      // the player is still watching. Not forced: `push_save` without `force`
      // refuses when the cloud copy is ahead, which is exactly the case where
      // overwriting would be the wrong thing to do silently.
      if (!uploadSaves || !row.save || !match?.saveRule) return { uploaded: false };

      const rule = {
        pathTemplate: match.saveRule.pathTemplate,
        include: match.saveRule.include,
        exclude: match.saveRule.exclude,
      };
      await ipc.pushSave(gameId, rule, false);
      return { uploaded: true };
    },
    onSuccess: (result, variables) => {
      setError(null);
      patch(variables.row.candidate.path, { linked: true, saveUploaded: result.uploaded });
      void queryClient.invalidateQueries({ queryKey: ['installed'] });
    },
    onError: (caught, variables) => {
      // The link may well have succeeded and only the save upload failed, so
      // the row is not marked done — but the message says which half it was.
      setError(`${variables.row.candidate.name}: ${errorMessage(caught)}`);
    },
  });

  const browse = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choose a folder to search',
    });
    if (typeof picked !== 'string') return;
    scanMutation.mutate([picked]);
  };

  const linkable = (rows ?? []).filter(
    (row) => !row.linked && row.chosenGameId && !alreadyLinked.has(row.chosenGameId),
  );
  const savesFound = (rows ?? []).filter((row) => row.save).length;

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="drawer" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <h2>Import from this PC</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="drawer-body">
          <p className="muted small">
            Searches the folders GameBlade installs to, matches what it finds against the catalog,
            and looks for save files that belong to each match. Nothing is copied or moved — the
            games stay exactly where they are.
          </p>

          <ErrorNote message={error} />

          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => scanMutation.mutate(undefined)}
              disabled={scanMutation.isPending}
            >
              {scanMutation.isPending ? <Spinner /> : <FolderSearch size={15} aria-hidden />}
              Rescan my game folders
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void browse()}
              disabled={scanMutation.isPending}
            >
              Search another folder…
            </button>
          </div>

          <ScannedRoots roots={roots} pending={scanMutation.isPending} />

          {scanMutation.isPending ? (
            <p className="muted small">Looking for games…</p>
          ) : rows === null ? null : rows.length === 0 ? (
            <p className="muted small">
              No folders containing a Windows executable were found in the folders above.
            </p>
          ) : (
            <>
              <label className="import-toggle">
                <input
                  type="checkbox"
                  checked={uploadSaves}
                  onChange={(event) => setUploadSaves(event.target.checked)}
                />
                <span>
                  <strong>Upload the saves I find</strong>
                  <span className="muted small">
                    {savesFound > 0
                      ? `${savesFound} save${savesFound === 1 ? '' : 's'} found on this PC. `
                      : ''}
                    A save is only sent when the cloud has nothing newer, so this cannot overwrite
                    progress from another machine.
                  </span>
                </span>
              </label>

              <div className="row between">
                <p className="muted small">
                  {rows.length} folder{rows.length === 1 ? '' : 's'} found
                </p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={linkable.length === 0 || linkMutation.isPending}
                  onClick={() => {
                    setError(null);
                    for (const row of linkable) {
                      linkMutation.mutate({ row, gameId: row.chosenGameId });
                    }
                  }}
                >
                  <Link2 size={15} aria-hidden />
                  Import {linkable.length} selected
                </button>
              </div>

              <ul className="import-list">
                {rows.map((row) => (
                  <ImportRow
                    key={row.candidate.path}
                    row={row}
                    done={
                      row.linked || Boolean(row.chosenGameId && alreadyLinked.has(row.chosenGameId))
                    }
                    pending={linkMutation.isPending}
                    onChoose={(gameId) =>
                      // Clearing the save re-runs the lookup against the newly
                      // chosen game's rule, which is a different folder.
                      patch(row.candidate.path, { chosenGameId: gameId, save: undefined })
                    }
                    onLink={() => linkMutation.mutate({ row, gameId: row.chosenGameId })}
                  />
                ))}
              </ul>

              {rows.every((row) => row.matches.length === 0) ? (
                <p className="muted small">
                  None of these folders matched a game in the catalog. They may not be on this
                  server, or the folder names may differ too much from the catalog titles.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Which folders were searched, and whether each one is still there. */
function ScannedRoots({ roots, pending }: { roots: ImportRoot[] | null; pending: boolean }) {
  if (!roots || roots.length === 0) return null;

  return (
    <ul className="import-roots">
      {roots.map((root) => (
        <li key={root.path} className={root.exists ? undefined : 'missing-root'}>
          {root.exists ? null : <AlertTriangle size={12} aria-hidden />}
          <span className="mono">{root.path}</span>
          <span className="muted small">
            {!root.exists
              ? 'not on this PC any more'
              : pending
                ? 'searching…'
                : `${root.found} found`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ImportRow({
  row,
  done,
  pending,
  onChoose,
  onLink,
}: {
  row: Row;
  done: boolean;
  pending: boolean;
  onChoose: (gameId: string) => void;
  onLink: () => void;
}) {
  return (
    <li className="import-row">
      <div className="import-info">
        <strong>{row.candidate.name}</strong>
        <span className="muted small mono">{row.candidate.path}</span>
        <span className="muted small">
          {formatBytes(row.candidate.sizeBytes)} · {row.candidate.executableCount} executable
          {row.candidate.executableCount === 1 ? '' : 's'}
          {row.candidate.executable ? ` · ${row.candidate.executable}` : ''}
        </span>

        {/* The save line only appears once there is something to say about it,
            so a list of a hundred folders does not gain a hundred "no save"
            rows nobody asked about. */}
        {row.save ? (
          <span className="import-save">
            <Save size={12} aria-hidden />
            {row.save.fileCount} save file{row.save.fileCount === 1 ? '' : 's'} ·{' '}
            {formatBytes(row.save.sizeBytes)}
            {row.saveUploaded ? (
              <span className="import-save-done">
                <CloudUpload size={12} aria-hidden /> uploaded
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      {done ? (
        <span className="import-done">
          <Check size={14} aria-hidden /> Imported
        </span>
      ) : (
        <div className="import-actions">
          <select
            className="select"
            aria-label={`Catalog match for ${row.candidate.name}`}
            value={row.chosenGameId}
            onChange={(event) => onChoose(event.target.value)}
          >
            <option value="">Skip this folder</option>
            {row.matches.map((match) => (
              <option key={match.gameId} value={match.gameId}>
                {match.title} ({Math.round(match.score * 100)}%)
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn btn-ghost"
            disabled={!row.chosenGameId || pending}
            onClick={onLink}
          >
            Import
          </button>
        </div>
      )}
    </li>
  );
}
