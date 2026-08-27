import { describe, expect, it } from 'vitest';
import { MESH_CHUNK_BYTES, chunkCountFor, chunkRange } from './mesh.js';

/**
 * The chunk grid is the one thing the server, the node and the client all have
 * to agree on byte for byte. If any of them disagrees about where chunk 3
 * starts, a download stitched from two sources is silently corrupt in a way no
 * whole-file hash catches until the very end of a multi-gigabyte transfer.
 */
describe('chunk grid', () => {
  it('counts a file that divides evenly', () => {
    expect(chunkCountFor(MESH_CHUNK_BYTES * 4)).toBe(4);
  });

  it('counts the short final chunk', () => {
    expect(chunkCountFor(MESH_CHUNK_BYTES * 4 + 1)).toBe(5);
  });

  it('gives an empty file no chunks at all', () => {
    // Zero chunks rather than one empty chunk: there is nothing to hash, and a
    // node advertising "I have chunk 0 of this" for no bytes is a claim that
    // cannot be verified.
    expect(chunkCountFor(0)).toBe(0);
  });

  it('covers a file exactly, with no gap and no overlap', () => {
    const size = MESH_CHUNK_BYTES * 3 + 1234;
    let covered = 0;
    let expectedStart = 0;

    for (let index = 0; index < chunkCountFor(size); index += 1) {
      const range = chunkRange(index, size);
      expect(range.start).toBe(expectedStart);
      expect(range.end).toBe(range.start + range.length - 1);
      covered += range.length;
      expectedStart = range.end + 1;
    }

    expect(covered).toBe(size);
    expect(expectedStart).toBe(size);
  });

  it('makes only the last chunk short', () => {
    const size = MESH_CHUNK_BYTES * 2 + 10;
    expect(chunkRange(0, size).length).toBe(MESH_CHUNK_BYTES);
    expect(chunkRange(1, size).length).toBe(MESH_CHUNK_BYTES);
    expect(chunkRange(2, size).length).toBe(10);
  });

  it('reports a zero-length range past the end rather than a negative one', () => {
    // A client asking for a chunk index a shorter file no longer has must get
    // something harmless, not a range that reads backwards.
    expect(chunkRange(9, 100)).toEqual({
      start: MESH_CHUNK_BYTES * 9,
      end: -1 + MESH_CHUNK_BYTES * 9,
      length: 0,
    });
  });
});
