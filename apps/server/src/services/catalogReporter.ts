import { readFile } from 'node:fs/promises';
import type { ReportedFile, ReportedGame } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFileChunks, gameFiles, games } from '../db/schema.js';
import type { Logger } from './metadata/service.js';

/**
 * What a node keeps between restarts.
 *
 * Deliberately the same file, and the same field names, that the Rust mesh
 * agent reads. The two processes are one node: this one scans and reports, that
 * one serves bytes, and they have to agree about who they are. One of them
 * registers and writes this; the other reads it and does not register again.
 */
interface NodeState {
  secretKey?: string;
  nodeId?: string;
  nodeToken?: string;
  coordinatorKey?: string;
}

export interface ReporterConfig {
  coordinatorUrl: string;
  statePath: string;
  libraryId: string;
}

/**
 * The node half of the catalog: scan local disk, then tell the coordinator.
 *
 * This exists because the machine holding the games and the machine holding the
 * database stopped being the same machine. The scanner still runs exactly where
 * the files are — it has to, it reads them — and what changes is only where its
 * findings go: over HTTP to a coordinator instead of into a local table.
 *
 * The scan itself is untouched. Folder and archive detection, title parsing,
 * the nested-directory rules, the matcher's normalisation — all of it keeps
 * working the way it always has, on the same code, because reimplementing any
 * of that somewhere else would be a large amount of subtle behaviour to get
 * wrong for no gain.
 */
export class CatalogReporter {
  private state: NodeState = {};

  constructor(
    private readonly db: Db,
    private readonly config: ReporterConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Wait for the bundled QUIC agent to enrol and write the shared identity.
   * Only that process registers now; letting both the scanner and agent spend
   * the same one-time token was a race that could rotate credentials underneath
   * whichever process lost.
   */
  async ensureRegistered(): Promise<boolean> {
    await this.loadState();

    if (this.state.nodeId && this.state.nodeToken) return true;
    this.logger.info({}, 'waiting for the node agent to finish enrolment');
    return false;
  }

  /**
   * Send everything this node currently holds.
   *
   * Read back out of the local database the scanner just wrote, rather than
   * held in memory from the scan, so a report after a restart is as complete as
   * one straight after a scan.
   */
  async report(): Promise<boolean> {
    if (!this.state.nodeId || !this.state.nodeToken) return false;

    const payload = this.collect();

    try {
      const response = await fetch(`${this.config.coordinatorUrl}/api/mesh/catalog`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.state.nodeToken}`,
          'x-gameblade-node': this.state.nodeId,
        },
        body: JSON.stringify({ complete: true, games: payload }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.logger.error(
          { status: response.status, body: text.slice(0, 400) },
          'the coordinator refused this node’s catalog',
        );
        return false;
      }

      this.logger.info(
        { games: payload.length, ...((await response.json().catch(() => ({}))) as object) },
        'catalog reported',
      );
      return true;
    } catch (error) {
      this.logger.warn({ err: error }, 'could not reach the coordinator to report');
      return false;
    }
  }

  /**
   * Turn the local scan into the shape the coordinator accepts.
   *
   * No ids travel. The coordinator owns those and matches on relative path, so
   * that a game already in its database keeps the id it has and everything
   * attached to that id stays attached.
   */
  collect(): ReportedGame[] {
    const rows = this.db
      .select()
      .from(games)
      .where(eq(games.libraryId, this.config.libraryId))
      .all();
    const out: ReportedGame[] = [];

    for (const game of rows) {
      // A game the local scanner has flagged as gone is not something to
      // report as held.
      if (game.missingAt) continue;

      const files = this.db.select().from(gameFiles).where(eq(gameFiles.gameId, game.id)).all();

      const reportedFiles: ReportedFile[] = files.map((file) => {
        const chunks = this.db
          .select()
          .from(gameFileChunks)
          .where(eq(gameFileChunks.fileId, file.id))
          .orderBy(gameFileChunks.chunkIndex)
          .all();

        return {
          relPath: file.relPath,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          sha256: file.sha256,
          ...(chunks.length > 0
            ? {
                chunks: chunks.map((piece) => ({
                  index: piece.chunkIndex,
                  sha256: piece.sha256,
                  sizeBytes: piece.sizeBytes,
                })),
              }
            : {}),
        };
      });

      out.push({
        relPath: game.relPath,
        kind: game.kind,
        sizeBytes: game.sizeBytes,
        contentMtime: game.contentMtime ?? '',
        files: reportedFiles,
      });
    }

    return out;
  }

  private async loadState(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.config.statePath, 'utf8')) as NodeState;
    } catch {
      // No state is a first run, not a failure.
      this.state = {};
    }
  }
}
