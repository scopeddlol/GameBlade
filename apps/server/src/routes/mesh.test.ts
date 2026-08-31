import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, MESH_CHUNK_BYTES } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { gameFileChunks, gameFiles, games, libraries, meshNodes, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';

describe('Node HTTPS downloads', () => {
  // Deliberately above Fastify's ordinary 1 MiB body limit. Node chunk uploads
  // use a streaming parser and must never regress to the catalog's old 413.
  const TEST_BYTES = 2 * 1024 * 1024;
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };
  let player: { cookie: string; csrf: string };
  let gameId: string;
  let fileId: string;
  let fileDigest: string;
  let playerId: string;

  const auth = (session: { cookie: string; csrf: string }) => ({
    cookie: session.cookie,
    [CSRF_HEADER]: session.csrf,
  });

  async function register(url: string, payload: Record<string, unknown>) {
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(201);
    const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
    return { cookie, csrf: (response.json() as { csrfToken: string }).csrfToken };
  }

  async function enrol(label: string) {
    const code = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label, role: 'origin' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: {
        enrolmentToken: (code.json() as { token: string }).token,
        publicKey: 'k'.repeat(44),
        endpoints: [{ kind: 'local', address: '192.0.2.10', port: 47820 }],
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { nodeId: string; nodeToken: string };
  }

  const nodeAuth = (node: { nodeId: string; nodeToken: string }) => ({
    authorization: `Bearer ${node.nodeToken}`,
    'x-gameblade-node': node.nodeId,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-node-https-'));
    const libraryDir = path.join(dataDir, 'library');
    await mkdir(path.join(libraryDir, 'Demo'), { recursive: true });
    await writeFile(path.join(libraryDir, 'Demo', 'game.bin'), Buffer.alloc(TEST_BYTES, 7));
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

    admin = await register('/api/auth/setup', {
      username: 'archivist',
      password: 'a-long-enough-password',
    });
    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(admin),
      payload: { role: 'user', maxUses: 1 },
    });
    player = await register('/api/auth/register', {
      username: 'player',
      password: 'a-long-enough-password',
      inviteCode: (invite.json() as { code: string }).code,
    });
    playerId = app.gameblade.db.select().from(users).where(eq(users.username, 'player')).get()!.id;

    const libraryId = newId('lib');
    app.gameblade.db
      .insert(libraries)
      .values({ id: libraryId, name: 'Test', path: libraryDir })
      .run();
    gameId = newId('gam');
    app.gameblade.db
      .insert(games)
      .values({
        id: gameId,
        libraryId,
        relPath: 'Demo',
        kind: 'folder',
        title: 'Demo',
        sortTitle: 'demo',
        searchTitle: 'demo',
        sizeBytes: TEST_BYTES,
        fileCount: 1,
      })
      .run();
    fileId = newId('gfl');
    fileDigest = createHash('sha256').update(Buffer.alloc(TEST_BYTES, 7)).digest('hex');
    app.gameblade.db
      .insert(gameFiles)
      .values({
        id: fileId,
        gameId,
        relPath: 'game.bin',
        sizeBytes: TEST_BYTES,
        modifiedAt: new Date().toISOString(),
        sha256: fileDigest,
        chunkedAt: new Date().toISOString(),
        chunkBytes: MESH_CHUNK_BYTES,
      })
      .run();
    app.gameblade.db
      .insert(gameFileChunks)
      .values({ fileId, chunkIndex: 0, sizeBytes: TEST_BYTES, sha256: fileDigest })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    app.gameblade.db.delete(meshNodes).run();
    app.gameblade.settings.update({ meshEnabled: true });
  });

  it('allows unused enrolment codes to be deleted', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label: 'Unused', role: 'origin' },
    });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/mesh/nodes',
      headers: auth(admin),
    });
    const code = (
      listed.json() as { enrolments: { tokenHash: string; label: string }[] }
    ).enrolments.find((entry) => entry.label === 'Unused')!;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/mesh/enrolments/${code.tokenHash}`,
      headers: auth(admin),
    });
    expect(removed.statusCode).toBe(200);
    expect(app.gameblade.mesh.listEnrolments()).toHaveLength(0);
  });

  it('renames Nodes and never retains their supplied addresses', async () => {
    const node = await enrol('Old name');
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [{ kind: 'local', address: '198.51.100.20', port: 47820 }] },
    });
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/mesh/nodes/${node.nodeId}`,
      headers: auth(admin),
      payload: { label: 'HermesNode' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(app.gameblade.mesh.listNodes()[0]).toMatchObject({
      label: 'HermesNode',
      endpoints: [],
    });
  });

  it('streams a ranged Node chunk through the Coordinator', async () => {
    const node = await enrol('HermesNode');
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    const local = app.gameblade.config.servesLocalFiles;
    app.gameblade.config.servesLocalFiles = false;
    try {
      const download = app.inject({
        method: 'GET',
        url: `/api/download/${gameId}/files/${fileId}`,
        headers: { cookie: player.cookie, range: `bytes=0-${TEST_BYTES - 1}` },
      });
      const poll = await app.inject({
        method: 'GET',
        url: '/api/mesh/transfers/poll',
        headers: nodeAuth(node),
      });
      const [job] = (poll.json() as { jobs: { requestId: string }[] }).jobs;
      expect(job).toBeTruthy();

      const delivered = await app.inject({
        method: 'POST',
        url: `/api/mesh/transfers/${job!.requestId}`,
        headers: { ...nodeAuth(node), 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(TEST_BYTES, 7),
      });
      expect(delivered.statusCode).toBe(200);

      const response = await download;
      expect(response.statusCode).toBe(206);
      expect(response.rawPayload).toEqual(Buffer.alloc(TEST_BYTES, 7));
      expect(decodeURIComponent(String(response.headers['x-gameblade-node']))).toBe('HermesNode');
    } finally {
      app.gameblade.config.servesLocalFiles = local;
    }
  });

  it('only assigns as many jobs as the Node says it can start', async () => {
    const node = await enrol('CapacityNode');
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    const requests = Array.from({ length: 3 }, () =>
      app.gameblade.mesh.fetchNodeChunk({
        userId: playerId,
        gameId,
        fileId,
        chunkIndex: 0,
        expectedBytes: TEST_BYTES,
        sha256: fileDigest,
      }),
    );

    const take = async (limit: number) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/mesh/transfers/poll?limit=${limit}`,
        headers: nodeAuth(node),
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as { jobs: { requestId: string }[] }).jobs;
    };
    const deliver = async (requestId: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/mesh/transfers/${requestId}`,
        headers: { ...nodeAuth(node), 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(TEST_BYTES, 7),
      });
      expect(response.statusCode).toBe(200);
    };

    const first = await take(2);
    expect(first).toHaveLength(2);
    await Promise.all(first.map((job) => deliver(job.requestId)));

    const second = await take(2);
    expect(second).toHaveLength(1);
    await deliver(second[0]!.requestId);
    await expect(Promise.all(requests)).resolves.toHaveLength(3);
  });

  it('keeps Node administration private', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/mesh/nodes' })).statusCode).toBe(401);
  });
});
