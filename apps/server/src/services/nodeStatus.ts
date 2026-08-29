import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { gameFiles, games, libraries } from '../db/schema.js';
import { VERSION } from '../lib/version.js';

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
  nodeId: string | null;
  /** Whether the mesh agent has generated this node's key yet. */
  keyPresent: boolean;
  libraries: { name: string; path: string; games: number; lastScanAt: string | null }[];
  configuredPaths: string[];
  games: number;
  /** Files with per-chunk hashes; only these can be served over the mesh. */
  hashedFiles: number;
  totalFiles: number;
  scanning: boolean;
  lastReport: ReportAttempt | null;
  startedAt: string;
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
    private readonly scanner: { readonly isRunning: boolean },
  ) {}

  /** Called by the reporter loop after every attempt, successful or not. */
  record(attempt: Omit<ReportAttempt, 'at'>): void {
    this.lastReport = { at: new Date().toISOString(), ...attempt };
  }

  async snapshot(): Promise<NodeStatusSnapshot> {
    const state = await this.readState();

    const rows = this.db.select().from(libraries).all();
    const counts = this.db
      .select({ libraryId: games.libraryId, n: sql<number>`count(*)` })
      .from(games)
      .groupBy(games.libraryId)
      .all();
    const byLibrary = new Map(counts.map((row) => [row.libraryId, Number(row.n)]));

    const files = this.db
      .select({
        total: sql<number>`count(*)`,
        hashed: sql<number>`sum(case when ${gameFiles.chunkedAt} is not null then 1 else 0 end)`,
      })
      .from(gameFiles)
      .get();

    return {
      version: VERSION,
      role: this.config.role,
      // The environment when an operator declared one, else whatever setup
      // wrote — the same order the reporter and the agent resolve it in.
      coordinatorUrl: this.config.coordinatorUrl ?? state.coordinatorUrl ?? null,
      enrolled: Boolean(state.nodeId),
      configured: Boolean(this.config.coordinatorUrl ?? state.coordinatorUrl),
      enrolmentPending: Boolean(state.enrolmentToken),
      nodeId: state.nodeId ?? null,
      keyPresent: Boolean(state.secretKey),
      libraries: rows.map((library) => ({
        name: library.name,
        path: library.path,
        games: byLibrary.get(library.id) ?? 0,
        lastScanAt: library.lastScanAt,
      })),
      configuredPaths: this.config.libraryPaths,
      games: [...byLibrary.values()].reduce((sum, n) => sum + n, 0),
      hashedFiles: Number(files?.hashed ?? 0),
      totalFiles: Number(files?.total ?? 0),
      scanning: this.scanner.isRunning,
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
