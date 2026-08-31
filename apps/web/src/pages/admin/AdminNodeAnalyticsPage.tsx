import { useState } from 'react';
import { AreaChart, RankedBars, StatTile, type Point } from '../../components/charts.js';
import { Badge, SectionSkeleton } from '../../components/ui.js';
import { formatBytes } from '../../lib/format.js';
import { useMeshAnalytics } from './meshData.js';

const RANGES = [7, 14, 30, 90] as const;

/**
 * How much download traffic is supplied by Nodes through the Coordinator.
 */
export function AdminNodeAnalyticsPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  const analyticsQuery = useMeshAnalytics(days);
  const report = analyticsQuery.data;

  if (!report) return <SectionSkeleton rows={4} />;

  const share = Math.round(report.bytes.meshShare * 100);

  const meshSeries: Point[] = report.history.map((point) => ({
    label: point.date,
    short: point.date.slice(5),
    value: point.meshBytes,
    display: formatBytes(point.meshBytes),
  }));

  const originSeries: Point[] = report.history.map((point) => ({
    label: point.date,
    short: point.date.slice(5),
    value: point.originBytes,
    display: formatBytes(point.originBytes),
  }));

  return (
    <div className="gb-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-ink-400 text-xs">
          Node transfers are recorded as verified chunks arrive at the Coordinator.
        </p>
        <div className="flex gap-1">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              className={range === days ? 'gb-btn text-xs' : 'gb-btn-ghost text-xs'}
              onClick={() => setDays(range)}
            >
              {range}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Node-backed share"
          value={`${share}%`}
          hint={`${formatBytes(report.bytes.mesh7d)} of ${formatBytes(report.bytes.origin7d)} this week`}
        />
        <StatTile
          label="Nodes served"
          value={formatBytes(report.bytes.mesh24h)}
          hint="in the last 24 hours"
        />
        <StatTile
          label="This server served"
          value={formatBytes(report.bytes.origin24h)}
          hint="in the last 24 hours"
        />
        <StatTile
          label="All time, from nodes"
          value={formatBytes(report.bytes.meshLifetime)}
          hint="since Node transfers were enabled"
        />
      </div>

      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">
          Bytes served by nodes
        </h2>
        <p className="text-ink-400 mb-3 text-xs">
          Verified chunks supplied by Nodes and forwarded through the Coordinator.
        </p>
        <AreaChart points={meshSeries} emptyMessage="No node transfers in this period." />
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">
          Bytes served by this server
        </h2>
        <p className="text-ink-400 mb-3 text-xs">
          Total bytes delivered through the Coordinator in the same period.
        </p>
        <AreaChart points={originSeries} emptyMessage="No downloads from this server." />
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">Catalog coverage</h2>
        <p className="text-ink-400 mb-3 text-xs">
          How much of the archive an online node can actually hand over. A game no node holds is a
          game cannot currently be downloaded from the Node fleet.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            dense
            label="Games"
            value={report.coverage.games.toLocaleString('en')}
            hint="in the catalog"
          />
          <StatTile
            dense
            label="On a node"
            value={report.coverage.covered.toLocaleString('en')}
            hint={`${percent(report.coverage.covered, report.coverage.games)}% of the catalog`}
          />
          <StatTile
            dense
            label="One node only"
            value={report.coverage.singleSource.toLocaleString('en')}
            hint="a drive failure from gone"
          />
          <StatTile
            dense
            label="No node"
            value={report.coverage.uncovered.toLocaleString('en')}
            hint="served from here"
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="gb-card p-5">
          <h2 className="mb-3 text-sm font-semibold tracking-wide uppercase">
            Busiest nodes, 7 days
          </h2>
          <RankedBars
            points={report.topNodes.map((node) => ({
              label: node.label,
              value: node.bytes,
              display: formatBytes(node.bytes),
            }))}
            emptyMessage="No node has served anything this week."
          />
        </section>

        <section className="gb-card p-5">
          <h2 className="mb-3 text-sm font-semibold tracking-wide uppercase">
            Most-pulled games, 7 days
          </h2>
          <RankedBars
            points={report.topGames.map((game) => ({
              label: game.title,
              value: game.bytes,
              display: formatBytes(game.bytes),
            }))}
            limit={8}
            emptyMessage="Nothing has been pulled from a node this week."
          />
        </section>
      </div>

      <section className="gb-card p-5">
        <h2 className="mb-3 text-sm font-semibold tracking-wide uppercase">The fleet</h2>
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge tone="success">{report.nodes.online} online</Badge>
          <Badge tone="warning">{report.nodes.stale} stale</Badge>
          <Badge tone="danger">{report.nodes.blocked} blocked</Badge>
          <Badge tone="neutral">{report.nodes.pending} pending</Badge>
          <Badge tone="neutral">{report.nodes.operator} managed Nodes</Badge>
        </div>
      </section>
    </div>
  );
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}
