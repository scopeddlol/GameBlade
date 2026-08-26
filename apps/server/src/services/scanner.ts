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

const IDLE_PROGRESS: ScanProgress = {
  libraryId: null,
  state: 'idle',
  phase: null,
  library: null,
  processed: 0,
  total: 0,
  currentItem: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  added: 0,
  updated: 0,
  removed: 0,
  log: [],
  skipped: 0,
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

function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isIgnored(name: string): boolean {
  return name.startsWith('.') || IGNORED.has(name.toLowerCase());
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

  /** Records a line for the admin panel, keeping only the recent ones. */
  private note(level: ScanLogEntry['level'], message: string): void {
    const log = [...this.progress.log, { at: new Date().toISOString(), level, message }].slice(
      -SCAN_LOG_LINES,
    );
    this.progress = { ...this.progress, log };
    if (level === 'warn') this.logger.warn({}, message);
    else this.logger.info({}, message);
  }

  /** Consumes a pending skip request, if there is one. */
  private takeSkip(): boolean {
    if (!this.skipRequested) return false;
    this.skipRequested = false;
    this.progress = { ...this.progress, skipped: this.progress.skipped + 1 };
    return true;
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
        this.logger.error({ err: error }, 'library scan failed');
        this.progress = {
          ...this.progress,
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        };
      })
      .finally(() => {
        this.running = null;
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
    this.progress = {
      ...IDLE_PROGRESS,
      libraryId: options.libraryId ?? null,
      state: 'scanning',
      phase: 'reading',
      startedAt: new Date().toISOString(),
    };
    this.note(
      'info',
      `Scan started over ${targets.length} librar${targets.length === 1 ? 'y' : 'ies'}`,
    );

    for (const library of targets) {
      if (!library.enabled && !options.libraryId) continue;
      await this.scanLibrary(library, options.force ?? false);
    }

    if (options.fetchMetadata !== false) {
      // The internal loop, not the guarded wrapper: `matchPending` returns the
      // in-flight run when one exists, which here is this very scan — awaiting
      // it would be awaiting ourselves.
      await this.runMatchPending();
    }

    this.note(
      'info',
      `Scan finished — ${this.progress.added} added, ${this.progress.updated} updated, ` +
        `${this.progress.removed} missing, ${this.progress.skipped} skipped`,
    );
    this.progress = {
      ...this.progress,
      state: 'idle',
      phase: null,
      library: null,
      currentItem: null,
      finishedAt: new Date().toISOString(),
    };
  }

  private async scanLibrary(library: Library, force: boolean): Promise<void> {
    this.logger.info({ library: library.name, path: library.path }, 'scanning library');
    const startedAt = Date.now();

    let discovered: DiscoveredGame[];
    try {
      // Walking a large share turns up no count until it finishes, and the
      // progress readout would otherwise sit on the previous library's final
      // tally throughout — indistinguishable from a stall. Naming the library
      // being read says which of the two is happening.
      this.progress = {
        ...this.progress,
        phase: 'reading',
        library: library.name,
        currentItem: `Reading ${library.name}…`,
      };
      this.note('info', `Reading ${library.name} (${library.path})`);
      discovered = await this.discover(library.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, path: library.path }, 'library root unreadable');
      this.db
        .update(libraries)
        .set({ lastScanAt: new Date().toISOString(), lastScanStatus: `error: ${message}` })
        .where(eq(libraries.id, library.id))
        .run();
      return;
    }

    this.note(
      'info',
      `Read ${library.name}: ${discovered.length} entries in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );

    this.progress = {
      ...this.progress,
      phase: 'indexing',
      total: this.progress.total + discovered.length,
    };

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
      seen.add(item.relPath);
      this.progress = {
        ...this.progress,
        processed: this.progress.processed + 1,
        currentItem: item.rawName,
      };

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

      const current = existing.get(item.relPath);
      if (current) {
        const unchanged =
          !force &&
          current.sizeBytes === item.sizeBytes &&
          current.fileCount === item.files.length &&
          current.contentMtime === item.contentMtime &&
          current.missingAt === null;

        if (unchanged) continue;

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
        this.progress = { ...this.progress, updated: this.progress.updated + 1 };
        continue;
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
      this.progress = { ...this.progress, added: this.progress.added + 1 };
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
      this.progress = { ...this.progress, removed: this.progress.removed + vanished.length };
      this.note('info', `${vanished.length} entries in ${library.name} are no longer on disk`);
    }

    this.db
      .update(libraries)
      .set({
        lastScanAt: new Date().toISOString(),
        lastScanStatus: `ok: ${discovered.length} entries`,
      })
      .where(eq(libraries.id, library.id))
      .run();
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

  /** Enumerate library entries: top-level directories and top-level archives. */
  private async discover(root: string): Promise<DiscoveredGame[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const results: DiscoveredGame[] = [];

    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const absolute = path.join(root, entry.name);

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
        this.logger.warn({ err: error, entry: entry.name }, 'skipping unreadable library entry');
      }
    }

    return results;
  }

  /** Recursively list a folder game's files, guarding against symlink loops. */
  private async walkFolder(
    root: string,
    prefix: string,
    depth = 0,
    visited = new Set<string>(),
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
            files.push(...(await this.walkFolder(root, relPath, depth + 1, visited)));
          } else if (info.isFile()) {
            files.push({
              relPath: toPosixPath(relPath),
              sizeBytes: info.size,
              modifiedAt: info.mtime.toISOString(),
            });
          }
        } catch {
          // Broken link — nothing to index.
        }
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...(await this.walkFolder(root, relPath, depth + 1, visited)));
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
  matchPending(limit = 500): Promise<void> {
    if (this.running) return this.running;

    this.skipRequested = false;
    this.progress = {
      ...IDLE_PROGRESS,
      state: 'matching',
      phase: 'matching',
      startedAt: new Date().toISOString(),
    };

    this.running = this.runMatchPending(limit)
      .then(() => {
        this.progress = {
          ...this.progress,
          state: 'idle',
          phase: null,
          currentItem: null,
          finishedAt: new Date().toISOString(),
        };
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'metadata enrichment failed');
        this.progress = {
          ...this.progress,
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        };
      })
      .finally(() => {
        this.running = null;
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
   * Leaves the progress state on `matching`; whoever started the run decides
   * what it becomes next.
   */
  private async runMatchPending(limit = 500): Promise<void> {
    if (!this.metadata.hasIgdb && !this.metadata.hasSteamGridDb) {
      this.logger.info({}, 'no metadata providers configured — skipping enrichment');
      return;
    }

    const pending = this.db
      .select()
      .from(games)
      .where(
        and(
          isNull(games.missingAt),
          // Enrichment is a first-time job. Once a provider has written to a
          // row it is left alone, so a title corrected by hand or artwork
          // chosen deliberately is not undone by the next scan.
          isNull(games.metadataLockedAt),
          or(eq(games.matchStatus, 'unmatched'), isNull(games.coverImageId)),
        ),
      )
      .limit(limit)
      .all();

    if (pending.length === 0) {
      this.note('info', 'No games are waiting on metadata');
      return;
    }

    this.note('info', `Fetching metadata for ${pending.length} games`);

    this.progress = {
      ...this.progress,
      state: 'matching',
      phase: 'matching',
      currentItem: null,
      processed: 0,
      total: pending.length,
    };

    for (const game of pending) {
      this.progress = {
        ...this.progress,
        processed: this.progress.processed + 1,
        currentItem: game.title,
      };

      // A skip asked for while the previous title was in flight applies here.
      if (this.takeSkip()) {
        this.note('warn', `Skipped metadata for ${game.title}`);
        continue;
      }

      const controller = new AbortController();
      this.currentItem = controller;
      try {
        await this.metadata.enrich(game, controller.signal);
      } catch (error) {
        // An abort here is the operator pressing skip, not a failure.
        if (this.takeSkip()) {
          this.note('warn', `Skipped metadata for ${game.title}`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.note('warn', `Could not fetch metadata for ${game.title}: ${message}`);
        }
      } finally {
        this.currentItem = null;
      }

      // Providers are awaited above, so the loop already yields; this only
      // matters for a run where every game is skipped outright.
      await yieldToLoop();
    }
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
