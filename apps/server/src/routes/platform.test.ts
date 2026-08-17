import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SESSION_COOKIE, CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { eq } from 'drizzle-orm';
import { games, images, libraries, userLibrary } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * End-to-end coverage for the platform surface: two accounts, a friendship, a
 * post, an achievement unlock and a cloud save round trip. These paths span
 * several services each, so a unit test per service would not catch the wiring
 * mistakes that actually break the desktop client.
 */
describe('platform routes', () => {
  let app: FastifyInstance;
  let dataDir: string;

  /** Cookie session plus its CSRF token, which state-changing calls need. */
  interface Session {
    cookie: string;
    csrf: string;
    userId: string;
  }

  let admin: Session;
  let friend: Session;
  let gameId: string;
  let libraryId: string;

  async function signUp(username: string, inviteCode?: string): Promise<Session> {
    const response = await app.inject({
      method: 'POST',
      url: inviteCode ? '/api/auth/register' : '/api/auth/setup',
      payload: {
        username,
        password: 'a-long-enough-password',
        ...(inviteCode ? { inviteCode } : {}),
      },
    });
    expect(response.statusCode).toBe(201);

    const body = response.json() as { user: { id: string }; csrfToken: string };
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookie = String(raw).split(';')[0] ?? '';

    return { cookie, csrf: body.csrfToken, userId: body.user.id };
  }

  function auth(session: Session) {
    return { cookie: session.cookie, [CSRF_HEADER]: session.csrf };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
      SCAN_ON_START: 'false',
      SCAN_INTERVAL_MINUTES: '0',
    } as NodeJS.ProcessEnv);

    app = await buildApp(config);
    await app.ready();

    admin = await signUp('archivist');

    // A library and a game, inserted directly: the scanner has its own tests
    // and walking a real directory here would only slow this suite down.
    libraryId = newId('lib');
    app.gameblade.db
      .insert(libraries)
      .values({ id: libraryId, name: 'Test', path: path.join(dataDir, 'library') })
      .run();

    gameId = newId('gam');
    app.gameblade.db
      .insert(games)
      .values({
        id: gameId,
        libraryId,
        relPath: 'Cave Story',
        kind: 'folder',
        title: 'Cave Story',
        sortTitle: 'cave story',
        searchTitle: 'cave story',
      })
      .run();

    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(admin),
      payload: { role: 'user', maxUses: 1 },
    });
    expect(invite.statusCode).toBe(201);
    const code = (invite.json() as { code: string }).code;

    friend = await signUp('curator', code);
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serves public server info without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/public/info' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { isConfigured: boolean; gameCount: number };
    expect(body.isConfigured).toBe(true);
    expect(body.gameCount).toBe(1);
  });

  it('separates the store from a user library', async () => {
    const store = await app.inject({
      method: 'GET',
      url: '/api/games?scope=not-in-library',
      headers: auth(admin),
    });
    expect(store.json()).toMatchObject({ total: 1 });

    const add = await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/library`,
      headers: auth(admin),
    });
    expect(add.statusCode).toBe(200);

    const library = await app.inject({
      method: 'GET',
      url: '/api/games?scope=library',
      headers: auth(admin),
    });
    const body = library.json() as { total: number; items: Array<{ inLibrary: boolean }> };
    expect(body.total).toBe(1);
    expect(body.items[0]?.inLibrary).toBe(true);

    // The same game is now absent from the store view for this account.
    const storeAfter = await app.inject({
      method: 'GET',
      url: '/api/games?scope=not-in-library',
      headers: auth(admin),
    });
    expect(storeAfter.json()).toMatchObject({ total: 0 });
  });

  it('completes a friend request round trip', async () => {
    const request = await app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: auth(admin),
      payload: { username: 'curator' },
    });
    expect(request.json()).toEqual({ status: 'pending' });

    const incoming = await app.inject({
      method: 'GET',
      url: '/api/friends/requests',
      headers: auth(friend),
    });
    const pending = incoming.json() as { incoming: Array<{ profile: { userId: string } }> };
    expect(pending.incoming).toHaveLength(1);
    expect(pending.incoming[0]?.profile.userId).toBe(admin.userId);

    const accept = await app.inject({
      method: 'POST',
      url: `/api/friends/${admin.userId}/accept`,
      headers: auth(friend),
    });
    expect(accept.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/friends', headers: auth(admin) });
    const friends = list.json() as Array<{ profile: { username: string } }>;
    expect(friends.map((f) => f.profile.username)).toEqual(['curator']);
  });

  it('shows a friend-only post to a friend but not to a stranger', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: auth(admin),
      payload: { body: 'Finally beat the Sacred Grounds.', visibility: 'friends' },
    });
    expect(created.statusCode).toBe(201);

    const friendFeed = await app.inject({
      method: 'GET',
      url: '/api/feed?scope=friends',
      headers: auth(friend),
    });
    expect(friendFeed.json()).toHaveLength(1);

    // A third account with no friendship must not see it.
    const inviteResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(admin),
      payload: { role: 'user', maxUses: 1 },
    });
    const stranger = await signUp('lurker', (inviteResponse.json() as { code: string }).code);

    const strangerFeed = await app.inject({
      method: 'GET',
      url: '/api/feed?scope=everyone',
      headers: auth(stranger),
    });
    expect(strangerFeed.json()).toHaveLength(0);
  });

  it('tracks a play session and folds it into playtime', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/play/sessions',
      headers: auth(admin),
      payload: { gameId },
    });
    expect(started.statusCode).toBe(201);
    const sessionId = (started.json() as { id: string }).id;

    // The client's reported duration is clamped to real elapsed time, so a
    // session that just opened banks essentially nothing.
    const ended = await app.inject({
      method: 'POST',
      url: `/api/play/sessions/${sessionId}/end`,
      headers: auth(admin),
      payload: { seconds: 9999 },
    });
    expect(ended.statusCode).toBe(200);
    expect((ended.json() as { seconds: number }).seconds).toBeLessThan(10);
  });

  it('unlocks an achievement exactly once', async () => {
    const define = await app.inject({
      method: 'PUT',
      url: `/api/admin/games/${gameId}/achievements`,
      headers: auth(admin),
      payload: { key: 'sacred_grounds', name: 'Sacred Grounds', points: 50 },
    });
    expect(define.statusCode).toBe(200);

    const unlock = await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/achievements/unlock`,
      headers: auth(admin),
      payload: { key: 'sacred_grounds' },
    });
    expect(unlock.statusCode).toBe(200);
    const first = unlock.json() as { unlockedAt: string | null };
    expect(first.unlockedAt).not.toBeNull();

    // Re-reporting must be idempotent rather than re-announcing the unlock.
    const again = await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/achievements/unlock`,
      headers: auth(admin),
      payload: { key: 'sacred_grounds' },
    });
    expect((again.json() as { unlockedAt: string }).unlockedAt).toBe(first.unlockedAt);

    const summary = await app.inject({
      method: 'GET',
      url: `/api/games/${gameId}/achievements/summary`,
      headers: auth(admin),
    });
    expect(summary.json()).toMatchObject({ total: 1, unlocked: 1, earnedPoints: 50 });
  });

  it('round-trips a cloud save and rejects a bad checksum', async () => {
    const payload = Buffer.from('a pretend save archive');
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const capturedAt = new Date().toISOString();

    const upload = await app.inject({
      method: 'POST',
      url: `/api/saves?gameId=${gameId}&slot=default&sha256=${sha256}&sizeBytes=${payload.length}&fileCount=1&capturedAt=${encodeURIComponent(capturedAt)}`,
      headers: { ...auth(admin), 'content-type': 'application/zip' },
      payload,
    });
    expect(upload.statusCode).toBe(201);

    const slots = await app.inject({
      method: 'GET',
      url: `/api/saves?gameId=${gameId}`,
      headers: auth(admin),
    });
    const body = slots.json() as {
      slots: Array<{ id: string; currentVersion: { sha256: string } }>;
    };
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0]?.currentVersion.sha256).toBe(sha256);

    const download = await app.inject({
      method: 'GET',
      url: `/api/saves/${body.slots[0]?.id}/download`,
      headers: auth(admin),
    });
    expect(download.rawPayload.equals(payload)).toBe(true);

    // A digest that does not match what arrived must be refused outright.
    const corrupt = await app.inject({
      method: 'POST',
      url: `/api/saves?gameId=${gameId}&slot=other&sha256=${'0'.repeat(64)}&sizeBytes=${payload.length}&fileCount=1&capturedAt=${encodeURIComponent(capturedAt)}`,
      headers: { ...auth(admin), 'content-type': 'application/zip' },
      payload,
    });
    expect(corrupt.statusCode).toBe(400);
  });

  it('reports a save conflict when both sides moved on', async () => {
    const status = await app.inject({
      method: 'GET',
      url: `/api/saves/status?gameId=${gameId}&slot=default&sha256=${'a'.repeat(64)}&baseSha256=${'b'.repeat(64)}&capturedAt=${encodeURIComponent(new Date().toISOString())}`,
      headers: auth(admin),
    });
    expect(status.json()).toMatchObject({ state: 'conflict' });
  });

  it('assembles the home feed in one request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/home', headers: auth(admin) });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      continuePlaying: unknown[];
      recentAchievements: unknown[];
      stats: { games: number };
    };
    expect(body.continuePlaying).toHaveLength(1);
    expect(body.recentAchievements).toHaveLength(1);
    expect(body.stats.games).toBe(1);
  });

  it('serves an upload to a token in the query string', async () => {
    // An <img> or <video> tag cannot send an Authorization header, so the
    // desktop client can only load avatars, screenshots and clips this way.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
        '05fe02fa0000000049454e44ae426082',
      'hex',
    );

    const upload = await app.inject({
      method: 'POST',
      url: '/api/media?kind=image',
      headers: { ...auth(admin), 'content-type': 'image/png' },
      payload: png,
    });
    expect(upload.statusCode).toBe(201);
    const mediaId = (upload.json() as { id: string }).id;

    const anonymous = await app.inject({ method: 'GET', url: `/api/media/${mediaId}` });
    expect(anonymous.statusCode).toBe(401);

    const device = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'archivist',
        password: 'a-long-enough-password',
        deviceName: 'Test PC',
      },
    });
    const token = (device.json() as { token: string }).token;

    const withToken = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}?token=${token}`,
    });
    expect(withToken.statusCode).toBe(200);
    expect(withToken.rawPayload.equals(png)).toBe(true);

    const badToken = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}?token=not-a-real-token`,
    });
    expect(badToken.statusCode).toBe(401);

    // The desktop webview is served from tauri.localhost, so every asset it
    // loads is cross-origin. Helmet's blanket same-origin CORP made the
    // browser fetch these bytes and then throw them away, which showed up as
    // every image in the client being broken while the admin panel — which is
    // same-origin with the server — looked perfectly fine.
    expect(withToken.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('lets a cross-origin webview embed artwork, but not the rest of the API', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
        '05fe02fa0000000049454e44ae426082',
      'hex',
    );

    // The cache only ingests by URL, so seed a row and its file the way a
    // download would.
    const imageId = newId('img');
    const { images: imageCache } = app.gameblade;
    const filePath = imageCache.filePath(imageId, 'image/png');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, png);
    app.gameblade.db
      .insert(images)
      .values({
        id: imageId,
        kind: 'cover',
        sourceUrl: `https://example.invalid/${imageId}.png`,
        contentType: 'image/png',
        sizeBytes: png.length,
        createdAt: new Date().toISOString(),
      })
      .run();

    const image = await app.inject({
      method: 'GET',
      url: `/api/images/${imageId}`,
      headers: auth(admin),
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['cross-origin-resource-policy']).toBe('cross-origin');

    // A revalidation must carry the header as well, or a cached cover breaks
    // on its second load while working on the first.
    const revalidated = await app.inject({
      method: 'GET',
      url: `/api/images/${imageId}`,
      headers: { ...auth(admin), 'if-none-match': `"${imageId}"` },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.headers['cross-origin-resource-policy']).toBe('cross-origin');

    // Everything else keeps helmet's default; only browser-loaded subresources
    // opt out.
    const json = await app.inject({ method: 'GET', url: '/api/home', headers: auth(admin) });
    expect(json.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('removes games that are gone from disk, and guards the ones that are not', async () => {
    function insertGame(title: string, missing: boolean): string {
      const id = newId('gam');
      app.gameblade.db
        .insert(games)
        .values({
          id,
          libraryId,
          relPath: title,
          kind: 'folder',
          title,
          sortTitle: title.toLowerCase(),
          searchTitle: title.toLowerCase(),
          missingAt: missing ? new Date().toISOString() : null,
        })
        .run();
      return id;
    }

    const vanished = insertGame('Vanished', true);
    const present = insertGame('Still Here', false);

    // A game still on disk would be re-added by the next scan without any of
    // its metadata, so removing it takes an explicit force.
    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/admin/games/${present}`,
      headers: auth(admin),
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe('game_present');

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/admin/games/${present}?force=true`,
      headers: auth(admin),
    });
    expect(forced.statusCode).toBe(200);

    // A library entry cascades away with the game rather than lingering as a
    // row pointing at nothing.
    app.gameblade.db
      .insert(userLibrary)
      .values({ userId: admin.userId, gameId: vanished, addedAt: new Date().toISOString() })
      .run();

    const purge = await app.inject({
      method: 'POST',
      url: '/api/admin/games/purge-missing',
      headers: auth(admin),
      payload: {},
    });
    expect(purge.statusCode).toBe(200);
    expect((purge.json() as { removed: number }).removed).toBe(1);

    const left = app.gameblade.db.select().from(games).all();
    expect(left.map((row) => row.id)).not.toContain(vanished);
    expect(left.map((row) => row.id)).not.toContain(present);
    // The game the rest of the suite depends on is untouched.
    expect(left.map((row) => row.id)).toContain(gameId);

    const orphans = app.gameblade.db
      .select()
      .from(userLibrary)
      .where(eq(userLibrary.gameId, vanished))
      .all();
    expect(orphans).toHaveLength(0);

    const missingNow = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: auth(admin),
    });
    expect((missingNow.json() as { missing: number }).missing).toBe(0);
  });

  it('lets a member change their own username and email, but not their role', async () => {
    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: auth(friend),
      payload: { username: 'curator-renamed', email: 'curator@example.test' },
    });
    expect(changed.statusCode).toBe(200);
    const body = changed.json() as { username: string; email: string | null; role: string };
    expect(body.username).toBe('curator-renamed');
    expect(body.email).toBe('curator@example.test');
    // The schema has no role field at all, so there is nothing for a crafted
    // payload to smuggle through — this is the guarantee that makes /account
    // safe to expose to every signed-in user rather than admins only.
    expect(body.role).toBe('user');

    // Taking someone else's username is refused rather than silently renaming
    // both accounts to the same login.
    const clash = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: auth(admin),
      payload: { username: 'curator-renamed' },
    });
    expect(clash.statusCode).toBe(409);

    // Renaming yourself to your own current name is a no-op, not a conflict.
    const same = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: auth(friend),
      payload: { username: 'curator-renamed' },
    });
    expect(same.statusCode).toBe(200);
  });

  it('refuses to serve the API without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/home' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a state-changing call without the CSRF header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/library`,
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('keeps the session cookie name stable for the web client', () => {
    expect(SESSION_COOKIE).toBe('gb_session');
  });
});
