import clsx from 'clsx';
import { X } from 'lucide-react';
import { formatBytes, formatEta, formatRate } from '../lib/format.js';
import type { DownloadState } from '../lib/ipc.js';
import { Badge, Empty, ProgressBar } from './ui.js';

export function DownloadQueue({
  downloads,
  onCancel,
  onClear,
  onClose,
}: {
  downloads: DownloadState[];
  onCancel: (gameId: string) => void;
  onClear: (gameId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="drawer narrow" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>Downloads</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="drawer-body">
          {downloads.length === 0 ? (
            <Empty
              title="Nothing downloading"
              message="Installs you start from the Store or Library show up here."
            />
          ) : (
            downloads.map((download) => {
              const percent =
                download.total_bytes > 0
                  ? (download.downloaded_bytes / download.total_bytes) * 100
                  : 0;
              const active = download.status === 'downloading' || download.status === 'queued';

              return (
                <div key={download.game_id} className="download">
                  <div className="download-head">
                    <strong>{download.title}</strong>
                    <Badge
                      tone={
                        download.status === 'failed'
                          ? 'danger'
                          : download.status === 'completed'
                            ? 'success'
                            : download.status === 'cancelled'
                              ? 'neutral'
                              : 'info'
                      }
                    >
                      {download.status}
                    </Badge>
                  </div>

                  <ProgressBar value={percent} />

                  <p className="muted small">
                    {formatBytes(download.downloaded_bytes)} of {formatBytes(download.total_bytes)}
                    {active ? (
                      <>
                        {' '}
                        · {formatRate(download.bytes_per_second)} ·{' '}
                        {formatEta(
                          download.total_bytes - download.downloaded_bytes,
                          download.bytes_per_second,
                        )}{' '}
                        left
                      </>
                    ) : null}
                    {download.files_total > 1 ? (
                      <>
                        {' '}
                        · {download.files_completed}/{download.files_total} files
                      </>
                    ) : null}
                  </p>

                  {download.current_file && active ? (
                    <p className={clsx('muted', 'small', 'truncate')}>{download.current_file}</p>
                  ) : null}

                  {download.error ? <p className="error small">{download.error}</p> : null}

                  <div className="download-actions">
                    {active ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => onCancel(download.game_id)}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => onClear(download.game_id)}
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
