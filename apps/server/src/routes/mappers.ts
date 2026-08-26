import type { GameDetail, GameSummary, LaunchRule, SaveRule } from '@gameblade/shared';
import type { Game, gameLaunchRules, gameSaveRules } from '../db/schema.js';
import type { AchievementComparator, AchievementFormat, AchievementRule } from '@gameblade/shared';

/**
 * Extends a summary — already decorated with the caller's ownership, playtime
 * and achievement progress by `CatalogService` — with the fields only a detail
 * view needs.
 */
export function toGameDetail(
  game: Game,
  summary: GameSummary,
  options: { basePath: string; libraryName: string },
): GameDetail {
  return {
    ...summary,
    libraryId: game.libraryId,
    libraryName: options.libraryName,
    relPath: game.relPath,
    summary: game.summary,
    storyline: game.storyline,
    developers: game.developers ?? [],
    publishers: game.publishers ?? [],
    igdbId: game.igdbId,
    sgdbId: game.sgdbId,
    // Screenshots are stored as cached image ids and served from this server,
    // so no client request ever reaches a provider CDN. The ids ride along
    // beside the URLs because the admin editor addresses them by id to remove
    // one, and parsing an id back out of a URL is a worse contract.
    screenshots: (game.screenshots ?? []).map((id) => `${options.basePath}/api/images/${id}`),
    screenshotIds: game.screenshots ?? [],
    videos: game.videos ?? [],
    updatedAt: game.updatedAt,
    scannedAt: game.scannedAt,
  };
}

export function toSaveRule(row: typeof gameSaveRules.$inferSelect): SaveRule {
  return {
    id: row.id,
    gameId: row.gameId,
    pathTemplate: row.pathTemplate,
    include: row.include,
    exclude: row.exclude,
    note: row.note,
  };
}

export function toLaunchRule(row: typeof gameLaunchRules.$inferSelect): LaunchRule {
  return {
    id: row.id,
    gameId: row.gameId,
    executable: row.executable,
    args: row.args,
    workingDir: row.workingDir,
    note: row.note,
  };
}

/** One achievement rule as the client and the admin panel see it. */
export function toAchievementRule(row: {
  id: string;
  achievementKey: string;
  sourceTemplate: string;
  format: AchievementFormat;
  selector: string;
  comparator: AchievementComparator;
  value: string | null;
  tags?: string[] | null;
}): AchievementRule & { id: string } {
  return {
    id: row.id,
    achievementKey: row.achievementKey,
    sourceTemplate: row.sourceTemplate,
    format: row.format,
    selector: row.selector,
    comparator: row.comparator,
    value: row.value,
    tags: row.tags ?? [],
  };
}
