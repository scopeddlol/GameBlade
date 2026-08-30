import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { games, libraries, meshNodes } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { CatalogReporter } from '../services/catalogReporter.js';

/**
 * A node joining a coordinator, over a real socket.
 *
 * Everything else about the split topology is tested a piece at a time. This is
 * the one path an operator actually walks — bring a node up with nothing
 * configured, type two things into the page it serves, and watch its catalog
 * appear on the coordinator — and every piece of it crosses a process boundary
 * that a unit test would stub out. So the coordinator listens on a real port
 * and the node talks to it over HTTP, because the failures worth catching here
 * are the ones that only exist between the two.
 *
 * The mesh agent is Rust and cannot run in this process. What it contributes is
 * one thing — the keypair, written into the shared state file — so that is
 * written here directly. Its own half of the contract is pinned by tests in the
 * crate, which assert the field names on disk that this reads.
 */
describe('a node joining a coordinator', () => {
  let coordinator: Awaited<ReturnType<typeof buildApp>>;
  let coordinatorUrl: string;
  let coordinatorDir: string;
  let nodeDir: string;
  let admin: { cookie: string; csrf: string };
  let libraryId: string;

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  /**
   * The 32 secret bytes, base64url — exactly what the mesh agent writes.
   *
   * Ed25519 private keys export as PKCS#8 behind a fixed 16-byte prefix, and
   * the agent stores only the tail. The reporter rebuilds the prefix to derive
   * the public half, so anything else here would fail in a way that looks like
   * a rejected enrolment rather than a malformed key.
   */
  function agentIdentity(): { secretKey: string; publicKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return {
      secretKey: Buffer.from(pkcs8.subarray(16)).toString('base64url'),
      publicKey: Buffer.from(spki.subarray(12)).toString('base64url'),
    };
  }

  beforeAll(async () => {
    coordinatorDir = await mkdtemp(path.join(tmpdir(), 'gb-coord-'));
    nodeDir = await mkdtemp(path.join(tmpdir(), 'gb-node-'));

    coordinator = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: coordinatorDir,
        LOG_LEVEL: 'silent',
        ROLE: 'coordinator',
      } as NodeJS.ProcessEnv),
    );
    // A real socket: the node reaches this with fetch, not with inject.
    coordinatorUrl = await coordinator.listen({ port: 0, host: '127.0.0.1' });

    const setup = await coordinator.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'archivist', password: 'a-long-enough-password' },
    });
    const raw = setup.headers['set-cookie'];
    admin = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: (setup.json() as { csrfToken: string }).csrfToken,
    };

    /*
     * A library that already exists on this coordinator, written directly.
     *
     * Not through the API: a coordinator holds no game files and refuses to be
     * given a folder, because it has nothing to read one from. A row like this
     * arrives one of two ways in reality — a standalone server's database
     * copied across, or a node's own enrolment making one — and this stands in
     * for the first, so the assertions below can prove an enrolling node makes
     * its *own* rather than adopting somebody else's.
     */
    libraryId = newId('lib');
    coordinator.gameblade.db
      .insert(libraries)
      .values({
        id: libraryId,
        name: 'Somebody else’s archive',
        path: '/libraries/original',
        enabled: true,
        createdAt: new Date().toISOString(),
        lastScanAt: null,
        lastScanStatus: null,
      })
      .run();
  });

  afterAll(async () => {
    await coordinator.close();
    await rm(coordinatorDir, { recursive: true, force: true });
    await rm(nodeDir, { recursive: true, force: true });
  });

  it('goes from an unconfigured node to a catalog on the coordinator', async () => {
    /* ---------------------------------------------------- the enrolment code */

    const enrolment = await coordinator.inject({
      method: 'POST',
      url: '/api/mesh/enrolments',
      headers: auth(),
      payload: { label: 'Home archive', role: 'origin' },
    });
    expect(enrolment.statusCode).toBe(200);
    const code = (enrolment.json() as { token: string }).token;

    /* ------------------------------------------------------------- the node */

    // The agent's half: its key, in the file both processes share.
    await mkdir(nodeDir, { recursive: true });
    const statePath = path.join(nodeDir, 'node-state.json');
    const identity = agentIdentity();
    await writeFile(statePath, JSON.stringify({ secretKey: identity.secretKey }), 'utf8');

    const node = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: nodeDir,
        LOG_LEVEL: 'silent',
        ROLE: 'node',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
      } as NodeJS.ProcessEnv),
    );
    await node.ready();

    try {
      // Nothing has been said to it yet, so it asks.
      const page = await node.inject({ method: 'GET', url: '/' });
      expect(page.body).toContain('Set this node up');

      // A game on this node's disk, as its own scan would have recorded it.
      const localLibrary = newId('lib');
      node.gameblade.db
        .insert(libraries)
        .values({ id: localLibrary, name: 'Local', path: '/library' })
        .run();
      node.gameblade.db
        .insert(games)
        .values({
          id: newId('gam'),
          libraryId: localLibrary,
          relPath: 'Hollow Knight',
          kind: 'folder',
          title: 'Hollow Knight',
          sortTitle: 'hollow knight',
          searchTitle: 'hollow knight',
          sizeBytes: 4096,
          fileCount: 1,
          contentMtime: new Date().toISOString(),
        })
        .run();

      /* ------------------------------------------------------- the two fields */

      const saved = await node.inject({
        method: 'POST',
        url: '/api/node/setup',
        payload: { coordinatorUrl, enrolmentToken: code },
      });
      expect(saved.statusCode).toBe(202);

      /* ---------------------------------------- what the mesh agent does next */

      // The agent is the sole registrar. Letting the catalog reporter race it
      // rotated the bearer token twice; whichever process wrote last could
      // leave the other permanently presenting a stale credential.
      const registered = await coordinator.inject({
        method: 'POST',
        url: '/api/mesh/register',
        payload: { enrolmentToken: code, publicKey: identity.publicKey, endpoints: [] },
      });
      expect(registered.statusCode).toBe(200);
      const registration = registered.json() as {
        nodeId: string;
        nodeToken: string;
        coordinatorPublicKey: string;
      };
      const configured = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, string>;
      configured.nodeId = registration.nodeId;
      configured.nodeToken = registration.nodeToken;
      configured.coordinatorKey = registration.coordinatorPublicKey;
      configured.coordinatorUrl = coordinatorUrl;
      delete configured.enrolmentToken;
      await writeFile(statePath, JSON.stringify(configured), 'utf8');

      /* ------------------------------------- what the reporter does next, now */

      const reporter = new CatalogReporter(
        node.gameblade.db,
        { coordinatorUrl: null, enrolmentToken: null, statePath },
        node.log,
      );

      // Configured by the form, not by the environment — which is the whole
      // point of it: nothing was passed to this process. It reads the agent's
      // registration rather than issuing a second one.
      expect(await reporter.isConfigured()).toBe(true);
      expect(await reporter.ensureRegistered()).toBe(true);

      // The code is spent, and the address is remembered for next boot.
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, string>;
      expect(state.nodeId).toMatch(/^nod_/);
      expect(state.nodeToken).toBeTruthy();
      expect(state.enrolmentToken).toBeUndefined();
      expect(state.coordinatorUrl).toBe(coordinatorUrl);

      // And the coordinator agrees it exists.
      const listed = await coordinator.inject({
        method: 'GET',
        url: '/api/mesh/nodes',
        headers: auth(),
      });
      const enrolled = (listed.json() as { nodes: { id: string; label: string }[] }).nodes;
      expect(enrolled.map((n) => n.id)).toContain(state.nodeId);

      /* ------------------------------------------------------- the catalog */

      // A library was made for this node when it registered, so there is no
      // step between enrolling and reporting. Nobody had to create one, name a
      // path that does not exist on this machine, and come back to assign it.
      const assigned = coordinator.gameblade.db
        .select()
        .from(meshNodes)
        .where(eq(meshNodes.id, state.nodeId!))
        .get();
      expect(assigned?.libraryId).toBeTruthy();

      const theirs = coordinator.gameblade.db
        .select()
        .from(libraries)
        .where(eq(libraries.id, assigned!.libraryId!))
        .get();
      expect(theirs?.name).toBe('Home archive');

      expect(await reporter.report()).toBe(true);

      const onCoordinator = coordinator.gameblade.db
        .select()
        .from(games)
        .where(eq(games.libraryId, assigned!.libraryId!))
        .all();
      expect(onCoordinator.map((g) => g.relPath)).toEqual(['Hollow Knight']);

      // And the library that was already there is untouched: an automatic one
      // is a new library, never somebody else's.
      expect(
        coordinator.gameblade.db.select().from(games).where(eq(games.libraryId, libraryId)).all(),
      ).toHaveLength(0);

      // The page has stopped asking and started reporting.
      const after = await node.inject({ method: 'GET', url: '/' });
      expect(after.body).not.toContain('Set this node up');
      expect(after.body).toContain('enrolled');
      /* ------------------------------- one bad row must not poison the rest */

      // An empty directory in a library scans as a game with no files, whose
      // fingerprint is the newest of no modification times: the empty string.
      // A report is all or nothing, so sent as-is the coordinator refused the
      // whole thing — and a node then enrolled, heartbeated and reported every
      // five minutes while none of its catalog ever arrived.
      node.gameblade.db
        .insert(games)
        .values({
          id: newId('gam'),
          libraryId: localLibrary,
          relPath: 'An Empty Folder',
          kind: 'folder',
          title: 'An Empty Folder',
          sortTitle: 'an empty folder',
          searchTitle: 'an empty folder',
          sizeBytes: 0,
          fileCount: 0,
          contentMtime: '',
        })
        .run();

      expect(await reporter.report()).toBe(true);

      const withTheEmptyOne = coordinator.gameblade.db
        .select()
        .from(games)
        .where(eq(games.libraryId, assigned!.libraryId!))
        .all();
      expect(withTheEmptyOne.map((g) => g.relPath).sort()).toEqual([
        'An Empty Folder',
        'Hollow Knight',
      ]);
    } finally {
      await node.close();
    }
  }, 30_000);
});
