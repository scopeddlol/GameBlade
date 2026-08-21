import type {
  BugQuery,
  BugReportInfo,
  BugReportInput,
  BugTriageInput,
  BugStatus,
} from '@gameblade/shared';
import { BUG_STATUS_LABELS } from '@gameblade/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { bugReports, games } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { NotificationService } from './notifications.js';
import type { ProfileService } from './profiles.js';

/**
 * Reports from the people actually using the thing.
 *
 * This archive is tested by its players rather than by a suite, so the path
 * from "that broke" to an operator seeing it has to be short enough that people
 * bother. Two things follow from that: the client attaches what it already
 * knows rather than asking the reporter for it, and every status change tells
 * the reporter — hearing nothing back is the main reason people stop
 * reporting.
 */
export class BugService {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileService,
    private readonly notifications: NotificationService,
  ) {}

  create(userId: string, input: BugReportInput): BugReportInfo {
    // A report naming a game that has since been removed is still worth
    // keeping; only the link to it is dropped.
    const gameId = input.gameId
      ? (this.db.select({ id: games.id }).from(games).where(eq(games.id, input.gameId)).get()?.id ??
        null)
      : null;

    const record = {
      id: newId('bug'),
      userId,
      title: input.title,
      body: input.body,
      severity: input.severity,
      status: 'open' as const,
      reply: null,
      gameId,
      clientVersion: input.clientVersion ?? null,
      platform: input.platform ?? null,
      diagnostics: input.diagnostics ?? null,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    this.db.insert(bugReports).values(record).run();

    return this.get(record.id, userId, false);
  }

  /** The reports one person filed, so they can see where each got to. */
  mine(userId: string): BugReportInfo[] {
    return this.db
      .select()
      .from(bugReports)
      .where(eq(bugReports.userId, userId))
      .orderBy(desc(bugReports.createdAt))
      .all()
      .map((row) => this.toInfo(row, userId, false));
  }

  /** The triage queue. */
  list(query: BugQuery, viewerId: string): BugReportInfo[] {
    const where = query.status ? eq(bugReports.status, query.status) : undefined;
    const base = this.db.select().from(bugReports).$dynamic();

    return (where ? base.where(where) : base)
      .orderBy(desc(bugReports.createdAt))
      .limit(query.limit)
      .all()
      .map((row) => this.toInfo(row, viewerId, true));
  }

  get(id: string, viewerId: string, asAdmin: boolean): BugReportInfo {
    const row = this.db.select().from(bugReports).where(eq(bugReports.id, id)).get();
    if (!row) throw ApiError.notFound('Report not found');
    if (!asAdmin && row.userId !== viewerId) throw ApiError.notFound('Report not found');
    return this.toInfo(row, viewerId, asAdmin);
  }

  /**
   * Answers a report, and tells whoever filed it.
   *
   * The notification is the point. A reporter who never hears back concludes
   * that reporting does nothing, and the next bug goes unreported.
   */
  triage(id: string, input: BugTriageInput, adminId: string): BugReportInfo {
    const row = this.db.select().from(bugReports).where(eq(bugReports.id, id)).get();
    if (!row) throw ApiError.notFound('Report not found');

    this.db
      .update(bugReports)
      .set({
        status: input.status,
        reply: input.reply ?? row.reply,
        updatedAt: isoNow(),
      })
      .where(eq(bugReports.id, id))
      .run();

    const changed = row.status !== input.status || (input.reply ?? null) !== row.reply;
    if (changed && row.userId) {
      this.notifications.create({
        userId: row.userId,
        kind: 'bug-report',
        title: `${BUG_STATUS_LABELS[input.status]}: ${row.title}`,
        body: input.reply ?? null,
        link: 'settings/reports',
        actorId: adminId,
      });
    }

    return this.get(id, adminId, true);
  }

  /** How many are waiting, for the health page and the admin badge. */
  openCount(): number {
    return this.db
      .select()
      .from(bugReports)
      .where(and(eq(bugReports.status, 'open')))
      .all().length;
  }

  private toInfo(
    row: typeof bugReports.$inferSelect,
    viewerId: string,
    asAdmin: boolean,
  ): BugReportInfo {
    const title = row.gameId
      ? (this.db.select({ title: games.title }).from(games).where(eq(games.id, row.gameId)).get()
          ?.title ?? null)
      : null;

    return {
      id: row.id,
      title: row.title,
      body: row.body,
      severity: row.severity,
      status: row.status as BugStatus,
      reply: row.reply,
      gameId: row.gameId,
      gameTitle: title,
      clientVersion: row.clientVersion,
      platform: row.platform,
      // Diagnostics and who reported it are for the operator. A reporter has
      // no use for their own machine details echoed back, and no business
      // seeing anyone else's.
      diagnostics: asAdmin ? row.diagnostics : null,
      reporter: asAdmin && row.userId ? this.profiles.summarizeOne(row.userId, viewerId) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
