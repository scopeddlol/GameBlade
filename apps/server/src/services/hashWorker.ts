import { parentPort } from 'node:worker_threads';
import { hashFileByChunk, hashFileWhole, type HashMode } from './hashing.js';

/**
 * One thread of the hashing pool.
 *
 * Deliberately tiny and stateless: it takes a path, reads it once and posts the
 * digests back. Everything that decides *which* files to read, what to do with
 * the answer and how to report progress stays on the main thread, where the
 * database is — a worker that could write rows would need its own connection
 * to a SQLite file the rest of the server already has open.
 *
 * Progress is posted as bytes are read rather than only at the end, because a
 * single 60 GB archive is otherwise twenty minutes of a bar that does not move.
 */
const port = parentPort;
if (!port) throw new Error('hashWorker must be run as a worker thread');

interface HashRequest {
  id: number;
  path: string;
  mode: HashMode;
}

/** How often byte counts are posted back. Often enough to look live, rarely
 * enough that the channel is not the bottleneck on a fast NVMe read. */
const PROGRESS_INTERVAL_BYTES = 16 * 1024 * 1024;

port.on('message', (request: HashRequest) => {
  let sinceLastReport = 0;
  const onBytes = (bytes: number) => {
    sinceLastReport += bytes;
    if (sinceLastReport < PROGRESS_INTERVAL_BYTES) return;
    port.postMessage({ id: request.id, type: 'progress', bytes: sinceLastReport });
    sinceLastReport = 0;
  };

  const flush = () => {
    if (sinceLastReport > 0) {
      port.postMessage({ id: request.id, type: 'progress', bytes: sinceLastReport });
      sinceLastReport = 0;
    }
  };

  const work =
    request.mode === 'chunked'
      ? hashFileByChunk(request.path, onBytes).then((digest) => {
          flush();
          port.postMessage({ id: request.id, type: 'done', digest });
        })
      : hashFileWhole(request.path, onBytes).then((whole) => {
          flush();
          port.postMessage({ id: request.id, type: 'done', whole });
        });

  work.catch((error: unknown) => {
    port.postMessage({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
