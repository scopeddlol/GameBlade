import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { downloadEvents, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import type { SettingsService } from './settings.js';

/** What a user is allowed, and how much of it they have spent this month. */
export interface QuotaStatus {
  /** 0 means unlimited. */
  quotaBytes: number;
  usedBytes: number;
  remainingBytes: number;
  /** True when a quota applies and has been reached. */
  exceeded: boolean;
  /** ISO date the current window began. */
  periodStart: string;
}

/**
 * Download speed limits and monthly transfer quotas.
 *
 * Usage is derived from the download event log rather than kept as a running
 * counter: the log is written anyway, and a separate counter is one more thing
 * that can drift out of agreement with what actually happened.
 */
export class BandwidthService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  /** Bytes per second one download stream may use; 0 means unlimited. */
  speedLimitBytesPerSecond(): number {
    const kbps = this.settings.get().downloadSpeedLimitKbps ?? 0;
    return kbps > 0 ? kbps * 1024 : 0;
  }

  /** First instant of the current calendar month, in UTC. */
  static periodStart(now = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }

  /** Bytes this account has been sent since the start of the month. */
  usedThisPeriod(userId: string): number {
    const row = this.db
      .select({ bytes: sql<number>`coalesce(sum(${downloadEvents.bytesSent}), 0)` })
      .from(downloadEvents)
      .where(
        and(
          eq(downloadEvents.userId, userId),
          gte(downloadEvents.startedAt, BandwidthService.periodStart()),
        ),
      )
      .get();
    return Number(row?.bytes ?? 0);
  }

  /**
   * The quota that applies to one account.
   *
   * An explicit per-account override always wins, including for an
   * administrator — setting one and having it silently ignored would be the
   * more surprising behaviour. What administrators are exempt from is the
   * *server default*: it is not aimed at them, and applying it by accident
   * risks locking the operator out of their own downloads.
   */
  quotaBytesFor(userId: string): number {
    const user = this.db
      .select({ role: users.role, override: users.monthlyQuotaMb })
      .from(users)
      .where(eq(users.id, userId))
      .get();

    if (!user) return 0;
    if (user.override !== null && user.override !== undefined) {
      return user.override * 1024 * 1024;
    }
    if (user.role === 'admin') return 0;

    const defaultMb = this.settings.get().monthlyQuotaMb ?? 0;
    return defaultMb > 0 ? defaultMb * 1024 * 1024 : 0;
  }

  status(userId: string): QuotaStatus {
    const quotaBytes = this.quotaBytesFor(userId);
    const usedBytes = this.usedThisPeriod(userId);
    return {
      quotaBytes,
      usedBytes,
      remainingBytes:
        quotaBytes === 0 ? Number.POSITIVE_INFINITY : Math.max(0, quotaBytes - usedBytes),
      exceeded: quotaBytes > 0 && usedBytes >= quotaBytes,
      periodStart: BandwidthService.periodStart(),
    };
  }

  /**
   * Refuses a download that starts already over quota.
   *
   * Checked before a byte is written, and again while streaming — a single
   * transfer larger than the whole allowance would otherwise sail past a
   * start-only check, because usage is only recorded when a stream closes.
   */
  assertWithinQuota(userId: string): QuotaStatus {
    const status = this.status(userId);
    if (status.exceeded) {
      throw new ApiError(
        429,
        'quota_exceeded',
        'You have used your download allowance for this month. It resets at the start of next month.',
      );
    }
    return status;
  }
}
