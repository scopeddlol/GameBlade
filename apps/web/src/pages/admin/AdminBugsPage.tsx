import {
  BUG_SEVERITY_LABELS,
  BUG_STATUS,
  BUG_STATUS_LABELS,
  type BugReportInfo,
  type BugStatus,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bug, Monitor } from 'lucide-react';
import { useState } from 'react';
import { Badge, EmptyState, FormError, Spinner, RowSkeleton } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';

const TONE: Record<BugStatus, 'danger' | 'warning' | 'success' | 'neutral' | 'info'> = {
  open: 'danger',
  acknowledged: 'warning',
  fixed: 'success',
  'not-a-bug': 'neutral',
  duplicate: 'neutral',
};

/**
 * The triage queue.
 *
 * The reply box is not optional decoration: answering is what keeps reports
 * coming, and a reporter who hears nothing concludes that reporting does
 * nothing. Every change here reaches them as a notification.
 */
export function AdminBugsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<BugStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const bugsQuery = useQuery({
    queryKey: ['admin', 'bugs', status],
    queryFn: () => api.get<BugReportInfo[]>(`/admin/bugs${status ? `?status=${status}` : ''}`),
  });

  const triage = useMutation({
    mutationFn: (input: { id: string; status: BugStatus; reply: string | null }) =>
      api.put(`/admin/bugs/${input.id}`, { status: input.status, reply: input.reply }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'bugs'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not update.'),
  });

  const reports = bugsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <p className="text-ink-300 text-sm">
        What your players have run into. Whatever you set here, and anything you write back, reaches
        them as a notification.
      </p>

      <FormError message={error} />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={status === '' ? 'gb-chip gb-chip-active' : 'gb-chip'}
          onClick={() => setStatus('')}
        >
          All
        </button>
        {BUG_STATUS.map((option) => (
          <button
            key={option}
            type="button"
            className={status === option ? 'gb-chip gb-chip-active' : 'gb-chip'}
            onClick={() => setStatus(option)}
          >
            {BUG_STATUS_LABELS[option]}
          </button>
        ))}
      </div>

      {bugsQuery.isLoading ? (
        <RowSkeleton rows={4} />
      ) : reports.length === 0 ? (
        <EmptyState
          title={status ? 'Nothing with that status' : 'No reports yet'}
          message="Players can report a problem from the sidebar of the desktop client."
        />
      ) : (
        <div className="space-y-4">
          {reports.map((report) => (
            <article key={report.id} className="gb-card space-y-3 p-4">
              <div className="flex flex-wrap items-start gap-2">
                <Bug className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{report.title}</p>
                  <p className="text-ink-400 text-xs">
                    {report.reporter?.displayName ?? 'a departed account'} ·{' '}
                    {BUG_SEVERITY_LABELS[report.severity]} ·{' '}
                    {new Date(report.createdAt).toLocaleString()}
                    {report.gameTitle ? ` · in ${report.gameTitle}` : ''}
                  </p>
                </div>
                <Badge tone={TONE[report.status]}>{BUG_STATUS_LABELS[report.status]}</Badge>
              </div>

              <p className="text-ink-200 text-sm whitespace-pre-line">{report.body}</p>

              {report.clientVersion || report.platform ? (
                <p className="text-ink-400 flex flex-wrap items-center gap-2 text-xs">
                  <Monitor className="h-3.5 w-3.5" aria-hidden />
                  {[report.clientVersion && `client ${report.clientVersion}`, report.platform]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}

              {report.diagnostics ? (
                <details className="text-xs">
                  <summary className="text-ink-400 cursor-pointer">
                    What the app logged just before
                  </summary>
                  <pre className="bg-ink-900 text-ink-300 mt-2 max-h-48 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
                    {report.diagnostics}
                  </pre>
                </details>
              ) : null}

              {report.reply ? (
                <p className="border-ink-700 text-ink-300 border-l-2 pl-3 text-sm">
                  {report.reply}
                </p>
              ) : null}

              <div className="space-y-2">
                <textarea
                  className="gb-input"
                  rows={2}
                  placeholder="Reply to whoever reported this…"
                  value={drafts[report.id] ?? ''}
                  aria-label={`Reply to ${report.title}`}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [report.id]: event.target.value }))
                  }
                />
                <div className="flex flex-wrap gap-2">
                  {BUG_STATUS.filter((option) => option !== report.status).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="gb-btn-ghost"
                      disabled={triage.isPending}
                      onClick={() =>
                        triage.mutate({
                          id: report.id,
                          status: option,
                          reply: drafts[report.id]?.trim() || null,
                        })
                      }
                    >
                      {triage.isPending ? <Spinner className="h-4 w-4" /> : null}
                      {BUG_STATUS_LABELS[option]}
                    </button>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
