import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { gameFiles, gameLaunchRules, games, libraries } from '../db/schema.js';

interface Report {
  checkedAt: string;
  disks: Array<{ label: string; freeBytes: number; totalBytes: number }>;
  findings: Array<{ id: string; severity: string; count?: number }>;
  lastScanAt: string | null;
}

/**
 * The page that says what is wrong, rather than what happened.
 *
 * Its value is entirely in not missing things, so the tests are about which
 * findings appear for which state of the catalog.
 */
describe('health report', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });
  const report = async (): Promise<Report> =>
    (
      await app.inject({ method: 'GET', url: '/api/admin/health', headers: auth() })
    ).json() as Report;
  const idsIn = async () => (await report()).findings.map((f) => f.id);

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-health-test-'));
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
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('says the catalog is empty before anything is added', async () => {
    expect(await idsIn()).toContain('empty-catalog');
  });

  it('reports free space on the data directory', async () => {
    const { disks } = await report();
    const data = disks.find((disk) => disk.label === 'Data');
    expect(data?.totalBytes).toBeGreaterThan(0);
    expect(data?.freeBytes).toBeGreaterThan(0);
  });

  it('flags games with no launch rule and no save rule', async () => {
    const db = app.gameblade.db;
    db.insert(libraries).values({ id: 'lib1', name: 'Main', path: dataDir }).run();
    for (const id of ['g1', 'g2']) {
      db.insert(games)
        .values({
          id,
          libraryId: 'lib1',
          relPath: id,
          kind: 'folder',
          title: id,
          sortTitle: id,
          searchTitle: id,
        })
        .run();
    }

    const ids = await idsIn();
    expect(ids).toContain('no-launch-rule');
    expect(ids).toContain('no-save-rule');
    expect(ids).not.toContain('empty-catalog');
  });

  it('stops counting a game once it has a rule', async () => {
    app.gameblade.db
      .insert(gameLaunchRules)
      .values({ id: 'lr1', gameId: 'g1', executable: 'game.exe' })
      .run();

    const finding = (await report()).findings.find((f) => f.id === 'no-launch-rule');
    expect(finding?.count).toBe(1);
  });

  it('raises a game that has gone from disk as critical', async () => {
    app.gameblade.db
      .update(games)
      .set({ missingAt: new Date().toISOString() })
      .where(eq(games.id, 'g2'))
      .run();

    const finding = (await report()).findings.find((f) => f.id === 'missing-games');
    expect(finding?.severity).toBe('critical');
  });

  it('says nothing about checksums until a verification has run', async () => {
    // Every file starts with integrity null, which is not a finding.
    app.gameblade.db
      .insert(gameFiles)
      .values({
        id: 'f1',
        gameId: 'g1',
        relPath: 'a.dat',
        sizeBytes: 10,
        modifiedAt: new Date().toISOString(),
        sha256: 'abc',
      })
      .run();
    expect(await idsIn()).not.toContain('checksum-drift');
  });

  it('raises drift once verification finds a file that changed', async () => {
    app.gameblade.db
      .update(gameFiles)
      .set({ integrity: 'mismatch', verifiedAt: new Date().toISOString() })
      .where(eq(gameFiles.id, 'f1'))
      .run();

    const finding = (await report()).findings.find((f) => f.id === 'checksum-drift');
    expect(finding).toMatchObject({ severity: 'critical', count: 1 });
  });

  it('keeps the report to administrators', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/admin/health' });
    expect(response.statusCode).toBe(401);
  });
});
