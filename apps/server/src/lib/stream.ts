import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface StoredStream {
  sha256: string;
  bytes: number;
}

/**
 * Streams a request body to a file while hashing it in the same pass.
 *
 * Uploads here are saves and clips — routinely hundreds of megabytes — so the
 * body is never buffered in memory, and the digest is computed on the way past
 * rather than by re-reading the finished file.
 *
 * A failure or an over-limit body removes the partial file before rethrowing,
 * so a rejected upload never leaves a stray on disk.
 *
 * @param onOverflow Called when `maxBytes` is exceeded; whatever it returns is
 * thrown, letting callers raise their own domain error.
 */
export async function writeHashedStream(
  source: Readable | NodeJS.ReadableStream,
  target: string,
  maxBytes: number,
  onOverflow: () => Error,
): Promise<StoredStream> {
  const hash = createHash('sha256');
  let bytes = 0;

  try {
    await pipeline(
      source as Readable,
      async function* (chunks: AsyncIterable<Buffer | string>) {
        for await (const chunk of chunks) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          bytes += buffer.length;
          if (bytes > maxBytes) throw onOverflow();
          hash.update(buffer);
          yield buffer;
        }
      },
      createWriteStream(target),
    );
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }

  return { sha256: hash.digest('hex'), bytes };
}
