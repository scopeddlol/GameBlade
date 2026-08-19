import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AreaChart, ColumnChart, Meter, RankedBars, StatTile } from '../../components/charts.js';
import { Badge, EmptyState, PageLoader } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';

/** Mirrors AnalyticsReport on the server. */
interface AnalyticsReport {
  rangeDays: number;
  since: string;
  summary: {
    downloads: number;
    bytes: number;
    completedDownloads: number;
    activeUsers: number;
    playSeconds: number;
    monthBytes: number;
    allTimeBytes: number;
  };
  daily: Array<{ date: string; bytes: number; downloads: number }>;
  monthly: Array<{ month: string; bytes: number; downloads: number }>;
  topGamesByDownloads: Array<{ gameId: string; title: string; downloads: number; bytes: number }>;
  topGamesByPlaytime: Array<{ gameId: string; title: string; seconds: number; players: number }>;
  topUsers: Array<{ userId: string; username: string; downloads: number; bytes: number }>;
  recentDownloads: Array<{
    id: string;
    at: string;
    username: string | null;
    title: string | null;
    bytes: number;
    completed: boolean;
    client: string;
  }>;
  quotas: Array<{ userId: string; username: string; usedBytes: number; quotaBytes: number }>;
}

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
] as const;

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 1000) return `${Math.round(hours).toLocaleString()} h`;
  if (hours >= 10) return `${hours.toFixed(0)} h`;
  if (hours >= 1) return `${hours.toFixed(1)} h`;
  return `${Math.round(seconds / 60)} min`;
}

function formatMonth(month: string): string {
  const [year, index] = month.split('-');
  const name = MONTH_NAMES[Number(index) - 1] ?? month;
  return `${name} ${year}`;
}

/**
 * Who downloaded what, what gets played, and where the bandwidth goes.
 *
 * One request backs the whole page: every panel comes out of the same two
 * tables, so six endpoints would each pay their own round trip for one query's
 * worth of data.
 */
export function AdminAnalyticsPage() {
  const [days, setDays] = useState<number>(30);

  const reportQuery = useQuery({
    queryKey: ['admin', 'analytics', days],
    queryFn: () => api.get<AnalyticsReport>(`/admin/analytics?days=${days}`),
  });

  if (reportQuery.isLoading) return <PageLoader label="Loading analytics" />;
  const report = reportQuery.data;
  if (!report) {
    return <EmptyState title="No data yet" message="Analytics appear once games are downloaded." />;
  }

  const { summary } = report;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>

        {/* Filters in one row above the charts. */}
        <div className="ml-auto flex gap-1.5">
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              className={days === range.days ? 'gb-chip gb-chip-active' : 'gb-chip'}
              aria-pressed={days === range.days}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Transferred"
          value={formatBytes(summary.bytes)}
          hint={`in the last ${report.rangeDays} days`}
        />
        <StatTile
          label="This month"
          value={formatBytes(summary.monthBytes)}
          hint={`${formatBytes(summary.allTimeBytes)} all time`}
        />
        <StatTile
          label="Downloads"
          value={summary.downloads.toLocaleString()}
          hint={`${summary.completedDownloads.toLocaleString()} completed`}
        />
        <StatTile
          label="Play time"
          value={formatHours(summary.playSeconds)}
          hint={`${summary.activeUsers} accounts downloading`}
        />
      </div>

      <section className="gb-card space-y-3 p-5">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Bandwidth per day</h2>
        <AreaChart
          points={report.daily.map((point) => ({
            label: point.date,
            value: point.bytes,
            display: `${formatBytes(point.bytes)} · ${point.downloads} download${
              point.downloads === 1 ? '' : 's'
            }`,
          }))}
          emptyMessage="Nothing was downloaded in this period."
        />
      </section>

      <section className="gb-card space-y-3 p-5">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Bandwidth per month</h2>
        <ColumnChart
          points={report.monthly.map((point) => ({
            label: formatMonth(point.month),
            short: MONTH_NAMES[Number(point.month.split('-')[1]) - 1] ?? point.month,
            value: point.bytes,
            display: `${formatBytes(point.bytes)} · ${point.downloads} download${
              point.downloads === 1 ? '' : 's'
            }`,
          }))}
          emptyMessage="No downloads recorded yet."
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="gb-card space-y-3 p-5">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Most downloaded</h2>
          <RankedBars
            points={report.topGamesByDownloads.map((row) => ({
              label: row.title,
              value: row.downloads,
              display: `${row.downloads} · ${formatBytes(row.bytes)}`,
            }))}
          />
        </section>

        <section className="gb-card space-y-3 p-5">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Most played</h2>
          <RankedBars
            points={report.topGamesByPlaytime.map((row) => ({
              label: row.title,
              value: row.seconds,
              display: `${formatHours(row.seconds)} · ${row.players} player${
                row.players === 1 ? '' : 's'
              }`,
            }))}
            emptyMessage="Nobody has played anything yet."
          />
        </section>

        <section className="gb-card space-y-3 p-5">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Top downloaders</h2>
          <RankedBars
            points={report.topUsers.map((row) => ({
              label: row.username,
              value: row.bytes,
              display: `${formatBytes(row.bytes)} · ${row.downloads} download${
                row.downloads === 1 ? '' : 's'
              }`,
            }))}
          />
        </section>

        <section className="gb-card space-y-3 p-5">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Allowance used</h2>
          {report.quotas.length === 0 ? (
            <p className="text-ink-400 py-6 text-center text-sm">
              No account has a monthly allowance. Set one in Settings.
            </p>
          ) : (
            <ul className="space-y-2">
              {report.quotas.map((row) => (
                <Meter
                  key={row.userId}
                  label={row.username}
                  used={row.usedBytes}
                  limit={row.quotaBytes}
                  usedDisplay={formatBytes(row.usedBytes)}
                  limitDisplay={formatBytes(row.quotaBytes)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="gb-card space-y-3 p-5">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Recent downloads</h2>
        {report.recentDownloads.length === 0 ? (
          <p className="text-ink-400 py-6 text-center text-sm">Nothing yet.</p>
        ) : (
          // A table, not a chart: this is a log, and every column carries meaning.
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-ink-400 border-ink-700/70 border-b text-left text-xs uppercase">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="py-2 pr-3 font-medium">Game</th>
                  <th className="py-2 pr-3 font-medium">Size</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-ink-800 divide-y">
                {report.recentDownloads.map((row) => (
                  <tr key={row.id}>
                    <td className="text-ink-400 py-2 pr-3 whitespace-nowrap">
                      {new Date(row.at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">{row.username ?? '—'}</td>
                    <td className="max-w-[18rem] truncate py-2 pr-3">{row.title ?? '—'}</td>
                    <td className="py-2 pr-3 tabular-nums">{formatBytes(row.bytes)}</td>
                    <td className="py-2">
                      {row.completed ? (
                        <Badge tone="success">Complete</Badge>
                      ) : (
                        <Badge tone="neutral">Partial</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
