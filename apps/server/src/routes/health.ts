import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { VERSION } from '../lib/version.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.gameblade;

  /**
   * Unauthenticated liveness probe for Docker and the reverse proxy. It touches
   * the database so a container with a corrupt or locked volume reports unhealthy
   * rather than sitting there accepting requests it cannot serve.
   *
   * It also names the role, because a deployment is now three containers that
   * answer this identically and an operator checking one has no other way to
   * tell which one they reached.
   */
  app.get('/health', async (_request, reply) => {
    try {
      db.run(sql`SELECT 1`);
      return { status: 'ok', version: VERSION, role: config.role };
    } catch (error) {
      return reply.code(503).send({
        status: 'error',
        message: error instanceof Error ? error.message : 'database unavailable',
      });
    }
  });
}
