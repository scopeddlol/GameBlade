import type {
  CatalogGap,
  FeaturedEntry,
  FeaturedInput,
  GameQuery,
  GameSummary,
  HomeFeed,
  Paginated,
  StoreFacets,
} from '@gameblade/shared';
import { and, asc, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  featuredGames,
  gameLaunchRules,
  games,
  gameSaveRules,
  userGameState,
  userGameStats,
  userLibrary,
  users,
  type Game,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { AchievementService } from './achievements.js';
import type { ActivityService } from './activity.js';
import type { PresenceService } from './presence.js';
import type { PlaytimeService } from './playtime.js';
import type { ProfileService } from './profiles.js';

/**
 * One SQL condition per gap an administrator can filter on.
 *
 * These are deliberately written against the tables rather than derived from a
 * decorated page: "show me everything with no launch rule" has to mean every
 * such row in the catalog, not just the ones on the current page.
 */
const GAP_CONDITIONS: Record<CatalogGap, SQL> = {
  'launch-rule': sql`NOT EXISTS (SELECT 1 FROM game_launch_rules r
        WHERE r.game_id = ${games.id} AND r.executable IS NOT NULL AND r.executable <> '')`,
  'save-rule': sql`NOT EXISTS (SELECT 1 FROM game_save_rules r WHERE r.game_id = ${games.id})`,
  cover: isNull(games.coverImageId),
  banner: isNull(games.bannerImageId),
  hero: isNull(games.heroImageId),
  logo: isNull(games.logoImageId),
  icon: isNull(games.iconImageId),
  // "No artwork at all" is the one worth triaging first; a game missing only
  // its icon still looks finished everywhere a player sees it.
  artwork: sql`(${games.coverImageId} IS NULL AND ${games.heroImageId} IS NULL
        AND ${games.logoImageId} IS NULL AND ${games.iconImageId} IS NULL
        AND ${games.bannerImageId} IS NULL)`,
  achievements: sql`NOT EXISTS (SELECT 1 FROM achievements a WHERE a.game_id = ${games.id})`,
  // Nothing a store page could render: never identified, or identified and
  // still without a description.
  // Parenthesised because these are ANDed with the rest of the filters, and an
  // unbracketed OR would quietly swallow every other condition.
  metadata: sql`(${games.matchStatus} = 'unmatched' OR ${games.summary} IS NULL
        OR ${games.summary} = '')`,
};

/**
 * Reads the game catalog for a specific user.
 *
 * Every listing needs the same four per-user decorations — owned, favourited,
 * played, achievement progress — so they are resolved as set lookups over the
 * page rather than as correlated subqueries or a query per row.
 */
export class CatalogService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly playtime: PlaytimeService,
    private readonly achievements: AchievementService,
    private readonly profiles: ProfileService,
    private readonly presence: PresenceService,
    private readonly activity: ActivityService,
  ) {}

  /** Turns rows into summaries with everything the client renders. */
  decorate(rows: Game[], userId: string): GameSummary[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const owned = new Set(
      this.db
        .select({ gameId: userLibrary.gameId })
        .from(userLibrary)
        .where(and(eq(userLibrary.userId, userId), inArray(userLibrary.gameId, ids)))
        .all()
        .map((r) => r.gameId),
    );

    const favourites = new Set(
      this.db
        .select({ gameId: userGameState.gameId })
        .from(userGameState)
        .where(
          and(
            eq(userGameState.userId, userId),
            eq(userGameState.isFavorite, true),
            inArray(userGameState.gameId, ids),
          ),
        )
        .all()
        .map((r) => r.gameId),
    );

    const stats = this.playtime.statsFor(userId, ids);
    const achievementCounts = this.achievements.countsFor(userId, ids);

    // Two more set lookups over the page, in the same spirit as the ones
    // above: the admin catalog shows at a glance which entries a player could
    // not actually launch or sync, and the desktop client uses the same flags
    // to decide whether to offer a "play" button or a save-sync toggle.
    const withLaunchRule = new Set(
      this.db
        .selectDistinct({ gameId: gameLaunchRules.gameId })
        .from(gameLaunchRules)
        .where(inArray(gameLaunchRules.gameId, ids))
        .all()
        .map((r) => r.gameId),
    );
    const withSaveRule = new Set(
      this.db
        .selectDistinct({ gameId: gameSaveRules.gameId })
        .from(gameSaveRules)
        .where(inArray(gameSaveRules.gameId, ids))
        .all()
        .map((r) => r.gameId),
    );

    return rows.map((game) => {
      const stat = stats.get(game.id);
      const counts = achievementCounts.get(game.id);
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
        art: {
          cover: this.imageUrl(game.coverImageId),
          banner: this.imageUrl(game.bannerImageId),
          hero: this.imageUrl(game.heroImageId),
          logo: this.imageUrl(game.logoImageId),
          icon: this.imageUrl(game.iconImageId),
        },
        matchStatus: game.matchStatus,
        isFavorite: favourites.has(game.id),
        addedAt: game.addedAt,
        isMissing: game.missingAt !== null,
        inLibrary: owned.has(game.id),
        playSeconds: stat?.seconds ?? 0,
        lastPlayedAt: stat?.last ?? null,
        achievementCount: counts?.total ?? 0,
        unlockedCount: counts?.unlocked ?? 0,
        hasLaunchRule: withLaunchRule.has(game.id),
        hasSaveRule: withSaveRule.has(game.id),
      };
    });
  }

  /** The paginated query behind both the Store and the Library tab. */
  search(userId: string, query: GameQuery): Paginated<GameSummary> {
    const conditions: SQL[] = [];

    if (!query.includeMissing) conditions.push(isNull(games.missingAt));

    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '')}%`;
      const match = or(like(games.title, term), like(games.searchTitle, term));
      if (match) conditions.push(match);
    }
    if (query.libraryId) conditions.push(eq(games.libraryId, query.libraryId));
    if (query.matchStatus) conditions.push(eq(games.matchStatus, query.matchStatus));

    // Genres, platforms and developers are JSON arrays. Matching the quoted
    // value keeps "Action" from also matching "Action-Adventure".
    if (query.genre) conditions.push(sql`${games.genres} LIKE ${`%"${query.genre}"%`}`);
    if (query.platform) conditions.push(sql`${games.platforms} LIKE ${`%"${query.platform}"%`}`);
    if (query.developer) {
      conditions.push(sql`${games.developers} LIKE ${`%"${query.developer}"%`}`);
    }

    const gap = query.missing ? GAP_CONDITIONS[query.missing] : null;
    if (gap) conditions.push(gap);

    if (query.favoritesOnly) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM user_game_state ugs
              WHERE ugs.game_id = ${games.id} AND ugs.user_id = ${userId} AND ugs.is_favorite = 1)`,
      );
    }
    if (query.scope === 'library') {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM user_library ul
              WHERE ul.game_id = ${games.id} AND ul.user_id = ${userId})`,
      );
    } else if (query.scope === 'not-in-library') {
      conditions.push(
        sql`NOT EXISTS (SELECT 1 FROM user_library ul
              WHERE ul.game_id = ${games.id} AND ul.user_id = ${userId})`,
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const direction = query.order === 'desc' ? desc : asc;

    // Playtime lives in a per-user table, so those two sorts join it in rather
    // than ordering by a column on `games`.
    const needsStats = query.sort === 'played' || query.sort === 'playtime';
    const orderBy = needsStats
      ? query.sort === 'played'
        ? direction(sql`coalesce(ugs.last_played_at, '')`)
        : direction(sql`coalesce(ugs.total_seconds, 0)`)
      : direction(
          {
            title: games.sortTitle,
            added: games.addedAt,
            released: games.releaseDate,
            size: games.sizeBytes,
            rating: games.rating,
          }[query.sort as 'title' | 'added' | 'released' | 'size' | 'rating'],
        );

    const base = this.db.select().from(games).$dynamic();
    const withJoin = needsStats
      ? base.leftJoin(
          sql`user_game_stats ugs`,
          sql`ugs.game_id = ${games.id} AND ugs.user_id = ${userId}`,
        )
      : base;

    const rows = withJoin
      .where(where)
      // Secondary sort keeps pagination stable when the primary key ties.
      .orderBy(orderBy, asc(games.sortTitle))
      .limit(query.limit)
      .offset(query.offset)
      .all() as Array<Game | { games: Game }>;

    // A joined select nests the row under its table name; a plain one does not.
    const normalized = rows.map((row) => ('games' in row ? row.games : row));

    const totalRow = this.db
      .select({ count: sql<number>`count(*)` })
      .from(games)
      .where(where)
      .get();

    return {
      items: this.decorate(normalized, userId),
      total: totalRow?.count ?? 0,
      offset: query.offset,
      limit: query.limit,
    };
  }

  addToLibrary(userId: string, gameId: string): void {
    const game = this.db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const result = this.db
      .insert(userLibrary)
      .values({ userId, gameId, addedAt: isoNow() })
      .onConflictDoNothing()
      .run();

    // Only announce a genuinely new addition, so re-adding is quiet.
    if (result.changes > 0) {
      this.activity.record({ userId, kind: 'added-game', gameId });
    }
  }

  removeFromLibrary(userId: string, gameId: string): void {
    this.db
      .delete(userLibrary)
      .where(and(eq(userLibrary.userId, userId), eq(userLibrary.gameId, gameId)))
      .run();
  }

  /** Distinct values present in the catalog, for the Store filter rail. */
  facets(): StoreFacets {
    const rows = this.db
      .select({
        genres: games.genres,
        platforms: games.platforms,
        developers: games.developers,
      })
      .from(games)
      .where(isNull(games.missingAt))
      .all();

    const tally = (values: Array<string[] | null>) => {
      const counts = new Map<string, number>();
      for (const list of values) {
        for (const value of list ?? []) {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
      return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    };

    return {
      genres: tally(rows.map((r) => r.genres)),
      platforms: tally(rows.map((r) => r.platforms)),
      // Developers are a long tail; the rail only ever shows the top slice.
      developers: tally(rows.map((r) => r.developers)).slice(0, 40),
    };
  }

  /** Everything the Home tab renders, assembled server-side in one call. */
  home(userId: string): HomeFeed {
    const featured = this.listFeatured(userId, true);

    const continueRows = this.db
      .select({ game: games })
      .from(userGameStats)
      .innerJoin(games, eq(games.id, userGameStats.gameId))
      .where(and(eq(userGameStats.userId, userId), isNull(games.missingAt)))
      .orderBy(desc(userGameStats.lastPlayedAt))
      .limit(12)
      .all();

    const recentRows = this.db
      .select()
      .from(games)
      .where(isNull(games.missingAt))
      .orderBy(desc(games.addedAt))
      .limit(12)
      .all();

    const friendIds = [...this.profiles.friendIds(userId)];
    const friendProfiles = this.profiles.summarizeMany(friendIds, userId);

    // Only friends whose presence actually names a game land in this rail.
    const playingIds = friendIds
      .map((id) => ({ id, gameId: friendProfiles.get(id)?.playingGameId ?? null }))
      .filter((entry): entry is { id: string; gameId: string } => entry.gameId !== null);

    const playedGames =
      playingIds.length > 0
        ? this.db
            .select()
            .from(games)
            .where(inArray(games.id, [...new Set(playingIds.map((p) => p.gameId))]))
            .all()
        : [];
    const playedMap = new Map(this.decorate(playedGames, userId).map((g) => [g.id, g]));

    const friendsPlaying = playingIds.flatMap((entry) => {
      const profile = friendProfiles.get(entry.id);
      const game = playedMap.get(entry.gameId);
      return profile && game ? [{ profile, game }] : [];
    });

    return {
      featured,
      continuePlaying: this.decorate(
        continueRows.map((r) => r.game),
        userId,
      ),
      recentlyAdded: this.decorate(recentRows, userId),
      friendsPlaying,
      friendActivity: this.activity.list(userId, { scope: 'friends', limit: 15 }),
      recentAchievements: this.achievements.recentForUser(userId, 6),
      stats: this.serverStats(),
    };
  }

  /**
   * How many entries fall into each gap, for the filter chips on the admin
   * catalog. One grouped pass rather than a query per gap, so the count strip
   * costs the same as the listing beside it.
   */
  gapCounts(): Record<CatalogGap, number> {
    const columns = Object.fromEntries(
      Object.entries(GAP_CONDITIONS).map(([gap, condition]) => [
        gap,
        sql<number>`sum(case when ${condition} then 1 else 0 end)`,
      ]),
    ) as Record<CatalogGap, SQL<number>>;

    const row = this.db.select(columns).from(games).get();
    return Object.fromEntries(
      (Object.keys(GAP_CONDITIONS) as CatalogGap[]).map((gap) => [gap, Number(row?.[gap] ?? 0)]),
    ) as Record<CatalogGap, number>;
  }

  /* --------------------------------------------------------------- featured */

  listFeatured(userId: string, activeOnly: boolean): FeaturedEntry[] {
    const rows = this.db
      .select({ featured: featuredGames, game: games })
      .from(featuredGames)
      .innerJoin(games, eq(games.id, featuredGames.gameId))
      .where(activeOnly ? eq(featuredGames.active, true) : undefined)
      .orderBy(asc(featuredGames.sortOrder), asc(games.sortTitle))
      .all();

    const summaries = new Map(
      this.decorate(
        rows.map((r) => r.game),
        userId,
      ).map((g) => [g.id, g]),
    );

    return rows.flatMap((row) => {
      const game = summaries.get(row.game.id);
      if (!game) return [];
      return [
        {
          id: row.featured.id,
          game,
          headline: row.featured.headline,
          blurb: row.featured.blurb,
          // Falls back to the game's own hero art when no override is set.
          heroUrl: this.imageUrl(row.featured.heroImageId) ?? game.art.hero,
          hasHeroOverride: row.featured.heroImageId !== null,
          sortOrder: row.featured.sortOrder,
        },
      ];
    });
  }

  /** Points one carousel slot at a hand-picked hero image, or clears the override. */
  setFeaturedArtwork(id: string, imageId: string | null): void {
    const existing = this.db.select().from(featuredGames).where(eq(featuredGames.id, id)).get();
    if (!existing) throw ApiError.notFound('That featured entry no longer exists');

    this.db
      .update(featuredGames)
      .set({ heroImageId: imageId })
      .where(eq(featuredGames.id, id))
      .run();
  }

  upsertFeatured(input: FeaturedInput): void {
    const game = this.db
      .select({ id: games.id })
      .from(games)
      .where(eq(games.id, input.gameId))
      .get();
    if (!game) throw ApiError.notFound('Game not found');

    this.db
      .insert(featuredGames)
      .values({
        id: newId('ftr'),
        gameId: input.gameId,
        headline: input.headline ?? null,
        blurb: input.blurb ?? null,
        heroImageId: null,
        sortOrder: input.sortOrder,
        active: input.active,
        createdAt: isoNow(),
      })
      .onConflictDoUpdate({
        target: featuredGames.gameId,
        set: {
          headline: input.headline ?? null,
          blurb: input.blurb ?? null,
          sortOrder: input.sortOrder,
          active: input.active,
        },
      })
      .run();
  }

  removeFeatured(id: string): void {
    this.db.delete(featuredGames).where(eq(featuredGames.id, id)).run();
  }

  reorderFeatured(ids: string[]): void {
    this.db.transaction((tx) => {
      ids.forEach((id, index) => {
        tx.update(featuredGames).set({ sortOrder: index }).where(eq(featuredGames.id, id)).run();
      });
    });
  }

  private serverStats() {
    const gameCount = this.db
      .select({ count: sql<number>`count(*)` })
      .from(games)
      .where(isNull(games.missingAt))
      .get();

    const userCount = this.db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.isActive, true))
      .get();

    return {
      games: gameCount?.count ?? 0,
      users: userCount?.count ?? 0,
      totalPlayHours: this.playtime.totalHours(),
    };
  }

  /** Everyone currently connected, for the admin dashboard. */
  onlineCount(): number {
    return this.presence.onlineCount();
  }

  private imageUrl(id: string | null): string | null {
    return id ? `${this.config.basePath}/api/images/${id}` : null;
  }
}
