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

  // WAL keeps reads flowing while a scan writes; NORMAL is the right durability
  // trade-off for a media catalog that can always be rebuilt by rescanning.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 10000');
  sqlite.pragma('temp_store = MEMORY');

  applyMigrations(sqlite, logger);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
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
