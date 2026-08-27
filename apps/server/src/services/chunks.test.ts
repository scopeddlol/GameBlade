import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MESH_CHUNK_BYTES } from '@gameblade/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashFileByChunk } from './chunks.js';

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
