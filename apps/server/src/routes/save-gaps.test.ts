import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { gameAchievementRules, gameSaveRules, games, libraries } from '../db/schema.js';

interface Gap {
  gameId: string;
  title: string;
  achievementCount: number;
  candidates: Array<{ pathTemplate: string; ruleCount: number }>;
}

/**
 * Reading a save location out of the achievement rules that already name one.
 *
 * The situation this exists for: a catalog where thirty games track
 * achievements and none of them sync. That is not thirty unknown save
 * locations — an unlock rule reads a file the game wrote into its own save
 * folder, so each of those games has had its save path written down already,
 * in a column that syncs nothing.
 */
describe('save rules derived from achievement rules', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-gaps-test-'));

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
      ['g1', 'Emulated Thing'],
      ['g2', 'Already Synced'],
      ['g3', 'No Achievements'],
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

    // Two rules into one folder, plus one nested a level deeper — the shape a
    // real Goldberg layout has, and the one that must fold into a single
    // proposal rather than two rules copying the same files twice.
    const rules = [
      ['r1', 'g1', 'first-blood', '{appdata}\\Goldberg SteamEmu Saves\\480\\achievements.json'],
      ['r2', 'g1', 'all-levels', '{appdata}\\Goldberg SteamEmu Saves\\480\\stats.json'],
      ['r3', 'g1', 'deep-cut', '{appdata}\\Goldberg SteamEmu Saves\\480\\slots\\1.sav'],
      ['r4', 'g2', 'already', '{documents}\\Already Synced\\progress.json'],
    ];
    for (const [id, gameId, achievementKey, sourceTemplate] of rules) {
      db.insert(gameAchievementRules)
        .values({
          id: id as string,
          gameId: gameId as string,
          achievementKey: achievementKey as string,
          sourceTemplate: sourceTemplate as string,
          format: 'json',
          selector: 'earned',
          comparator: 'truthy',
        })
        .run();
    }

    db.insert(gameSaveRules)
      .values({
        id: 'svr-existing',
        gameId: 'g2',
        pathTemplate: '{documents}\\Already Synced',
      })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const gaps = async (): Promise<Gap[]> =>
    (
      (
        await app.inject({ method: 'GET', url: '/api/admin/save-rules/gaps', headers: auth() })
      ).json() as { gaps: Gap[] }
    ).gaps;

  it('reports a game whose achievements are read from an unsynced folder', async () => {
    const found = await gaps();
    expect(found.map((gap) => gap.title)).toContain('Emulated Thing');
  });

  it('proposes one folder, not one per rule', async () => {
    const emulated = (await gaps()).find((gap) => gap.title === 'Emulated Thing');
    expect(emulated?.candidates).toEqual([
      { pathTemplate: '{appdata}\\Goldberg SteamEmu Saves\\480', ruleCount: 3 },
    ]);
  });

  it('counts the distinct achievements at stake', async () => {
    const emulated = (await gaps()).find((gap) => gap.title === 'Emulated Thing');
    expect(emulated?.achievementCount).toBe(3);
  });

  it('leaves out a game that already syncs', async () => {
    expect((await gaps()).map((gap) => gap.title)).not.toContain('Already Synced');
  });

  it('leaves out a game with nothing to derive from', async () => {
    expect((await gaps()).map((gap) => gap.title)).not.toContain('No Achievements');
  });

  it('writes the rule when asked, and stops reporting it', async () => {
    const before = (await gaps()).find((gap) => gap.title === 'Emulated Thing');
    expect(before).toBeDefined();

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/save-rules/from-achievements',
      headers: auth(),
      payload: {
        rules: [
          {
            gameId: 'g1',
            pathTemplate: '{appdata}\\Goldberg SteamEmu Saves\\480',
            include: null,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ applied: 1 });
    expect((await gaps()).map((gap) => gap.title)).not.toContain('Emulated Thing');
  });

  it('does not overwrite a rule somebody has already settled', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/save-rules/from-achievements',
      headers: auth(),
      payload: {
        rules: [{ gameId: 'g2', pathTemplate: '{appdata}\\Wrong Place', include: null }],
      },
    });

    expect(response.json()).toMatchObject({ applied: 0 });

    const rule = app.gameblade.db.select().from(gameSaveRules).all().find((r) => r.gameId === 'g2');
    expect(rule?.pathTemplate).toBe('{documents}\\Already Synced');
  });
});
