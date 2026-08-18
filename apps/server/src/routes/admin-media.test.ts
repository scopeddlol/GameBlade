import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { games, gameLaunchRules, images, libraries } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * The admin worklist and the installer upload.
 *
 * Both are about state that spans tables — a game plus its rules, a settings
 * row plus a file on disk — so they are exercised through the HTTP surface
 * rather than against the services in isolation.
 */
describe('admin catalog gaps and the client installer', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let session: { cookie: string; csrf: string };

  /** Two games: one left entirely bare, one given a launch rule and a cover. */
  let bareId: string;
  let readyId: string;

  function auth() {
    return { cookie: session.cookie, [CSRF_HEADER]: session.csrf };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-media-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
      SCAN_ON_START: 'false',
      SCAN_INTERVAL_MINUTES: '0',
    } as NodeJS.ProcessEnv);

    app = await buildApp(config);
    await app.ready();

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'archivist', password: 'a-long-enough-password' },
    });
    expect(setup.statusCode).toBe(201);
    const body = setup.json() as { csrfToken: string };
    const raw = setup.headers['set-cookie'];
    session = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
    };

    const db = app.gameblade.db;
    const libraryId = newId('lib');
    db.insert(libraries)
      .values({ id: libraryId, name: 'Test', path: path.join(dataDir, 'library') })
      .run();

    // A cached image row, so a cover can be attached without a network fetch.
    const coverId = newId('img');
    db.insert(images)
      .values({
        id: coverId,
        kind: 'cover',
        sourceUrl: 'https://example.invalid/cover.png',
        contentType: 'image/png',
        sizeBytes: 1,
      })
      .run();

    bareId = newId('gam');
    db.insert(games)
      .values({
        id: bareId,
        libraryId,
        relPath: 'Bare Game',
        kind: 'folder',
        title: 'Bare Game',
        sortTitle: 'bare game',
        searchTitle: 'bare game',
      })
      .run();

    readyId = newId('gam');
    db.insert(games)
      .values({
        id: readyId,
        libraryId,
        relPath: 'Ready Game',
        kind: 'folder',
        title: 'Ready Game',
        sortTitle: 'ready game',
        searchTitle: 'ready game',
        coverImageId: coverId,
      })
      .run();

    db.insert(gameLaunchRules)
      .values({ id: newId('lnr'), gameId: readyId, executable: 'game.exe' })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------------ gaps */

  it('reports which games have a launch rule and which have a save rule', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/games', headers: auth() });
    const body = response.json() as {
      items: Array<{ id: string; hasLaunchRule: boolean; hasSaveRule: boolean }>;
    };

    const byId = new Map(body.items.map((item) => [item.id, item]));
    expect(byId.get(readyId)?.hasLaunchRule).toBe(true);
    expect(byId.get(bareId)?.hasLaunchRule).toBe(false);
    // Neither game has a save rule yet.
    expect(byId.get(readyId)?.hasSaveRule).toBe(false);
  });

  it('filters the catalog down to entries missing a launch executable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/games?missing=launch-rule',
      headers: auth(),
    });
    const body = response.json() as { total: number; items: Array<{ id: string }> };

    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe(bareId);
  });

  it('treats a launch rule with a blank executable as no launch rule at all', async () => {
    // A rule row saved with only a note is exactly the case that looks
    // configured in the database and still leaves the client guessing.
    app.gameblade.db
      .update(gameLaunchRules)
      .set({ executable: '' })
      .where(eq(gameLaunchRules.gameId, readyId))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/games?missing=launch-rule',
      headers: auth(),
    });
    expect(response.json()).toMatchObject({ total: 2 });

    app.gameblade.db
      .update(gameLaunchRules)
      .set({ executable: 'game.exe' })
      .where(eq(gameLaunchRules.gameId, readyId))
      .run();
  });

  it('filters on cloud saving and on artwork independently', async () => {
    const saves = await app.inject({
      method: 'GET',
      url: '/api/games?missing=save-rule',
      headers: auth(),
    });
    expect(saves.json()).toMatchObject({ total: 2 });

    // Only the bare game has nothing in any artwork slot.
    const artwork = await app.inject({
      method: 'GET',
      url: '/api/games?missing=artwork',
      headers: auth(),
    });
    const body = artwork.json() as { total: number; items: Array<{ id: string }> };
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe(bareId);

    // ...but both are still missing the banner specifically.
    const banner = await app.inject({
      method: 'GET',
      url: '/api/games?missing=banner',
      headers: auth(),
    });
    expect(banner.json()).toMatchObject({ total: 2 });
  });

  it('counts every gap server-wide for the admin filter chips', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: auth(),
    });
    const body = response.json() as { gaps: Record<string, number> };

    expect(body.gaps['launch-rule']).toBe(1);
    expect(body.gaps['save-rule']).toBe(2);
    expect(body.gaps.cover).toBe(1);
    expect(body.gaps.artwork).toBe(1);
    expect(body.gaps.achievements).toBe(2);
    // Neither game was ever matched, so both count as missing metadata. This
    // is an OR of two conditions, which would swallow the rest of the WHERE
    // clause if it were ever emitted without brackets.
    expect(body.gaps.metadata).toBe(2);
  });

  it('keeps a gap filter that is an OR from swallowing the other conditions', async () => {
    // `metadata` is "unmatched OR no summary". Combined with a search term it
    // must still be one game, not every unmatched entry on the server.
    const response = await app.inject({
      method: 'GET',
      url: '/api/games?missing=metadata&search=Bare',
      headers: auth(),
    });
    const body = response.json() as { total: number; items: Array<{ id: string }> };
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe(bareId);
  });

  /* ----------------------------------------------------- thumbnail proxy */

  it('refuses to proxy a thumbnail from anywhere but the two providers', async () => {
    for (const url of [
      'http://localhost:8080/api/admin/stats',
      'https://example.invalid/pixel.png',
      'https://images.igdb.com.evil.test/x.jpg',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/artwork/thumbnail?url=${encodeURIComponent(url)}`,
        headers: auth(),
      });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('will not proxy a thumbnail for someone who is not signed in', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/artwork/thumbnail?url=${encodeURIComponent('https://images.igdb.com/a.jpg')}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown artwork slot', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/games/${bareId}/artwork`,
      headers: auth(),
      payload: { kind: 'poster', url: 'https://example.invalid/x.png' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('removes a screenshot by its cached image id', async () => {
    const screenshotId = newId('img');
    app.gameblade.db
      .update(games)
      .set({ screenshots: [screenshotId, 'img_other'] })
      .where(eq(games.id, bareId))
      .run();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/games/${bareId}/screenshots/${screenshotId}`,
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/games/${bareId}`,
      headers: auth(),
    });
    expect((detail.json() as { screenshotIds: string[] }).screenshotIds).toEqual(['img_other']);
  });

  /* ------------------------------------------------------------- installer */

  it('publishes an uploaded installer on the public landing page', async () => {
    const bytes = Buffer.from('MZ fake installer payload');

    const upload = await app.inject({
      method: 'POST',
      url: '/api/admin/client-installer?fileName=GameBlade-Setup.exe',
      headers: { ...auth(), 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      fileName: 'GameBlade-Setup.exe',
      sizeBytes: bytes.length,
    });

    // The landing page reads this unauthenticated, which is the whole point.
    const info = await app.inject({ method: 'GET', url: '/api/public/info' });
    expect(info.json()).toMatchObject({
      downloadUrl: '/api/client/download',
      downloadFileName: 'GameBlade-Setup.exe',
      downloadSizeBytes: bytes.length,
    });

    const download = await app.inject({ method: 'GET', url: '/api/client/download' });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('GameBlade-Setup.exe');
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it('refuses an installer whose extension is not an installer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/client-installer?fileName=notes.txt',
      headers: { ...auth(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope'),
    });
    expect(response.statusCode).toBe(400);
  });

  it('strips any path out of the uploaded file name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/client-installer?fileName=${encodeURIComponent('../../escape.exe')}`,
      headers: { ...auth(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('MZ'),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ fileName: 'escape.exe' });
  });

  it('falls back to the configured URL once the upload is removed', async () => {
    app.gameblade.settings.update({ downloadUrl: 'https://example.invalid/client.exe' });

    const remove = await app.inject({
      method: 'DELETE',
      url: '/api/admin/client-installer',
      headers: auth(),
    });
    expect(remove.statusCode).toBe(200);

    const info = await app.inject({ method: 'GET', url: '/api/public/info' });
    expect(info.json()).toMatchObject({
      downloadUrl: 'https://example.invalid/client.exe',
      downloadFileName: null,
    });

    const download = await app.inject({ method: 'GET', url: '/api/client/download' });
    expect(download.statusCode).toBe(404);
  });

  it('keeps the installer route out of reach of a non-administrator', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/client-installer',
    });
    expect(response.statusCode).toBe(401);
  });
});
