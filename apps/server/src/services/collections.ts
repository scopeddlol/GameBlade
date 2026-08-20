import {
  MAX_COLLECTIONS_PER_USER,
  type CollectionColor,
  type CollectionInfo,
  type CollectionInput,
} from '@gameblade/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { collectionGames, collections, games } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';

/**
 * A player's own groupings of games.
 *
 * Every method takes the owner's id and filters on it rather than checking
 * ownership after the fact: a missing `where` then produces "not found", which
 * is the safe failure, instead of quietly operating on somebody else's group.
 */
export class CollectionService {
  constructor(private readonly db: Db) {}

  list(userId: string): CollectionInfo[] {
    const rows = this.db
      .select()
      .from(collections)
      .where(eq(collections.userId, userId))
      .orderBy(asc(collections.sortOrder), asc(collections.name))
      .all();

    if (rows.length === 0) return [];

    // One grouped pass for the counts rather than a query per group — the
    // sidebar renders every group's badge on each load.
    const counts = new Map(
      this.db
        .select({ collectionId: collectionGames.collectionId, count: sql<number>`count(*)` })
        .from(collectionGames)
        .where(
          inArray(
            collectionGames.collectionId,
            rows.map((row) => row.id),
          ),
        )
        .groupBy(collectionGames.collectionId)
        .all()
        .map((row) => [row.collectionId, Number(row.count)]),
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color as CollectionColor,
      sortOrder: row.sortOrder,
      gameCount: counts.get(row.id) ?? 0,
      createdAt: row.createdAt,
    }));
  }

  create(userId: string, input: CollectionInput): CollectionInfo {
    const existingCount = this.db
      .select({ count: sql<number>`count(*)` })
      .from(collections)
      .where(eq(collections.userId, userId))
      .get();

    if (Number(existingCount?.count ?? 0) >= MAX_COLLECTIONS_PER_USER) {
      throw ApiError.badRequest(`You can have at most ${MAX_COLLECTIONS_PER_USER} groups.`);
    }

    const clash = this.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.userId, userId), eq(collections.name, input.name)))
      .get();
    if (clash) throw ApiError.conflict('You already have a group with that name');

    const record = {
      id: newId('col'),
      userId,
      name: input.name,
      color: input.color,
      sortOrder: Number(existingCount?.count ?? 0),
      createdAt: isoNow(),
    };
    this.db.insert(collections).values(record).run();

    return { ...record, gameCount: 0, color: record.color as CollectionColor };
  }

  update(userId: string, id: string, input: CollectionInput): CollectionInfo {
    this.owned(userId, id);

    const clash = this.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.userId, userId), eq(collections.name, input.name)))
      .get();
    if (clash && clash.id !== id)
      throw ApiError.conflict('You already have a group with that name');

    this.db
      .update(collections)
      .set({ name: input.name, color: input.color })
      .where(and(eq(collections.id, id), eq(collections.userId, userId)))
      .run();

    return this.list(userId).find((entry) => entry.id === id) as CollectionInfo;
  }

  remove(userId: string, id: string): void {
    this.owned(userId, id);
    // The join rows go with it via the foreign key; the games themselves are
    // untouched, which is the whole point of a group being a view over them.
    this.db
      .delete(collections)
      .where(and(eq(collections.id, id), eq(collections.userId, userId)))
      .run();
  }

  reorder(userId: string, ids: string[]): void {
    this.db.transaction((tx) => {
      ids.forEach((id, index) => {
        tx.update(collections)
          .set({ sortOrder: index })
          .where(and(eq(collections.id, id), eq(collections.userId, userId)))
          .run();
      });
    });
  }

  /** Adds games, ignoring any already present and any that do not exist. */
  addGames(userId: string, id: string, gameIds: string[]): number {
    this.owned(userId, id);

    const known = new Set(
      this.db
        .select({ id: games.id })
        .from(games)
        .where(inArray(games.id, gameIds))
        .all()
        .map((row) => row.id),
    );

    const rows = gameIds
      .filter((gameId) => known.has(gameId))
      .map((gameId) => ({ collectionId: id, gameId, addedAt: isoNow() }));
    if (rows.length === 0) return 0;

    this.db.insert(collectionGames).values(rows).onConflictDoNothing().run();
    return rows.length;
  }

  removeGames(userId: string, id: string, gameIds: string[]): void {
    this.owned(userId, id);
    this.db
      .delete(collectionGames)
      .where(and(eq(collectionGames.collectionId, id), inArray(collectionGames.gameId, gameIds)))
      .run();
  }

  /**
   * Which of the caller's groups each of these games is in.
   *
   * Returned as a map so a context menu can tick the groups a game already
   * belongs to without a request per game.
   */
  membership(userId: string, gameIds: string[]): Record<string, string[]> {
    if (gameIds.length === 0) return {};

    const rows = this.db
      .select({ gameId: collectionGames.gameId, collectionId: collectionGames.collectionId })
      .from(collectionGames)
      .innerJoin(collections, eq(collections.id, collectionGames.collectionId))
      .where(and(eq(collections.userId, userId), inArray(collectionGames.gameId, gameIds)))
      .all();

    const map: Record<string, string[]> = {};
    for (const row of rows) {
      (map[row.gameId] ??= []).push(row.collectionId);
    }
    return map;
  }

  private owned(userId: string, id: string): void {
    const row = this.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.id, id), eq(collections.userId, userId)))
      .get();
    if (!row) throw ApiError.notFound('That group no longer exists');
  }
}
