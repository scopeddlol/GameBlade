import type { GameSummary } from '@gameblade/shared';
import clsx from 'clsx';
import { Archive, Folder, Heart, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatBytes, formatYear } from '../lib/format.js';

export function GameCard({
  game,
  onToggleFavorite,
}: {
  game: GameSummary;
  onToggleFavorite?: (game: GameSummary) => void;
}) {
  const year = formatYear(game.releaseDate);
  const KindIcon = game.kind === 'archive' ? Archive : Folder;

  return (
    <div className="group relative">
      <Link
        to={`/game/${game.id}`}
        className="focus-visible:outline-blade-400 block rounded-xl focus-visible:outline-2"
      >
        <div className="bg-ink-800 ring-ink-700/60 group-hover:ring-blade-500/70 relative aspect-[2/3] overflow-hidden rounded-xl ring-1 transition-all group-hover:-translate-y-1 group-hover:shadow-xl group-hover:shadow-black/50">
          {game.art.cover ? (
            <img
              src={game.art.cover}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            // Without artwork the title has to carry the tile, so it is shown large.
            <div className="from-ink-700 to-ink-850 flex h-full w-full items-center justify-center bg-gradient-to-br p-3">
              <span className="text-ink-200 line-clamp-4 text-center text-sm font-semibold">
                {game.title}
              </span>
            </div>
          )}

          {game.isMissing ? (
            <div className="absolute inset-x-0 top-0 bg-amber-600/90 py-1 text-center text-[11px] font-semibold text-amber-50">
              Files missing
            </div>
          ) : null}

          <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1">
            <span className="bg-ink-950/80 text-ink-200 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium backdrop-blur">
              <KindIcon className="h-3 w-3" aria-hidden />
              {formatBytes(game.sizeBytes)}
            </span>
          </div>

          {game.rating !== null ? (
            <span className="bg-ink-950/80 text-ink-100 absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden />
              {game.rating}
            </span>
          ) : null}
        </div>
      </Link>

      {onToggleFavorite ? (
        <button
          type="button"
          onClick={() => onToggleFavorite(game)}
          aria-label={game.isFavorite ? `Unfavourite ${game.title}` : `Favourite ${game.title}`}
          aria-pressed={game.isFavorite}
          className={clsx(
            'bg-ink-950/80 absolute top-1.5 right-1.5 rounded-full p-1.5 backdrop-blur transition',
            game.isFavorite
              ? 'text-red-400 opacity-100'
              : 'text-ink-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <Heart className={clsx('h-4 w-4', game.isFavorite && 'fill-current')} aria-hidden />
        </button>
      ) : null}

      <div className="mt-2 px-0.5">
        <Link
          to={`/game/${game.id}`}
          className="text-ink-100 hover:text-blade-400 line-clamp-2 text-sm font-medium"
        >
          {game.title}
        </Link>
        <p className="text-ink-400 mt-0.5 text-xs">
          {year ?? 'Unknown year'}
          {game.genres[0] ? ` · ${game.genres[0]}` : ''}
        </p>
      </div>
    </div>
  );
}

export function GameGrid({
  games,
  onToggleFavorite,
}: {
  games: GameSummary[];
  onToggleFavorite?: (game: GameSummary) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
      {games.map((game) => (
        <GameCard key={game.id} game={game} onToggleFavorite={onToggleFavorite} />
      ))}
    </div>
  );
}
