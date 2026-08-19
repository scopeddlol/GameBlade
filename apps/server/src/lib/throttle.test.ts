import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { createThrottle } from './throttle.js';

/** Drains a stream, returning how long it took and how many bytes arrived. */
async function drain(source: Readable): Promise<{ ms: number; bytes: number }> {
  const started = Date.now();
  let bytes = 0;
  await pipeline(source, async function (chunks) {
    for await (const chunk of chunks) bytes += (chunk as Buffer).length;
  });
  return { ms: Date.now() - started, bytes };
}

describe('createThrottle', () => {
  it('passes every byte through unchanged', async () => {
    const payload = Buffer.alloc(64 * 1024, 7);
    const throttle = createThrottle(1024 * 1024);

    const chunks: Buffer[] = [];
    await pipeline(Readable.from([payload]), throttle, async function (stream) {
      for await (const chunk of stream) chunks.push(chunk as Buffer);
    });

    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it('does not delay a stream that stays inside its budget', async () => {
    // 32 KB against a 1 MB/s limit should never wait.
    const source = Readable.from([Buffer.alloc(32 * 1024)]);
    const { ms, bytes } = await drain(source.pipe(createThrottle(1024 * 1024)));

    expect(bytes).toBe(32 * 1024);
    expect(ms).toBeLessThan(300);
  });

  it('slows a stream that exceeds its budget', async () => {
    // 40 KB at 20 KB/s is two seconds' worth, so it must take at least one
    // full window — the point of the limit is that this cannot arrive at once.
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(4 * 1024));
    const source = Readable.from(chunks);

    const { ms, bytes } = await drain(source.pipe(createThrottle(20 * 1024)));

    expect(bytes).toBe(40 * 1024);
    expect(ms).toBeGreaterThan(700);
  });

  it('refuses to throttle below a floor, so a limit is never a stall', async () => {
    // A limit of 1 byte/second would take hours for a single chunk; the floor
    // turns it into something slow rather than something hung.
    const source = Readable.from([Buffer.alloc(1024)]);
    const { ms, bytes } = await drain(source.pipe(createThrottle(1)));

    expect(bytes).toBe(1024);
    expect(ms).toBeLessThan(3000);
  });
});
