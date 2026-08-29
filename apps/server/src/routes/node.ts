import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { renderNodePage } from './nodePage.js';

/**
 * What setup accepts, and nothing else.
 *
 * The URL is parsed rather than trusted as a string so a typo is refused here
 * rather than becoming a node that retries an unresolvable host for ever, and
 * the scheme list is what stops `file:` or anything else exotic being written
 * into a field two processes later hand to an HTTP client.
 */
const setupSchema = z.object({
  coordinatorUrl: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    }, 'Enter the coordinator’s full address, e.g. https://games.example.com'),
  enrolmentToken: z.string().trim().min(1).max(512),
});

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

  /**
   * Point this node at a coordinator, once.
   *
   * The one thing on a node a request may change, and it exists because the
   * alternative is worse: without it, joining a node to a coordinator means
   * editing a compose file on the machine holding the games and restarting the
   * container, for two values that are only ever entered once. That is a poor
   * trade for an operator and a genuinely bad one for anybody setting this up
   * for the first time.
   *
   * Bounded exactly like the coordinator's own first-run administrator screen,
   * which is the same shape of problem — a privileged action that has to be
   * possible before there is anybody to authenticate:
   *
   * * It works only while this node is not enrolled. After that it is gone, so
   *   an enrolled node is back to having nothing a request can alter.
   * * It grants nothing by itself. The enrolment code is checked by the
   *   coordinator, not here; a wrong one produces a node that fails to
   *   register, which is exactly what a wrong one in an environment variable
   *   produces.
   * * The page it belongs to is bound to localhost by default and is meant to
   *   stay off the public internet either way.
   *
   * The values go into the shared state file rather than into this process,
   * because the mesh agent alongside is the half that registers and it reads
   * the same file. Writing there means one answer configures both, and it
   * survives a restart without being in the environment.
   */
  app.post(`${config.basePath}/api/node/setup`, async (request, reply) => {
    const current = await nodeStatus.snapshot();
    if (current.enrolled) {
      throw ApiError.conflict(
        'This node is already enrolled. Remove it in Admin → Settings → Nodes and delete node-state.json to start again.',
      );
    }

    const input = setupSchema.parse(request.body);

    // Read, merge, write. The agent owns the key in this file and may be
    // generating it right now; replacing the file wholesale would lose it and
    // this node would enrol twice under two identities.
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(await readFile(config.nodeStatePath, 'utf8')) as Record<string, unknown>;
    } catch {
      // No file yet is the ordinary first run.
    }

    state.coordinatorUrl = input.coordinatorUrl.replace(/\/+$/, '');
    state.enrolmentToken = input.enrolmentToken;

    await mkdir(path.dirname(config.nodeStatePath), { recursive: true });
    await writeFile(config.nodeStatePath, JSON.stringify(state, null, 2), 'utf8');

    app.log.info(
      { coordinator: state.coordinatorUrl },
      'this node was pointed at a coordinator from its setup page',
    );

    return reply.code(202).send({ accepted: true, coordinatorUrl: state.coordinatorUrl });
  });

  app.get(config.basePath === '' ? '/' : config.basePath, async (_request, reply) => send(reply));

  // Anything else is somebody looking for the panel, which is not here. The
  // page says where it is, so this is more useful than a bare 404.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith(`${config.basePath}/api`)) {
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: 'A node serves /api/health, /api/node/status and /api/node/setup only',
        },
      });
    }
    return send(reply.code(404));
  });
}
