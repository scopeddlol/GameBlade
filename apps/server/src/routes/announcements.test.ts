import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type PostInfo } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

interface Session {
  cookie: string;
  csrf: string;
  id: string;
}

/**
 * Announcements as posts.
 *
 * They used to be notifications alone: read once, then gone, with nowhere to
 * reply. Publishing one now also puts it on the News page, which is an
 * ordinary post row — so comments, edits and deletion all come from the
 * machinery that already existed rather than a second copy of it.
 */
describe('announcements', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: Session;
  let player: Session;

  const auth = (s: Session) => ({ cookie: s.cookie, [CSRF_HEADER]: s.csrf });

  const signIn = async (username: string, password: string): Promise<Session> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    });
    const raw = res.headers['set-cookie'];
    const body = res.json() as { csrfToken: string; user: { id: string } };
    return {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
      id: body.user.id,
    };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-news-test-'));
    app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
      } as NodeJS.ProcessEnv),
    );
    await app.ready();

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'archivist', password: 'a-long-enough-password' },
    });
    const raw = setup.headers['set-cookie'];
    const body = setup.json() as { csrfToken: string; user: { id: string } };
    admin = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
      id: body.user.id,
    };

    // There is no admin route that mints an account directly, so the player
    // arrives the way a real one does: an invite, then registration.
    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(admin),
      payload: { maxUses: 1 },
    });
    const { code } = invite.json() as { code: string };

    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'player', password: 'another-long-password', inviteCode: code },
    });
    player = await signIn('player', 'another-long-password');
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const announce = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: auth(admin),
      payload,
    });

  const news = async (session: Session): Promise<PostInfo[]> =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/feed?scope=everyone&kind=announcement',
        headers: { cookie: session.cookie },
      })
    ).json() as PostInfo[];

  it('publishes to the news page as well as notifying', async () => {
    const response = await announce({ title: 'Server moving', body: 'New host on Sunday.' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { sent: number; postId: string | null };
    expect(body.sent).toBeGreaterThan(0);
    expect(body.postId).not.toBeNull();

    // The point of the whole change: it is still there afterwards.
    const items = await news(player);
    expect(items.map((post) => post.title)).toContain('Server moving');
  });

  it('reaches a player who was not online when it was sent', async () => {
    // Nothing about reading the page depends on having received the
    // notification, which is what made announcements feel like they vanished.
    const items = await news(player);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.kind).toBe('announcement');
  });

  it('can be answered by anyone who can read it', async () => {
    const [post] = await news(player);
    const comment = await app.inject({
      method: 'POST',
      url: `/api/posts/${post?.id}/comments`,
      headers: auth(player),
      payload: { body: 'Thanks for the heads up.' },
    });
    expect(comment.statusCode).toBe(201);

    const comments = (
      await app.inject({
        method: 'GET',
        url: `/api/posts/${post?.id}/comments`,
        headers: { cookie: admin.cookie },
      })
    ).json() as { body: string }[];
    expect(comments.map((entry) => entry.body)).toContain('Thanks for the heads up.');
  });

  it('stays out of the news page when it is only a notification', async () => {
    const before = (await news(player)).length;
    const response = await announce({ title: 'Back in five', publish: false });

    expect((response.json() as { postId: string | null }).postId).toBeNull();
    expect(await news(player)).toHaveLength(before);
  });

  it('is never published when it is aimed at named accounts', async () => {
    // A message to three people has no business on a page everyone reads,
    // whatever the publish flag says.
    const response = await announce({
      title: 'About your account',
      userIds: [player.id],
      publish: true,
    });

    expect((response.json() as { postId: string | null }).postId).toBeNull();
    const titles = (await news(player)).map((post) => post.title);
    expect(titles).not.toContain('About your account');
  });

  it('keeps announcements out of the ordinary feed', async () => {
    const items = (
      await app.inject({
        method: 'GET',
        url: '/api/feed?scope=everyone&kind=not-announcement',
        headers: { cookie: player.cookie },
      })
    ).json() as PostInfo[];

    expect(items.every((post) => post.kind !== 'announcement')).toBe(true);
  });

  it('does not let a player post something that looks official', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: auth(player),
      payload: { title: 'Free games', body: 'Trust me', kind: 'announcement' },
    });

    // The route may accept the field, but the stored kind is derived from what
    // was attached — so it must never come back as an announcement.
    if (response.statusCode === 201) {
      expect((response.json() as PostInfo).kind).not.toBe('announcement');
    } else {
      expect(response.statusCode).toBe(400);
    }
  });

  it('refuses to let a player announce at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: auth(player),
      payload: { title: 'Nope' },
    });
    expect(response.statusCode).toBe(403);
  });
});
