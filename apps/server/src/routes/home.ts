import type { PublicServerInfo } from '@gameblade/shared';
import { isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/middleware.js';
import { games } from '../db/schema.js';

export async function homeRoutes(app: FastifyInstance): Promise<void> {
  const { catalog, db, settings, auth } = app.gameblade;

  /**
   * Everything the Home tab renders, in one request.
   *
   * The desktop client opens on this screen, so the round-trip count on cold
   * start is what the app's perceived speed is made of — six parallel fetches
   * would each pay their own latency.
   */
  app.get('/home', async (request) => {
    const context = requireUser(request);
    return catalog.home(context.user.id);
  });

  app.get('/featured', async (request) => {
    const context = requireUser(request);
    return catalog.listFeatured(context.user.id, true);
  });

  /**
   * The only unauthenticated read in the API. It backs the public landing page
   * and the desktop sign-in screen, so it exposes nothing beyond what a visitor
   * needs to decide whether to ask for an invite.
   */
  app.get('/public/info', async () => {
    const current = settings.get();
    const gameCount = db
      .select({ count: sql<number>`count(*)` })
      .from(games)
      .where(isNull(games.missingAt))
      .get();

    const body: PublicServerInfo = {
      serverName: current.serverName,
      tagline: current.tagline,
      allowSelfRegistration: current.allowSelfRegistration,
      isConfigured: auth.countUsers() > 0,
      downloadUrl: current.downloadUrl,
      clientVersion: current.clientVersion,
      gameCount: gameCount?.count ?? 0,
    };
    return body;
  });
}
