import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import yazl from 'yazl';

/** What a stored archive looks like from the outside. */
export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  /** A complete copy also carries the regenerable artwork cache. */
  complete: boolean;
}

export interface BackupSettings {
  /** Archives kept before the oldest is deleted. */
  keep: number;
  /** Hours between automatic runs; 0 turns them off. */
  everyHours: number;
  /**
   * Whether cached provider artwork is included.
   *
   * Off by default. It is the largest thing in the data directory by a wide
   * margin and the only part that can be fetched again, so including it turns
   * a small daily archive into a very large one to protect the one thing that
   * is not actually at risk.
   */
  includeImages: boolean;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  keep: 7,
  everyHours: 24,
  includeImages: false,
};

/** Trees/partials that must never be copied into an archive. */
const ALWAYS_SKIP_AT_ROOT = new Set([
  'backups',
  'coordinator-backups',
  'save-manifest.yaml.part',
  'save-manifest.json.part',
]);

/** Regenerable files omitted only from the smaller, essential archive. */
const ESSENTIAL_SKIP_AT_ROOT = new Set(['save-manifest.json']);

/** Names of the parts of the data directory, in the order they are added. */
const CONTENT_DIRS = ['saves', 'media', 'client'] as const;

/**
 * Archives of everything that cannot be recreated.
 *
 * The data directory holds the database, every player's cloud saves, uploaded
 * avatars and clips, and the published installer. Losing it loses other
 * people's saves, which is a promise this server made to them and which they
 * had no part in storing. Until now nothing here could be backed up at all.
 *
 * The game library itself is deliberately not included: it is enormous, it is
 * the one thing an operator already has somewhere else, and a scan rebuilds
 * every catalog row from it.
 */
export class BackupService {
  private running: Promise<BackupInfo> | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly sqlite: Database.Database,
  ) {}

  private get dir(): string {
    return path.join(this.dataDir, 'backups');
  }

  async list(): Promise<BackupInfo[]> {
    const entries = await readdir(this.dir).catch(() => []);
    const infos: BackupInfo[] = [];

    for (const name of entries) {
      if (!name.endsWith('.zip')) continue;
      const info = await stat(path.join(this.dir, name)).catch(() => null);
      if (!info?.isFile()) continue;
      infos.push({
        name,
        sizeBytes: info.size,
        createdAt: new Date(info.mtimeMs).toISOString(),
        complete: name.startsWith('gameblade-full-'),
      });
    }

    // Newest first, which is the one anyone restoring actually wants.
    return infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pathFor(name: string): string | null {
    // Only ever a plain file name from our own listing; anything with a
    // separator in it is a caller trying to reach outside the directory.
    if (!/^gameblade-[\w.-]+\.zip$/.test(name) || name.includes('/') || name.includes('\\')) {
      return null;
    }
    return path.join(this.dir, name);
  }

  async remove(name: string): Promise<boolean> {
    const target = this.pathFor(name);
    if (!target) return false;
    await rm(target, { force: true });
    return true;
  }

  /**
   * Writes a new archive and prunes old ones.
   *
   * The database is copied through SQLite's own backup API rather than by
   * reading the file: with WAL on, the file on disk is not a complete database
   * on its own, and copying it while a scan writes produces an archive that
   * restores to a corrupt state.
   */
  async create(settings: BackupSettings): Promise<BackupInfo> {
    // A scheduled run and two Nodes may all ask at the same moment. They want
    // the same point-in-time copy, not three competing SQLite snapshots and
    // three ZIP writers fighting over the Coordinator's disk.
    if (this.running) return this.running;

    this.running = this.write(settings).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  private async write(settings: BackupSettings): Promise<BackupInfo> {
    await mkdir(this.dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Complete archives are identifiable without opening a potentially huge
    // ZIP. Nodes only accept these for off-machine retention: artwork can be
    // fetched again, but "back up everything" should still mean everything.
    const name = `gameblade-${settings.includeImages ? 'full-' : ''}${stamp}.zip`;
    const target = path.join(this.dir, name);
    const staging = `${target}.part`;

    // Written outside the data directory's own tree so an in-progress copy is
    // never itself picked up by the walk below.
    const dbCopy = path.join(this.dir, `.db-${stamp}`);
    await this.sqlite.backup(dbCopy);

    try {
      const zip = new yazl.ZipFile();
      zip.addFile(dbCopy, 'gameblade.db');

      for (const name of CONTENT_DIRS) {
        await addTree(zip, path.join(this.dataDir, name), name);
      }
      if (settings.includeImages) {
        await addTree(zip, path.join(this.dataDir, 'images'), 'images');
      }

      // Anything else sitting at the root. Complete Node copies recursively
      // include future directories too, so adding a new kind of Coordinator
      // state cannot silently make the disaster-recovery archive incomplete.
      const covered = new Set<string>([...CONTENT_DIRS, 'images']);
      for (const entry of await readdir(this.dataDir, { withFileTypes: true }).catch(() => [])) {
        if (ALWAYS_SKIP_AT_ROOT.has(entry.name) || covered.has(entry.name)) continue;
        if (!settings.includeImages && ESSENTIAL_SKIP_AT_ROOT.has(entry.name)) continue;

        if (entry.isDirectory()) {
          await addTree(zip, path.join(this.dataDir, entry.name), entry.name);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('gameblade.db')) continue;
        zip.addFile(path.join(this.dataDir, entry.name), entry.name);
      }

      zip.end();

      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(staging);
        zip.outputStream.pipe(out).on('close', resolve).on('error', reject);
        zip.outputStream.on('error', reject);
      });

      // Renamed only once complete, so a crash mid-write never leaves
      // something that looks like a usable archive.
      const { rename } = await import('node:fs/promises');
      await rename(staging, target);
    } finally {
      await rm(dbCopy, { force: true });
      await rm(staging, { force: true });
    }

    await this.prune(settings.keep);

    const info = await stat(target);
    return {
      name,
      sizeBytes: info.size,
      createdAt: new Date(info.mtimeMs).toISOString(),
      complete: settings.includeImages,
    };
  }

  /** Deletes the oldest archives beyond the number to keep. */
  async prune(keep: number): Promise<number> {
    if (keep <= 0) return 0;
    const all = await this.list();
    const doomed = all.slice(keep);
    for (const entry of doomed) await this.remove(entry.name);
    return doomed.length;
  }
}

/** Adds a directory to the archive, recursively, skipping what cannot be read. */
async function addTree(zip: yazl.ZipFile, root: string, prefix: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return;

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const relative = `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      await addTree(zip, full, relative);
      continue;
    }
    // Symlinks are skipped rather than followed: an archive that dereferences
    // them can be made to include anything on the disk.
    if (!entry.isFile()) continue;

    zip.addFile(full, relative);
  }
}
