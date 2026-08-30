import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { MESH_CHUNK_BYTES, type ChunkRef } from '@gameblade/shared';

/**
 * How much is read at once.
 *
 * Eight megabytes rather than one: hashing an archive is one long sequential
 * read, and the old buffer meant eight times as many syscalls, event-loop
 * turns and buffer copies per chunk of the mesh grid. On a spinning disk or an
 * SMB mount — which is what a home archive usually is — the larger request is
 * most of the difference on its own.
 */
export const READ_BUFFER_BYTES = 8 * 1024 * 1024;

/** What one pass over a file produced. */
export interface FileDigest {
  whole: string;
  chunks: ChunkRef[];
}

/** Called as bytes are read, so a pass can report progress inside a big file. */
export type ProgressSink = (bytes: number) => void;

/**
 * One streamed pass producing the whole-file hash and every chunk hash.
 *
 * The read stream's buffers have nothing to do with the chunk grid, so the
 * bytes are cut here rather than trusted to arrive aligned. Getting this wrong
 * is not a crash — it is a set of hashes that look fine and match nothing any
 * other implementation computes, so the split is deliberately explicit.
 */
export function hashFileByChunk(absolutePath: string, onBytes?: ProgressSink): Promise<FileDigest> {
  return new Promise((resolve, reject) => {
    const whole = createHash('sha256');
    let chunkHash = createHash('sha256');
    let chunkFilled = 0;
    let index = 0;
    const chunks: ChunkRef[] = [];

    const closeChunk = () => {
      chunks.push({ index, sha256: chunkHash.digest('hex'), sizeBytes: chunkFilled });
      index += 1;
      chunkHash = createHash('sha256');
      chunkFilled = 0;
    };

    // Streamed, and never larger than one chunk in memory, so a 50 GB file
    // costs the same as a 50 MB one.
    const stream = createReadStream(absolutePath, { highWaterMark: READ_BUFFER_BYTES });

    stream.on('data', (buffer: string | Buffer) => {
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      whole.update(bytes);
      onBytes?.(bytes.length);

      let consumed = 0;
      while (consumed < bytes.length) {
        const room = MESH_CHUNK_BYTES - chunkFilled;
        const take = Math.min(room, bytes.length - consumed);
        chunkHash.update(bytes.subarray(consumed, consumed + take));
        chunkFilled += take;
        consumed += take;

        if (chunkFilled === MESH_CHUNK_BYTES) closeChunk();
      }
    });

    stream.on('error', reject);

    stream.on('end', () => {
      // A trailing partial chunk still counts. An empty file gets none at all,
      // which is what `chunkCountFor` says it should have.
      if (chunkFilled > 0) closeChunk();
      resolve({ whole: whole.digest('hex'), chunks });
    });
  });
}

/** The whole-file digest on its own, for the integrity pass. */
export function hashFileWhole(absolutePath: string, onBytes?: ProgressSink): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath, { highWaterMark: READ_BUFFER_BYTES });
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
      onBytes?.(typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/* ------------------------------------------------------------------- pool */

/** What the caller wants out of one file. */
export type HashMode = 'chunked' | 'whole';

interface Job {
  path: string;
  mode: HashMode;
  onBytes?: ProgressSink;
  resolve: (value: FileDigest | string) => void;
  reject: (error: unknown) => void;
  /** Set while a worker is holding it, so a crash can fail exactly that job. */
  worker?: Worker;
}

interface WorkerMessage {
  id: number;
  type: 'progress' | 'done' | 'error';
  bytes?: number;
  digest?: FileDigest;
  whole?: string;
  message?: string;
}

/**
 * Where the worker script lives once this is built.
 *
 * `existsSync` rather than a bare `new Worker(...)`: under `tsx` and `vitest`
 * this module runs straight from `src`, where no compiled sibling exists, and
 * a worker that fails to boot would surface as an unhandled rejection halfway
 * through a hashing pass. Absent, the pool hashes in-process instead — same
 * answers, same concurrency over the disk, just without the extra cores.
 */
const WORKER_URL = new URL('./hashWorker.js', import.meta.url);
const WORKERS_AVAILABLE = existsSync(fileURLToPath(WORKER_URL));

/** A sensible number of files to read at once when nothing says otherwise. */
export function defaultHashConcurrency(): number {
  // One core left for the rest of the server: this runs while the same process
  // is answering downloads, and a pass that saturates every core makes the
  // whole archive feel down for the hours it takes.
  const cores = availableParallelism();
  return Math.max(1, Math.min(6, cores - 1));
}

/**
 * Hashes several files at once, on worker threads where it can.
 *
 * Hashing used to be one file at a time on the main thread, which made it slow
 * twice over: SHA-256 is real CPU work that blocked everything else the server
 * was doing, and a single sequential reader leaves most of a disk's — or a
 * network mount's — throughput on the table. Both halves are fixed by the same
 * change. The whole-file and per-chunk digests still come from one read, so
 * the bytes are never walked twice.
 *
 * Falls back to in-process hashing when there is no compiled worker beside
 * this file, so development and tests behave identically apart from speed.
 */
export class HashPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly inFlight = new Map<number, Job>();
  private readonly queue: Job[] = [];
  private nextJobId = 1;
  private inlineRunning = 0;
  private closed = false;

  constructor(
    readonly size: number,
    private readonly onWorkerFailure?: (error: unknown) => void,
  ) {}

  /** Whether real threads are doing the work, for the progress readout. */
  get threaded(): boolean {
    return WORKERS_AVAILABLE;
  }

  chunked(path: string, onBytes?: ProgressSink): Promise<FileDigest> {
    return this.submit(path, 'chunked', onBytes) as Promise<FileDigest>;
  }

  whole(path: string, onBytes?: ProgressSink): Promise<string> {
    return this.submit(path, 'whole', onBytes) as Promise<string>;
  }

  private submit(
    path: string,
    mode: HashMode,
    onBytes?: ProgressSink,
  ): Promise<FileDigest | string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ path, mode, onBytes, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length > 0) {
      if (WORKERS_AVAILABLE) {
        const worker = this.idle.pop() ?? this.spawn();
        if (!worker) break;
        this.dispatch(worker, this.queue.shift() as Job);
      } else {
        if (this.inlineRunning >= this.size) break;
        this.runInline(this.queue.shift() as Job);
      }
    }
  }

  private spawn(): Worker | null {
    if (this.workers.length >= this.size) return null;

    const worker = new Worker(WORKER_URL);
    this.workers.push(worker);

    worker.on('message', (message: WorkerMessage) => {
      const job = this.inFlight.get(message.id);
      if (!job) return;

      if (message.type === 'progress') {
        job.onBytes?.(message.bytes ?? 0);
        return;
      }

      this.inFlight.delete(message.id);
      this.idle.push(worker);

      if (message.type === 'error') {
        job.reject(new Error(message.message ?? 'Hashing failed'));
      } else {
        job.resolve(
          job.mode === 'chunked' ? (message.digest as FileDigest) : (message.whole as string),
        );
      }
      this.pump();
    });

    // A worker that dies takes whatever it was holding with it. Failing that
    // one file rather than the whole pass matches how an unreadable file is
    // already treated, and the caller logs it the same way.
    worker.on('error', (error) => {
      this.onWorkerFailure?.(error);
      this.retire(worker, error);
    });
    worker.on('exit', () => {
      if (!this.closed) this.retire(worker, new Error('The hashing worker stopped'));
    });

    return worker;
  }

  private retire(worker: Worker, error: unknown): void {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);

    for (const [id, job] of [...this.inFlight]) {
      if (job.worker !== worker) continue;
      this.inFlight.delete(id);
      job.reject(error);
    }
    this.pump();
  }

  private dispatch(worker: Worker, job: Job): void {
    const id = this.nextJobId++;
    job.worker = worker;
    this.inFlight.set(id, job);
    worker.postMessage({ id, path: job.path, mode: job.mode });
  }

  private runInline(job: Job): void {
    this.inlineRunning += 1;
    const finish = () => {
      this.inlineRunning -= 1;
      this.pump();
    };

    const work =
      job.mode === 'chunked'
        ? hashFileByChunk(job.path, job.onBytes)
        : hashFileWhole(job.path, job.onBytes);

    work.then(
      (result) => {
        job.resolve(result);
        finish();
      },
      (error: unknown) => {
        job.reject(error);
        finish();
      },
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

/* --------------------------------------------------------------- progress */

/**
 * What a hashing pass over one game is doing, in enough detail to watch.
 *
 * A bare percentage was the whole readout before this, and on an archive it is
 * the least useful number available: it moves in jumps of a whole file, says
 * nothing about which of several thousand files is being read, and gives no way
 * to tell "slow because the disk is slow" from "stuck". Bytes, a live rate, an
 * estimate and the names of the files actually open answer all three.
 */
export interface HashProgress {
  gameId: string | null;
  /** The game's title, so nothing has to resolve an id to show a name. */
  gameTitle: string | null;
  state: 'idle' | 'hashing' | 'error';
  /** Files finished, and files this pass set out to read. */
  processed: number;
  total: number;
  /** Bytes finished, and bytes this pass set out to read. */
  bytesProcessed: number;
  bytesTotal: number;
  /** Every file open right now — one per worker. */
  currentFiles: string[];
  /** The first of those, for anything that only has room for one name. */
  currentFile: string | null;
  startedAt: string | null;
  /** Read speed over the last few seconds, not the average since the start. */
  bytesPerSecond: number;
  /** Seconds left at the current rate, or null before there is one. */
  etaSeconds: number | null;
  /** How many files are being read at once. */
  concurrency: number;
  /** False when the pool is hashing in-process rather than on threads. */
  threaded: boolean;
  error: string | null;
}

export function idleHashProgress(): HashProgress {
  return {
    gameId: null,
    gameTitle: null,
    state: 'idle',
    processed: 0,
    total: 0,
    bytesProcessed: 0,
    bytesTotal: 0,
    currentFiles: [],
    currentFile: null,
    startedAt: null,
    bytesPerSecond: 0,
    etaSeconds: null,
    concurrency: 0,
    threaded: WORKERS_AVAILABLE,
    error: null,
  };
}

/**
 * A read rate over a short trailing window.
 *
 * Averaging since the start of a pass makes the rate lag reality by however
 * long the pass has been going, so an archive that slowed to a crawl an hour
 * ago still reads as fast. A short window is what makes the estimate move when
 * the disk does.
 */
export class RateMeter {
  private readonly samples: Array<{ at: number; bytes: number }> = [];
  private total = 0;

  constructor(private readonly windowMs = 15_000) {}

  add(bytes: number): void {
    const now = Date.now();
    this.total += bytes;
    this.samples.push({ at: now, bytes });
    this.trim(now);
  }

  /** Bytes per second over the window, or 0 before anything has been read. */
  rate(): number {
    const now = Date.now();
    this.trim(now);
    if (this.samples.length < 2) return 0;

    const oldest = this.samples[0];
    if (!oldest) return 0;
    const elapsed = now - oldest.at;
    if (elapsed <= 0) return 0;

    const bytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    return Math.round((bytes / elapsed) * 1000);
  }

  get bytes(): number {
    return this.total;
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && (this.samples[0]?.at ?? 0) < cutoff) this.samples.shift();
  }
}

/** Seconds left at the given rate, or null when neither is known. */
export function etaFrom(remainingBytes: number, bytesPerSecond: number): number | null {
  if (remainingBytes <= 0) return 0;
  if (bytesPerSecond <= 0) return null;
  return Math.round(remainingBytes / bytesPerSecond);
}
