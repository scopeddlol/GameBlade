import type { ScanProgress } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, RefreshCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Field, FormError, PageLoader, Spinner } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';
import { formatBytes, formatRelative } from '../../lib/format.js';

interface AdminStats {
  games: number;
  totalBytes: number;
  matched: number;
  missing: number;
  users: number;
  libraries: number;
  basePath: string;
  scan: ScanProgress;
  online: number;
}

export function AdminOverviewPage() {
  const queryClient = useQueryClient();

  const statsQuery = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api.get<AdminStats>('/admin/stats'),
    // Keep the scan progress and online count moving while a scan is running.
    refetchInterval: (query) => {
      const state = query.state.data?.scan.state;
      return state === 'scanning' || state === 'matching' ? 1500 : 15_000;
    },
  });

  const scanMutation = useMutation({
    mutationFn: () => api.post('/admin/scan', { force: false, fetchMetadata: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] }),
  });

  if (statsQuery.isLoading) return <PageLoader label="Loading overview" />;
  const stats = statsQuery.data;
  const scanning = stats?.scan.state === 'scanning' || stats?.scan.state === 'matching';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <button
          type="button"
          className="gb-btn-primary ml-auto"
          onClick={() => scanMutation.mutate()}
          disabled={scanning}
        >
          {scanning ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
          {scanning ? 'Scanning…' : 'Scan libraries'}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Games" value={stats?.games.toLocaleString() ?? '—'} />
        <StatCard label="On disk" value={formatBytes(stats?.totalBytes ?? 0)} />
        <StatCard label="Accounts" value={stats?.users.toLocaleString() ?? '—'} />
        <StatCard
          label="Online now"
          value={stats?.online.toLocaleString() ?? '0'}
          hint="Desktop clients connected"
        />
      </div>

      <section className="gb-card p-5">
        <h2 className="mb-3 text-sm font-semibold tracking-wide uppercase">Catalogue health</h2>
        <div className="text-ink-300 flex flex-wrap items-center gap-4 text-sm">
          <span>
            <strong className="text-ink-100">{stats?.matched ?? 0}</strong> matched to metadata
          </span>
          {stats && stats.games > stats.matched ? (
            <Link to="/admin/catalog?matchStatus=unmatched" className="text-blade-400 underline">
              {stats.games - stats.matched} still need a match
            </Link>
          ) : null}
          {stats && stats.missing > 0 ? (
            <Badge tone="warning">{stats.missing} missing from disk</Badge>
          ) : null}
          <span className="text-ink-400">{stats?.libraries ?? 0} library folders</span>
        </div>

        {stats?.scan.finishedAt && !scanning ? (
          <p className="text-ink-400 mt-3 text-xs">
            Last scan {formatRelative(stats.scan.finishedAt)} · {stats.scan.added} added,{' '}
            {stats.scan.updated} updated, {stats.scan.removed} missing
          </p>
        ) : null}

        {scanning && stats && stats.scan.total > 0 ? (
          <div className="mt-3 space-y-1.5">
            <div className="bg-ink-700 h-1.5 w-full overflow-hidden rounded-full">
              <div
                className="bg-blade-500 h-full transition-all"
                style={{
                  width: `${Math.min(100, (stats.scan.processed / stats.scan.total) * 100)}%`,
                }}
              />
            </div>
            <p className="text-ink-400 text-xs">
              {stats.scan.processed} / {stats.scan.total}
              {stats.scan.currentItem ? ` · ${stats.scan.currentItem}` : ''}
            </p>
          </div>
        ) : null}
      </section>

      <Announcements />
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="gb-card p-5">
      <p className="text-ink-400 text-xs tracking-wide uppercase">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="text-ink-400 mt-1 text-xs">{hint}</p> : null}
    </div>
  );
}

/** Pushes a notification to every account; it lands in the desktop client. */
function Announcements() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendMutation = useMutation({
    mutationFn: () => api.post<{ sent: number }>('/admin/announcements', { title, body }),
    onSuccess: (result) => {
      setNotice(`Sent to ${result.sent} ${result.sent === 1 ? 'account' : 'accounts'}.`);
      setError(null);
      setTitle('');
      setBody('');
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not send.'),
  });

  return (
    <section className="gb-card p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
        <Megaphone className="h-4 w-4" aria-hidden />
        Announcement
      </h2>

      <FormError message={error} />
      {notice ? (
        <p className="mb-3 rounded-lg border border-emerald-900/60 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </p>
      ) : null}

      <form
        className="max-w-xl space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          sendMutation.mutate();
        }}
      >
        <Field label="Title" htmlFor="annTitle">
          <input
            id="annTitle"
            className="gb-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Server maintenance on Sunday"
            required
          />
        </Field>
        <Field label="Message (optional)" htmlFor="annBody">
          <textarea
            id="annBody"
            className="gb-input min-h-24"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <button type="submit" className="gb-btn-primary" disabled={sendMutation.isPending}>
          {sendMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
          Send to everyone
        </button>
      </form>
    </section>
  );
}
