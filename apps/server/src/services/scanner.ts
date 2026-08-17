import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ARCHIVE_EXTENSIONS, IGNORED_ENTRIES, type ScanProgress } from '@gameblade/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameFiles, games, libraries, type Game, type Library } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { toPosixPath } from '../lib/paths.js';
import { parseTitle, toSearchTitle, toSortTitle } from '../lib/titles.js';
import type { Logger, MetadataService } from './metadata/service.js';

const IGNORED = new Set<string>(IGNORED_ENTRIES);

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
  private progress: ScanProgress = {
    libraryId: null,
    state: 'idle',
    processed: 0,
    total: 0,
    currentItem: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    added: 0,
    updated: 0,
    removed: 0,
  };

  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly metadata: MetadataService,
    private readonly logger: Logger,
  ) {}

  getProgress(): ScanProgress {
    return { ...this.progress };
  }

  get isRunning(): boolean {
    return this.running !== null;
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

    this.progress = {
      libraryId: options.libraryId ?? null,
      state: 'scanning',
      processed: 0,
      total: 0,
      currentItem: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      added: 0,
      updated: 0,
      removed: 0,
    };

    for (const library of targets) {
      if (!library.enabled && !options.libraryId) continue;
      await this.scanLibrary(library, options.force ?? false);
    }

    if (options.fetchMetadata !== false) {
      await this.matchPending();
    }

    this.progress = {
      ...this.progress,
      state: 'idle',
      currentItem: null,
      finishedAt: new Date().toISOString(),
    };
  }

  private async scanLibrary(library: Library, force: boolean): Promise<void> {
    this.logger.info({ library: library.name, path: library.path }, 'scanning library');

    let discovered: DiscoveredGame[];
    try {
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

    this.progress = { ...this.progress, total: this.progress.total + discovered.length };

    const existing = new Map(
      this.db
        .select()
        .from(games)
        .where(eq(games.libraryId, library.id))
        .all()
        .map((g) => [g.relPath, g]),
    );

    const seen = new Set<string>();

    for (const item of discovered) {
      seen.add(item.relPath);
      this.progress = {
        ...this.progress,
        processed: this.progress.processed + 1,
        currentItem: item.rawName,
      };

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
   * Fill in metadata and artwork for every game still missing either.
   *
   * A game with no cover is picked up even once it has been matched, because
   * artwork comes from a different provider that may have been configured
   * later — or that was unreachable when the game was first scanned.
   */
  async matchPending(limit = 500): Promise<void> {
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
          or(eq(games.matchStatus, 'unmatched'), isNull(games.coverImageId)),
        ),
      )
      .limit(limit)
      .all();

    if (pending.length === 0) return;

    this.progress = {
      ...this.progress,
      state: 'matching',
      processed: 0,
      total: pending.length,
    };

    for (const game of pending) {
      this.progress = {
        ...this.progress,
        processed: this.progress.processed + 1,
        currentItem: game.title,
      };
      try {
        await this.metadata.enrich(game);
      } catch (error) {
        this.logger.warn({ err: error, title: game.title }, 'metadata enrichment failed');
      }
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
