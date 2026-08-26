import {
  GAME_REQUEST_STATUS_LABELS,
  type GameRequestInfo,
  type GameRequestStatus,
} from '@gameblade/shared';
import clsx from 'clsx';
import { ArrowBigUp, CheckCircle2, Clock, Loader2, Send, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useRequestList, useRequestMutations } from '../hooks/useRequests.js';
import { errorMessage } from '../lib/ipc.js';
import { formatRelative } from '../lib/format.js';
import { Empty, ErrorNote, Loading, Modal } from './ui.js';

const TONES: Record<GameRequestStatus, string> = {
  pending: 'neutral',
  'coming-soon': 'info',
  added: 'success',
  denied: 'danger',
};

/**
 * One request, with the button that backs it.
 *
 * The vote count and the tick are the whole visible result of a click, so the
 * mutation patches them in place rather than waiting on a refetch.
 */
export function RequestRow({
  request,
  onOpenGame,
}: {
  request: GameRequestInfo;
  onOpenGame?: (gameId: string) => void;
}) {
  const { vote } = useRequestMutations();

  return (
    <li className="request-row">
      <button
        type="button"
        className={clsx('request-vote', request.hasVoted && 'active')}
        aria-pressed={request.hasVoted}
        aria-label={
          request.hasVoted ? `Withdraw your vote for ${request.title}` : `Vote for ${request.title}`
        }
        onClick={() => vote.mutate({ id: request.id, wanted: !request.hasVoted })}
      >
        <ArrowBigUp size={15} aria-hidden />
        <span>{request.votes}</span>
      </button>

      {/* Once a request has been added, the row is the way to the game — the
          whole body, not only the small button on the right, because that is
          what anybody reading a row called "Added" reaches for. */}
      {request.status === 'added' && request.gameId && onOpenGame ? (
        <button
          type="button"
          className="request-body request-body-link"
          onClick={() => onOpenGame(request.gameId as string)}
          title={`Open ${request.title}`}
        >
          <RequestBody request={request} />
        </button>
      ) : (
        <span className="request-body">
          <RequestBody request={request} />
        </span>
      )}

      {request.status === 'added' && request.gameId && onOpenGame ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onOpenGame(request.gameId as string)}
        >
          Open
        </button>
      ) : null}
    </li>
  );
}

/** The text of a row, shared by its clickable and inert forms. */
function RequestBody({ request }: { request: GameRequestInfo }) {
  return (
    <>
      <span className="request-title">
        {request.title}
        <span className={`badge ${TONES[request.status]}`}>
          {GAME_REQUEST_STATUS_LABELS[request.status]}
        </span>
      </span>
      {request.adminNote ? (
        <span className="muted small">{request.adminNote}</span>
      ) : request.note ? (
        <span className="muted small">{request.note}</span>
      ) : null}
      <span className="muted small">asked {formatRelative(request.createdAt)}</span>
    </>
  );
}

/**
 * A short panel of requests for the Home tab.
 *
 * Capped and headed rather than scrollable: this sits beside three other
 * sections, and a panel that grows without limit pushes everything under it
 * off the screen.
 */
export function RequestPanel({
  title,
  hint,
  icon,
  requests,
  emptyMessage,
  onOpenGame,
}: {
  title: string;
  hint?: string;
  icon: ReactNode;
  requests: GameRequestInfo[];
  emptyMessage: string;
  onOpenGame?: (gameId: string) => void;
}) {
  return (
    <section className="request-panel">
      <div className="section-header">
        <div>
          <h2>
            <span className="request-panel-icon" aria-hidden>
              {icon}
            </span>
            {title}
          </h2>
          {hint ? <p className="muted">{hint}</p> : null}
        </div>
      </div>

      {requests.length === 0 ? (
        <p className="muted small">{emptyMessage}</p>
      ) : (
        <ul className="request-list">
          {requests.map((request) => (
            <RequestRow key={request.id} request={request} onOpenGame={onOpenGame} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Icons the Home tab's request panels wear. */
export const REQUEST_ICONS = {
  comingSoon: <Clock size={15} />,
  mostRequested: <Sparkles size={15} />,
  added: <CheckCircle2 size={15} />,
};

/**
 * The full request queue, with the form for adding to it.
 *
 * Opened from the Store — asking for something that is not in the archive is
 * the natural next step from failing to find it there.
 */
export function RequestsDialog({
  onClose,
  onOpenGame,
}: {
  onClose: () => void;
  onOpenGame?: (gameId: string) => void;
}) {
  const [status, setStatus] = useState<GameRequestStatus | ''>('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const listQuery = useRequestList(status);
  const { create } = useRequestMutations();

  const requests = listQuery.data ?? [];

  return (
    <Modal title="Request a game" onClose={onClose}>
      <ErrorNote message={error} />
      {sent ? <p className="notice">{sent}</p> : null}

      <form
        className="request-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = title.trim();
          if (trimmed.length < 2) return;
          setError(null);
          create.mutate(
            { title: trimmed, note: note.trim() || null },
            {
              onSuccess: (request) => {
                setTitle('');
                setNote('');
                setSent(
                  request.created
                    ? `Asked for ${request.title}.`
                    : `${request.title} was already on the list — your vote went to that one.`,
                );
              },
              onError: (caught) => setError(errorMessage(caught)),
            },
          );
        }}
      >
        <input
          className="input"
          value={title}
          maxLength={120}
          placeholder="Which game?"
          aria-label="Game title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          className="input"
          value={note}
          maxLength={500}
          rows={2}
          placeholder="Anything that would help find the right one — a year, a platform, a link."
          aria-label="Note"
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={title.trim().length < 2 || create.isPending}
        >
          {create.isPending ? (
            <Loader2 size={14} className="spin" aria-hidden />
          ) : (
            <Send size={14} aria-hidden />
          )}
          Send request
        </button>
      </form>

      <div className="segmented" role="tablist">
        {(['', 'pending', 'coming-soon', 'added'] as const).map((option) => (
          <button
            key={option || 'all'}
            type="button"
            role="tab"
            aria-selected={status === option}
            className={clsx('segment', status === option && 'active')}
            onClick={() => setStatus(option)}
          >
            {option === '' ? 'All' : GAME_REQUEST_STATUS_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="request-scroll">
        {listQuery.isLoading ? (
          <Loading label="Loading requests" />
        ) : requests.length === 0 ? (
          <Empty
            title="Nothing here yet"
            message={
              status === '' ? 'Be the first to ask for something.' : 'No requests with that status.'
            }
          />
        ) : (
          <ul className="request-list">
            {requests.map((request) => (
              <RequestRow key={request.id} request={request} onOpenGame={onOpenGame} />
            ))}
          </ul>
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
