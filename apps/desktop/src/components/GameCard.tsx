import type { GameSummary } from '@gameblade/shared';
import clsx from 'clsx';
import { Check, Clock, Download, Play, Trophy } from 'lucide-react';
import type { MouseEvent } from 'react';
import { formatBytes, formatPlaytime, formatYear } from '../lib/format.js';
import { Artwork, GameCapabilities } from './ui.js';

/**
 * Whether the primary button should be an action or an explanation.
 *
 * A game the server cannot serve yet is still worth showing — the archive is
 * the point of a store — but offering "Install" on one is how a player ends up
 * staring at an error five minutes into a download. `add` stays live either
 * way: putting something in your library is a bookmark, and bookmarking a game
 * that is not ready yet is exactly what you would want to do with it.
 */
export function isComingSoon(game: GameSummary): boolean {
  return game.availability === 'coming-soon';
}

/** The button shown in place of Install while a game is not ready. */
function ComingSoon({ game, className }: { game: GameSummary; className?: string }) {
  return (
    <span
      className={clsx('btn btn-ghost coming-soon', className)}
      title={game.availabilityNote ?? 'Not ready to install yet.'}
    >
      <Clock size={14} aria-hidden />
      Coming soon
    </span>
  );
}

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
  onContextMenu,
}: {
  game: GameSummary;
  installed?: boolean;
  onOpen: (game: GameSummary) => void;
  onPrimary?: (game: GameSummary) => void;
  primaryLabel?: 'install' | 'play' | 'add';
  busy?: boolean;
  /** Right-click anywhere on the tile, not just the artwork. */
  onContextMenu?: (event: MouseEvent, game: GameSummary) => void;
}) {
  const year = formatYear(game.releaseDate);

  return (
    <div
      className={clsx('game-card', game.isMissing && 'missing')}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, game) : undefined}
    >
      <button
        type="button"
        className="game-card-art"
        onClick={() => onOpen(game)}
        aria-label={`Open ${game.title}`}
      >
        <Artwork path={game.art.cover} alt={game.title} className="cover" />

        {/* On the poster rather than only on the button, because the Store's
            button says "Add to library" — which stays available — and the
            player still needs to know before they open it. */}
        {isComingSoon(game) ? (
          <span
            className="card-chip coming-soon-chip"
            title={game.availabilityNote ?? 'Not ready to install yet.'}
          >
            <Clock size={12} aria-hidden />
            Coming soon
          </span>
        ) : game.unlockedCount > 0 ? (
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
        {/* Icons only under a poster: the labels do not fit, and the tooltip
            carries the detail for anyone who wants it. */}
        <GameCapabilities
          hasSaveRule={game.hasSaveRule}
          achievementCount={game.achievementCount}
          unlockedCount={game.unlockedCount}
          compact
        />
      </div>

      {onPrimary && primaryLabel === 'install' && isComingSoon(game) ? (
        <ComingSoon game={game} className="card-cta" />
      ) : onPrimary && primaryLabel ? (
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
  onContextMenu,
}: {
  games: GameSummary[];
  onOpen: (game: GameSummary) => void;
  emptyMessage?: string;
  onContextMenu?: (event: MouseEvent, game: GameSummary) => void;
}) {
  if (games.length === 0) {
    return emptyMessage ? <p className="muted">{emptyMessage}</p> : null;
  }
  return (
    <div className="shelf">
      {games.map((game) => (
        <GameCard key={game.id} game={game} onOpen={onOpen} onContextMenu={onContextMenu} />
      ))}
    </div>
  );
}

/**
 * One game as a row rather than a poster.
 *
 * A dense list is the right shape for a large library: it fits four or five
 * times as many titles on screen, and it can carry the columns a poster has no
 * room for — size, last played, whether it is installed — as text rather than
 * as badges layered over artwork.
 */
export function GameRow({
  game,
  installed,
  onOpen,
  onPrimary,
  primaryLabel,
  busy,
  onContextMenu,
}: {
  game: GameSummary;
  installed?: boolean;
  onOpen: (game: GameSummary) => void;
  onPrimary?: (game: GameSummary) => void;
  primaryLabel?: 'install' | 'play' | 'add';
  busy?: boolean;
  onContextMenu?: (event: MouseEvent, game: GameSummary) => void;
}) {
  const year = formatYear(game.releaseDate);

  return (
    <div
      className={clsx('game-row', game.isMissing && 'missing')}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, game) : undefined}
    >
      <button
        type="button"
        className="game-row-main"
        onClick={() => onOpen(game)}
        aria-label={`Open ${game.title}`}
      >
        {/* The square icon where a game has one; its cover, cropped, otherwise.
            A row this short cannot show a portrait cover without either
            squashing it or making every row three times as tall. */}
        <Artwork
          path={game.art.icon ?? game.art.cover}
          alt=""
          className="row-icon"
          fallbackText={game.title}
        />

        <span className="game-row-title">{game.title}</span>

        <span className="game-row-meta muted small">
          {[year, formatBytes(game.sizeBytes)].filter(Boolean).join(' · ')}
        </span>

        <span className="game-row-meta muted small">
          {game.playSeconds > 0 ? formatPlaytime(game.playSeconds) : '—'}
        </span>

        <span className="game-row-meta muted small">
          {game.achievementCount > 0 ? (
            <span className="row-chip">
              <Trophy size={12} aria-hidden />
              {game.unlockedCount}/{game.achievementCount}
            </span>
          ) : (
            '—'
          )}
        </span>

        <span className="game-row-meta">
          {installed ? (
            <span className="row-chip installed">Installed</span>
          ) : isComingSoon(game) ? (
            <span className="row-chip coming-soon-chip" title={game.availabilityNote ?? undefined}>
              Coming soon
            </span>
          ) : null}
        </span>
      </button>

      {onPrimary && primaryLabel === 'install' && isComingSoon(game) ? (
        <ComingSoon game={game} />
      ) : onPrimary && primaryLabel ? (
        <button
          type="button"
          className={clsx('btn', primaryLabel === 'play' ? 'btn-primary' : 'btn-ghost')}
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
              {game.inLibrary ? 'In library' : 'Add'}
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One game as a wide panel: artwork, blurb and every stat spelled out.
 *
 * Between the poster grid and the dense list. The grid is for recognising a
 * game by its cover and the list is for finding one by name; this is for
 * deciding what to play, which needs the things neither of those has room for
 * — what the game actually is, when it came out, who made it.
 */
export function GameDetailedRow({
  game,
  installed,
  onOpen,
  onPrimary,
  primaryLabel,
  busy,
  onContextMenu,
}: {
  game: GameSummary;
  installed?: boolean;
  onOpen: (game: GameSummary) => void;
  onPrimary?: (game: GameSummary) => void;
  primaryLabel?: 'install' | 'play' | 'add';
  busy?: boolean;
  onContextMenu?: (event: MouseEvent, game: GameSummary) => void;
}) {
  const year = formatYear(game.releaseDate);
  const facts = [
    year,
    formatBytes(game.sizeBytes),
    game.playSeconds > 0 ? formatPlaytime(game.playSeconds) : null,
  ].filter(Boolean) as string[];

  return (
    <div
      className={clsx('game-detailed', game.isMissing && 'missing')}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, game) : undefined}
    >
      <button
        type="button"
        className="game-detailed-art"
        onClick={() => onOpen(game)}
        aria-label={`Open ${game.title}`}
      >
        <Artwork path={game.art.cover} alt={game.title} className="cover" />
      </button>

      <div className="game-detailed-body">
        <div className="game-detailed-head">
          <button type="button" className="game-detailed-title" onClick={() => onOpen(game)}>
            {game.title}
          </button>
          {installed ? <span className="row-chip installed">Installed</span> : null}
          {game.isMissing ? <span className="row-chip missing-chip">Missing</span> : null}
          {!game.isMissing && isComingSoon(game) ? (
            <span className="row-chip coming-soon-chip" title={game.availabilityNote ?? undefined}>
              Coming soon
            </span>
          ) : null}
        </div>

        <p className="game-detailed-facts muted small">{facts.join(' · ')}</p>

        {game.summary ? <p className="game-detailed-summary">{game.summary}</p> : null}

        <div className="game-detailed-tags">
          {game.genres.slice(0, 4).map((genre) => (
            <span key={genre} className="row-chip">
              {genre}
            </span>
          ))}
          {game.achievementCount > 0 ? (
            <span className="row-chip">
              <Trophy size={12} aria-hidden />
              {game.unlockedCount}/{game.achievementCount}
            </span>
          ) : null}
        </div>
      </div>

      {onPrimary && primaryLabel ? (
        <div className="game-detailed-action">
          {primaryLabel === 'install' && isComingSoon(game) ? (
            <ComingSoon game={game} />
          ) : (
            <button
              type="button"
              className={clsx('btn', primaryLabel === 'play' ? 'btn-primary' : 'btn-ghost')}
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
                  {game.inLibrary ? 'In library' : 'Add'}
                </>
              )}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
