import type { LibraryInfo, ScanProgress } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, RefreshCw, SkipForward, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Field, FormError, Spinner, RowSkeleton } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';
import { formatBytes, formatRelative } from '../../lib/format.js';

export function AdminLibrariesPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const librariesQuery = useQuery({
    queryKey: ['admin', 'libraries'],
    queryFn: () => api.get<LibraryInfo[]>('/admin/libraries'),
  });

  // Poll while a scan is running so progress advances without a manual refresh.
  const progressQuery = useQuery({
    queryKey: ['admin', 'scan'],
    queryFn: () => api.get<ScanProgress>('/admin/scan/progress'),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'scanning' || state === 'matching' ? 1000 : false;
    },
  });

  const addMutation = useMutation({
    mutationFn: () => api.post('/admin/libraries', { name, path, enabled: true }),
    onSuccess: async () => {
      setName('');
      setPath('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'libraries'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not add library.'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/libraries/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'libraries'] }),
  });

  const scanMutation = useMutation({
    mutationFn: (libraryId?: string) =>
      api.post('/admin/scan', { libraryId, force: false, fetchMetadata: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'scan'] }),
  });

  const skipMutation = useMutation({
    mutationFn: () => api.post('/admin/scan/skip'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'scan'] }),
  });

  const progress = progressQuery.data;
  const scanning = progress?.state === 'scanning' || progress?.state === 'matching';

  // "Reading" reports no count, because the walk does not know one yet. Saying
  // which library is being read is what distinguishes it from a stall.
  const phaseLabel =
    progress?.phase === 'reading'
      ? `Reading ${progress.library ?? 'library'}`
      : progress?.phase === 'indexing'
        ? `Indexing ${progress.library ?? 'library'}`
        : progress?.phase === 'matching'
          ? 'Fetching metadata'
          : null;

  return (
    <div className="gb-page">
      <section className="gb-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Scan</h2>
          <button
            type="button"
            className="gb-btn-primary"
            onClick={() => scanMutation.mutate(undefined)}
            disabled={scanning || scanMutation.isPending}
          >
            {scanning ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            {scanning ? 'Scanning…' : 'Scan all libraries'}
          </button>
        </div>

        {progress ? (
          <div className="space-y-2">
            <div className="text-ink-300 flex items-center gap-2 text-sm">
              <Badge
                tone={
                  progress.state === 'error'
                    ? 'danger'
                    : progress.state === 'idle'
                      ? 'neutral'
                      : 'info'
                }
              >
                {progress.state}
              </Badge>
              {scanning && phaseLabel ? <span>{phaseLabel}</span> : null}
              {scanning && progress.total > 0 ? (
                <span>
                  {progress.processed} / {progress.total}
                </span>
              ) : null}
              {scanning && progress.currentItem ? (
                <span className="truncate">{progress.currentItem}</span>
              ) : null}
              {scanning && progress.skipped > 0 ? <span>{progress.skipped} skipped</span> : null}
              {progress.finishedAt && !scanning ? (
                <span>Last finished {formatRelative(progress.finishedAt)}</span>
              ) : null}
            </div>

            {scanning && progress.total > 0 ? (
              <div className="bg-ink-700 h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="bg-blade-500 h-full transition-all"
                  style={{
                    width: `${Math.min(100, (progress.processed / progress.total) * 100)}%`,
                  }}
                />
              </div>
            ) : null}

            {scanning ? (
              <div>
                <button
                  type="button"
                  className="gb-btn-ghost text-xs"
                  onClick={() => skipMutation.mutate()}
                  disabled={skipMutation.isPending}
                >
                  <SkipForward className="h-3.5 w-3.5" />
                  Skip this one
                </button>
              </div>
            ) : null}

            {progress.log.length > 0 ? (
              <details className="text-xs" open={scanning}>
                <summary className="text-ink-400 cursor-pointer select-none">
                  Activity ({progress.log.length})
                </summary>
                <ul className="bg-ink-900/50 mt-2 max-h-56 space-y-1 overflow-y-auto rounded p-2 font-mono">
                  {progress.log
                    .slice()
                    .reverse()
                    .map((line) => (
                      <li
                        key={`${line.at}-${line.message}`}
                        className={line.level === 'warn' ? 'text-amber-400' : 'text-ink-300'}
                      >
                        <span className="text-ink-500">
                          {new Date(line.at).toLocaleTimeString()}
                        </span>{' '}
                        {line.message}
                      </li>
                    ))}
                </ul>
              </details>
            ) : null}

            {progress.state === 'error' && progress.error ? (
              <FormError message={progress.error} />
            ) : null}

            {!scanning && progress.finishedAt ? (
              <p className="text-ink-400 text-xs">
                {progress.added} added · {progress.updated} updated · {progress.removed} missing
                {progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ''}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Library folders</h2>

        {librariesQuery.isLoading ? (
          <RowSkeleton rows={2} />
        ) : (librariesQuery.data ?? []).length === 0 ? (
          <p className="text-ink-400 mb-4 text-sm">
            No libraries yet. Add the path <em>inside the container</em> — for example{' '}
            <code className="bg-ink-800 rounded px-1">/library</code> if you mounted your games
            there.
          </p>
        ) : (
          <div className="divide-ink-700/70 mb-4 divide-y">
            {(librariesQuery.data ?? []).map((library) => (
              <div key={library.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {library.name} {library.enabled ? null : <Badge tone="warning">Disabled</Badge>}
                  </p>
                  <p className="text-ink-400 truncate font-mono text-xs">{library.path}</p>
                  <p className="text-ink-400 mt-0.5 text-xs">
                    {library.gameCount} games · {formatBytes(library.totalBytes)} · scanned{' '}
                    {formatRelative(library.lastScanAt)}
                    {library.lastScanStatus?.startsWith('error') ? (
                      <span className="text-amber-400"> · {library.lastScanStatus}</span>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  className="gb-btn-ghost shrink-0"
                  onClick={() => scanMutation.mutate(library.id)}
                  disabled={scanning}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Scan
                </button>
                <button
                  type="button"
                  className="gb-btn-danger shrink-0"
                  onClick={() => {
                    if (
                      confirm(
                        `Remove "${library.name}" from GameBlade? Your files on disk are not touched.`,
                      )
                    ) {
                      removeMutation.mutate(library.id);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            addMutation.mutate();
          }}
        >
          <div className="min-w-[160px] flex-1">
            <Field label="Name" htmlFor="libName">
              <input
                id="libName"
                className="gb-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Games"
                required
              />
            </Field>
          </div>
          <div className="min-w-[240px] flex-[2]">
            <Field label="Path in container" htmlFor="libPath">
              <input
                id="libPath"
                className="gb-input font-mono"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/library"
                required
              />
            </Field>
          </div>
          <button type="submit" className="gb-btn-primary" disabled={addMutation.isPending}>
            <FolderPlus className="h-4 w-4" aria-hidden />
            Add
          </button>
        </form>
        <FormError message={error} />
      </section>
    </div>
  );
}
