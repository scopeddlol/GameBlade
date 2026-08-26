import { accessSync, constants, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrations } from './migrations.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  /** Escape hatch for pragmas and maintenance the query builder cannot express. */
  sqlite: Database.Database;
}

export function createDb(databasePath: string, logger?: { info: (msg: string) => void }): DbHandle {
  const dataDir = path.dirname(databasePath);
  assertDataDirWritable(dataDir);

  const sqlite = new Database(databasePath);

  tune(sqlite);
  applyMigrations(sqlite, logger);

  // Fresh statistics on a database whose shape has just changed. Without this
  // SQLite plans the first queries after a migration from whatever it knew
  // before, which on a large catalog is how a query that has an index still
  // ends up scanning the table.
  analyze(sqlite);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/**
 * How much of the database SQLite may keep in memory.
 *
 * Negative values are kibibytes rather than pages, which is the only form worth
 * writing: the page size can change underneath a page count and quietly mean
 * something else. 64 MiB is a catalog of tens of thousands of games and every
 * index over it — small next to what the container is already given, and the
 * difference between a query answered from memory and one answered by a disk
 * that has to move a head to do it.
 */
const CACHE_KIB = 64 * 1024;

/**
 * How much of the file to map into the address space.
 *
 * Memory-mapped reads skip a copy through SQLite's own pager, which matters
 * most on the read-heavy work this server does — a library page is a join
 * across four tables and runs on every tab switch. 256 MiB is a ceiling, not a
 * reservation: only pages actually touched are ever faulted in.
 */
const MMAP_BYTES = 256 * 1024 * 1024;

/**
 * Pragmas, tuned for a catalog living on a spinning disk.
 *
 * The defaults assume a database that is small or a disk that is fast, and this
 * is neither: a seek costs milliseconds rather than microseconds, so the goal
 * throughout is to make fewer of them. Every one of these is a runtime setting
 * that has to be set per connection — none of it persists in the file.
 */
function tune(sqlite: Database.Database): void {
  // Before journal_mode, and it matters: a database already in WAL will not
  // change its page size at all, and one that is not only applies it while the
  // file is still empty. A larger page is fewer of them for the same row, which
  // on a disk that charges milliseconds per seek is most of the win — so an
  // existing database keeps whatever it was created with, and a new one gets
  // this.
  sqlite.pragma('page_size = 8192');

  // WAL keeps reads flowing while a scan writes; NORMAL is the right durability
  // trade-off for a media catalog that can always be rebuilt by rescanning.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 10000');
  sqlite.pragma('temp_store = MEMORY');

  sqlite.pragma(`cache_size = -${CACHE_KIB}`);
  sqlite.pragma(`mmap_size = ${MMAP_BYTES}`);

  // The default checkpoints every 1000 pages, which on a scan writing thousands
  // of rows means stopping to fold the WAL back into the database over and
  // over. Four times that trades a larger WAL file — cheap — for a quarter as
  // many of those pauses.
  sqlite.pragma('wal_autocheckpoint = 4000');

  // Bounds what `PRAGMA optimize` will do in one go, so the periodic run below
  // can never turn into a full table scan on a large catalog.
  sqlite.pragma('analysis_limit = 400');
}

/** Refresh the planner's statistics, bounded by `analysis_limit`. */
function analyze(sqlite: Database.Database): void {
  try {
    sqlite.pragma('optimize');
  } catch {
    // Statistics are an optimisation, never a correctness requirement.
  }
}

/**
 * Periodic upkeep, and the checkpoint that keeps the WAL from growing without
 * bound on a server that is never idle for long.
 *
 * Returns what it did so the admin panel can show it rather than the operator
 * having to trust that a button did something.
 */
export function maintain(
  sqlite: Database.Database,
  options: { vacuum?: boolean } = {},
): { walPages: number; vacuumed: boolean; sizeBytes: number } {
  analyze(sqlite);

  // TRUNCATE rather than PASSIVE: it resets the WAL file to nothing once the
  // frames are folded in, where PASSIVE leaves it at its high-water mark for
  // ever. On a disk being watched for space that difference is visible.
  const checkpoint = sqlite.pragma('wal_checkpoint(TRUNCATE)') as Array<{ log?: number }>;

  // Rewrites the file with its pages in order, which is what actually repays
  // the cost on a spinning disk: a table read back-to-front across a fragmented
  // file is a seek per page. Deliberately not automatic — it needs room for a
  // second copy of the database on the same disk, and holds a write lock for
  // as long as it takes.
  if (options.vacuum) sqlite.exec('VACUUM');

  const pageCount = Number((sqlite.pragma('page_count', { simple: true }) as number) ?? 0);
  const pageSize = Number((sqlite.pragma('page_size', { simple: true }) as number) ?? 0);

  return {
    walPages: Number(checkpoint[0]?.log ?? 0),
    vacuumed: options.vacuum === true,
    sizeBytes: pageCount * pageSize,
  };
}

/**
 * SQLite is embedded, so a "database" failure at boot is almost always the data
 * directory not being writable — typically a bind mount owned by root while the
 * container runs as uid 1000. Raw SQLITE_CANTOPEN says none of that, so the
 * cause and the fix are reported explicitly instead.
 */
function assertDataDirWritable(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(buildPermissionMessage(dataDir, 'could not be created'));
    }
    throw error;
  }

  try {
    accessSync(dataDir, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(buildPermissionMessage(dataDir, 'is not writable'));
  }
}

function buildPermissionMessage(dataDir: string, problem: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  const identity = uid === null ? 'this process' : `uid ${uid}${gid === null ? '' : `:${gid}`}`;

  return [
    `The data directory "${dataDir}" ${problem} by ${identity}.`,
    '',
    'GameBlade stores its SQLite database there. In Docker this usually means the',
    'bind-mounted host folder is owned by a different user than the container.',
    '',
    'Fix it on the host with:',
    `  sudo chown -R ${uid ?? 1000}:${gid ?? 1000} <the folder you mounted at ${dataDir}>`,
    '',
    'Or run the container as the owning user by adding to your compose service:',
    '  user: "1000:1000"   # replace with your own values from: id -u && id -g',
  ].join('\n');
}

function applyMigrations(
  sqlite: Database.Database,
  logger?: { info: (msg: string) => void },
): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);

  const applied = new Set(
    sqlite
      .prepare<[], { id: string }>('SELECT id FROM _migrations')
      .all()
      .map((r) => r.id),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    logger?.info(`applying migration ${migration.id}`);
    const run = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      sqlite.prepare('INSERT INTO _migrations (id) VALUES (?)').run(migration.id);
    });
    run();
  }
}

export { schema };
