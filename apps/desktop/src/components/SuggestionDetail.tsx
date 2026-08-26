import type { GameRequestSuggestion } from '@gameblade/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowBigUp, Check, Sparkles, Star, X } from 'lucide-react';
import { useRequestMutations } from '../hooks/useRequests.js';
import { errorMessage } from '../lib/ipc.js';
import { Artwork, Badge } from './ui.js';

/**
 * A game the archive does not have, presented the way it would be if it did.
 *
 * Clicking a card on the Requests page used to do nothing at all: the only
 * thing on it that responded was the Request button, so deciding whether you
 * actually wanted a title meant reading two lines of truncated blurb and
 * guessing. Everything the provider sent is already on the client — the cover,
 * the full summary, the year, the score — and none of it was being shown.
 *
 * Deliberately not the game drawer. That page is built around a game that
 * exists here: install it, play it, sync its saves, see its achievements. None
 * of those are things you can do to a title nobody has added yet, and offering
 * them greyed out would be a page of dead buttons.
 */
export function SuggestionDetail({
  suggestion,
  onClose,
  onError,
}: {
  suggestion: GameRequestSuggestion;
  onClose: () => void;
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
      onClose();
    },
    onError: (caught) => onError(errorMessage(caught)),
  });

  return (
    <div
      className="drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={suggestion.title}
      onClick={onClose}
    >
      <div className="drawer suggestion-drawer" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
          <X size={18} aria-hidden />
        </button>

        <div className="suggestion-detail">
          <Artwork
            path={suggestion.coverUrl}
            alt={suggestion.title}
            className="suggestion-cover"
            fallbackText={suggestion.title}
          />

          <div className="suggestion-body">
            <h1>{suggestion.title}</h1>

            <div className="suggestion-meta">
              {suggestion.releaseYear ? <Badge>{suggestion.releaseYear}</Badge> : null}
              {suggestion.rating !== null ? (
                <span className="suggestion-score" title={`Rated ${suggestion.rating} out of 100`}>
                  <Star size={13} aria-hidden />
                  {suggestion.rating}
                </span>
              ) : null}
              {suggestion.status ? <Badge tone="info">Already asked for</Badge> : null}
            </div>

            {suggestion.summary ? (
              <p className="suggestion-summary">{suggestion.summary}</p>
            ) : (
              <p className="muted small">No description was published for this one.</p>
            )}

            <p className="muted small">
              This is not in the archive. Asking for it puts it on the operator&rsquo;s list, and
              the more people back it the higher it climbs.
            </p>

            <div className="suggestion-actions">
              <button
                type="button"
                className={clsx('btn btn-lg', suggestion.hasVoted ? 'btn-ghost' : 'btn-primary')}
                onClick={() => ask.mutate()}
                disabled={ask.isPending}
              >
                {suggestion.hasVoted ? (
                  <>
                    <Check size={16} aria-hidden /> Backed
                  </>
                ) : suggestion.requestId ? (
                  <>
                    <ArrowBigUp size={16} aria-hidden /> Back it
                  </>
                ) : (
                  <>
                    <Sparkles size={16} aria-hidden /> Request it
                  </>
                )}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
