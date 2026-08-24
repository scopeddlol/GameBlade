import type {
  AchievementDefinitionInput,
  AchievementProgress,
  AchievementSummary,
} from '@gameblade/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { achievements, gameAchievementRules, games, userAchievements } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import type { NotificationService } from './notifications.js';
import type { RealtimeGateway } from './realtime.js';
import type { SettingsService } from './settings.js';

/** Shape of the public Steam achievement schema we consume. */
interface SteamSchemaResponse {
  game?: {
    availableGameStats?: {
      achievements?: Array<{
        name: string;
        displayName?: string;
        description?: string;
        icon?: string;
        hidden?: number;
      }>;
    };
  };
}

interface SteamGlobalPercentages {
  achievementpercentages?: {
    achievements?: Array<{ name: string; percent: number }>;
  };
}

const STEAM_API = 'https://api.steampowered.com';

export class AchievementService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    private readonly activity: ActivityService,
    private readonly realtime: RealtimeGateway,
    private readonly logger: FastifyBaseLogger,
  ) {}

  listForGame(gameId: string, userId: string): AchievementProgress[] {
    const rows = this.db
      .select({
        achievement: achievements,
        unlockedAt: userAchievements.unlockedAt,
        progress: userAchievements.progress,
      })
      .from(achievements)
      .leftJoin(
        userAchievements,
        and(
          eq(userAchievements.achievementId, achievements.id),
          eq(userAchievements.userId, userId),
        ),
      )
      .where(eq(achievements.gameId, gameId))
      .orderBy(achievements.sortOrder, achievements.name)
      .all();

    return rows.map((row) => this.toProgress(row.achievement, row.unlockedAt, row.progress));
  }

  /** Definitions only, for the admin editor where no user context applies. */
  definitionsForGame(gameId: string) {
    return this.db
      .select()
      .from(achievements)
      .where(eq(achievements.gameId, gameId))
      .orderBy(achievements.sortOrder, achievements.name)
      .all();
  }

  summaryForGame(gameId: string, userId: string, recentLimit = 4): AchievementSummary {
    const all = this.listForGame(gameId, userId);
    const unlocked = all.filter((a) => a.unlockedAt !== null);

    return {
      total: all.length,
      unlocked: unlocked.length,
      points: all.reduce((sum, a) => sum + a.points, 0),
      earnedPoints: unlocked.reduce((sum, a) => sum + a.points, 0),
      recent: [...unlocked]
        .sort((a, b) => (b.unlockedAt ?? '').localeCompare(a.unlockedAt ?? ''))
        .slice(0, recentLimit),
    };
  }

  /** Unlock counts for a batch of games, so a listing needs one query. */
  countsFor(userId: string, gameIds: string[]): Map<string, { total: number; unlocked: number }> {
    if (gameIds.length === 0) return new Map();

    const rows = this.db
      .select({
        gameId: achievements.gameId,
        total: sql<number>`count(*)`,
        unlocked: sql<number>`sum(case when ua.unlocked_at is not null then 1 else 0 end)`,
      })
      .from(achievements)
      .leftJoin(
        sql`user_achievements ua`,
        sql`ua.achievement_id = ${achievements.id} AND ua.user_id = ${userId}`,
      )
      .where(inArray(achievements.gameId, [...new Set(gameIds)]))
      .groupBy(achievements.gameId)
      .all();

    return new Map(
      rows.map((r) => [r.gameId, { total: r.total, unlocked: Number(r.unlocked ?? 0) }]),
    );
  }

  /** The caller's newest unlocks across every game, for the Home tab. */
  recentForUser(userId: string, limit: number): AchievementProgress[] {
    const rows = this.db
      .select({
        achievement: achievements,
        unlockedAt: userAchievements.unlockedAt,
        progress: userAchievements.progress,
      })
      .from(userAchievements)
      .innerJoin(achievements, eq(achievements.id, userAchievements.achievementId))
      .where(
        and(eq(userAchievements.userId, userId), sql`${userAchievements.unlockedAt} IS NOT NULL`),
      )
      .orderBy(desc(userAchievements.unlockedAt))
      .limit(limit)
      .all();

    return rows.map((row) => this.toProgress(row.achievement, row.unlockedAt, row.progress));
  }

  /**
   * Records an unlock reported by the client.
   *
   * These games are DRM-free and have no achievement runtime of their own, so
   * the client is the only thing that can observe progress. That makes unlocks
   * self-reported and therefore not cheat-proof; the server's job is to keep
   * them idempotent and well-formed, not to adjudicate them.
   */
  unlock(
    userId: string,
    gameId: string,
    key: string,
    progress: number | null,
  ): AchievementProgress {
    const definition = this.db
      .select()
      .from(achievements)
      .where(and(eq(achievements.gameId, gameId), eq(achievements.key, key)))
      .get();

    if (!definition) throw ApiError.notFound('No achievement with that key for this game');

    const existing = this.db
      .select()
      .from(userAchievements)
      .where(
        and(eq(userAchievements.userId, userId), eq(userAchievements.achievementId, definition.id)),
      )
      .get();

    // Already unlocked: re-reporting is a no-op so a client replaying its log
    // cannot spam the feed.
    if (existing?.unlockedAt) {
      return this.toProgress(definition, existing.unlockedAt, existing.progress);
    }

    const partial = progress !== null && progress < 100;
    const unlockedAt = partial ? null : isoNow();

    this.db
      .insert(userAchievements)
      .values({
        userId,
        achievementId: definition.id,
        unlockedAt,
        progress: progress ?? null,
      })
      .onConflictDoUpdate({
        target: [userAchievements.userId, userAchievements.achievementId],
        set: { unlockedAt, progress: progress ?? null },
      })
      .run();

    const result = this.toProgress(definition, unlockedAt, progress ?? null);
    if (!unlockedAt) return result;

    this.realtime.send(userId, { type: 'achievement', achievement: result });
    this.activity.record({
      userId,
      kind: 'unlocked-achievement',
      gameId,
      achievementId: definition.id,
    });
    this.notifications.create({
      userId,
      kind: 'achievement',
      title: `Unlocked "${definition.name}"`,
      body: definition.description,
      link: `library/${gameId}`,
    });

    return result;
  }

  upsertDefinition(gameId: string, input: AchievementDefinitionInput) {
    const record = {
      id: newId('ach'),
      gameId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      iconUrl: input.iconUrl?.trim() ? input.iconUrl : null,
      points: input.points,
      hidden: input.hidden,
      globalPercent: input.globalPercent === null ? null : Math.round(input.globalPercent ?? 0),
      source: input.source,
      sortOrder: input.sortOrder,
      createdAt: isoNow(),
    };

    this.db
      .insert(achievements)
      .values(record)
      .onConflictDoUpdate({
        target: [achievements.gameId, achievements.key],
        set: {
          name: record.name,
          description: record.description,
          iconUrl: record.iconUrl,
          points: record.points,
          hidden: record.hidden,
          globalPercent: record.globalPercent,
          source: record.source,
          sortOrder: record.sortOrder,
        },
      })
      .run();

    return this.db
      .select()
      .from(achievements)
      .where(and(eq(achievements.gameId, gameId), eq(achievements.key, input.key)))
      .get();
  }

  /**
   * Removes a definition, and any rule that pointed at it.
   *
   * `game_achievement_rules.achievement_key` is plain text with no foreign key
   * to the definition — it cascades on the game, not on the achievement — so a
   * deleted definition used to leave its rule behind. That rule still matched
   * on report, and `unlock` then threw for a key with no definition, failing
   * the whole request: one tidied-up achievement silently stopped *every*
   * achievement for that game from unlocking, with the client swallowing the
   * error. The report route no longer throws either, but the orphan should not
   * exist in the first place.
   */
  deleteDefinition(gameId: string, achievementId: string): void {
    const definition = this.db
      .select({ key: achievements.key })
      .from(achievements)
      .where(and(eq(achievements.id, achievementId), eq(achievements.gameId, gameId)))
      .get();

    this.db
      .delete(achievements)
      .where(and(eq(achievements.id, achievementId), eq(achievements.gameId, gameId)))
      .run();

    if (definition) {
      this.db
        .delete(gameAchievementRules)
        .where(
          and(
            eq(gameAchievementRules.gameId, gameId),
            eq(gameAchievementRules.achievementKey, definition.key),
          ),
        )
        .run();
    }
  }

  /**
   * Imports a game's achievement list from Steam's public schema endpoint.
   *
   * This reads published game metadata only — no player data is requested and no
   * account is linked — which is what makes it usable for DRM-free copies of
   * games that also happen to ship on Steam.
   */
  async importFromSteam(
    gameId: string,
    steamAppId: number,
    replace: boolean,
  ): Promise<{ imported: number; skipped: number }> {
    const apiKey = this.settings.get().steamApiKey;
    if (!apiKey) {
      throw ApiError.unavailable(
        'Add a Steam Web API key in Settings before importing achievements',
      );
    }

    const game = this.db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get();
    if (!game) throw ApiError.notFound('Game not found');

    const schema = await this.fetchJson<SteamSchemaResponse>(
      `${STEAM_API}/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(apiKey)}&appid=${steamAppId}`,
    );

    const list = schema.game?.availableGameStats?.achievements ?? [];
    if (list.length === 0) {
      return { imported: 0, skipped: 0 };
    }

    // Global unlock rates need no key and make the list far more interesting,
    // so a failure here is not worth failing the whole import over.
    const percentages = await this.fetchGlobalPercentages(steamAppId);

    if (replace) {
      this.db
        .delete(achievements)
        .where(and(eq(achievements.gameId, gameId), eq(achievements.source, 'steam')))
        .run();
    }

    let imported = 0;
    let skipped = 0;

    this.db.transaction((tx) => {
      list.forEach((entry, index) => {
        if (!entry.name) {
          skipped += 1;
          return;
        }
        const percent = percentages.get(entry.name);
        tx.insert(achievements)
          .values({
            id: newId('ach'),
            gameId,
            key: entry.name,
            name: entry.displayName?.trim() || entry.name,
            description: entry.description?.trim() || null,
            iconUrl: entry.icon ?? null,
            // Rarer achievements are worth more; the curve is deliberately flat
            // so a full clear lands in a familiar range rather than the hundreds.
            points: pointsForRarity(percent),
            hidden: entry.hidden === 1,
            globalPercent: percent === undefined ? null : Math.round(percent),
            source: 'steam' as const,
            sortOrder: index,
            createdAt: isoNow(),
          })
          .onConflictDoUpdate({
            target: [achievements.gameId, achievements.key],
            set: {
              name: entry.displayName?.trim() || entry.name,
              description: entry.description?.trim() || null,
              iconUrl: entry.icon ?? null,
              hidden: entry.hidden === 1,
              globalPercent: percent === undefined ? null : Math.round(percent),
              source: 'steam' as const,
              sortOrder: index,
            },
          })
          .run();
        imported += 1;
      });

      tx.update(games).set({ steamAppId }).where(eq(games.id, gameId)).run();
    });

    this.logger.info(
      { gameId, steamAppId, imported, skipped },
      'imported Steam achievement schema',
    );
    return { imported, skipped };
  }

  private async fetchGlobalPercentages(steamAppId: number): Promise<Map<string, number>> {
    try {
      const data = await this.fetchJson<SteamGlobalPercentages>(
        `${STEAM_API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${steamAppId}`,
      );
      const entries = data.achievementpercentages?.achievements ?? [];
      return new Map(entries.map((e) => [e.name, e.percent]));
    } catch (error) {
      this.logger.warn({ err: error, steamAppId }, 'could not read global achievement rates');
      return new Map();
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 403) {
      throw ApiError.badRequest('Steam rejected the API key');
    }
    if (response.status === 404) {
      throw ApiError.notFound('Steam has no achievement schema for that app id');
    }
    if (!response.ok) {
      throw ApiError.unavailable(`Steam returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private toProgress(
    definition: typeof achievements.$inferSelect,
    unlockedAt: string | null,
    progress: number | null,
  ): AchievementProgress {
    const locked = unlockedAt === null;
    return {
      id: definition.id,
      gameId: definition.gameId,
      key: definition.key,
      // A hidden achievement withholds its name and text until it is earned.
      name: definition.hidden && locked ? 'Hidden achievement' : definition.name,
      description: definition.hidden && locked ? null : definition.description,
      iconUrl: definition.iconUrl,
      points: definition.points,
      hidden: definition.hidden,
      globalPercent: definition.globalPercent,
      source: definition.source,
      sortOrder: definition.sortOrder,
      unlockedAt,
      progress,
    };
  }
}

function pointsForRarity(percent: number | undefined): number {
  if (percent === undefined) return 10;
  if (percent < 1) return 100;
  if (percent < 5) return 50;
  if (percent < 15) return 25;
  if (percent < 40) return 15;
  return 10;
}
