import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  HardDrive,
  LoaderCircle,
  Pause,
  Play,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatEta, formatRate } from '../lib/format.js';
import { ipc, type DownloadState } from '../lib/ipc.js';
import { Badge, Empty, Modal, ProgressBar } from './ui.js';

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
  onCancel: (gameId: string, deleteFiles: boolean) => void;
  onClear: (gameId: string, deleteFiles: boolean) => void;
  onClose: () => void;
}) {
  // What the user is being asked about, if anything. Held here rather than per
  // row so the dialog survives the row re-rendering underneath it, which it
  // does several times a second while a download is running.
  const [pending, setPending] = useState<{ download: DownloadState; kind: Kind } | null>(null);
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
              const installing = download.status === 'installing';
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

                  {download.current_file && (active || installing) ? (
                    <p className={clsx('muted', 'small', 'truncate')}>{download.current_file}</p>
                  ) : null}

                  {download.sources?.length ? <ConnectionSummary download={download} /> : null}

                  {download.error ? <p className="error small">{download.error}</p> : null}

                  <div className="download-actions">
                    {installing ? null : active ? (
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
                          onClick={() => setPending({ download, kind: 'cancel' })}
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
                          onClick={() => setPending({ download, kind: 'dismiss' })}
                        >
                          Dismiss
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() =>
                          // Nothing was left behind by a download that finished
                          // or was already purged, so there is nothing to ask
                          // about — the row just goes.
                          download.downloaded_bytes > 0 && download.status !== 'completed'
                            ? setPending({ download, kind: 'dismiss' })
                            : onClear(download.game_id, false)
                        }
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

      {pending ? (
        <StopDownloadDialog
          download={pending.download}
          kind={pending.kind}
          onChoose={(deleteFiles) => {
            const act = pending.kind === 'cancel' ? onCancel : onClear;
            act(pending.download.game_id, deleteFiles);
            setPending(null);
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Which machines this download is actually pulling from.
 *
 * The headline is the summary a player wants at a glance — am I connected, and
 * to what — and the list under it is the detail an operator wants when the
 * answer is "not really". Every source the client attempted stays listed,
 * failures included, because a node that could not be reached is the single
 * most useful thing on screen when a download will not start.
 */
function ConnectionSummary({ download }: { download: DownloadState }) {
  const connected = uniqueLabels(
    download.sources
      .filter((source) => source.status === 'connected')
      .map((source) => source.label),
  );
  const available = uniqueLabels(
    download.sources
      .filter((source) => source.status === 'available')
      .map((source) => source.label),
  );
  const attempted = uniqueLabels(download.sources.map((source) => source.label));
  const names = connected.length ? connected : available.length ? available : attempted;
  const failed = connected.length === 0 && available.length === 0;
  const waiting = !failed && download.status === 'queued';

  return (
    <div
      className={clsx('download-connection', failed && 'failed', waiting && 'connecting')}
      aria-label="Download connection"
    >
      <div className="download-connection-icon" aria-hidden>
        {failed ? (
          <TriangleAlert size={17} />
        ) : waiting ? (
          <LoaderCircle size={17} />
        ) : (
          <ShieldCheck size={17} />
        )}
      </div>
      <div className="download-connection-copy">
        <span className="muted small">Secure connection</span>
        <strong>
          {failed
            ? `Couldn't connect to ${naturalJoin(names)}`
            : waiting
              ? `Connecting to ${naturalJoin(names)}`
              : `Connected to ${naturalJoin(names)}`}
        </strong>
        <span className="muted small">
          {failed
            ? 'GameBlade could not reach an available copy.'
            : connected.length
              ? 'Secure GameBlade download'
              : 'Secure HTTPS through the Coordinator'}
        </span>
      </div>
      <span className="download-connection-pulse" aria-hidden />
    </div>
  );
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels.filter(Boolean))];
}

function naturalJoin(labels: string[]): string {
  if (labels.length === 0) return 'an available source';
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} & ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} & ${labels.at(-1)}`;
}

/** Whether the download is still running, which decides the dialog's wording. */
type Kind = 'cancel' | 'dismiss';

/**
 * The question that used to go unasked.
 *
 * Stopping a download left everything it had fetched on the disk with nothing
 * in the app ever mentioning it again — cancel a 250 GB install 100 GB in and
 * that is 100 GB gone until somebody goes looking for it by hand. Both answers
 * are legitimate, which is why this asks rather than picking one: a transfer
 * being stopped to be resumed later wants its bytes kept, and one being
 * abandoned wants the space back.
 *
 * Keeping the files is the safe default and sits first; removing them is
 * styled as the destructive action it is, with the figure spelled out so the
 * choice is made knowing what is at stake.
 */
function StopDownloadDialog({
  download,
  kind,
  onChoose,
  onClose,
}: {
  download: DownloadState;
  kind: Kind;
  onChoose: (deleteFiles: boolean) => void;
  onClose: () => void;
}) {
  const written = formatBytes(download.downloaded_bytes);
  const title =
    kind === 'cancel'
      ? `Stop downloading ${download.title}?`
      : `Remove ${download.title} from the list?`;

  return (
    <Modal title={title} onClose={onClose}>
      <p>
        {written} of {download.title} {kind === 'cancel' ? 'has been' : 'is'} written to{' '}
        <span className="path">{download.destination}</span>.
      </p>
      <p className="muted small">
        Keeping the files lets the download pick up where it left off later. Removing them frees the
        space now and starts from nothing next time.
      </p>

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Never mind
        </button>
        <button type="button" className="btn" onClick={() => onChoose(false)}>
          Keep the files
        </button>
        <button type="button" className="btn btn-danger" onClick={() => onChoose(true)}>
          <Trash2 size={14} aria-hidden />
          Remove {written}
        </button>
      </div>
    </Modal>
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
