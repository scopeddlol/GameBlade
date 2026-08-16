import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.gameblade;

  /**
   * Unauthenticated liveness probe for Docker and the reverse proxy. It touches
   * the database so a container with a corrupt or locked volume reports unhealthy
   * rather than sitting there accepting requests it cannot serve.
   */
  app.get('/health', async (_request, reply) => {
    try {
      db.run(sql`SELECT 1`);
      return { status: 'ok', version: process.env.npm_package_version ?? '0.1.0' };
    } catch (error) {
      return reply.code(503).send({
        status: 'error',
        message: error instanceof Error ? error.message : 'database unavailable',
      });
    }
  });
}
