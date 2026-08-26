import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  CircleCheck,
  Database,
  Download,
  HardDrive,
  Info,
  Save,
  Trash2,
  TriangleAlert,
  Wand2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Badge, FormError, Spinner, SectionSkeleton } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';

interface Finding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  count?: number;
  href?: string;
}

interface HealthReport {
  checkedAt: string;
  disks: Array<{ label: string; path: string; freeBytes: number; totalBytes: number }>;
  findings: Finding[];
  lastScanAt: string | null;
}

interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

interface DatabaseInfo {
  sizeBytes: number;
  pageSize: number;
  freeBytes: number;
  journalMode: string;
}

const SEVERITY = {
  critical: { icon: CircleAlert, tone: 'danger' as const, label: 'Critical' },
  warning: { icon: TriangleAlert, tone: 'warning' as const, label: 'Warning' },
  info: { icon: Info, tone: 'info' as const, label: 'Note' },
};

/**
 * What needs attention, and the archives that mean losing it is survivable.
 *
 * Separate from analytics on purpose: that page answers "what happened", and
 * an operator asking "is anything wrong" should not have to infer it from a
 * chart. Everything here is a thing to go and fix, with a link to where.
 */
export function AdminHealthPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const healthQuery = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => api.get<HealthReport>('/admin/health'),
    // Cheap, and the point of the page is to be current.
    refetchInterval: 60_000,
  });

  const backupsQuery = useQuery({
    queryKey: ['admin', 'backups'],
    queryFn: () =>
      api.get<{ backups: BackupInfo[]; settings: { keep: number; everyHours: number } }>(
        '/admin/backups',
      ),
  });

  const invalidateBackups = () => queryClient.invalidateQueries({ queryKey: ['admin', 'backups'] });

  const createBackup = useMutation({
    mutationFn: () => api.post<BackupInfo>('/admin/backups'),
    onSuccess: () => {
      setError(null);
      void invalidateBackups();
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not write the backup.'),
  });

  const deleteBackup = useMutation({
    mutationFn: (name: string) => api.delete(`/admin/backups/${encodeURIComponent(name)}`),
    onSuccess: invalidateBackups,
  });

  if (healthQuery.isLoading) return <SectionSkeleton rows={3} />;

  const report = healthQuery.data;
  const backups = backupsQuery.data?.backups ?? [];
  const schedule = backupsQuery.data?.settings;

  return (
    <div className="gb-page">
      <FormError message={error} />

      <section className="space-y-3">
        {report && report.findings.length === 0 ? (
          <div className="gb-card flex items-center gap-3 p-4">
            <CircleCheck className="text-[var(--status-success-fg)] h-5 w-5" aria-hidden />
            <p className="text-sm">Nothing needs attention.</p>
          </div>
        ) : (
          report?.findings.map((finding) => {
            const { icon: Icon, tone, label } = SEVERITY[finding.severity];
            return (
              <div key={finding.id} className="gb-card flex gap-3 p-4">
                <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {finding.title}
                    <Badge tone={tone}>{label}</Badge>
                  </p>
                  <p className="text-ink-300 mt-1 text-sm">{finding.detail}</p>
                </div>
                {finding.href ? (
                  <Link to={finding.href} className="gb-btn-ghost shrink-0 self-start">
                    Fix
                  </Link>
                ) : null}
              </div>
            );
          })
        )}
      </section>

      <section className="gb-card space-y-3 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
          <HardDrive className="h-4 w-4" aria-hidden />
          Disks
        </h2>
        {report?.disks.map((disk) => {
          const used = disk.totalBytes > 0 ? 1 - disk.freeBytes / disk.totalBytes : 0;
          return (
            <div key={disk.path} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{disk.label}</span>
                <span className="text-ink-400 text-xs">
                  {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                </span>
              </div>
              <div className="bg-ink-800 h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="bg-blade-500 h-full rounded-full"
                  style={{ width: `${Math.round(used * 100)}%` }}
                />
              </div>
              <p className="text-ink-500 font-mono text-[11px] break-all">{disk.path}</p>
            </div>
          );
        })}
        {report?.lastScanAt ? (
          <p className="text-ink-400 text-xs">
            Library last scanned {new Date(report.lastScanAt).toLocaleString()}.
          </p>
        ) : (
          <p className="text-ink-400 text-xs">The library has never been scanned.</p>
        )}
      </section>

      <section className="gb-card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
            <Save className="h-4 w-4" aria-hidden />
            Backups
          </h2>
          <button
            type="button"
            className="gb-btn-ghost ml-auto"
            disabled={createBackup.isPending}
            onClick={() => createBackup.mutate()}
          >
            {createBackup.isPending ? <Spinner className="h-4 w-4" /> : null}
            {createBackup.isPending ? 'Writing…' : 'Back up now'}
          </button>
        </div>

        <p className="text-ink-400 text-xs">
          The database, every player's cloud saves, uploaded media and the published installer — the
          things that exist nowhere else. The game library itself is not included: it is enormous,
          you already have it, and a scan rebuilds the catalog from it.
          {schedule
            ? schedule.everyHours > 0
              ? ` Written every ${schedule.everyHours}h, keeping ${schedule.keep}.`
              : ' Automatic backups are off.'
            : ''}
        </p>

        {backups.length === 0 ? (
          <p className="text-ink-400 text-sm">None yet.</p>
        ) : (
          <div className="divide-ink-700/70 divide-y">
            {backups.map((backup) => (
              <div key={backup.name} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs break-all">{backup.name}</p>
                  <p className="text-ink-400 text-xs">
                    {formatBytes(backup.sizeBytes)} · {new Date(backup.createdAt).toLocaleString()}
                  </p>
                </div>
                <a
                  className="gb-btn-ghost shrink-0"
                  href={`${import.meta.env.BASE_URL}api/admin/backups/${encodeURIComponent(backup.name)}`}
                >
                  <Download className="h-4 w-4" aria-hidden />
                  Download
                </a>
                <button
                  type="button"
                  className="gb-btn-danger shrink-0"
                  aria-label={`Delete ${backup.name}`}
                  onClick={() => {
                    if (!confirm(`Delete ${backup.name}?`)) return;
                    deleteBackup.mutate(backup.name);
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <DatabaseSection />
    </div>
  );
}

/**
 * What the catalog costs on disk, and the two jobs that keep it quick.
 *
 * Both run hourly on their own. This is here for the moment they need to run
 * *now* — right after importing a few thousand games, when the planner's idea
 * of how big each table is has just become badly wrong and every page in the
 * panel is paying for it.
 */
function DatabaseSection() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const infoQuery = useQuery({
    queryKey: ['admin', 'database'],
    queryFn: () => api.get<DatabaseInfo>('/admin/database'),
  });

  const maintain = useMutation({
    mutationFn: (vacuum: boolean) =>
      api.post<{ vacuumed: boolean; sizeBytes: number; tookMs: number }>(
        '/admin/database/maintenance',
        { vacuum },
      ),
    onSuccess: (result) => {
      setFailure(null);
      setNotice(
        `${result.vacuumed ? 'Rebuilt' : 'Refreshed'} in ${(result.tookMs / 1000).toFixed(1)}s — ` +
          `now ${formatBytes(result.sizeBytes)}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'database'] });
    },
    onError: (caught) =>
      setFailure(
        caught instanceof ApiRequestError ? caught.message : 'Maintenance could not finish.',
      ),
  });

  const info = infoQuery.data;
  // Only worth offering the expensive rebuild when there is something to
  // reclaim. Below this it costs minutes on a spinning disk to save nothing.
  const worthVacuuming = info ? info.freeBytes > 8 * 1024 * 1024 : false;

  return (
    <section className="gb-card p-5">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
        <Database className="h-4 w-4" aria-hidden />
        Database
      </h2>
      <p className="text-ink-400 mb-3 text-xs leading-relaxed">
        Statistics and a log checkpoint run hourly by themselves. Refresh them by hand after
        importing a large library, when the query planner's picture of the catalog has just gone
        stale. A rebuild reclaims unused space and puts the file back in order, which is worth real
        time on a spinning disk — but it holds a write lock while it runs.
      </p>

      {info ? (
        <dl className="text-ink-300 mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Metric label="On disk" value={formatBytes(info.sizeBytes)} />
          <Metric label="Reclaimable" value={formatBytes(info.freeBytes)} />
          <Metric label="Page size" value={`${(info.pageSize / 1024).toFixed(0)} KiB`} />
          <Metric label="Journal" value={info.journalMode.toUpperCase()} />
        </dl>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="gb-btn-ghost"
          onClick={() => maintain.mutate(false)}
          disabled={maintain.isPending}
        >
          {maintain.isPending ? <Spinner className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
          Refresh statistics
        </button>
        <button
          type="button"
          className="gb-btn-ghost"
          onClick={() => {
            if (!confirm('Rebuild the database? It will be locked for writes until this finishes.'))
              return;
            maintain.mutate(true);
          }}
          disabled={maintain.isPending}
          title={worthVacuuming ? undefined : 'Nothing much to reclaim right now.'}
        >
          <Database className="h-4 w-4" aria-hidden />
          Rebuild and compact
        </button>
      </div>

      {notice ? <p className="text-ink-400 mt-2 text-xs">{notice}</p> : null}
      <FormError message={failure} />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-500 text-xs">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
