import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type MeshAnalytics } from '@gameblade/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { games, libraries, meshNodeGames } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * What the Nodes section reads: the fleet's numbers, and the live map.
 *
 * Both exist because a mesh fails quietly. A node that stopped reporting still
 * looks enrolled; a fleet that has fallen back to the relay still looks like it
 * is working, while every byte crosses the coordinator it was meant to spare.
 * These pin the two numbers that say so — the share of traffic that stayed off
 * this server, and whether a tunnel is direct.
 */
describe('the coordinator’s view of its fleet', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const auth = (s: { cookie: string; csrf: string }) => ({
    cookie: s.cookie,
    [CSRF_HEADER]: s.csrf,
  });

  async function boot(env: Record<string, string> = {}) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-mesh-admin-'));
    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        ROLE: 'coordinator',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
        ...env,
      } as NodeJS.ProcessEnv),
    );
    await app.ready();

    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'archivist', password: 'a-long-enough-password' },
    });
    const raw = setup.headers['set-cookie'];
    const admin = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: (setup.json() as { csrfToken: string }).csrfToken,
    };

    return { app, admin };
  }

  /** Enrol one node the way an operator does: a code, then a registration. */
  async function enrol(
    app: Awaited<ReturnType<typeof buildApp>>,
    admin: { cookie: string; csrf: string },
    label: string,
    key: string,
  ) {
    const enrolment = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label, role: 'origin' },
    });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: {
        enrolmentToken: (enrolment.json() as { token: string }).token,
        publicKey: key.repeat(43),
        endpoints: [{ kind: 'local', address: '10.0.0.4', port: 47820 }],
      },
    });
    return registered.json() as { nodeId: string; nodeToken: string };
  }

  /** A game row in the node's own library, since a grant references one. */
  function addGame(app: Awaited<ReturnType<typeof buildApp>>, title: string): string {
    const db = app.gameblade.db;
    const libraryId = db.select().from(libraries).all()[0]!.id;
    const id = newId('gam');
    const now = new Date().toISOString();
    db.insert(games)
      .values({
        id,
        libraryId,
        relPath: title,
        kind: 'folder',
        title,
        sortTitle: title.toLowerCase(),
        searchTitle: title.toLowerCase(),
        sizeBytes: 1_024,
        fileCount: 1,
        contentMtime: now,
        matchStatus: 'unmatched',
        addedAt: now,
        updatedAt: now,
        scannedAt: now,
      })
      .run();
    return id;
  }

  it('reports a node’s catalog against the library it reports into', async () => {
    // The pairing that explains a node: it announces four hundred games while
    // its library holds two thousand, because the rest are not hashed yet.
    // Either number alone says nothing.
    const { app, admin } = await boot();
    const node = await enrol(app, admin, 'Loft NAS', 'a');
    const db = app.gameblade.db;

    const gameId = addGame(app, 'Hollow Knight');
    db.insert(meshNodeGames)
      .values({ nodeId: node.nodeId, gameId, contentHash: 'x'.repeat(64) })
      .run();

    const listed = await app.inject({
      method: 'GET',
      url: '/api/mesh/nodes',
      headers: auth(admin),
    });
    expect(listed.statusCode).toBe(200);

    const [first] = (listed.json() as { nodes: { label: string; libraryGames: number }[] }).nodes;
    expect(first!.label).toBe('Loft NAS');
    expect(first!.libraryGames).toBe(1);
  });

  it('counts a game no online node holds as one this server has to serve', async () => {
    const { app, admin } = await boot();
    await enrol(app, admin, 'Loft NAS', 'b');

    addGame(app, 'Celeste');

    const response = await app.inject({
      method: 'GET',
      url: '/api/mesh/analytics?days=7',
      headers: auth(admin),
    });
    expect(response.statusCode).toBe(200);

    const report = response.json() as MeshAnalytics;
    expect(report.coverage.games).toBe(1);
    expect(report.coverage.covered).toBe(0);
    // Nothing has been delivered at all, so the share is zero rather than NaN —
    // a division by nothing on a fresh server used to render as "NaN%".
    expect(report.bytes.meshShare).toBe(0);
    expect(report.history).toHaveLength(7);
  });

  it('keeps the fleet to administrators', async () => {
    const { app } = await boot();
    for (const url of ['/api/mesh/nodes', '/api/mesh/analytics']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    }
  });
});
