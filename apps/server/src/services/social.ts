import {
  REACTIONS,
  type CommentInfo,
  type CreatePostInput,
  type FeedQuery,
  type PostInfo,
  type ReactionKind,
  type UpdatePostInput,
} from '@gameblade/shared';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { comments, games, media, postMedia, posts, reactions } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import type { FriendService } from './friends.js';
import type { MediaStore } from './media.js';
import type { NotificationService } from './notifications.js';
import type { ProfileService } from './profiles.js';

const emptyReactions = (): Record<ReactionKind, number> =>
  Object.fromEntries(REACTIONS.map((r) => [r, 0])) as Record<ReactionKind, number>;

export class SocialService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly profiles: ProfileService,
    private readonly friends: FriendService,
    private readonly mediaStore: MediaStore,
    private readonly notifications: NotificationService,
    private readonly activity: ActivityService,
  ) {}

  create(authorId: string, input: CreatePostInput): PostInfo {
    if (input.gameId) {
      const game = this.db
        .select({ id: games.id })
        .from(games)
        .where(eq(games.id, input.gameId))
        .get();
      if (!game) throw ApiError.badRequest('That game does not exist');
    }

    this.mediaStore.assertOwned(authorId, input.mediaIds);

    // The declared kind must match what was actually attached, so the client
    // renders a clip card for a clip and never for a bare text post.
    const attached = this.mediaStore.infoFor(input.mediaIds);
    const hasClip = [...attached.values()].some((m) => m.kind === 'clip');
    const kind = hasClip ? 'clip' : input.mediaIds.length > 0 ? 'image' : 'text';

    const record = {
      id: newId('pst'),
      authorId,
      kind: kind as CreatePostInput['kind'],
      title: input.title?.trim() ? input.title.trim() : null,
      body: input.body?.trim() ? input.body.trim() : null,
      gameId: input.gameId ?? null,
      visibility: input.visibility,
      createdAt: isoNow(),
      editedAt: null,
    };

    this.db.transaction((tx) => {
      tx.insert(posts).values(record).run();
      input.mediaIds.forEach((mediaId, index) => {
        tx.insert(postMedia)
          .values({ postId: record.id, mediaId, position: index })
          .onConflictDoNothing()
          .run();
      });
    });

    // A private post is a personal note; it never reaches anyone's feed.
    if (input.visibility !== 'private') {
      this.activity.record({
        userId: authorId,
        kind: 'posted',
        postId: record.id,
        gameId: input.gameId ?? null,
      });
    }

    return this.get(record.id, authorId);
  }

  update(postId: string, userId: string, input: UpdatePostInput): PostInfo {
    const post = this.requireOwnPost(postId, userId);

    this.db
      .update(posts)
      .set({
        title: input.title !== undefined ? input.title?.trim() || null : post.title,
        body: input.body !== undefined ? input.body?.trim() || null : post.body,
        visibility: input.visibility ?? post.visibility,
        editedAt: isoNow(),
      })
      .where(eq(posts.id, postId))
      .run();

    return this.get(postId, userId);
  }

  remove(postId: string, userId: string, isAdmin: boolean): void {
    const post = this.db.select().from(posts).where(eq(posts.id, postId)).get();
    if (!post) throw ApiError.notFound('That post does not exist');
    // Admins moderate; everyone else may only delete their own.
    if (post.authorId !== userId && !isAdmin) {
      throw ApiError.forbidden('That post is not yours');
    }
    this.db.delete(posts).where(eq(posts.id, postId)).run();
  }

  get(postId: string, viewerId: string): PostInfo {
    const row = this.db.select().from(posts).where(eq(posts.id, postId)).get();
    if (!row) throw ApiError.notFound('That post does not exist');

    const [info] = this.hydrate([row], viewerId);
    if (!info) throw ApiError.forbidden('You cannot see that post');
    return info;
  }

  /**
   * Lists posts the viewer is allowed to see.
   *
   * Visibility is applied in SQL rather than after the fact: filtering a fetched
   * page in memory would silently return short pages and make pagination lie.
   */
  list(viewerId: string, query: FeedQuery): PostInfo[] {
    const friendIds = [...this.profiles.friendIds(viewerId)];
    const conditions = [];

    if (query.scope === 'mine') {
      conditions.push(eq(posts.authorId, viewerId));
    } else if (query.scope === 'friends') {
      const audience = [viewerId, ...friendIds];
      conditions.push(inArray(posts.authorId, audience));
    }

    if (query.gameId) conditions.push(eq(posts.gameId, query.gameId));
    if (query.before) conditions.push(lt(posts.createdAt, query.before));

    const visible = or(
      eq(posts.authorId, viewerId),
      eq(posts.visibility, 'public'),
      friendIds.length > 0
        ? and(eq(posts.visibility, 'friends'), inArray(posts.authorId, friendIds))
        : undefined,
    );
    if (visible) conditions.push(visible);

    const rows = this.db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(posts.createdAt))
      .limit(query.limit)
      .all();

    return this.hydrate(rows, viewerId);
  }

  /** Posts on a profile page, honouring that profile's own visibility. */
  listByAuthor(authorId: string, viewerId: string, limit: number): PostInfo[] {
    return this.list(viewerId, {
      scope: 'everyone',
      limit,
      before: undefined,
      gameId: undefined,
    }).filter((post) => post.author.userId === authorId);
  }

  comments(postId: string, viewerId: string): CommentInfo[] {
    // Reading comments requires being able to read the post itself.
    this.get(postId, viewerId);

    const rows = this.db
      .select()
      .from(comments)
      .where(eq(comments.postId, postId))
      .orderBy(comments.createdAt)
      .all();

    const authors = this.profiles.summarizeMany(
      rows.map((r) => r.authorId),
      viewerId,
    );

    return rows.flatMap((row) => {
      const author = authors.get(row.authorId);
      if (!author) return [];
      return [
        {
          id: row.id,
          postId: row.postId,
          author,
          body: row.body,
          createdAt: row.createdAt,
          canEdit: row.authorId === viewerId,
        },
      ];
    });
  }

  comment(postId: string, authorId: string, body: string): CommentInfo {
    const post = this.get(postId, authorId);
    if (this.friends.isBlocked(authorId, post.author.userId)) {
      throw ApiError.forbidden('You cannot comment on that post');
    }

    const record = {
      id: newId('cmt'),
      postId,
      authorId,
      body: body.trim(),
      createdAt: isoNow(),
      editedAt: null,
    };
    this.db.insert(comments).values(record).run();

    const author = this.profiles.summarizeOne(authorId, post.author.userId);
    this.notifications.create({
      userId: post.author.userId,
      kind: 'post-comment',
      actorId: authorId,
      title: `${author?.displayName ?? 'Someone'} commented on your post`,
      body: record.body.slice(0, 140),
      link: `social/post/${postId}`,
    });

    const summary = this.profiles.summarizeOne(authorId, authorId);
    return {
      id: record.id,
      postId,
      author: summary ?? post.author,
      body: record.body,
      createdAt: record.createdAt,
      canEdit: true,
    };
  }

  deleteComment(commentId: string, userId: string, isAdmin: boolean): void {
    const row = this.db.select().from(comments).where(eq(comments.id, commentId)).get();
    if (!row) throw ApiError.notFound('That comment does not exist');

    // The post's author may also clear comments on their own post.
    const post = this.db
      .select({ authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, row.postId))
      .get();

    const allowed = row.authorId === userId || post?.authorId === userId || isAdmin;
    if (!allowed) throw ApiError.forbidden('That comment is not yours');

    this.db.delete(comments).where(eq(comments.id, commentId)).run();
  }

  react(postId: string, userId: string, reaction: ReactionKind | null): PostInfo {
    const post = this.get(postId, userId);

    if (reaction === null) {
      this.db
        .delete(reactions)
        .where(and(eq(reactions.postId, postId), eq(reactions.userId, userId)))
        .run();
      return this.get(postId, userId);
    }

    const existing = this.db
      .select({ reaction: reactions.reaction })
      .from(reactions)
      .where(and(eq(reactions.postId, postId), eq(reactions.userId, userId)))
      .get();

    this.db
      .insert(reactions)
      .values({ postId, userId, reaction, createdAt: isoNow() })
      .onConflictDoUpdate({
        target: [reactions.postId, reactions.userId],
        set: { reaction, createdAt: isoNow() },
      })
      .run();

    // Only the first reaction notifies; switching from 👍 to 🔥 should not.
    if (!existing) {
      const actor = this.profiles.summarizeOne(userId, post.author.userId);
      this.notifications.create({
        userId: post.author.userId,
        kind: 'post-reaction',
        actorId: userId,
        title: `${actor?.displayName ?? 'Someone'} reacted to your post`,
        link: `social/post/${postId}`,
      });
    }

    return this.get(postId, userId);
  }

  private requireOwnPost(postId: string, userId: string) {
    const post = this.db.select().from(posts).where(eq(posts.id, postId)).get();
    if (!post) throw ApiError.notFound('That post does not exist');
    if (post.authorId !== userId) throw ApiError.forbidden('That post is not yours');
    return post;
  }

  /**
   * Turns post rows into full cards. Media, comment counts, reactions and games
   * are each resolved once for the whole page rather than per post.
   */
  private hydrate(rows: Array<typeof posts.$inferSelect>, viewerId: string): PostInfo[] {
    if (rows.length === 0) return [];

    const postIds = rows.map((r) => r.id);
    const authors = this.profiles.summarizeMany(
      rows.map((r) => r.authorId),
      viewerId,
    );

    const mediaRows = this.db
      .select({ postId: postMedia.postId, position: postMedia.position, record: media })
      .from(postMedia)
      .innerJoin(media, eq(media.id, postMedia.mediaId))
      .where(inArray(postMedia.postId, postIds))
      .all();

    const mediaByPost = new Map<string, typeof mediaRows>();
    for (const row of mediaRows) {
      const list = mediaByPost.get(row.postId) ?? [];
      list.push(row);
      mediaByPost.set(row.postId, list);
    }

    const commentCounts = new Map(
      this.db
        .select({ postId: comments.postId, count: sql<number>`count(*)` })
        .from(comments)
        .where(inArray(comments.postId, postIds))
        .groupBy(comments.postId)
        .all()
        .map((r) => [r.postId, r.count]),
    );

    const reactionRows = this.db
      .select()
      .from(reactions)
      .where(inArray(reactions.postId, postIds))
      .all();

    const reactionsByPost = new Map<string, Record<ReactionKind, number>>();
    const myReactions = new Map<string, ReactionKind>();
    for (const row of reactionRows) {
      const counts = reactionsByPost.get(row.postId) ?? emptyReactions();
      const key = row.reaction as ReactionKind;
      if (key in counts) counts[key] += 1;
      reactionsByPost.set(row.postId, counts);
      if (row.userId === viewerId) myReactions.set(row.postId, key);
    }

    const gameIds = rows.map((r) => r.gameId).filter((id): id is string => Boolean(id));
    const gameRows =
      gameIds.length > 0
        ? this.db
            .select({ id: games.id, title: games.title, coverImageId: games.coverImageId })
            .from(games)
            .where(inArray(games.id, [...new Set(gameIds)]))
            .all()
        : [];
    const gameMap = new Map(gameRows.map((g) => [g.id, g]));

    return rows.flatMap((row) => {
      const author = authors.get(row.authorId);
      if (!author) return [];

      const game = row.gameId ? gameMap.get(row.gameId) : undefined;
      const attachments = (mediaByPost.get(row.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .map((entry) => ({
          id: entry.record.id,
          kind: entry.record.kind,
          url: this.mediaStore.url(entry.record.id),
          thumbnailUrl: null,
          contentType: entry.record.contentType,
          sizeBytes: entry.record.sizeBytes,
          width: entry.record.width,
          height: entry.record.height,
          durationMs: entry.record.durationMs,
        }));

      return [
        {
          id: row.id,
          author,
          kind: row.kind,
          title: row.title,
          body: row.body,
          media: attachments,
          game: game
            ? {
                id: game.id,
                title: game.title,
                coverUrl: game.coverImageId
                  ? `${this.config.basePath}/api/images/${game.coverImageId}`
                  : null,
              }
            : null,
          visibility: row.visibility,
          createdAt: row.createdAt,
          editedAt: row.editedAt,
          commentCount: commentCounts.get(row.id) ?? 0,
          reactions: reactionsByPost.get(row.id) ?? emptyReactions(),
          myReaction: myReactions.get(row.id) ?? null,
          canEdit: row.authorId === viewerId,
        },
      ];
    });
  }
}
