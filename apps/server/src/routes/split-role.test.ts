import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, MESH_CHUNK_BYTES } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { startSchedules } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { gameFileChunks, gameFiles, games, libraries, meshNodes } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * A coordinator and its nodes, as an assembly rather than as three roles.
 *
 * Each of these pins a step that was impossible in 0.6.1, and the reason they
 * are worth tests is that every one of them fails silently. A coordinator that
 * scans does not error, it flags a catalog. A node that cannot hash does not
 * warn, it holds a library nobody is offered. Nothing here is visible from a
 * standalone server, which is exactly how it survived a release — so these run
 * the split roles specifically.
 */
describe('the split-role topology', () => {
  const cleanups: (() => Promise<void>)[] = [];

  const auth = (s: { cookie: string; csrf: string }) => ({
    cookie: s.cookie,
    [CSRF_HEADER]: s.csrf,
  });

  /** A running instance in one role, torn down after the test. */
  async function boot(env: Record<string, string>) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-split-test-'));
    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
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

    return { app, dataDir };
  }

  async function signIn(app: FastifyInstance) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'archivist', password: 'a-long-enough-password' },
    });
    expect(response.statusCode).toBe(201);
    const raw = response.headers['set-cookie'];
    return {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: (response.json() as { csrfToken: string }).csrfToken,
    };
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /* ------------------------------------------------------- library records */

  it('lets a coordinator register a library whose path is not on this machine', async () => {
    // The whole topology hangs off this. A node's catalog is filed into an
    // assigned library and reports are refused until one exists, so a
    // coordinator that cannot create a library cannot be given a node — and it
    // holds no game files, so no path it would accept is ever mounted on it.
    const { app } = await boot({ ROLE: 'coordinator' });
    const admin = await signIn(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/libraries',
      headers: auth(admin),
      payload: { name: 'Node A', path: '/libraries/node-a' },
    });

    expect(created.statusCode).toBe(201);
    expect((created.json() as { path: string }).path).toBe('/libraries/node-a');
  });

  it('still refuses a path that is not there when this machine reads its own files', async () => {
    // The check is right on a standalone server: a library nobody can read is
    // a scan that finds nothing for a week and says so nowhere.
    const { app } = await boot({ ROLE: 'standalone' });
    const admin = await signIn(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/libraries',
      headers: auth(admin),
      payload: { name: 'Missing', path: '/no/such/library' },
    });

    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({
      error: { message: expect.stringContaining('not a readable directory') },
    });
  });

  /* -------------------------------------------------------------- scanning */

  it('does not scan on a coordinator, whatever the scanning settings say', async () => {
    // An empty directory reads as a library whose games have all been deleted,
    // so a coordinator that scans flags the entire catalog its nodes just
    // reported. It has no disk to scan; the role decides rather than leaving
    // two more variables to get right.
    const { app } = await boot({
      ROLE: 'coordinator',
      SCAN_ON_START: 'true',
      SCAN_INTERVAL_MINUTES: '1',
    });

    let scans = 0;
    app.gameblade.scanner.scan = (async () => {
      scans += 1;
    }) as typeof app.gameblade.scanner.scan;

    const stop = startSchedules(app);
    try {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(scans).toBe(0);
    } finally {
      stop();
    }
  }, 10_000);

  it('still scans on a standalone server', async () => {
    const { app } = await boot({ ROLE: 'standalone', SCAN_ON_START: 'true' });

    let scans = 0;
    app.gameblade.scanner.scan = (async () => {
      scans += 1;
    }) as typeof app.gameblade.scanner.scan;

    const stop = startSchedules(app);
    try {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(scans).toBe(1);
    } finally {
      stop();
    }
  }, 10_000);

  /* -------------------------------------------------------------- hashing */

  it('hashes its own games on a node, since nothing can ask it to', async () => {
    // A node has no API. Either the sweep runs itself or the machine holds a
    // library that is never offered to a single client, and every part of that
    // looks healthy: the games are there, the scan worked, the node is online.
    const { app, dataDir } = await boot({
      ROLE: 'node',
      COORDINATOR_URL: 'https://coordinator.invalid',
    });
    const db = app.gameblade.db;

    const libraryDir = path.join(dataDir, 'library');
    await mkdir(path.join(libraryDir, 'Held'), { recursive: true });
    await writeFile(path.join(libraryDir, 'Held', 'game.bin'), Buffer.alloc(4096, 9));

    const libraryId = newId('lib');
    db.insert(libraries).values({ id: libraryId, name: 'Local', path: libraryDir }).run();

    const gameId = newId('gam');
    db.insert(games)
      .values({
        id: gameId,
        libraryId,
        relPath: 'Held',
        kind: 'folder',
        title: 'Held',
        sortTitle: 'held',
        searchTitle: 'held',
        sizeBytes: 4096,
        fileCount: 1,
      })
      .run();
    db.insert(gameFiles)
      .values({
        id: newId('gfl'),
        gameId,
        relPath: 'game.bin',
        sizeBytes: 4096,
        modifiedAt: new Date().toISOString(),
      })
      .run();

    expect(app.gameblade.chunks.isGameChunked(gameId)).toBe(false);

    // The sweep is on a timer measured in tens of seconds, so drive it
    // directly: what is under test is that a node does this at all, and that
    // the same call on a coordinator would have nothing to work with.
    const result = await app.gameblade.chunks.hashUnhashed();

    expect(result).toEqual({ hashed: 1, failed: 0 });
    expect(app.gameblade.chunks.isGameChunked(gameId)).toBe(true);
  });

  /* --------------------------------------------------- what a node is told */

  it('tells a node about its own library and nobody else’s', async () => {
    // Two nodes on one coordinator is the ordinary case, and each was being
    // handed the other's catalog: a request per game, then a stat of every
    // file of a game on a different machine, on a timer, for ever.
    const { app, dataDir } = await boot({ ROLE: 'coordinator' });
    const admin = await signIn(app);
    const db = app.gameblade.db;

    const libraryDir = path.join(dataDir, 'library');
    await mkdir(path.join(libraryDir, 'Held'), { recursive: true });
    await writeFile(path.join(libraryDir, 'Held', 'game.bin'), Buffer.alloc(16, 3));

    /** A library holding one fully hashed game, so it is mesh-eligible. */
    const seed = (name: string, relPath: string) => {
      const libraryId = newId('lib');
      // Its own path: library paths are unique, and on a coordinator they are
      // labels a node's catalog is filed under rather than folders it reads.
      db.insert(libraries)
        .values({ id: libraryId, name, path: path.join(libraryDir, libraryId) })
        .run();

      const gameId = newId('gam');
      db.insert(games)
        .values({
          id: gameId,
          libraryId,
          relPath,
          kind: 'folder',
          title: relPath,
          sortTitle: relPath.toLowerCase(),
          searchTitle: relPath.toLowerCase(),
          sizeBytes: 16,
          fileCount: 1,
        })
        .run();

      const fileId = newId('gfl');
      db.insert(gameFiles)
        .values({
          id: fileId,
          gameId,
          relPath: 'game.bin',
          sizeBytes: 16,
          modifiedAt: new Date().toISOString(),
          sha256: 'a'.repeat(64),
          chunkedAt: new Date().toISOString(),
          chunkBytes: MESH_CHUNK_BYTES,
        })
        .run();
      db.insert(gameFileChunks)
        .values({ fileId, chunkIndex: 0, sizeBytes: 16, sha256: 'b'.repeat(64) })
        .run();

      return { libraryId, gameId };
    };

    const mine = seed('Node A', 'Held');
    const theirs = seed('Node B', 'Elsewhere');

    const enrolment = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label: 'Node A', role: 'origin' },
    });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: {
        enrolmentToken: (enrolment.json() as { token: string }).token,
        publicKey: 'k'.repeat(43),
        endpoints: [],
      },
    });
    const node = registered.json() as { nodeId: string; nodeToken: string };

    // Unassigned, a node is a mirror and syncs against everything.
    const everything = await app.inject({
      method: 'GET',
      url: '/api/mesh/catalog',
      headers: {
        authorization: `Bearer ${node.nodeToken}`,
        'x-gameblade-node': node.nodeId,
      },
    });
    expect((everything.json() as { games: unknown[] }).games).toHaveLength(2);

    // Assigned, it is told only what it could possibly be holding.
    db.update(meshNodes)
      .set({ libraryId: mine.libraryId })
      .where(eq(meshNodes.id, node.nodeId))
      .run();

    const scoped = await app.inject({
      method: 'GET',
      url: '/api/mesh/catalog',
      headers: {
        authorization: `Bearer ${node.nodeToken}`,
        'x-gameblade-node': node.nodeId,
      },
    });

    const listed = (scoped.json() as { games: { gameId: string }[] }).games;
    expect(listed.map((game) => game.gameId)).toEqual([mine.gameId]);
    expect(listed.map((game) => game.gameId)).not.toContain(theirs.gameId);
  });
});
