import { mkdirSync } from 'node:fs';
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
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);

  // WAL keeps reads flowing while a scan writes; NORMAL is the right durability
  // trade-off for a media catalogue that can always be rebuilt by rescanning.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 10000');
  sqlite.pragma('temp_store = MEMORY');

  applyMigrations(sqlite, logger);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
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
