import {
  MAX_SAVE_BYTES,
  endPlaySessionSchema,
  presenceSchema,
  saveUploadSchema,
  startPlaySessionSchema,
  unlockAchievementSchema,
} from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/middleware.js';
import { ApiError } from '../lib/errors.js';

export async function playRoutes(app: FastifyInstance): Promise<void> {
  const { playtime, achievements, saves, presence, catalog } = app.gameblade;

  /* ---------------------------------------------------------- sessions */

  app.post('/play/sessions', async (request, reply) => {
    const context = requireUser(request);
    const input = startPlaySessionSchema.parse(request.body);
    const session = playtime.start(
      context.user.id,
      input.gameId,
      context.device?.id ?? null,
      input.shareActivity,
    );
    return reply.code(201).send(session);
  });

  app.post('/play/sessions/:id/heartbeat', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const { seconds } = (request.body ?? {}) as { seconds?: number };
    playtime.heartbeat(context.user.id, id, Math.max(0, Math.floor(seconds ?? 0)));
    return { ok: true };
  });

  app.post('/play/sessions/:id/end', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = endPlaySessionSchema.parse(request.body ?? {});
    return playtime.end(context.user.id, id, input.seconds);
  });

  /** Lets a restarted client re-attach to a session it left open. */
  app.get('/play/sessions/current', async (request) => {
    const context = requireUser(request);
    return playtime.openSession(context.user.id);
  });

  app.get('/play/top', async (request) => {
    const context = requireUser(request);
    const { limit } = request.query as { limit?: string };
    return playtime.top(context.user.id, Math.min(Number(limit) || 12, 50));
  });

  /**
   * Presence over HTTP as well as the socket: a client that has not opened a
   * WebSocket yet (or lost it) can still report going idle.
   */
  app.put('/play/presence', async (request) => {
    const context = requireUser(request);
    const input = presenceSchema.parse(request.body);
    presence.update(context.user.id, input.status, input.gameId ?? null);
    return { ok: true };
  });

  /* ------------------------------------------------------ achievements */

  app.get('/achievements/recent', async (request) => {
    const context = requireUser(request);
    const { limit } = request.query as { limit?: string };
    return achievements.recentForUser(context.user.id, Math.min(Number(limit) || 20, 100));
  });

  app.post('/games/:id/achievements/unlock', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = unlockAchievementSchema.parse(request.body);
    return achievements.unlock(context.user.id, id, input.key, input.progress ?? null);
  });

  app.get('/games/:id/achievements/summary', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    return achievements.summaryForGame(id, context.user.id);
  });

  /* -------------------------------------------------------- cloud saves */

  app.get('/saves', async (request) => {
    const context = requireUser(request);
    const { gameId } = request.query as { gameId?: string };
    return {
      slots: saves.listSlots(context.user.id, gameId),
      usage: saves.usage(context.user.id),
      quotaBytes: app.gameblade.config.saveQuotaBytes,
    };
  });

  /**
   * Asked before every sync. The client sends what it has on disk and what it
   * last pulled; the answer says whether to push, pull, or stop and ask.
   */
  app.get('/saves/status', async (request) => {
    const context = requireUser(request);
    const { gameId, slot, sha256, capturedAt, baseSha256 } = request.query as {
      gameId?: string;
      slot?: string;
      sha256?: string;
      capturedAt?: string;
      baseSha256?: string;
    };

    if (!gameId) throw ApiError.badRequest('gameId is required');

    return saves.status(context.user.id, gameId, slot || 'default', {
      sha256: sha256 ?? null,
      capturedAt: capturedAt ?? null,
      baseSha256: baseSha256 ?? null,
    });
  });

  app.get('/saves/:slotId/versions', async (request) => {
    const context = requireUser(request);
    const { slotId } = request.params as { slotId: string };
    return saves.listVersions(context.user.id, slotId);
  });

  /**
   * Uploads the zipped save. Metadata rides in the query string so the body
   * stays a pure byte stream that can be written straight to disk.
   */
  app.post('/saves', { bodyLimit: MAX_SAVE_BYTES }, async (request, reply) => {
    const context = requireUser(request);
    const query = request.query as Record<string, string | undefined>;

    const input = saveUploadSchema.parse({
      gameId: query.gameId,
      slotName: query.slot || 'default',
      sha256: query.sha256,
      sizeBytes: Number(query.sizeBytes ?? request.headers['content-length'] ?? 0),
      fileCount: Number(query.fileCount ?? 1),
      capturedAt: query.capturedAt,
      baseSha256: query.baseSha256 || null,
      force: query.force === 'true' || query.force === '1',
    });

    const version = await saves.upload(
      context.user.id,
      input,
      request.raw,
      context.device?.id ?? null,
    );

    // A synced save implies the game is theirs, so keep the library honest.
    catalog.addToLibrary(context.user.id, input.gameId);

    return reply.code(201).send(version);
  });

  app.get('/saves/:slotId/download', async (request, reply) => {
    const context = requireUser(request);
    const { slotId } = request.params as { slotId: string };
    const { version: versionId } = request.query as { version?: string };

    const { stream, version } = await saves.openVersion(context.user.id, slotId, versionId);
    return (
      reply
        .header('Content-Type', 'application/zip')
        .header('Content-Length', String(version.sizeBytes))
        // Lets the client verify the download without a second round trip.
        .header('X-GameBlade-Sha256', version.sha256)
        .header('X-GameBlade-Captured-At', version.capturedAt)
        .send(stream)
    );
  });

  app.post('/saves/:slotId/restore/:versionId', async (request) => {
    const context = requireUser(request);
    const { slotId, versionId } = request.params as { slotId: string; versionId: string };
    return saves.restore(context.user.id, slotId, versionId);
  });

  app.delete('/saves/:slotId', async (request) => {
    const context = requireUser(request);
    const { slotId } = request.params as { slotId: string };
    await saves.deleteSlot(context.user.id, slotId);
    return { ok: true };
  });
}
