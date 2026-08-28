import { createHash } from 'node:crypto';
import {
  MESH_HEARTBEAT_TIMEOUT_SECONDS,
  MESH_MAX_SOURCES_PER_GAME,
  MESH_PUNCH_TTL_SECONDS,
  type MeshPunchRequest,
  type MeshEndpoint,
  type MeshNodeInfo,
  type MeshNodeRole,
  type MeshSource,
} from '@gameblade/shared';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  gameFiles,
  libraries,
  meshEnrollments,
  meshNodeEndpoints,
  meshNodeGames,
  meshNodes,
  meshTransfers,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { hashToken, newId, newToken, safeEqual } from '../lib/ids.js';
import type { Logger } from './metadata/service.js';

/** How long an unused enrolment code stays good for. */
const ENROLMENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface RegisterInput {
  enrolmentToken: string;
  publicKey: string;
  agentVersion?: string;
  endpoints: MeshEndpoint[];
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
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /* --------------------------------------------------------------- enrolment */

  /**
   * Mint a one-time code that turns a machine into a node.
   *
   * Returned in plaintext exactly once. Only the hash is stored, so an operator
   * who loses the code generates another rather than recovering it — the same
   * posture as every other credential in this system.
   */
  createEnrolment(options: { label: string; role: MeshNodeRole; createdBy: string }): {
    token: string;
    expiresAt: string;
  } {
    const token = newToken(24);
    const expiresAt = new Date(Date.now() + ENROLMENT_TTL_MS).toISOString();

    this.db
      .insert(meshEnrollments)
      .values({
        tokenHash: hashToken(token),
        label: options.label,
        role: options.role,
        createdBy: options.createdBy,
        expiresAt,
      })
      .run();

    return { token, expiresAt };
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
      tx.insert(meshNodes)
        .values({
          id: nodeId,
          label: enrolment.label,
          role: enrolment.role,
          status: 'online',
          publicKey: input.publicKey,
          tokenHash: hashToken(nodeToken),
          agentVersion: input.agentVersion ?? null,
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
  sourcesFor(
    gameId: string,
    options: { chunked: boolean; excludeOwnerId?: string; originAvailable?: boolean },
  ): MeshSource[] {
    const sources: MeshSource[] =
      options.originAvailable === false ? [] : [{ kind: 'origin', label: 'Origin', priority: 100 }];

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
  recordGrant(input: { nonce: string; nodeId: string; userId: string; gameId: string }): void {
    this.db
      .insert(meshTransfers)
      .values({
        nonce: input.nonce,
        nodeId: input.nodeId,
        userId: input.userId,
        gameId: input.gameId,
      })
      .run();
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

  /* ------------------------------------------------------------ administration */

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
