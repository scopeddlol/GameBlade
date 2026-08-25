import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { gameAchievementRules, games, libraries } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Adding achievements to more than one game at a time.
 *
 * The parts worth pinning down are the ones that decide whether a catalog of
 * several hundred games can actually be covered: that a pasted list arrives
 * whole and in order, that replacing takes the orphaned unlock rules with it,
 * and that one awkward game in a batch is reported rather than ending the run.
 */
describe('bulk achievements', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-bulk-achv-test-'));
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
        steamAppId: 200900,
      })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const paste = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/admin/games/g1/achievements/bulk',
      headers: auth(),
      payload,
    });

  /* ------------------------------------------------------------- pasted list */

  it('writes a whole list in one request, in the order it was given', async () => {
    const response = await paste({
      achievements: [
        { key: 'second', name: 'Second', sortOrder: 1 },
        { key: 'first', name: 'First', sortOrder: 0 },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ written: 2, total: 2 });

    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/games/g1/achievements',
        headers: auth(),
      })
    ).json() as Array<{ key: string }>;

    expect(list.map((entry) => entry.key)).toEqual(['first', 'second']);
  });

  it('merges by key rather than duplicating, so a corrected list can be re-pasted', async () => {
    const response = await paste({
      achievements: [{ key: 'first', name: 'First Blood', points: 25 }],
    });

    expect(response.json()).toMatchObject({ written: 1, total: 2 });

    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/games/g1/achievements',
        headers: auth(),
      })
    ).json() as Array<{ key: string; name: string; points: number }>;

    const first = list.find((entry) => entry.key === 'first');
    expect(first).toMatchObject({ name: 'First Blood', points: 25 });
  });

  it('takes the last of a repeated key instead of failing the whole paste', async () => {
    // A repeated key in a pasted list is a typo, not a reason to reject two
    // hundred good rows alongside it.
    const response = await paste({
      achievements: [
        { key: 'dupe', name: 'Earlier' },
        { key: 'dupe', name: 'Later' },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ written: 1 });

    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/games/g1/achievements',
        headers: auth(),
      })
    ).json() as Array<{ key: string; name: string }>;

    expect(list.find((entry) => entry.key === 'dupe')?.name).toBe('Later');
  });

  /**
   * Replacing has to take the rules with it.
   *
   * `game_achievement_rules.achievement_key` is plain text with no foreign key
   * to the definition, so wiping the definitions alone leaves rules naming
   * keys that no longer exist — which unlock nothing and are invisible.
   */
  it('clears the unlock rules when it replaces the definitions', async () => {
    const db = app.gameblade.db;

    const generated = await app.inject({
      method: 'POST',
      url: '/api/games/g1/achievement-rules/generate',
      headers: auth(),
      payload: {},
    });
    expect(generated.statusCode).toBe(200);
    expect(
      db.select().from(gameAchievementRules).where(eq(gameAchievementRules.gameId, 'g1')).all()
        .length,
    ).toBeGreaterThan(0);

    await paste({ achievements: [{ key: 'only', name: 'Only' }], replace: true });

    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/games/g1/achievements',
        headers: auth(),
      })
    ).json() as Array<{ key: string }>;
    expect(list.map((entry) => entry.key)).toEqual(['only']);

    expect(
      db.select().from(gameAchievementRules).where(eq(gameAchievementRules.gameId, 'g1')).all(),
    ).toEqual([]);
  });

  it('refuses a paste with nothing in it rather than reporting a success', async () => {
    expect((await paste({ achievements: [] })).statusCode).toBe(400);
  });

  /* -------------------------------------------------------------- bulk import */

  it('reports a game it cannot act on instead of failing the batch', async () => {
    // No Steam key is configured here, so every game in the batch fails for
    // the same reason — which is exactly the shape a real batch takes when
    // one title cannot be placed, and must arrive as rows rather than a 500.
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/achievements/bulk-import',
      headers: auth(),
      payload: { gameIds: ['g1', 'does-not-exist'], skipExisting: false },
    });

    expect(response.statusCode).toBe(200);
    const { results } = response.json() as {
      results: Array<{ gameId: string; status: string; message: string }>;
    };

    expect(results).toHaveLength(2);
    expect(results.map((entry) => entry.gameId)).toEqual(['g1', 'does-not-exist']);
    expect(results.every((entry) => entry.status === 'failed')).toBe(true);
    expect(results[1]?.message).toMatch(/no longer in the catalog/i);
  });

  it('leaves a game that already has achievements alone by default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/achievements/bulk-import',
      headers: auth(),
      payload: { gameIds: ['g1'] },
    });

    const { results } = response.json() as {
      results: Array<{ status: string; message: string }>;
    };
    expect(results[0]).toMatchObject({ status: 'skipped' });
    expect(results[0]?.message).toMatch(/already has/i);
  });

  it('will not take a batch larger than the client is meant to send', async () => {
    // The cap is what keeps a request from sitting open for minutes with
    // nothing to report; a client ignoring it should be told, not obeyed.
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/achievements/bulk-import',
      headers: auth(),
      payload: { gameIds: Array.from({ length: 40 }, (_, at) => `g${at}`) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('is closed to anyone who is not an administrator', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/achievements/bulk-import',
          payload: { gameIds: ['g1'] },
        })
      ).statusCode,
    ).toBe(401);
  });
});
