import type { GameSummary } from '@gameblade/shared';
import clsx from 'clsx';
import { Check, Download, Play, Trophy } from 'lucide-react';
import { formatBytes, formatPlaytime, formatYear } from '../lib/format.js';
import { Artwork } from './ui.js';

/**
 * The poster tile used across Home, Library and Store.
 *
 * The primary action changes with state — install, play, or already-owned —
 * so one component covers all three tabs rather than each growing its own
 * near-identical card.
 */
export function GameCard({
  game,
  installed,
  onOpen,
  onPrimary,
  primaryLabel,
  busy,
}: {
  game: GameSummary;
  installed?: boolean;
  onOpen: (game: GameSummary) => void;
  onPrimary?: (game: GameSummary) => void;
  primaryLabel?: 'install' | 'play' | 'add';
  busy?: boolean;
}) {
  const year = formatYear(game.releaseDate);

  return (
    <div className={clsx('game-card', game.isMissing && 'missing')}>
      <button
        type="button"
        className="game-card-art"
        onClick={() => onOpen(game)}
        aria-label={`Open ${game.title}`}
      >
        <Artwork path={game.art.cover} alt={game.title} className="cover" />

        {game.unlockedCount > 0 ? (
          <span className="card-chip" title="Achievements unlocked">
            <Trophy size={12} aria-hidden />
            {game.unlockedCount}/{game.achievementCount}
          </span>
        ) : null}
      </button>

      <div className="game-card-body">
        <p className="game-card-title" title={game.title}>
          {game.title}
        </p>
        <p className="muted small">
          {game.playSeconds > 0
            ? formatPlaytime(game.playSeconds)
            : [year, formatBytes(game.sizeBytes)].filter(Boolean).join(' · ')}
        </p>
      </div>

      {onPrimary && primaryLabel ? (
        <button
          type="button"
          className={clsx('btn', primaryLabel === 'play' ? 'btn-primary' : 'btn-ghost', 'card-cta')}
          onClick={() => onPrimary(game)}
          disabled={busy}
        >
          {primaryLabel === 'play' ? (
            <>
              <Play size={14} aria-hidden /> Play
            </>
          ) : primaryLabel === 'install' ? (
            <>
              <Download size={14} aria-hidden /> {installed ? 'Installed' : 'Install'}
            </>
          ) : (
            <>
              {game.inLibrary ? <Check size={14} aria-hidden /> : null}
              {game.inLibrary ? 'In library' : 'Add to library'}
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

/** A horizontally scrolling shelf, as used by every row on the Home tab. */
export function GameShelf({
  games,
  onOpen,
  emptyMessage,
}: {
  games: GameSummary[];
  onOpen: (game: GameSummary) => void;
  emptyMessage?: string;
}) {
  if (games.length === 0) {
    return emptyMessage ? <p className="muted">{emptyMessage}</p> : null;
  }
  return (
    <div className="shelf">
      {games.map((game) => (
        <GameCard key={game.id} game={game} onOpen={onOpen} />
      ))}
    </div>
  );
}
