import {
  MESH_CHUNK_BYTES,
  MESH_HEARTBEAT_INTERVAL_SECONDS,
  MESH_TRANSFER_POLL_SECONDS,
  meshEnrolmentSchema,
  meshHeartbeatSchema,
  meshRegisterSchema,
  reportedCatalogBatchSchema,
  reportedCatalogSchema,
} from '@gameblade/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin } from '../auth/middleware.js';
import { gameFiles, games, meshNodes } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

/**
 * A node catalog contains paths and chunk hashes for an entire archive.
 *
 * The ordinary API limit is 1 MiB, which is appropriate for interactive
 * requests and far below a real catalog: a few hundred thousand files can
 * describe tens of megabytes without carrying a single byte of game data.
 */
const MAX_NODE_CATALOG_BYTES = 128 * 1024 * 1024;

/** An abandoned multi-request report is harmless and should not live forever. */
const CATALOG_BATCH_SESSION_TTL_MS = 60 * 60_000;

async function readChunkUpload(body: unknown): Promise<Buffer> {
  const stream = body as NodeJS.ReadableStream | undefined;
  if (!stream || !(Symbol.asyncIterator in stream)) {
    throw ApiError.badRequest('A binary chunk body is required');
  }

  const pieces: Buffer[] = [];
  let received = 0;
  for await (const piece of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    const bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    received += bytes.length;
    if (received > MESH_CHUNK_BYTES) {
      throw ApiError.badRequest('A Node chunk cannot exceed the configured chunk size');
    }
    pieces.push(bytes);
  }
  return Buffer.concat(pieces, received);
}

interface CatalogBatchSession {
  nextIndex: number;
  seen: Set<string>;
  startedAt: number;
  result: { added: number; updated: number; unchanged: number; missing: number };
}

export async function meshRoutes(app: FastifyInstance): Promise<void> {
  const { db, mesh, settings, chunks, catalogIngest } = app.gameblade;

  // In memory on purpose. A coordinator restart between pieces makes the next
  // piece fail safely and the node retries the whole report; persisting partial
  // catalog state would make a half-finished report survive the process that
  // knew how to finish it.
  const catalogBatchSessions = new Map<string, CatalogBatchSession>();

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

  /** A one-use challenge for a known node recovering its credential. */
  app.get('/mesh/register/challenge', async (request) => {
    const { publicKey } = request.query as { publicKey?: string };
    const key = publicKey?.trim() ?? '';
    if (key.length < 32 || key.length > 200) {
      throw ApiError.badRequest('A valid node public key is required');
    }
    return mesh.createRegistrationChallenge(key);
  });

  /**
   * Turn an enrolment code into a node, or re-register one that already exists.
   *
   * The response carries the coordinator's public key, which is everything the
   * node needs to check the grants clients present and nothing it needs to mint
   * one.
   */
  app.post('/mesh/register', async (request) => {
    const body = meshRegisterSchema.parse(request.body);

    const { nodeId, status, nodeToken } = mesh.register({ ...body, endpoints: [] });

    settings.enableMeshWhenUnconfigured();

    return {
      nodeId,
      status,
      // Returned exactly once. Only its hash is stored, so an agent that loses
      // it re-registers with its key rather than recovering it.
      nodeToken,
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
      endpoints: [],
      games: body.games,
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
    const { nodeId } = requireNode(request);
    const node = db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();

    /*
     * Scoped to the library this node was assigned, when it has one.
     *
     * A node with a library is one that reports its own catalog, and the only
     * games it can possibly hold are the ones in it. Sending the whole
     * database meant a node fetched every other node's games too, checked its
     * own disk for each of them, and found nothing — a stat of every file of
     * every game on somebody else's machine, on a timer, for ever.
     *
     * A node with no library is a mirror, which syncs against everything on
     * purpose, so that case is unchanged.
     */
    const scoped = node?.libraryId
      ? and(eq(games.libraryId, node.libraryId), isNull(games.missingAt))
      : isNull(games.missingAt);

    const rows = db
      .select({
        id: games.id,
        title: games.title,
        relPath: games.relPath,
        sizeBytes: games.sizeBytes,
      })
      .from(games)
      .where(scoped)
      .all();

    return {
      games: rows
        .filter((game) => chunks.isGameChunked(game.id))
        .map((game) => ({
          gameId: game.id,
          title: game.title,
          // How a node recognises one of these as a game it holds. It knows
          // its own catalog by relative path and nothing else — ids are the
          // coordinator's, and it has never seen them.
          relPath: game.relPath,
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
   * A node reporting the library it scanned.
   *
   * This is the direction that makes a coordinator possible at all: when the
   * games are on somebody else's disk, the catalog has to come to the database
   * rather than the database going to look for it.
   */
  app.post('/mesh/catalog', {
    bodyLimit: MAX_NODE_CATALOG_BYTES,
    // A full library report is large and infrequent; the abuse limiter reads
    // it as something to throttle.
    config: { rateLimit: false },
    handler: async (request) => {
      const { nodeId } = requireNode(request);
      const body = reportedCatalogSchema.parse(request.body);

      settings.enableMeshWhenUnconfigured();

      return catalogIngest.ingest(nodeId, body.games, { complete: body.complete });
    },
  });

  /**
   * A large catalog, accepted in bounded pieces.
   *
   * Each piece is ingested as a partial report. Only the final one may mark old
   * rows missing, and it does so against every path accumulated for this report,
   * not merely the games in its own request body.
   */
  app.post('/mesh/catalog/batch', {
    bodyLimit: MAX_NODE_CATALOG_BYTES,
    config: { rateLimit: false },
    handler: async (request) => {
      const { nodeId } = requireNode(request);
      const body = reportedCatalogBatchSchema.parse(request.body);
      const now = Date.now();

      for (const [key, session] of catalogBatchSessions) {
        if (now - session.startedAt > CATALOG_BATCH_SESSION_TTL_MS) {
          catalogBatchSessions.delete(key);
        }
      }

      const key = `${nodeId}:${body.reportId}`;
      let session = catalogBatchSessions.get(key);
      if (!session) {
        if (body.index !== 0) {
          throw ApiError.conflict(
            'That catalog report expired; start it again from the first batch',
          );
        }

        // The reporter sends one report at a time. Retaining an older report
        // from the same authenticated node would only hold memory until its
        // timeout and let a buggy client accumulate many path sets.
        for (const candidate of catalogBatchSessions.keys()) {
          if (candidate.startsWith(`${nodeId}:`)) catalogBatchSessions.delete(candidate);
        }

        settings.enableMeshWhenUnconfigured();
        session = {
          nextIndex: 0,
          seen: new Set(),
          startedAt: now,
          result: { added: 0, updated: 0, unchanged: 0, missing: 0 },
        };
        catalogBatchSessions.set(key, session);
      }

      if (body.index !== session.nextIndex) {
        throw ApiError.conflict(
          `Expected catalog batch ${session.nextIndex}, received ${body.index}`,
        );
      }

      for (const game of body.games) session.seen.add(game.relPath);
      const result = catalogIngest.ingest(nodeId, body.games, {
        complete: body.final,
        ...(body.final ? { seenRelPaths: session.seen } : {}),
      });
      session.result.added += result.added;
      session.result.updated += result.updated;
      session.result.unchanged += result.unchanged;
      session.result.missing += result.missing;
      session.nextIndex += 1;

      const response = {
        ...session.result,
        entries: session.seen.size,
        batches: session.nextIndex,
        complete: body.final,
      };
      if (body.final) catalogBatchSessions.delete(key);
      return response;
    },
  });

  /**
   * A Node holds this authenticated outbound HTTPS poll
   * open; the Coordinator answers immediately when one or more Desktop ranges
   * need bytes from that node.
   */
  app.get('/mesh/transfers/poll', async (request) => {
    const { nodeId } = requireNode(request);
    const jobs = await mesh.waitForNodeChunks(nodeId, MESH_TRANSFER_POLL_SECONDS * 1000);
    return { jobs };
  });

  app.post('/mesh/transfers/:requestId', async (request) => {
    const { nodeId } = requireNode(request);
    const { requestId } = request.params as { requestId: string };
    const bytes = await readChunkUpload(request.body);
    mesh.deliverNodeChunk(requestId, nodeId, bytes);
    return { ok: true };
  });

  app.post('/mesh/transfers/:requestId/fail', async (request) => {
    const { nodeId } = requireNode(request);
    const { requestId } = request.params as { requestId: string };
    const body = (request.body ?? {}) as { message?: string };
    mesh.failNodeChunk(requestId, nodeId, body.message?.slice(0, 300) || 'Node could not read it');
    return { ok: true };
  });

  /* ----------------------------------------------------------------- admin */

  app.get('/mesh/nodes', async (request) => {
    requireAdmin(request);
    return { nodes: mesh.listNodeStats(), enrolments: mesh.listEnrolments() };
  });

  /** How much download traffic the Node fleet supplies. */
  app.get('/mesh/analytics', async (request) => {
    requireAdmin(request);
    const { days } = request.query as { days?: string };
    return mesh.analytics({ days: Number(days) || 14 });
  });

  app.post('/mesh/enrolments', async (request) => {
    const context = requireAdmin(request);
    const body = meshEnrolmentSchema.parse(request.body);

    // Shown once. Only the hash is kept, so losing it means minting another.
    return mesh.createEnrolment({
      label: body.label,
      role: body.role,
      libraryId: body.libraryId ?? null,
      createdBy: context.user.id,
    });
  });

  app.delete('/mesh/enrolments/:tokenHash', async (request) => {
    requireAdmin(request);
    const { tokenHash } = request.params as { tokenHash: string };
    mesh.revokeEnrolment(tokenHash);
    return { ok: true };
  });

  /**
   * Say which library a node's catalog reports belong to.
   *
   * Deliberately an explicit administrative act. Reports are matched into a
   * library by relative path, so pointing a node at the library its games are
   * already in updates those rows and every game keeps its id. Pointing it at a
   * new one would re-add the whole catalog as strangers and orphan every
   * achievement and save rule attached to the originals — so this is never
   * inferred, and reports are refused until it is set.
   */
  app.post('/mesh/nodes/:nodeId/library', async (request) => {
    requireAdmin(request);
    const { nodeId } = request.params as { nodeId: string };
    const { libraryId } = (request.body ?? {}) as { libraryId?: string | null };

    mesh.assignLibrary(nodeId, libraryId ?? null);
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

  app.patch('/mesh/nodes/:nodeId', async (request) => {
    requireAdmin(request);
    const { nodeId } = request.params as { nodeId: string };
    const { label } = (request.body ?? {}) as { label?: string };
    mesh.renameNode(nodeId, label ?? '');
    return { ok: true };
  });

  app.delete('/mesh/nodes/:nodeId', async (request) => {
    requireAdmin(request);
    const { nodeId } = request.params as { nodeId: string };
    mesh.removeNode(nodeId);
    return { ok: true };
  });
}
