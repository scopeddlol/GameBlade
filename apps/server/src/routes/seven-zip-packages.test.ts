import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSRF_HEADER, MESH_CHUNK_BYTES } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { games } from '../db/schema.js';

/**
 * A game kept as a `.7z`, from the library folder to the bytes on the wire.
 *
 * Each step of that chain used to have its own `.zip` check, and a game in any
 * other format failed a different one depending on how far it got: the store
 * called it "coming soon", the hashing pass skipped it, the manifest refused
 * it, the download route refused it again. The point of an end-to-end test
 * rather than four unit tests is that those four checks now have to agree — a
 * `.7z` the store offers must be one the manifest describes and the download
 * route serves, or a player gets a button that cannot work.
 *
 * The archive is a real one written by 7-Zip. Its *contents* are irrelevant to
 * everything below except the launch-rule listing: a download moves a package's
 * bytes without ever opening it.
 */
describe('a game stored as .7z', () => {
  const cleanups: (() => Promise<void>)[] = [];

  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'lib',
    'fixtures',
    'game.7z',
  );

  const auth = (session: { cookie: string; csrf: string }) => ({
    cookie: session.cookie,
    [CSRF_HEADER]: session.csrf,
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** A standalone server whose library holds one archive game, scanned and hashed. */
  async function serverHolding(packageName: string, expectHashed = 1) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-7z-test-'));
    const libraryDir = path.join(dataDir, 'library');
    await mkdir(libraryDir, { recursive: true });
    await copyFile(fixture, path.join(libraryDir, packageName));

    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
        METADATA_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
    );
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    const admin = await signIn(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/libraries',
      headers: auth(admin),
      payload: { name: 'Library', path: libraryDir },
    });
    expect(created.statusCode).toBe(201);

    await app.gameblade.scanner.scan();
    // The sweep runs on a timer in production; here it is driven directly so
    // the test is about the format rather than about waiting.
    expect(await app.gameblade.chunks.hashUnhashed()).toEqual({
      hashed: expectHashed,
      failed: 0,
    });

    const game = app.gameblade.db.select().from(games).all()[0]!;
    return { app, admin, libraryDir, game };
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

  it('is scanned in as one archive game, hashed and offered as ready', async () => {
    const { app, admin, game } = await serverHolding('Cave Story.7z');

    expect(game).toMatchObject({ kind: 'archive', relPath: 'Cave Story.7z', title: 'Cave Story' });
    expect(app.gameblade.chunks.isGameChunked(game.id)).toBe(true);

    const store = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}`,
      headers: auth(admin),
    });
    expect(store.statusCode).toBe(200);
    expect(store.json()).toMatchObject({ availability: 'ready' });
  });

  it('is described by a manifest the downloader can act on', async () => {
    const { app, admin, game } = await serverHolding('Cave Story.7z');

    const response = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}/manifest`,
      headers: auth(admin),
    });

    expect(response.statusCode).toBe(200);
    const manifest = response.json() as {
      kind: string;
      chunkBytes: number;
      totalBytes: number;
      files: Array<{ path: string; sizeBytes: number; chunks: Array<{ sha256: string }> }>;
    };

    // One package file, on the same 10 MiB grid a .zip uses, with the size the
    // client checks the manifest against before it creates anything on disk.
    expect(manifest.kind).toBe('archive');
    expect(manifest.chunkBytes).toBe(MESH_CHUNK_BYTES);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]!.path).toBe('Cave Story.7z');
    expect(manifest.totalBytes).toBe(manifest.files[0]!.sizeBytes);
    expect(manifest.files[0]!.chunks.length).toBeGreaterThan(0);
  });

  it('serves the package byte for byte over the download route', async () => {
    const { app, admin, libraryDir, game } = await serverHolding('Cave Story.7z');

    const manifest = (
      await app.inject({
        method: 'GET',
        url: `/api/games/${game.id}/manifest`,
        headers: auth(admin),
      })
    ).json() as { token: string };

    const download = await app.inject({
      method: 'GET',
      url: `/api/download/${game.id}?token=${manifest.token}`,
    });

    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(await readFile(path.join(libraryDir, 'Cave Story.7z')));
  });

  it('offers its executables for a launch rule without unpacking it', async () => {
    const { app, admin, game } = await serverHolding('Cave Story.7z');

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/games/${game.id}/executables`,
      headers: auth(admin),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ready: true,
      source: 'local',
      candidates: [
        { path: 'Cave Story/bin/CaveStory.exe' },
        { path: 'Cave Story/Ünïcode Läuncher.exe' },
      ],
    });
  });

  it('is still refused when the format is one nothing in the chain can unpack', async () => {
    // The same archive under a .rar name. It is scanned into the catalog so a
    // conversion does not lose its metadata, but nothing downstream can open
    // it — so it is never hashed, never offered, and the refusal says what to
    // do rather than failing somewhere later in a download.
    const { app, admin, game } = await serverHolding('Cave Story.rar', 0);

    expect(game).toMatchObject({ kind: 'archive', relPath: 'Cave Story.rar' });

    const store = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}`,
      headers: auth(admin),
    });
    expect(store.json()).toMatchObject({
      availability: 'coming-soon',
      availabilityNote: expect.stringContaining('.zip or .7z'),
    });

    const manifest = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}/manifest`,
      headers: auth(admin),
    });
    expect(manifest.statusCode).toBe(409);
    expect(manifest.json()).toMatchObject({
      error: { message: expect.stringContaining('.zip or .7z') },
    });
  });
});
