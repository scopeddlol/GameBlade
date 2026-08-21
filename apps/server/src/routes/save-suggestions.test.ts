import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { gameSaveRules, games, libraries } from '../db/schema.js';

interface Suggestion {
  gameId: string;
  title: string;
  matchedTitle: string;
  hasExistingRule: boolean;
  saves: Array<{ pathTemplate: string; include: string | null }>;
}

/**
 * Suggesting save rules from the upstream manifest.
 *
 * The point of the feature is that an operator stops playing every game to
 * find where it saved. The point of these tests is that it never writes a rule
 * they did not look at first.
 */
describe('save-path suggestions', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-saves-test-'));

    // Stand in for the download, so the tests never reach the network.
    await writeFile(
      path.join(dataDir, 'save-manifest.json'),
      JSON.stringify([
        { title: 'Celeste', saves: [{ pathTemplate: '{install}\\Saves', include: '*.celeste' }] },
        {
          title: 'Stardew Valley',
          saves: [
            { pathTemplate: '{localappdata}\\Packages\\x\\wgs', include: null },
            { pathTemplate: '{appdata}\\StardewValley\\Saves', include: null },
          ],
        },
      ]),
      'utf8',
    );

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
    admin = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: (setup.json() as { csrfToken: string }).csrfToken,
    };

    const db = app.gameblade.db;
    db.insert(libraries).values({ id: 'lib1', name: 'Main', path: '/srv/games' }).run();
    for (const [id, title] of [
      ['g1', 'Celeste'],
      ['g2', 'stardew valley'],
      ['g3', 'Some Homebrew Thing'],
    ]) {
      db.insert(games)
        .values({
          id,
          libraryId: 'lib1',
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

  const suggest = async (): Promise<Suggestion[]> =>
    (
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/save-manifest/suggestions',
          headers: auth(),
        })
      ).json() as { suggestions: Suggestion[] }
    ).suggestions;

  it('matches catalog titles however they are cased', async () => {
    const titles = (await suggest()).map((s) => s.title);
    expect(titles).toContain('Celeste');
    expect(titles).toContain('stardew valley');
  });

  it('says nothing about a game the manifest does not know', async () => {
    expect((await suggest()).map((s) => s.title)).not.toContain('Some Homebrew Thing');
  });

  it('offers the install-relative path first', async () => {
    const celeste = (await suggest()).find((s) => s.title === 'Celeste');
    expect(celeste?.saves[0]).toEqual({ pathTemplate: '{install}\\Saves', include: '*.celeste' });
  });

  it('puts a Microsoft Store container path last', async () => {
    const stardew = (await suggest()).find((s) => s.title === 'stardew valley');
    expect(stardew?.saves[0]?.pathTemplate).toBe('{appdata}\\StardewValley\\Saves');
  });

  it('writes nothing until the operator confirms', async () => {
    // Reading suggestions must never be a side effect.
    const before = app.gameblade.db.select().from(gameSaveRules).all();
    await suggest();
    expect(app.gameblade.db.select().from(gameSaveRules).all()).toHaveLength(before.length);
  });

  it('stores exactly the path that was confirmed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/save-manifest/apply',
      headers: auth(),
      payload: {
        rules: [{ gameId: 'g1', pathTemplate: '{install}\\Saves', include: '*.celeste' }],
      },
    });
    expect((response.json() as { applied: number }).applied).toBe(1);

    const rule = app.gameblade.db
      .select()
      .from(gameSaveRules)
      .all()
      .find((r) => r.gameId === 'g1');
    expect(rule).toMatchObject({ pathTemplate: '{install}\\Saves', include: '*.celeste' });
  });

  it('replaces rather than accumulating, as the single-rule model requires', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/admin/save-manifest/apply',
      headers: auth(),
      payload: { rules: [{ gameId: 'g1', pathTemplate: '{appdata}\\Other', include: null }] },
    });

    const rules = app.gameblade.db
      .select()
      .from(gameSaveRules)
      .all()
      .filter((r) => r.gameId === 'g1');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pathTemplate).toBe('{appdata}\\Other');
  });

  it('flags a game that already has a rule so it is not silently replaced', async () => {
    const celeste = (await suggest()).find((s) => s.title === 'Celeste');
    expect(celeste?.hasExistingRule).toBe(true);
  });

  it('ignores a game id that does not exist rather than failing the batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/save-manifest/apply',
      headers: auth(),
      payload: {
        rules: [
          { gameId: 'nope', pathTemplate: '{appdata}\\X', include: null },
          { gameId: 'g2', pathTemplate: '{appdata}\\StardewValley\\Saves', include: null },
        ],
      },
    });
    expect((response.json() as { applied: number }).applied).toBe(1);
  });

  it('keeps all of this behind the admin scope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/save-manifest/suggestions',
    });
    expect(response.statusCode).toBe(401);
  });
});
