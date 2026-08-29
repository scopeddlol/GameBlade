import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MESH_CHUNK_BYTES } from '@gameblade/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../db/index.js';
import { gameFiles, games, libraries } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { ChunkService, hashFileByChunk } from './chunks.js';

/**
 * These hashes are a wire format. A node, the server and the client each
 * compute or check them independently, so "whatever this implementation
 * produces" is not good enough — the values have to be the SHA-256 of exactly
 * the bytes at exactly those offsets, and nothing about the read buffering may
 * show through.
 */
describe('hashFileByChunk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gameblade-chunks-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, bytes: Buffer): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, bytes);
    return file;
  }

  function sha(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  it('hashes a file smaller than one chunk as a single short chunk', async () => {
    const bytes = randomBytes(1024);
    const digest = await hashFileByChunk(await write('small.bin', bytes));

    expect(digest.whole).toBe(sha(bytes));
    expect(digest.chunks).toEqual([{ index: 0, sha256: sha(bytes), sizeBytes: 1024 }]);
  });

  it('gives an empty file no chunks', async () => {
    const digest = await hashFileByChunk(await write('empty.bin', Buffer.alloc(0)));

    expect(digest.chunks).toEqual([]);
    expect(digest.whole).toBe(sha(Buffer.alloc(0)));
  });

  it('cuts on the grid regardless of how the reads arrive', async () => {
    // Deliberately not a multiple of the 1 MiB read buffer, so the stream hands
    // over buffers that straddle a chunk boundary. That straddle is the whole
    // reason the split is done by hand rather than per read.
    const size = MESH_CHUNK_BYTES * 2 + 4096;
    const bytes = randomBytes(size);
    const digest = await hashFileByChunk(await write('big.bin', bytes));

    expect(digest.chunks).toHaveLength(3);
    expect(digest.chunks[0]).toEqual({
      index: 0,
      sha256: sha(bytes.subarray(0, MESH_CHUNK_BYTES)),
      sizeBytes: MESH_CHUNK_BYTES,
    });
    expect(digest.chunks[1]).toEqual({
      index: 1,
      sha256: sha(bytes.subarray(MESH_CHUNK_BYTES, MESH_CHUNK_BYTES * 2)),
      sizeBytes: MESH_CHUNK_BYTES,
    });
    expect(digest.chunks[2]).toEqual({
      index: 2,
      sha256: sha(bytes.subarray(MESH_CHUNK_BYTES * 2)),
      sizeBytes: 4096,
    });
  });

  it('produces the same whole-file hash as a plain one-pass digest', async () => {
    // The single pass computes both; if the chunk splitting ever consumed
    // bytes the whole-file hash did not see, this is what catches it.
    const bytes = randomBytes(MESH_CHUNK_BYTES + 777);
    const digest = await hashFileByChunk(await write('both.bin', bytes));

    expect(digest.whole).toBe(sha(bytes));
  });

  it('covers every byte exactly once', async () => {
    const size = MESH_CHUNK_BYTES * 2 + 123;
    const digest = await hashFileByChunk(await write('cover.bin', randomBytes(size)));

    const total = digest.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
    expect(total).toBe(size);
    expect(digest.chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
  });

  it('rejects rather than resolving when the file cannot be read', async () => {
    await expect(hashFileByChunk(path.join(dir, 'missing.bin'))).rejects.toThrow();
  });
});

/**
 * The sweep a node runs on itself.
 *
 * A node has no API, so nothing can ask it to hash anything: either it does
 * this by itself or its library is never offered to a single client. The
 * failure is silent at every step — the games are there, the scan succeeded,
 * the node is online and reporting — so the properties are pinned here rather
 * than left to be noticed in production.
 */
describe('ChunkService.hashUnhashed', () => {
  let dir: string;
  let handle: DbHandle;
  let service: ChunkService;
  let libraryDir: string;

  const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gameblade-sweep-test-'));
    libraryDir = path.join(dir, 'library');
    handle = createDb(path.join(dir, 'test.db'));
    service = new ChunkService(handle.db, silent);
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** One folder game of one file, on disk and in the database, unhashed. */
  async function seed(name: string, bytes: Buffer, options: { missing?: boolean } = {}) {
    const libraryId = newId('lib');
    const existing = handle.db.select().from(libraries).all();
    if (existing.length === 0) {
      handle.db
        .insert(libraries)
        .values({ id: libraryId, name: 'Library', path: libraryDir })
        .run();
    }
    const library = handle.db.select().from(libraries).all()[0]!;

    await mkdir(path.join(libraryDir, name), { recursive: true });
    await writeFile(path.join(libraryDir, name, 'game.bin'), bytes);

    const gameId = newId('gam');
    handle.db
      .insert(games)
      .values({
        id: gameId,
        libraryId: library.id,
        relPath: name,
        kind: 'folder',
        title: name,
        sortTitle: name.toLowerCase(),
        searchTitle: name.toLowerCase(),
        sizeBytes: bytes.length,
        fileCount: 1,
        missingAt: options.missing ? new Date().toISOString() : null,
      })
      .run();

    handle.db
      .insert(gameFiles)
      .values({
        id: newId('gfl'),
        gameId,
        relPath: 'game.bin',
        sizeBytes: bytes.length,
        modifiedAt: new Date().toISOString(),
      })
      .run();

    return gameId;
  }

  it('hashes everything that was not hashed, so a node can serve it', async () => {
    const first = await seed('One', randomBytes(4096));
    const second = await seed('Two', randomBytes(4096));

    expect(service.isGameChunked(first)).toBe(false);

    const result = await service.hashUnhashed();

    expect(result).toEqual({ hashed: 2, failed: 0 });
    expect(service.isGameChunked(first)).toBe(true);
    expect(service.isGameChunked(second)).toBe(true);
  });

  it('does nothing the second time, so it can run on a timer', async () => {
    // The sweep runs every ten minutes for the life of the node. If it did not
    // narrow to what is actually pending it would re-read every byte of the
    // whole archive, for ever.
    await seed('One', randomBytes(4096));
    await service.hashUnhashed();

    expect(service.unhashedGameIds()).toEqual([]);
    expect(await service.hashUnhashed()).toEqual({ hashed: 0, failed: 0 });
  });

  it('leaves a game that is no longer on disk alone', async () => {
    // Flagged missing means the files went away. Hashing it would fail once per
    // sweep for ever, and the failure count is meant to mean something.
    await seed('Gone', randomBytes(1024), { missing: true });

    expect(service.unhashedGameIds()).toEqual([]);
    expect(await service.hashUnhashed()).toEqual({ hashed: 0, failed: 0 });
  });

  it('stops between games when asked, so a scan is not fighting it for the disk', async () => {
    await seed('One', randomBytes(4096));
    await seed('Two', randomBytes(4096));

    let seen = 0;
    const result = await service.hashUnhashed(() => seen++ > 0);

    expect(result.hashed).toBe(1);
    expect(service.unhashedGameIds()).toHaveLength(1);
  });
});
