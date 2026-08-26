import { readdir, realpath, stat } from 'node:fs/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import path from 'node:path';
import {
  ARCHIVE_EXTENSIONS,
  IGNORED_ENTRIES,
  type ScanLogEntry,
  type ScanProgress,
} from '@gameblade/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFiles, games, libraries, type Game, type Library } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { toPosixPath } from '../lib/paths.js';
import { parseTitle, toSearchTitle, toSortTitle } from '../lib/titles.js';
import type { Logger, MetadataService } from './metadata/service.js';

const IGNORED = new Set<string>(IGNORED_ENTRIES);

/** How many activity lines the admin panel is offered. */
const SCAN_LOG_LINES = 200;

/**
 * How many entries are reconciled before the run hands the event loop back.
 *
 * SQLite here is synchronous, so a library's worth of inserts is one long
 * uninterrupted block of work: for a big archive the server stops answering
 * anything at all until it ends, which from the admin panel is indistinguishable
 * from the whole thing having fallen over. Pausing between batches costs the
 * scan very little and keeps the API responsive throughout.
 */
const YIELD_EVERY = 25;

/**
 * How many directory entries the walk reads before yielding.
 *
 * The reading phase used to run start to finish without ever giving the loop
 * back. On a spinning disk holding thousands of folders that is minutes of a
 * server that answers nothing — including the progress endpoint the operator
 * is refreshing to find out what is happening.
 */
const WALK_YIELD_EVERY = 200;

/**
 * The longest one title may spend in the providers before the run moves on.
 *
 * Every individual request already has its own timeout, but a title is not one
 * request: a match is a search, a fetch, a cover, and up to a screenshot per
 * image the provider publishes, each with its own retries. Multiply those out
 * and a single game can legitimately occupy the run for the better part of an
 * hour — which is exactly what "the scan has been running since I started the
 * app" turned out to be. This is the ceiling on the whole title.
 */
const ITEM_DEADLINE_MS = 90_000;

/**
 * How long a single library's walk may take before the run gives up on it.
 *
 * A share that has gone away mid-walk does not fail, it hangs — every `readdir`
 * blocking on a mount that will never answer. Without a ceiling the run sits
 * there for ever with no log line and no counter moving.
 */
const READ_DEADLINE_MS = 30 * 60_000;

/**
 * How many rows the enrichment pass claims at a time, and how many passes it
 * will make. Batching means a library with three thousand unmatched games is
 * finished by one run rather than needing the button pressed six times.
 */
const MATCH_BATCH = 250;
const MATCH_MAX_BATCHES = 40;

const IDLE_PROGRESS: ScanProgress = {
  libraryId: null,
  state: 'idle',
  phase: null,
  library: null,
  libraryIndex: 0,
  libraryCount: 0,
  processed: 0,
  total: 0,
  currentItem: null,
  heartbeatAt: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  added: 0,
  updated: 0,
  removed: 0,
  log: [],
  skipped: 0,
  failed: 0,
  canceling: false,
};

interface DiscoveredFile {
  relPath: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface DiscoveredGame {
  relPath: string;
  kind: 'folder' | 'archive';
  rawName: string;
  sizeBytes: number;
  files: DiscoveredFile[];
  contentMtime: string;
}

/** Raised by `cancel`, and caught only by the run that was asked to stop. */
class ScanCanceled extends Error {
  constructor() {
    super('Scan canceled');
    this.name = 'ScanCanceled';
  }
}

function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isIgnored(name: string): boolean {
  return name.startsWith('.') || IGNORED.has(name.toLowerCase());
}

/**
 * Runs `work` with a hard ceiling, aborting it rather than waiting it out.
 *
 * The abort matters more than the timer: without it the abandoned work carries
 * on in the background holding a provider slot, so "moved on" would mean the
 * next title queues behind the one we supposedly gave up on.
 */
async function withDeadline<T>(
  timeoutMs: number,
  controller: AbortController,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; timedOut: false } | { value: null; timedOut: true }> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return { value: await work(controller.signal), timedOut: false };
  } catch (error) {
    if (timedOut) return { value: null, timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walks the configured library roots and reconciles what is on disk with the
 * database.
 *
 * The library is mounted read-only, so the scanner only ever reads. A game is
 * either a top-level directory (a portable install) or a top-level archive file.
 * Nested directories are walked to enumerate a folder game's files, never to
 * discover additional games — otherwise every `data/` subfolder would become an
 * entry of its own.
 *
 * Everything here is written on the assumption that a run can wedge, because in
 * practice one did: a share that stops answering, a provider that accepts a
 * connection and then goes quiet, one game whose fifty screenshots each get two
 * sixty-second attempts. Each phase therefore carries its own deadline, every
 * counter is reset when the phase changes rather than carried forward, and the
 * progress record stamps the moment it last moved so a wedged run can be told
 * from a slow one without reading the container's logs.
 */
export class ScannerService {
  private progress: ScanProgress = { ...IDLE_PROGRESS };

  private running: Promise<void> | null = null;

  /**
   * Set when the operator asks to move past whatever is in front of the run.
   *
   * Cleared by the item that consumes it. The controller is what makes the ask
   * take effect immediately: a provider request that has already gone out is
   * aborted rather than waited on, which is the difference between "skip" and
   * "skip once this finishes in twenty seconds".
   */
  private skipRequested = false;
  private cancelRequested = false;
  private currentItem: AbortController | null = null;

  constructor(
    private readonly db: Db,
    private readonly metadata: MetadataService,
    private readonly logger: Logger,
  ) {}

  getProgress(): ScanProgress {
    return { ...this.progress, log: [...this.progress.log] };
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Move past whatever the run is working on now.
   *
   * Returns false when there is nothing to skip, so the caller can say so
   * rather than reporting a skip that did not happen.
   */
  skipCurrent(): boolean {
    if (!this.running) return false;
    this.skipRequested = true;
    // Stops an in-flight provider request rather than letting the skip wait on
    // it. Aborting a controller nothing is listening to is harmless.
    this.currentItem?.abort();
    this.note('warn', `Skipping ${this.progress.currentItem ?? 'the current item'}`);
    return true;
  }

  /**
   * Stop the whole run at the next checkpoint.
   *
   * Skip was the only control there was, which is no help at all when the
   * problem is the run itself rather than one title in it — the only way out
   * was restarting the container. What has already been written stays written:
   * a cancelled scan is a partial scan, not a rolled-back one.
   */
  cancel(): boolean {
    if (!this.running) return false;
    this.cancelRequested = true;
    this.currentItem?.abort();
    this.progress = { ...this.progress, canceling: true };
    this.note('warn', 'Stopping the scan…');
    return true;
  }

  /** Records a line for the admin panel, keeping only the recent ones. */
  private note(level: ScanLogEntry['level'], message: string): void {
    const log = [...this.progress.log, { at: new Date().toISOString(), level, message }].slice(
      -SCAN_LOG_LINES,
    );
    this.progress = { ...this.progress, log, heartbeatAt: new Date().toISOString() };
    if (level === 'warn') this.logger.warn({}, message);
    else this.logger.info({}, message);
  }

  /**
   * Moves the run's counters and stamps the moment it happened.
   *
   * Every progress write goes through here so that `heartbeatAt` cannot drift
   * out of step with the numbers it is meant to describe.
   */
  private advance(patch: Partial<ScanProgress>): void {
    this.progress = { ...this.progress, ...patch, heartbeatAt: new Date().toISOString() };
  }

  /**
   * Starts a phase, clearing the counters the previous one left behind.
   *
   * This is the fix for the readout that sat on "25 / 25" while the second
   * library was still being read: the totals belong to a phase, so they end
   * with it rather than being carried into work that has not started counting.
   */
  private beginPhase(phase: ScanProgress['phase'], patch: Partial<ScanProgress> = {}): void {
    this.advance({ phase, processed: 0, total: 0, currentItem: null, ...patch });
  }

  /** Consumes a pending skip request, if there is one. */
  private takeSkip(): boolean {
    if (!this.skipRequested) return false;
    this.skipRequested = false;
    this.advance({ skipped: this.progress.skipped + 1 });
    return true;
  }

  /** Throws out of the run if a stop has been asked for. */
  private checkpoint(): void {
    if (this.cancelRequested) throw new ScanCanceled();
  }

  /**
   * Start a scan unless one is already in flight, in which case the existing
   * run is returned so callers never queue duplicate work.
   */
  scan(
    options: { libraryId?: string; force?: boolean; fetchMetadata?: boolean } = {},
  ): Promise<void> {
    if (this.running) return this.running;

    this.running = this.runScan(options)
      .catch((error: unknown) => {
        if (error instanceof ScanCanceled) {
          this.note('warn', 'Scan stopped');
          this.advance({
            state: 'canceled',
            phase: null,
            currentItem: null,
            canceling: false,
            finishedAt: new Date().toISOString(),
          });
          return;
        }
        this.logger.error({ err: error }, 'library scan failed');
        this.advance({
          state: 'error',
          canceling: false,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
      })
      .finally(() => {
        this.running = null;
        this.cancelRequested = false;
        this.skipRequested = false;
        this.currentItem = null;
      });

    return this.running;
  }

  private async runScan(options: {
    libraryId?: string;
    force?: boolean;
    fetchMetadata?: boolean;
  }): Promise<void> {
    const targets = options.libraryId
      ? this.db.select().from(libraries).where(eq(libraries.id, options.libraryId)).all()
      : this.db.select().from(libraries).where(eq(libraries.enabled, true)).all();

    this.skipRequested = false;
    this.cancelRequested = false;
    this.progress = {
      ...IDLE_PROGRESS,
      libraryId: options.libraryId ?? null,
      state: 'scanning',
      phase: 'reading',
      libraryCount: targets.length,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    this.note(
      'info',
      `Scan started over ${targets.length} librar${targets.length === 1 ? 'y' : 'ies'}`,
    );

    let index = 0;
    for (const library of targets) {
      if (!library.enabled && !options.libraryId) continue;
      this.checkpoint();
      index += 1;
      this.advance({ libraryIndex: index, library: library.name });
      await this.scanLibrary(library, options.force ?? false);
    }

    if (options.fetchMetadata !== false) {
      this.checkpoint();
      // The internal loop, not the guarded wrapper: `matchPending` returns the
      // in-flight run when one exists, which here is this very scan — awaiting
      // it would be awaiting ourselves.
      await this.runMatchPending();
    }

    this.note(
      'info',
      `Scan finished — ${this.progress.added} added, ${this.progress.updated} updated, ` +
        `${this.progress.removed} missing, ${this.progress.skipped} skipped, ` +
        `${this.progress.failed} failed`,
    );
    this.advance({
      state: 'idle',
      phase: null,
      library: null,
      currentItem: null,
      canceling: false,
      finishedAt: new Date().toISOString(),
    });
  }

  private async scanLibrary(library: Library, force: boolean): Promise<void> {
    this.logger.info({ library: library.name, path: library.path }, 'scanning library');
    const startedAt = Date.now();

    let discovered: DiscoveredGame[];
    try {
      // Walking a large share turns up no count until it finishes, and the
      // progress readout used to sit on the *previous* library's final tally
      // throughout — indistinguishable from a stall, and the reason a run
      // part-way through its second root reported "25 / 25" for minutes on
      // end. The counters are cleared here and the walk reports what it has
      // found so far as it goes.
      this.beginPhase('reading', {
        library: library.name,
        currentItem: `Reading ${library.name}…`,
      });
      this.note('info', `Reading ${library.name} (${library.path})`);

      const controller = new AbortController();
      this.currentItem = controller;
      const read = await withDeadline(READ_DEADLINE_MS, controller, () =>
        this.discover(library.path),
      );
      this.currentItem = null;

      if (read.timedOut) {
        this.checkpoint();
        const message = `gave up after ${Math.round(READ_DEADLINE_MS / 60_000)} minutes`;
        this.note('warn', `Could not finish reading ${library.name} — ${message}`);
        this.markLibraryScan(library.id, `error: ${message}`);
        this.advance({ failed: this.progress.failed + 1 });
        return;
      }
      discovered = read.value;
    } catch (error) {
      if (error instanceof ScanCanceled) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.currentItem = null;
      this.logger.error({ err: error, path: library.path }, 'library root unreadable');
      this.note('warn', `Could not read ${library.name}: ${message}`);
      this.markLibraryScan(library.id, `error: ${message}`);
      this.advance({ failed: this.progress.failed + 1 });
      return;
    }

    this.note(
      'info',
      `Read ${library.name}: ${discovered.length} entries in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );

    this.beginPhase('indexing', { library: library.name, total: discovered.length });

    const existing = new Map(
      this.db
        .select()
        .from(games)
        .where(eq(games.libraryId, library.id))
        .all()
        .map((g) => [g.relPath, g]),
    );

    const seen = new Set<string>();

    let sinceYield = 0;
    for (const item of discovered) {
      this.checkpoint();
      seen.add(item.relPath);
      this.advance({ processed: this.progress.processed + 1, currentItem: item.rawName });

      // SQLite is synchronous here, so without this the whole library is one
      // unbroken block of work and the server answers nothing until it ends.
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        await yieldToLoop();
      }

      // Marking it seen above and skipping here is deliberate: a skipped entry
      // keeps whatever row it already has rather than being flagged missing.
      if (this.takeSkip()) {
        this.note('warn', `Skipped ${item.rawName}`);
        continue;
      }

      try {
        this.reconcile(library, item, existing.get(item.relPath), force);
      } catch (error) {
        // One unwritable row is not a reason to abandon the other four
        // thousand; it is a reason to say which one and carry on.
        const message = error instanceof Error ? error.message : String(error);
        this.note('warn', `Could not index ${item.rawName}: ${message}`);
        this.advance({ failed: this.progress.failed + 1 });
      }
    }

    // Anything previously known but absent now is flagged rather than deleted,
    // so an unmounted share does not destroy hand-made metadata matches.
    const vanished = [...existing.keys()].filter((relPath) => !seen.has(relPath));
    if (vanished.length > 0) {
      for (const batch of chunk(vanished, 400)) {
        this.db
          .update(games)
          .set({ missingAt: new Date().toISOString() })
          .where(
            and(
              eq(games.libraryId, library.id),
              inArray(games.relPath, batch),
              isNull(games.missingAt),
            ),
          )
          .run();
      }
      this.advance({ removed: this.progress.removed + vanished.length });
      this.note('info', `${vanished.length} entries in ${library.name} are no longer on disk`);
    }

    this.markLibraryScan(library.id, `ok: ${discovered.length} entries`);
  }

  private markLibraryScan(libraryId: string, status: string): void {
    this.db
      .update(libraries)
      .set({ lastScanAt: new Date().toISOString(), lastScanStatus: status })
      .where(eq(libraries.id, libraryId))
      .run();
  }

  /** Insert, update or leave alone one discovered entry. */
  private reconcile(
    library: Library,
    item: DiscoveredGame,
    current: Game | undefined,
    force: boolean,
  ): void {
    if (current) {
      const unchanged =
        !force &&
        current.sizeBytes === item.sizeBytes &&
        current.fileCount === item.files.length &&
        current.contentMtime === item.contentMtime &&
        current.missingAt === null;

      if (unchanged) return;

      this.db
        .update(games)
        .set({
          sizeBytes: item.sizeBytes,
          fileCount: item.files.length,
          contentMtime: item.contentMtime,
          scannedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          missingAt: null,
        })
        .where(eq(games.id, current.id))
        .run();

      this.replaceFiles(current.id, item.files);
      this.advance({ updated: this.progress.updated + 1 });
      return;
    }

    const title = parseTitle(item.rawName, item.kind === 'archive');
    const id = newId('gam');
    const now = new Date().toISOString();

    this.db
      .insert(games)
      .values({
        id,
        libraryId: library.id,
        relPath: item.relPath,
        kind: item.kind,
        title,
        sortTitle: toSortTitle(title),
        searchTitle: toSearchTitle(title),
        sizeBytes: item.sizeBytes,
        fileCount: item.files.length,
        contentMtime: item.contentMtime,
        matchStatus: 'unmatched',
        addedAt: now,
        updatedAt: now,
        scannedAt: now,
      })
      .run();

    this.replaceFiles(id, item.files);
    this.advance({ added: this.progress.added + 1 });
  }

  private replaceFiles(gameId: string, files: DiscoveredFile[]): void {
    this.db.transaction((tx) => {
      tx.delete(gameFiles).where(eq(gameFiles.gameId, gameId)).run();
      for (const batch of chunk(files, 200)) {
        tx.insert(gameFiles)
          .values(
            batch.map((file) => ({
              id: newId('gfl'),
              gameId,
              relPath: file.relPath,
              sizeBytes: file.sizeBytes,
              modifiedAt: file.modifiedAt,
              sha256: null,
            })),
          )
          .run();
      }
    });
  }

  /**
   * Enumerate library entries: top-level directories and top-level archives.
   *
   * Reports as it goes rather than only at the end. The count it publishes is
   * "entries found so far" — the walk genuinely does not know the total until
   * it finishes — but a number that climbs is the whole difference between a
   * run somebody can watch and one they assume has died.
   */
  private async discover(root: string): Promise<DiscoveredGame[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const results: DiscoveredGame[] = [];
    const candidates = entries.filter((entry) => !isIgnored(entry.name));

    // Now that the top level is known, the phase has a real denominator: it is
    // the folders to inspect, not the games that will come out of them.
    this.advance({ total: candidates.length });

    for (const entry of candidates) {
      this.checkpoint();
      const absolute = path.join(root, entry.name);
      this.advance({ processed: this.progress.processed + 1, currentItem: entry.name });

      if (this.takeSkip()) {
        this.note('warn', `Skipped reading ${entry.name}`);
        continue;
      }

      try {
        if (entry.isDirectory()) {
          const files = await this.walkFolder(absolute, '');
          if (files.length === 0) continue;
          results.push({
            relPath: toPosixPath(entry.name),
            kind: 'folder',
            rawName: entry.name,
            sizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
            files,
            contentMtime: files.reduce((max, f) => (f.modifiedAt > max ? f.modifiedAt : max), ''),
          });
        } else if (entry.isFile() && isArchive(entry.name)) {
          const info = await stat(absolute);
          results.push({
            relPath: toPosixPath(entry.name),
            kind: 'archive',
            rawName: entry.name,
            sizeBytes: info.size,
            files: [
              {
                relPath: entry.name,
                sizeBytes: info.size,
                modifiedAt: info.mtime.toISOString(),
              },
            ],
            contentMtime: info.mtime.toISOString(),
          });
        }
      } catch (error) {
        if (error instanceof ScanCanceled) throw error;
        this.logger.warn({ err: error, entry: entry.name }, 'skipping unreadable library entry');
        this.note('warn', `Skipping ${entry.name}: unreadable`);
        this.advance({ failed: this.progress.failed + 1 });
      }
    }

    return results;
  }

  /**
   * Recursively list a folder game's files, guarding against symlink loops.
   *
   * Yields to the event loop periodically. A game with a hundred thousand small
   * files is not unusual — an emulator set, an engine's asset tree — and
   * without this the server stops answering for as long as one of them takes to
   * read off a spinning disk.
   */
  private async walkFolder(
    root: string,
    prefix: string,
    depth = 0,
    visited = new Set<string>(),
    counter = { seen: 0 },
  ): Promise<DiscoveredFile[]> {
    if (depth > 12) return [];

    const dir = prefix ? path.join(root, prefix) : root;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      this.logger.warn({ err: error, dir }, 'skipping unreadable directory');
      return [];
    }

    const files: DiscoveredFile[] = [];

    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      if (++counter.seen % WALK_YIELD_EVERY === 0) {
        this.checkpoint();
        await yieldToLoop();
      }
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(root, relPath);

      if (entry.isSymbolicLink()) {
        // Resolve once, then only follow it if it stays inside this game and has
        // not been visited, so a self-referential link cannot spin forever.
        try {
          const info = await stat(absolute);
          const real = await realpath(absolute);
          if (visited.has(real)) continue;
          visited.add(real);
          if (info.isDirectory()) {
            files.push(...(await this.walkFolder(root, relPath, depth + 1, visited, counter)));
          } else if (info.isFile()) {
            files.push({
              relPath: toPosixPath(relPath),
              sizeBytes: info.size,
              modifiedAt: info.mtime.toISOString(),
            });
          }
        } catch (error) {
          if (error instanceof ScanCanceled) throw error;
          // Broken link — nothing to index.
        }
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...(await this.walkFolder(root, relPath, depth + 1, visited, counter)));
      } else if (entry.isFile()) {
        try {
          const info = await stat(absolute);
          files.push({
            relPath: toPosixPath(relPath),
            sizeBytes: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        } catch {
          // Disappeared mid-scan; ignore.
        }
      }
    }

    return files;
  }

  /**
   * Run enrichment on its own, outside a scan.
   *
   * Goes through the same guard as `scan`, so the two cannot interleave and
   * trample each other's progress, and — the part that matters — returns the
   * progress to `idle` when it finishes. The bare loop below does not: it
   * leaves the state on `matching`, which is correct mid-scan because `runScan`
   * closes it out afterwards, but left this stuck at its final count forever
   * when the admin panel's "fetch metadata" button called it directly. The UI
   * reads `matching` as a run in flight, so the count sat there and every scan
   * button stayed disabled until the server was restarted.
   */
  matchPending(limit = MATCH_BATCH): Promise<void> {
    if (this.running) return this.running;

    this.skipRequested = false;
    this.cancelRequested = false;
    this.progress = {
      ...IDLE_PROGRESS,
      state: 'matching',
      phase: 'matching',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };

    this.running = this.runMatchPending(limit)
      .then(() => {
        this.advance({
          state: 'idle',
          phase: null,
          currentItem: null,
          canceling: false,
          finishedAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ScanCanceled) {
          this.note('warn', 'Metadata enrichment stopped');
          this.advance({
            state: 'canceled',
            phase: null,
            currentItem: null,
            canceling: false,
            finishedAt: new Date().toISOString(),
          });
          return;
        }
        this.logger.error({ err: error }, 'metadata enrichment failed');
        this.advance({
          state: 'error',
          canceling: false,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
      })
      .finally(() => {
        this.running = null;
        this.cancelRequested = false;
        this.skipRequested = false;
        this.currentItem = null;
      });

    return this.running;
  }

  /**
   * Fill in metadata and artwork for every game still missing either.
   *
   * A game with no cover is picked up even once it has been matched, because
   * artwork comes from a different provider that may have been configured
   * later — or that was unreachable when the game was first scanned.
   *
   * Claimed in batches and looped, because one pass with a fixed limit quietly
   * left everything past that limit for the next time somebody pressed the
   * button — on a first scan of a large archive, most of it.
   *
   * Leaves the progress state on `matching`; whoever started the run decides
   * what it becomes next.
   */
  private async runMatchPending(batchSize = MATCH_BATCH): Promise<void> {
    if (!this.metadata.hasIgdb && !this.metadata.hasSteamGridDb) {
      this.note('info', 'No metadata providers configured — skipping enrichment');
      return;
    }

    // Counted up front so the progress bar means something across the whole
    // pass rather than restarting at zero on every batch.
    const outstanding = this.countPending();
    if (outstanding === 0) {
      this.note('info', 'No games are waiting on metadata');
      return;
    }

    this.note('info', `Fetching metadata for ${outstanding} games`);
    this.beginPhase('matching', { state: 'matching', library: null, total: outstanding });

    // Rows that came back with nothing are held aside so the next batch does
    // not re-claim them: the query selects "still missing metadata", which a
    // title the provider has never heard of matches for ever.
    const exhausted = new Set<string>();

    for (let pass = 0; pass < MATCH_MAX_BATCHES; pass += 1) {
      this.checkpoint();
      const pending = this.selectPending(batchSize + exhausted.size).filter(
        (game) => !exhausted.has(game.id),
      );
      if (pending.length === 0) break;

      for (const game of pending.slice(0, batchSize)) {
        this.checkpoint();
        this.advance({ processed: this.progress.processed + 1, currentItem: game.title });

        // A skip asked for while the previous title was in flight applies here.
        if (this.takeSkip()) {
          this.note('warn', `Skipped metadata for ${game.title}`);
          exhausted.add(game.id);
          continue;
        }

        const before = this.db.select().from(games).where(eq(games.id, game.id)).get();
        const controller = new AbortController();
        this.currentItem = controller;
        try {
          const result = await withDeadline(ITEM_DEADLINE_MS, controller, (signal) =>
            this.metadata.enrich(game, signal),
          );
          if (result.timedOut) {
            this.note(
              'warn',
              `Gave up on ${game.title} after ${Math.round(ITEM_DEADLINE_MS / 1000)}s`,
            );
            this.advance({ failed: this.progress.failed + 1 });
          }
        } catch (error) {
          // An abort here is the operator pressing skip, not a failure.
          if (this.takeSkip()) {
            this.note('warn', `Skipped metadata for ${game.title}`);
          } else if (this.cancelRequested) {
            throw new ScanCanceled();
          } else {
            const message = error instanceof Error ? error.message : String(error);
            this.note('warn', `Could not fetch metadata for ${game.title}: ${message}`);
            this.advance({ failed: this.progress.failed + 1 });
          }
        } finally {
          this.currentItem = null;
        }

        // Whether or not it worked, this title has had its turn. Without this
        // the next batch re-selects it — a provider that does not know the
        // game would otherwise be asked about it until the pass cap ran out.
        const after = this.db.select().from(games).where(eq(games.id, game.id)).get();
        if (!after || (before && after.updatedAt === before.updatedAt)) {
          exhausted.add(game.id);
        }

        // Providers are awaited above, so the loop already yields; this only
        // matters for a run where every game is skipped outright.
        await yieldToLoop();
      }
    }

    const left = this.countPending();
    if (left > 0) {
      this.note(
        'info',
        `${left} games still have no metadata — the providers had nothing for them, ` +
          'or they need matching by hand from the catalog',
      );
    }
  }

  /** The filter both the count and the batch query share. */
  private pendingWhere() {
    return and(
      isNull(games.missingAt),
      // Enrichment is a first-time job. Once a provider has written to a
      // row it is left alone, so a title corrected by hand or artwork
      // chosen deliberately is not undone by the next scan.
      isNull(games.metadataLockedAt),
      or(eq(games.matchStatus, 'unmatched'), isNull(games.coverImageId)),
    );
  }

  private countPending(): number {
    return (
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(games)
        .where(this.pendingWhere())
        .get()?.count ?? 0
    );
  }

  private selectPending(limit: number): Game[] {
    return this.db.select().from(games).where(this.pendingWhere()).limit(limit).all();
  }

  /**
   * Permanently delete games flagged missing for longer than the grace period.
   *
   * The comparison is inclusive so that a grace period of zero means "every
   * entry currently flagged", including one flagged by a scan that finished in
   * this same millisecond.
   */
  purgeMissing(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = this.db
      .delete(games)
      .where(and(sql`${games.missingAt} IS NOT NULL`, sql`${games.missingAt} <= ${cutoff}`))
      .run();
    return result.changes;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export type { Game };
