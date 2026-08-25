import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  CircleCheck,
  Download,
  HardDrive,
  Info,
  Save,
  Trash2,
  TriangleAlert,
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
    </div>
  );
}
