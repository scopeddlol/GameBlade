import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('refuses to give a coordinator a library folder, because it has no disk', async () => {
    // A coordinator holds no game files, so a folder to add is a folder that
    // is not there. It used to be allowed — the topology could not be
    // assembled otherwise — and that is no longer true: an enrolling node
    // creates the library it reports into, so the only thing this offered was
    // a path nothing reads and a Scan button that walked it and flagged the
    // whole catalog as missing.
    const { app } = await boot({ ROLE: 'coordinator' });
    const admin = await signIn(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/libraries',
      headers: auth(admin),
      payload: { name: 'Node A', path: '/libraries/node-a' },
    });

    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({
      error: { code: 'no_local_files' },
    });

    // And the same for the scan it used to offer beside it.
    const scanned = await app.inject({
      method: 'POST',
      url: '/api/admin/scan',
      headers: auth(admin),
      payload: {},
    });
    expect(scanned.statusCode).toBe(409);
    expect(scanned.json()).toMatchObject({ error: { code: 'no_local_files' } });
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

  /* ---------------------------------------------------------------- setup */

  it('serves a setup form while it has no coordinator, and takes one', async () => {
    // The deployment path: bring a node up with nothing configured, open it,
    // and point it at a coordinator from the page itself. Every alternative
    // means editing a compose file on the machine with the games on it.
    const { app, dataDir } = await boot({ ROLE: 'node' });

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Set this node up');
    expect(page.body).toContain('Coordinator address');

    const before = (await app.inject({ method: 'GET', url: '/api/node/status' })).json() as {
      configured: boolean;
      coordinatorUrl: string | null;
    };
    expect(before.configured).toBe(false);
    expect(before.coordinatorUrl).toBeNull();

    const saved = await app.inject({
      method: 'POST',
      url: '/api/node/setup',
      payload: {
        coordinatorUrl: 'https://games.example.com/',
        enrolmentToken: 'enrol-me-please',
      },
    });
    expect(saved.statusCode).toBe(202);

    // Written where both halves of a node read it, not held in this process:
    // the mesh agent is the one that registers, and it is a different process.
    const state = JSON.parse(
      await readFile(path.join(dataDir, 'node-state.json'), 'utf8'),
    ) as Record<string, string>;
    expect(state.coordinatorUrl).toBe('https://games.example.com');
    expect(state.enrolmentToken).toBe('enrol-me-please');

    const after = (await app.inject({ method: 'GET', url: '/api/node/status' })).json() as {
      configured: boolean;
      coordinatorUrl: string | null;
    };
    expect(after.configured).toBe(true);
    expect(after.coordinatorUrl).toBe('https://games.example.com');
  });

  it('keeps the key the agent already generated', async () => {
    // The agent owns this node's identity and may be writing it while somebody
    // is filling in the form. Replacing the file rather than merging into it
    // would lose the key, and this machine would enrol twice under two
    // identities — the coordinator would see a stranger holding the same games.
    const { app, dataDir } = await boot({ ROLE: 'node' });

    await writeFile(
      path.join(dataDir, 'node-state.json'),
      JSON.stringify({ secretKey: 'the-agents-key' }),
      'utf8',
    );

    const saved = await app.inject({
      method: 'POST',
      url: '/api/node/setup',
      payload: { coordinatorUrl: 'https://games.example.com', enrolmentToken: 'code' },
    });
    expect(saved.statusCode).toBe(202);

    const state = JSON.parse(
      await readFile(path.join(dataDir, 'node-state.json'), 'utf8'),
    ) as Record<string, string>;
    expect(state.secretKey).toBe('the-agents-key');
    expect(state.coordinatorUrl).toBe('https://games.example.com');
  });

  it('refuses setup once the node is enrolled', async () => {
    // The form is a first-run screen and closes like one. An enrolled node is
    // back to having nothing a request can change.
    const { app, dataDir } = await boot({ ROLE: 'node' });

    await writeFile(
      path.join(dataDir, 'node-state.json'),
      JSON.stringify({ secretKey: 'k', nodeId: 'nod_1', nodeToken: 't' }),
      'utf8',
    );

    const refused = await app.inject({
      method: 'POST',
      url: '/api/node/setup',
      payload: { coordinatorUrl: 'https://elsewhere.example.com', enrolmentToken: 'code' },
    });
    expect(refused.statusCode).toBe(409);

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.body).not.toContain('Set this node up');
  });

  it('refuses an address that is not one', async () => {
    // A typo here becomes a node retrying an unresolvable host for ever, with
    // nothing on the page to say which of the two fields was wrong.
    const { app } = await boot({ ROLE: 'node' });

    for (const coordinatorUrl of ['games.example.com', 'file:///etc/passwd', 'not a url']) {
      const refused = await app.inject({
        method: 'POST',
        url: '/api/node/setup',
        payload: { coordinatorUrl, enrolmentToken: 'code' },
      });
      expect(refused.statusCode, coordinatorUrl).toBe(400);
    }
  });

  it('gives a coordinator no setup route at all', async () => {
    // It is a node's first-run screen, and a coordinator has its own. Nothing
    // about this should exist on the machine with the accounts on it.
    const { app } = await boot({ ROLE: 'coordinator' });
    await signIn(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/node/setup',
      payload: { coordinatorUrl: 'https://games.example.com', enrolmentToken: 'code' },
    });
    expect(response.statusCode).toBe(404);
  });

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
    await mkdir(libraryDir, { recursive: true });
    await writeFile(path.join(libraryDir, 'Held.zip'), Buffer.alloc(4096, 9));

    const libraryId = newId('lib');
    db.insert(libraries).values({ id: libraryId, name: 'Local', path: libraryDir }).run();

    const gameId = newId('gam');
    db.insert(games)
      .values({
        id: gameId,
        libraryId,
        relPath: 'Held.zip',
        kind: 'archive',
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
        relPath: 'Held.zip',
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

  /* ------------------------------------------------------ pairing a node */

  it('makes a library for a node when it registers, named after it', async () => {
    // Previously an operator had to create a library, give it a path that does
    // not exist on this machine, and come back to assign it — three steps of
    // ceremony around a decision with one sensible answer, during which the
    // node reported into nothing and said so only in a log.
    const { app } = await boot({ ROLE: 'coordinator' });
    const admin = await signIn(app);
    const db = app.gameblade.db;

    expect(db.select().from(libraries).all()).toHaveLength(0);

    const enrolment = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label: 'Loft NAS', role: 'origin' },
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
    const nodeId = (registered.json() as { nodeId: string }).nodeId;

    const made = db.select().from(libraries).all();
    expect(made).toHaveLength(1);
    expect(made[0]!.name).toBe('Loft NAS');

    const node = db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();
    expect(node?.libraryId).toBe(made[0]!.id);
  });

  it('sends a node to an existing library when the code said to', async () => {
    // The migration case, and the reason this is decided on the code rather
    // than afterwards: assigning it after the node registers is a race the
    // operator loses. The node reports into its fresh library first, and the
    // catalog every achievement and save rule hangs off is orphaned.
    const { app } = await boot({ ROLE: 'coordinator' });
    const admin = await signIn(app);
    const db = app.gameblade.db;

    // Written directly, the way it really arrives: this is a standalone
    // server's library, in a database copied onto the coordinator. The API
    // refuses to create one here, because a coordinator has no folder to add.
    const libraryId = newId('lib');
    db.insert(libraries)
      .values({
        id: libraryId,
        name: 'The archive as it was',
        path: '/libraries/original',
        enabled: true,
        createdAt: new Date().toISOString(),
        lastScanAt: null,
        lastScanStatus: null,
      })
      .run();

    const enrolment = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label: 'Replacement NAS', role: 'origin', libraryId },
    });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: {
        enrolmentToken: (enrolment.json() as { token: string }).token,
        publicKey: 'j'.repeat(43),
        endpoints: [],
      },
    });

    const nodeId = (registered.json() as { nodeId: string }).nodeId;
    const node = db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();

    expect(node?.libraryId).toBe(libraryId);
    // And nothing new was invented alongside it.
    expect(db.select().from(libraries).all()).toHaveLength(1);
  });

  it('refuses a code pointed at a library that is not there', async () => {
    const { app } = await boot({ ROLE: 'coordinator' });
    const admin = await signIn(app);

    const refused = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label: 'Typo', role: 'origin', libraryId: 'lib_nonexistent' },
    });

    expect(refused.statusCode).toBe(404);
  });

  it('exposes and saves both mesh switches through admin settings', async () => {
    const { app } = await boot({ ROLE: 'coordinator' });
    const admin = await signIn(app);

    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: auth(admin),
      payload: { meshEnabled: true },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ meshEnabled: true });

    const reloaded = await app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: auth(admin),
    });
    expect(reloaded.json()).toMatchObject({ meshEnabled: true });
  });

  it('turns a batched hashed catalog into a node-backed desktop manifest', async () => {
    const { app } = await boot({ ROLE: 'coordinator' });
    const admin = await signIn(app);
    const db = app.gameblade.db;

    const enrolment = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label: 'Archive node', role: 'origin' },
    });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: {
        enrolmentToken: (enrolment.json() as { token: string }).token,
        publicKey: 'd'.repeat(43),
        endpoints: [{ kind: 'local', address: '10.0.0.20', port: 47820 }],
      },
    });
    const node = registered.json() as { nodeId: string; nodeToken: string };
    const nodeHeaders = {
      authorization: `Bearer ${node.nodeToken}`,
      'x-gameblade-node': node.nodeId,
    };
    const reportId = '00000000-0000-4000-8000-000000000067';
    const reported = (title: string, fill: string) => ({
      relPath: `${title}.zip`,
      kind: 'archive' as const,
      sizeBytes: 16,
      contentMtime: '2026-08-30T00:00:00.000Z',
      executables: [{ path: `bin/${title}.exe`, sizeBytes: 8 }],
      files: [
        {
          relPath: `${title}.zip`,
          sizeBytes: 16,
          modifiedAt: '2026-08-30T00:00:00.000Z',
          sha256: fill.repeat(64),
          chunkBytes: MESH_CHUNK_BYTES,
          chunks: [{ index: 0, sha256: fill.repeat(64), sizeBytes: 16 }],
        },
      ],
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/mesh/catalog/batch',
      headers: nodeHeaders,
      payload: { reportId, index: 0, final: false, games: [reported('Companion Game', 'a')] },
    });
    const final = await app.inject({
      method: 'POST',
      url: '/api/mesh/catalog/batch',
      headers: nodeHeaders,
      payload: { reportId, index: 1, final: true, games: [reported('Downloadable Game', 'b')] },
    });
    expect(first.statusCode).toBe(200);
    expect(final.statusCode).toBe(200);

    const catalog = db
      .select({ id: games.id, relPath: games.relPath })
      .from(games)
      .all()
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
    expect(catalog.map((game) => game.relPath)).toEqual([
      'Companion Game.zip',
      'Downloadable Game.zip',
    ]);

    const announced = catalog.map((game) => ({
      gameId: game.id,
      contentHash: app.gameblade.mesh.contentHashFor(game.id),
    }));
    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeHeaders,
      payload: {
        endpoints: [{ kind: 'local', address: '10.0.0.20', port: 47820 }],
        games: announced,
      },
    });
    expect(heartbeat.statusCode).toBe(200);

    const target = catalog.find((game) => game.relPath === 'Downloadable Game.zip')!;
    const manifest = await app.inject({
      method: 'GET',
      url: `/api/games/${target.id}/manifest`,
      headers: auth(admin),
    });
    expect(manifest.statusCode).toBe(200);
    const manifestBody = manifest.json() as {
      gameId: string;
      chunkBytes: number;
      originAvailable: boolean;
      files: Array<{ path: string; chunks: Array<{ index: number; sizeBytes: number }> }>;
      sources: Array<{ kind: string; nodeId?: string }>;
    };
    expect(manifestBody).toMatchObject({
      gameId: target.id,
      chunkBytes: MESH_CHUNK_BYTES,
      originAvailable: true,
      files: [{ path: 'Downloadable Game.zip', chunks: [{ index: 0, sizeBytes: 16 }] }],
    });
    expect(manifestBody.sources).toContainEqual(
      expect.objectContaining({ kind: 'node', nodeId: node.nodeId }),
    );

    const executableIndex = await app.inject({
      method: 'GET',
      url: `/api/admin/games/${target.id}/executables`,
      headers: auth(admin),
    });
    expect(executableIndex.statusCode).toBe(200);
    expect(executableIndex.json()).toMatchObject({
      ready: true,
      source: 'node',
      candidates: [{ path: 'bin/Downloadable Game.exe', sizeBytes: 8 }],
    });
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
    await mkdir(libraryDir, { recursive: true });

    /** A library holding one fully hashed game, so it is mesh-eligible. */
    const seed = (name: string, title: string) => {
      const relPath = `${title}.zip`;
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
          kind: 'archive',
          title,
          sortTitle: title.toLowerCase(),
          searchTitle: title.toLowerCase(),
          sizeBytes: 16,
          fileCount: 1,
        })
        .run();

      const fileId = newId('gfl');
      db.insert(gameFiles)
        .values({
          id: fileId,
          gameId,
          relPath,
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

    // Registering gave it a library of its own, so it starts scoped to that —
    // which is empty, because nothing has reported into it yet.
    const ownLibrary = await app.inject({
      method: 'GET',
      url: '/api/mesh/catalog',
      headers: {
        authorization: `Bearer ${node.nodeToken}`,
        'x-gameblade-node': node.nodeId,
      },
    });
    expect((ownLibrary.json() as { games: unknown[] }).games).toHaveLength(0);

    // Cleared, it is a mirror and syncs against everything on purpose.
    db.update(meshNodes).set({ libraryId: null }).where(eq(meshNodes.id, node.nodeId)).run();

    const everything = await app.inject({
      method: 'GET',
      url: '/api/mesh/catalog',
      headers: {
        authorization: `Bearer ${node.nodeToken}`,
        'x-gameblade-node': node.nodeId,
      },
    });
    expect((everything.json() as { games: unknown[] }).games).toHaveLength(2);

    // Pointed at a library, it is told only what it could possibly be holding.
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
