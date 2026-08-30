import { readFile } from 'node:fs/promises';
import { MESH_CHUNK_BYTES, type ReportedFile, type ReportedGame } from '@gameblade/shared';
import { eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFileChunks, gameFiles, games, libraries } from '../db/schema.js';
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
  /** Written by the setup page, so a node can be pointed without a redeploy. */
  coordinatorUrl?: string;
  /** The one-time code, until the mesh agent spends it. */
  enrolmentToken?: string;
}

export interface ReporterConfig {
  /** From the environment, when an operator declared one. The state file wins otherwise. */
  coordinatorUrl: string | null;
  enrolmentToken: string | null;
  statePath: string;
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
   * Which coordinator to talk to, resolved per attempt rather than at boot.
   *
   * The environment wins where an operator set it. Otherwise it is whatever the
   * setup page wrote into the state file — which is the whole point of reading
   * it every time: a node that starts unconfigured must be able to become
   * configured without being restarted underneath the person configuring it.
   */
  private coordinatorUrl(): string | null {
    const configured = this.config.coordinatorUrl ?? this.state.coordinatorUrl ?? null;
    return configured ? configured.replace(/\/+$/, '') : null;
  }

  /** True once somebody has said where this node reports. */
  async isConfigured(): Promise<boolean> {
    await this.loadState();
    return this.coordinatorUrl() !== null;
  }

  /** Wait for the mesh agent beside this process to finish enrolment. */
  async ensureRegistered(): Promise<boolean> {
    await this.loadState();

    if (this.state.nodeId && this.state.nodeToken) return true;

    const coordinatorUrl = this.coordinatorUrl();
    if (!coordinatorUrl) {
      this.logger.info({}, 'no coordinator set yet; waiting for this node’s setup page');
      return false;
    }

    if (!(this.config.enrolmentToken ?? this.state.enrolmentToken)) {
      this.logger.warn(
        {},
        'no enrolment code and no saved registration; paste one into this node’s setup page',
      );
      return false;
    }

    if (!this.state.secretKey) {
      this.logger.info({}, 'waiting for the mesh agent to generate this node’s key');
      return false;
    }

    // Only the Rust agent registers. Both processes used to race the same
    // one-time code and then rotate each other's node token; whichever stale
    // write landed last left catalog reporting broken until the next restart.
    // The agent is also the process that owns and proves the private key, so it
    // is the one authoritative registrar. This loop rereads what it writes.
    this.logger.info({}, 'waiting for the mesh agent to finish enrolment');
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
    const coordinatorUrl = this.coordinatorUrl();
    if (!coordinatorUrl || !this.state.nodeId || !this.state.nodeToken) return false;

    const payload = this.collect();

    try {
      const response = await fetch(`${coordinatorUrl}/api/mesh/catalog`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.state.nodeToken}`,
          'x-gameblade-node': this.state.nodeId,
        },
        body: JSON.stringify({ complete: true, games: payload }),
      });

      /*
       * A rejected credential is recoverable, and used to be permanent.
       *
       * The mesh agent beside this process re-registers when its own heartbeat
       * is refused, which rotates the token in the state file — so the copy
       * held here goes stale in the ordinary course of things, not only when
       * something is wrong. Rereading the file is the whole fix: the agent has
       * already put a working credential in it. Anything else — a node deleted
       * and re-enrolled, a token rotated elsewhere — resolves the same way
       * within one heartbeat, without a restart and without anybody noticing.
       */
      if (response.status === 401 || response.status === 403) {
        this.logger.warn(
          { status: response.status },
          'the coordinator rejected this node’s credential; rereading the state file',
        );
        await this.loadState();
        return false;
      }

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
   * Take the hashes the coordinator already has, instead of computing them.
   *
   * A node's first act after pairing is otherwise to read every byte of every
   * game it holds, which on a real archive is hours during which nothing it
   * has is servable. Most of that is often wasted: a coordinator split off a
   * standalone server, or one that already had another node holding the same
   * games, has the hashes already — and they are hashes of file *contents*,
   * so a copy that matches is described by them exactly.
   *
   * Matched on relative path and then checked file by file on size. Anything
   * that does not line up is left alone and hashed locally in the ordinary
   * way, because adopting hashes for bytes this machine does not actually have
   * would mean advertising a game and then failing every chunk of it.
   *
   * Returns how many games it could skip.
   */
  async adoptKnownHashes(): Promise<{ adopted: number; checked: number }> {
    await this.loadState();
    const coordinatorUrl = this.coordinatorUrl();
    if (!coordinatorUrl || !this.state.nodeId || !this.state.nodeToken) {
      return { adopted: 0, checked: 0 };
    }

    const headers = {
      authorization: `Bearer ${this.state.nodeToken}`,
      'x-gameblade-node': this.state.nodeId,
    };

    const listed = await fetch(`${coordinatorUrl}/api/mesh/catalog`, { headers });
    if (!listed.ok) return { adopted: 0, checked: 0 };

    const body = (await listed.json()) as {
      games?: { gameId: string; relPath: string }[];
    };
    const known = body.games ?? [];
    if (known.length === 0) return { adopted: 0, checked: 0 };

    // Only games this node holds and has not hashed yet are worth asking about,
    // keyed the way the coordinator knows them — prefixed for every library
    // but the first, exactly as `collect` reports them.
    const prefixes = this.pathPrefixes();
    const mine = new Map(
      this.db
        .select({ id: games.id, relPath: games.relPath, libraryId: games.libraryId })
        .from(games)
        .where(isNull(games.missingAt))
        .all()
        .map((game) => [`${prefixes.get(game.libraryId) ?? ''}${game.relPath}`, game.id]),
    );

    let adopted = 0;
    let checked = 0;

    for (const candidate of known) {
      const localId = mine.get(candidate.relPath);
      if (!localId) continue;
      checked += 1;

      const localFiles = this.db
        .select()
        .from(gameFiles)
        .where(eq(gameFiles.gameId, localId))
        .all();
      if (localFiles.length === 0) continue;
      // Already hashed here; nothing to take.
      if (localFiles.every((file) => file.chunkBytes === MESH_CHUNK_BYTES)) continue;

      const detail = await fetch(
        `${coordinatorUrl}/api/mesh/catalog/${encodeURIComponent(candidate.gameId)}`,
        { headers },
      );
      if (!detail.ok) continue;

      const remote = (await detail.json()) as {
        files?: {
          path: string;
          sizeBytes: number;
          sha256: string | null;
          chunks?: { index: number; sha256: string; sizeBytes: number }[];
        }[];
      };

      const byPath = new Map((remote.files ?? []).map((file) => [file.path, file]));

      // All or nothing per game: a half-adopted game is one the node would
      // announce and then refuse pieces of.
      const usable = localFiles.every((file) => {
        const match = byPath.get(file.relPath);
        return Boolean(match && match.sizeBytes === file.sizeBytes && match.chunks?.length);
      });
      if (!usable) continue;

      this.db.transaction((tx) => {
        for (const file of localFiles) {
          const match = byPath.get(file.relPath)!;
          tx.delete(gameFileChunks).where(eq(gameFileChunks.fileId, file.id)).run();
          for (const piece of match.chunks ?? []) {
            tx.insert(gameFileChunks)
              .values({
                fileId: file.id,
                chunkIndex: piece.index,
                sizeBytes: piece.sizeBytes,
                sha256: piece.sha256,
              })
              .run();
          }
          tx.update(gameFiles)
            .set({
              sha256: match.sha256 ?? file.sha256,
              chunkedAt: new Date().toISOString(),
              chunkBytes: MESH_CHUNK_BYTES,
            })
            .where(eq(gameFiles.id, file.id))
            .run();
        }
      });

      adopted += 1;
    }

    if (adopted > 0) {
      this.logger.info(
        { adopted, checked },
        'took chunk hashes the coordinator already had, instead of re-reading those games',
      );
    }

    return { adopted, checked };
  }

  /**
   * What each of this node's libraries prefixes its paths with, upstream.
   *
   * A node's libraries all arrive in *one* library on the coordinator, so two
   * roots each holding a `Hollow Knight` folder would be one row there and
   * each report would fight the other over what it contains. Prefixing the
   * path with the library's name settles it.
   *
   * The oldest library is deliberately left unprefixed. Changing the path of a
   * game that has already been reported makes it a stranger: the coordinator
   * would add the whole catalog again as new games and orphan every
   * achievement, save rule, artwork match and playtime record attached to the
   * originals. A node has always had one root, so that root's paths must keep
   * the shape they were first reported in — mounting a second drive is then a
   * thing that adds games rather than one that re-adds all of them.
   *
   * Ordered by creation and then by path, so the answer does not depend on the
   * order SQLite happens to return rows in.
   */
  private pathPrefixes(): Map<string, string> {
    const roots = this.db
      .select({ id: libraries.id, name: libraries.name })
      .from(libraries)
      .orderBy(libraries.createdAt, libraries.path)
      .all();

    const prefixes = new Map<string, string>();
    for (const root of roots.slice(1)) {
      prefixes.set(root.id, `${sanitiseSegment(root.name)}/`);
    }
    return prefixes;
  }

  /**
   * Turn the local scan into the shape the coordinator accepts.
   *
   * No ids travel. The coordinator owns those and matches on relative path, so
   * that a game already in its database keeps the id it has and everything
   * attached to that id stays attached.
   */
  collect(): ReportedGame[] {
    const rows = this.db.select().from(games).all();
    const out: ReportedGame[] = [];
    const prefixes = this.pathPrefixes();

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
        relPath: `${prefixes.get(game.libraryId) ?? ''}${game.relPath}`,
        kind: game.kind,
        sizeBytes: game.sizeBytes,
        /*
         * Never empty, because a report is all or nothing.
         *
         * An empty folder in a library scans as a game with no files, and its
         * fingerprint is the newest of no modification times — the empty
         * string. Sent as it was, the coordinator refused the *whole* report
         * as malformed, so one stray directory meant a node that enrolled,
         * heartbeated and reported every five minutes while none of its
         * catalog ever arrived, saying so only in a log nobody reads. Rows
         * predating the column are null and did the same.
         *
         * The fallback is a real timestamp this node already holds, so the
         * game is described accurately rather than dropped.
         */
        contentMtime: game.contentMtime || game.scannedAt || game.updatedAt,
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

/**
 * A library name reduced to something safe to put in a path.
 *
 * These become part of a relative path that is compared, stored and shown, so
 * a slash or a run of dots in a library's name would change the shape of it
 * rather than just its text.
 */
function sanitiseSegment(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .trim();
  return cleaned || 'library';
}
