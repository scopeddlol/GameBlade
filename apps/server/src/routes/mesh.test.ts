import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, MESH_CHUNK_BYTES } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { gameFileChunks, gameFiles, games, libraries, meshNodes } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * The coordinator.
 *
 * The properties worth pinning are the ones that decide whether enrolling a
 * node is a security decision or an operational one: a node must be able to
 * check a client's authority without being able to mint any, a node's claim to
 * hold a game must be checked against what the origin actually has, and a
 * quota must still mean something once bytes stop passing through this server.
 */
describe('mesh coordinator', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let libraryDir: string;
  let admin: { cookie: string; csrf: string; id: string };
  let player: { cookie: string; csrf: string; id: string };
  let gameId: string;
  let fileId: string;

  const auth = (s: { cookie: string; csrf: string }) => ({
    cookie: s.cookie,
    [CSRF_HEADER]: s.csrf,
  });

  async function register(url: string, payload: Record<string, unknown>) {
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { csrfToken: string; user: { id: string } };
    const raw = response.headers['set-cookie'];
    return {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
      id: body.user.id,
    };
  }

  /** An enrolled node, with the credential it was handed once. */
  async function enrol(label: string, publicKey: string) {
    const enrolment = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label, role: 'mirror' },
    });
    expect(enrolment.statusCode).toBe(200);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: {
        enrolmentToken: (enrolment.json() as { token: string }).token,
        publicKey,
        endpoints: [{ kind: 'local', address: '192.168.1.20', port: 47820 }],
      },
    });
    expect(registered.statusCode).toBe(200);
    return registered.json() as {
      nodeId: string;
      nodeToken: string;
      coordinatorPublicKey: string;
    };
  }

  const nodeAuth = (node: { nodeId: string; nodeToken: string }) => ({
    authorization: `Bearer ${node.nodeToken}`,
    'x-gameblade-node': node.nodeId,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-mesh-test-'));
    libraryDir = path.join(dataDir, 'library');
    await mkdir(path.join(libraryDir, 'Demo Game'), { recursive: true });
    await writeFile(path.join(libraryDir, 'Demo Game', 'game.bin'), Buffer.alloc(1024, 7));

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
        relPath: 'Demo Game',
        kind: 'folder',
        title: 'Demo Game',
        sortTitle: 'demo game',
        searchTitle: 'demo game',
        sizeBytes: 1024,
        fileCount: 1,
      })
      .run();

    fileId = newId('gfl');
    app.gameblade.db
      .insert(gameFiles)
      .values({
        id: fileId,
        gameId,
        relPath: 'game.bin',
        sizeBytes: 1024,
        modifiedAt: new Date().toISOString(),
        sha256: 'a'.repeat(64),
        chunkedAt: new Date().toISOString(),
        chunkBytes: MESH_CHUNK_BYTES,
      })
      .run();

    app.gameblade.db
      .insert(gameFileChunks)
      .values({ fileId, chunkIndex: 0, sizeBytes: 1024, sha256: 'b'.repeat(64) })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    app.gameblade.db.delete(meshNodes).run();
    app.gameblade.settings.update({ meshEnabled: true, meshSeedingEnabled: false });
  });

  /* ------------------------------------------------------------- enrolment */

  it('turns an enrolment code into a node', async () => {
    const node = await enrol('Home archive', 'k'.repeat(44));

    expect(node.nodeId).toMatch(/^nod_/);
    expect(node.nodeToken.length).toBeGreaterThan(20);
    expect(node.coordinatorPublicKey.length).toBeGreaterThan(20);
  });

  it('will not spend the same enrolment code twice', async () => {
    // A code that stayed useful after enrolment would mean a leaked one is a
    // standing invitation. Re-registering is what the node's own key is for.
    const enrolment = await app.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(admin),
      payload: { label: 'Mirror', role: 'mirror' },
    });
    const token = (enrolment.json() as { token: string }).token;

    const first = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: { enrolmentToken: token, publicKey: 'x'.repeat(44), endpoints: [] },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: { enrolmentToken: token, publicKey: 'y'.repeat(44), endpoints: [] },
    });
    expect(second.statusCode).toBe(403);
  });

  it('treats a known key as the same node coming back, not a conflict', async () => {
    // An agent that lost its local state still holds its key. Refusing it would
    // strand a working mirror behind a code its operator no longer has.
    const first = await enrol('Home archive', 'z'.repeat(44));

    const again = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: { enrolmentToken: 'not-a-real-code', publicKey: 'z'.repeat(44), endpoints: [] },
    });

    expect(again.statusCode).toBe(200);
    expect((again.json() as { nodeId: string }).nodeId).toBe(first.nodeId);
  });

  it('rotates the credential when a node re-registers', async () => {
    const first = await enrol('Home archive', 'q'.repeat(44));

    const again = await app.inject({
      method: 'POST',
      url: '/api/mesh/register',
      payload: { enrolmentToken: 'unused-placeholder', publicKey: 'q'.repeat(44), endpoints: [] },
    });
    const rotated = again.json() as { nodeToken: string };

    expect(rotated.nodeToken).not.toBe(first.nodeToken);

    // The old one stops working, which is the point of rotating it.
    const stale = await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(first),
      payload: { endpoints: [] },
    });
    expect(stale.statusCode).toBe(401);
  });

  it('refuses a node credential derived from the public key', async () => {
    // The public key is handed to every client that resolves this game, so
    // anything computable from it cannot be a credential.
    const node = await enrol('Home archive', 'p'.repeat(44));

    const forged = await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: { authorization: `Bearer ${'p'.repeat(44)}`, 'x-gameblade-node': node.nodeId },
      payload: { endpoints: [] },
    });

    expect(forged.statusCode).toBe(401);
  });

  it('refuses an unauthenticated heartbeat', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      payload: { endpoints: [] },
    });
    expect(response.statusCode).toBe(401);
  });

  /* ------------------------------------------------------------ heartbeats */

  it('replaces endpoints rather than accumulating them', async () => {
    // A stale candidate is not harmless: it is a connection attempt a client
    // has to time out before trying one that works.
    const node = await enrol('Home archive', 'e'.repeat(44));

    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [{ kind: 'local', address: '10.0.0.5', port: 47820 }] },
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/mesh/nodes',
      headers: auth(admin),
    });
    const nodes = (listed.json() as { nodes: { endpoints: { address: string }[] }[] }).nodes;
    const addresses = nodes[0]?.endpoints.map((e) => e.address) ?? [];

    expect(addresses).toContain('10.0.0.5');
    expect(addresses).not.toContain('192.168.1.20');
  });

  it('marks a node stale once it stops heartbeating', async () => {
    const node = await enrol('Home archive', 'h'.repeat(44));

    // Reach past the timeout without waiting it out.
    app.gameblade.db
      .update(meshNodes)
      .set({ lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() })
      .run();

    expect(app.gameblade.mesh.pruneStale()).toBe(1);
    expect(app.gameblade.mesh.listNodes()[0]?.status).toBe('stale');

    // Stale, not deleted: a home connection drops and comes back, and its
    // content index should survive that.
    expect(app.gameblade.mesh.listNodes()).toHaveLength(1);
    expect(node.nodeId).toBe(app.gameblade.mesh.listNodes()[0]?.id);
  });

  /* --------------------------------------------------------------- content */

  it('accepts an announcement whose fingerprint matches the origin', async () => {
    const node = await enrol('Home archive', 'c'.repeat(44));
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);

    const beat = await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    expect((beat.json() as { knownGames: number }).knownGames).toBe(1);
  });

  it('drops an announcement whose fingerprint does not match', async () => {
    // A mirror mid-sync legitimately holds a mixture, so one stale entry drops
    // rather than failing the whole heartbeat and taking a working node offline.
    const node = await enrol('Home archive', 'd'.repeat(44));

    const beat = await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash: 'f'.repeat(64) }] },
    });

    expect(beat.statusCode).toBe(200);
    expect((beat.json() as { knownGames: number }).knownGames).toBe(0);
  });

  it('stops offering a mirror once the origin copy changes', async () => {
    const node = await enrol('Home archive', 'g'.repeat(44));
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);

    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });
    expect(app.gameblade.mesh.nodesForGame(gameId)).toHaveLength(1);

    // The origin rescans and the file is different now. The mirror is still
    // announcing the old fingerprint, so it is announcing something that no
    // longer exists.
    app.gameblade.db
      .update(gameFiles)
      .set({ sha256: 'c'.repeat(64) })
      .run();

    expect(app.gameblade.mesh.nodesForGame(gameId)).toHaveLength(0);

    app.gameblade.db
      .update(gameFiles)
      .set({ sha256: 'a'.repeat(64) })
      .run();
  });

  /* ---------------------------------------------------------------- grants */

  it('hands a client nodes and a grant for each', async () => {
    const node = await enrol('Home archive', 'r'.repeat(44));
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/mesh/resolve/${gameId}`,
      headers: auth(player),
    });

    const body = resolved.json() as {
      nodes: { id: string; publicKey: string }[];
      grants: { nodeId: string; grant: string }[];
    };

    expect(body.nodes).toHaveLength(1);
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]?.nodeId).toBe(node.nodeId);

    // The grant a client carries has to be one the node can check.
    expect(app.gameblade.downloadTokens.verifyGrant(body.grants[0]!.grant)).toMatchObject({
      userId: player.id,
      gameId,
      nodeId: node.nodeId,
    });
  });

  it('offers no nodes while the mesh is switched off', async () => {
    const node = await enrol('Home archive', 's'.repeat(44));
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    app.gameblade.settings.update({ meshEnabled: false });

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/mesh/resolve/${gameId}`,
      headers: auth(player),
    });

    // Not an error — "use the origin" is a perfectly good answer.
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as { nodes: unknown[] }).nodes).toHaveLength(0);
  });

  /* -------------------------------------------------------------- metering */

  it('counts node-served bytes against the account quota', async () => {
    // Without this the quota would only see traffic the mesh exists to avoid:
    // an account could spend its whole allowance and the counter would barely
    // move.
    const node = await enrol('Home archive', 'm'.repeat(44));
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/mesh/resolve/${gameId}`,
      headers: auth(player),
    });
    const grant = (resolved.json() as { grants: { grant: string }[] }).grants[0]!.grant;
    const nonce = app.gameblade.downloadTokens.verifyGrant(grant).nonce;

    const before = app.gameblade.bandwidth.usedThisPeriod(player.id);

    const reported = await app.inject({
      method: 'POST',
      url: '/api/mesh/report',
      headers: nodeAuth(node),
      payload: { nonce, bytesServed: 4_096 },
    });
    expect(reported.statusCode).toBe(200);

    expect(app.gameblade.bandwidth.usedThisPeriod(player.id)).toBe(before + 4_096);
  });

  it('will not let a replayed report charge an account twice', async () => {
    const node = await enrol('Home archive', 'n'.repeat(44));
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/mesh/resolve/${gameId}`,
      headers: auth(player),
    });
    const grant = (resolved.json() as { grants: { grant: string }[] }).grants[0]!.grant;
    const nonce = app.gameblade.downloadTokens.verifyGrant(grant).nonce;

    const before = app.gameblade.bandwidth.usedThisPeriod(player.id);

    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/mesh/report',
        headers: nodeAuth(node),
        payload: { nonce, bytesServed: 1_000 },
      });
    }

    // The report is a running total, not an increment.
    expect(app.gameblade.bandwidth.usedThisPeriod(player.id)).toBe(before + 1_000);
  });

  it('refuses a report against another node’s transfer', async () => {
    const server = await enrol('Home archive', 'u'.repeat(44));
    const other = await enrol('Someone else', 'v'.repeat(44));
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(server),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/mesh/resolve/${gameId}`,
      headers: auth(player),
    });
    const grant = (resolved.json() as { grants: { grant: string }[] }).grants[0]!.grant;
    const nonce = app.gameblade.downloadTokens.verifyGrant(grant).nonce;

    const stolen = await app.inject({
      method: 'POST',
      url: '/api/mesh/report',
      headers: nodeAuth(other),
      payload: { nonce, bytesServed: 99_999 },
    });

    expect(stolen.statusCode).toBe(403);
  });

  /* ------------------------------------------------------------------ peers */

  it('refuses peer registration while seeding is off', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mesh/peer',
      headers: auth(player),
      payload: { publicKey: 'w'.repeat(44), label: "player's PC", endpoints: [] },
    });

    expect(response.statusCode).toBe(403);
  });

  it('never offers somebody their own machine as a source', async () => {
    // It is the copy they are trying to obtain.
    app.gameblade.settings.update({ meshSeedingEnabled: true });

    const peer = await app.inject({
      method: 'POST',
      url: '/api/mesh/peer',
      headers: auth(player),
      payload: { publicKey: 'o'.repeat(44), label: "player's PC", endpoints: [] },
    });
    const registered = peer.json() as { nodeId: string; nodeToken: string };

    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(registered),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    expect(app.gameblade.mesh.nodesForGame(gameId)).toHaveLength(1);
    expect(app.gameblade.mesh.nodesForGame(gameId, { excludeOwnerId: player.id })).toHaveLength(0);
  });

  /* ------------------------------------------------------------------ admin */

  it('keeps the node list to administrators', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/mesh/nodes',
      headers: auth(player),
    });
    expect(response.statusCode).toBe(403);
  });

  it('stops offering a blocked node', async () => {
    const node = await enrol('Home archive', 'j'.repeat(44));
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [], games: [{ gameId, contentHash }] },
    });

    await app.inject({
      method: 'POST',
      url: `/api/mesh/nodes/${node.nodeId}/status`,
      headers: auth(admin),
      payload: { status: 'blocked' },
    });

    expect(app.gameblade.mesh.nodesForGame(gameId)).toHaveLength(0);

    const beat = await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: { endpoints: [] },
    });
    expect(beat.statusCode).toBe(403);
  });
});
