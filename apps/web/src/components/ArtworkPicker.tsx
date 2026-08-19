import {
  ART_STYLE_LABELS,
  ART_STYLES,
  type ArtKind,
  type ArtworkSearchResult,
} from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { Check, Search, X } from 'lucide-react';
import { useState } from 'react';
import { api, queryString } from '../lib/api.js';
import { Badge, EmptyState, PageLoader, Spinner } from './ui.js';

/** How each slot's candidates are framed in the grid, so shapes stay readable. */
const LAYOUT: Record<ArtKind, { columns: string; aspect: string; fit: string }> = {
  cover: { columns: 'minmax(120px,1fr)', aspect: 'aspect-[2/3]', fit: 'object-cover' },
  banner: { columns: 'minmax(230px,1fr)', aspect: 'aspect-[92/43]', fit: 'object-cover' },
  hero: { columns: 'minmax(260px,1fr)', aspect: 'aspect-[16/9]', fit: 'object-cover' },
  // A logo is usually transparent and rarely fills its box; cropping one to fit
  // cuts the wordmark in half, which is the whole point of the image.
  logo: { columns: 'minmax(200px,1fr)', aspect: 'aspect-[16/9]', fit: 'object-contain' },
  icon: { columns: 'minmax(96px,1fr)', aspect: 'aspect-square', fit: 'object-contain' },
};

/**
 * Browses every image both providers have for a title so a slot can be filled
 * by eye. The automatic pass picks the highest-scoring asset, which is usually
 * right and occasionally very wrong — this is the escape hatch for the latter.
 *
 * `multiple` keeps the dialog open after a pick and ticks what has been taken,
 * which is what a screenshot list wants; a single slot closes on the first
 * choice instead.
 */
export function ArtworkPicker({
  gameId,
  title,
  kind,
  heading,
  multiple = false,
  onClose,
  onChoose,
}: {
  gameId: string;
  /** Seeds the search box; providers match on their own titles, not filenames. */
  title: string;
  kind: ArtKind;
  heading?: string;
  multiple?: boolean;
  onClose: () => void;
  onChoose: (url: string) => void;
}) {
  const [query, setQuery] = useState(title);
  const [submitted, setSubmitted] = useState(title);
  const [style, setStyle] = useState('');
  const [taken, setTaken] = useState<string[]>([]);

  const searchQuery = useQuery({
    queryKey: ['admin', 'artwork', gameId, kind, submitted, style],
    queryFn: () =>
      api.get<ArtworkSearchResult>(
        `/games/${gameId}/artwork/search${queryString({ kind, q: submitted, style })}`,
      ),
  });

  const candidates = searchQuery.data?.candidates ?? [];
  const providerErrors = searchQuery.data?.errors ?? [];
  // A configured provider that returned nothing is a different problem from no
  // provider at all, and only one of them is fixed by a better search term.
  const noProviders = searchQuery.data !== undefined && searchQuery.data.providers.length === 0;
  const layout = LAYOUT[kind];

  const choose = (url: string) => {
    onChoose(url);
    if (multiple) setTaken((current) => [...current, url]);
    else onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={heading ?? `${kind} artwork`}
      onClick={onClose}
    >
      <div
        className="bg-ink-900 border-ink-700 flex h-full max-h-[88vh] w-full max-w-5xl flex-col rounded-xl border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-ink-800 flex items-center gap-3 border-b px-5 py-4">
          <h2 className="text-lg font-semibold capitalize">{heading ?? `${kind} artwork`}</h2>
          {searchQuery.isFetching ? <Spinner className="text-ink-400 h-4 w-4" /> : null}
          <button type="button" className="gb-btn-ghost ml-auto" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
            {multiple && taken.length > 0 ? `Done (${taken.length})` : 'Close'}
          </button>
        </header>

        <div className="border-ink-800 flex flex-wrap gap-2 border-b px-5 py-3">
          <div className="min-w-[220px] flex-1">
            <input
              className="gb-input"
              value={query}
              aria-label="Search both providers"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSubmitted(query.trim() || title);
              }}
              placeholder="Search both providers…"
            />
          </div>

          {/* Styles are SteamGridDB's own vocabulary, so picking one narrows the
              results to that provider — which is exactly what someone hunting
              for, say, a white text wordmark is asking for. */}
          <select
            className="gb-input w-auto shrink-0"
            value={style}
            aria-label="Style"
            onChange={(e) => setStyle(e.target.value)}
          >
            <option value="">Any style</option>
            {ART_STYLES[kind].map((option) => (
              <option key={option} value={option}>
                {ART_STYLE_LABELS[option] ?? option}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="gb-btn-primary shrink-0"
            onClick={() => setSubmitted(query.trim() || title)}
          >
            <Search className="h-4 w-4" aria-hidden />
            Search
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* A provider that failed is named, so a half-empty grid does not
              read as "there is no artwork for this game". */}
          {providerErrors.map((failure) => (
            <p key={failure.provider} className="gb-note-warning mb-3">
              {failure.provider === 'igdb' ? 'IGDB' : 'SteamGridDB'} could not be reached:{' '}
              {failure.message}
            </p>
          ))}

          {searchQuery.isLoading ? (
            <PageLoader label="Searching for artwork" />
          ) : noProviders ? (
            <EmptyState
              title="No metadata providers are configured"
              message={
                kind === 'logo' || kind === 'icon'
                  ? 'Add a SteamGridDB API key in Settings — it is the only provider that publishes logos and icons.'
                  : 'Add a SteamGridDB API key or IGDB credentials in Settings, then come back.'
              }
            />
          ) : candidates.length === 0 ? (
            <EmptyState
              title="Nothing found"
              message={
                style
                  ? 'No artwork in that style. Try "Any style", or a different search term.'
                  : 'Try a different search term — the providers match on their own titles, not your filename.'
              }
            />
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fill, ${layout.columns})` }}
            >
              {candidates.map((candidate) => {
                const chosen = taken.includes(candidate.url);
                return (
                  <button
                    key={`${candidate.provider}-${candidate.url}`}
                    type="button"
                    className={
                      chosen
                        ? 'group border-blade-500 overflow-hidden rounded-lg border text-left'
                        : 'group border-ink-700 hover:border-blade-500 overflow-hidden rounded-lg border text-left transition-colors'
                    }
                    onClick={() => choose(candidate.url)}
                    title={candidate.label ?? undefined}
                  >
                    <div className="relative">
                      <img
                        src={candidate.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className={`bg-ink-800 w-full ${layout.aspect} ${layout.fit}`}
                      />
                      {chosen ? (
                        <span className="bg-blade-500 absolute top-1.5 right-1.5 rounded-full p-1 text-white">
                          <Check className="h-3 w-3" aria-hidden />
                        </span>
                      ) : null}
                    </div>
                    <span className="text-ink-400 flex items-center gap-1.5 px-2 py-1.5 text-[11px]">
                      <Badge tone={candidate.provider === 'igdb' ? 'info' : 'success'}>
                        {candidate.provider === 'igdb' ? 'IGDB' : 'SGDB'}
                      </Badge>
                      {candidate.width && candidate.height ? (
                        <span>
                          {candidate.width}×{candidate.height}
                        </span>
                      ) : null}
                      {candidate.label ? <span className="truncate">{candidate.label}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
