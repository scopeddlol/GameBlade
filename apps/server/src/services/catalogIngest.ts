import { MESH_CHUNK_BYTES, type ReportedGame, type ReportedFile } from '@gameblade/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  gameArchiveExecutables,
  gameFileChunks,
  gameFiles,
  games,
  libraries,
  meshNodes,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseTitle, toSearchTitle, toSortTitle } from '../lib/titles.js';
import type { Logger } from './metadata/service.js';

export interface IngestResult {
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
}

/** How many rows to write per statement; SQLite caps bound parameters. */
const BATCH = 200;

function batched<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The handle drizzle hands a transaction body. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** One game's files, waiting to be written with everybody else's. */
interface FileWork {
  gameId: string;
  files: ReportedFile[];
}

interface ExecutableWork {
  gameId: string;
  executables: NonNullable<ReportedGame['executables']>;
}

/**
 * Takes a catalog a node scanned and folds it into this coordinator's database.
 *
 * This is the half of the move that people are right to be nervous about, so
 * the guarantee is worth stating plainly: **an existing game keeps its id**.
 * Games are matched within a library by relative path — exactly as the local
 * scanner matches them — so a node reporting a library that is already in the
 * database updates those rows rather than adding a second copy of everything.
 * Every achievement, save rule, artwork match, favourite, collection entry and
 * playtime record is keyed to that id and stays attached without being touched.
 *
 * The second guarantee follows from the first: only file-derived fields are
 * written. Size, file count, modification time. Never the title somebody
 * corrected, never the artwork they chose, never the IGDB match they made. A
 * scan reports what is on a disk; it has no opinion about any of that, and this
 * writes nothing it has no opinion about.
 *
 * Deliberately mirrors `ScannerService.reconcile` rather than sharing code with
 * it. They answer the same question from different sources and both are load
 * bearing, so the duplication is pinned by tests that assert the invariants
 * above rather than by one implementation both depend on.
 */
export class CatalogIngestService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /**
   * Fold one node's report into the library it was assigned.
   *
   * Refuses rather than guessing when no library is assigned. Guessing wrong —
   * or helpfully creating a new library — would re-add the entire catalog as
   * new games and orphan the metadata on the old ones, which is the single
   * worst thing this code could do.
   */
  ingest(
    nodeId: string,
    reported: ReportedGame[],
    options: { complete: boolean; seenRelPaths?: ReadonlySet<string> } = { complete: true },
  ): IngestResult {
    const node = this.db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();
    if (!node) throw ApiError.notFound('Unknown node');

    if (!node.libraryId) {
      throw new ApiError(
        409,
        'library_not_assigned',
        'This node has no library assigned. Assign one in Admin → Nodes before it reports a catalog.',
      );
    }

    const library = this.db.select().from(libraries).where(eq(libraries.id, node.libraryId)).get();
    if (!library) throw ApiError.notFound('The library assigned to this node no longer exists');

    const existing = new Map(
      this.db
        .select()
        .from(games)
        .where(eq(games.libraryId, library.id))
        .all()
        .map((game) => [game.relPath, game]),
    );

    /*
     * How many of each game's files this coordinator already has hashes for.
     *
     * Needed because hashing changes nothing else. A node reports its catalog
     * within minutes of starting and then spends hours hashing, and every
     * property the comparison below looks at — size, file count, modification
     * time — is identical before and after. So every game came back
     * "unchanged", the hashes were dropped, and the mesh never had a single
     * eligible game on a coordinator that had not been a standalone server
     * first. Nothing errored; the catalog was complete and none of it was
     * servable.
     *
     * One grouped query rather than a lookup per game: a report is thousands
     * of them.
     */
    const chunkedFiles = new Map(
      this.db
        .select({
          gameId: gameFiles.gameId,
          chunked: sql<number>`sum(case when ${gameFiles.chunkBytes} = ${MESH_CHUNK_BYTES} then 1 else 0 end)`,
        })
        .from(gameFiles)
        .innerJoin(games, eq(games.id, gameFiles.gameId))
        .where(eq(games.libraryId, library.id))
        .groupBy(gameFiles.gameId)
        .all()
        .map((row) => [row.gameId, Number(row.chunked)]),
    );

    const result: IngestResult = { added: 0, updated: 0, unchanged: 0, missing: 0 };
    const seen = new Set<string>();
    const now = new Date().toISOString();

    // Decided first, written second.
    //
    // The obvious shape - write each game as its decision is made - issues
    // three or four statements per entry, and a real archive is thousands of
    // entries arriving in one report. Every one of those is a prepared
    // statement behind a native handle, and this loop is synchronous, so none
    // of them is ever collected while it runs: one report allocated tens of
    // thousands and was still holding all of them at the end. It also meant a
    // report that failed halfway left the catalog halfway written. Sorting the
    // work out in memory and then writing it in batches inside one transaction
    // fixes both - the whole report lands or none of it does, in a number of
    // statements that grows with the batch count rather than the catalog.
    const inserts: (typeof games.$inferInsert)[] = [];
    const updates: { id: string; item: ReportedGame }[] = [];
    const fileWork: FileWork[] = [];
    const executableWork: ExecutableWork[] = [];

    for (const item of reported) {
      seen.add(item.relPath);
      const current = existing.get(item.relPath);

      if (current) {
        if (item.executables) {
          executableWork.push({ gameId: current.id, executables: item.executables });
        }
        // What the node says it has hashed, against what is stored. Equal is
        // the steady state — a node reporting the same library every five
        // minutes must not rewrite every file row for ever — and different in
        // either direction is work that has happened since the last report.
        const reportedChunked = item.files.filter(
          (file) => file.chunkBytes === MESH_CHUNK_BYTES && file.chunks?.length,
        ).length;
        const storedChunked = chunkedFiles.get(current.id) ?? 0;

        const unchanged =
          current.sizeBytes === item.sizeBytes &&
          current.fileCount === item.files.length &&
          current.contentMtime === item.contentMtime &&
          current.missingAt === null &&
          reportedChunked === storedChunked;

        if (unchanged) {
          result.unchanged += 1;
          continue;
        }

        updates.push({ id: current.id, item });
        fileWork.push({ gameId: current.id, files: item.files });
        result.updated += 1;
        continue;
      }

      const title = parseTitle(basename(item.relPath), item.kind === 'archive');
      const id = newId('gam');
      inserts.push({
        id,
        libraryId: library.id,
        relPath: item.relPath,
        kind: item.kind,
        title,
        sortTitle: toSortTitle(title),
        searchTitle: toSearchTitle(title),
        sizeBytes: item.sizeBytes,
        fileCount: item.files.length,
        contentMtime: item.contentMtime,
        matchStatus: 'unmatched',
        addedAt: now,
        updatedAt: now,
        scannedAt: now,
      });
      fileWork.push({ gameId: id, files: item.files });
      if (item.executables) executableWork.push({ gameId: id, executables: item.executables });
      result.added += 1;
    }

    // Only a complete report may mark games missing. A partial one says
    // nothing about what it did not mention, and reading silence as absence
    // would flag an entire catalog because a node sent it in pieces.
    // A batched report carries only one slice here. Its route accumulates every
    // path from the preceding slices and hands that complete set to the final
    // ingest; without it, finalising batch 12 would mark everything from batches
    // 0–11 missing.
    const completeSeen = options.seenRelPaths ?? seen;
    const vanished = options.complete
      ? [...existing.keys()].filter((relPath) => !completeSeen.has(relPath))
      : [];
    result.missing = vanished.length;

    this.db.transaction((tx) => {
      for (const batch of batched(inserts)) {
        tx.insert(games).values(batch).run();
      }

      for (const { id, item } of updates) {
        tx.update(games)
          .set({
            // File-derived only. Everything an operator curated is untouched.
            sizeBytes: item.sizeBytes,
            fileCount: item.files.length,
            contentMtime: item.contentMtime,
            scannedAt: now,
            updatedAt: now,
            missingAt: null,
          })
          .where(eq(games.id, id))
          .run();
      }

      this.replaceFiles(tx, fileWork);
      this.replaceArchiveExecutables(tx, executableWork);
      this.markMissing(tx, library.id, vanished, now);

      tx.update(meshNodes)
        .set({
          catalogReportedAt: now,
          catalogStatus: options.complete
            ? `ok: ${completeSeen.size} entries`
            : `receiving: ${reported.length} entries`,
        })
        .where(eq(meshNodes.id, nodeId))
        .run();
    });

    this.logger.info({ nodeId, library: library.name, ...result }, 'node catalog ingested');
    return result;
  }

  /**
   * Swap the file rows of every game in one report, keeping the node's hashes.
   *
   * The node has already read every byte to hash them, so carrying them across
   * here means the coordinator never has to - which matters rather a lot when
   * the coordinator has no copy of the file to read.
   *
   * Takes the whole report's worth at once rather than a game at a time: the
   * deletes collapse into a handful of `IN` statements and the inserts into a
   * handful of batches, instead of three statements per game.
   */
  private replaceFiles(tx: Tx, work: FileWork[]): void {
    if (work.length === 0) return;

    // Chunk rows cascade from the file rows, so this clears both.
    for (const batch of batched(
      work.map((entry) => entry.gameId),
      400,
    )) {
      tx.delete(gameFiles).where(inArray(gameFiles.gameId, batch)).run();
    }

    const now = new Date().toISOString();
    const fileRows: (typeof gameFiles.$inferInsert)[] = [];
    const chunkRows: (typeof gameFileChunks.$inferInsert)[] = [];

    for (const { gameId, files } of work) {
      for (const file of files) {
        const id = newId('gfl');
        // A pre-v0.8 Node omitted the grid and used 8 MiB. Never relabel those
        // hashes as the current 10 MiB layout during a rolling upgrade.
        const chunked = file.chunkBytes === MESH_CHUNK_BYTES && Boolean(file.chunks?.length);

        fileRows.push({
          id,
          gameId,
          relPath: file.relPath,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          sha256: file.sha256 ?? null,
          chunkedAt: chunked ? now : null,
          chunkBytes: chunked ? MESH_CHUNK_BYTES : null,
        });

        for (const piece of chunked ? (file.chunks ?? []) : []) {
          chunkRows.push({
            fileId: id,
            chunkIndex: piece.index,
            sizeBytes: piece.sizeBytes,
            sha256: piece.sha256,
          });
        }
      }
    }

    for (const batch of batched(fileRows)) {
      tx.insert(gameFiles).values(batch).run();
    }
    for (const batch of batched(chunkRows)) {
      tx.insert(gameFileChunks).values(batch).run();
    }
  }

  /** Replace the tiny launch-rule index reported from each ZIP central directory. */
  private replaceArchiveExecutables(tx: Tx, work: ExecutableWork[]): void {
    if (work.length === 0) return;

    for (const batch of batched(
      work.map((entry) => entry.gameId),
      400,
    )) {
      tx.delete(gameArchiveExecutables).where(inArray(gameArchiveExecutables.gameId, batch)).run();
    }

    const rows = work.flatMap(({ gameId, executables }) =>
      executables.map((candidate) => ({
        gameId,
        path: candidate.path,
        sizeBytes: candidate.sizeBytes,
      })),
    );
    for (const batch of batched(rows)) tx.insert(gameArchiveExecutables).values(batch).run();
  }

  /**
   * Flag what the node no longer has, without deleting it.
   *
   * A node that is mid-sync, or whose drive did not mount, reports a short
   * catalog. Deleting the difference would destroy hand-made metadata over a
   * temporary condition, so this marks and the operator decides.
   */
  private markMissing(tx: Tx, libraryId: string, vanished: string[], at: string): void {
    for (const batch of batched(vanished, 400)) {
      tx.update(games)
        .set({ missingAt: at })
        .where(
          and(
            eq(games.libraryId, libraryId),
            inArray(games.relPath, batch),
            isNull(games.missingAt),
          ),
        )
        .run();
    }
  }
}

/** The last path segment, forward- or back-slashed. */
function basename(relPath: string): string {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? relPath;
}
