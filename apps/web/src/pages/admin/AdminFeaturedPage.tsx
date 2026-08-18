import type { FeaturedEntry, GameSummary, Paginated } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Images, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ArtworkPicker } from '../../components/ArtworkPicker.js';
import { Badge, EmptyState, Field, FormError, PageLoader, Spinner } from '../../components/ui.js';
import { api, ApiRequestError, queryString } from '../../lib/api.js';

/**
 * Curates the carousel at the top of the desktop client's Home tab. Order here
 * is the order players see, so the list is reorderable rather than sorted.
 */
export function AdminFeaturedPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const featuredQuery = useQuery({
    queryKey: ['admin', 'featured'],
    queryFn: () => api.get<FeaturedEntry[]>('/admin/featured'),
  });

  const searchQuery = useQuery({
    queryKey: ['admin', 'featured', 'search', search],
    queryFn: () =>
      api.get<Paginated<GameSummary>>(`/games${queryString({ search, limit: 8, sort: 'title' })}`),
    enabled: search.trim().length > 1,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'featured'] });

  const upsertMutation = useMutation({
    mutationFn: (input: {
      gameId: string;
      headline?: string | null;
      blurb?: string | null;
      sortOrder?: number;
      active?: boolean;
    }) =>
      api.put<FeaturedEntry[]>('/admin/featured', {
        sortOrder: featuredQuery.data?.length ?? 0,
        active: true,
        ...input,
      }),
    onSuccess: () => {
      setError(null);
      setSearch('');
      void invalidate();
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not update.'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/featured/${id}`),
    onSuccess: invalidate,
  });

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => api.post('/admin/featured/reorder', { ids }),
    onSuccess: invalidate,
  });

  const artworkMutation = useMutation({
    mutationFn: ({ id, url }: { id: string; url: string | null }) =>
      api.put(`/admin/featured/${id}/artwork`, { url }),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not set the featured image.',
      ),
  });

  const entries = featuredQuery.data ?? [];

  /** Swaps an entry with its neighbor and persists the whole new order. */
  const move = (index: number, delta: number) => {
    const next = [...entries];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    reorderMutation.mutate(next.map((entry) => entry.id));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Featured</h1>
      <p className="text-ink-300 -mt-3 text-sm">
        These appear in the carousel on the Home tab of the desktop client, in this order.
      </p>

      <FormError message={error} />

      <section className="gb-card space-y-3 p-5">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Add a game</h2>
        <Field label="Search the catalog" htmlFor="featuredSearch">
          <input
            id="featuredSearch"
            className="gb-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Start typing a title…"
          />
        </Field>

        {searchQuery.isFetching ? <Spinner className="h-4 w-4" /> : null}
        {(searchQuery.data?.items ?? []).map((game) => (
          <button
            key={game.id}
            type="button"
            className="hover:bg-ink-800 flex w-full items-center gap-3 rounded-lg p-2 text-left"
            onClick={() => upsertMutation.mutate({ gameId: game.id })}
            disabled={entries.some((entry) => entry.game.id === game.id)}
          >
            {game.art.cover ? (
              <img src={game.art.cover} alt="" className="h-12 w-9 rounded object-cover" />
            ) : (
              <div className="bg-ink-800 h-12 w-9 rounded" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{game.title}</span>
            {entries.some((entry) => entry.game.id === game.id) ? (
              <Badge tone="neutral">Already featured</Badge>
            ) : (
              <Plus className="text-ink-400 h-4 w-4" aria-hidden />
            )}
          </button>
        ))}
      </section>

      {featuredQuery.isLoading ? (
        <PageLoader label="Loading featured games" />
      ) : entries.length === 0 ? (
        <EmptyState
          title="Nothing featured yet"
          message="Add a few games above and they will headline the Home tab."
        />
      ) : (
        <div className="space-y-3">
          {entries.map((entry, index) => (
            <FeaturedRow
              key={entry.id}
              entry={entry}
              isFirst={index === 0}
              isLast={index === entries.length - 1}
              onMoveUp={() => move(index, -1)}
              onMoveDown={() => move(index, 1)}
              onRemove={() => removeMutation.mutate(entry.id)}
              onSave={(patch) => upsertMutation.mutate({ gameId: entry.game.id, ...patch })}
              onSetArtwork={(url) => artworkMutation.mutate({ id: entry.id, url })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeaturedRow({
  entry,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onRemove,
  onSave,
  onSetArtwork,
}: {
  entry: FeaturedEntry;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onSave: (patch: { headline: string | null; blurb: string | null; active: boolean }) => void;
  onSetArtwork: (url: string | null) => void;
}) {
  const [headline, setHeadline] = useState(entry.headline ?? '');
  const [blurb, setBlurb] = useState(entry.blurb ?? '');
  const [picking, setPicking] = useState(false);

  return (
    <section className="gb-card overflow-hidden">
      {entry.heroUrl ? (
        <img src={entry.heroUrl} alt="" className="h-28 w-full object-cover" loading="lazy" />
      ) : (
        <div className="border-ink-700 text-ink-500 flex h-28 w-full items-center justify-center border-b border-dashed text-xs">
          No image — the carousel will show a blank slot
        </div>
      )}

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-400 text-xs">
            {entry.hasHeroOverride ? 'Using a hand-picked image' : "Using the game's own hero art"}
          </span>
          <button type="button" className="gb-btn-ghost ml-auto" onClick={() => setPicking(true)}>
            <Images className="h-4 w-4" aria-hidden />
            Browse gallery
          </button>
          {entry.hasHeroOverride ? (
            <button type="button" className="gb-btn-ghost" onClick={() => onSetArtwork(null)}>
              Use the game&rsquo;s art
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate font-medium">{entry.game.title}</h3>
          <button
            type="button"
            className="gb-btn-ghost"
            onClick={onMoveUp}
            disabled={isFirst}
            aria-label="Move up"
          >
            <ArrowUp className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            className="gb-btn-ghost"
            onClick={onMoveDown}
            disabled={isLast}
            aria-label="Move down"
          >
            <ArrowDown className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className="gb-btn-danger" onClick={onRemove} aria-label="Remove">
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <Field label="Headline" htmlFor={`h_${entry.id}`}>
          <input
            id={`h_${entry.id}`}
            className="gb-input"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder="Staff pick"
          />
        </Field>

        <Field label="Blurb" htmlFor={`b_${entry.id}`}>
          <textarea
            id={`b_${entry.id}`}
            className="gb-input min-h-16"
            value={blurb}
            onChange={(e) => setBlurb(e.target.value)}
            placeholder="One or two lines on why this is worth playing."
          />
        </Field>

        <button
          type="button"
          className="gb-btn-primary"
          onClick={() => onSave({ headline: headline || null, blurb: blurb || null, active: true })}
        >
          Save
        </button>
      </div>

      {picking ? (
        <ArtworkPicker
          gameId={entry.game.id}
          title={entry.game.title}
          kind="hero"
          heading="Featured image"
          onClose={() => setPicking(false)}
          onChoose={(url) => onSetArtwork(url)}
        />
      ) : null}
    </section>
  );
}
