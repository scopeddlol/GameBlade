import type { FastifyInstance, FastifyReply } from 'fastify';
import { renderNodePage } from './nodePage.js';

/**
 * What a node serves over HTTP: a page about itself, and the same thing as JSON.
 *
 * Everything else a node does happens somewhere other than this port — it scans
 * local disk, reports upward over HTTPS, and serves game data over QUIC from
 * the agent process beside this one. This exists because a machine that does
 * all of that invisibly is a machine whose only diagnostic is `docker logs`.
 *
 * Deliberately unauthenticated, and deliberately given nothing worth
 * authenticating: counts, paths that are already in the compose file, and
 * whether the coordinator answered. No game data, no accounts, no keys, and
 * nothing that can be changed from here — a node has no state a request should
 * be able to alter. It is still worth keeping off the public internet, and the
 * compose file binds it to localhost for that reason.
 *
 * Registered instead of the SPA and the whole coordinator API, not alongside
 * them. A node runs its own empty database, so serving the admin bundle would
 * offer a second, wrong panel over it — first-run administrator screen and all.
 */
export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  const { nodeStatus, config } = app.gameblade;

  const send = async (reply: FastifyReply): Promise<FastifyReply> =>
    reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(renderNodePage(await nodeStatus.snapshot()));

  app.get(`${config.basePath}/api/node/status`, async () => nodeStatus.snapshot());

  app.get(config.basePath === '' ? '/' : config.basePath, async (_request, reply) => send(reply));

  // Anything else is somebody looking for the panel, which is not here. The
  // page says where it is, so this is more useful than a bare 404.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith(`${config.basePath}/api`)) {
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: 'A node serves /api/health and /api/node/status only',
        },
      });
    }
    return send(reply.code(404));
  });
}
