import {
  resolveStoreTemplate,
  usableStores,
  type AchievementDefinitionInput,
  type AchievementProgress,
  type AchievementSummary,
  type BulkImportResult,
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
const STEAM_STORE_SEARCH = 'https://store.steampowered.com/api/storesearch/';

interface SteamStoreSearchResponse {
  items?: Array<{ id?: number; name?: string }>;
}

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

  /** Finds the unambiguous Steam catalogue entry that best matches this game's title. */
  async findSteamAppId(gameId: string): Promise<{ steamAppId: number; title: string }> {
    const game = this.db
      .select({ title: games.title })
      .from(games)
      .where(eq(games.id, gameId))
      .get();
    if (!game) throw ApiError.notFound('Game not found');

    const response = await this.fetchJson<SteamStoreSearchResponse>(
      `${STEAM_STORE_SEARCH}?term=${encodeURIComponent(game.title)}&l=english&cc=us`,
    );
    const candidates = (response.items ?? []).filter(
      (item): item is { id: number; name: string } =>
        Number.isInteger(item.id) && Boolean(item.name),
    );
    const titleKey = steamTitleKey(game.title);
    const exact = candidates.find((item) => steamTitleKey(item.name) === titleKey);
    const result = exact ?? candidates[0];
    if (!result) throw ApiError.notFound(`Steam could not find a game named "${game.title}"`);
    if (!exact && candidates.length > 1) {
      throw ApiError.badRequest(
        `Steam found several games for "${game.title}". Enter its AppID manually.`,
      );
    }
    return { steamAppId: result.id, title: result.name };
  }

  async autoImportFromSteam(gameId: string, replace: boolean) {
    const match = await this.findSteamAppId(gameId);
    const imported = await this.importFromSteam(gameId, match.steamAppId, replace);
    return { ...match, ...imported };
  }

  /**
   * Writes the rules that make an imported list actually unlock.
   *
   * Lifted out of the route it used to live in so the bulk importer can call
   * it too: importing a hundred games and leaving every one of them with names
   * that never fire is not a feature, it is a hundred games to go back through
   * by hand.
   *
   * Rules are written for *every* applicable emulator layout at once, on
   * purpose: one whose file does not exist reads as nothing and unlocks
   * nothing, so the layouts that do not apply stay silent and whichever the
   * player's copy actually uses is the one that fires.
   */
  generateRules(
    gameId: string,
    options: { sources?: string[]; replace?: boolean } = {},
  ): { generated: number; achievements: number; stores: string[] } {
    const { sources: wanted, replace = true } = options;

    const game = this.db
      .select({ id: games.id, steamAppId: games.steamAppId })
      .from(games)
      .where(eq(games.id, gameId))
      .get();
    if (!game) throw ApiError.notFound('Game not found');

    const keys = this.db
      .select({ key: achievements.key })
      .from(achievements)
      .where(eq(achievements.gameId, gameId))
      .all()
      .map((row) => row.key);

    if (keys.length === 0) {
      throw ApiError.badRequest(
        "Import this game's achievements first — there is nothing to write rules for.",
      );
    }

    const stores = usableStores(game.steamAppId ?? null).filter(
      (store) => !wanted || wanted.includes(store.id),
    );
    if (stores.length === 0) {
      throw ApiError.badRequest(
        game.steamAppId
          ? 'None of the selected layouts are usable for this game.'
          : "Set this game's Steam app id first: every emulator layout but the portable one stores saves under it.",
      );
    }

    this.db.transaction((tx) => {
      // Replacing by default: generating twice should not double every rule.
      if (replace) {
        tx.delete(gameAchievementRules).where(eq(gameAchievementRules.gameId, gameId)).run();
      }
      for (const store of stores) {
        const template = resolveStoreTemplate(store, game.steamAppId ?? null);
        for (const key of keys) {
          tx.insert(gameAchievementRules)
            .values({
              id: newId('achr'),
              gameId,
              achievementKey: key,
              sourceTemplate: template,
              format: store.format,
              selector: store.selector(key),
              comparator: store.comparator,
              value: null,
              createdAt: isoNow(),
            })
            .run();
        }
      }
    });

    return {
      generated: stores.length * keys.length,
      achievements: keys.length,
      stores: stores.map((store) => store.id),
    };
  }

  /**
   * Writes many definitions to one game in a single transaction.
   *
   * Adding achievements one PUT at a time is fine for a correction and absurd
   * for a game that ships two hundred of them, which is the whole reason the
   * paste box exists. One transaction, so a bad row half way down cannot leave
   * the game with the first half of a list.
   */
  bulkUpsertDefinitions(
    gameId: string,
    inputs: AchievementDefinitionInput[],
    replace: boolean,
  ): { written: number; total: number } {
    const game = this.db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get();
    if (!game) throw ApiError.notFound('Game not found');

    // The last row wins, rather than the insert failing on its own conflict
    // target: a pasted list with a repeated key is a typo, not a reason to
    // reject two hundred good rows.
    const byKey = new Map(inputs.map((input) => [input.key, input]));

    // Statements run through `this.db` rather than the callback's handle, and
    // that is fine here: better-sqlite3 is one synchronous connection, so
    // everything issued inside the callback — including `upsertDefinition`,
    // which has no transaction parameter to take — is inside the same
    // transaction.
    this.db.transaction(() => {
      if (replace) {
        this.db.delete(achievements).where(eq(achievements.gameId, gameId)).run();
        // The rules point at keys by name with no foreign key of their own, so
        // wiping the definitions without them leaves rules that can never fire.
        this.db.delete(gameAchievementRules).where(eq(gameAchievementRules.gameId, gameId)).run();
      }
      let index = 0;
      for (const input of byKey.values()) {
        this.upsertDefinition(gameId, {
          ...input,
          // A pasted list has an order, and it is the order it was pasted in.
          sortOrder: input.sortOrder || index,
        });
        index += 1;
      }
    });

    return {
      written: byKey.size,
      total: this.definitionsForGame(gameId).length,
    };
  }

  /**
   * Imports a batch of games from Steam, one at a time, and reports each.
   *
   * One game's failure is never the batch's: an ambiguous title, a game that
   * is not on Steam at all, and a game whose Steam entry has no achievements
   * are all ordinary and all common across a real catalog. Each is recorded
   * against its own row so the operator gets a list of what to look at by hand
   * rather than a request that stopped at the first awkward title.
   *
   * Sequential rather than parallel on purpose. Steam rate-limits the store
   * search hard, and eight concurrent lookups is the reliable way to be told
   * to go away for the rest of the batch.
   */
  async bulkImportFromSteam(
    gameIds: string[],
    options: { replace: boolean; generateRules: boolean; skipExisting: boolean },
  ): Promise<BulkImportResult[]> {
    const results: BulkImportResult[] = [];

    for (const gameId of gameIds) {
      const game = this.db
        .select({ id: games.id, title: games.title, steamAppId: games.steamAppId })
        .from(games)
        .where(eq(games.id, gameId))
        .get();

      if (!game) {
        results.push({
          gameId,
          title: gameId,
          status: 'failed',
          steamAppId: null,
          imported: 0,
          rules: null,
          message: 'That game is no longer in the catalog.',
        });
        continue;
      }

      const existing = this.definitionsForGame(gameId).length;
      if (options.skipExisting && existing > 0) {
        results.push({
          gameId,
          title: game.title,
          status: 'skipped',
          steamAppId: game.steamAppId,
          imported: 0,
          rules: null,
          message: `Already has ${existing} ${existing === 1 ? 'achievement' : 'achievements'}.`,
        });
        continue;
      }

      try {
        // A stored app id is the operator's own answer and beats searching for
        // one — the search is a guess, and this game has already been decided.
        const steamAppId = game.steamAppId ?? (await this.findSteamAppId(gameId)).steamAppId;
        const { imported } = await this.importFromSteam(gameId, steamAppId, options.replace);

        if (imported === 0) {
          results.push({
            gameId,
            title: game.title,
            status: 'skipped',
            steamAppId,
            imported: 0,
            rules: null,
            message: 'Steam publishes no achievements for this game.',
          });
          continue;
        }

        let rules: number | null = null;
        if (options.generateRules) {
          try {
            rules = this.generateRules(gameId).generated;
          } catch (error) {
            // The import itself succeeded and is worth keeping; say plainly
            // that the half which makes them unlock did not happen.
            this.logger.warn({ err: error, gameId }, 'could not generate achievement rules');
            results.push({
              gameId,
              title: game.title,
              status: 'imported',
              steamAppId,
              imported,
              rules: null,
              message: `Imported ${imported}, but the unlock rules could not be written: ${messageOf(error)}`,
            });
            continue;
          }
        }

        results.push({
          gameId,
          title: game.title,
          status: 'imported',
          steamAppId,
          imported,
          rules,
          message:
            rules === null
              ? `Imported ${imported}.`
              : `Imported ${imported} and wrote ${rules} unlock rules.`,
        });
      } catch (error) {
        results.push({
          gameId,
          title: game.title,
          status: 'failed',
          steamAppId: game.steamAppId,
          imported: 0,
          rules: null,
          message: messageOf(error),
        });
      }
    }

    return results;
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

/** Whatever a failed step said, in one line fit for a results table. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.';
}

function steamTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

function pointsForRarity(percent: number | undefined): number {
  if (percent === undefined) return 10;
  if (percent < 1) return 100;
  if (percent < 5) return 50;
  if (percent < 15) return 25;
  if (percent < 40) return 15;
  return 10;
}
