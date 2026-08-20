import {
  GAME_REQUEST_STATUS,
  GAME_REQUEST_STATUS_LABELS,
  type GameRequestInfo,
  type GameRequestSuggestion,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowBigUp, Check, Flame, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { RequestRow } from '../components/GameRequests.js';
import { Artwork, Empty, ErrorNote, Loading } from '../components/ui.js';
import { useRequestDigest, useRequestList, useRequestMutations } from '../hooks/useRequests.js';
import { errorMessage, ipc } from '../lib/ipc.js';

type Filter = '' | (typeof GAME_REQUEST_STATUS)[number];

const FILTERS: { id: Filter; label: string }[] = [
  { id: '', label: 'All' },
  ...GAME_REQUEST_STATUS.map((status) => ({
    id: status as Filter,
    label: GAME_REQUEST_STATUS_LABELS[status],
  })),
];

/**
 * Asking for games, as a place of its own.
 *
 * It was a dialog hidden behind a Store button, which is a strange home for
 * the one screen where players tell the operator what to buy next. Here the
 * queue, what is on the way and what is trending elsewhere are all one page.
 */
export function RequestsTab({ onOpenGameId }: { onOpenGameId: (gameId: string) => void }) {
  const [filter, setFilter] = useState<Filter>('');
  const [error, setError] = useState<string | null>(null);

  const digestQuery = useRequestDigest();
  const listQuery = useRequestList(filter);

  const requests = listQuery.data ?? [];
  const counts = digestQuery.data?.counts;

  return (
    <div className="tab-content requests-tab">
      <header className="requests-head">
        <div>
          <h1>Requests</h1>
          <p className="muted">
            Ask for anything missing. The more people back a title, the higher it climbs.
          </p>
        </div>
        {counts ? (
          <div className="requests-tally">
            <Tally label="Open" value={counts.pending} />
            <Tally label="On the way" value={counts['coming-soon']} accent />
            <Tally label="Added" value={counts.added} />
          </div>
        ) : null}
      </header>

      <ErrorNote message={error} />

      <Composer onError={setError} />

      <TrendingStrip onError={setError} />

      <section className="requests-queue">
        <div className="requests-filters">
          {FILTERS.map((option) => (
            <button
              key={option.id || 'all'}
              type="button"
              className={clsx('chip', filter === option.id && 'active')}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {listQuery.isLoading ? (
          <Loading label="Loading requests" />
        ) : requests.length === 0 ? (
          <Empty
            title={
              filter
                ? `Nothing ${GAME_REQUEST_STATUS_LABELS[filter].toLowerCase()}`
                : 'No requests yet'
            }
            message={
              filter
                ? 'Try another filter.'
                : 'Be the first — ask for something above, or back one of the trending titles.'
            }
          />
        ) : (
          <ul className="request-list">
            {requests.map((request: GameRequestInfo) => (
              <RequestRow key={request.id} request={request} onOpenGame={onOpenGameId} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Tally({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={clsx('requests-tally-item', accent && 'accent')}>
      <strong>{value}</strong>
      <span className="muted small">{label}</span>
    </div>
  );
}

/** Asking for something by name, for anything the trending strip does not have. */
function Composer({ onError }: { onError: (message: string) => void }) {
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const { create } = useRequestMutations();

  return (
    <form
      className="card requests-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        create.mutate(
          { title: title.trim(), note: note.trim() || undefined },
          {
            onSuccess: () => {
              setTitle('');
              setNote('');
            },
            onError: (caught) => onError(errorMessage(caught)),
          },
        );
      }}
    >
      <div className="requests-composer-row">
        <input
          className="input"
          value={title}
          maxLength={120}
          placeholder="Ask for a game by name…"
          aria-label="Game title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!title.trim() || create.isPending}
        >
          <Plus size={15} aria-hidden />
          Request
        </button>
      </div>
      <input
        className="input"
        value={note}
        maxLength={280}
        placeholder="Anything worth adding? (optional)"
        aria-label="Note"
        onChange={(event) => setNote(event.target.value)}
      />
    </form>
  );
}

/**
 * What is being played elsewhere right now, as one-click asks.
 *
 * Each card already knows whether the archive has the game, whether somebody
 * has asked, and whether the reader has backed it — so the button says what it
 * will actually do rather than making them find out by pressing it.
 */
function TrendingStrip({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  const { create, vote } = useRequestMutations();

  const suggestionsQuery = useQuery({
    queryKey: ['requests', 'suggestions'],
    queryFn: () => ipc.get<GameRequestSuggestion[]>('/requests/suggestions'),
    // Held for an hour on the server as well; this stops a tab switch re-asking.
    staleTime: 30 * 60_000,
  });

  const ask = useMutation({
    mutationFn: (suggestion: GameRequestSuggestion) =>
      suggestion.requestId
        ? vote.mutateAsync({ id: suggestion.requestId, wanted: !suggestion.hasVoted })
        : create.mutateAsync({ title: suggestion.title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
    },
    onError: (caught) => onError(errorMessage(caught)),
  });

  const suggestions = suggestionsQuery.data ?? [];

  // Silent when no metadata provider is configured: the page works without it.
  if (suggestionsQuery.isLoading || suggestions.length === 0) return null;

  return (
    <section className="trending">
      <h2>
        <Flame size={16} aria-hidden />
        Trending right now
        <span className="muted small">Most played elsewhere this week</span>
      </h2>

      <div className="trending-strip">
        {suggestions.map((suggestion) => (
          <article key={suggestion.title} className="trending-card">
            <Artwork
              path={suggestion.coverUrl}
              alt={suggestion.title}
              className="trending-cover"
              fallbackText={suggestion.title}
            />
            <div className="trending-body">
              <p className="trending-title" title={suggestion.title}>
                {suggestion.title}
              </p>
              {suggestion.releaseYear ? (
                <p className="muted small">{suggestion.releaseYear}</p>
              ) : null}
            </div>

            {suggestion.inCatalog ? (
              <span className="row-chip installed">
                <Check size={12} aria-hidden />
                In the archive
              </span>
            ) : (
              <button
                type="button"
                className={clsx('btn', suggestion.hasVoted ? 'btn-ghost' : 'btn-primary')}
                onClick={() => ask.mutate(suggestion)}
                disabled={ask.isPending}
              >
                {suggestion.hasVoted ? (
                  <>
                    <Check size={14} aria-hidden /> Backed
                  </>
                ) : suggestion.requestId ? (
                  <>
                    <ArrowBigUp size={14} aria-hidden /> Back it
                  </>
                ) : (
                  <>
                    <Sparkles size={14} aria-hidden /> Request
                  </>
                )}
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
