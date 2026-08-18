import type { FastifyInstance } from 'fastify';

/**
 * Serves the Windows client installer an administrator uploaded.
 *
 * Deliberately unauthenticated, and the only route besides `/public/info` that
 * is: the landing page's Download button is what a visitor clicks before they
 * have an account, so requiring a session here would make the upload feature
 * useless for exactly the case it exists for. Nothing is exposed beyond the
 * installer an operator chose to publish.
 */
export async function installerRoutes(app: FastifyInstance): Promise<void> {
  const { installer } = app.gameblade;

  app.get('/client/download', { config: { rateLimit: false } }, async (_request, reply) => {
    const file = await installer.open();

    return (
      reply
        .header('Content-Type', file.contentType)
        .header('Content-Length', String(file.sizeBytes))
        // The name the browser saves it under; quoted because a build name may
        // well contain spaces.
        .header('Content-Disposition', `attachment; filename="${file.fileName}"`)
        // A new upload lands on a new digest but the same URL, so this must
        // revalidate rather than serve last month's build out of a cache.
        .header('Cache-Control', 'no-cache')
        .send(file.stream)
    );
  });
}
