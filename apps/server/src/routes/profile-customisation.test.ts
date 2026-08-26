import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type ProfileDetail } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { games, libraries } from '../db/schema.js';

/**
 * The things that make a profile somebody's rather than a name and an avatar.
 *
 * Two of these carry real risk and are what the tests are mostly about: a link
 * ends up in an `href`, so a `javascript:` URL there is somebody else's script
 * running for everyone who opens the profile; and a pinned game is a foreign
 * key, so an id that does not exist has to be refused rather than allowed to
 * fail as a constraint error nobody can act on.
 */
describe('profile customisation', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string; id: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  const save = (patch: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/profile', headers: auth(), payload: patch });

  const profile = async (): Promise<ProfileDetail> =>
    (
      await app.inject({ method: 'GET', url: `/api/profiles/${admin.id}`, headers: auth() })
    ).json() as ProfileDetail;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-profile-custom-test-'));
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

    const db = app.gameblade.db;
    db.insert(libraries).values({ id: 'lib1', name: 'Main', path: '/srv/games' }).run();
    db.insert(games)
      .values({
        id: 'g1',
        libraryId: 'lib1',
        relPath: 'Hollow Knight',
        kind: 'folder',
        title: 'Hollow Knight',
        sortTitle: 'hollow knight',
        searchTitle: 'hollow knight',
      })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps pronouns and a status line', async () => {
    expect(
      (await save({ pronouns: 'they/them', tagline: 'Chasing the last one' })).statusCode,
    ).toBe(200);

    const detail = await profile();
    expect(detail.pronouns).toBe('they/them');
    expect(detail.tagline).toBe('Chasing the last one');
  });

  it('remembers where the banner is cropped', async () => {
    await save({ bannerPosition: 20 });
    expect((await profile()).bannerPosition).toBe(20);
  });

  it('refuses a banner position outside the image', async () => {
    expect((await save({ bannerPosition: 240 })).statusCode).toBe(400);
    expect((await profile()).bannerPosition).toBe(20);
  });

  it('stores labelled links', async () => {
    await save({ links: [{ label: 'Site', url: 'https://example.com' }] });
    expect((await profile()).links).toEqual([{ label: 'Site', url: 'https://example.com' }]);
  });

  it('refuses a link that is not http, since it lands in an href', async () => {
    // eslint-disable-next-line no-script-url
    const attack = { label: 'Click me', url: 'javascript:alert(1)' };
    expect((await save({ links: [attack] })).statusCode).toBe(400);

    // And the previous, legitimate list is untouched by the rejection.
    expect((await profile()).links).toEqual([{ label: 'Site', url: 'https://example.com' }]);
  });

  it('caps how many links a profile can carry', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      label: `L${index}`,
      url: `https://example.com/${index}`,
    }));
    expect((await save({ links: many })).statusCode).toBe(400);
  });

  it('clears the links when given an empty list', async () => {
    await save({ links: [] });
    expect((await profile()).links).toEqual([]);
  });

  it('pins a game and shows its cover', async () => {
    await save({ favoriteGameId: 'g1' });
    expect((await profile()).favoriteGame).toMatchObject({ id: 'g1', title: 'Hollow Knight' });
  });

  it('ignores a pin for a game that is not here rather than failing the save', async () => {
    // A constraint error at this point would reject an otherwise valid profile
    // edit with a message about foreign keys.
    const response = await save({ favoriteGameId: 'no-such-game', tagline: 'still saved' });
    expect(response.statusCode).toBe(200);

    const detail = await profile();
    expect(detail.favoriteGame).toBeNull();
    expect(detail.tagline).toBe('still saved');
  });

  it('unpins when asked', async () => {
    await save({ favoriteGameId: 'g1' });
    await save({ favoriteGameId: null });
    expect((await profile()).favoriteGame).toBeNull();
  });
});
