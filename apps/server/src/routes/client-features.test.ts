import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type ClientButton, type LocalGameMatch } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { games, libraries } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * The two server-side halves of the desktop client's new features: the
 * operator-defined buttons it renders, and the title matching that lets a
 * player link a copy they already have on disk.
 */
describe('desktop client buttons and local install matching', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };
  let player: { cookie: string; csrf: string };

  const auth = (session: { cookie: string; csrf: string }) => ({
    cookie: session.cookie,
    [CSRF_HEADER]: session.csrf,
  });

  async function register(url: string, payload: Record<string, unknown>) {
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { csrfToken: string };
    const raw = response.headers['set-cookie'];
    return {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-client-test-'));
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

    admin = await register('/api/auth/setup', {
      username: 'archivist',
      password: 'a-long-enough-password',
    });

    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(admin),
      payload: { role: 'user', maxUses: 1 },
    });
    player = await register('/api/auth/register', {
      username: 'player',
      password: 'a-long-enough-password',
      inviteCode: (invite.json() as { code: string }).code,
    });

    const libraryId = newId('lib');
    app.gameblade.db
      .insert(libraries)
      .values({ id: libraryId, name: 'Test', path: path.join(dataDir, 'library') })
      .run();

    for (const title of ['Cave Story', 'Hollow Knight', 'Celeste']) {
      app.gameblade.db
        .insert(games)
        .values({
          id: newId('gam'),
          libraryId,
          relPath: title,
          kind: 'folder',
          title,
          sortTitle: title.toLowerCase(),
          searchTitle: title.toLowerCase(),
        })
        .run();
    }
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* --------------------------------------------------------------- buttons */

  it('creates a button and shows it to a signed-in client', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/client-buttons',
      headers: auth(admin),
      payload: {
        label: 'Our Discord',
        url: 'https://discord.gg/example',
        icon: 'message-circle',
        placement: 'sidebar',
      },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/client-buttons',
      headers: auth(player),
    });
    const body = listed.json() as ClientButton[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ label: 'Our Discord', placement: 'sidebar' });
  });

  it('hides an inactive button from the client but not from the admin panel', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/client-buttons',
      headers: auth(admin),
      payload: {
        label: 'Staged',
        url: 'https://example.com/soon',
        placement: 'home',
        active: false,
      },
    });
    const id = (created.json() as ClientButton).id;

    const clientView = await app.inject({
      method: 'GET',
      url: '/api/client-buttons',
      headers: auth(player),
    });
    expect((clientView.json() as ClientButton[]).some((b) => b.id === id)).toBe(false);

    const adminView = await app.inject({
      method: 'GET',
      url: '/api/admin/client-buttons',
      headers: auth(admin),
    });
    expect((adminView.json() as ClientButton[]).some((b) => b.id === id)).toBe(true);
  });

  it('filters the client list by placement', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/client-buttons?placement=game-menu',
      headers: auth(player),
    });
    expect(response.json()).toEqual([]);
  });

  it('refuses a link that is not http or https', async () => {
    for (const url of ['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'ftp://x/y']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/client-buttons',
        headers: auth(admin),
        payload: { label: 'Bad', url },
      });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('keeps button management away from a non-admin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/client-buttons',
      headers: auth(player),
      payload: { label: 'Nope', url: 'https://example.com' },
    });
    expect(response.statusCode).toBe(403);
  });

  /* --------------------------------------------------------------- matching */

  it('matches folder names against catalog titles', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/games/match-local',
      headers: auth(player),
      payload: { names: ['Cave Story', 'Hollow Knight'] },
    });
    expect(response.statusCode).toBe(200);

    const { results } = response.json() as { results: LocalGameMatch[] };
    expect(results).toHaveLength(2);
    expect(results[0]?.matches[0]?.title).toBe('Cave Story');
    expect(results[0]?.matches[0]?.score).toBe(1);
    expect(results[1]?.matches[0]?.title).toBe('Hollow Knight');
  });

  it('sees through the release-name noise a real folder carries', async () => {
    // Exactly the shape a repacked folder on a player's drive has.
    const response = await app.inject({
      method: 'POST',
      url: '/api/games/match-local',
      headers: auth(player),
      payload: { names: ['Hollow.Knight.v1.5.78.11.GOG-FitGirl [Repack]'] },
    });

    const { results } = response.json() as { results: LocalGameMatch[] };
    expect(results[0]?.matches[0]?.title).toBe('Hollow Knight');
  });

  it('offers nothing for a folder that resembles no game in the catalog', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/games/match-local',
      headers: auth(player),
      payload: { names: ['Tax Returns 2019'] },
    });

    const { results } = response.json() as { results: LocalGameMatch[] };
    expect(results[0]?.matches).toEqual([]);
  });

  it('rejects an unauthenticated match request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/games/match-local',
      payload: { names: ['Cave Story'] },
    });
    expect(response.statusCode).toBe(401);
  });
});
