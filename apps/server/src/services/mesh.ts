import { createHash, createPublicKey, verify as verifyBytes } from 'node:crypto';
import {
  MESH_CHUNK_BYTES,
  MESH_HEARTBEAT_TIMEOUT_SECONDS,
  MESH_MAX_SOURCES_PER_GAME,
  MESH_PUNCH_TTL_SECONDS,
  MESH_TUNNEL_IDLE_SECONDS,
  type MeshAnalytics,
  type MeshDailyPoint,
  type MeshPunchRequest,
  type MeshEndpoint,
  type MeshNodeInfo,
  type MeshNodeRole,
  type MeshNodeStats,
  type MeshSource,
  type MeshTunnel,
  type MeshTunnelMap,
} from '@gameblade/shared';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
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
}

export interface HeartbeatInput {
  nodeId: string;
  endpoints: MeshEndpoint[];
  observedAddress?: string;
  /** Games this node currently holds a complete, verified copy of. */
  games?: { gameId: string; contentHash: string }[];
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
   * Register a client as its own short-lived peer node.
   *
   * Peers carry no enrolment code — the account is the credential, and the node
   * dies with it. They are also the least trusted thing in the mesh, which is
   * why they are a separate entry point rather than a flag on `register`: there
   * is no path by which a peer can talk its way into being a mirror.
   */
  registerPeer(input: {
    ownerId: string;
    publicKey: string;
    label: string;
    endpoints: MeshEndpoint[];
    observedAddress?: string;
    agentVersion?: string;
  }): { nodeId: string; nodeToken: string } {
    const existing = this.db
      .select()
      .from(meshNodes)
      .where(eq(meshNodes.publicKey, input.publicKey))
      .get();

    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.role !== 'peer') {
        // A key already claimed by someone else, or by a mirror, is not
        // something to merge into — it is a mistake or an attempt.
        throw ApiError.conflict('That key is already registered to another node');
      }
      if (existing.status === 'blocked') {
        throw ApiError.forbidden('This node has been blocked by an administrator');
      }
      this.applyEndpoints(existing.id, input.endpoints, input.observedAddress);
      const rotated = newToken(24);
      this.db
        .update(meshNodes)
        .set({
          status: 'online',
          tokenHash: hashToken(rotated),
          lastSeenAt: new Date().toISOString(),
        })
        .where(eq(meshNodes.id, existing.id))
        .run();
      return { nodeId: existing.id, nodeToken: rotated };
    }

    const nodeId = newId('nod');
    const nodeToken = newToken(24);
    this.db
      .insert(meshNodes)
      .values({
        id: nodeId,
        label: input.label,
        role: 'peer',
        status: 'online',
        publicKey: input.publicKey,
        tokenHash: hashToken(nodeToken),
        ownerId: input.ownerId,
        agentVersion: input.agentVersion ?? null,
        lastSeenAt: new Date().toISOString(),
      })
      .run();

    this.applyEndpoints(nodeId, input.endpoints, input.observedAddress);
    return { nodeId, nodeToken };
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
      .set({ status: 'online', lastSeenAt: new Date().toISOString() })
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
        .selectDistinct({ gameId: meshNodeGames.gameId })
        .from(meshNodeGames)
        .innerJoin(meshNodes, eq(meshNodes.id, meshNodeGames.nodeId))
        .where(and(inArray(meshNodeGames.gameId, batch), eq(meshNodes.status, 'online')))
        .all();
      for (const row of rows) offered.add(row.gameId);
    }

    return offered;
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
    const contentHash = this.contentHashFor(gameId);
    if (!contentHash) return [];

    const rows = this.db
      .select({ node: meshNodes })
      .from(meshNodeGames)
      .innerJoin(meshNodes, eq(meshNodes.id, meshNodeGames.nodeId))
      .where(
        and(
          eq(meshNodeGames.gameId, gameId),
          // A mirror announcing a copy of a game that has since changed on the
          // origin is announcing something that no longer exists.
          eq(meshNodeGames.contentHash, contentHash),
          eq(meshNodes.status, 'online'),
        ),
      )
      .all()
      .map((row) => row.node)
      // Nobody should be offered their own machine as a download source: it is
      // the copy they are trying to obtain.
      .filter((node) => !options.excludeOwnerId || node.ownerId !== options.excludeOwnerId);

    const rank: Record<string, number> = { origin: 0, mirror: 1, peer: 2 };
    rows.sort((a, b) => {
      const byRole = (rank[a.role] ?? 9) - (rank[b.role] ?? 9);
      if (byRole !== 0) return byRole;
      return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
    });

    const endpoints = this.endpointsFor(rows.map((node) => node.id));

    return rows.slice(0, MESH_MAX_SOURCES_PER_GAME).map((node) => ({
      id: node.id,
      label: node.label,
      role: node.role,
      status: node.status,
      publicKey: node.publicKey,
      endpoints: endpoints.get(node.id) ?? [],
      lastSeenAt: node.lastSeenAt,
      bytesServed: node.bytesServed,
      gameCount: 0,
      observedRttMs: null,
    }));
  }

  /**
   * The source list for a game's manifest.
   *
   * The origin is always first and always present. Everything else is an
   * optimisation the client may ignore — which is exactly what an older client
   * does, and why adding nodes needs no client release.
   */
  sourcesFor(gameId: string, options: { chunked: boolean; excludeOwnerId?: string }): MeshSource[] {
    const sources: MeshSource[] = [{ kind: 'origin', label: 'Origin', priority: 100 }];

    // Without chunk hashes a client cannot verify a piece, so it cannot safely
    // take one from anywhere but the origin. Offering nodes anyway would be
    // offering bytes it has no way to check.
    if (!options.chunked) return sources;

    const nodes = this.nodesForGame(gameId, { excludeOwnerId: options.excludeOwnerId });
    nodes.forEach((node, position) => {
      sources.push({
        kind: 'node',
        nodeId: node.id,
        label: node.label,
        priority: position,
      });
    });

    return sources.sort((a, b) => a.priority - b.priority);
  }

  /* --------------------------------------------------------------- rendezvous */

  /**
   * Punch instructions waiting for each node, and whoever is waiting to hear.
   *
   * In memory rather than in the database on purpose. These live for seconds,
   * are worthless the moment they go stale, and arrive on the path of every
   * download — a write and a poll per connection attempt would be the busiest
   * thing this coordinator does, in service of data nobody would ever read
   * twice. A restart losing them costs one download its direct path.
   */
  private readonly punches = new Map<string, MeshPunchRequest[]>();
  private readonly waiters = new Map<string, (() => void)[]>();

  /**
   * Tell a node to punch toward a client.
   *
   * This is what breaks the deadlock at the heart of hole punching: both ends
   * have to send at roughly the same moment, but a node has no idea a client
   * exists until it connects — and it cannot connect until the node has
   * punched. The coordinator knows about both, so it tells the node first.
   */
  requestPunch(nodeId: string, request: MeshPunchRequest): void {
    for (const tunnel of this.live.values()) {
      if (tunnel.nodeId === nodeId && tunnel.userId === request.userId) tunnel.punches += 1;
    }

    const queued = this.punches.get(nodeId) ?? [];

    // Bounded, because this is reachable by any signed-in account asking to
    // resolve a game repeatedly. A node that is not polling should not
    // accumulate work nobody will collect.
    queued.push(request);
    this.punches.set(nodeId, queued.slice(-32));

    // Wake whoever is holding a long-poll open, so the node punches now rather
    // than whenever its poll happens to time out.
    for (const wake of this.waiters.get(nodeId) ?? []) wake();
    this.waiters.delete(nodeId);
  }

  /** Take everything queued for a node, dropping what has gone stale. */
  takePunches(nodeId: string): MeshPunchRequest[] {
    const queued = this.punches.get(nodeId) ?? [];
    this.punches.delete(nodeId);

    const cutoff = Date.now() - MESH_PUNCH_TTL_SECONDS * 1000;
    // A client that asked ten seconds ago has already fallen back to HTTP, and
    // its NAT mapping has probably lapsed. Punching at it is not harmful, just
    // pointless.
    return queued.filter((request) => Date.parse(request.queuedAt) >= cutoff);
  }

  /**
   * Wait for a punch request, or for the poll to time out.
   *
   * Resolves as soon as `requestPunch` wakes it. The timeout is what makes this
   * a long-poll rather than a hang: the connection completes normally and the
   * node immediately opens another.
   */
  async waitForPunch(nodeId: string, timeoutMs: number): Promise<MeshPunchRequest[]> {
    const ready = this.takePunches(nodeId);
    if (ready.length > 0) return ready;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(nodeId, wake);
        resolve();
      }, timeoutMs);

      const wake = () => {
        clearTimeout(timer);
        resolve();
      };

      const waiting = this.waiters.get(nodeId) ?? [];
      waiting.push(wake);
      this.waiters.set(nodeId, waiting);
    });

    return this.takePunches(nodeId);
  }

  private removeWaiter(nodeId: string, wake: () => void): void {
    const waiting = (this.waiters.get(nodeId) ?? []).filter((entry) => entry !== wake);
    if (waiting.length > 0) {
      this.waiters.set(nodeId, waiting);
    } else {
      this.waiters.delete(nodeId);
    }
  }

  /* ---------------------------------------------------------------- reporting */

  /** Remember that a grant was issued, so its report can be matched to it. */
  recordGrant(input: {
    nonce: string;
    nodeId: string;
    userId: string;
    gameId: string;
    /** Where the client said it could be reached, for the tunnel map. */
    clientAddress?: string | null;
  }): void {
    this.db
      .insert(meshTransfers)
      .values({
        nonce: input.nonce,
        nodeId: input.nodeId,
        userId: input.userId,
        gameId: input.gameId,
      })
      .run();

    this.live.set(input.nonce, {
      nonce: input.nonce,
      nodeId: input.nodeId,
      userId: input.userId,
      gameId: input.gameId,
      via: 'direct',
      openedAt: Date.now(),
      lastReportAt: null,
      previousReportAt: null,
      bytesServed: 0,
      previousBytes: 0,
      clientNetwork: network(input.clientAddress ?? null),
      punches: 0,
    });
    this.pruneLive();
  }

  /**
   * Note that a tunnel went to the relay after failing to connect directly.
   *
   * The same tunnel, not a second one: it is the same account fetching the same
   * game from the same node, and drawing it twice would say the mesh is doing
   * more work than it is. What changes is the route, which is exactly the thing
   * an operator watching the map wants to see — a fleet whose tunnels are all
   * relayed is a fleet paying the coordinator's bandwidth bill after all.
   */
  noteRelayed(nodeId: string, userId: string, gameId: string): void {
    this.relaySessions.push(Date.now());
    // Bounded, and only ever the last day is read.
    const cutoff = Date.now() - 24 * 3_600_000;
    this.relaySessions = this.relaySessions.filter((at) => at >= cutoff).slice(-4_096);

    for (const tunnel of this.live.values()) {
      if (tunnel.nodeId === nodeId && tunnel.userId === userId && tunnel.gameId === gameId) {
        tunnel.via = 'relay';
      }
    }
  }

  /**
   * Record what a node says it served under one grant.
   *
   * Only ever raises the number, and only against a grant this coordinator
   * actually issued. A node that reports twice cannot charge the account twice,
   * and one that reports a smaller number the second time cannot walk a
   * transfer back after the fact.
   */
  reportTransfer(input: { nonce: string; nodeId: string; bytesServed: number }): void {
    const existing = this.db
      .select()
      .from(meshTransfers)
      .where(eq(meshTransfers.nonce, input.nonce))
      .get();

    if (!existing) throw ApiError.notFound('Unknown transfer');
    if (existing.nodeId !== input.nodeId) {
      throw ApiError.forbidden('That transfer belongs to another node');
    }

    const bytes = Math.max(0, Math.floor(input.bytesServed));
    if (bytes <= existing.bytesServed) return;

    const delta = bytes - existing.bytesServed;

    this.db.transaction((tx) => {
      tx.update(meshTransfers)
        .set({ bytesServed: bytes, reportedAt: new Date().toISOString() })
        .where(eq(meshTransfers.nonce, input.nonce))
        .run();

      tx.update(meshNodes)
        .set({ bytesServed: sql`${meshNodes.bytesServed} + ${delta}` })
        .where(eq(meshNodes.id, input.nodeId))
        .run();
    });

    const tunnel = this.live.get(input.nonce);
    if (tunnel) {
      tunnel.previousBytes = tunnel.bytesServed;
      tunnel.previousReportAt = tunnel.lastReportAt;
      tunnel.bytesServed = bytes;
      tunnel.lastReportAt = Date.now();
    }
  }

  /**
   * Bytes served to one account by nodes since a given instant.
   *
   * `BandwidthService` counts what flowed through the server. Once transfers go
   * direct, that number stops being the whole story, and a quota that only sees
   * half the traffic is not a quota. This is the other half.
   */
  bytesServedToUserSince(userId: string, since: string): number {
    const row = this.db
      .select({ bytes: sql<number>`coalesce(sum(${meshTransfers.bytesServed}), 0)` })
      .from(meshTransfers)
      .where(and(eq(meshTransfers.userId, userId), gte(meshTransfers.issuedAt, since)))
      .get();
    return Number(row?.bytes ?? 0);
  }

  /* ---------------------------------------------------------------- tunnels */

  /**
   * Every tunnel this coordinator currently believes is open.
   *
   * In memory and deliberately so. A tunnel exists for minutes, is worthless
   * once it closes, and the only durable thing about it — how many bytes it
   * moved — is already a row in `mesh_transfers`. Writing the live view to disk
   * would be the busiest thing on this server in service of data nobody reads
   * twice, and losing it on a restart costs a map that fills itself in again
   * within one heartbeat.
   */
  private readonly live = new Map<string, LiveTunnel>();

  /** When the relay was asked to carry a transfer, for the last day. */
  private relaySessions: number[] = [];

  /**
   * Drop tunnels nothing has been heard about, and cap the rest.
   *
   * The cap is what stops a busy evening turning this into a leak: the map
   * shows what is happening now, and a hundred tunnels is already more than
   * anybody reads off a diagram.
   */
  private pruneLive(): void {
    const cutoff = Date.now() - MESH_TUNNEL_IDLE_SECONDS * 1000;
    for (const [nonce, tunnel] of this.live) {
      if ((tunnel.lastReportAt ?? tunnel.openedAt) < cutoff) this.live.delete(nonce);
    }

    const CAP = 256;
    if (this.live.size <= CAP) return;
    const oldest = [...this.live.entries()]
      .sort((a, b) => (a[1].lastReportAt ?? a[1].openedAt) - (b[1].lastReportAt ?? b[1].openedAt))
      .slice(0, this.live.size - CAP);
    for (const [nonce] of oldest) this.live.delete(nonce);
  }

  /**
   * The map: the nodes, the relay, and the tunnels currently strung between
   * them.
   *
   * Everything here is the coordinator's belief rather than a measurement. A
   * direct transfer never crosses this machine, so what it knows is what the
   * node last said on its heartbeat — and the map carries the timestamp so it
   * can say "twelve seconds ago" instead of implying it is watching the wire.
   */
  tunnelMap(options: { relay: string | null; label: string }): MeshTunnelMap {
    this.pruneLive();

    const nodes = this.db.select().from(meshNodes).all();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const endpoints = this.endpointsFor(nodes.map((node) => node.id));

    const counts = new Map<string, number>();
    for (const row of this.db
      .select({ nodeId: meshNodeGames.nodeId, count: sql<number>`count(*)` })
      .from(meshNodeGames)
      .groupBy(meshNodeGames.nodeId)
      .all()) {
      counts.set(row.nodeId, Number(row.count));
    }

    const names = this.namesFor(
      [...this.live.values()].map((tunnel) => tunnel.userId),
      [...this.live.values()].map((tunnel) => tunnel.gameId),
    );

    const tunnels: MeshTunnel[] = [];
    for (const tunnel of this.live.values()) {
      const node = byId.get(tunnel.nodeId);
      if (!node) continue;

      const elapsed =
        tunnel.lastReportAt && tunnel.previousReportAt
          ? (tunnel.lastReportAt - tunnel.previousReportAt) / 1000
          : 0;
      const moved = tunnel.bytesServed - tunnel.previousBytes;

      tunnels.push({
        id: tunnel.nonce,
        nodeId: tunnel.nodeId,
        nodeLabel: node.label,
        nodeRole: node.role,
        userId: tunnel.userId,
        username: names.users.get(tunnel.userId) ?? null,
        gameId: tunnel.gameId,
        gameTitle: names.games.get(tunnel.gameId) ?? null,
        via: tunnel.via,
        state: tunnelState(tunnel),
        openedAt: new Date(tunnel.openedAt).toISOString(),
        lastReportAt: tunnel.lastReportAt ? new Date(tunnel.lastReportAt).toISOString() : null,
        bytesServed: tunnel.bytesServed,
        bytesPerSecond: elapsed > 0 && moved > 0 ? Math.round(moved / elapsed) : null,
        clientNetwork: tunnel.clientNetwork,
        punches: tunnel.punches,
      });
    }

    // Busiest first: a map with thirty tunnels on it is read from the top.
    tunnels.sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0));

    return {
      generatedAt: new Date().toISOString(),
      coordinator: { label: options.label, relay: options.relay },
      nodes: nodes.map((node) => ({
        id: node.id,
        label: node.label,
        role: node.role,
        status: node.status,
        address: preferredAddress(endpoints.get(node.id) ?? []),
        lastSeenAt: node.lastSeenAt,
        gameCount: counts.get(node.id) ?? 0,
        bytesServed: node.bytesServed,
      })),
      tunnels,
    };
  }

  /** Usernames and game titles for the ids a map is about to draw. */
  private namesFor(userIds: string[], gameIds: string[]) {
    const uniqueUsers = [...new Set(userIds.filter(Boolean))];
    const uniqueGames = [...new Set(gameIds.filter(Boolean))];

    const userNames = new Map<string, string>();
    if (uniqueUsers.length > 0) {
      for (const row of this.db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, uniqueUsers))
        .all()) {
        userNames.set(row.id, row.username);
      }
    }

    const gameNames = new Map<string, string>();
    if (uniqueGames.length > 0) {
      for (const row of this.db
        .select({ id: games.id, title: games.title })
        .from(games)
        .where(inArray(games.id, uniqueGames))
        .all()) {
        gameNames.set(row.id, row.title);
      }
    }

    return { users: userNames, games: gameNames };
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
  analytics(options: { days: number; relay: string | null }): MeshAnalytics {
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

    const originBytes = (from: string) =>
      Number(
        this.db
          .select({ bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)` })
          .from(downloadEvents)
          .where(gte(downloadEvents.startedAt, from))
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
    const delivered = mesh7d + origin7d;

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

    this.pruneLive();
    const relayCutoff = Date.now() - day;

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
        peers: nodes.filter((node) => node.role === 'peer').length,
      },
      bytes: {
        meshLifetime: lifetime,
        mesh24h: meshBytes(since(day)),
        mesh7d,
        origin24h: originBytes(since(day)),
        origin7d,
        meshShare: delivered > 0 ? mesh7d / delivered : 0,
      },
      coverage: {
        games: catalogGames,
        covered,
        singleSource,
        uncovered: Math.max(0, catalogGames - covered),
      },
      relay: {
        configured: options.relay !== null,
        address: options.relay,
        sessions24h: this.relaySessions.filter((at) => at >= relayCutoff).length,
        activeSessions: [...this.live.values()].filter((tunnel) => tunnel.via === 'relay').length,
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

    this.pruneLive();
    const activeByNode = new Map<string, number>();
    for (const tunnel of this.live.values()) {
      activeByNode.set(tunnel.nodeId, (activeByNode.get(tunnel.nodeId) ?? 0) + 1);
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
      };
    });
  }

  listNodes(): MeshNodeInfo[] {
    const rows = this.db.select().from(meshNodes).orderBy(desc(meshNodes.createdAt)).all();
    const endpoints = this.endpointsFor(rows.map((node) => node.id));

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
      endpoints: endpoints.get(node.id) ?? [],
      lastSeenAt: node.lastSeenAt,
      bytesServed: node.bytesServed,
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

  /** Peer nodes an account has left behind, cleaned up when it signs out. */
  dropPeersFor(ownerId: string): void {
    this.db
      .delete(meshNodes)
      .where(and(eq(meshNodes.ownerId, ownerId), eq(meshNodes.role, 'peer')))
      .run();
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
      for (const endpoint of endpoints.slice(0, 4)) {
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

  private endpointsFor(nodeIds: string[]): Map<string, MeshEndpoint[]> {
    const byNode = new Map<string, MeshEndpoint[]>();
    if (nodeIds.length === 0) return byNode;

    for (let offset = 0; offset < nodeIds.length; offset += 500) {
      const batch = nodeIds.slice(offset, offset + 500);
      for (const row of this.db
        .select()
        .from(meshNodeEndpoints)
        .where(inArray(meshNodeEndpoints.nodeId, batch))
        .all()) {
        const list = byNode.get(row.nodeId) ?? [];
        list.push({ kind: row.kind, address: row.address, port: row.port });
        byNode.set(row.nodeId, list);
      }
    }

    return byNode;
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

/**
 * One tunnel as this coordinator tracks it, in memory.
 *
 * Times are epoch milliseconds rather than ISO strings: every one of them is
 * compared or subtracted, and parsing a string back on each pass of a map that
 * refreshes every couple of seconds is work for nothing.
 */
interface LiveTunnel {
  nonce: string;
  nodeId: string;
  userId: string;
  gameId: string;
  via: 'direct' | 'relay';
  openedAt: number;
  lastReportAt: number | null;
  previousReportAt: number | null;
  bytesServed: number;
  previousBytes: number;
  clientNetwork: string | null;
  punches: number;
}

/**
 * What a tunnel is doing, from the little the coordinator can see.
 *
 * `connecting` is a grant issued and nothing reported yet — the handshake is
 * either in progress or it failed, and from here those look the same for the
 * first half-minute. `transferring` is bytes having moved since the previous
 * report. `idle` is a tunnel that reported once and has not since: a paused
 * download, a finished one, or a client that vanished.
 */
function tunnelState(tunnel: LiveTunnel): MeshTunnel['state'] {
  if (tunnel.lastReportAt === null) return 'connecting';
  if (tunnel.bytesServed > tunnel.previousBytes) return 'transferring';
  return 'idle';
}

/**
 * An address reduced to the network it is on.
 *
 * A tunnel map is left open on a screen, and a player's full address is not
 * something to put on one. Two octets of an IPv4 address, or the first three
 * groups of an IPv6 one, is enough to tell two players apart and to see that
 * somebody is on the same LAN as the node they are pulling from — which is the
 * only thing the map uses it for.
 */
function network(address: string | null): string | null {
  if (!address) return null;

  if (address.includes(':')) {
    const groups = address.split(':').filter(Boolean).slice(0, 3);
    return groups.length > 0 ? `${groups.join(':')}::/48` : null;
  }

  const octets = address.split('.');
  if (octets.length !== 4) return null;
  return `${octets[0]}.${octets[1]}.x.x`;
}

/**
 * The address worth putting on a node's marker.
 *
 * The observed one first: it is what the coordinator saw the node arrive from,
 * so it is the one that means something to somebody looking at a map from
 * outside the LAN. A local address is better than nothing when there is no
 * other.
 */
function preferredAddress(endpoints: MeshEndpoint[]): string | null {
  const observed = endpoints.find((endpoint) => endpoint.kind === 'observed');
  const chosen = observed ?? endpoints[0];
  return chosen ? `${chosen.address}:${chosen.port}` : null;
}
