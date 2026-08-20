import { COLLECTION_COLORS, type CollectionColor, type GameSummary } from '@gameblade/shared';
import clsx from 'clsx';
import { Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  useCollectionMutations,
  useCollections,
  useGameCollections,
} from '../hooks/useCollections.js';
import { errorMessage } from '../lib/ipc.js';
import { ErrorNote, Modal } from './ui.js';

/**
 * Puts one game into the caller's groups.
 *
 * A dialog rather than a submenu on the right-click menu: creating a group is
 * part of the same job as filing something into one, and a submenu that also
 * has to hold a text field is a submenu that has become a dialog anyway.
 */
export function CollectionPicker({ game, onClose }: { game: GameSummary; onClose: () => void }) {
  const collectionsQuery = useCollections();
  const membershipQuery = useGameCollections(game.id);
  const { create, addGames, removeGames, remove } = useCollectionMutations();

  const [name, setName] = useState('');
  const [color, setColor] = useState<CollectionColor>('blade');
  const [error, setError] = useState<string | null>(null);

  const collections = collectionsQuery.data ?? [];
  const memberOf = new Set(membershipQuery.data ?? []);

  /**
   * Files or unfiles the game straight away.
   *
   * The tick and the count come from the cache, which the mutation patches
   * before it sends, so a row responds on the click rather than on the reply
   * and several can be toggled in a row without waiting.
   */
  const toggle = (id: string) => {
    setError(null);
    const mutation = memberOf.has(id) ? removeGames : addGames;
    mutation.mutate(
      { id, gameIds: [game.id] },
      { onError: (caught) => setError(errorMessage(caught)) },
    );
  };

  return (
    <Modal title={`Groups for ${game.title}`} onClose={onClose}>
      <ErrorNote message={error} />

      {collections.length === 0 ? (
        <p className="muted">
          You have no groups yet. Make one below — a group is just a way to shelve games together,
          and adding one here does not move or copy anything.
        </p>
      ) : (
        <ul className="collection-list">
          {collections.map((collection) => {
            const inGroup = memberOf.has(collection.id);
            return (
              <li key={collection.id}>
                <button
                  type="button"
                  className={clsx('collection-row', inGroup && 'active')}
                  onClick={() => toggle(collection.id)}
                  aria-pressed={inGroup}
                >
                  <span className={`collection-dot ${collection.color}`} aria-hidden />
                  <span className="collection-name">{collection.name}</span>
                  <span className="muted small">{collection.gameCount}</span>
                  {inGroup ? <Check size={14} aria-hidden /> : null}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete ${collection.name}`}
                  onClick={() => {
                    if (!confirm(`Delete the group "${collection.name}"? The games are kept.`)) {
                      return;
                    }
                    remove.mutate(collection.id, {
                      onError: (caught) => setError(errorMessage(caught)),
                    });
                  }}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="collection-new"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          setError(null);
          create.mutate(
            { name: trimmed, color },
            {
              // Filing the game straight into the group it was just created for
              // is the whole reason this form is in this dialog.
              onSuccess: (collection) => {
                setName('');
                addGames.mutate({ id: collection.id, gameIds: [game.id] });
              },
              onError: (caught) => setError(errorMessage(caught)),
            },
          );
        }}
      >
        <div className="collection-colors" role="radiogroup" aria-label="Group colour">
          {COLLECTION_COLORS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={color === option}
              aria-label={option}
              className={clsx('collection-swatch', option, color === option && 'active')}
              onClick={() => setColor(option)}
            />
          ))}
        </div>

        <div className="collection-new-row">
          <input
            className="input"
            value={name}
            maxLength={60}
            placeholder="New group…"
            aria-label="New group name"
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!name.trim() || create.isPending}
          >
            {create.isPending ? (
              <Loader2 size={14} className="spin" aria-hidden />
            ) : (
              <Plus size={14} aria-hidden />
            )}
            Create
          </button>
        </div>
      </form>

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
