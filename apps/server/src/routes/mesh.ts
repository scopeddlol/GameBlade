import {
  MESH_HEARTBEAT_INTERVAL_SECONDS,
  MESH_RENDEZVOUS_POLL_SECONDS,
  meshResolveSchema,
  meshEnrolmentSchema,
  meshHeartbeatSchema,
  meshPeerRegisterSchema,
  meshRegisterSchema,
  meshReportSchema,
} from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin, requireUser } from '../auth/middleware.js';
import { gameFiles, games } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

/**
 * The address a request appears to come from.
 *
 * Behind Pangolin every request arrives from the tunnel, so the forwarded
 * header is the only thing that carries the real client. It is also
 * attacker-controlled in general — which is why this feeds an endpoint
 * *candidate* and nothing else. A wrong value here costs one failed connection
 * attempt; it grants nothing.
 */
function observedAddress(request: FastifyRequest): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = first?.split(',')[0]?.trim() || request.ip;
  if (!candidate) return undefined;

  // Only literals. A hostname would mean resolving names on a node's say-so,
  // and a bracketed IPv6 form would be stored in a shape the agent cannot use.
  return /^[0-9a-fA-F:.]+$/.test(candidate) ? candidate : undefined;
}

export async function meshRoutes(app: FastifyInstance): Promise<void> {
  const { db, mesh, settings, downloadTokens, chunks, bandwidth } = app.gameblade;

  /**
   * Authenticate a node by its id and its enrolment-issued node token.
   *
   * Nodes do not have sessions and must not have accounts: a node is a machine
   * that serves bytes, not a user, and giving it a session would give it the
   * whole API. It presents its node id and the token it was handed at
   * registration.
   */
  function requireNode(request: FastifyRequest): { nodeId: string } {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const nodeId = request.headers['x-gameblade-node'];
    const id = Array.isArray(nodeId) ? nodeId[0] : nodeId;

    if (!token || !id) throw ApiError.unauthorized('Node credentials required');
    return { nodeId: mesh.authenticate(id, token).id };
  }

  /* ------------------------------------------------------------ node-facing */

  /**
   * Turn an enrolment code into a node, or re-register one that already exists.
   *
   * The response carries the coordinator's public key, which is everything the
   * node needs to check the grants clients present and nothing it needs to mint
   * one.
   */
  app.post('/mesh/register', async (request) => {
    const body = meshRegisterSchema.parse(request.body);

    const { nodeId, status, nodeToken } = mesh.register({
      ...body,
      observedAddress: observedAddress(request),
    });

    return {
      nodeId,
      status,
      // Returned exactly once. Only its hash is stored, so an agent that loses
      // it re-registers with its key rather than recovering it.
      nodeToken,
      coordinatorPublicKey: downloadTokens.publicKeyBase64(),
      heartbeatSeconds: MESH_HEARTBEAT_INTERVAL_SECONDS,
    };
  });

  /**
   * Stay alive, refresh addresses, and say what this node holds.
   *
   * Also the node's own clock: the response says how soon to come back, so the
   * interval can be changed centrally without redeploying agents.
   */
  app.post('/mesh/heartbeat', async (request) => {
    const { nodeId } = requireNode(request);
    const body = meshHeartbeatSchema.parse(request.body);

    const result = mesh.heartbeat({
      nodeId,
      endpoints: body.endpoints,
      games: body.games,
      observedAddress: observedAddress(request),
    });

    return { ...result, heartbeatSeconds: MESH_HEARTBEAT_INTERVAL_SECONDS };
  });

  /**
   * What the coordinator believes a node should be holding.
   *
   * A mirror syncs against this: every game with chunk hashes, plus the
   * fingerprint to announce once its copy matches. Games without chunk hashes
   * are omitted because a mirror could not prove its copy of one is right.
   */
  app.get('/mesh/catalog', async (request) => {
    requireNode(request);

    const rows = db
      .select({ id: games.id, title: games.title, sizeBytes: games.sizeBytes })
      .from(games)
      .all();

    return {
      games: rows
        .filter((game) => chunks.isGameChunked(game.id))
        .map((game) => ({
          gameId: game.id,
          title: game.title,
          sizeBytes: game.sizeBytes,
          contentHash: mesh.contentHashFor(game.id),
        }))
        .filter((game) => game.contentHash !== null),
    };
  });

  /**
   * The file layout of one game, for a node that has to serve pieces of it.
   *
   * Node-facing rather than reusing the client manifest, and deliberately
   * carrying no download token: a node serves bytes it already holds and has no
   * business being handed authority to fetch them from here.
   */
  app.get('/mesh/catalog/:gameId', async (request) => {
    requireNode(request);
    const { gameId } = request.params as { gameId: string };

    const game = db.select().from(games).where(eq(games.id, gameId)).get();
    if (!game) throw ApiError.notFound('Game not found');

    if (!chunks.isGameChunked(gameId)) {
      // Not an error: a node simply cannot serve a game whose pieces nobody can
      // verify, so there is nothing useful to send.
      throw ApiError.gone('That game has no chunk hashes yet');
    }

    const files = db.select().from(gameFiles).where(eq(gameFiles.gameId, gameId)).all();
    const byFile = chunks.chunksForGame(gameId);

    return {
      gameId,
      kind: game.kind,
      /** Relative to the library root, which is where a node's copy begins. */
      relPath: game.relPath,
      contentHash: mesh.contentHashFor(gameId),
      files: files.map((file) => ({
        id: file.id,
        path: file.relPath,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        chunks: byFile.get(file.id) ?? [],
      })),
    };
  });

  /**
   * Report what was actually served under a grant.
   *
   * This is what keeps a byte allowance honest once transfers stop passing
   * through the server. A node that stops reporting is a node whose grants stop
   * being renewed, so under-reporting buys a node nothing.
   */
  app.post('/mesh/report', async (request) => {
    const { nodeId } = requireNode(request);
    const body = meshReportSchema.parse(request.body);

    mesh.reportTransfer({ nonce: body.nonce, nodeId, bytesServed: body.bytesServed });
    return { ok: true };
  });

  /**
   * Wait to be told to punch toward a client.
   *
   * Held open rather than polled on a timer, because the whole value is in
   * being immediate: a client asks, the node punches within milliseconds, and
   * both ends' packets cross while the mappings are fresh. A poll every few
   * seconds would mean the client had given up and fallen back to HTTP long
   * before the node heard.
   *
   * A long-poll rather than a WebSocket because it survives any proxy
   * unchanged, needs no upgrade negotiation, and there is exactly one message
   * shape to carry.
   */
  app.get('/mesh/rendezvous', {
    // A node holds this open continuously by design; the abuse limiter would
    // read a well-behaved agent as a flood.
    config: { rateLimit: false },
    handler: async (request) => {
      const { nodeId } = requireNode(request);

      const punches = await mesh.waitForPunch(nodeId, MESH_RENDEZVOUS_POLL_SECONDS * 1000);
      return { punches, pollSeconds: MESH_RENDEZVOUS_POLL_SECONDS };
    },
  });

  /* ---------------------------------------------------------- client-facing */

  /**
   * Ask where a game can be fetched from, and get permission to fetch it.
   *
   * One call rather than two: a client that has been told about a node has
   * nothing to do with that knowledge without a grant, and a grant is only
   * meaningful for a node it was told about.
   */
  app.post('/mesh/resolve/:gameId', async (request) => {
    const context = requireUser(request);
    const { gameId } = request.params as { gameId: string };

    if (!settings.get().meshEnabled) {
      // Not an error: the client's answer is "use the origin", which is what an
      // empty node list already says.
      return { nodes: [], grants: [], coordinatorPublicKey: downloadTokens.publicKeyBase64() };
    }

    const game = db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get();
    if (!game) throw ApiError.notFound('Game not found');

    // Refused up front rather than by a node mid-transfer: an account out of
    // allowance should be told so, not handed a grant that dies at zero bytes.
    const quota = bandwidth.assertWithinQuota(context.user.id);

    const nodes = mesh.nodesForGame(gameId, { excludeOwnerId: context.user.id });

    // Tell every candidate node to punch toward this client, now.
    //
    // The client's own reflexive address is what it sends here, and it is the
    // only usable one: the address this HTTP request arrived from belongs to a
    // TCP connection through a different NAT mapping on a different port.
    // Punching at that would open a hole nothing uses.
    const candidates = meshResolveSchema.parse(request.body ?? {}).endpoints;
    const queuedAt = new Date().toISOString();

    for (const node of nodes) {
      for (const candidate of candidates) {
        mesh.requestPunch(node.id, {
          address: candidate.address,
          port: candidate.port,
          userId: context.user.id,
          queuedAt,
        });
      }
    }

    // The ceiling on one grant. With no quota configured this is still bounded,
    // because an unbounded grant would be a permanent credential if it leaked.
    const ceiling =
      quota.quotaBytes > 0 ? Math.max(0, quota.remainingBytes) : 512 * 1024 * 1024 * 1024;

    const grants = nodes.map((node) => {
      const issued = downloadTokens.issueGrant({
        userId: context.user.id,
        gameId,
        nodeId: node.id,
        maxBytes: ceiling,
      });
      mesh.recordGrant({
        nonce: issued.nonce,
        nodeId: node.id,
        userId: context.user.id,
        gameId,
      });
      return { nodeId: node.id, grant: issued.grant, expiresAt: issued.expiresAt };
    });

    return {
      nodes: nodes.map((node) => ({
        id: node.id,
        label: node.label,
        role: node.role,
        publicKey: node.publicKey,
        endpoints: node.endpoints,
      })),
      grants,
      coordinatorPublicKey: downloadTokens.publicKeyBase64(),
    };
  });

  /**
   * Offer this client as a peer node for what it already holds.
   *
   * Gated on the seeding setting rather than the mesh setting, because they are
   * different decisions: one shares the operator's machines, the other turns
   * players into distributors of each other's downloads.
   */
  app.post('/mesh/peer', async (request) => {
    const context = requireUser(request);
    if (!settings.get().meshSeedingEnabled) {
      throw ApiError.forbidden('Peer sharing is turned off on this server');
    }

    const body = meshPeerRegisterSchema.parse(request.body);
    const { nodeId, nodeToken } = mesh.registerPeer({
      ...body,
      ownerId: context.user.id,
      observedAddress: observedAddress(request),
    });

    return { nodeId, nodeToken, heartbeatSeconds: MESH_HEARTBEAT_INTERVAL_SECONDS };
  });

  /** Stop seeding — on sign-out, or when someone turns the setting off. */
  app.delete('/mesh/peer', async (request) => {
    const context = requireUser(request);
    mesh.dropPeersFor(context.user.id);
    return { ok: true };
  });

  /* ----------------------------------------------------------------- admin */

  app.get('/mesh/nodes', async (request) => {
    requireAdmin(request);
    return { nodes: mesh.listNodes(), enrolments: mesh.listEnrolments() };
  });

  app.post('/mesh/enrolments', async (request) => {
    const context = requireAdmin(request);
    const body = meshEnrolmentSchema.parse(request.body);

    // Shown once. Only the hash is kept, so losing it means minting another.
    return mesh.createEnrolment({ ...body, createdBy: context.user.id });
  });

  app.delete('/mesh/enrolments/:tokenHash', async (request) => {
    requireAdmin(request);
    const { tokenHash } = request.params as { tokenHash: string };
    mesh.revokeEnrolment(tokenHash);
    return { ok: true };
  });

  app.post('/mesh/nodes/:nodeId/status', async (request) => {
    requireAdmin(request);
    const { nodeId } = request.params as { nodeId: string };
    const { status } = (request.body ?? {}) as { status?: string };

    if (status !== 'online' && status !== 'blocked') {
      throw ApiError.badRequest('Status must be "online" or "blocked"');
    }

    mesh.setNodeStatus(nodeId, status);
    return { ok: true };
  });

  app.delete('/mesh/nodes/:nodeId', async (request) => {
    requireAdmin(request);
    const { nodeId } = request.params as { nodeId: string };
    mesh.removeNode(nodeId);
    return { ok: true };
  });
}
