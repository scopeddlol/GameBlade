import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, MESH_CHUNK_BYTES, type DownloadManifest } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import {
  downloadEvents,
  gameFileChunks,
  gameFiles,
  games,
  libraries,
  meshNodes,
  users,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * A Node that can be reached on its own address should be handed the download.
 *
 * The relay through the Coordinator is what makes a machine behind a home
 * router usable at all, and it costs that machine's uplink twice for every
 * byte — which on a small VPS is the ceiling on everybody's downloads. A Node
 * with a routable address does not need it.
 *
 * What is asserted here is the contract that makes that safe to offer: the
 * client is given an address *and* a signed, expiring permission naming one
 * node and one file; the Node can check that permission with a key it already
 * has and could never mint one; and the Coordinator's own route is still there,
 * unchanged, for every client and every moment the direct path does not work.
 */
describe('direct Node downloads', () => {
  const BYTES = 512 * 1024;
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };
  let player: { cookie: string; csrf: string };
  let playerId: string;
  let gameId: string;
  let fileId: string;

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

  async function enrol(label: string, publicKey: string) {
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
        publicKey,
        endpoints: [],
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      nodeId: string;
      nodeToken: string;
      coordinatorPublicKey?: string;
    };
  }

  const nodeAuth = (node: { nodeId: string; nodeToken: string }) => ({
    authorization: `Bearer ${node.nodeToken}`,
    'x-gameblade-node': node.nodeId,
  });

  /** Say this node is online, holding the game, at this address. */
  async function heartbeat(
    node: { nodeId: string; nodeToken: string },
    publicUrl: string | undefined,
  ) {
    const contentHash = app.gameblade.mesh.contentHashFor(gameId);
    const response = await app.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      headers: nodeAuth(node),
      payload: {
        endpoints: [],
        games: [{ gameId, contentHash }],
        ...(publicUrl === undefined ? {} : { publicUrl }),
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { coordinatorPublicKey?: string };
  }

  async function manifest(): Promise<DownloadManifest> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/games/${gameId}/manifest`,
      headers: auth(player),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as DownloadManifest;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-direct-'));
    const libraryDir = path.join(dataDir, 'library');
    await mkdir(libraryDir, { recursive: true });
    await writeFile(path.join(libraryDir, 'Demo.zip'), Buffer.alloc(BYTES, 5));

    app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
        // A coordinator: it holds no files, which is exactly the deployment
        // where the relay hop is the expensive one.
        ROLE: 'coordinator',
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
        relPath: 'Demo.zip',
        kind: 'archive',
        title: 'Demo',
        sortTitle: 'demo',
        searchTitle: 'demo',
        sizeBytes: BYTES,
        fileCount: 1,
      })
      .run();

    fileId = newId('gfl');
    const digest = createHash('sha256').update(Buffer.alloc(BYTES, 5)).digest('hex');
    app.gameblade.db
      .insert(gameFiles)
      .values({
        id: fileId,
        gameId,
        relPath: 'Demo.zip',
        sizeBytes: BYTES,
        modifiedAt: new Date().toISOString(),
        sha256: digest,
        chunkedAt: new Date().toISOString(),
        chunkBytes: MESH_CHUNK_BYTES,
      })
      .run();
    app.gameblade.db
      .insert(gameFileChunks)
      .values({ fileId, chunkIndex: 0, sizeBytes: BYTES, sha256: digest })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('gives a node the key it needs to check grants, and nothing more', async () => {
    const node = await enrol('VPS', `${'k'.repeat(43)}1`);
    // The public half. A node can verify what this Coordinator signed and can
    // never sign anything itself, which is what makes handing it out safe.
    expect(node.coordinatorPublicKey).toBe(app.gameblade.downloadTokens.publicKeyBase64());

    const beat = await heartbeat(node, 'https://vps.example.com:8099');
    // Repeated on every heartbeat so a rotated key does not mean restarting
    // every node in the fleet.
    expect(beat.coordinatorPublicKey).toBe(node.coordinatorPublicKey);
  });

  it('offers the node address with a grant scoped to one file', async () => {
    const node = await enrol('VPS 2', `${'k'.repeat(43)}2`);
    await heartbeat(node, 'https://vps.example.com:8099');

    const body = await manifest();
    const source = body.sources?.find((entry) => entry.nodeId === node.nodeId);
    expect(source?.directUrl).toBe('https://vps.example.com:8099/gb/v1/chunk');
    expect(source?.gameId).toBe(gameId);
    expect(source?.fileId).toBe(fileId);

    const claims = app.gameblade.downloadTokens.verifyDeliveryGrant(source!.grant!);
    expect(claims).toMatchObject({
      v: 1,
      nodeId: node.nodeId,
      gameId,
      fileId,
      userId: playerId,
    });
    // Minutes, not the six hours a download token lives for: a grant is handed
    // to a machine the Coordinator does not control.
    expect(claims.expiresAt * 1000).toBeLessThan(Date.now() + 61 * 60_000);
  });

  it('offers no address for a node that has none, and still offers the node', async () => {
    const node = await enrol('Home server', `${'k'.repeat(43)}3`);
    await heartbeat(node, undefined);

    const source = (await manifest()).sources?.find((entry) => entry.nodeId === node.nodeId);
    // The ordinary case for a machine behind a router: a perfectly good source,
    // reached the way it always was.
    expect(source).toBeDefined();
    expect(source?.directUrl).toBeUndefined();
    expect(source?.grant).toBeUndefined();
  });

  it('stops offering an address a node has retracted', async () => {
    const node = await enrol('Moving house', `${'k'.repeat(43)}4`);
    await heartbeat(node, 'https://old.example.com:8099');
    expect(
      (await manifest()).sources?.find((entry) => entry.nodeId === node.nodeId)?.directUrl,
    ).toBe('https://old.example.com:8099/gb/v1/chunk');

    // An empty string is how an agent says the forward has gone. Leaving the
    // old one would be an address every client waits out before falling back.
    await heartbeat(node, '');
    expect(
      (await manifest()).sources?.find((entry) => entry.nodeId === node.nodeId)?.directUrl,
    ).toBeUndefined();
    expect(
      app.gameblade.db.select().from(meshNodes).where(eq(meshNodes.id, node.nodeId)).get()
        ?.publicUrl,
    ).toBeNull();
  });

  it('counts what a node delivered directly against the account and the node', async () => {
    const node = await enrol('Counted', `${'k'.repeat(43)}5`);
    await heartbeat(node, 'https://vps.example.com:8099');

    const reported = await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/sources/report`,
      headers: auth(player),
      payload: {
        results: [
          {
            nodeId: node.nodeId,
            transport: 'direct',
            latencyMs: 12,
            bytesPerSecond: 40e6,
            ok: true,
          },
          { nodeId: null, transport: 'proxy', latencyMs: 90, bytesPerSecond: 6e6, ok: true },
        ],
        delivered: [{ nodeId: node.nodeId, bytes: BYTES }],
      },
    });
    expect(reported.statusCode).toBe(200);

    const row = app.gameblade.db
      .select()
      .from(meshNodes)
      .where(eq(meshNodes.id, node.nodeId))
      .get();
    expect(row?.directBytesServed).toBe(BYTES);
    expect(row?.directOkAt).not.toBeNull();

    // Counted against the allowance too. A transfer that skipped the
    // Coordinator is still a transfer somebody is paying for.
    const events = app.gameblade.db
      .select()
      .from(downloadEvents)
      .where(eq(downloadEvents.userId, playerId))
      .all();
    expect(events.some((event) => event.bytesSent === BYTES)).toBe(true);
    expect(app.gameblade.bandwidth.usedThisPeriod(playerId)).toBeGreaterThanOrEqual(BYTES);
  });

  it('puts the source the client measured as fastest first', async () => {
    const slow = await enrol('Slow', `${'k'.repeat(43)}6`);
    const fast = await enrol('Fast', `${'k'.repeat(43)}7`);
    await heartbeat(slow, 'https://slow.example.com:8099');
    await heartbeat(fast, 'https://fast.example.com:8099');

    await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/sources/report`,
      headers: auth(player),
      payload: {
        results: [
          {
            nodeId: slow.nodeId,
            transport: 'direct',
            latencyMs: 200,
            bytesPerSecond: 2e6,
            ok: true,
          },
          {
            nodeId: fast.nodeId,
            transport: 'direct',
            latencyMs: 20,
            bytesPerSecond: 90e6,
            ok: true,
          },
        ],
      },
    });

    const sources = (await manifest()).sources?.filter((entry) => entry.kind === 'node') ?? [];
    expect(sources[0]?.nodeId).toBe(fast.nodeId);
    expect(sources[0]?.observedBytesPerSecond).toBe(90e6);
  });

  it('always leaves the Coordinator route as the way back', async () => {
    const node = await enrol('Relay', `${'k'.repeat(43)}8`);
    await heartbeat(node, 'https://vps.example.com:8099');

    const body = await manifest();
    // Direct delivery is an optimisation and never a requirement. Whatever
    // addresses are offered, the manifest still says the Coordinator's own
    // route is there — which is what the client falls back to the moment a
    // direct fetch fails, and the only path an older client knows at all.
    expect(body.originAvailable).toBe(true);
    expect(body.sources?.some((source) => source.kind === 'node')).toBe(true);

    // And the relay is dispatchable for exactly the copy the manifest
    // described, in the ids the holding node knows it by.
    const plan = app.gameblade.mesh.deliveryPlan(gameId);
    expect(plan?.fileId).toBe(body.files[0]?.id);
    expect(plan?.holders.every((holder) => holder.gameId === gameId)).toBe(true);
  });
});
