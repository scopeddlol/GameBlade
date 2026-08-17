import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { HardDrive, Pause, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatEta, formatRate } from '../lib/format.js';
import { ipc, type DownloadState } from '../lib/ipc.js';
import { Badge, Empty, ProgressBar } from './ui.js';

/** How many speed samples the network graph keeps — about two minutes at the progress event's own cadence. */
const SPEED_HISTORY_LENGTH = 30;

export function DownloadQueue({
  downloads,
  onPause,
  onResume,
  onCancel,
  onClear,
  onClose,
}: {
  downloads: DownloadState[];
  onPause: (gameId: string) => void;
  onResume: (gameId: string) => void;
  onCancel: (gameId: string) => void;
  onClear: (gameId: string) => void;
  onClose: () => void;
}) {
  const totalRate = downloads.reduce(
    (sum, d) => (d.status === 'downloading' ? sum + d.bytes_per_second : sum),
    0,
  );
  const speedHistory = useSpeedHistory(totalRate);

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
          <div className="downloads-gauges">
            <NetworkGraph history={speedHistory} currentRate={totalRate} />
            <DiskGauge />
          </div>

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
              const paused = download.status === 'paused';

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
                            : download.status === 'paused'
                              ? 'warning'
                              : download.status === 'canceled'
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
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => onPause(download.game_id)}
                        >
                          <Pause size={14} aria-hidden />
                          Pause
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => onCancel(download.game_id)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : paused ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => onResume(download.game_id)}
                        >
                          <Play size={14} aria-hidden />
                          Resume
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => onClear(download.game_id)}
                        >
                          Dismiss
                        </button>
                      </>
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

/**
 * Tracks the last N aggregate throughput samples for the sparkline. A new
 * sample is only appended when the rate actually changes — `downloads`
 * updates on every progress event, several times a second across files, and
 * sampling all of them would make the graph jitter rather than read as a
 * trend.
 */
function useSpeedHistory(currentRate: number): number[] {
  const [history, setHistory] = useState<number[]>([]);
  const lastRate = useRef<number | null>(null);

  useEffect(() => {
    if (lastRate.current === currentRate) return;
    lastRate.current = currentRate;
    setHistory((current) => [...current, currentRate].slice(-SPEED_HISTORY_LENGTH));
  }, [currentRate]);

  return history;
}

function NetworkGraph({ history, currentRate }: { history: number[]; currentRate: number }) {
  const peak = Math.max(1, ...history);
  const width = 100;
  const height = 32;
  const points = history
    .map((value, index) => {
      const x = history.length > 1 ? (index / (history.length - 1)) * width : width;
      const y = height - (value / peak) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="muted small">Network</span>
        <strong>{currentRate > 0 ? formatRate(currentRate) : 'Idle'}</strong>
      </div>
      <svg
        className="gauge-graph"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {history.length > 1 ? (
          <>
            <polyline points={`0,${height} ${points} ${width},${height}`} className="gauge-fill" />
            <polyline points={points} className="gauge-line" />
          </>
        ) : null}
      </svg>
    </div>
  );
}

function DiskGauge() {
  const usageQuery = useQuery({
    queryKey: ['disk-usage'],
    queryFn: () => ipc.diskUsage(),
    // The install drive doesn't change mid-session; a slow poll just keeps
    // the number honest if something else fills the disk in the background.
    refetchInterval: 30_000,
  });

  const usage = usageQuery.data;
  const usedBytes = usage ? Math.max(0, usage.total_bytes - usage.available_bytes) : 0;
  const usedPercent = usage && usage.total_bytes > 0 ? (usedBytes / usage.total_bytes) * 100 : 0;

  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="muted small">
          <HardDrive size={12} aria-hidden /> Disk
        </span>
        <strong>{usage ? formatBytes(usage.available_bytes) : '—'} free</strong>
      </div>
      <ProgressBar value={usedPercent} />
      {usage ? <p className="muted small">{formatBytes(usage.total_bytes)} total</p> : null}
    </div>
  );
}
