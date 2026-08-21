import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { achievements, games, libraries } from '../db/schema.js';

/**
 * Rules that turn a game's own files into unlocked achievements.
 *
 * Achievements have been definable since the start and nothing ever unlocked
 * one. These tests cover the half that was missing, and in particular that the
 * report endpoint cannot be used simply to ask for an achievement.
 */
describe('achievement rules', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  const rule = (over: Record<string, unknown> = {}) => ({
    achievementKey: 'first_blood',
    sourceTemplate: '{install}\\save\\stats.json',
    format: 'json',
    selector: 'stats.kills',
    comparator: 'at-least',
    value: '1',
    ...over,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-achv-test-'));
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
    db.insert(games)
      .values({
        id: 'g1',
        libraryId: 'lib1',
        relPath: 'Test',
        kind: 'folder',
        title: 'Test',
        sortTitle: 'test',
        searchTitle: 'test',
      })
      .run();
    db.insert(achievements)
      .values({ id: 'a1', gameId: 'g1', key: 'first_blood', name: 'First Blood' })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const put = (rules: unknown[]) =>
    app.inject({
      method: 'PUT',
      url: '/api/games/g1/achievement-rules',
      headers: auth(),
      payload: { rules },
    });

  it('stores rules and hands them back with the other rules', async () => {
    expect((await put([rule()])).statusCode).toBe(200);

    const rules = (
      await app.inject({ method: 'GET', url: '/api/games/g1/rules', headers: auth() })
    ).json() as { achievements: Array<{ achievementKey: string }> };

    expect(rules.achievements.map((r) => r.achievementKey)).toEqual(['first_blood']);
  });

  it('refuses a rule naming an achievement this game does not have', async () => {
    // Otherwise it could never fire and there would be no way to notice.
    const response = await put([rule({ achievementKey: 'not_a_real_key' })]);
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain(
      'not_a_real_key',
    );
  });

  it('replaces the whole set rather than merging', async () => {
    await put([rule()]);
    await put([]);
    const rules = (
      await app.inject({ method: 'GET', url: '/api/games/g1/rules', headers: auth() })
    ).json() as { achievements: unknown[] };
    expect(rules.achievements).toHaveLength(0);
  });

  it('unlocks what the client reports', async () => {
    await put([rule()]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/games/g1/achievements/report',
      headers: auth(),
      payload: { keys: ['first_blood'] },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { unlocked: unknown[] }).unlocked).toHaveLength(1);
  });

  it('ignores a reported key that has no rule', async () => {
    // The report endpoint must not be a way of simply asking for an
    // achievement; only keys an operator wrote a rule for can come through it.
    await put([rule()]);
    app.gameblade.db
      .insert(achievements)
      .values({ id: 'a2', gameId: 'g1', key: 'unruled', name: 'Unruled' })
      .run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/games/g1/achievements/report',
      headers: auth(),
      payload: { keys: ['unruled'] },
    });
    expect((response.json() as { unlocked: unknown[] }).unlocked).toHaveLength(0);
  });

  it('is idempotent, so a client re-reading the same save changes nothing', async () => {
    await put([rule()]);
    const report = () =>
      app.inject({
        method: 'POST',
        url: '/api/games/g1/achievements/report',
        headers: auth(),
        payload: { keys: ['first_blood'] },
      });
    await report();
    const second = (await report()).json() as {
      unlocked: Array<{ unlockedAt: string | null }>;
    };
    // Still reported as unlocked, but the timestamp is the original one.
    expect(second.unlocked).toHaveLength(1);
  });

  it('keeps rule writing to administrators', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/games/g1/achievement-rules',
      payload: { rules: [rule()] },
    });
    expect(response.statusCode).toBe(401);
  });
});
