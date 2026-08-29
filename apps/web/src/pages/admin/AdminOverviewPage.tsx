import type { ScanProgress } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, Megaphone, RefreshCw, Server } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Field, FormError, Spinner, SectionSkeleton } from '../../components/ui.js';
import { useServerRole } from '../../hooks/useServerRole.js';
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
  // A coordinator holds no game files. Scanning one used to walk a path that is
  // not there and read the empty result as "every game has been deleted",
  // flagging the whole catalog its nodes had just reported.
  const scansOwnDisk = useServerRole() !== 'coordinator';

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

  // Artwork comes from a different provider than metadata, so a game can be
  // matched and still have no cover — after adding a SteamGridDB key, or after
  // the provider was unreachable during the first scan.
  const enrichMutation = useMutation({
    mutationFn: () => api.post('/admin/scan/match-pending'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] }),
  });

  if (statsQuery.isLoading) return <SectionSkeleton rows={3} />;
  const stats = statsQuery.data;
  const scanning = stats?.scan.state === 'scanning' || stats?.scan.state === 'matching';

  return (
    <div className="gb-page">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <button
          type="button"
          className="gb-btn-ghost ml-auto"
          onClick={() => enrichMutation.mutate()}
          disabled={scanning || enrichMutation.isPending}
          title="Fetch metadata and artwork for anything still missing it, without re-walking the disk"
        >
          {enrichMutation.isPending ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <ImageIcon className="h-4 w-4" />
          )}
          Fetch missing artwork
        </button>

        {scansOwnDisk ? (
          <button
            type="button"
            className="gb-btn-primary"
            onClick={() => scanMutation.mutate()}
            disabled={scanning}
          >
            {scanning ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            {scanning ? 'Scanning…' : 'Scan libraries'}
          </button>
        ) : (
          <Link to="/admin/nodes" className="gb-btn-primary">
            <Server className="h-4 w-4" aria-hidden />
            Nodes
          </Link>
        )}
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
        <h2 className="mb-3 text-sm font-semibold tracking-wide uppercase">Catalog health</h2>
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
          <span className="text-ink-400">
            {stats?.libraries ?? 0}{' '}
            {scansOwnDisk ? 'library folders' : 'libraries reported by nodes'}
          </span>
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
  const [icon, setIcon] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendMutation = useMutation({
    mutationFn: () =>
      api.post<{ sent: number }>('/admin/announcements', {
        title,
        body,
        icon: icon.trim() || undefined,
      }),
    onSuccess: (result) => {
      setNotice(`Sent to ${result.sent} ${result.sent === 1 ? 'account' : 'accounts'}.`);
      setError(null);
      setTitle('');
      setBody('');
      setIcon('');
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
      {notice ? <p className="gb-note mb-3">{notice}</p> : null}

      <form
        className="max-w-xl space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          sendMutation.mutate();
        }}
      >
        <div className="flex gap-3">
          <div className="w-20 shrink-0">
            <Field label="Icon" htmlFor="annIcon">
              <input
                id="annIcon"
                className="gb-input text-center text-lg"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="🎉"
                maxLength={8}
              />
            </Field>
          </div>
          <div className="flex-1">
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
          </div>
        </div>
        <Field label="Message (optional)" htmlFor="annBody">
          <textarea
            id="annBody"
            className="gb-input min-h-24"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        {/* What lands in the client, drawn the way the client draws it. An
            announcement is written once and read by everybody, so seeing the
            icon and the wrapping before sending is worth the few lines. */}
        <div>
          <p className="gb-label">Preview</p>
          <div className="border-ink-700 bg-ink-900 flex items-start gap-2.5 rounded-lg border p-3">
            <span className="bg-ink-800 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base">
              {icon.trim() || <Megaphone className="h-4 w-4" aria-hidden />}
            </span>
            <span className="min-w-0 text-sm">
              <strong className="block truncate">{title.trim() || 'Your announcement'}</strong>
              {body.trim() ? (
                <span className="text-ink-400 block text-xs whitespace-pre-wrap">{body}</span>
              ) : null}
              <span className="text-ink-500 block text-xs">just now</span>
            </span>
          </div>
        </div>

        <button type="submit" className="gb-btn-primary" disabled={sendMutation.isPending}>
          {sendMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
          Send to everyone
        </button>
      </form>
    </section>
  );
}
