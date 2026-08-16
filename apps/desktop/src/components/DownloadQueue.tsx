import { formatBytes, formatEta, formatRate, type DownloadState } from '../lib/ipc.js';

const STATUS_LABEL: Record<DownloadState['status'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  verifying: 'Verifying',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Paused',
};

function badgeClass(status: DownloadState['status']): string {
  if (status === 'completed') return 'badge badge-success';
  if (status === 'failed') return 'badge badge-danger';
  if (status === 'downloading' || status === 'verifying') return 'badge badge-info';
  return 'badge';
}

export function DownloadQueue({
  downloads,
  onCancel,
  onClear,
}: {
  downloads: DownloadState[];
  onCancel: (gameId: string) => void;
  onClear: (gameId: string) => void;
}) {
  if (downloads.length === 0) {
    return (
      <div className="empty">
        <p>No downloads yet.</p>
        <p className="tile-sub">
          Pick a game from the library. Transfers resume automatically if the connection drops.
        </p>
      </div>
    );
  }

  return (
    <div className="queue">
      {downloads.map((download) => {
        const percent =
          download.total_bytes > 0
            ? Math.min(100, (download.downloaded_bytes / download.total_bytes) * 100)
            : 0;
        const active = download.status === 'downloading' || download.status === 'queued';
        const remaining = Math.max(0, download.total_bytes - download.downloaded_bytes);

        return (
          <div className="card queue-item" key={download.game_id}>
            <div className="queue-head">
              <span className="queue-title" title={download.title}>
                {download.title}
              </span>
              <span className={badgeClass(download.status)}>{STATUS_LABEL[download.status]}</span>
              {active ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onCancel(download.game_id)}
                >
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onClear(download.game_id)}
                >
                  Clear
                </button>
              )}
            </div>

            <div className="progress">
              <div className="progress-bar" style={{ width: `${percent}%` }} />
            </div>

            <div className="queue-meta">
              <span>
                {formatBytes(download.downloaded_bytes)} / {formatBytes(download.total_bytes)} (
                {percent.toFixed(1)}%)
              </span>
              {download.status === 'downloading' ? (
                <>
                  <span>{formatRate(download.bytes_per_second)}</span>
                  <span>{formatEta(remaining, download.bytes_per_second)} left</span>
                </>
              ) : null}
              {download.files_total > 1 ? (
                <span>
                  {download.files_completed} / {download.files_total} files
                </span>
              ) : null}
              {download.current_file && download.status === 'downloading' ? (
                <span title={download.current_file}>{download.current_file}</span>
              ) : null}
            </div>

            {download.error ? (
              <div className="error" style={{ marginTop: 10, marginBottom: 0 }}>
                {download.error}
              </div>
            ) : null}

            {download.status === 'completed' ? (
              <div className="queue-meta">
                <span title={download.destination}>Saved to {download.destination}</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
