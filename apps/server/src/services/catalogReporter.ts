import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
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
  /** Written by the setup page, so a node can be pointed without a redeploy. */
  coordinatorUrl?: string;
  /** The one-time code, until whichever process registers first spends it. */
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

  /**
   * Enrol with the coordinator, or recover the enrolment from last time.
   *
   * The code is spent on first use, so it is normal — and expected — for it to
   * be absent from the environment after the first run. What identifies this
   * node afterwards is the key in the state file.
   */
  async ensureRegistered(): Promise<boolean> {
    await this.loadState();

    if (this.state.nodeId && this.state.nodeToken) return true;

    const coordinatorUrl = this.coordinatorUrl();
    if (!coordinatorUrl) {
      this.logger.info({}, 'no coordinator set yet; waiting for this node’s setup page');
      return false;
    }

    const enrolmentToken = this.config.enrolmentToken ?? this.state.enrolmentToken ?? null;
    if (!enrolmentToken) {
      this.logger.warn(
        {},
        'no enrolment code and no saved registration; paste one into this node’s setup page',
      );
      return false;
    }

    // The mesh agent alongside this process owns the keypair. If it has not
    // started yet there is nothing to register with, so wait rather than
    // generating a second identity for the same node.
    if (!this.state.secretKey) {
      this.logger.info({}, 'waiting for the mesh agent to generate this node’s key');
      return false;
    }

    try {
      const response = await fetch(`${coordinatorUrl}/api/mesh/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enrolmentToken,
          publicKey: await this.publicKey(),
          endpoints: [],
        }),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status },
          'the coordinator refused this node’s enrolment',
        );
        return false;
      }

      const body = (await response.json()) as {
        nodeId: string;
        nodeToken: string;
        coordinatorPublicKey: string;
      };

      this.state.nodeId = body.nodeId;
      this.state.nodeToken = body.nodeToken;
      this.state.coordinatorKey = body.coordinatorPublicKey;
      // Spent, and remembered: the code is of no further use and the URL is
      // how this node finds its way back after a restart.
      delete this.state.enrolmentToken;
      this.state.coordinatorUrl = coordinatorUrl;
      await this.saveState();

      this.logger.info({ nodeId: body.nodeId }, 'node enrolled with the coordinator');
      return true;
    } catch (error) {
      this.logger.warn({ err: error }, 'could not reach the coordinator to enrol');
      return false;
    }
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
   * Turn the local scan into the shape the coordinator accepts.
   *
   * No ids travel. The coordinator owns those and matches on relative path, so
   * that a game already in its database keeps the id it has and everything
   * attached to that id stays attached.
   */
  collect(): ReportedGame[] {
    const rows = this.db.select().from(games).all();
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

  private async saveState(): Promise<void> {
    await mkdir(path.dirname(this.config.statePath), { recursive: true });
    await writeFile(this.config.statePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  /** The public half of the key the mesh agent generated. */
  private async publicKey(): Promise<string> {
    const { createPrivateKey, createPublicKey } = await import('node:crypto');
    const secret = Buffer.from(this.state.secretKey ?? '', 'base64url');

    // Ed25519 secret keys wrap into PKCS#8 behind a fixed sixteen-byte prefix.
    // Building it here avoids a dependency for what is a constant.
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret]);

    const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    // The raw 32 bytes are the tail of the SPKI encoding, which is what the
    // coordinator and the mesh agent both exchange.
    return createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .subarray(12)
      .toString('base64url');
  }
}
