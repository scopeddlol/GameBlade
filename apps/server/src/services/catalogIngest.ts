import { MESH_CHUNK_BYTES, type ReportedGame, type ReportedFile } from '@gameblade/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFileChunks, gameFiles, games, libraries, meshNodes } from '../db/schema.js';
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
    options: { complete: boolean } = { complete: true },
  ): IngestResult {
    const node = this.db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();
    if (!node) throw ApiError.notFound('Unknown node');

    if (!node.libraryId) {
      throw new ApiError(
        409,
        'library_not_assigned',
        'This node has no library assigned. Assign one in Admin → Settings → Nodes before it reports a catalog.',
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

    const result: IngestResult = { added: 0, updated: 0, unchanged: 0, missing: 0 };
    const seen = new Set<string>();

    for (const item of reported) {
      seen.add(item.relPath);
      const current = existing.get(item.relPath);

      if (current) {
        const unchanged =
          current.sizeBytes === item.sizeBytes &&
          current.fileCount === item.files.length &&
          current.contentMtime === item.contentMtime &&
          current.missingAt === null;

        if (unchanged) {
          result.unchanged += 1;
          continue;
        }

        const now = new Date().toISOString();
        this.db
          .update(games)
          .set({
            // File-derived only. Everything an operator curated is untouched.
            sizeBytes: item.sizeBytes,
            fileCount: item.files.length,
            contentMtime: item.contentMtime,
            scannedAt: now,
            updatedAt: now,
            missingAt: null,
          })
          .where(eq(games.id, current.id))
          .run();

        this.replaceFiles(current.id, item.files);
        result.updated += 1;
        continue;
      }

      this.insert(library.id, item);
      result.added += 1;
    }

    // Only a complete report may mark games missing. A partial one says
    // nothing about what it did not mention, and reading silence as absence
    // would flag an entire catalog because a node sent it in pieces.
    result.missing = options.complete ? this.markMissing(library.id, existing, seen) : 0;

    this.db
      .update(meshNodes)
      .set({
        catalogReportedAt: new Date().toISOString(),
        catalogStatus: `ok: ${reported.length} entries`,
      })
      .where(eq(meshNodes.id, nodeId))
      .run();

    this.logger.info({ nodeId, library: library.name, ...result }, 'node catalog ingested');
    return result;
  }

  private insert(libraryId: string, item: ReportedGame): void {
    const title = parseTitle(basename(item.relPath), item.kind === 'archive');
    const id = newId('gam');
    const now = new Date().toISOString();

    this.db
      .insert(games)
      .values({
        id,
        libraryId,
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
      })
      .run();

    this.replaceFiles(id, item.files);
  }

  /**
   * Swap a game's file rows, keeping any chunk hashes the node computed.
   *
   * The node has already read every byte to hash them, so carrying them across
   * here means the coordinator never has to — which matters rather a lot when
   * the coordinator has no copy of the file to read.
   */
  private replaceFiles(gameId: string, files: ReportedFile[]): void {
    this.db.transaction((tx) => {
      // Chunk rows cascade from the file rows, so this clears both.
      tx.delete(gameFiles).where(eq(gameFiles.gameId, gameId)).run();

      const rows = files.map((file) => ({
        id: newId('gfl'),
        gameId,
        relPath: file.relPath,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        sha256: file.sha256 ?? null,
        chunkedAt: file.chunks?.length ? new Date().toISOString() : null,
        chunkBytes: file.chunks?.length ? MESH_CHUNK_BYTES : null,
      }));

      for (const batch of batched(rows)) {
        tx.insert(gameFiles).values(batch).run();
      }

      const chunkRows = rows.flatMap((row, index) =>
        (files[index]?.chunks ?? []).map((piece) => ({
          fileId: row.id,
          chunkIndex: piece.index,
          sizeBytes: piece.sizeBytes,
          sha256: piece.sha256,
        })),
      );

      for (const batch of batched(chunkRows)) {
        tx.insert(gameFileChunks).values(batch).run();
      }
    });
  }

  /**
   * Flag what the node no longer has, without deleting it.
   *
   * A node that is mid-sync, or whose drive did not mount, reports a short
   * catalog. Deleting the difference would destroy hand-made metadata over a
   * temporary condition, so this marks and the operator decides.
   */
  private markMissing(
    libraryId: string,
    existing: Map<string, { relPath: string }>,
    seen: Set<string>,
  ): number {
    const vanished = [...existing.keys()].filter((relPath) => !seen.has(relPath));
    if (vanished.length === 0) return 0;

    for (const batch of batched(vanished, 400)) {
      this.db
        .update(games)
        .set({ missingAt: new Date().toISOString() })
        .where(
          and(
            eq(games.libraryId, libraryId),
            inArray(games.relPath, batch),
            isNull(games.missingAt),
          ),
        )
        .run();
    }

    return vanished.length;
  }
}

/** The last path segment, forward- or back-slashed. */
function basename(relPath: string): string {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? relPath;
}
