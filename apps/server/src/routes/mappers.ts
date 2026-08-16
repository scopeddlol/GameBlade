import type { GameArt, GameDetail, GameSummary } from '@gameblade/shared';
import type { Game } from '../db/schema.js';

/**
 * Artwork is addressed through our own image route rather than the provider CDN,
 * so cached art keeps working offline and no client IP reaches IGDB or SteamGridDB.
 */
export function buildArt(game: Game, basePath: string): GameArt {
  const url = (id: string | null) => (id ? `${basePath}/api/images/${id}` : null);
  return {
    cover: url(game.coverImageId),
    hero: url(game.heroImageId),
    logo: url(game.logoImageId),
    icon: url(game.iconImageId),
  };
}

export function toGameSummary(
  game: Game,
  options: { basePath: string; isFavorite?: boolean },
): GameSummary {
  return {
    id: game.id,
    title: game.title,
    sortTitle: game.sortTitle,
    kind: game.kind,
    sizeBytes: game.sizeBytes,
    fileCount: game.fileCount,
    releaseDate: game.releaseDate,
    rating: game.rating,
    genres: game.genres ?? [],
    platforms: game.platforms ?? [],
    art: buildArt(game, options.basePath),
    matchStatus: game.matchStatus,
    isFavorite: options.isFavorite ?? false,
    addedAt: game.addedAt,
    isMissing: game.missingAt !== null,
  };
}

export function toGameDetail(
  game: Game,
  options: { basePath: string; libraryName: string; isFavorite?: boolean },
): GameDetail {
  return {
    ...toGameSummary(game, options),
    libraryId: game.libraryId,
    libraryName: options.libraryName,
    relPath: game.relPath,
    summary: game.summary,
    storyline: game.storyline,
    developers: game.developers ?? [],
    publishers: game.publishers ?? [],
    igdbId: game.igdbId,
    sgdbId: game.sgdbId,
    screenshots: (game.screenshots ?? []).map((id) => `${options.basePath}/api/images/${id}`),
    videos: game.videos ?? [],
    updatedAt: game.updatedAt,
    scannedAt: game.scannedAt,
  };
}
