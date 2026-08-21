import { statfs } from 'node:fs/promises';
import { and, count, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  gameFiles,
  gameLaunchRules,
  games,
  gameSaveRules,
  libraries,
  users,
} from '../db/schema.js';
import type { AnalyticsService } from './analytics.js';
import type { BugService } from './bugs.js';

/** One thing that wants an operator's attention. */
export interface HealthFinding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  /** How many things this covers, when that is meaningful. */
  count?: number;
  /** Where to go and fix it. */
  href?: string;
}

export interface DiskUsage {
  label: string;
  path: string;
  freeBytes: number;
  totalBytes: number;
}

export interface HealthReport {
  checkedAt: string;
  disks: DiskUsage[];
  findings: HealthFinding[];
  /** When a scan last finished, or null if one never has. */
  lastScanAt: string | null;
}

/** Below this share free, a disk is worth saying something about. */
const DISK_WARN_RATIO = 0.1;
const DISK_CRITICAL_RATIO = 0.03;

/**
 * What needs an operator's attention right now.
 *
 * Distinct from analytics, which says what happened. This says what is wrong:
 * disks filling, games that have vanished from disk, catalog entries that
 * cannot be launched or synced, and accounts that have hit their limit. All of
 * it is derived from rows already being written, so nothing here needs
 * maintaining alongside the thing it describes.
 */
export class HealthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly analytics: AnalyticsService,
    private readonly bugs: BugService,
  ) {}

  async report(): Promise<HealthReport> {
    const findings: HealthFinding[] = [];

    const disks = await this.disks();
    for (const disk of disks) {
      if (disk.totalBytes === 0) continue;
      const free = disk.freeBytes / disk.totalBytes;
      if (free > DISK_WARN_RATIO) continue;

      findings.push({
        id: `disk-${disk.label.toLowerCase()}`,
        severity: free <= DISK_CRITICAL_RATIO ? 'critical' : 'warning',
        title: `${disk.label} is nearly full`,
        detail: `${formatPercent(free)} free at ${disk.path}.`,
      });
    }

    const missing = this.countGames(isNotNull(games.missingAt));
    if (missing > 0) {
      findings.push({
        id: 'missing-games',
        severity: 'critical',
        title: `${missing} ${plural(missing, 'game has', 'games have')} gone from disk`,
        detail:
          'Still in the catalog but no longer where the library says. Anyone downloading one gets an error.',
        count: missing,
        href: '/admin/catalog?gap=missing',
      });
    }

    // Files whose recorded checksum no longer matches what is on disk. Only
    // ever set by a verification run, so this is empty until one is done.
    const drifted = this.db
      .select({ n: count() })
      .from(gameFiles)
      .where(eq(gameFiles.integrity, 'mismatch'))
      .get();
    if ((drifted?.n ?? 0) > 0) {
      findings.push({
        id: 'checksum-drift',
        severity: 'critical',
        title: `${drifted?.n} ${plural(drifted?.n ?? 0, 'file has', 'files have')} changed on disk`,
        detail:
          'Their contents no longer match the checksum recorded for them. For an archive that usually means corruption rather than an edit.',
        count: drifted?.n,
        href: '/admin/catalog',
      });
    }

    const noLaunch = this.gamesWithoutLaunchRule();
    if (noLaunch > 0) {
      findings.push({
        id: 'no-launch-rule',
        severity: 'warning',
        title: `${noLaunch} ${plural(noLaunch, 'game has', 'games have')} no launch rule`,
        detail:
          'The client has to guess what to run, and picks wrong on anything with an installer.',
        count: noLaunch,
        href: '/admin/catalog?gap=launch-rule',
      });
    }

    const noSave = this.gamesWithoutSaveRule();
    if (noSave > 0) {
      findings.push({
        id: 'no-save-rule',
        severity: 'warning',
        title: `${noSave} ${plural(noSave, 'game has', 'games have')} no save rule`,
        detail: 'Nothing syncs for these. Save paths can suggest most of them.',
        count: noSave,
        href: '/admin/save-paths',
      });
    }

    const unmatched = this.countGames(
      or(eq(games.matchStatus, 'unmatched'), isNull(games.summary)),
    );
    if (unmatched > 0) {
      findings.push({
        id: 'unmatched',
        severity: 'info',
        title: `${unmatched} ${plural(unmatched, 'game is', 'games are')} unidentified`,
        detail: 'No metadata, so they show as a bare folder name with no artwork.',
        count: unmatched,
        href: '/admin/catalog?gap=metadata',
      });
    }

    const atQuota = this.analytics
      .quotaUsage()
      .filter((entry) => entry.quotaBytes > 0 && entry.usedBytes >= entry.quotaBytes);
    if (atQuota.length > 0) {
      findings.push({
        id: 'quota-exhausted',
        severity: 'warning',
        title: `${atQuota.length} ${plural(atQuota.length, 'account has', 'accounts have')} hit their limit`,
        detail: 'Their downloads are being refused until the month turns over.',
        count: atQuota.length,
        href: '/admin/users',
      });
    }

    const openBugs = this.bugs.openCount();
    if (openBugs > 0) {
      findings.push({
        id: 'open-bugs',
        severity: 'warning',
        title: `${openBugs} unanswered bug ${plural(openBugs, 'report', 'reports')}`,
        detail:
          'Nobody has replied to these yet. A reporter who hears nothing back stops reporting.',
        count: openBugs,
        href: '/admin/bugs',
      });
    }

    if (this.countGames() === 0) {
      findings.push({
        id: 'empty-catalog',
        severity: 'info',
        title: 'The catalog is empty',
        detail: 'Add a library and run a scan.',
        href: '/admin/libraries',
      });
    }

    return {
      checkedAt: new Date().toISOString(),
      disks,
      findings,
      lastScanAt: this.lastScanAt(),
    };
  }

  /** Free space on the data directory and each configured library. */
  private async disks(): Promise<DiskUsage[]> {
    const roots: Array<{ label: string; path: string }> = [
      { label: 'Data', path: this.config.dataDir },
      ...this.db
        .select({ name: libraries.name, path: libraries.path })
        .from(libraries)
        .all()
        .map((row) => ({ label: row.name, path: row.path })),
    ];

    const seen = new Set<string>();
    const disks: DiskUsage[] = [];

    for (const root of roots) {
      if (seen.has(root.path)) continue;
      seen.add(root.path);

      // A library on a disconnected mount is itself worth knowing about, but
      // it is reported as a missing-games finding rather than a zero-byte disk.
      const stats = await statfs(root.path).catch(() => null);
      if (!stats) continue;

      disks.push({
        label: root.label,
        path: root.path,
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
      });
    }

    return disks;
  }

  private countGames(where?: SQL): number {
    const query = this.db.select({ n: count() }).from(games);
    const row = where ? query.where(where).get() : query.get();
    return Number(row?.n ?? 0);
  }

  /** Games present on disk that have no launch rule. */
  private gamesWithoutLaunchRule(): number {
    const row = this.db
      .select({ n: count() })
      .from(games)
      .leftJoin(gameLaunchRules, eq(gameLaunchRules.gameId, games.id))
      .where(and(isNull(games.missingAt), isNull(gameLaunchRules.id)))
      .get();
    return Number(row?.n ?? 0);
  }

  /** Games present on disk that have no save rule. */
  private gamesWithoutSaveRule(): number {
    const row = this.db
      .select({ n: count() })
      .from(games)
      .leftJoin(gameSaveRules, eq(gameSaveRules.gameId, games.id))
      .where(and(isNull(games.missingAt), isNull(gameSaveRules.id)))
      .get();
    return Number(row?.n ?? 0);
  }

  private lastScanAt(): string | null {
    const row = this.db
      .select({ at: sql<string>`max(${games.scannedAt})` })
      .from(games)
      .get();
    return row?.at ?? null;
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
