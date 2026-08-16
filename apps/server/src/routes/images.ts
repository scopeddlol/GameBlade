import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../lib/errors.js';

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  const { images, auth } = app.gameblade;

  /**
   * Cached artwork. Authenticated, because the set of covers on a server is a
   * listing of its library.
   *
   * A `token` query parameter is accepted alongside normal auth so the desktop
   * client can point plain `<img>` tags at these URLs — an image element cannot
   * send an Authorization header.
   */
  // A poster grid legitimately requests dozens of images at once.
  app.get('/images/:id', { config: { rateLimit: false } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { token } = request.query as { token?: string };

    const authorised = request.auth !== null || (token ? auth.resolveDeviceToken(token) !== null : false);
    if (!authorised) throw ApiError.unauthorized();

    const record = images.findById(id);
    if (!record) throw ApiError.notFound('Image not found');

    const filePath = images.filePath(record.id, record.contentType);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw ApiError.notFound('Image not found');

    const etag = `"${record.id}"`;
    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }

    return reply
      .header('Content-Type', record.contentType)
      .header('Content-Length', String(info.size))
      .header('ETag', etag)
      // Each id maps to one immutable cached file, so this can cache forever.
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(createReadStream(filePath));
  });
}
