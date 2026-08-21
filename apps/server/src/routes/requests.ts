import {
  bugReportSchema,
  collectionGamesSchema,
  collectionSchema,
  createGameRequestSchema,
  gameRequestQuerySchema,
  reorderCollectionsSchema,
} from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/middleware.js';

/**
 * The player-facing halves of two features an administrator also touches:
 * asking for a game, and grouping the ones you have.
 *
 * Both live here rather than in `admin.ts` because they are used from the
 * desktop client by ordinary accounts. The operator's side of requests — who
 * asked, and deciding — stays behind the admin scope.
 */
export async function requestRoutes(app: FastifyInstance): Promise<void> {
  const { gameRequests, collections, metadata, bugs } = app.gameblade;

  /* ------------------------------------------------------------------ bugs */

  /**
   * Filing a bug.
   *
   * The diagnostics arrive with it rather than being asked for — a reporter
   * should not need to know their own client version, and a report missing it
   * is one an operator has to chase.
   */
  app.post('/bugs', async (request, reply) => {
    const context = requireUser(request);
    const input = bugReportSchema.parse(request.body);
    reply.code(201);
    return bugs.create(context.user.id, input);
  });

  /** The reports you filed, and where each got to. */
  app.get('/bugs/mine', async (request) => {
    const context = requireUser(request);
    return bugs.mine(context.user.id);
  });

  /* -------------------------------------------------------------- requests */

  /** Everything the client's request panels draw, in one call. */
  app.get('/requests/digest', async (request) => {
    const context = requireUser(request);
    return gameRequests.digest(context.user.id);
  });

  app.get('/requests', async (request) => {
    const context = requireUser(request);
    const query = gameRequestQuerySchema.parse(request.query);
    // Who asked is admin-only; an ordinary account sees titles and counts.
    return gameRequests.list(query, context.user.id, context.user.role === 'admin');
  });

  /**
   * Trending titles to ask for, each already checked against this archive.
   *
   * On its own route rather than folded into the digest: it depends on an
   * external provider and the digest is on the client's cold-start path, so a
   * slow IGDB must not hold up the Home tab.
   */
  app.get('/requests/suggestions', async (request) => {
    const context = requireUser(request);
    const candidates = await metadata.trending(12);
    return gameRequests.suggestions(context.user.id, candidates);
  });

  app.post('/requests', async (request, reply) => {
    const context = requireUser(request);
    const input = createGameRequestSchema.parse(request.body);
    reply.code(201);
    return gameRequests.create(context.user.id, input);
  });

  app.post('/requests/:id/vote', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const votes = gameRequests.vote(context.user.id, id, true);
    return { votes, hasVoted: true };
  });

  app.delete('/requests/:id/vote', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const votes = gameRequests.vote(context.user.id, id, false);
    return { votes, hasVoted: false };
  });

  /* ------------------------------------------------------------ collections */

  app.get('/collections', async (request) => {
    const context = requireUser(request);
    return collections.list(context.user.id);
  });

  app.post('/collections', async (request, reply) => {
    const context = requireUser(request);
    reply.code(201);
    return collections.create(context.user.id, collectionSchema.parse(request.body));
  });

  app.put('/collections/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    return collections.update(context.user.id, id, collectionSchema.parse(request.body));
  });

  app.delete('/collections/:id', async (request, reply) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    collections.remove(context.user.id, id);
    reply.code(204);
  });

  app.post('/collections/reorder', async (request) => {
    const context = requireUser(request);
    const { ids } = reorderCollectionsSchema.parse(request.body);
    collections.reorder(context.user.id, ids);
    return collections.list(context.user.id);
  });

  app.post('/collections/:id/games', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const { gameIds } = collectionGamesSchema.parse(request.body);
    const added = collections.addGames(context.user.id, id, gameIds);
    return { added };
  });

  /**
   * A POST rather than a DELETE: the ids are a list, and the desktop client's
   * IPC bridge has no way to put a body on a DELETE — a query string long
   * enough to hold a selection is how one becomes a 414.
   */
  app.post('/collections/:id/games/remove', async (request, reply) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const { gameIds } = collectionGamesSchema.parse(request.body);
    collections.removeGames(context.user.id, id, gameIds);
    reply.code(204);
  });

  /**
   * Which groups a set of games is already in.
   *
   * A POST because the game ids arrive as a list — a query string long enough
   * to hold a library's worth of ids is how a GET becomes a 414.
   */
  app.post('/collections/membership', async (request) => {
    const context = requireUser(request);
    const { gameIds } = collectionGamesSchema.parse(request.body);
    return collections.membership(context.user.id, gameIds);
  });
}
