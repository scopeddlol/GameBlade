import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { AreaChart, ColumnChart, Meter, RankedBars, StatTile } from '../../components/charts.js';
import { Badge, EmptyState, SectionSkeleton } from '../../components/ui.js';
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
    files: number;
    completed: boolean;
    client: string;
  }>;
  quotas: Array<{ userId: string; username: string; usedBytes: number; quotaBytes: number }>;
}

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
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

/** Remembers the density choice, so the page opens the way it was left. */
const DENSITY_KEY = 'gb.analytics.density';

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

/** A panel heading, sized to whichever density is active. */
function PanelTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-[11px] font-semibold tracking-wide uppercase">{children}</h2>;
}

/**
 * Who downloaded what, what gets played, and where the bandwidth goes.
 *
 * One request backs the whole page: every panel comes out of the same two
 * tables, so six endpoints would each pay their own round trip for one query's
 * worth of data.
 *
 * Laid out as a console rather than as a report. The panels used to be one
 * per row at full width, which made a page of ten charts several screens tall
 * for data that fits in one; compact mode packs them into a grid with shorter
 * plots, and the download log — the only genuinely unbounded thing here —
 * collapses behind a disclosure.
 */
export function AdminAnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const [compact, setCompact] = useState(true);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(DENSITY_KEY);
    if (stored) setCompact(stored === 'compact');
  }, []);

  const setDensity = (next: boolean) => {
    setCompact(next);
    localStorage.setItem(DENSITY_KEY, next ? 'compact' : 'roomy');
  };

  const reportQuery = useQuery({
    queryKey: ['admin', 'analytics', days],
    queryFn: () => api.get<AnalyticsReport>(`/admin/analytics?days=${days}`),
  });

  if (reportQuery.isLoading) return <SectionSkeleton rows={4} />;
  const report = reportQuery.data;
  if (!report) {
    return <EmptyState title="No data yet" message="Analytics appear once games are downloaded." />;
  }

  const { summary } = report;
  const panel = compact ? 'gb-card space-y-2 p-3' : 'gb-card space-y-3 p-5';
  const rankLimit = compact ? 5 : undefined;
  const logRows = compact ? 12 : 40;

  return (
    // Compact is this page embedded as a panel on the Overview, where it has
    // to fit whatever it is given; on its own it takes the same shell as every
    // other admin page.
    <div className={compact ? 'space-y-3' : 'gb-page'}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
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

          <button
            type="button"
            className="gb-btn-ghost ml-1 px-2"
            aria-pressed={compact}
            title={compact ? 'Show more detail' : 'Fit more on screen'}
            onClick={() => setDensity(!compact)}
          >
            {compact ? (
              <Maximize2 className="h-4 w-4" aria-hidden />
            ) : (
              <Minimize2 className="h-4 w-4" aria-hidden />
            )}
            <span className="hidden sm:inline">{compact ? 'Roomy' : 'Compact'}</span>
          </button>
        </div>
      </div>

      <div
        className={
          compact
            ? 'grid gap-2 grid-cols-2 lg:grid-cols-4'
            : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4'
        }
      >
        <StatTile
          dense={compact}
          label="Transferred"
          value={formatBytes(summary.bytes)}
          hint={`last ${report.rangeDays} days`}
        />
        <StatTile
          dense={compact}
          label="This month"
          value={formatBytes(summary.monthBytes)}
          hint={`${formatBytes(summary.allTimeBytes)} all time`}
        />
        <StatTile
          dense={compact}
          label="Downloads"
          value={summary.downloads.toLocaleString()}
          hint={`${summary.completedDownloads.toLocaleString()} completed`}
        />
        <StatTile
          dense={compact}
          label="Play time"
          value={formatHours(summary.playSeconds)}
          hint={`${summary.activeUsers} accounts downloading`}
        />
      </div>

      {/* The two time series sit side by side: they answer the same question at
          two scales, and reading one under the other means scrolling between
          them. */}
      <div className={compact ? 'grid gap-2 xl:grid-cols-2' : 'grid gap-4 xl:grid-cols-2'}>
        <section className={panel}>
          <PanelTitle>Bandwidth per day</PanelTitle>
          <AreaChart
            height={compact ? 120 : 180}
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

        <section className={panel}>
          <PanelTitle>Bandwidth per month</PanelTitle>
          <ColumnChart
            height={compact ? 120 : 160}
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
      </div>

      <div
        className={
          compact ? 'grid gap-2 md:grid-cols-2 xl:grid-cols-4' : 'grid gap-4 lg:grid-cols-2'
        }
      >
        <section className={panel}>
          <PanelTitle>Most downloaded</PanelTitle>
          <RankedBars
            limit={rankLimit}
            points={report.topGamesByDownloads.map((row) => ({
              label: row.title,
              value: row.downloads,
              display: `${row.downloads} · ${formatBytes(row.bytes)}`,
            }))}
          />
        </section>

        <section className={panel}>
          <PanelTitle>Most played</PanelTitle>
          <RankedBars
            limit={rankLimit}
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

        <section className={panel}>
          <PanelTitle>Top downloaders</PanelTitle>
          <RankedBars
            limit={rankLimit}
            points={report.topUsers.map((row) => ({
              label: row.username,
              value: row.bytes,
              display: `${formatBytes(row.bytes)} · ${row.downloads} download${
                row.downloads === 1 ? '' : 's'
              }`,
            }))}
          />
        </section>

        <section className={panel}>
          <PanelTitle>Allowance used</PanelTitle>
          {report.quotas.length === 0 ? (
            <p className="text-ink-400 py-4 text-center text-sm">
              No account has a monthly allowance. Set one in Settings.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {(compact ? report.quotas.slice(0, 5) : report.quotas).map((row) => (
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

      {/* The log is the one unbounded thing on the page, so it is the one thing
          folded away by default rather than merely trimmed. */}
      <section className={panel}>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-left"
          aria-expanded={showLog}
          onClick={() => setShowLog((open) => !open)}
        >
          {showLog ? (
            <ChevronDown className="text-ink-400 h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="text-ink-400 h-4 w-4" aria-hidden />
          )}
          <PanelTitle>Recent downloads</PanelTitle>
          <span className="text-ink-500 ml-auto text-xs">
            {report.recentDownloads.length.toLocaleString()} entries
          </span>
        </button>

        {!showLog ? null : report.recentDownloads.length === 0 ? (
          <p className="text-ink-400 py-4 text-center text-sm">Nothing yet.</p>
        ) : (
          // A table, not a chart: this is a log, and every column carries meaning.
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-ink-400 border-ink-700/70 border-b text-left text-[11px] uppercase">
                  <th className="py-1.5 pr-3 font-medium">When</th>
                  <th className="py-1.5 pr-3 font-medium">Who</th>
                  <th className="py-1.5 pr-3 font-medium">Game</th>
                  <th className="py-1.5 pr-3 font-medium">Files</th>
                  <th className="py-1.5 pr-3 font-medium">Size</th>
                  <th className="py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-ink-800 divide-y">
                {report.recentDownloads.slice(0, logRows).map((row) => (
                  <tr key={row.id}>
                    <td className="text-ink-400 py-1.5 pr-3 whitespace-nowrap">
                      {new Date(row.at).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3">{row.username ?? '—'}</td>
                    <td className="max-w-[18rem] truncate py-1.5 pr-3">{row.title ?? '—'}</td>
                    <td className="text-ink-400 py-1.5 pr-3 tabular-nums">
                      {row.files.toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">{formatBytes(row.bytes)}</td>
                    <td className="py-1.5">
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
