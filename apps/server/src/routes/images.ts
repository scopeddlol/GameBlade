import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { allowCrossOriginEmbed } from '../lib/assets.js';
import { ApiError } from '../lib/errors.js';

/**
 * Hosts the artwork proxy will fetch from.
 *
 * This is an allowlist rather than a filter because the route takes a URL from
 * the caller: without it, an administrator's browser could be used to make the
 * server issue requests to anything it can reach, including services on the
 * private network the container sits on.
 */
function isProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'images.igdb.com' || host === 'steamgriddb.com' || host.endsWith('.steamgriddb.com')
  );
}

/** Provider thumbnails are small; anything larger is not a thumbnail. */
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  const { images, auth } = app.gameblade;

  /**
   * Streams one provider thumbnail through the server.
   *
   * The page's content security policy allows images from this origin only,
   * and deliberately so: it is what keeps a player's browser from ever talking
   * to IGDB or SteamGridDB directly. Rather than punching two CDN hosts into
   * that policy for every page on the site, provider previews come through
   * here. Nothing is written to disk — only the image an admin actually
   * chooses gets cached, by the artwork route.
   */
  app.get('/artwork/thumbnail', { config: { rateLimit: false } }, async (request, reply) => {
    // Any signed-in account, not just an administrator: the request page shows
    // trending covers to whoever is deciding what to ask for. The guards that
    // matter are below — https only, two known provider hosts, a size cap —
    // and none of them depend on the caller's role.
    //
    // A `token` query parameter is accepted for the same reason /images/:id
    // accepts one: the desktop client points plain <img> tags at these URLs,
    // and an image element cannot send an Authorization header.
    const { url, token } = request.query as { url?: string; token?: string };
    const authorised =
      request.auth !== null || (token ? auth.resolveDeviceToken(token) !== null : false);
    if (!authorised) throw ApiError.unauthorized();

    if (!url) throw ApiError.badRequest('A url is required');

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw ApiError.badRequest('That is not a valid URL');
    }
    if (target.protocol !== 'https:' || !isProviderHost(target.hostname)) {
      throw ApiError.badRequest('Only IGDB and SteamGridDB images can be previewed');
    }

    const upstream = await fetch(target, { headers: { Accept: 'image/*' } }).catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      throw ApiError.unavailable('That provider image could not be fetched');
    }

    const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!contentType.startsWith('image/')) {
      throw ApiError.badRequest('That URL is not an image');
    }

    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_THUMBNAIL_BYTES) {
      throw ApiError.badRequest('That image is too large to preview');
    }

    return (
      reply
        .header('Content-Type', contentType)
        // The provider's URL is content-addressed, so a preview can be held for
        // the length of a browsing session without going stale.
        .header('Cache-Control', 'private, max-age=3600')
        .send(Readable.fromWeb(upstream.body as never))
    );
  });

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

    const authorised =
      request.auth !== null || (token ? auth.resolveDeviceToken(token) !== null : false);
    if (!authorised) throw ApiError.unauthorized();

    const record = images.findById(id);
    if (!record) throw ApiError.notFound('Image not found');

    const filePath = images.filePath(record.id, record.contentType);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw ApiError.notFound('Image not found');

    const etag = `"${record.id}"`;
    if (request.headers['if-none-match'] === etag) {
      // The 304 needs the header too: without it the revalidated response is
      // discarded and a cached image breaks on the second load.
      return allowCrossOriginEmbed(reply).code(304).send();
    }

    return (
      allowCrossOriginEmbed(reply)
        .header('Content-Type', record.contentType)
        .header('Content-Length', String(info.size))
        .header('ETag', etag)
        // Each id maps to one immutable cached file, so this can cache forever.
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .send(createReadStream(filePath))
    );
  });
}
