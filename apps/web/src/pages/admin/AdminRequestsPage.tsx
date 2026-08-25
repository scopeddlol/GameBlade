import {
  GAME_REQUEST_STATUS,
  GAME_REQUEST_STATUS_LABELS,
  type GameRequestCounts,
  type GameRequestInfo,
  type GameRequestStatus,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowBigUp, Check, Clock, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, EmptyState, FormError, Spinner, RowSkeleton } from '../../components/ui.js';
import { api, ApiRequestError, queryString } from '../../lib/api.js';

interface RequestsResponse {
  items: GameRequestInfo[];
  counts: GameRequestCounts;
}

const TONES: Record<GameRequestStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  pending: 'neutral',
  'coming-soon': 'info',
  added: 'success',
  denied: 'danger',
};

/**
 * The decisions available on a row, in the order an operator makes them.
 *
 * `pending` is not offered as a button because it is where everything starts;
 * putting a request back is the "Reopen" action on an already-decided row.
 */
const DECISIONS = [
  { status: 'coming-soon' as const, label: 'Coming soon', Icon: Clock },
  { status: 'added' as const, label: 'Added', Icon: Check },
  { status: 'denied' as const, label: 'Denied', Icon: X },
];

/**
 * The request queue.
 *
 * Sorted by votes by default, which is the only order that answers the
 * question an operator actually has: of everything people have asked for,
 * what should I go and find first?
 */
export function AdminRequestsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<GameRequestStatus | ''>('pending');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'votes' | 'newest' | 'title'>('votes');
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [gameIds, setGameIds] = useState<Record<string, string>>({});

  const requestsQuery = useQuery({
    queryKey: ['admin', 'requests', status, search, sort],
    queryFn: () =>
      api.get<RequestsResponse>(
        `/admin/requests${queryString({ status, search, sort, limit: 200 })}`,
      ),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'requests'] });

  const decideMutation = useMutation({
    mutationFn: (input: {
      id: string;
      status: GameRequestStatus;
      adminNote: string | null;
      gameId: string | null;
    }) =>
      api.patch<GameRequestInfo>(`/admin/requests/${input.id}`, {
        status: input.status,
        adminNote: input.adminNote,
        gameId: input.gameId,
      }),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not update that request.',
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/requests/${id}`),
    onSuccess: invalidate,
  });

  const counts = requestsQuery.data?.counts;
  const items = requestsQuery.data?.items ?? [];

  const decide = (request: GameRequestInfo, next: GameRequestStatus) =>
    decideMutation.mutate({
      id: request.id,
      status: next,
      adminNote: (notes[request.id] ?? request.adminNote ?? '').trim() || null,
      // Only a fulfilled request carries a catalog link; keeping one on a
      // denied row would leave a dead "open it" button in every client.
      gameId:
        next === 'added' ? (gameIds[request.id] ?? request.gameId ?? '').trim() || null : null,
    });

  return (
    <div className="gb-page">
      <p className="text-ink-300 text-sm">
        What players have asked for. Deciding one tells every client.
      </p>

      <FormError message={error} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={status === '' ? 'gb-chip gb-chip-active' : 'gb-chip'}
          aria-pressed={status === ''}
          onClick={() => setStatus('')}
        >
          Everything
        </button>
        {GAME_REQUEST_STATUS.map((option) => (
          <button
            key={option}
            type="button"
            className={status === option ? 'gb-chip gb-chip-active' : 'gb-chip'}
            aria-pressed={status === option}
            onClick={() => setStatus(option)}
          >
            {GAME_REQUEST_STATUS_LABELS[option]}
            {counts ? <span className="text-ink-400 ml-1.5">{counts[option]}</span> : null}
          </button>
        ))}

        <div className="relative ml-auto min-w-[200px]">
          <Search
            className="text-ink-500 pointer-events-none absolute top-2.5 left-2.5 h-4 w-4"
            aria-hidden
          />
          <input
            className="gb-input pl-8"
            value={search}
            aria-label="Search requests"
            placeholder="Search titles…"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <select
          className="gb-input w-auto"
          value={sort}
          aria-label="Sort by"
          onChange={(event) => setSort(event.target.value as typeof sort)}
        >
          <option value="votes">Most wanted</option>
          <option value="newest">Newest</option>
          <option value="title">Title</option>
        </select>
      </div>

      {requestsQuery.isLoading ? (
        <RowSkeleton rows={5} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing here"
          message={
            status === 'pending'
              ? 'No requests are waiting on you.'
              : 'No requests match that filter.'
          }
        />
      ) : (
        <div className="space-y-2">
          {items.map((request) => (
            <article key={request.id} className="gb-card space-y-3 p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span
                  className="border-ink-700 bg-ink-800 flex min-w-12 flex-col items-center rounded-lg border px-2 py-1"
                  title={`${request.votes} ${request.votes === 1 ? 'person wants' : 'people want'} this`}
                >
                  <ArrowBigUp className="text-blade-400 h-4 w-4" aria-hidden />
                  <span className="text-sm font-semibold tabular-nums">{request.votes}</span>
                </span>

                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {request.title}
                    <Badge tone={TONES[request.status]}>
                      {GAME_REQUEST_STATUS_LABELS[request.status]}
                    </Badge>
                  </p>
                  {request.note ? (
                    <p className="text-ink-300 mt-1 text-sm whitespace-pre-wrap">{request.note}</p>
                  ) : null}
                  <p className="text-ink-500 mt-1 text-xs">
                    {request.requestedBy ? `${request.requestedBy.username} · ` : ''}
                    {new Date(request.createdAt).toLocaleDateString()}
                    {request.decidedAt
                      ? ` · decided ${new Date(request.decidedAt).toLocaleDateString()}`
                      : ''}
                  </p>
                </div>

                <button
                  type="button"
                  className="gb-btn-danger"
                  aria-label={`Delete the request for ${request.title}`}
                  onClick={() => {
                    if (!confirm(`Delete the request for "${request.title}"? Its votes go too.`)) {
                      return;
                    }
                    deleteMutation.mutate(request.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  className="gb-input"
                  value={notes[request.id] ?? request.adminNote ?? ''}
                  maxLength={500}
                  aria-label={`Reply to the request for ${request.title}`}
                  placeholder="A note players will see — why, or when"
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [request.id]: event.target.value }))
                  }
                />
                <input
                  className="gb-input font-mono text-xs"
                  value={gameIds[request.id] ?? request.gameId ?? ''}
                  maxLength={64}
                  aria-label={`Catalog id that fulfils ${request.title}`}
                  placeholder="Catalog game id, once it is added"
                  onChange={(event) =>
                    setGameIds((current) => ({ ...current, [request.id]: event.target.value }))
                  }
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {DECISIONS.map(({ status: next, label, Icon }) => (
                  <button
                    key={next}
                    type="button"
                    className={
                      request.status === next ? 'gb-chip gb-chip-active' : 'gb-btn-ghost text-sm'
                    }
                    disabled={decideMutation.isPending}
                    onClick={() => decide(request, next)}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {label}
                  </button>
                ))}

                {request.status === 'pending' ? null : (
                  <button
                    type="button"
                    className="gb-btn-ghost text-sm"
                    disabled={decideMutation.isPending}
                    onClick={() => decide(request, 'pending')}
                  >
                    Reopen
                  </button>
                )}

                {decideMutation.isPending && decideMutation.variables?.id === request.id ? (
                  <Spinner className="text-ink-400 mt-2 h-4 w-4" />
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
