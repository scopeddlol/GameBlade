import {
  MAX_CLIP_BYTES,
  MAX_IMAGE_BYTES,
  createCommentSchema,
  createPostSchema,
  feedQuerySchema,
  friendRequestSchema,
  friendSearchSchema,
  reactionSchema,
  updatePostSchema,
  updateProfileSchema,
  type MediaKind,
} from '@gameblade/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '../auth/middleware.js';
import { ApiError } from '../lib/errors.js';

/** Uploads arrive as a raw body, so the kind is declared in the query string. */
interface UploadQuery {
  kind?: string;
  width?: string;
  height?: string;
  durationMs?: string;
}

const UPLOAD_KINDS: readonly MediaKind[] = ['avatar', 'banner', 'image', 'clip'];

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  const { profiles, friends, social, media, notifications, activity, playtime, achievements } =
    app.gameblade;

  /* ----------------------------------------------------------- profiles */

  app.get('/profile', async (request) => {
    const context = requireUser(request);
    return profiles.detail(context.user.id, context.user.id);
  });

  app.patch('/profile', async (request) => {
    const context = requireUser(request);
    const input = updateProfileSchema.parse(request.body);

    // Only your own uploads may become your avatar or banner.
    const attachments = [input.avatarMediaId, input.bannerMediaId].filter(
      (id): id is string => typeof id === 'string',
    );
    media.assertOwned(context.user.id, attachments);

    profiles.update(context.user.id, input);
    return profiles.detail(context.user.id, context.user.id);
  });

  app.get('/profiles/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    return profiles.detail(id, context.user.id);
  });

  /** Public slice of someone's profile: their posts, playtime and unlocks. */
  app.get('/profiles/:id/showcase', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };

    const detail = profiles.detail(id, context.user.id);
    if (!detail.canViewDetail) {
      return { profile: detail, posts: [], topGames: [], recentAchievements: [] };
    }

    return {
      profile: detail,
      posts: social.listByAuthor(id, context.user.id, 10),
      topGames: playtime.top(id, 6),
      recentAchievements: achievements.recentForUser(id, 8),
    };
  });

  app.get('/profiles', async (request) => {
    const context = requireUser(request);
    const input = friendSearchSchema.parse(request.query);
    return profiles.search(input.query, context.user.id, input.limit);
  });

  /* ------------------------------------------------------------ friends */

  app.get('/friends', async (request) => {
    const context = requireUser(request);
    return friends.list(context.user.id);
  });

  app.get('/friends/requests', async (request) => {
    const context = requireUser(request);
    return friends.requests(context.user.id);
  });

  app.get('/friends/blocked', async (request) => {
    const context = requireUser(request);
    return friends.blocked(context.user.id);
  });

  app.post('/friends/requests', async (request) => {
    const context = requireUser(request);
    const input = friendRequestSchema.parse(request.body);

    const targetId =
      input.userId ?? (input.username ? friends.findByUsername(input.username) : null);
    if (!targetId) throw ApiError.badRequest('Give a username or a user id');

    return friends.request(context.user.id, targetId);
  });

  app.post('/friends/:id/accept', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    friends.accept(context.user.id, id);
    return { ok: true };
  });

  /** Declines a pending request or removes an established friend. */
  app.delete('/friends/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    friends.remove(context.user.id, id);
    return { ok: true };
  });

  app.post('/friends/:id/block', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    friends.block(context.user.id, id);
    return { ok: true };
  });

  app.delete('/friends/:id/block', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    friends.unblock(context.user.id, id);
    return { ok: true };
  });

  /* --------------------------------------------------------------- feed */

  app.get('/feed', async (request) => {
    const context = requireUser(request);
    const query = feedQuerySchema.parse(request.query);
    return social.list(context.user.id, query);
  });

  /** The activity stream (played, unlocked, added) rather than written posts. */
  app.get('/activity', async (request) => {
    const context = requireUser(request);
    const query = feedQuerySchema.parse(request.query);
    return activity.list(context.user.id, {
      scope: query.scope,
      before: query.before,
      limit: query.limit,
    });
  });

  app.post('/posts', async (request, reply) => {
    const context = requireUser(request);
    const input = createPostSchema.parse(request.body);
    const post = social.create(context.user.id, input);
    return reply.code(201).send(post);
  });

  app.get('/posts/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    return social.get(id, context.user.id);
  });

  app.patch('/posts/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    return social.update(id, context.user.id, updatePostSchema.parse(request.body));
  });

  app.delete('/posts/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    social.remove(id, context.user.id, context.user.role === 'admin');
    return { ok: true };
  });

  app.get('/posts/:id/comments', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    return social.comments(id, context.user.id);
  });

  app.post('/posts/:id/comments', async (request, reply) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = createCommentSchema.parse(request.body);
    return reply.code(201).send(social.comment(id, context.user.id, input.body));
  });

  app.delete('/comments/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    social.deleteComment(id, context.user.id, context.user.role === 'admin');
    return { ok: true };
  });

  app.put('/posts/:id/reaction', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = reactionSchema.parse(request.body);
    return social.react(id, context.user.id, input.reaction);
  });

  /* -------------------------------------------------------------- media */

  /**
   * Uploads stream straight to disk rather than going through a multipart
   * parser: a screenshot is small, but a gameplay clip is not, and buffering
   * one in memory to re-write it would double the cost of every upload.
   */
  app.post(
    '/media',
    {
      // Fastify would otherwise try to parse the body; take it raw instead.
      bodyLimit: MAX_CLIP_BYTES,
      onRequest: async (request: FastifyRequest) => {
        requireUser(request);
      },
    },
    async (request, reply) => {
      const context = requireUser(request);
      const query = request.query as UploadQuery;

      const kind = query.kind as MediaKind | undefined;
      if (!kind || !UPLOAD_KINDS.includes(kind)) {
        throw ApiError.badRequest(`kind must be one of: ${UPLOAD_KINDS.join(', ')}`);
      }

      const contentType = request.headers['content-type'];
      if (!contentType) throw ApiError.badRequest('A Content-Type header is required');

      const declared = Number(request.headers['content-length'] ?? 0);
      const maxBytes = kind === 'clip' ? MAX_CLIP_BYTES : MAX_IMAGE_BYTES;

      const info = await media.store(
        context.user.id,
        {
          kind,
          contentType,
          sizeBytes: Number.isFinite(declared) && declared > 0 ? declared : 1,
          width: parseNumber(query.width),
          height: parseNumber(query.height),
          durationMs: parseNumber(query.durationMs),
        },
        request.raw,
        maxBytes,
      );

      return reply.code(201).send(info);
    },
  );

  /**
   * Uploads are addressed by unguessable id and served to any signed-in
   * account, which is what lets one `<img>` tag work for a friend's avatar.
   *
   * A `token` query parameter is accepted alongside normal auth for the same
   * reason `/images/:id` accepts one: an `<img>` or `<video>` element cannot
   * send an Authorization header, so the desktop client has no other way to
   * point one of these at an avatar, a screenshot or a clip.
   */
  app.get('/media/:id', { config: { rateLimit: false } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { token } = request.query as { token?: string };

    const authorised =
      request.auth !== null ||
      (token ? app.gameblade.auth.resolveDeviceToken(token) !== null : false);
    if (!authorised) throw ApiError.unauthorized();

    const { stream, record } = await media.open(id);
    return (
      reply
        .header('Content-Type', record.contentType)
        .header('Content-Length', String(record.sizeBytes))
        // Content is immutable once stored, so it can be cached hard.
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .send(stream)
    );
  });

  app.delete('/media/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    await media.delete(context.user.id, id);
    return { ok: true };
  });

  app.get('/media/usage', async (request) => {
    const context = requireUser(request);
    return {
      bytes: media.usage(context.user.id),
      quotaBytes: app.gameblade.config.mediaQuotaBytes,
    };
  });

  /* ------------------------------------------------------ notifications */

  app.get('/notifications', async (request) => {
    const context = requireUser(request);
    const { unread, limit, before } = request.query as {
      unread?: string;
      limit?: string;
      before?: string;
    };

    return {
      items: notifications.list(context.user.id, {
        unreadOnly: unread === 'true' || unread === '1',
        limit: Math.min(Number(limit) || 30, 100),
        before,
      }),
      unreadCount: notifications.unreadCount(context.user.id),
    };
  });

  app.post('/notifications/:id/read', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    notifications.markRead(context.user.id, id);
    return { ok: true };
  });

  app.post('/notifications/read-all', async (request) => {
    const context = requireUser(request);
    notifications.markAllRead(context.user.id);
    return { ok: true };
  });
}
