import {
  GAME_REQUEST_STATUS,
  GAME_REQUEST_STATUS_LABELS,
  type DiscoveryShelf,
  type GameRequestInfo,
  type GameRequestSuggestion,
} from '@gameblade/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowBigUp, Check, Plus, Search, Sparkles, Star, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RequestRow } from '../components/GameRequests.js';
import { Artwork, Empty, ErrorNote, Loading, ListSkeleton } from '../components/ui.js';
import {
  useDiscovery,
  useRequestDigest,
  useRequestList,
  useRequestMutations,
  useRequestSearch,
} from '../hooks/useRequests.js';
import { errorMessage } from '../lib/ipc.js';

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
 * queue, what is on the way and what to browse are all one page.
 *
 * Discovery is several shelves plus a search rather than one strip of the
 * week's most-played: the game somebody actually wants is usually not the one
 * peaking on Steam, and a single row of twelve gives them nowhere else to look.
 */
export function RequestsTab({ onOpenGameId }: { onOpenGameId: (gameId: string) => void }) {
  const [filter, setFilter] = useState<Filter>('');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

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

      <Finder search={search} onSearch={setSearch} onError={setError} />

      {search.trim().length >= 2 ? null : <Shelves onError={setError} />}

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
          <ListSkeleton rows={5} />
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
                : 'Be the first — search for something above, or back one of the titles on the shelves.'
            }
          />
        ) : (
          // Dimmed rather than replaced while the next filter loads: the rows
          // are already right most of the time, and a spinner between every
          // chip makes a one-key change feel like a page load.
          <ul className={clsx('request-list', listQuery.isPlaceholderData && 'is-stale')}>
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

/**
 * Search first, free text second.
 *
 * Typing a name looks the game up so the request carries its real title, cover
 * and year — an operator can act on that, where "that space one with the
 * ships" needs a conversation first. Asking by name is still there for
 * anything the provider does not know, or for a server with no provider at all.
 */
function Finder({
  search,
  onSearch,
  onError,
}: {
  search: string;
  onSearch: (value: string) => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  const debounced = useDebounced(search, 350);
  const searchQuery = useRequestSearch(debounced);
  const { create } = useRequestMutations();

  const term = search.trim();
  const results = searchQuery.data?.results ?? [];
  const searching = term.length >= 2;
  // A settled search that found nothing is the one moment the by-name form
  // earns its place, so that is when it appears.
  const exhausted = searching && !searchQuery.isFetching && results.length === 0;

  return (
    <section className="requests-finder">
      <div className="requests-search">
        <Search size={16} aria-hidden className="requests-search-icon" />
        <input
          className="input"
          value={search}
          maxLength={120}
          placeholder="Search for a game to request…"
          aria-label="Search for a game"
          onChange={(event) => onSearch(event.target.value)}
        />
        {search ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Clear the search"
            onClick={() => onSearch('')}
          >
            <X size={15} aria-hidden />
          </button>
        ) : null}
      </div>

      {searching ? (
        <div className="requests-results">
          {searchQuery.isFetching && results.length === 0 ? (
            <Loading label="Searching" />
          ) : results.length > 0 ? (
            <CardGrid items={results} onError={onError} />
          ) : null}

          {exhausted ? (
            <form
              className="card requests-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!term) return;
                create.mutate(
                  { title: term, note: note.trim() || undefined },
                  {
                    onSuccess: () => {
                      onSearch('');
                      setNote('');
                    },
                    onError: (caught) => onError(errorMessage(caught)),
                  },
                );
              }}
            >
              <p className="muted small">
                Nothing found for “{term}”. Ask for it by name and the operator will take it from
                there.
              </p>
              <div className="requests-composer-row">
                <input
                  className="input"
                  value={note}
                  maxLength={280}
                  placeholder="Anything that would help find it — a year, a platform, a link"
                  aria-label="Note"
                  onChange={(event) => setNote(event.target.value)}
                />
                <button type="submit" className="btn btn-primary" disabled={create.isPending}>
                  <Plus size={15} aria-hidden />
                  Request “{term}”
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Every discovery shelf the server offered, in the order it offered them. */
function Shelves({ onError }: { onError: (message: string) => void }) {
  const discoveryQuery = useDiscovery();
  const shelves = discoveryQuery.data?.shelves ?? [];

  // Silent when no metadata provider is configured: the page works without it.
  if (discoveryQuery.isLoading || shelves.length === 0) return null;

  return (
    <>
      {shelves.map((shelf: DiscoveryShelf) => (
        <section key={shelf.id} className="discover">
          <h2>
            <Sparkles size={16} aria-hidden />
            {shelf.label}
            <span className="muted small">{shelf.hint}</span>
          </h2>
          <div className="discover-strip">
            {shelf.items.map((item) => (
              <SuggestionCard
                key={`${shelf.id}-${item.title}`}
                suggestion={item}
                onError={onError}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** Search results, which wrap into a grid rather than scrolling sideways. */
function CardGrid({
  items,
  onError,
}: {
  items: GameRequestSuggestion[];
  onError: (message: string) => void;
}) {
  return (
    <div className="discover-grid">
      {items.map((item) => (
        <SuggestionCard key={item.title} suggestion={item} onError={onError} />
      ))}
    </div>
  );
}

/**
 * One title, with the button that acts on it.
 *
 * The card already knows whether the archive has the game, whether somebody
 * has asked, and whether the reader has backed it — so the button says what it
 * will actually do rather than making them press it to find out.
 */
function SuggestionCard({
  suggestion,
  onError,
}: {
  suggestion: GameRequestSuggestion;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { create, vote } = useRequestMutations();

  const ask = useMutation({
    mutationFn: () =>
      suggestion.requestId
        ? vote.mutateAsync({ id: suggestion.requestId, wanted: !suggestion.hasVoted })
        : create.mutateAsync({ title: suggestion.title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
    },
    onError: (caught) => onError(errorMessage(caught)),
  });

  return (
    <article className="discover-card">
      <div className="discover-cover-wrap">
        <Artwork
          path={suggestion.coverUrl}
          alt={suggestion.title}
          className="discover-cover"
          fallbackText={suggestion.title}
        />
        {suggestion.rating !== null ? (
          <span className="discover-score" title={`Rated ${suggestion.rating} out of 100`}>
            <Star size={11} aria-hidden />
            {suggestion.rating}
          </span>
        ) : null}
      </div>

      <div className="discover-body">
        <p className="discover-title" title={suggestion.title}>
          {suggestion.title}
        </p>
        {suggestion.releaseYear ? <p className="muted small">{suggestion.releaseYear}</p> : null}
        {suggestion.summary ? (
          <p className="muted small shelf-blurb">{suggestion.summary}</p>
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
          onClick={() => ask.mutate()}
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
  );
}

/**
 * Holds a value still until typing stops.
 *
 * IGDB's rate limit is four requests a second shared across everything the
 * server does, so a search per keystroke would spend it on prefixes nobody
 * meant to look up.
 */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
