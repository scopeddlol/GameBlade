import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupService, DEFAULT_BACKUP_SETTINGS } from './backups.js';

/** Lists what actually ended up inside an archive. */
async function entriesIn(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('could not open'));
      zip.on('entry', (entry: { fileName: string }) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Pulls one file out, so the database inside can actually be opened. */
async function extract(zipPath: string, wanted: string, to: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('could not open'));
      zip.on('entry', (entry: { fileName: string }) => {
        if (entry.fileName !== wanted) return zip.readEntry();
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('no stream'));
          const { createWriteStream } = require('node:fs') as typeof import('node:fs');
          stream.pipe(createWriteStream(to)).on('close', resolve).on('error', reject);
        });
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/**
 * Archiving the data directory.
 *
 * This is the only copy of every player's cloud saves. The tests that matter
 * are that the database inside an archive actually opens, and that nothing
 * irreplaceable is left out.
 */
describe('BackupService', () => {
  let dataDir: string;
  let sqlite: Database.Database;
  let service: BackupService;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-backup-test-'));

    sqlite = new Database(path.join(dataDir, 'gameblade.db'));
    // WAL is what the real server uses, and is exactly why the file on disk
    // cannot simply be copied.
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec('CREATE TABLE saves (id TEXT PRIMARY KEY, body TEXT)');
    sqlite.prepare('INSERT INTO saves VALUES (?, ?)').run('one', 'precious');

    await mkdir(path.join(dataDir, 'saves', 'user1'), { recursive: true });
    await writeFile(path.join(dataDir, 'saves', 'user1', 'slot.zip'), 'save bytes');
    await mkdir(path.join(dataDir, 'media'), { recursive: true });
    await writeFile(path.join(dataDir, 'media', 'avatar.png'), 'png bytes');
    await mkdir(path.join(dataDir, 'images'), { recursive: true });
    await writeFile(path.join(dataDir, 'images', 'cover.webp'), 'cached artwork');
    await mkdir(path.join(dataDir, 'client'), { recursive: true });
    await writeFile(path.join(dataDir, 'client', 'setup.exe'), 'installer');

    service = new BackupService(dataDir, sqlite);
  });

  afterEach(async () => {
    sqlite.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('produces a database that opens and still has the data', async () => {
    // The reason for using SQLite's backup API rather than copying the file:
    // under WAL the file alone is not a complete database.
    const info = await service.create(DEFAULT_BACKUP_SETTINGS);
    const restored = path.join(dataDir, 'restored.db');
    await extract(path.join(dataDir, 'backups', info.name), 'gameblade.db', restored);

    const reopened = new Database(restored, { readonly: true });
    const row = reopened.prepare('SELECT body FROM saves WHERE id = ?').get('one') as {
      body: string;
    };
    reopened.close();
    expect(row.body).toBe('precious');
  });

  it('includes everything that cannot be fetched again', async () => {
    const info = await service.create(DEFAULT_BACKUP_SETTINGS);
    const names = await entriesIn(path.join(dataDir, 'backups', info.name));

    expect(names).toContain('gameblade.db');
    expect(names).toContain('saves/user1/slot.zip');
    expect(names).toContain('media/avatar.png');
    expect(names).toContain('client/setup.exe');
  });

  it('leaves cached artwork out by default', async () => {
    // It is the largest thing there and the only part that can be refetched.
    const info = await service.create(DEFAULT_BACKUP_SETTINGS);
    const names = await entriesIn(path.join(dataDir, 'backups', info.name));
    expect(names.some((name) => name.startsWith('images/'))).toBe(false);
  });

  it('includes artwork when asked', async () => {
    const info = await service.create({ ...DEFAULT_BACKUP_SETTINGS, includeImages: true });
    const names = await entriesIn(path.join(dataDir, 'backups', info.name));
    expect(names).toContain('images/cover.webp');
  });

  it('never archives its own archives', async () => {
    await service.create(DEFAULT_BACKUP_SETTINGS);
    const second = await service.create(DEFAULT_BACKUP_SETTINGS);
    const names = await entriesIn(path.join(dataDir, 'backups', second.name));
    expect(names.some((name) => name.startsWith('backups/'))).toBe(false);
  });

  it('keeps only the newest archives', async () => {
    for (let i = 0; i < 4; i += 1) {
      await service.create({ ...DEFAULT_BACKUP_SETTINGS, keep: 2 });
      // Distinct names come from the timestamp, which is second-resolution.
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    expect(await service.list()).toHaveLength(2);
  });

  it('lists newest first', async () => {
    await service.create(DEFAULT_BACKUP_SETTINGS);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await service.create(DEFAULT_BACKUP_SETTINGS);
    expect((await service.list())[0]?.name).toBe(second.name);
  });

  it('refuses a name that tries to leave the backup directory', () => {
    // The name reaches this from a URL parameter.
    expect(service.pathFor('../../etc/passwd')).toBeNull();
    expect(service.pathFor('gameblade-../x.zip')).toBeNull();
    expect(service.pathFor('not-a-backup.zip')).toBeNull();
    expect(service.pathFor('gameblade-2026-01-01.zip')).not.toBeNull();
  });

  it('leaves no partial archive behind on a clean run', async () => {
    await service.create(DEFAULT_BACKUP_SETTINGS);
    const { readdir } = await import('node:fs/promises');
    const left = await readdir(path.join(dataDir, 'backups'));
    expect(left.filter((name) => name.endsWith('.part') || name.startsWith('.db-'))).toEqual([]);
  });

  it('survives a data directory with pieces missing', async () => {
    // A fresh install has no media or saves yet.
    await rm(path.join(dataDir, 'media'), { recursive: true, force: true });
    await rm(path.join(dataDir, 'saves'), { recursive: true, force: true });
    const info = await service.create(DEFAULT_BACKUP_SETTINGS);
    expect(info.sizeBytes).toBeGreaterThan(0);
  });
});
