import type { DuplicateCandidate, DuplicateGroup, GameMergeReason } from '@gameblade/shared';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFiles, games, libraries, meshNodeGames, meshNodes } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import type { Logger } from './metadata/service.js';

/** The handle drizzle hands a transaction body. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * One catalog row, with everything a merge decision needs and nothing else.
 */
interface Row {
  id: string;
  title: string;
  searchTitle: string;
  relPath: string;
  libraryId: string;
  libraryName: string;
  sizeBytes: number;
  igdbId: number | null;
  matchStatus: 'unmatched' | 'auto' | 'manual' | 'skipped';
  addedAt: string;
  sha256: string | null;
  files: number;
}

export interface MergeResult {
  primaryId: string;
  merged: string[];
}

/**
 * How confident a rule is, highest first. Only the top two merge on their own.
 */
const CONFIDENCE: Record<GameMergeReason, number> = {
  content: 0,
  package: 1,
  metadata: 2,
  manual: 3,
};

/** Rules the automatic pass is allowed to act on without anybody looking. */
const AUTOMATIC: ReadonlySet<GameMergeReason> = new Set<GameMergeReason>(['content', 'package']);

/**
 * The package's file name, lowercased and stripped of the noise that changes
 * when a file is copied between machines.
 *
 * Windows and a few sync tools rename on copy — ` (1)`, `.1`, a trailing
 * space — and a rule that treats `Game.zip` and `Game (1).zip` as different
 * games would leave exactly the duplicates this exists to find.
 */
function packageKey(relPath: string): string {
  const base = relPath.split(/[\\/]/).filter(Boolean).pop() ?? relPath;
  return base
    .toLowerCase()
    .replace(/\.zip$/, '')
    .replace(/\s*\((?:\d+|copy)\)\s*$/, '')
    .replace(/[\s._-]*copy$/, '')
    .replace(/\.\d+$/, '')
    .trim();
}

/**
 * Finds and folds together catalog rows that are the same game on more than
 * one machine.
 *
 * The problem this solves is specific and was, until now, unavoidable: a node
 * reports its catalog into its own library, and games are matched within a
 * library by relative path. Two libraries therefore never match each other, so
 * moving an archive from a home server onto a VPS produced a second entry for
 * every game in it — same title, same bytes, same everything — and a store
 * listing each game twice.
 *
 * The merge is deliberately conservative and deliberately reversible:
 *
 * * **Nothing is deleted.** The folded-in row keeps its library, its path, its
 *   files and its chunk hashes, which is exactly what its machine needs to go
 *   on serving it. It stops being an entry of its own and becomes a *copy*.
 * * **The oldest, best-identified row wins.** Every achievement, save rule,
 *   playtime record and collection entry hangs off a game id, and the row that
 *   has been in the catalog longest is the one those are attached to.
 * * **Only proof merges automatically.** Identical package bytes, or the same
 *   package name at exactly the same size. Weaker evidence — the same
 *   identified game, two different builds of it — is offered to an operator
 *   and never acted on alone.
 */
export class DuplicateService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /* ------------------------------------------------------------- candidates */

  /**
   * Every present catalog entry, with its package hash and library name.
   *
   * One query rather than a walk: this runs after every catalog report, and a
   * real archive is thousands of rows.
   */
  private rows(): Row[] {
    return (
      this.db
        .select({
          id: games.id,
          title: games.title,
          searchTitle: games.searchTitle,
          relPath: games.relPath,
          libraryId: games.libraryId,
          libraryName: libraries.name,
          sizeBytes: games.sizeBytes,
          igdbId: games.igdbId,
          matchStatus: games.matchStatus,
          addedAt: games.addedAt,
          // A game is one ZIP, so `min` is that ZIP's hash. Written as an
          // aggregate rather than a join so a row whose file is still being
          // hashed comes back with a null instead of disappearing.
          sha256: sql<string | null>`min(${gameFiles.sha256})`,
          files: sql<number>`count(${gameFiles.id})`,
        })
        .from(games)
        .innerJoin(libraries, eq(libraries.id, games.libraryId))
        .leftJoin(gameFiles, eq(gameFiles.gameId, games.id))
        /*
         * Copies whose files have gone are candidates too, deliberately.
         *
         * The sequence that makes this matter: a game is deleted from the
         * machine that had it, is flagged missing, and turns up on a second
         * machine a day later. If a missing row could not be merged into, the
         * arriving copy would become a separate entry and the original — with
         * every achievement and every hour of playtime on it — would stay
         * missing for ever beside it.
         */
        .where(isNull(games.mergedIntoId))
        .groupBy(games.id)
        .all()
        .map((row) => ({ ...row, files: Number(row.files) }))
    );
  }

  /**
   * Group rows that describe the same game, strongest evidence first.
   *
   * A row is only ever in one group: once identical bytes have claimed it,
   * asking whether its name also matches something else answers nothing.
   */
  private group(rows: Row[]): { reason: GameMergeReason; key: string; members: Row[] }[] {
    const claimed = new Set<string>();
    const groups: { reason: GameMergeReason; key: string; members: Row[] }[] = [];

    const collect = (
      reason: GameMergeReason,
      keyOf: (row: Row) => string | null,
      eligible: (row: Row) => boolean = () => true,
    ) => {
      const buckets = new Map<string, Row[]>();
      for (const row of rows) {
        if (claimed.has(row.id) || !eligible(row)) continue;
        const key = keyOf(row);
        if (!key) continue;
        const bucket = buckets.get(key) ?? [];
        bucket.push(row);
        buckets.set(key, bucket);
      }

      for (const [key, members] of buckets) {
        // Two copies on the same disk are two copies on the same disk. The
        // scanner already sees both, an operator put them there, and folding
        // them together would hide a deliberate arrangement rather than fix an
        // accident of how nodes report.
        const libraryCount = new Set(members.map((row) => row.libraryId)).size;
        if (members.length < 2 || libraryCount < 2) continue;
        for (const row of members) claimed.add(row.id);
        groups.push({ reason, key, members });
      }
    };

    // Identical bytes. Nothing else can be as certain, and two rows that agree
    // here can also be served interchangeably chunk for chunk.
    collect('content', (row) => (row.files === 1 && row.sha256 ? `sha:${row.sha256}` : null));

    // The same package at exactly the same size. This is what a copied archive
    // looks like before either side has been hashed — which is most of the
    // first hour after a library is moved.
    collect('package', (row) =>
      row.sizeBytes > 0 ? `pkg:${packageKey(row.relPath)}:${row.sizeBytes}` : null,
    );

    // The same identified game, which may be two different builds of it. Never
    // merged automatically; offered, with the sizes shown, so the difference is
    // visible before anybody decides.
    collect(
      'metadata',
      (row) => (row.igdbId ? `igdb:${row.igdbId}` : null),
      (row) => row.matchStatus === 'auto' || row.matchStatus === 'manual',
    );

    // Same cleaned title, different size. Weakest of the four and still worth
    // showing: it is how a re-packaged copy of the same game presents.
    collect('metadata', (row) => (row.searchTitle ? `title:${row.searchTitle}` : null));

    return groups;
  }

  /**
   * Which row of a group survives, and keeps everything attached to its id.
   *
   * Identification first, then age. A hand-matched row carries artwork and a
   * description somebody chose; the oldest row carries the playtime and the
   * achievements. Preferring the identified one and then the older of those is
   * the order that loses the least.
   */
  private primaryOf(members: Row[]): Row {
    const rank = (row: Row) =>
      row.matchStatus === 'manual' ? 0 : row.matchStatus === 'auto' ? 1 : 2;

    return [...members].sort((a, b) => {
      const byMatch = rank(a) - rank(b);
      if (byMatch !== 0) return byMatch;
      const byAge = a.addedAt.localeCompare(b.addedAt);
      if (byAge !== 0) return byAge;
      return a.id.localeCompare(b.id);
    })[0] as Row;
  }

  /**
   * Groups an operator could act on, weakest evidence included.
   *
   * Everything the automatic pass would already have merged is gone by the time
   * this is asked, so in a healthy deployment this lists the judgement calls and
   * nothing else.
   */
  suggestions(): DuplicateGroup[] {
    const rows = this.rows();
    const online = this.onlineGameIds(rows.map((row) => row.id));

    return this.group(rows)
      .map((group) => {
        const primary = this.primaryOf(group.members);
        const describe = (row: Row): DuplicateCandidate => ({
          gameId: row.id,
          title: row.title,
          libraryId: row.libraryId,
          libraryName: row.libraryName,
          relPath: row.relPath,
          sizeBytes: row.sizeBytes,
          contentHash: row.sha256,
          addedAt: row.addedAt,
          matchStatus: row.matchStatus,
          online: online.has(row.id),
        });

        return {
          key: group.key,
          reason: group.reason,
          primary: describe(primary),
          duplicates: group.members.filter((row) => row.id !== primary.id).map(describe),
        };
      })
      .sort((a, b) => {
        const byReason = CONFIDENCE[a.reason] - CONFIDENCE[b.reason];
        return byReason !== 0 ? byReason : a.primary.title.localeCompare(b.primary.title);
      });
  }

  /** Which of these rows an online node is currently announcing. */
  private onlineGameIds(gameIds: string[]): Set<string> {
    const found = new Set<string>();
    for (let offset = 0; offset < gameIds.length; offset += 400) {
      const batch = gameIds.slice(offset, offset + 400);
      const rows = this.db
        .selectDistinct({ gameId: meshNodeGames.gameId })
        .from(meshNodeGames)
        .innerJoin(meshNodes, eq(meshNodes.id, meshNodeGames.nodeId))
        .where(and(inArray(meshNodeGames.gameId, batch), eq(meshNodes.status, 'online')))
        .all();
      for (const row of rows) found.add(row.gameId);
    }
    return found;
  }

  /* ----------------------------------------------------------------- merging */

  /**
   * Fold every group the evidence settles on its own.
   *
   * Called after a node reports a catalog, which is the moment duplicates
   * appear: a second machine's first report is a whole library of them. Returns
   * how many entries it folded away, for the log line the caller writes.
   */
  autoMerge(): { groups: number; merged: number } {
    const rows = this.rows();
    let groupsMerged = 0;
    let merged = 0;

    for (const group of this.group(rows)) {
      if (!AUTOMATIC.has(group.reason)) continue;
      const primary = this.primaryOf(group.members);
      const duplicates = group.members.filter((row) => row.id !== primary.id).map((row) => row.id);
      if (duplicates.length === 0) continue;

      try {
        const result = this.merge(primary.id, duplicates, group.reason);
        groupsMerged += 1;
        merged += result.merged.length;
      } catch (error) {
        // One unmergeable group must not stop the rest: the usual cause is a
        // row that vanished between the query and the write, which fixes
        // itself on the next report.
        this.logger.warn({ err: error, key: group.key }, 'could not merge a duplicate group');
      }
    }

    if (merged > 0) {
      this.logger.info({ groups: groupsMerged, merged }, 'folded duplicate catalog entries');
    }
    return { groups: groupsMerged, merged };
  }

  /**
   * Fold specific rows into one entry.
   *
   * The primary must be an entry in its own right — merging into something that
   * is itself a copy would build a chain, and every reader would then have to
   * walk it. Anything already merged elsewhere is re-pointed here instead,
   * which is what makes merging a group twice harmless.
   */
  merge(primaryId: string, duplicateIds: string[], reason: GameMergeReason): MergeResult {
    const primary = this.db.select().from(games).where(eq(games.id, primaryId)).get();
    if (!primary) throw ApiError.notFound('That game is not in the catalog');
    if (primary.mergedIntoId) {
      throw ApiError.conflict(
        'That entry is itself a copy of another. Merge into the entry it belongs to instead.',
      );
    }

    const targets = duplicateIds.filter((id) => id !== primaryId);
    if (targets.length === 0) return { primaryId, merged: [] };

    const rows = this.db.select().from(games).where(inArray(games.id, targets)).all();
    const missing = targets.filter((id) => !rows.some((row) => row.id === id));
    if (missing.length > 0) {
      throw ApiError.notFound(`No catalog entry for ${missing.join(', ')}`);
    }

    const at = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const row of rows) {
        // Anything that was merged into this row comes along, otherwise the
        // copies it was holding would be orphaned behind a row that is itself
        // now a copy.
        tx.update(games)
          .set({ mergedIntoId: primaryId })
          .where(eq(games.mergedIntoId, row.id))
          .run();

        this.repoint(tx, row.id, primaryId);

        tx.update(games)
          .set({ mergedIntoId: primaryId, mergedAt: at, mergeReason: reason })
          .where(eq(games.id, row.id))
          .run();
      }
    });

    // A copy arriving is a reason for the entry to come back: the usual shape
    // of this is a library that has been moved, where the new machine reports
    // its copy after the old one has already reported the original gone.
    this.refreshEntryPresence();

    this.logger.info(
      { primaryId, merged: targets.length, reason },
      'merged duplicate catalog entries',
    );
    return { primaryId, merged: targets.map((id) => id) };
  }

  /**
   * Move what a player owns from a folded-in row onto the entry that survives.
   *
   * Only things attached to *people* move. Files, chunk hashes, the ZIP's
   * executable index and the node announcements stay exactly where they are:
   * they describe a copy on a particular disk, and moving them would destroy
   * the machine's ability to serve it — which is the whole reason the row is
   * kept rather than deleted.
   *
   * `UPDATE OR IGNORE` then `DELETE` is the shape throughout. Where a player
   * already has a row for the surviving entry — they favourited both copies,
   * say — the update is skipped by the unique index and the leftover is
   * removed, so the primary's own record always wins over the copy's.
   */
  private repoint(tx: Tx, fromId: string, toId: string): void {
    // Playtime is added rather than replaced: two rows for one player are two
    // halves of the same history, and picking one would silently delete hours
    // somebody actually played.
    tx.run(sql`
      UPDATE user_game_stats AS target
         SET total_seconds = target.total_seconds + source.total_seconds,
             launch_count  = target.launch_count + source.launch_count,
             last_played_at = CASE
               WHEN source.last_played_at IS NULL THEN target.last_played_at
               WHEN target.last_played_at IS NULL THEN source.last_played_at
               WHEN source.last_played_at > target.last_played_at THEN source.last_played_at
               ELSE target.last_played_at
             END
        FROM user_game_stats AS source
       WHERE source.game_id = ${fromId}
         AND target.game_id = ${toId}
         AND target.user_id = source.user_id
    `);

    /*
     * Rows a player would otherwise see twice, or have counted twice.
     *
     * Where the update is refused because the player already has the same row
     * against the surviving entry, the copy's leftover is removed: they
     * favourited both halves of what turned out to be one game, and one
     * favourite is the honest answer. Playtime is here because it has already
     * been added to the primary's row above, so leaving the source would be
     * the same hours twice.
     */
    const replaceable = [
      'user_game_state',
      'user_library',
      'user_game_stats',
      'collection_games',
      'featured_games',
    ];

    /*
     * Rows that are a record of something that happened.
     *
     * Moved where they can be, and left alone where a unique key refuses them
     * — never deleted. A save slot is somebody's save file, a play session is
     * an evening they spent; the copy's row stays attached to the copy, which
     * is still in the database, rather than being thrown away to tidy up a
     * merge.
     */
    const historical = [
      'play_sessions',
      'save_slots',
      'download_events',
      'activity_events',
      'posts',
      'mesh_transfers',
      'game_requests',
    ];

    // The table name is interpolated because SQL cannot bind one; every value
    // is bound. Those names are the fixed lists above and never reach here
    // from a request, while the ids very much do.
    for (const table of [...replaceable, ...historical]) {
      const name = sql.raw(table);
      tx.run(sql`UPDATE OR IGNORE ${name} SET game_id = ${toId} WHERE game_id = ${fromId}`);
    }
    for (const table of replaceable) {
      const name = sql.raw(table);
      tx.run(sql`DELETE FROM ${name} WHERE game_id = ${fromId}`);
    }

    /*
     * An achievement set moves only into an empty one.
     *
     * `user_achievements` rows point at achievement ids rather than game ids,
     * so moving the set carries every player's unlocks with it untouched. If
     * the surviving entry already has a set, the copy keeps its own: two sets
     * merged by name would produce duplicates nobody can tell apart, and
     * deleting one would delete the unlocks hanging off it.
     */
    this.adoptIfAbsent(tx, 'achievements', fromId, toId);

    tx.run(sql`
      UPDATE user_profiles SET favorite_game_id = ${toId} WHERE favorite_game_id = ${fromId}
    `);
    tx.run(sql`UPDATE messages SET shared_game_id = ${toId} WHERE shared_game_id = ${fromId}`);

    // Rules and achievement sets move only into a gap. The surviving entry is
    // the one an operator has been curating; a copy's automatically imported
    // set must never overwrite the one somebody edited.
    this.adoptIfAbsent(tx, 'game_launch_rules', fromId, toId);
    this.adoptIfAbsent(tx, 'game_save_rules', fromId, toId);
    this.adoptIfAbsent(tx, 'game_achievement_rules', fromId, toId);
  }

  /**
   * Move a copy's rules across, but only into a gap.
   *
   * The surviving entry is the one an operator has been curating. A copy's
   * automatically derived launch rule must never overwrite one somebody wrote,
   * so the move happens only where the primary has nothing at all — and where
   * it does, the copy keeps its own rule rather than having it deleted.
   */
  private adoptIfAbsent(tx: Tx, table: string, fromId: string, toId: string): void {
    const name = sql.raw(table);
    tx.run(sql`
      UPDATE OR IGNORE ${name} SET game_id = ${toId}
       WHERE game_id = ${fromId}
         AND NOT EXISTS (SELECT 1 FROM ${name} existing WHERE existing.game_id = ${toId})
    `);
  }

  /**
   * Pull one copy back out into an entry of its own.
   *
   * What moved to the primary stays there. This is not an undo of history — the
   * playtime a player accrued belongs to the game they played, and the entry
   * they played it under is the one that survived — it is a statement that
   * these are two different games after all.
   */
  unmerge(gameId: string): void {
    const row = this.db.select().from(games).where(eq(games.id, gameId)).get();
    if (!row) throw ApiError.notFound('That game is not in the catalog');
    if (!row.mergedIntoId) throw ApiError.conflict('That entry is not a copy of anything');

    this.db
      .update(games)
      .set({ mergedIntoId: null, mergedAt: null, mergeReason: null })
      .where(eq(games.id, gameId))
      .run();
    this.logger.info({ gameId, wasMergedInto: row.mergedIntoId }, 'unmerged a catalog entry');
  }

  /**
   * Entries that are currently held as more than one copy.
   *
   * The other half of the duplicates page, and the half that makes an
   * automatic merge safe to do at all: whatever the rules folded together can
   * be seen, and pulled apart again, by somebody who disagrees.
   *
   * Bounded, because on a fully mirrored archive this is every game in it and
   * an operator checking a merge does not need four thousand rows to find it.
   */
  mergedGroups(limit = 100): DuplicateGroup[] {
    const copies = this.db
      .select({ game: games, libraryName: libraries.name })
      .from(games)
      .innerJoin(libraries, eq(libraries.id, games.libraryId))
      .where(isNotNull(games.mergedIntoId))
      .orderBy(desc(games.mergedAt))
      .limit(limit)
      .all();

    if (copies.length === 0) return [];

    const primaryIds = [...new Set(copies.map((row) => row.game.mergedIntoId as string))];
    const primaries = new Map(
      this.db
        .select({ game: games, libraryName: libraries.name })
        .from(games)
        .innerJoin(libraries, eq(libraries.id, games.libraryId))
        .where(inArray(games.id, primaryIds))
        .all()
        .map((row) => [row.game.id, row]),
    );

    const hashes = new Map(
      this.db
        .select({
          gameId: gameFiles.gameId,
          sha256: sql<string | null>`min(${gameFiles.sha256})`,
        })
        .from(gameFiles)
        .where(inArray(gameFiles.gameId, [...primaryIds, ...copies.map((row) => row.game.id)]))
        .groupBy(gameFiles.gameId)
        .all()
        .map((row) => [row.gameId, row.sha256]),
    );

    const online = this.onlineGameIds([...primaryIds, ...copies.map((row) => row.game.id)]);

    const describe = (row: { game: typeof games.$inferSelect; libraryName: string }) => ({
      gameId: row.game.id,
      title: row.game.title,
      libraryId: row.game.libraryId,
      libraryName: row.libraryName,
      relPath: row.game.relPath,
      sizeBytes: row.game.sizeBytes,
      contentHash: hashes.get(row.game.id) ?? null,
      addedAt: row.game.addedAt,
      matchStatus: row.game.matchStatus,
      online: online.has(row.game.id),
    });

    const grouped = new Map<string, DuplicateGroup>();
    for (const copy of copies) {
      const primaryId = copy.game.mergedIntoId as string;
      const primary = primaries.get(primaryId);
      if (!primary) continue;

      const existing = grouped.get(primaryId);
      if (existing) {
        existing.duplicates.push(describe(copy));
        continue;
      }

      grouped.set(primaryId, {
        key: primaryId,
        reason: copy.game.mergeReason ?? 'manual',
        primary: describe(primary),
        duplicates: [describe(copy)],
      });
    }

    return [...grouped.values()];
  }

  /* ---------------------------------------------------------- presence */

  /**
   * Bring a catalog entry back when one of its copies is still there.
   *
   * This is the other half of holding one entry across several machines, and
   * the half that is easy to miss: moving a library to a VPS ends with the
   * local copy being deleted, the local node reporting it gone, and the entry
   * — which is that local row — being flagged as missing. The VPS copy is
   * online the whole time. Without this the archive would quietly empty itself
   * out over exactly the move it is meant to support.
   *
   * One statement, run after anything that can mark rows missing. Cheap enough
   * to be unconditional and idempotent by construction.
   */
  refreshEntryPresence(): number {
    const back = this.db.run(sql`
      UPDATE games
         SET missing_at = NULL
       WHERE missing_at IS NOT NULL
         AND merged_into_id IS NULL
         AND EXISTS (
           SELECT 1 FROM games copy
            WHERE copy.merged_into_id = games.id AND copy.missing_at IS NULL
         )
    `);

    /*
     * And the other direction: the last copy has gone too.
     *
     * `own_missing_at` is why this can be said at all. It records that this
     * row's own files are not there, which is true whether or not the entry
     * was still being served from somewhere else at the time — so when the
     * somewhere else goes away, the entry can be marked honestly instead of
     * sitting in the catalog as available with nothing behind it.
     */
    const gone = this.db.run(sql`
      UPDATE games
         SET missing_at = own_missing_at
       WHERE missing_at IS NULL
         AND own_missing_at IS NOT NULL
         AND merged_into_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM games copy
            WHERE copy.merged_into_id = games.id AND copy.missing_at IS NULL
         )
    `);

    return Number(back.changes ?? 0) + Number(gone.changes ?? 0);
  }

  /** Every copy behind one catalog entry, the entry's own row included. */
  copiesOf(gameId: string): string[] {
    const merged = this.db
      .select({ id: games.id })
      .from(games)
      .where(eq(games.mergedIntoId, gameId))
      .all()
      .map((row) => row.id);
    return [gameId, ...merged];
  }

  /**
   * How many entries currently have a copy on more than one machine.
   *
   * The number an operator watches while a library is being moved: it should
   * climb as the second host catches up and stay there.
   */
  mergedCount(): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(games)
      .where(isNotNull(games.mergedIntoId))
      .get();
    return Number(row?.count ?? 0);
  }
}
