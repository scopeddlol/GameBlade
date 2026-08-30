import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type LaunchRuleRow } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { gameFiles, gameLaunchRules, games, libraries } from '../db/schema.js';

/**
 * The Launch Rules tab.
 *
 * The point of the page is that a rule is picked from what is really inside a
 * game rather than typed from memory, so what is worth pinning down is the
 * suggestion: it has to prefer the executable named after the game over the
 * merely largest one, because a game shipping a fat launcher beside a small
 * binary is the common case that size alone gets wrong.
 */
describe('launch rules', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  const page = async (query = 'status=all'): Promise<{ items: LaunchRuleRow[]; total: number }> =>
    (
      await app.inject({ method: 'GET', url: `/api/admin/launch-rules?${query}`, headers: auth() })
    ).json();

  const rowFor = async (gameId: string, query = 'status=all') =>
    (await page(query)).items.find((item) => item.gameId === gameId);

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-launch-test-'));

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
      ['g1', 'Cave Story'],
      ['g2', 'Nothing Runnable'],
      ['g3', 'Already Set'],
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

    const files: Array<[string, string, string, number]> = [
      // A launcher four times the size of the game, plus an installer that
      // must never be offered at all.
      ['f1', 'g1', 'Launcher.exe', 400_000_000],
      ['f2', 'g1', 'Cave Story.exe', 12_000_000],
      ['f3', 'g1', 'unins000.exe', 900_000],
      ['f4', 'g1', 'data/assets.pak', 800_000_000],
      ['f5', 'g2', 'readme.txt', 1_000],
      ['f6', 'g3', 'Game.exe', 5_000_000],
    ];
    for (const [id, gameId, relPath, sizeBytes] of files) {
      db.insert(gameFiles)
        .values({ id, gameId, relPath, sizeBytes, modifiedAt: '2026-01-01T00:00:00.000Z' })
        .run();
    }

    db.insert(gameLaunchRules).values({ id: 'lnr1', gameId: 'g3', executable: 'Game.exe' }).run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('offers the game a folder holds, and never its uninstaller', async () => {
    const row = await rowFor('g1');
    const paths = row?.candidates.map((candidate) => candidate.path) ?? [];

    expect(paths).toContain('Cave Story.exe');
    expect(paths).toContain('Launcher.exe');
    expect(paths).not.toContain('unins000.exe');
    // Non-executables never belong in a list of things to run.
    expect(paths).not.toContain('data/assets.pak');
  });

  it('suggests the executable named after the game, not the largest one', async () => {
    expect((await rowFor('g1'))?.suggestion).toBe('Cave Story.exe');
  });

  it('suggests nothing where nothing is runnable', async () => {
    const row = await rowFor('g2');
    expect(row?.candidates).toEqual([]);
    expect(row?.suggestion).toBeNull();
  });

  it('lists only the games still waiting on a rule by default', async () => {
    const ids = (await page('status=missing')).items.map((item) => item.gameId);
    expect(ids).toContain('g1');
    expect(ids).toContain('g2');
    expect(ids).not.toContain('g3');
  });

  it('writes a page of rules in one request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/launch-rules/apply',
      headers: auth(),
      payload: {
        rules: [
          { gameId: 'g1', executable: 'Cave Story.exe', args: '-windowed', workingDir: null },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ applied: 1, cleared: 0 });

    const row = await rowFor('g1');
    expect(row?.rule?.executable).toBe('Cave Story.exe');
    expect(row?.rule?.args).toBe('-windowed');
  });

  it('replaces rather than accumulating, so a game never has two rules', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/admin/launch-rules/apply',
      headers: auth(),
      payload: { rules: [{ gameId: 'g1', executable: 'Launcher.exe' }] },
    });

    const rules = app.gameblade.db.select().from(gameLaunchRules).all();
    expect(rules.filter((rule) => rule.gameId === 'g1')).toHaveLength(1);
    expect((await rowFor('g1'))?.rule?.executable).toBe('Launcher.exe');
  });

  it('treats an emptied executable as clearing the rule', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/launch-rules/apply',
      headers: auth(),
      payload: { rules: [{ gameId: 'g3', executable: '' }] },
    });

    expect(response.json()).toMatchObject({ applied: 0, cleared: 1 });
    expect((await rowFor('g3'))?.rule).toBeNull();
  });

  it('refuses a caller who is not an administrator', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/admin/launch-rules' });
    expect(response.statusCode).toBe(401);
  });
});
