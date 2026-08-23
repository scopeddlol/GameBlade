import type { FastifyReply } from 'fastify';

/**
 * Marks a response as loadable from another origin.
 *
 * Helmet stamps `Cross-Origin-Resource-Policy: same-origin` on everything,
 * which is right for the API but silently breaks the desktop client. Its
 * webview runs on `http://tauri.localhost`, so every artwork and avatar request
 * is cross-origin: the browser fetches the bytes, reads that header, throws the
 * response away and fires an error event. The `<img>` renders as broken with no
 * failed request in the network log and nothing in the server log, because the
 * request itself succeeded.
 *
 * Only the routes a browser loads as a subresource opt out — cached artwork,
 * and the provider-thumbnail proxy the request page's covers come through. It
 * costs nothing here: each requires a device token or a session, and the
 * session cookie is SameSite=lax, so a third-party page embedding one of these
 * URLs sends no credentials and gets a 401 rather than a user's artwork.
 */
export function allowCrossOriginEmbed(reply: FastifyReply): FastifyReply {
  return reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
}
