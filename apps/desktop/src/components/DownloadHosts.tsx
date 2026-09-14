import type { GameCopy } from '@gameblade/shared';
import { Gauge, HardDrive, LoaderCircle, Server, Zap } from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '../lib/format.js';
import { errorMessage, ipc, type SourceProbe } from '../lib/ipc.js';
import { Badge } from './ui.js';

/**
 * Where this game is held, and how fast each of those places is from here.
 *
 * Two questions with one answer. A game can live on more than one machine — a
 * home server and a VPS, say — and the client will use whichever turns out to
 * be quicker while a download runs. That happens silently and correctly, which
 * is exactly why it needs a screen: when a download is slower than expected,
 * "which machines are these and what can each of them actually do for me" is
 * the first thing worth knowing, and nothing else in the client can say it.
 *
 * The measurement is a real transfer over the real route, so pressing the
 * button costs a few megabytes and a few seconds. That is deliberate. A
 * synthetic test measures a path nobody downloads over, which is a number that
 * looks reassuring and predicts nothing.
 */
export function DownloadHosts({ gameId, copies }: { gameId: string; copies: GameCopy[] }) {
  const [probes, setProbes] = useState<SourceProbe[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const online = copies.reduce((total, copy) => total + copy.hosts.length, 0);
  const direct = copies.some((copy) => copy.hosts.some((host) => host.direct));

  async function test() {
    setTesting(true);
    setError(null);
    try {
      setProbes(await ipc.testDownloadSources(gameId));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setTesting(false);
    }
  }

  // Nothing is holding it, which the store already says in its own words.
  // Repeating it here as an empty panel would be noise on a page that has
  // already explained itself.
  if (copies.length === 0) return null;

  const fastest = probes
    ?.filter((probe) => probe.ok && probe.bytes_per_second)
    .sort((a, b) => (b.bytes_per_second ?? 0) - (a.bytes_per_second ?? 0))[0];

  return (
    <section className="detail-section">
      <h3>
        <Server size={14} aria-hidden />
        Download hosts
      </h3>

      <p className="muted small">
        {online === 0
          ? 'None of the machines holding this game are online at the moment.'
          : online === 1
            ? 'One machine is holding this game and is online.'
            : `${online} machines are holding this game. Downloads use whichever is quickest and fall back the moment one stops answering.`}
        {direct ? ' At least one of them serves downloads directly.' : ''}
      </p>

      <ul className="host-list">
        {copies.map((copy) => (
          <li key={copy.gameId} className="host-row">
            <span className="host-icon" aria-hidden>
              <HardDrive size={15} />
            </span>
            <div className="host-copy">
              <strong>{copy.libraryName}</strong>
              <span className="muted small truncate">{copy.relPath}</span>
            </div>
            <div className="host-meta">
              <span className="muted small">{formatBytes(copy.sizeBytes)}</span>
              {copy.hosts.length === 0 ? (
                <Badge tone="neutral">Offline</Badge>
              ) : copy.hosts.some((host) => host.direct) ? (
                <Badge tone="success">Direct</Badge>
              ) : (
                <Badge tone="info">Online</Badge>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="host-actions">
        <button type="button" className="btn btn-ghost" onClick={test} disabled={testing}>
          {testing ? (
            <LoaderCircle size={14} className="spin" aria-hidden />
          ) : (
            <Gauge size={14} aria-hidden />
          )}
          {testing ? 'Measuring…' : 'Test download speeds'}
        </button>
        {fastest ? (
          <span className="muted small">
            Fastest right now: <strong>{fastest.label}</strong> at {rate(fastest)}
          </span>
        ) : null}
      </div>

      {error ? <p className="error small">{error}</p> : null}

      {probes ? (
        <ul className="probe-list">
          {probes.map((probe) => (
            <li
              key={`${probe.node_id ?? 'server'}-${probe.direct}`}
              className={probe.ok ? 'probe-row' : 'probe-row failed'}
            >
              <span className="probe-icon" aria-hidden>
                {probe.direct ? <Zap size={14} /> : <Server size={14} />}
              </span>
              <div className="probe-copy">
                <strong>{probe.label}</strong>
                <span className="muted small">
                  {probe.direct ? 'Straight from this host' : 'Relayed by the GameBlade server'}
                </span>
              </div>
              <div className="probe-meta">
                {probe.ok ? (
                  <>
                    <strong>{rate(probe)}</strong>
                    {probe.latency_ms === null ? null : (
                      <span className="muted small">{Math.round(probe.latency_ms)} ms</span>
                    )}
                  </>
                ) : (
                  <span className="muted small">{probe.detail ?? 'Did not answer'}</span>
                )}
              </div>
              {/*
                The bar is the comparison, which is the point of the panel: a
                column of numbers makes "three times faster" arithmetic, and a
                bar makes it obvious.
              */}
              {probe.ok && probe.bytes_per_second ? (
                <span
                  className="probe-bar"
                  style={{ width: `${share(probe, probes)}%` }}
                  aria-hidden
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Megabytes per second, matching every other transfer number in the client. */
function rate(probe: SourceProbe): string {
  const bytes = probe.bytes_per_second ?? 0;
  const mb = bytes / 1_000_000;
  if (mb >= 10) return `${Math.round(mb)} MB/s`;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.round(bytes / 1_000)} kB/s`;
}

/** How wide one bar is, as a share of the fastest source measured. */
function share(probe: SourceProbe, probes: SourceProbe[]): number {
  const best = Math.max(...probes.map((entry) => entry.bytes_per_second ?? 0));
  if (best <= 0) return 0;
  // A floor, so the slowest source is still visibly *something* rather than an
  // invisible sliver that reads as a rendering bug.
  return Math.max(4, Math.round(((probe.bytes_per_second ?? 0) / best) * 100));
}
