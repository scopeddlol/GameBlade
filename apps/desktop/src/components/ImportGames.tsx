import type { LocalGameMatch } from '@gameblade/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Check, FolderSearch, Link2, X } from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '../lib/format.js';
import { errorMessage, ipc, type InstallCandidate, type InstalledGame } from '../lib/ipc.js';
import { ErrorNote, Spinner } from './ui.js';

/** A scanned folder plus what the server thinks it is. */
interface Row {
  candidate: InstallCandidate;
  matches: LocalGameMatch['matches'];
  /** Empty means "skip this folder". */
  chosenGameId: string;
  linked: boolean;
}

/**
 * Links games the user already has on disk to their catalog entries.
 *
 * The point is not to move or copy anything: someone with a drive full of
 * games should be able to play and cloud-sync them through GameBlade without
 * downloading a second copy of any of them. Every row is confirmed by hand,
 * because a wrong match would attach the wrong cloud saves to the wrong game.
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
  const [error, setError] = useState<string | null>(null);
  const [scannedPath, setScannedPath] = useState<string | null>(null);

  const alreadyLinked = new Set(installed.map((entry) => entry.gameId));

  const scanMutation = useMutation({
    mutationFn: async (roots?: string[]) => {
      const candidates = await ipc.scanInstallCandidates(roots);
      if (candidates.length === 0) return [] as Row[];

      // One request for the whole batch; the server owns the title matching.
      const { results } = await ipc.post<{ results: LocalGameMatch[] }>('/games/match-local', {
        names: candidates.map((candidate) => candidate.name),
      });
      const byName = new Map(results.map((result) => [result.name, result.matches]));

      return candidates.map<Row>((candidate) => {
        const matches = byName.get(candidate.name) ?? [];
        const best = matches[0];
        return {
          candidate,
          matches,
          // Only a confident match is pre-selected. Anything weaker starts as
          // "skip", so a careless click cannot link the wrong game.
          chosenGameId: best && best.score >= 0.75 ? best.gameId : '',
          linked: false,
        };
      });
    },
    onSuccess: (result) => {
      setRows(result);
      setError(null);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const linkMutation = useMutation({
    mutationFn: ({ row, gameId }: { row: Row; gameId: string }) => {
      const title =
        row.matches.find((match) => match.gameId === gameId)?.title ?? row.candidate.name;
      return ipc.linkInstalled(gameId, title, row.candidate.path);
    },
    onSuccess: (_result, variables) => {
      setError(null);
      setRows(
        (current) =>
          current?.map((row) =>
            row.candidate.path === variables.row.candidate.path ? { ...row, linked: true } : row,
          ) ?? null,
      );
      void queryClient.invalidateQueries({ queryKey: ['installed'] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: 'Choose a folder' });
    if (typeof picked !== 'string') return;
    setScannedPath(picked);
    scanMutation.mutate([picked]);
  };

  const linkable = (rows ?? []).filter(
    (row) => !row.linked && row.chosenGameId && !alreadyLinked.has(row.chosenGameId),
  );

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="drawer" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <h2>Import installed games</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="drawer-body">
          <p className="muted small">
            Point GameBlade at a folder that already holds games and it will match what it finds
            against the catalog. Nothing is copied or moved — the files stay exactly where they are.
          </p>

          <ErrorNote message={error} />

          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void browse()}
              disabled={scanMutation.isPending}
            >
              {scanMutation.isPending ? <Spinner /> : <FolderSearch size={15} aria-hidden />}
              Choose a folder…
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setScannedPath(null);
                scanMutation.mutate(undefined);
              }}
              disabled={scanMutation.isPending}
            >
              Scan my install folders
            </button>
          </div>

          {scannedPath ? <p className="muted small mono">{scannedPath}</p> : null}

          {scanMutation.isPending ? (
            <p className="muted small">Looking for games…</p>
          ) : rows === null ? null : rows.length === 0 ? (
            <p className="muted small">
              No folders containing a Windows executable were found there.
            </p>
          ) : (
            <>
              <div className="row between">
                <p className="muted small">
                  {rows.length} folder{rows.length === 1 ? '' : 's'} found
                </p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={linkable.length === 0 || linkMutation.isPending}
                  onClick={() => {
                    for (const row of linkable) {
                      linkMutation.mutate({ row, gameId: row.chosenGameId });
                    }
                  }}
                >
                  <Link2 size={15} aria-hidden />
                  Link {linkable.length} selected
                </button>
              </div>

              <ul className="import-list">
                {rows.map((row) => {
                  const isLinked =
                    row.linked || (row.chosenGameId && alreadyLinked.has(row.chosenGameId));
                  return (
                    <li key={row.candidate.path} className="import-row">
                      <div className="import-info">
                        <strong>{row.candidate.name}</strong>
                        <span className="muted small mono">{row.candidate.path}</span>
                        <span className="muted small">
                          {formatBytes(row.candidate.sizeBytes)} · {row.candidate.executableCount}{' '}
                          executable{row.candidate.executableCount === 1 ? '' : 's'}
                          {row.candidate.executable ? ` · ${row.candidate.executable}` : ''}
                        </span>
                      </div>

                      {isLinked ? (
                        <span className="import-done">
                          <Check size={14} aria-hidden /> Linked
                        </span>
                      ) : (
                        <div className="import-actions">
                          <select
                            className="select"
                            aria-label={`Catalog match for ${row.candidate.name}`}
                            value={row.chosenGameId}
                            onChange={(event) =>
                              setRows(
                                (current) =>
                                  current?.map((entry) =>
                                    entry.candidate.path === row.candidate.path
                                      ? { ...entry, chosenGameId: event.target.value }
                                      : entry,
                                  ) ?? null,
                              )
                            }
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
                            disabled={!row.chosenGameId || linkMutation.isPending}
                            onClick={() => linkMutation.mutate({ row, gameId: row.chosenGameId })}
                          >
                            Link
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
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
