import {
  BUG_SEVERITY,
  BUG_SEVERITY_LABELS,
  type BugReportInfo,
  type BugSeverity,
} from '@gameblade/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bug, Check } from 'lucide-react';
import { useState } from 'react';
import { recentErrors } from '../lib/errorLog.js';
import { errorMessage, ipc } from '../lib/ipc.js';
import { ErrorNote, Modal } from './ui.js';

/**
 * Reporting something broken, from wherever it broke.
 *
 * Everything the reporter would otherwise have to look up — client version,
 * which machine, what the app logged just before — is attached automatically.
 * A report that leaves those out is one the operator has to come back and ask
 * about, and each round trip is somewhere the report gets abandoned.
 */
export function ReportBug({ gameId, onClose }: { gameId?: string | null; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<BugSeverity>('broken');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const versionQuery = useQuery({
    queryKey: ['client-version'],
    queryFn: () => ipc.clientVersion(),
    staleTime: Infinity,
  });

  const send = useMutation({
    mutationFn: () =>
      ipc.post<BugReportInfo>('/bugs', {
        title: title.trim(),
        body: body.trim(),
        severity,
        gameId: gameId ?? null,
        clientVersion: versionQuery.data ?? null,
        platform: navigator.userAgent.slice(0, 120),
        // Whatever the app logged recently, which is usually the actual cause
        // and is never something a reporter would think to include.
        diagnostics: recentErrors().join('\n').slice(0, 8000) || null,
      }),
    onSuccess: () => setSent(true),
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (sent) {
    return (
      <Modal title="Thanks" onClose={onClose}>
        <p className="report-sent">
          <Check size={16} aria-hidden />
          Reported. You will get a notification when someone has looked at it, and you can see where
          it got to under Settings.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Report a problem" onClose={onClose}>
      <ErrorNote message={error} />

      <form
        className="report-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim().length < 3 || body.trim().length === 0) return;
          send.mutate();
        }}
      >
        <label className="field">
          <span>What happened?</span>
          <input
            className="input"
            value={title}
            maxLength={160}
            placeholder="Downloads stall at 90%"
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </label>

        <label className="field">
          <span>How bad is it?</span>
          <select
            className="input"
            value={severity}
            onChange={(event) => setSeverity(event.target.value as BugSeverity)}
          >
            {BUG_SEVERITY.map((option) => (
              <option key={option} value={option}>
                {BUG_SEVERITY_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Anything else</span>
          <textarea
            className="input"
            rows={5}
            value={body}
            maxLength={4000}
            placeholder="What you were doing, and what you expected instead."
            onChange={(event) => setBody(event.target.value)}
            required
          />
        </label>

        <p className="muted small">
          Your client version and recent app errors are attached so nobody has to ask.
        </p>

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={send.isPending || title.trim().length < 3 || body.trim().length === 0}
          >
            <Bug size={14} aria-hidden />
            {send.isPending ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
