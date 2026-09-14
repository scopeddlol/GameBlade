import { createHash, createPublicKey, verify as verifyBytes } from 'node:crypto';
import {
  MESH_CHUNK_BYTES,
  MESH_DIRECT_CHUNK_PATH,
  MESH_DIRECT_PROBE_PATH,
  MESH_HEARTBEAT_TIMEOUT_SECONDS,
  MESH_MAX_SOURCES_PER_GAME,
  type DeliveryGrantClaims,
  type MeshAnalytics,
  type MeshDailyPoint,
  type MeshEndpoint,
  type MeshNodeInfo,
  type MeshNodeRole,
  type MeshNodeStats,
  type MeshSource,
  type GameCopy,
  type SourceProbeReport,
} from '@gameblade/shared';
import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  downloadEvents,
  gameFiles,
  games,
  libraries,
  meshEnrollments,
  meshNodeEndpoints,
  meshNodeGames,
  meshNodes,
  meshSourceProbes,
  meshTransfers,
  users,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { hashToken, newId, newToken, safeEqual } from '../lib/ids.js';
import type { Logger } from './metadata/service.js';

/** The handle drizzle hands a transaction body. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** How long an unused enrolment code stays good for. */
const ENROLMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** A proof challenge is useful only for the request immediately following it. */
const REGISTRATION_CHALLENGE_TTL_MS = 60_000;

/** An idle Node should either claim queued work promptly or let another holder try. */
const NODE_CHUNK_CLAIM_TIMEOUT_MS = 15_000;

/** Once claimed, allow slow disks and modest uplinks time to deliver a full chunk. */
const NODE_CHUNK_DELIVERY_TIMEOUT_MS = 5 * 60_000;

/** Enough work to keep several HTTPS uploads full without flooding one node. */
const NODE_CHUNK_POLL_BATCH = 8;

/**
 * How long a client's measurement of a source is worth anything.
 *
 * A week. Links change, nodes move, and an order built on a measurement from
 * last spring is worse than no order at all — but re-measuring on every
 * download would spend a few seconds of everybody's transfer proving what did
 * not change.
 */
const PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How a download that never touched the Coordinator is labelled in the event
 * log.
 *
 * It is recorded there so monthly allowances still count it, and excluded from
 * "bytes the Coordinator served" wherever that number is reported — which is
 * the whole reason the distinction exists.
 */
export const DIRECT_CLIENT = 'desktop-direct';

/**
 * What to write for a node's advertised address, given what it just said.
 *
 * Three cases, and the difference between the last two is the point: a node
 * that says nothing is an older agent and keeps whatever it advertised before;
 * a node that sends an empty string is saying it no longer has an address, and
 * leaving the old one there would send every client to a port that stopped
 * answering.
 */
function directAddress(
  reported: string | undefined,
  current: string | null,
): { publicUrl?: string | null } {
  if (reported === undefined) return {};
  const clean = reported.trim().replace(/\/+$/, '');
  if (clean === '') return current === null ? {} : { publicUrl: null };
  return { publicUrl: clean };
}

export interface NodeChunkJob {
  requestId: string;
  gameId: string;
  fileId: string;
  chunkIndex: number;
  expectedBytes: number;
  sha256: string;
}

export interface ProxiedChunk {
  bytes: Buffer;
  nodeId: string;
  nodeLabel: string;
}

/**
 * One machine that can serve a particular set of bytes, addressed in its own ids.
 *
 * `gameId` and `fileId` are the copy *this* node holds. One catalog entry can
 * be held by several machines as several rows — that is what a merged entry
 * is — and a node only knows its own. Addressing a request in another node's
 * ids is how a request for a game a machine is holding comes back "not found".
 */
export interface DeliveryHolder {
  nodeId: string;
  label: string;
  role: MeshNodeRole;
  gameId: string;
  fileId: string;
  /** Where a client may fetch straight from this node, when it has an address. */
  publicUrl: string | null;
  lastSeenAt: string | null;
}

/**
 * How one catalog entry can actually be delivered right now.
 *
 * The entry may have copies on several machines. Those copies are usually the
 * same bytes — a file that was moved — but they need not be, and chunks from
 * two different packages must never be mixed into one download. So a plan
 * settles on **one** package: the fingerprint the most online machines agree
 * on, the copy whose chunk table describes it, and every holder of it.
 */
export interface DeliveryPlan {
  /** The catalog entry the client asked about. */
  entryGameId: string;
  /** The copy whose file and chunk hashes this download is described by. */
  gameId: string;
  fileId: string;
  sizeBytes: number;
  modifiedAt: string;
  sha256: string | null;
  /** What every holder in this plan agrees the package is. */
  contentHash: string | null;
  holders: DeliveryHolder[];
}

interface PendingNodeChunk extends NodeChunkJob {
  nodeId: string;
  nodeLabel: string;
  userId: string;
  queuedAt: string;
  resolve: (chunk: ProxiedChunk) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** The exact bytes both implementations sign when a known node comes back. */
export function registrationProofMessage(publicKey: string, challenge: string): string {
  return `gameblade-register-v1:${publicKey}:${challenge}`;
}

export interface RegisterInput {
  enrolmentToken?: string;
  publicKey: string;
  agentVersion?: string;
  endpoints: MeshEndpoint[];
  proof?: { challenge: string; signature: string };
  /** What the coordinator saw the registration arrive from. */
  observedAddress?: string;
  /** Where clients may reach this node directly; empty string retracts one. */
  publicUrl?: string;
}

export interface HeartbeatInput {
  nodeId: string;
  endpoints: MeshEndpoint[];
  observedAddress?: string;
  /** Games this node currently holds a complete, verified copy of. */
  games?: { gameId: string; contentHash: string }[];
  /** Where clients may reach this node directly; empty string retracts one. */
  publicUrl?: string;
}

/**
 * The coordinator: who the nodes are, how to reach them, and what they hold.
 *
 * Everything here is deliberately small. This runs on a VPS with 75 GB and a
 * thin pipe, so it keeps keys, addresses and counters and never a byte of game
 * data. That is the whole point of the split — coordination is kilobytes, and
 * the bandwidth problem it exists to solve is measured in terabytes.
 *
 * Nothing in this service is trusted to be true. A node's claim to hold a game
 * is a hint for choosing who to ask, not a guarantee; the chunk hashes decide
 * whether arriving bytes are real. That is what lets a node be enrolled without
 * the decision being a security judgement.
 */
export class MeshService {
  /** One outstanding proof challenge per known key; replaced and consumed once. */
  private readonly registrationChallenges = new Map<
    string,
    { challenge: string; expiresAt: number }
  >();

  /** Short-lived HTTPS work waiting for an outbound-connected node. */
  private readonly nodeChunkQueues = new Map<string, string[]>();
  private readonly pendingNodeChunks = new Map<string, PendingNodeChunk>();
  private readonly nodeChunkWaiters = new Map<string, (() => void)[]>();
  private nextNode = 0;

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /* --------------------------------------------------------------- enrolment */

  /**
   * Ask a known node to prove it still holds the private half of its key.
   *
   * The public half is deliberately given to clients, so merely repeating it
   * can never authenticate a node. A short-lived, one-use challenge turns the
   * existing Ed25519 identity into an actual proof without keeping another
   * long-lived secret on the node.
   */
  createRegistrationChallenge(publicKey: string): {
    challenge: string;
    expiresAt: string;
  } {
    const node = this.db.select().from(meshNodes).where(eq(meshNodes.publicKey, publicKey)).get();
    if (!node) throw ApiError.notFound('That node key is not registered');
    if (node.status === 'blocked') {
      throw ApiError.forbidden('This node has been blocked by an administrator');
    }

    const challenge = newToken(32);
    const expiresAt = Date.now() + REGISTRATION_CHALLENGE_TTL_MS;
    this.registrationChallenges.set(publicKey, { challenge, expiresAt });
    return { challenge, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Mint a one-time code that turns a machine into a node.
   *
   * Returned in plaintext exactly once. Only the hash is stored, so an operator
   * who loses the code generates another rather than recovering it — the same
   * posture as every other credential in this system.
   */
  createEnrolment(options: {
    label: string;
    role: MeshNodeRole;
    createdBy: string;
    /** An existing library to take over, instead of getting a new one. */
    libraryId?: string | null;
  }): {
    token: string;
    expiresAt: string;
  } {
    const token = newToken(24);
    const expiresAt = new Date(Date.now() + ENROLMENT_TTL_MS).toISOString();

    if (options.libraryId) {
      const library = this.db
        .select({ id: libraries.id })
        .from(libraries)
        .where(eq(libraries.id, options.libraryId))
        .get();
      if (!library) throw ApiError.notFound('That library does not exist');
    }

    this.db
      .insert(meshEnrollments)
      .values({
        tokenHash: hashToken(token),
        label: options.label,
        role: options.role,
        createdBy: options.createdBy,
        libraryId: options.libraryId ?? null,
        expiresAt,
      })
      .run();

    return { token, expiresAt };
  }

  /**
   * The library a newly enrolled node reports into.
   *
   * Made here rather than asked of an operator. A node's catalog has to land
   * somewhere and a coordinator holds no files, so "create a library, give it a
   * path that does not exist on this machine, then come back and assign it"
   * was three steps of ceremony around a decision with one sensible answer —
   * and until all three were done the node reported into nothing and said so
   * only in a log.
   *
   * The path is synthetic and derived from the node id, because it is a label:
   * nothing on a coordinator ever reads through it, it only has to be unique
   * and to say what it belongs to when somebody reads the libraries list.
   */
  private libraryForNewNode(tx: Tx, nodeId: string, label: string): string {
    const libraryId = newId('lib');
    tx.insert(libraries)
      .values({
        id: libraryId,
        name: label,
        path: `/nodes/${nodeId}`,
        enabled: true,
        createdAt: new Date().toISOString(),
      })
      .run();
    return libraryId;
  }

  listEnrolments() {
    return this.db
      .select()
      .from(meshEnrollments)
      .orderBy(desc(meshEnrollments.createdAt))
      .limit(50)
      .all()
      .map((row) => ({
        tokenHash: row.tokenHash,
        label: row.label,
        role: row.role,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        usedAt: row.usedAt,
        nodeId: row.nodeId,
      }));
  }

  revokeEnrolment(tokenHash: string): void {
    this.db.delete(meshEnrollments).where(eq(meshEnrollments.tokenHash, tokenHash)).run();
  }

  renameNode(nodeId: string, label: string): void {
    const clean = label.trim();
    if (!clean) throw ApiError.badRequest('Give the Node a name');
    if (clean.length > 80) throw ApiError.badRequest('Node names cannot exceed 80 characters');
    const updated = this.db
      .update(meshNodes)
      .set({ label: clean })
      .where(eq(meshNodes.id, nodeId))
      .run();
    if ((updated.changes ?? 0) === 0) throw ApiError.notFound('Node not found');
  }

  /**
   * Turn an enrolment code into a node.
   *
   * A code is spent on first use even if the same machine registers again
   * later: re-registering is what the node's own key is for. Reusing a code
   * would mean a leaked one stays useful indefinitely.
   *
   * Registering with a key that already exists is a re-registration, not a
   * conflict — an agent that lost its local state and still holds its key is
   * the same node, and refusing it would strand a working mirror.
   */
  register(input: RegisterInput): { nodeId: string; status: string; nodeToken: string } {
    const existing = this.db
      .select()
      .from(meshNodes)
      .where(eq(meshNodes.publicKey, input.publicKey))
      .get();

    if (existing) {
      if (existing.status === 'blocked') {
        throw ApiError.forbidden('This node has been blocked by an administrator');
      }
      if (!input.proof || !this.consumeRegistrationProof(input.publicKey, input.proof)) {
        throw ApiError.forbidden('Prove possession of this node’s private key to re-register it');
      }
      this.applyEndpoints(existing.id, input.endpoints, input.observedAddress);

      // A fresh credential on every registration. An agent re-registering is
      // one that lost its local state, so the old token is either gone or
      // leaked; either way it should stop working.
      const nodeToken = newToken(24);
      this.db
        .update(meshNodes)
        .set({
          status: 'online',
          tokenHash: hashToken(nodeToken),
          agentVersion: input.agentVersion ?? existing.agentVersion,
          lastSeenAt: new Date().toISOString(),
          ...directAddress(input.publicUrl, existing.publicUrl),
        })
        .where(eq(meshNodes.id, existing.id))
        .run();
      return { nodeId: existing.id, status: 'online', nodeToken };
    }

    if (!input.enrolmentToken) {
      throw ApiError.forbidden('A new node needs an enrolment code');
    }

    const enrolment = this.db
      .select()
      .from(meshEnrollments)
      .where(eq(meshEnrollments.tokenHash, hashToken(input.enrolmentToken)))
      .get();

    if (!enrolment) throw ApiError.forbidden('That enrolment code is not valid');
    if (enrolment.usedAt) throw ApiError.forbidden('That enrolment code has already been used');
    if (Date.parse(enrolment.expiresAt) <= Date.now()) {
      throw ApiError.forbidden('That enrolment code has expired');
    }

    const nodeId = newId('nod');
    const nodeToken = newToken(24);
    const now = new Date().toISOString();

    this.db.transaction((tx) => {
      // The code said where to report, or this node gets somewhere of its own.
      // Either way it is decided here, so a node is never enrolled and idle
      // waiting for somebody to finish setting it up.
      const libraryId = enrolment.libraryId ?? this.libraryForNewNode(tx, nodeId, enrolment.label);

      tx.insert(meshNodes)
        .values({
          id: nodeId,
          label: enrolment.label,
          role: enrolment.role,
          status: 'online',
          publicKey: input.publicKey,
          tokenHash: hashToken(nodeToken),
          agentVersion: input.agentVersion ?? null,
          libraryId,
          lastSeenAt: now,
          ...directAddress(input.publicUrl, null),
        })
        .run();

      tx.update(meshEnrollments)
        .set({ usedAt: now, nodeId })
        .where(eq(meshEnrollments.tokenHash, enrolment.tokenHash))
        .run();
    });

    this.applyEndpoints(nodeId, input.endpoints, input.observedAddress);
    this.logger.info({ nodeId, label: enrolment.label }, 'mesh node enrolled');
    return { nodeId, status: 'online', nodeToken };
  }

  /** Consume and verify one proof challenge. It cannot be replayed. */
  private consumeRegistrationProof(
    publicKey: string,
    proof: { challenge: string; signature: string },
  ): boolean {
    const expected = this.registrationChallenges.get(publicKey);
    this.registrationChallenges.delete(publicKey);

    if (
      !expected ||
      expected.expiresAt <= Date.now() ||
      !safeEqual(expected.challenge, proof.challenge)
    ) {
      return false;
    }

    try {
      const raw = Buffer.from(publicKey, 'base64url');
      if (raw.length !== 32) return false;

      // Ed25519 SubjectPublicKeyInfo is a fixed twelve-byte prefix followed by
      // the raw 32-byte key. Node's verifier expects the wrapped form.
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
      const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
      return verifyBytes(
        null,
        Buffer.from(registrationProofMessage(publicKey, proof.challenge)),
        key,
        Buffer.from(proof.signature, 'base64url'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Resolve a node's credential to a node.
   *
   * Nodes deliberately have no session and no account: a node is a machine that
   * serves bytes, and a session would hand it the whole API.
   */
  authenticate(nodeId: string, token: string): { id: string } {
    const node = this.db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();
    if (!node) throw ApiError.unauthorized('Unknown node');
    if (node.status === 'blocked') throw ApiError.forbidden('This node has been blocked');
    if (!safeEqual(hashToken(token), node.tokenHash)) {
      throw ApiError.unauthorized('Invalid node credentials');
    }
    return { id: node.id };
  }

  /* -------------------------------------------------------------- heartbeats */

  /**
   * Record that a node is alive, where it thinks it is, and what it holds.
   *
   * Endpoints are replaced rather than merged. A stale candidate is not
   * harmless — it is a connection attempt a client has to wait out before
   * trying one that works — so the node's current view wins outright.
   */
  heartbeat(input: HeartbeatInput): { status: string; knownGames: number } {
    const node = this.db.select().from(meshNodes).where(eq(meshNodes.id, input.nodeId)).get();
    if (!node) throw ApiError.notFound('Unknown node');
    if (node.status === 'blocked') throw ApiError.forbidden('This node has been blocked');

    this.applyEndpoints(node.id, input.endpoints, input.observedAddress);

    if (input.games) {
      this.replaceContent(node.id, input.games);
    }

    this.db
      .update(meshNodes)
      .set({
        status: 'online',
        lastSeenAt: new Date().toISOString(),
        ...directAddress(input.publicUrl, node.publicUrl),
      })
      .where(eq(meshNodes.id, node.id))
      .run();

    const knownGames = this.db
      .select({ count: sql<number>`count(*)` })
      .from(meshNodeGames)
      .where(eq(meshNodeGames.nodeId, node.id))
      .get();

    return { status: 'online', knownGames: Number(knownGames?.count ?? 0) };
  }

  /**
   * Mark nodes that have stopped heartbeating.
   *
   * Stale rather than deleted: a node that drops off for ten minutes and comes
   * back is the normal case for a machine on a home connection, and deleting it
   * would throw away its content index and its enrolment along with it.
   */
  pruneStale(): number {
    const cutoff = new Date(Date.now() - MESH_HEARTBEAT_TIMEOUT_SECONDS * 1000).toISOString();

    const result = this.db
      .update(meshNodes)
      .set({ status: 'stale' })
      .where(
        and(
          eq(meshNodes.status, 'online'),
          sql`(${meshNodes.lastSeenAt} IS NULL OR ${meshNodes.lastSeenAt} < ${cutoff})`,
        ),
      )
      .run();

    return result.changes ?? 0;
  }

  /* ------------------------------------------------------------- the catalog */

  /**
   * A stable fingerprint of what a game's files currently are.
   *
   * A node announces the hash it verified its copy against. When the origin
   * rescans and a file changes, this changes with it, and every mirror still
   * announcing the old one stops being offered — without the coordinator having
   * to diff file lists or trust a mirror to notice on its own.
   */
  contentHashFor(gameId: string): string | null {
    const files = this.db
      .select({ relPath: gameFiles.relPath, sha256: gameFiles.sha256 })
      .from(gameFiles)
      .where(eq(gameFiles.gameId, gameId))
      .orderBy(gameFiles.relPath)
      .all();

    if (files.length === 0) return null;
    // A file without a hash makes the fingerprint meaningless rather than
    // merely incomplete: two different copies would fingerprint identically.
    if (files.some((file) => !file.sha256)) return null;

    // NUL-delimited because it is the one byte that cannot appear in a path.
    // With a printable separator, a file called `a b` hashing to `c` and one
    // called `a` hashing to `b c` would produce the same fingerprint.
    const digest = createHash('sha256');
    for (const file of files) {
      digest.update(`${file.relPath}\u0000${file.sha256}\u0000`);
    }
    return digest.digest('hex');
  }

  /**
   * Which of these games at least one online node is currently offering.
   *
   * One query for a whole page, rather than `nodesForGame` per row: that
   * fingerprints the game first, which reads every file row it has — fine once
   * on an install, ruinous a hundred and twenty times to draw a store page.
   * The fingerprint check is skipped here on purpose. This decides whether a
   * card says "coming soon"; the manifest still does the strict comparison
   * when somebody actually installs, so a stale announcement costs a slightly
   * optimistic badge rather than a bad download.
   */
  offeredGameIds(gameIds: string[]): Set<string> {
    const offered = new Set<string>();
    if (gameIds.length === 0) return offered;

    // SQLite caps a statement at 999 bound parameters by default.
    for (let offset = 0; offset < gameIds.length; offset += 400) {
      const batch = gameIds.slice(offset, offset + 400);
      const rows = this.db
        .selectDistinct({
          gameId: meshNodeGames.gameId,
          // A copy standing in for the entry it was merged into: the machine
          // announces the row it holds, and the store is asking about the
          // entry. Without this, an entry whose only remaining copy is on
          // another machine reads as offered by nobody.
          entryId: sql<string | null>`${games.mergedIntoId}`,
        })
        .from(meshNodeGames)
        .innerJoin(meshNodes, eq(meshNodes.id, meshNodeGames.nodeId))
        .innerJoin(games, eq(games.id, meshNodeGames.gameId))
        .where(
          and(
            eq(meshNodes.status, 'online'),
            or(inArray(meshNodeGames.gameId, batch), inArray(games.mergedIntoId, batch)),
          ),
        )
        .all();
      for (const row of rows) offered.add(row.entryId ?? row.gameId);
    }

    return offered;
  }

  /**
   * How many machines are online and holding each of these entries.
   *
   * Counted per entry rather than per row, so an entry held by a home server
   * and a VPS is two hosts rather than two entries with one host each. One
   * query for a whole page: this decorates every card in a store listing.
   */
  hostCounts(gameIds: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (gameIds.length === 0) return counts;

    for (let offset = 0; offset < gameIds.length; offset += 400) {
      const batch = gameIds.slice(offset, offset + 400);
      const rows = this.db
        .select({
          entryId: sql<string>`coalesce(${games.mergedIntoId}, ${games.id})`,
          hosts: sql<number>`count(distinct ${meshNodeGames.nodeId})`,
        })
        .from(meshNodeGames)
        .innerJoin(meshNodes, eq(meshNodes.id, meshNodeGames.nodeId))
        .innerJoin(games, eq(games.id, meshNodeGames.gameId))
        .where(
          and(
            eq(meshNodes.status, 'online'),
            or(inArray(meshNodeGames.gameId, batch), inArray(games.mergedIntoId, batch)),
          ),
        )
        .groupBy(sql`coalesce(${games.mergedIntoId}, ${games.id})`)
        .all();

      for (const row of rows) counts.set(row.entryId, Number(row.hosts));
    }

    return counts;
  }

  /**
   * Every catalog row behind one entry: the entry itself and its copies.
   *
   * A merged entry is one game held by more than one machine, kept as one row
   * per machine so each can go on serving what is actually on its disk. Every
   * question about where a game can be fetched from starts here.
   */
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
   * Every copy of one entry, with the machines currently holding each.
   *
   * The operator's view of a merged entry, and the player's: one game, on one
   * disk or three. Cheap enough for a detail page and never asked for in a
   * listing, which is what `hostCounts` is for.
   */
  copiesFor(gameId: string): GameCopy[] {
    const rows = this.db
      .select({ game: games, libraryName: libraries.name })
      .from(games)
      .innerJoin(libraries, eq(libraries.id, games.libraryId))
      .where(or(eq(games.id, gameId), eq(games.mergedIntoId, gameId)))
      .all();

    const holders = new Map<string, { nodeId: string; label: string; direct: boolean }[]>();
    for (const row of this.db
      .select({ gameId: meshNodeGames.gameId, node: meshNodes })
      .from(meshNodeGames)
      .innerJoin(meshNodes, eq(meshNodes.id, meshNodeGames.nodeId))
      .where(
        and(
          inArray(
            meshNodeGames.gameId,
            rows.map((row) => row.game.id),
          ),
          eq(meshNodes.status, 'online'),
        ),
      )
      .all()) {
      const list = holders.get(row.gameId) ?? [];
      list.push({
        nodeId: row.node.id,
        label: row.node.label,
        direct: Boolean(row.node.publicUrl),
      });
      holders.set(row.gameId, list);
    }

    return rows
      .map(({ game, libraryName }) => ({
        gameId: game.id,
        libraryId: game.libraryId,
        libraryName,
        relPath: game.relPath,
        sizeBytes: game.sizeBytes,
        contentHash: this.contentHashFor(game.id),
        primary: game.id === gameId,
        mergeReason: game.mergeReason ?? null,
        hosts: holders.get(game.id) ?? [],
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary));
  }

  /**
   * How this entry can be delivered right now, and by whom.
   *
   * The awkward part is that two copies of a game need not be the same bytes.
   * Usually they are — a file that was copied to a second machine — and then
   * every holder is interchangeable chunk for chunk. When they are not, mixing
   * them would produce a download that is half one package and half another
   * and fails its hashes at the end, so a plan picks one package and sticks to
   * it: the fingerprint the most online machines agree on, with the entry's own
   * copy breaking a tie because it is the one whose metadata everybody sees.
   */
  deliveryPlan(gameId: string, options: { excludeOwnerId?: string } = {}): DeliveryPlan | null {
    const copies = this.copiesOf(gameId);

    const files = new Map(
      this.db
        .select()
        .from(gameFiles)
        .where(inArray(gameFiles.gameId, copies))
        .all()
        .map((file) => [file.gameId, file]),
    );

    const holderRows = this.db
      .select({ node: meshNodes, gameId: meshNodeGames.gameId, hash: meshNodeGames.contentHash })
      .from(meshNodeGames)
      .innerJoin(meshNodes, eq(meshNodes.id, meshNodeGames.nodeId))
      .where(and(inArray(meshNodeGames.gameId, copies), eq(meshNodes.status, 'online')))
      .all()
      // Nobody should be offered their own machine as a download source: it is
      // the copy they are trying to obtain.
      .filter((row) => !options.excludeOwnerId || row.node.ownerId !== options.excludeOwnerId);

    /*
     * Group by what each machine says it is holding, not by which row it holds.
     *
     * The fingerprint is computed from the file hashes, so two copies that are
     * the same bytes produce the same one even though they are different rows
     * in different libraries. That is what lets a home server and a VPS be two
     * sources for one download rather than two separate downloads.
     */
    const byHash = new Map<string, DeliveryHolder[]>();
    for (const row of holderRows) {
      const expected = this.contentHashFor(row.gameId);
      // A machine announcing a copy of a game that has since changed is
      // announcing something that no longer exists.
      if (!expected || expected !== row.hash) continue;
      const file = files.get(row.gameId);
      if (!file) continue;

      const holders = byHash.get(row.hash) ?? [];
      holders.push({
        nodeId: row.node.id,
        label: row.node.label,
        role: row.node.role,
        gameId: row.gameId,
        fileId: file.id,
        publicUrl: row.node.publicUrl ?? null,
        lastSeenAt: row.node.lastSeenAt,
      });
      byHash.set(row.hash, holders);
    }

    const ownHash = this.contentHashFor(gameId);
    const chosen = [...byHash.entries()].sort((a, b) => {
      const byCount = b[1].length - a[1].length;
      if (byCount !== 0) return byCount;
      if (a[0] === ownHash) return -1;
      if (b[0] === ownHash) return 1;
      return a[0].localeCompare(b[0]);
    })[0];

    /*
     * Nothing is announcing this entry. That is not necessarily a failure — a
     * standalone server holds its own files and never announces anything — so
     * the plan describes the entry's own copy with no holders and the caller
     * decides whether it can read those bytes itself.
     */
    const packageGameId = chosen ? (chosen[1][0] as DeliveryHolder).gameId : gameId;
    const file = files.get(packageGameId) ?? files.get(gameId);
    if (!file) return null;

    const rank: Record<string, number> = { origin: 0, mirror: 1, peer: 2 };
    const holders = (chosen?.[1] ?? []).sort((a, b) => {
      const byRole = (rank[a.role] ?? 9) - (rank[b.role] ?? 9);
      if (byRole !== 0) return byRole;
      return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
    });

    return {
      entryGameId: gameId,
      gameId: file.gameId,
      fileId: file.id,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      sha256: file.sha256,
      contentHash: chosen?.[0] ?? ownHash,
      holders,
    };
  }

  /**
   * Nodes currently able to serve this game, best first.
   *
   * "Best" here is only a starting order — role first, then how recently the
   * node was seen. The coordinator cannot know which node is fastest for a
   * particular client on a particular evening; the client measures that itself
   * and this just decides what it tries before it has measurements.
   */
  nodesForGame(gameId: string, options: { excludeOwnerId?: string } = {}): MeshNodeInfo[] {
    const plan = this.deliveryPlan(gameId, options);
    if (!plan) return [];

    const byId = new Map(
      this.db
        .select()
        .from(meshNodes)
        .where(
          inArray(
            meshNodes.id,
            plan.holders.map((holder) => holder.nodeId),
          ),
        )
        .all()
        .map((node) => [node.id, node]),
    );

    return plan.holders.slice(0, MESH_MAX_SOURCES_PER_GAME).flatMap((holder) => {
      const node = byId.get(holder.nodeId);
      if (!node) return [];
      return [
        {
          id: node.id,
          label: node.label,
          role: node.role,
          status: node.status,
          publicKey: node.publicKey,
          // Network locations were once deliberately never exposed. A node that
          // advertises a reachable address of its own is the exception it asked
          // to be: see `publicUrl`, which is handed out with a signed, expiring
          // grant rather than as a standing invitation.
          endpoints: [],
          lastSeenAt: node.lastSeenAt,
          bytesServed: node.bytesServed,
          gameCount: 0,
          observedRttMs: null,
          publicUrl: node.publicUrl ?? null,
          directOkAt: node.directOkAt ?? null,
        },
      ];
    });
  }

  /**
   * The source list for a game's manifest.
   *
   * The origin is included only when this process actually serves files.
   * Advertising a coordinator as an origin sends clients to a download route
   * whose backing path cannot exist.
   *
   * Ordered by what somebody has actually measured where anything has been:
   * the caller's own last measurement of each source first, then the median of
   * everybody else's. The client re-measures and re-orders for itself, so this
   * only decides the first few seconds of a download — which is exactly the
   * part a cold client gets wrong on its own.
   */
  sourcesFor(
    gameId: string,
    options: {
      chunked: boolean;
      includeOrigin: boolean;
      excludeOwnerId?: string;
      /** Whose measurements to prefer, and who a direct grant is minted for. */
      userId?: string;
      /** Mints the signed permission a direct fetch presents to a node. */
      mintGrant?: (claims: Omit<DeliveryGrantClaims, 'v' | 'expiresAt' | 'nonce'>) => {
        grant: string;
        expiresAt: string;
      };
    },
  ): MeshSource[] {
    const sources: MeshSource[] = options.includeOrigin
      ? [{ kind: 'origin', label: 'Origin', priority: 100 }]
      : [];

    // Without chunk hashes a client cannot verify a piece, so it cannot safely
    // take one from anywhere but the origin. Offering nodes anyway would be
    // offering bytes it has no way to check.
    if (!options.chunked) return sources;

    const plan = this.deliveryPlan(gameId, { excludeOwnerId: options.excludeOwnerId });
    const holders = plan?.holders ?? [];
    if (holders.length === 0) return sources;

    const speeds = this.measuredSpeeds(
      holders.map((holder) => holder.nodeId),
      options.userId,
    );

    const ordered = [...holders].sort((a, b) => {
      const bySpeed = (speeds.get(b.nodeId) ?? 0) - (speeds.get(a.nodeId) ?? 0);
      if (bySpeed !== 0) return bySpeed;
      // An unmeasured node with an address of its own goes ahead of a measured
      // proxy hop: the first client to try it is how it ever gets measured.
      const byDirect = Number(Boolean(b.publicUrl)) - Number(Boolean(a.publicUrl));
      if (byDirect !== 0) return byDirect;
      return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
    });

    ordered.slice(0, MESH_MAX_SOURCES_PER_GAME).forEach((holder, position) => {
      const direct =
        holder.publicUrl && options.mintGrant && options.userId
          ? options.mintGrant({
              nodeId: holder.nodeId,
              gameId: holder.gameId,
              fileId: holder.fileId,
              userId: options.userId,
            })
          : null;

      sources.push({
        kind: 'node',
        nodeId: holder.nodeId,
        label: holder.label,
        priority: position,
        gameId: holder.gameId,
        fileId: holder.fileId,
        observedBytesPerSecond: speeds.get(holder.nodeId) ?? null,
        ...(direct && holder.publicUrl
          ? {
              directUrl: `${holder.publicUrl}${MESH_DIRECT_CHUNK_PATH}`,
              probeUrl: `${holder.publicUrl}${MESH_DIRECT_PROBE_PATH}`,
              grant: direct.grant,
              grantExpiresAt: direct.expiresAt,
            }
          : {}),
      });
    });

    return sources.sort((a, b) => a.priority - b.priority);
  }

  /* ------------------------------------------------------- measured sources */

  /**
   * What has been measured against these nodes, bytes per second.
   *
   * One caller's own last measurement wins outright where they have one:
   * nobody else's link predicts theirs. Failing that, the median of recent
   * measurements from everyone, which at least distinguishes a node on a
   * gigabit line from one on a phone tether.
   *
   * Advisory in the strictest sense — it decides what is tried first and
   * nothing else. Every arriving chunk is verified against its hash whatever
   * this says.
   */
  private measuredSpeeds(nodeIds: string[], userId?: string): Map<string, number> {
    const speeds = new Map<string, number>();
    if (nodeIds.length === 0) return speeds;

    const cutoff = new Date(Date.now() - PROBE_TTL_MS).toISOString();
    const samples = new Map<string, number[]>();

    for (const row of this.db
      .select()
      .from(meshSourceProbes)
      .where(
        and(
          inArray(meshSourceProbes.nodeId, nodeIds),
          eq(meshSourceProbes.ok, true),
          gte(meshSourceProbes.measuredAt, cutoff),
        ),
      )
      .all()) {
      if (!row.nodeId || !row.bytesPerSecond) continue;
      if (userId && row.userId === userId) {
        speeds.set(row.nodeId, Math.max(speeds.get(row.nodeId) ?? 0, row.bytesPerSecond));
        continue;
      }
      const list = samples.get(row.nodeId) ?? [];
      list.push(row.bytesPerSecond);
      samples.set(row.nodeId, list);
    }

    for (const [nodeId, list] of samples) {
      if (speeds.has(nodeId)) continue;
      const sorted = [...list].sort((a, b) => a - b);
      speeds.set(nodeId, sorted[Math.floor(sorted.length / 2)] ?? 0);
    }

    return speeds;
  }

  /**
   * Record what a client measured against the sources it was offered.
   *
   * Kept as one row per account and source rather than a history: the question
   * it answers is "what should this person try first", and yesterday's answer
   * is the only one that has ever been useful.
   */
  recordProbes(userId: string, results: SourceProbeReport[]): void {
    if (results.length === 0) return;
    const measuredAt = new Date().toISOString();

    this.db.transaction((tx) => {
      for (const result of results) {
        const sourceKey = result.nodeId ? `${result.nodeId}:${result.transport}` : 'coordinator';
        const row = {
          userId,
          sourceKey,
          nodeId: result.nodeId,
          transport: result.transport,
          latencyMs: result.latencyMs === null ? null : Math.round(result.latencyMs),
          bytesPerSecond: result.bytesPerSecond === null ? null : Math.round(result.bytesPerSecond),
          ok: result.ok,
          measuredAt,
        };

        tx.insert(meshSourceProbes)
          .values(row)
          .onConflictDoUpdate({
            target: [meshSourceProbes.userId, meshSourceProbes.sourceKey],
            set: row,
          })
          .run();

        // A direct fetch that worked is worth recording on the node itself:
        // it is the only evidence the Coordinator ever gets that a node's
        // advertised address is reachable from the outside world.
        if (result.ok && result.transport === 'direct' && result.nodeId) {
          tx.update(meshNodes)
            .set({ directOkAt: measuredAt })
            .where(eq(meshNodes.id, result.nodeId))
            .run();
        }
      }
    });
  }

  /**
   * Account for bytes a node delivered straight to a client.
   *
   * The Coordinator never saw them, which is the entire point, so they have to
   * be reported or they are invisible: the node would look idle, the mesh
   * share would read as zero, and a monthly allowance would be a ceiling
   * anybody could walk around by having a fast node nearby. Reported by the
   * client, bounded by the size of the game, and never more authoritative than
   * that — it is accounting, not authorisation.
   */
  recordDirectDelivery(input: {
    nodeId: string;
    userId: string;
    gameId: string;
    bytes: number;
  }): void {
    const bytes = Math.max(0, Math.floor(input.bytes));
    if (bytes === 0) return;

    const node = this.db.select().from(meshNodes).where(eq(meshNodes.id, input.nodeId)).get();
    if (!node) return;

    const at = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.insert(meshTransfers)
        .values({
          nonce: newId('mtx'),
          nodeId: input.nodeId,
          userId: input.userId,
          gameId: input.gameId,
          bytesServed: bytes,
          issuedAt: at,
          reportedAt: at,
        })
        .run();

      tx.update(meshNodes)
        .set({
          bytesServed: sql`${meshNodes.bytesServed} + ${bytes}`,
          directBytesServed: sql`${meshNodes.directBytesServed} + ${bytes}`,
          directOkAt: at,
        })
        .where(eq(meshNodes.id, input.nodeId))
        .run();

      /*
       * Counted against the account as well, as a download that happened —
       * because it did. The monthly allowance is measured from this table, and
       * a transfer that skipped the Coordinator is still a transfer the
       * operator is paying for somewhere.
       */
      tx.insert(downloadEvents)
        .values({
          id: newId('dle'),
          userId: input.userId,
          gameId: input.gameId,
          fileId: null,
          sessionId: null,
          client: DIRECT_CLIENT,
          bytesSent: bytes,
          startedAt: at,
          finishedAt: at,
          completed: true,
        })
        .run();
    });
  }

  /* ------------------------------------------------------ HTTPS chunk proxy */

  /**
   * Fetch one verified 10 MiB ZIP piece through an operator node's outbound HTTPS
   * connection.
   *
   * Desktop already opens several byte-range requests concurrently. Each one
   * becomes one small job here, so the Coordinator can keep several uploads in
   * flight without buffering a game or waiting for one file to finish before
   * the next starts. A failed node is skipped and the same chunk is offered to
   * another current holder.
   */
  async fetchNodeChunk(input: {
    userId: string;
    gameId: string;
    fileId: string;
    chunkIndex: number;
    expectedBytes: number;
    sha256: string;
  }): Promise<ProxiedChunk> {
    /*
     * Every machine holding these exact bytes, addressed in its own ids.
     *
     * The plan is recomputed per chunk rather than held for the download: a
     * node going offline halfway through a 60 GB transfer should cost the
     * chunk in flight and nothing else, and a node coming online should be
     * usable immediately rather than after the next install.
     */
    const plan = this.deliveryPlan(input.gameId);
    const holders = (plan?.holders ?? []).filter((holder) => holder.role !== 'peer');
    if (holders.length === 0) {
      throw ApiError.gone('No active Node currently holds this game');
    }

    // Rotate the first choice so concurrent Desktop ranges spread naturally
    // across mirrors instead of pinning every request to the first row.
    const start = this.nextNode++ % holders.length;
    const ordered = [...holders.slice(start), ...holders.slice(0, start)];
    let lastError: Error | null = null;

    for (const holder of ordered) {
      try {
        return await this.queueNodeChunk(holder.nodeId, holder.label, {
          ...input,
          // In the holder's ids, not the catalog entry's: a node knows only
          // the copy on its own disk.
          gameId: holder.gameId,
          fileId: holder.fileId,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          { err: lastError, nodeId: holder.nodeId, gameId: holder.gameId, fileId: holder.fileId },
          'node did not deliver a requested HTTPS chunk',
        );
      }
    }

    throw ApiError.unavailable(
      lastError?.message || 'No active Node delivered the requested game data',
    );
  }

  private queueNodeChunk(
    nodeId: string,
    nodeLabel: string,
    input: {
      userId: string;
      gameId: string;
      fileId: string;
      chunkIndex: number;
      expectedBytes: number;
      sha256: string;
    },
  ): Promise<ProxiedChunk> {
    return new Promise<ProxiedChunk>((resolve, reject) => {
      const requestId = newId('nch');
      const timer = setTimeout(() => {
        this.pendingNodeChunks.delete(requestId);
        this.removeQueuedNodeChunk(nodeId, requestId);
        reject(new Error(`${nodeLabel} did not answer the Coordinator in time`));
      }, NODE_CHUNK_CLAIM_TIMEOUT_MS);
      timer.unref();

      this.pendingNodeChunks.set(requestId, {
        requestId,
        nodeId,
        nodeLabel,
        userId: input.userId,
        gameId: input.gameId,
        fileId: input.fileId,
        chunkIndex: input.chunkIndex,
        expectedBytes: input.expectedBytes,
        sha256: input.sha256,
        queuedAt: new Date().toISOString(),
        resolve,
        reject,
        timer,
      });

      const queued = this.nodeChunkQueues.get(nodeId) ?? [];
      if (queued.length >= 128) {
        const droppedId = queued.shift();
        const dropped = droppedId ? this.pendingNodeChunks.get(droppedId) : undefined;
        if (dropped) {
          clearTimeout(dropped.timer);
          this.pendingNodeChunks.delete(dropped.requestId);
          dropped.reject(new Error(`${nodeLabel} has too many pending chunk requests`));
        }
      }
      queued.push(requestId);
      // A disconnected Node must not become an unbounded memory queue.
      this.nodeChunkQueues.set(nodeId, queued);
      for (const wake of this.nodeChunkWaiters.get(nodeId) ?? []) wake();
      this.nodeChunkWaiters.delete(nodeId);
    });
  }

  /** Long-poll work for one authenticated node. */
  async waitForNodeChunks(
    nodeId: string,
    timeoutMs: number,
    limit = NODE_CHUNK_POLL_BATCH,
  ): Promise<NodeChunkJob[]> {
    const boundedLimit = Math.min(NODE_CHUNK_POLL_BATCH, Math.max(1, Math.floor(limit)));
    const ready = this.takeNodeChunks(nodeId, boundedLimit);
    if (ready.length > 0) return ready;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.removeNodeChunkWaiter(nodeId, wake);
        resolve();
      }, timeoutMs);
      timer.unref();

      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const waiters = this.nodeChunkWaiters.get(nodeId) ?? [];
      waiters.push(wake);
      this.nodeChunkWaiters.set(nodeId, waiters);
    });

    return this.takeNodeChunks(nodeId, boundedLimit);
  }

  private takeNodeChunks(nodeId: string, limit: number): NodeChunkJob[] {
    const queued = this.nodeChunkQueues.get(nodeId) ?? [];
    const taken = queued.splice(0, limit);
    if (queued.length > 0) this.nodeChunkQueues.set(nodeId, queued);
    else this.nodeChunkQueues.delete(nodeId);

    return taken.flatMap((requestId) => {
      const pending = this.pendingNodeChunks.get(requestId);
      if (!pending || pending.nodeId !== nodeId) return [];
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        this.pendingNodeChunks.delete(requestId);
        pending.reject(new Error(`${pending.nodeLabel} did not finish the requested chunk`));
      }, NODE_CHUNK_DELIVERY_TIMEOUT_MS);
      pending.timer.unref();

      return [
        {
          requestId: pending.requestId,
          gameId: pending.gameId,
          fileId: pending.fileId,
          chunkIndex: pending.chunkIndex,
          expectedBytes: pending.expectedBytes,
          sha256: pending.sha256,
        },
      ];
    });
  }

  /** Accept and independently verify bytes uploaded by the assigned node. */
  deliverNodeChunk(requestId: string, nodeId: string, bytes: Buffer): void {
    const pending = this.pendingNodeChunks.get(requestId);
    if (!pending) throw ApiError.gone('That chunk request is no longer waiting');
    if (pending.nodeId !== nodeId) throw ApiError.forbidden('That chunk belongs to another Node');
    if (bytes.length !== pending.expectedBytes) {
      this.failNodeChunk(
        requestId,
        nodeId,
        `Node returned ${bytes.length} bytes; ${pending.expectedBytes} were requested`,
      );
      throw ApiError.badRequest('The uploaded chunk has the wrong length');
    }

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (!safeEqual(actual.toLowerCase(), pending.sha256.toLowerCase())) {
      this.failNodeChunk(requestId, nodeId, 'Node returned a chunk that failed verification');
      throw ApiError.badRequest('The uploaded chunk failed verification');
    }

    clearTimeout(pending.timer);
    this.pendingNodeChunks.delete(requestId);

    const reportedAt = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.insert(meshTransfers)
        .values({
          nonce: requestId,
          nodeId,
          userId: pending.userId,
          gameId: pending.gameId,
          bytesServed: bytes.length,
          issuedAt: pending.queuedAt,
          reportedAt,
        })
        .run();
      tx.update(meshNodes)
        .set({ bytesServed: sql`${meshNodes.bytesServed} + ${bytes.length}` })
        .where(eq(meshNodes.id, nodeId))
        .run();
    });

    pending.resolve({ bytes, nodeId, nodeLabel: pending.nodeLabel });
  }

  failNodeChunk(requestId: string, nodeId: string, message: string): void {
    const pending = this.pendingNodeChunks.get(requestId);
    if (!pending) return;
    if (pending.nodeId !== nodeId) throw ApiError.forbidden('That chunk belongs to another Node');
    clearTimeout(pending.timer);
    this.pendingNodeChunks.delete(requestId);
    pending.reject(new Error(message || `${pending.nodeLabel} could not read that chunk`));
  }

  private removeQueuedNodeChunk(nodeId: string, requestId: string): void {
    const queued = (this.nodeChunkQueues.get(nodeId) ?? []).filter((id) => id !== requestId);
    if (queued.length > 0) this.nodeChunkQueues.set(nodeId, queued);
    else this.nodeChunkQueues.delete(nodeId);
  }

  private removeNodeChunkWaiter(nodeId: string, wake: () => void): void {
    const waiters = (this.nodeChunkWaiters.get(nodeId) ?? []).filter((entry) => entry !== wake);
    if (waiters.length > 0) this.nodeChunkWaiters.set(nodeId, waiters);
    else this.nodeChunkWaiters.delete(nodeId);
  }

  /* -------------------------------------------------------------- analytics */

  /**
   * The fleet, summarised, with enough history to see whether it is working.
   *
   * The question this exists to answer is not "are the nodes up" — the list
   * says that — but "is the mesh actually carrying the traffic". A coordinator
   * on a small VPS is why any of this exists, so the share of delivered bytes
   * that never touched it is the headline, and everything else is there to
   * explain that number when it is disappointing: games nothing holds, games
   * one node holds, nodes that stopped reporting.
   */
  analytics(options: { days: number }): MeshAnalytics {
    const days = Math.min(90, Math.max(1, Math.floor(options.days)));
    const since = (ago: number) => new Date(Date.now() - ago).toISOString();
    const day = 24 * 3_600_000;

    const nodes = this.db.select().from(meshNodes).all();
    const countStatus = (status: string) => nodes.filter((node) => node.status === status).length;

    const meshBytes = (from: string) =>
      Number(
        this.db
          .select({ bytes: sql<number>`coalesce(sum(${meshTransfers.bytesServed}), 0)` })
          .from(meshTransfers)
          .where(gte(meshTransfers.issuedAt, from))
          .get()?.bytes ?? 0,
      );

    /*
     * Bytes this machine sent itself.
     *
     * Deliveries a node made straight to a client are recorded in the same
     * table — the monthly allowance is measured from it — but they never
     * touched this machine, and counting them here would make the one number
     * this page exists for, the share the mesh carries, understate itself by
     * exactly the amount the mesh is doing best at.
     */
    const originBytes = (from: string) =>
      Number(
        this.db
          .select({ bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)` })
          .from(downloadEvents)
          .where(and(gte(downloadEvents.startedAt, from), ne(downloadEvents.client, DIRECT_CLIENT)))
          .get()?.bytes ?? 0,
      );

    const lifetime = Number(
      this.db
        .select({ bytes: sql<number>`coalesce(sum(${meshNodes.bytesServed}), 0)` })
        .from(meshNodes)
        .get()?.bytes ?? 0,
    );

    const mesh7d = meshBytes(since(7 * day));
    const origin7d = originBytes(since(7 * day));

    /*
     * Coverage, counted from what nodes are announcing right now.
     *
     * Only online nodes count. A game held solely by a node that went offline
     * yesterday is, as far as any player is concerned, a game the coordinator
     * has to serve — and saying otherwise on this page is how an operator
     * discovers the problem from a bandwidth bill instead.
     */
    const catalogGames = Number(
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(games)
        .where(isNull(games.missingAt))
        .get()?.n ?? 0,
    );

    const holders = this.db
      .select({ gameId: meshNodeGames.gameId, holders: sql<number>`count(*)` })
      .from(meshNodeGames)
      .innerJoin(meshNodes, eq(meshNodes.id, meshNodeGames.nodeId))
      .innerJoin(games, eq(games.id, meshNodeGames.gameId))
      .where(and(eq(meshNodes.status, 'online'), isNull(games.missingAt)))
      .groupBy(meshNodeGames.gameId)
      .all();

    const covered = holders.length;
    const singleSource = holders.filter((row) => Number(row.holders) === 1).length;

    const history: MeshDailyPoint[] = [];
    const meshByDay = new Map(
      this.db
        .select({
          date: sql<string>`substr(${meshTransfers.issuedAt}, 1, 10)`,
          bytes: sql<number>`coalesce(sum(${meshTransfers.bytesServed}), 0)`,
          transfers: sql<number>`count(*)`,
        })
        .from(meshTransfers)
        .where(gte(meshTransfers.issuedAt, since(days * day)))
        .groupBy(sql`substr(${meshTransfers.issuedAt}, 1, 10)`)
        .all()
        .map((row) => [row.date, row]),
    );

    const originByDay = new Map(
      this.db
        .select({
          date: sql<string>`substr(${downloadEvents.startedAt}, 1, 10)`,
          bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)`,
        })
        .from(downloadEvents)
        .where(gte(downloadEvents.startedAt, since(days * day)))
        .groupBy(sql`substr(${downloadEvents.startedAt}, 1, 10)`)
        .all()
        .map((row) => [row.date, row]),
    );

    // Every day in the window, including the quiet ones. A series that omits
    // them draws a busy Tuesday next to a busy Friday and hides the weekend.
    for (let index = days - 1; index >= 0; index -= 1) {
      const date = new Date(Date.now() - index * day).toISOString().slice(0, 10);
      history.push({
        date,
        meshBytes: Number(meshByDay.get(date)?.bytes ?? 0),
        originBytes: Number(originByDay.get(date)?.bytes ?? 0),
        transfers: Number(meshByDay.get(date)?.transfers ?? 0),
      });
    }

    const topNodes = this.db
      .select({
        nodeId: meshTransfers.nodeId,
        label: meshNodes.label,
        bytes: sql<number>`coalesce(sum(${meshTransfers.bytesServed}), 0)`,
      })
      .from(meshTransfers)
      .innerJoin(meshNodes, eq(meshNodes.id, meshTransfers.nodeId))
      .where(gte(meshTransfers.issuedAt, since(7 * day)))
      .groupBy(meshTransfers.nodeId, meshNodes.label)
      .orderBy(sql`sum(${meshTransfers.bytesServed}) desc`)
      .limit(8)
      .all()
      .map((row) => ({ nodeId: row.nodeId, label: row.label, bytes: Number(row.bytes) }))
      .filter((row) => row.bytes > 0);

    const topGames = this.db
      .select({
        gameId: meshTransfers.gameId,
        title: games.title,
        bytes: sql<number>`coalesce(sum(${meshTransfers.bytesServed}), 0)`,
      })
      .from(meshTransfers)
      .innerJoin(games, eq(games.id, meshTransfers.gameId))
      .where(gte(meshTransfers.issuedAt, since(7 * day)))
      .groupBy(meshTransfers.gameId, games.title)
      .orderBy(sql`sum(${meshTransfers.bytesServed}) desc`)
      .limit(8)
      .all()
      .map((row) => ({ gameId: row.gameId ?? '', title: row.title, bytes: Number(row.bytes) }))
      .filter((row) => row.bytes > 0);

    return {
      generatedAt: new Date().toISOString(),
      days,
      nodes: {
        total: nodes.length,
        online: countStatus('online'),
        stale: countStatus('stale'),
        blocked: countStatus('blocked'),
        pending: countStatus('pending'),
        operator: nodes.filter((node) => node.role !== 'peer').length,
      },
      bytes: {
        meshLifetime: lifetime,
        mesh24h: meshBytes(since(day)),
        mesh7d,
        origin24h: originBytes(since(day)),
        origin7d,
        // Node bytes are a subset of total Coordinator-delivered bytes now,
        // not a second delivery path to add to them.
        meshShare: origin7d > 0 ? Math.min(1, mesh7d / origin7d) : 0,
      },
      coverage: {
        games: catalogGames,
        covered,
        singleSource,
        uncovered: Math.max(0, catalogGames - covered),
      },
      history,
      topNodes,
      topGames,
    };
  }

  /* ------------------------------------------------------------ administration */

  /**
   * Every node with the numbers an operator actually monitors it by.
   *
   * A superset of `listNodes`, and separate from it because the two answer
   * different questions: that one is "who can serve this game", asked on the
   * path of every download and kept cheap for that reason; this one is "how is
   * the fleet doing", asked by one person with a page open.
   */
  listNodeStats(): MeshNodeStats[] {
    const base = this.listNodes();
    const rows = this.db.select().from(meshNodes).all();
    const byId = new Map(rows.map((node) => [node.id, node]));

    const day = 24 * 3_600_000;
    const since = (ago: number) => new Date(Date.now() - ago).toISOString();

    const window = (from: string) =>
      new Map(
        this.db
          .select({
            nodeId: meshTransfers.nodeId,
            bytes: sql<number>`coalesce(sum(${meshTransfers.bytesServed}), 0)`,
            transfers: sql<number>`count(*)`,
            players: sql<number>`count(distinct ${meshTransfers.userId})`,
            last: sql<string | null>`max(${meshTransfers.reportedAt})`,
          })
          .from(meshTransfers)
          .where(gte(meshTransfers.issuedAt, from))
          .groupBy(meshTransfers.nodeId)
          .all()
          .map((row) => [row.nodeId, row]),
      );

    const recent = window(since(day));
    const weekly = window(since(7 * day));

    const libraryNames = new Map(
      this.db
        .select({ id: libraries.id, name: libraries.name })
        .from(libraries)
        .all()
        .map((row) => [row.id, row.name]),
    );

    // Games in each node's library, and how many of those carry chunk hashes.
    // The gap between the two is the answer to "why is this node holding two
    // thousand games and serving none of them".
    const libraryTotals = new Map(
      this.db
        .select({ libraryId: games.libraryId, n: sql<number>`count(*)` })
        .from(games)
        .where(isNull(games.missingAt))
        .groupBy(games.libraryId)
        .all()
        .map((row) => [row.libraryId, Number(row.n)]),
    );

    /*
     * Games every one of whose files is hashed on the current grid.
     *
     * Grouped per game first and counted per library second, because the
     * condition is about a whole game: one unhashed file makes the game
     * unservable, and a per-library count of hashed *files* would sit at 99%
     * while nothing at all could be fetched.
     */
    const complete = this.db
      .select({ gameId: games.id, libraryId: games.libraryId })
      .from(games)
      .innerJoin(gameFiles, eq(gameFiles.gameId, games.id))
      .where(isNull(games.missingAt))
      .groupBy(games.id)
      .having(
        sql`sum(case when ${gameFiles.chunkBytes} = ${MESH_CHUNK_BYTES} then 0 else 1 end) = 0`,
      )
      .as('complete');

    const libraryServable = new Map(
      this.db
        .select({ libraryId: complete.libraryId, n: sql<number>`count(*)` })
        .from(complete)
        .groupBy(complete.libraryId)
        .all()
        .map((row) => [row.libraryId, Number(row.n)]),
    );

    const owners = new Map(
      this.db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(
          inArray(
            users.id,
            rows.map((node) => node.ownerId).filter((id): id is string => Boolean(id)),
          ),
        )
        .all()
        .map((row) => [row.id, row.username]),
    );

    const probes = this.probeSummary();

    const activeByNode = new Map<string, number>();
    for (const pending of this.pendingNodeChunks.values()) {
      activeByNode.set(pending.nodeId, (activeByNode.get(pending.nodeId) ?? 0) + 1);
    }

    return base.map((node) => {
      const row = byId.get(node.id);
      const today = recent.get(node.id);
      const week = weekly.get(node.id);
      const libraryId = row?.libraryId ?? null;

      return {
        ...node,
        agentVersion: row?.agentVersion ?? null,
        createdAt: row?.createdAt ?? new Date(0).toISOString(),
        libraryId,
        libraryName: libraryId ? (libraryNames.get(libraryId) ?? null) : null,
        catalogReportedAt: row?.catalogReportedAt ?? null,
        catalogStatus: row?.catalogStatus ?? null,
        libraryGames: libraryId ? (libraryTotals.get(libraryId) ?? 0) : 0,
        servableGames: libraryId ? (libraryServable.get(libraryId) ?? 0) : 0,
        bytesServed24h: Number(today?.bytes ?? 0),
        bytesServed7d: Number(week?.bytes ?? 0),
        transfers24h: Number(today?.transfers ?? 0),
        activeTransfers: activeByNode.get(node.id) ?? 0,
        players7d: Number(week?.players ?? 0),
        lastTransferAt: week?.last ?? null,
        ownerUsername: row?.ownerId ? (owners.get(row.ownerId) ?? null) : null,
        secondsSinceSeen: node.lastSeenAt
          ? Math.max(0, Math.round((Date.now() - Date.parse(node.lastSeenAt)) / 1000))
          : null,
        directBytesServed: Number(row?.directBytesServed ?? 0),
        probeBytesPerSecond: probes.get(node.id)?.median ?? null,
        probeSamples: probes.get(node.id)?.samples ?? 0,
      };
    });
  }

  /**
   * What clients have measured against each node lately.
   *
   * Shown on the Nodes page because it is the one number that answers "is
   * direct delivery actually helping": a node with a public address whose
   * measurements are no better than the proxy's is a port forward that is not
   * doing anything.
   */
  private probeSummary(): Map<string, { median: number; samples: number }> {
    const cutoff = new Date(Date.now() - PROBE_TTL_MS).toISOString();
    const byNode = new Map<string, number[]>();

    for (const row of this.db
      .select()
      .from(meshSourceProbes)
      .where(and(eq(meshSourceProbes.ok, true), gte(meshSourceProbes.measuredAt, cutoff)))
      .all()) {
      if (!row.nodeId || !row.bytesPerSecond) continue;
      const list = byNode.get(row.nodeId) ?? [];
      list.push(row.bytesPerSecond);
      byNode.set(row.nodeId, list);
    }

    const summary = new Map<string, { median: number; samples: number }>();
    for (const [nodeId, list] of byNode) {
      const sorted = [...list].sort((a, b) => a - b);
      summary.set(nodeId, {
        median: sorted[Math.floor(sorted.length / 2)] ?? 0,
        samples: sorted.length,
      });
    }
    return summary;
  }

  listNodes(): MeshNodeInfo[] {
    const rows = this.db.select().from(meshNodes).orderBy(desc(meshNodes.createdAt)).all();
    const counts = new Map<string, number>();
    for (const row of this.db
      .select({ nodeId: meshNodeGames.nodeId, count: sql<number>`count(*)` })
      .from(meshNodeGames)
      .groupBy(meshNodeGames.nodeId)
      .all()) {
      counts.set(row.nodeId, Number(row.count));
    }

    return rows.map((node) => ({
      id: node.id,
      label: node.label,
      role: node.role,
      status: node.status,
      publicKey: node.publicKey,
      endpoints: [],
      lastSeenAt: node.lastSeenAt,
      bytesServed: node.bytesServed,
      publicUrl: node.publicUrl ?? null,
      directOkAt: node.directOkAt ?? null,
      gameCount: counts.get(node.id) ?? 0,
      observedRttMs: null,
      libraryId: node.libraryId,
      catalogStatus: node.catalogStatus,
    }));
  }

  /**
   * Point a node's catalog reports at a library.
   *
   * `null` unassigns, which stops the node's reports being accepted rather than
   * silently sending them somewhere else.
   */
  assignLibrary(nodeId: string, libraryId: string | null): void {
    const node = this.db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();
    if (!node) throw ApiError.notFound('Unknown node');

    if (libraryId) {
      const library = this.db
        .select({ id: libraries.id })
        .from(libraries)
        .where(eq(libraries.id, libraryId))
        .get();
      if (!library) throw ApiError.notFound('Unknown library');
    }

    this.db.update(meshNodes).set({ libraryId }).where(eq(meshNodes.id, nodeId)).run();
  }

  setNodeStatus(nodeId: string, status: 'online' | 'blocked'): void {
    const node = this.db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();
    if (!node) throw ApiError.notFound('Unknown node');

    this.db.update(meshNodes).set({ status }).where(eq(meshNodes.id, nodeId)).run();
  }

  removeNode(nodeId: string): void {
    this.db.delete(meshNodes).where(eq(meshNodes.id, nodeId)).run();
  }

  /* ------------------------------------------------------------------ private */

  /**
   * Replace a node's endpoint candidates.
   *
   * The observed address is added by the coordinator rather than claimed by the
   * node, because a node behind NAT cannot see its own public address. It is
   * still only a candidate: if the NAT is not endpoint-independent, the address
   * that worked for this HTTP request is useless for anyone else, and the only
   * way to find that out is to try.
   */
  private applyEndpoints(
    nodeId: string,
    endpoints: MeshEndpoint[],
    observedAddress?: string,
  ): void {
    const rows = endpoints
      .filter((endpoint) => endpoint.port > 0 && endpoint.port < 65_536)
      // Wildcard bind addresses describe where a process listens, not where a
      // client can reach it.
      .filter((endpoint) => endpoint.address !== '0.0.0.0' && endpoint.address !== '::')
      .slice(0, 16)
      .map((endpoint) => ({
        nodeId,
        kind: endpoint.kind,
        address: endpoint.address,
        port: endpoint.port,
      }));

    if (observedAddress) {
      // Paired with whatever ports the node offered: the coordinator sees the
      // address a TCP request came from, never the UDP port a node listens on.
      for (const endpoint of endpoints
        .filter((candidate) => candidate.address !== '0.0.0.0' && candidate.address !== '::')
        .slice(0, 4)) {
        rows.push({
          nodeId,
          kind: 'observed' as const,
          address: observedAddress,
          port: endpoint.port,
        });
      }
    }

    // Deduplicated here rather than left to the primary key, because one
    // statement inserting the same (address, port) twice fails as a whole.
    const seen = new Set<string>();
    const unique = rows.filter((row) => {
      const key = `${row.address}:${row.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this.db.transaction((tx) => {
      tx.delete(meshNodeEndpoints).where(eq(meshNodeEndpoints.nodeId, nodeId)).run();
      if (unique.length > 0) {
        tx.insert(meshNodeEndpoints).values(unique).run();
      }
    });
  }

  /**
   * Replace what a node claims to hold.
   *
   * Announcements that name a game this server does not have, or one whose
   * fingerprint does not match, are dropped rather than rejected: a mirror
   * mid-sync legitimately holds a mixture, and failing its whole heartbeat over
   * one stale entry would take a working node offline.
   */
  private replaceContent(
    nodeId: string,
    announced: { gameId: string; contentHash: string }[],
  ): void {
    const accepted = announced
      .filter((entry) => this.contentHashFor(entry.gameId) === entry.contentHash)
      .slice(0, 5_000)
      .map((entry) => ({
        nodeId,
        gameId: entry.gameId,
        contentHash: entry.contentHash,
        announcedAt: new Date().toISOString(),
      }));

    this.db.transaction((tx) => {
      tx.delete(meshNodeGames).where(eq(meshNodeGames.nodeId, nodeId)).run();
      for (let offset = 0; offset < accepted.length; offset += 200) {
        tx.insert(meshNodeGames)
          .values(accepted.slice(offset, offset + 200))
          .run();
      }
    });

    if (accepted.length < announced.length) {
      this.logger.debug(
        { nodeId, announced: announced.length, accepted: accepted.length },
        'some announced games did not match the origin',
      );
    }
  }
}
