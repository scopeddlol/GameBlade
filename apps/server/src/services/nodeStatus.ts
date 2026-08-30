import { readFile, stat } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import type { ScanProgress } from '@gameblade/shared';
import { MULTI_LIBRARY_ROOT, type Config } from '../config.js';
import type { Db } from '../db/index.js';
import { gameFiles, games, libraries } from '../db/schema.js';
import { VERSION } from '../lib/version.js';
import type { ChunkProgress, SweepProgress } from './chunks.js';

/**
 * What the node agent beside this process wrote about itself.
 *
 * Read rather than held: the two processes are one node and the file is how
 * they agree about that. The secret key is deliberately never read out of it
 * here — nothing on this page needs it, and a status endpoint is the last place
 * a private key should be able to reach.
 */
interface NodeStateFile {
  nodeId?: string;
  coordinatorKey?: string;
  secretKey?: string;
  coordinatorUrl?: string;
  enrolmentToken?: string;
  registrationError?: string;
}

export interface ReportAttempt {
  at: string;
  ok: boolean;
  games: number;
  detail: string;
}

export interface NodeStatusSnapshot {
  version: string;
  role: string;
  coordinatorUrl: string | null;
  /** True once this node has a saved registration, whatever it does next. */
  enrolled: boolean;
  /**
   * Whether somebody has answered the two questions setup asks.
   *
   * Distinct from `enrolled`: a node can be configured and not yet enrolled
   * (the coordinator is down, the code was wrong) and the page has to tell
   * those apart, because they are fixed differently.
   */
  configured: boolean;
  /** Whether a code is sitting in the state file waiting to be spent. */
  enrolmentPending: boolean;
  /** The mesh agent's last failed registration attempt, if any. */
  enrolmentError: string | null;
  nodeId: string | null;
  /** Whether the mesh agent has generated this node's key yet. */
  keyPresent: boolean;
  libraries: NodeLibrary[];
  configuredPaths: string[];
  /** Whether the roots above were read off the mounts rather than declared. */
  pathsDiscovered: boolean;
  /** Where a second, third or fourth library is mounted on this image. */
  multiLibraryRoot: string;
  games: number;
  /** Files with per-chunk hashes; only these can be served over the mesh. */
  hashedFiles: number;
  totalFiles: number;
  /** Games every file of which is hashed — the ones that can actually be served. */
  servableGames: number;
  bytes: number;
  scanning: boolean;
  scan: ScanProgress;
  hashing: SweepProgress;
  /**
   * The game being hashed right now, file by file.
   *
   * The sweep above counts games; this says which one and which of its files
   * are open, which is the difference between a bar that moves once an hour
   * and a page you can tell is alive.
   */
  hashingGame: ChunkProgress;
  lastReport: ReportAttempt | null;
  startedAt: string;
}

/** One library root, as this node currently sees it. */
export interface NodeLibrary {
  id: string;
  name: string;
  path: string;
  games: number;
  bytes: number;
  lastScanAt: string | null;
  lastScanStatus: string | null;
  /**
   * Whether the path is a readable directory right now.
   *
   * The one thing worth saying about a library that the counts cannot: a drive
   * that did not mount looks exactly like a drive with nothing on it.
   */
  mounted: boolean;
  /** False while a root is unmounted, which is what makes the scanner skip it. */
  enabled: boolean;
}

/**
 * What a node knows about itself, for the page it serves about itself.
 *
 * A node has no admin panel and should not have one — it owns no accounts, no
 * settings and no catalog of record. What it does own is the answer to the only
 * question anybody stands in front of a node to ask: is this thing working?
 * That means whether it found its files, whether it reached the coordinator,
 * and when it last said anything. Before this, answering that meant reading
 * container logs.
 */
export class NodeStatusService {
  private lastReport: ReportAttempt | null = null;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly scanner: { readonly isRunning: boolean; getProgress(): ScanProgress },
    private readonly chunks: {
      getSweepProgress(): SweepProgress;
      getProgress(): ChunkProgress;
    },
  ) {}

  /** Called by the reporter loop after every attempt, successful or not. */
  record(attempt: Omit<ReportAttempt, 'at'>): void {
    this.lastReport = { at: new Date().toISOString(), ...attempt };
  }

  async snapshot(): Promise<NodeStatusSnapshot> {
    const state = await this.readState();

    const rows = this.db.select().from(libraries).all();
    const counts = this.db
      .select({
        libraryId: games.libraryId,
        n: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${games.sizeBytes}), 0)`,
      })
      .from(games)
      .groupBy(games.libraryId)
      .all();
    const byLibrary = new Map(counts.map((row) => [row.libraryId, row]));

    const files = this.db
      .select({
        total: sql<number>`count(*)`,
        hashed: sql<number>`sum(case when ${gameFiles.chunkedAt} is not null then 1 else 0 end)`,
      })
      .from(gameFiles)
      .get();

    /*
     * Games every one of whose files is hashed.
     *
     * The file counts above say how much work is left; this says how much of
     * the library is actually on offer, which is the number an operator is
     * really asking about. A game is all-or-nothing over the mesh, so one
     * unhashed file in a thousand makes the whole game unservable — and that is
     * invisible in a files-hashed percentage sitting at 99.9%.
     */
    const servable = this.db
      .select({ n: sql<number>`count(*)` })
      .from(
        this.db
          .select({ gameId: gameFiles.gameId })
          .from(gameFiles)
          .groupBy(gameFiles.gameId)
          .having(sql`sum(case when ${gameFiles.chunkedAt} is null then 1 else 0 end) = 0`)
          .as('complete'),
      )
      .get();

    const mounted = await Promise.all(
      rows.map(async (library) => {
        const info = await stat(library.path).catch(() => null);
        return Boolean(info?.isDirectory());
      }),
    );

    return {
      version: VERSION,
      role: this.config.role,
      // The environment when an operator declared one, else whatever setup
      // wrote — the same order the reporter and the agent resolve it in.
      coordinatorUrl: this.config.coordinatorUrl ?? state.coordinatorUrl ?? null,
      enrolled: Boolean(state.nodeId),
      configured: Boolean(this.config.coordinatorUrl ?? state.coordinatorUrl),
      enrolmentPending: Boolean(state.enrolmentToken),
      enrolmentError: state.registrationError ?? null,
      nodeId: state.nodeId ?? null,
      keyPresent: Boolean(state.secretKey),
      libraries: rows.map((library, index) => ({
        id: library.id,
        name: library.name,
        path: library.path,
        games: Number(byLibrary.get(library.id)?.n ?? 0),
        bytes: Number(byLibrary.get(library.id)?.bytes ?? 0),
        lastScanAt: library.lastScanAt,
        lastScanStatus: library.lastScanStatus,
        mounted: mounted[index] ?? false,
        enabled: library.enabled,
      })),
      configuredPaths: this.config.libraryPaths,
      pathsDiscovered: this.config.libraryPathsDiscovered,
      multiLibraryRoot: MULTI_LIBRARY_ROOT,
      games: [...byLibrary.values()].reduce((sum, row) => sum + Number(row.n), 0),
      hashedFiles: Number(files?.hashed ?? 0),
      totalFiles: Number(files?.total ?? 0),
      servableGames: Number(servable?.n ?? 0),
      bytes: [...byLibrary.values()].reduce((sum, row) => sum + Number(row.bytes), 0),
      scanning: this.scanner.isRunning,
      scan: this.scanner.getProgress(),
      hashing: this.chunks.getSweepProgress(),
      hashingGame: this.chunks.getProgress(),
      lastReport: this.lastReport,
      startedAt: this.startedAt,
    };
  }

  /**
   * Read the shared state file, treating every failure as "not yet".
   *
   * A node that has not enrolled has no file at all, and one whose agent is
   * still starting has a partial one. Neither is an error worth surfacing as
   * one — the page says "waiting" and means it.
   */
  private async readState(): Promise<NodeStateFile> {
    try {
      const raw = await readFile(this.config.nodeStatePath, 'utf8');
      return JSON.parse(raw) as NodeStateFile;
    } catch {
      return {};
    }
  }
}
