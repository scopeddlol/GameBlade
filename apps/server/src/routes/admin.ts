import {
  achievementDefinitionSchema,
  bulkAchievementDefinitionsSchema,
  bulkImportAchievementsSchema,
  announcementSchema,
  bugQuerySchema,
  bugTriageSchema,
  applyLaunchRulesSchema,
  applySaveSuggestionsSchema,
  launchRuleQuerySchema,
  createInviteSchema,
  clientButtonSchema,
  decideGameRequestSchema,
  gameRequestQuerySchema,
  createApiKeySchema,
  defaultLandingBlocks,
  landingPageSchema,
  createLibrarySchema,
  databaseMaintenanceSchema,
  deriveSaveTemplates,
  featuredArtworkSchema,
  featuredSchema,
  MAX_INSTALLER_BYTES,
  importAchievementsSchema,
  autoImportAchievementsSchema,
  providerSettingsSchema,
  purgeMissingSchema,
  createPasswordResetSchema,
  reorderClientButtonsSchema,
  reorderFeaturedSchema,
  scanRequestSchema,
  themeSettingsSchema,
  updateLibrarySchema,
  updateUserSchema,
  resolveTheme,
  type ClientInstallerInfo,
  type LandingBlock,
  type ThemePreset,
  type InviteInfo,
  type LaunchRuleRow,
  type LibraryInfo,
  type PublicUser,
  type ServerSettings,
  discordSettingsSchema,
  discordRoleSettingsSchema,
  discordReactionRoleSchema,
  discordAnnounceSchema,
  allowedMentions,
  extractMentions,
  pingLine,
  discordPresenceSchema,
  discordTicketSettingsSchema,
  MAX_DISCORD_ATTACHMENT_BYTES,
} from '@gameblade/shared';
import { and, asc, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { requireAdmin } from '../auth/middleware.js';
import type { DiscordUpload } from '../services/discord.js';
import type { MediaStore } from '../services/media.js';
import { toPublicUser } from '../auth/service.js';
import {
  discordReactionRoles,
  gameArchiveExecutables,
  gameAchievementRules,
  gameFiles,
  gameLaunchRules,
  gameSaveRules,
  games,
  invites,
  libraries,
  users,
} from '../db/schema.js';
import { maintain, type Db } from '../db/index.js';
import { ApiError } from '../lib/errors.js';
import { isLikelyGameExecutable, listZipExecutables, sortCandidates } from '../lib/executables.js';
import { newId, newInviteCode } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import { toLaunchRule } from './mappers.js';
import { matchCatalog } from '../services/saveManifest.js';

/**
 * A game with no usable launch rule.
 *
 * A row whose executable is null or empty is worse than no row at all — it
 * looks set from a distance and launches nothing — so both count as missing,
 * exactly as the catalog's own `launch-rule` gap filter already does.
 */
const GAMES_WITHOUT_LAUNCH_RULE: SQL = sql`NOT EXISTS (SELECT 1 FROM game_launch_rules r
      WHERE r.game_id = ${games.id} AND r.executable IS NOT NULL AND r.executable <> '')`;

/** How many executables one row offers before the list stops being a help. */
const MAX_LAUNCH_CANDIDATES = 12;

/**
 * Which executable to offer for a game, given what is in its folder.
 *
 * Name first, size second — the same order the desktop client's own detection
 * uses, so the suggestion here and the fallback there agree about what a game's
 * entry point is. Matching the title exactly beats being the biggest binary; a
 * game shipping a 400 MB launcher beside a 12 MB `Game.exe` is common enough
 * that size alone gets it wrong.
 */
function suggestExecutable(
  title: string,
  candidates: Array<{ path: string; sizeBytes: number }>,
): string | null {
  if (candidates.length === 0) return null;

  const normalise = (value: string) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const wanted = normalise(title);

  const named = candidates.find((candidate) => {
    const stem =
      candidate.path
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.exe$/i, '') ?? '';
    return normalise(stem) === wanted;
  });
  if (named) return named.path;

  // Shallower wins among equals: a game's entry point sits at the root far
  // more often than three folders down.
  const depth = (candidate: { path: string }) => candidate.path.split(/[/\\]/).length;
  const shallowest = Math.min(...candidates.map(depth));
  const atTop = candidates.filter((candidate) => depth(candidate) === shallowest);

  // Already sorted largest first, so the head of either list is the answer.
  return (atTop[0] ?? candidates[0])?.path ?? null;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const {
    db,
    auth,
    settings,
    metadata,
    scanner,
    config,
    catalog,
    achievements,
    notifications,
    profiles,
    presence,
    images,
    installer,
    clientButtons,
    gameRequests,
    apiKeys,
    analytics,
    bandwidth,
    social,
    saveManifest,
    backups,
    health,
    checksums,
    bugs,
    discord,
    discordBot,
    media,
    sqlite,
  } = app.gameblade;

  app.addHook('onRequest', async (request) => {
    requireAdmin(request);
  });

  // ---- Users ----

  app.get('/admin/users', async () => {
    const rows = db.select().from(users).all();
    const body: PublicUser[] = rows.map(toPublicUser);
    return body;
  });

  app.patch('/admin/users/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = updateUserSchema.parse(request.body);
    const context = requireAdmin(request);

    const target = auth.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    // Guard against an administrator locking everyone out of the server.
    if (target.role === 'admin' && (input.role === 'user' || input.isActive === false)) {
      const adminCount =
        db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(eq(users.role, 'admin'))
          .get()?.count ?? 0;
      if (adminCount <= 1) {
        throw ApiError.conflict('This is the only administrator account');
      }
    }
    if (target.id === context.user.id && input.isActive === false) {
      throw ApiError.conflict('You cannot disable your own account');
    }

    if (input.password) {
      await auth.setPassword(id, input.password);
    }

    const patch: Record<string, unknown> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.email !== undefined) patch.email = input.email;
    if (input.monthlyQuotaMb !== undefined) patch.monthlyQuotaMb = input.monthlyQuotaMb;

    if (Object.keys(patch).length > 0) {
      db.update(users).set(patch).where(eq(users.id, id)).run();
    }
    // A disabled or demoted account must not keep an active session.
    if (input.isActive === false || input.role !== undefined) {
      auth.destroyAllSessions(id);
    }

    const updated = auth.findById(id);
    return updated ? toPublicUser(updated) : null;
  });

  /**
   * A single-use reset link for a player who cannot sign in.
   *
   * There is no mail server here, so the link is handed back for an admin to
   * pass on themselves — which is also why it is shown once and never stored
   * in a form anyone can read back.
   */
  app.post('/admin/users/:id/password-reset', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = createPasswordResetSchema.parse(request.body ?? {});

    const target = auth.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    const { token, expiresAt } = auth.createPasswordReset(
      id,
      context.user.id,
      input.expiresInHours,
    );
    return { token, expiresAt, path: `/reset-password?token=${encodeURIComponent(token)}` };
  });

  app.delete('/admin/users/:id', async (request) => {
    const { id } = request.params as { id: string };
    const context = requireAdmin(request);

    if (id === context.user.id) {
      throw ApiError.conflict('You cannot delete your own account');
    }
    const target = auth.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    if (target.role === 'admin') {
      const adminCount =
        db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(eq(users.role, 'admin'))
          .get()?.count ?? 0;
      if (adminCount <= 1) {
        throw ApiError.conflict('This is the only administrator account');
      }
    }

    db.delete(users).where(eq(users.id, id)).run();
    return { ok: true };
  });

  // ---- Invites ----

  app.get('/admin/invites', async () => {
    const rows = db
      .select({ invite: invites, createdByUsername: users.username })
      .from(invites)
      .leftJoin(users, eq(users.id, invites.createdBy))
      .all();

    const body: InviteInfo[] = rows.map(({ invite, createdByUsername }) => ({
      id: invite.id,
      code: invite.code,
      role: invite.role,
      note: invite.note,
      maxUses: invite.maxUses,
      uses: invite.uses,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      createdByUsername,
      isValid:
        !invite.revokedAt &&
        invite.uses < invite.maxUses &&
        (!invite.expiresAt || new Date(invite.expiresAt).getTime() > Date.now()),
    }));
    return body;
  });

  app.post('/admin/invites', async (request, reply) => {
    const context = requireAdmin(request);
    const input = createInviteSchema.parse(request.body);

    const invite = {
      id: newId('inv'),
      code: newInviteCode().replace(/-/g, ''),
      role: input.role,
      note: input.note ?? null,
      maxUses: input.maxUses,
      uses: 0,
      createdBy: context.user.id,
      createdAt: new Date().toISOString(),
      expiresAt:
        input.expiresInDays === null
          ? null
          : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
      revokedAt: null,
    };

    db.insert(invites).values(invite).run();
    return reply
      .code(201)
      .send({ ...invite, isValid: true, createdByUsername: context.user.username });
  });

  app.delete('/admin/invites/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.update(invites).set({ revokedAt: new Date().toISOString() }).where(eq(invites.id, id)).run();
    return { ok: true };
  });

  // ---- Libraries ----

  app.get('/admin/libraries', async () => {
    const rows = db.select().from(libraries).all();
    const stats = db
      .select({
        libraryId: games.libraryId,
        gameCount: sql<number>`count(*)`,
        totalBytes: sql<number>`coalesce(sum(${games.sizeBytes}), 0)`,
      })
      .from(games)
      .groupBy(games.libraryId)
      .all();

    const byLibrary = new Map(stats.map((s) => [s.libraryId, s]));

    const body: LibraryInfo[] = rows.map((library) => ({
      id: library.id,
      name: library.name,
      path: library.path,
      enabled: library.enabled,
      gameCount: byLibrary.get(library.id)?.gameCount ?? 0,
      totalBytes: byLibrary.get(library.id)?.totalBytes ?? 0,
      lastScanAt: library.lastScanAt,
      lastScanStatus: library.lastScanStatus,
    }));
    return body;
  });

  /**
   * Refuse anything that assumes this machine has the game files on it.
   *
   * A coordinator has no disk to scan and no folder to add. Both of those used
   * to be offered anyway, and one of them was destructive: a library row on a
   * coordinator is the label a node's catalog is filed under, so scanning it
   * walked a path that either does not exist or is empty — and an empty library
   * root reads as a library whose games have all been deleted, which flagged
   * the entire catalog its nodes had just reported as missing.
   *
   * The panel no longer shows either control on a coordinator. This is the same
   * rule enforced where it cannot be routed around, because a bookmark, an API
   * key or a stale tab is enough to reach a route the navigation has stopped
   * linking to.
   */
  function assertHasLocalFiles(what: string): void {
    if (config.servesLocalFiles) return;
    throw new ApiError(
      409,
      'no_local_files',
      `This is a coordinator: it holds no game files, so ${what}. Its libraries are ` +
        'created for its nodes when they enrol, and each node scans its own disk.',
    );
  }

  /**
   * Whether a library path has to exist on this machine.
   *
   * On a standalone server it does, and checking at creation is far better
   * than silently scanning nothing for a week. On a coordinator the question
   * never arises: creating one is refused above.
   */
  async function assertUsableLibraryPath(resolved: string): Promise<void> {
    if (!config.servesLocalFiles) return;

    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) {
      throw ApiError.badRequest(
        `"${resolved}" is not a readable directory inside the container. Check the volume mount.`,
      );
    }
  }

  app.post('/admin/libraries', async (request, reply) => {
    assertHasLocalFiles('there is nothing here to add a folder from');
    const input = createLibrarySchema.parse(request.body);
    const resolved = path.resolve(input.path);

    await assertUsableLibraryPath(resolved);

    const existing = db.select().from(libraries).where(eq(libraries.path, resolved)).get();
    if (existing) throw ApiError.conflict('That path is already a library');

    const library = {
      id: newId('lib'),
      name: input.name,
      path: resolved,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
      lastScanAt: null,
      lastScanStatus: null,
    };
    db.insert(libraries).values(library).run();
    return reply.code(201).send(library);
  });

  app.patch('/admin/libraries/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = updateLibrarySchema.parse(request.body);

    const existing = db.select().from(libraries).where(eq(libraries.id, id)).get();
    if (!existing) throw ApiError.notFound('Library not found');

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.path !== undefined) {
      const resolved = path.resolve(input.path);
      await assertUsableLibraryPath(resolved);
      patch.path = resolved;
    }

    if (Object.keys(patch).length > 0) {
      db.update(libraries).set(patch).where(eq(libraries.id, id)).run();
    }
    return db.select().from(libraries).where(eq(libraries.id, id)).get();
  });

  app.delete('/admin/libraries/:id', async (request) => {
    const { id } = request.params as { id: string };
    // Only the catalog rows are removed; the mounted files are never touched.
    db.delete(libraries).where(eq(libraries.id, id)).run();
    return { ok: true };
  });

  // ---- Scanning ----

  app.post('/admin/scan', async (request, reply) => {
    assertHasLocalFiles('there is nothing here to scan');
    const input = scanRequestSchema.parse(request.body ?? {});
    if (scanner.isRunning) {
      return reply.code(409).send({
        error: { code: 'scan_in_progress', message: 'A scan is already running' },
      });
    }

    // Fire and forget: the client polls progress rather than holding a request open.
    void scanner.scan(input);
    return reply.code(202).send({ started: true });
  });

  app.get('/admin/scan/progress', async () => scanner.getProgress());

  // ---- Database ----

  /**
   * Statistics, a checkpoint and — only when asked — a full rewrite.
   *
   * The first two run hourly on their own; this is the button for after a
   * large import, when waiting an hour for the planner to notice the catalog
   * has quadrupled is exactly the wrong thing to do. `vacuum` is opt-in
   * because it needs room for a second copy of the database on the same disk
   * and holds a write lock throughout — on a spinning disk holding a large
   * catalog that is minutes, not seconds, and it is the operator's call.
   */
  app.post('/admin/database/maintenance', async (request) => {
    const input = databaseMaintenanceSchema.parse(request.body ?? {});
    const started = Date.now();
    const result = maintain(sqlite, { vacuum: input.vacuum });
    return { ...result, tookMs: Date.now() - started };
  });

  /** What the database currently costs on disk, split by file. */
  app.get('/admin/database', async () => {
    const pageCount = Number(sqlite.pragma('page_count', { simple: true }) ?? 0);
    const pageSize = Number(sqlite.pragma('page_size', { simple: true }) ?? 0);
    const freePages = Number(sqlite.pragma('freelist_count', { simple: true }) ?? 0);

    return {
      sizeBytes: pageCount * pageSize,
      pageSize,
      // Space the file holds but is not using. A large share of it is what a
      // VACUUM would give back, and the only honest reason to run one.
      freeBytes: freePages * pageSize,
      journalMode: String(sqlite.pragma('journal_mode', { simple: true }) ?? ''),
    };
  });

  /**
   * Move the running scan past whatever it is stuck on.
   *
   * A single unreadable folder or a provider that will not answer used to mean
   * waiting the run out or restarting the server. 409 rather than a silent
   * success when nothing is running, so the panel can say why nothing happened.
   */
  app.post('/admin/scan/skip', async (_request, reply) => {
    if (!scanner.skipCurrent()) {
      return reply.code(409).send({
        error: { code: 'no_scan_running', message: 'No scan is running' },
      });
    }
    return { skipped: true };
  });

  /**
   * Stop the whole run.
   *
   * Skip is the wrong tool when the problem is the run rather than one title
   * in it — and until now restarting the container was the only other option.
   * What has already been indexed stays indexed; a cancelled scan is a partial
   * scan, and the next one picks up from there.
   */
  app.post('/admin/scan/cancel', async (_request, reply) => {
    if (!scanner.cancel()) {
      return reply.code(409).send({
        error: { code: 'no_scan_running', message: 'No scan is running' },
      });
    }
    return { canceling: true };
  });

  // ---- Removing catalog entries ----

  /**
   * Forget a game entirely.
   *
   * A scan only *flags* a vanished game, because an unmounted share must not
   * destroy hand-made metadata matches — but that leaves no way to clear out
   * something deleted on purpose. This is that way. Files on disk are never
   * touched; only the catalog row goes, and the foreign keys cascade it out
   * of libraries, playtime, achievements and the featured shelf.
   *
   * Deleting a game that is still on disk is refused unless forced: the next
   * scan would re-add it as a new row with none of its metadata, which almost
   * nobody means to do.
   */
  app.delete('/admin/games/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { force } = request.query as { force?: string };

    const game = db.select().from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    if (game.missingAt === null && force !== 'true') {
      throw new ApiError(
        409,
        'game_present',
        `"${game.title}" is still on disk, so a scan would add it straight back. Delete the files first, or pass force=true to remove the entry anyway.`,
      );
    }

    db.delete(games).where(eq(games.id, id)).run();
    return { ok: true, title: game.title };
  });

  /** Clear out everything a scan has flagged as gone from disk. */
  app.post('/admin/games/purge-missing', async (request) => {
    const { olderThanDays } = purgeMissingSchema.parse(request.body ?? {});
    return { removed: scanner.purgeMissing(olderThanDays) };
  });

  /**
   * .exe files found in a game's own files, so the launch rule's executable
   * field can be picked rather than hand-typed. A folder game's files were
   * already indexed by the last scan; an archive game's central directory is
   * read on demand instead, since only the archive itself — not its
   * contents — gets a `game_files` row.
   */
  app.get('/admin/games/:id/executables', async (request) => {
    const { id } = request.params as { id: string };
    const row = db
      .select({ game: games, libraryPath: libraries.path })
      .from(games)
      .innerJoin(libraries, eq(libraries.id, games.libraryId))
      .where(eq(games.id, id))
      .get();
    if (!row) throw ApiError.notFound('Game not found');

    if (row.game.kind === 'archive') {
      const reported = db
        .select({ path: gameArchiveExecutables.path, sizeBytes: gameArchiveExecutables.sizeBytes })
        .from(gameArchiveExecutables)
        .where(eq(gameArchiveExecutables.gameId, id))
        .all();
      if (reported.length > 0) {
        return {
          candidates: sortCandidates(
            reported.filter((entry) => isLikelyGameExecutable(entry.path)),
          ),
        };
      }

      const absolute = path.join(row.libraryPath, row.game.relPath);
      try {
        return { candidates: sortCandidates(await listZipExecutables(absolute)) };
      } catch (error) {
        request.log.warn({ err: error, gameId: id }, 'could not read archive for executables');
        return { candidates: [] };
      }
    }

    const files = db
      .select({ relPath: gameFiles.relPath, sizeBytes: gameFiles.sizeBytes })
      .from(gameFiles)
      .where(eq(gameFiles.gameId, id))
      .all();
    const candidates = files
      .filter((file) => isLikelyGameExecutable(file.relPath))
      .map((file) => ({ path: file.relPath, sizeBytes: file.sizeBytes }));
    return { candidates: sortCandidates(candidates) };
  });

  /**
   * The Launch Rules tab: every game, what it is set to run, and what it could.
   *
   * The candidates come back with the rows on purpose. Setting a launch rule
   * by hand means knowing what is inside the folder, and an operator doing a
   * hundred of them from memory will type paths that are subtly wrong — which
   * nobody discovers until a player presses Play. A folder game's files were
   * indexed by the last scan, so the whole page costs two queries.
   *
   * An archive is the exception: only the zip itself has a `game_files` row, so
   * listing its executables means opening it. Those rows come back flagged and
   * fetch their own candidates when the operator opens them.
   */
  app.get('/admin/launch-rules', async (request) => {
    const query = launchRuleQuerySchema.parse(request.query ?? {});

    const conditions: SQL[] = [isNull(games.missingAt)];
    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '')}%`;
      const match = or(like(games.title, term), like(games.searchTitle, term));
      if (match) conditions.push(match);
    }
    if (query.status === 'missing') conditions.push(GAMES_WITHOUT_LAUNCH_RULE);
    if (query.status === 'set') conditions.push(sql`NOT (${GAMES_WITHOUT_LAUNCH_RULE})`);

    const where = and(...conditions);

    const total =
      db
        .select({ n: sql<number>`count(*)` })
        .from(games)
        .where(where)
        .get()?.n ?? 0;

    const rows = db
      .select({ id: games.id, title: games.title, kind: games.kind })
      .from(games)
      .where(where)
      .orderBy(asc(games.sortTitle))
      .limit(query.limit)
      .offset(query.offset)
      .all();

    const ids = rows.map((row) => row.id);
    const rules = new Map(
      (ids.length === 0
        ? []
        : db.select().from(gameLaunchRules).where(inArray(gameLaunchRules.gameId, ids)).all()
      ).map((row) => [row.gameId, toLaunchRule(row)]),
    );

    // One query for every candidate on the page. `.exe` is filtered in SQL so
    // a folder game of ten thousand assets does not travel here to be thrown
    // away in JavaScript.
    const byGame = new Map<string, Array<{ path: string; sizeBytes: number }>>();
    if (ids.length > 0) {
      for (const file of db
        .select({
          gameId: gameFiles.gameId,
          relPath: gameFiles.relPath,
          sizeBytes: gameFiles.sizeBytes,
        })
        .from(gameFiles)
        .where(and(inArray(gameFiles.gameId, ids), like(gameFiles.relPath, '%.exe')))
        .all()) {
        if (!isLikelyGameExecutable(file.relPath)) continue;
        const list = byGame.get(file.gameId) ?? [];
        list.push({ path: file.relPath, sizeBytes: file.sizeBytes });
        byGame.set(file.gameId, list);
      }

      for (const candidate of db
        .select({
          gameId: gameArchiveExecutables.gameId,
          path: gameArchiveExecutables.path,
          sizeBytes: gameArchiveExecutables.sizeBytes,
        })
        .from(gameArchiveExecutables)
        .where(inArray(gameArchiveExecutables.gameId, ids))
        .all()) {
        if (!isLikelyGameExecutable(candidate.path)) continue;
        const list = byGame.get(candidate.gameId) ?? [];
        list.push({ path: candidate.path, sizeBytes: candidate.sizeBytes });
        byGame.set(candidate.gameId, list);
      }
    }

    const items: LaunchRuleRow[] = rows.map((row) => {
      const candidates = sortCandidates(byGame.get(row.id) ?? []).slice(0, MAX_LAUNCH_CANDIDATES);
      return {
        gameId: row.id,
        title: row.title,
        kind: row.kind,
        rule: rules.get(row.id) ?? null,
        candidates,
        suggestion: suggestExecutable(row.title, candidates),
        // A standalone server can inspect an old ZIP on demand. A Coordinator
        // has no archive to open; its Node will fill this list on the next
        // catalog report instead of sending the UI on an impossible request.
        needsArchiveScan:
          row.kind === 'archive' && candidates.length === 0 && config.servesLocalFiles,
      };
    });

    return { items, total, offset: query.offset, limit: query.limit };
  });

  /** Writes a page of launch rules in one go. */
  app.post('/admin/launch-rules/apply', async (request) => {
    const input = applyLaunchRulesSchema.parse(request.body);
    let applied = 0;
    let cleared = 0;

    db.transaction((tx) => {
      for (const entry of input.rules) {
        const game = tx
          .select({ id: games.id })
          .from(games)
          .where(eq(games.id, entry.gameId))
          .get();
        if (!game) continue;

        // One rule per game, as everywhere else: a save replaces rather than
        // adds, so the client is never left choosing between two.
        tx.delete(gameLaunchRules).where(eq(gameLaunchRules.gameId, entry.gameId)).run();

        // An empty executable means "no rule", not "run nothing".
        if (entry.executable === '') {
          cleared += 1;
          continue;
        }

        tx.insert(gameLaunchRules)
          .values({
            id: newId('lnr'),
            gameId: entry.gameId,
            executable: entry.executable,
            args: entry.args || null,
            workingDir: entry.workingDir || null,
            note: null,
            createdAt: isoNow(),
          })
          .run();
        applied += 1;
      }
    });

    return { applied, cleared };
  });

  app.post('/admin/scan/match-pending', async (request, reply) => {
    if (scanner.isRunning) {
      return reply.code(409).send({
        error: { code: 'scan_in_progress', message: 'A scan is already running' },
      });
    }
    void scanner.matchPending();
    return reply.code(202).send({ started: true });
  });

  // ---- Settings ----

  /** Secrets are never echoed back — only whether one is set. */
  function describeSettings(): ServerSettings {
    const current = settings.get();
    return {
      serverName: current.serverName,
      tagline: current.tagline,
      allowSelfRegistration: current.allowSelfRegistration,
      downloadUrl: current.downloadUrl,
      clientVersion: current.clientVersion,
      providers: metadata.status(),
      igdbClientId: current.igdbClientId,
      igdbClientSecretSet: Boolean(current.igdbClientSecret),
      steamGridDbKeySet: Boolean(current.steamGridDbKey),
      steamApiKeySet: Boolean(current.steamApiKey),
      downloadSpeedLimitKbps: current.downloadSpeedLimitKbps,
      monthlyQuotaMb: current.monthlyQuotaMb,
      meshEnabled: current.meshEnabled,
      installer: installer.info(),
    };
  }

  app.get('/admin/settings', async () => describeSettings());

  app.patch('/admin/settings', async (request) => {
    const input = providerSettingsSchema.parse(request.body);
    settings.update({
      ...(input.serverName !== undefined ? { serverName: input.serverName } : {}),
      ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
      ...(input.allowSelfRegistration !== undefined
        ? { allowSelfRegistration: input.allowSelfRegistration }
        : {}),
      // An empty string from a cleared form field means "unset", not "".
      ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl || null } : {}),
      ...(input.clientVersion !== undefined ? { clientVersion: input.clientVersion } : {}),
      ...(input.igdbClientId !== undefined ? { igdbClientId: input.igdbClientId } : {}),
      ...(input.igdbClientSecret !== undefined ? { igdbClientSecret: input.igdbClientSecret } : {}),
      ...(input.steamGridDbKey !== undefined ? { steamGridDbKey: input.steamGridDbKey } : {}),
      ...(input.steamApiKey !== undefined ? { steamApiKey: input.steamApiKey } : {}),
      ...(input.downloadSpeedLimitKbps !== undefined
        ? { downloadSpeedLimitKbps: input.downloadSpeedLimitKbps }
        : {}),
      ...(input.monthlyQuotaMb !== undefined ? { monthlyQuotaMb: input.monthlyQuotaMb } : {}),
      ...(input.meshEnabled !== undefined ? { meshEnabled: input.meshEnabled } : {}),
    });

    return describeSettings();
  });

  app.post('/admin/settings/test-providers', async () => metadata.checkHealth());

  // ---- The Windows client installer ----

  /**
   * Uploads the installer as a raw body, streamed to disk.
   *
   * The file name rides in the query string rather than the body because there
   * is no multipart parser here: a build is hundreds of megabytes, and
   * buffering one through a form parser to recover a single string would cost
   * the whole file in memory.
   */
  app.post(
    '/admin/client-installer',
    { bodyLimit: MAX_INSTALLER_BYTES },
    async (request, reply) => {
      const { fileName } = request.query as { fileName?: string };
      if (!fileName?.trim()) {
        throw ApiError.badRequest('Include the installer file name as ?fileName=');
      }

      const body: ClientInstallerInfo = await installer.store(
        {
          fileName,
          contentType: request.headers['content-type'] ?? 'application/octet-stream',
        },
        request.raw,
        MAX_INSTALLER_BYTES,
      );

      return reply.code(201).send(body);
    },
  );

  app.delete('/admin/client-installer', async () => {
    await installer.remove();
    return { ok: true };
  });

  // ---- Overview ----

  app.get('/admin/stats', async () => {
    const gameStats = db
      .select({
        total: sql<number>`count(*)`,
        totalBytes: sql<number>`coalesce(sum(${games.sizeBytes}), 0)`,
        matched: sql<number>`sum(case when ${games.matchStatus} in ('auto','manual') then 1 else 0 end)`,
        missing: sql<number>`sum(case when ${games.missingAt} is not null then 1 else 0 end)`,
      })
      .from(games)
      .get();

    const userCount =
      db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .get()?.count ?? 0;

    return {
      games: gameStats?.total ?? 0,
      totalBytes: gameStats?.totalBytes ?? 0,
      matched: gameStats?.matched ?? 0,
      missing: gameStats?.missing ?? 0,
      // What still needs a human: no launch executable, no save rule, no art.
      // The catalog page renders these as counts on its filter chips.
      gaps: catalog.gapCounts(),
      users: userCount,
      libraries:
        db
          .select({ count: sql<number>`count(*)` })
          .from(libraries)
          .get()?.count ?? 0,
      basePath: config.basePath,
      scan: scanner.getProgress(),
      online: presence.onlineCount(),
    };
  });

  // ---- Featured games (the Home carousel) ----

  app.get('/admin/featured', async (request) => {
    const context = requireAdmin(request);
    // Admins see inactive entries too, so a slot can be staged before going live.
    return catalog.listFeatured(context.user.id, false);
  });

  app.put('/admin/featured', async (request) => {
    const context = requireAdmin(request);
    const input = featuredSchema.parse(request.body);
    catalog.upsertFeatured(input);
    return catalog.listFeatured(context.user.id, false);
  });

  app.post('/admin/featured/reorder', async (request) => {
    const context = requireAdmin(request);
    const input = reorderFeaturedSchema.parse(request.body);
    catalog.reorderFeatured(input.ids);
    return catalog.listFeatured(context.user.id, false);
  });

  app.delete('/admin/featured/:id', async (request) => {
    const { id } = request.params as { id: string };
    catalog.removeFeatured(id);
    return { ok: true };
  });

  /**
   * Overrides the hero image behind one carousel slot, or clears the override
   * so the game's own hero art shows through again.
   */
  app.put('/admin/featured/:id/artwork', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = featuredArtworkSchema.parse(request.body);

    const imageId = input.url ? await images.cache(input.url, 'hero') : null;
    if (input.url && !imageId) {
      throw ApiError.badRequest('That image could not be downloaded. Check the URL and try again.');
    }

    catalog.setFeaturedArtwork(id, imageId);
    return catalog.listFeatured(context.user.id, false);
  });

  // ---- Look and feel ----

  app.get('/admin/theme', async () => {
    const current = settings.get();
    return {
      preset: current.themePreset as ThemePreset,
      accent: current.themeAccent,
      tokens: resolveTheme(current.themePreset as ThemePreset, current.themeAccent),
    };
  });

  app.put('/admin/theme', async (request) => {
    const input = themeSettingsSchema.parse(request.body);
    settings.update({ themePreset: input.preset, themeAccent: input.accent ?? null });
    return {
      preset: input.preset,
      accent: input.accent ?? null,
      tokens: resolveTheme(input.preset, input.accent ?? null),
    };
  });

  /** The landing page's blocks. Unset falls back to the built-in page. */
  app.get('/admin/landing', async () => {
    const stored = settings.get().landingBlocks;
    const parsed = landingPageSchema.safeParse({ blocks: stored });
    const blocks: LandingBlock[] = parsed.success ? parsed.data.blocks : defaultLandingBlocks();
    return { blocks, isCustomised: stored !== null && stored !== undefined };
  });

  app.put('/admin/landing', async (request) => {
    const input = landingPageSchema.parse(request.body);
    settings.update({ landingBlocks: input.blocks });
    return { blocks: input.blocks, isCustomised: true };
  });

  /** Throws the customised page away and goes back to the shipped one. */
  app.post('/admin/landing/reset', async () => {
    settings.clear('landingBlocks');
    return { blocks: defaultLandingBlocks(), isCustomised: false };
  });

  // ---- Analytics ----

  /**
   * Everything the analytics page renders, in one request. The page shows six
   * panels; six endpoints would each pay their own round trip for data that all
   * comes out of the same two tables.
   */
  app.get('/admin/analytics', async (request) => {
    const { days } = request.query as { days?: string };
    const parsed = Number(days);
    const rangeDays = Number.isFinite(parsed) ? Math.min(365, Math.max(1, Math.floor(parsed))) : 30;
    return analytics.report(rangeDays);
  });

  /** One account's month-to-date transfer against its allowance. */
  app.get('/admin/users/:id/quota', async (request) => {
    const { id } = request.params as { id: string };
    return bandwidth.status(id);
  });

  // ---- API keys for the external API ----

  app.get('/admin/api-keys', async () => apiKeys.list());

  /**
   * Mints a key. The plaintext token comes back here and nowhere else, so the
   * UI has to show it once and tell the operator to store it.
   */
  app.post('/admin/api-keys', async (request, reply) => {
    const context = requireAdmin(request);
    const input = createApiKeySchema.parse(request.body);
    return reply.code(201).send(apiKeys.create(input, context.user.id));
  });

  /** Revoking keeps the row, so the audit trail of what existed survives. */
  app.post('/admin/api-keys/:id/revoke', async (request) => {
    const { id } = request.params as { id: string };
    apiKeys.revoke(id);
    return { ok: true };
  });

  app.delete('/admin/api-keys/:id', async (request) => {
    const { id } = request.params as { id: string };
    apiKeys.remove(id);
    return { ok: true };
  });

  // ---- Custom buttons in the desktop client ----

  /**
   * Operator-defined links the desktop client renders. Admins see inactive
   * rows too, so a button can be staged before it goes live.
   */
  app.get('/admin/client-buttons', async () => clientButtons.listAll());

  app.post('/admin/client-buttons', async (request, reply) => {
    const input = clientButtonSchema.parse(request.body);
    return reply.code(201).send(clientButtons.create(input));
  });

  app.put('/admin/client-buttons/:id', async (request) => {
    const { id } = request.params as { id: string };
    return clientButtons.update(id, clientButtonSchema.parse(request.body));
  });

  app.delete('/admin/client-buttons/:id', async (request) => {
    const { id } = request.params as { id: string };
    clientButtons.remove(id);
    return { ok: true };
  });

  app.post('/admin/client-buttons/reorder', async (request) => {
    const input = reorderClientButtonsSchema.parse(request.body);
    clientButtons.reorder(input.ids);
    return clientButtons.listAll();
  });

  // ---- Achievement definitions ----

  app.get('/admin/games/:id/achievements', async (request) => {
    const { id } = request.params as { id: string };
    return achievements.definitionsForGame(id);
  });

  app.put('/admin/games/:id/achievements', async (request) => {
    const { id } = request.params as { id: string };
    const input = achievementDefinitionSchema.parse(request.body);

    const game = db.select({ id: games.id }).from(games).where(eq(games.id, id)).get();
    if (!game) throw ApiError.notFound('Game not found');

    return achievements.upsertDefinition(id, input);
  });

  app.delete('/admin/games/:id/achievements/:achievementId', async (request) => {
    const { id, achievementId } = request.params as { id: string; achievementId: string };
    achievements.deleteDefinition(id, achievementId);
    return { ok: true };
  });

  /**
   * Pulls a game's achievement list from Steam's public schema endpoint. This
   * reads published game metadata only — no player data, no account linking —
   * which is what makes it usable for a DRM-free copy of a game that also
   * happens to ship on Steam.
   */
  app.post('/admin/games/:id/achievements/import', async (request) => {
    const { id } = request.params as { id: string };
    const input = importAchievementsSchema.parse(request.body);
    return achievements.importFromSteam(id, input.steamAppId, input.replace);
  });

  /** Finds the Steam AppID from the catalog title, then imports its achievement schema. */
  app.post('/admin/games/:id/achievements/auto-import', async (request) => {
    const { id } = request.params as { id: string };
    const input = autoImportAchievementsSchema.parse(request.body ?? {});
    return achievements.autoImportFromSteam(id, input.replace);
  });

  /**
   * Many definitions written to one game at once, from a pasted list.
   *
   * The single-definition PUT above is right for a correction and hopeless for
   * a game that ships two hundred achievements Steam has never heard of — a
   * fan translation, something itch-only, a title whose Steam entry predates
   * its achievements. Parsing the paste is the client's job; this takes the
   * rows it produced.
   */
  app.post('/admin/games/:id/achievements/bulk', async (request) => {
    const { id } = request.params as { id: string };
    const input = bulkAchievementDefinitionsSchema.parse(request.body);
    return achievements.bulkUpsertDefinitions(id, input.achievements, input.replace);
  });

  /**
   * One slice of a bulk import across the catalog.
   *
   * Deliberately not "import everything" in a single request. Each game is two
   * or three round trips to Steam, so a whole-catalog request would hold a
   * connection open for minutes, report nothing until it ended, and lose the
   * lot if anything dropped. The client walks the list in small batches
   * instead, which is also what gives it a progress bar and a Stop button.
   *
   * Nothing here throws for one game's sake: a title Steam cannot place, or
   * places ambiguously, or has no achievements for, is ordinary across a real
   * catalog and is reported per row.
   */
  app.post('/admin/achievements/bulk-import', async (request) => {
    const input = bulkImportAchievementsSchema.parse(request.body);
    const results = await achievements.bulkImportFromSteam(input.gameIds, {
      replace: input.replace,
      generateRules: input.generateRules,
      skipExisting: input.skipExisting,
    });
    return { results };
  });

  // ---- Bug reports ----

  app.get('/admin/bugs', async (request) => {
    const context = requireAdmin(request);
    return bugs.list(bugQuerySchema.parse(request.query), context.user.id);
  });

  /**
   * Answering a report.
   *
   * The reply and the status both reach the reporter as a notification. That
   * is the part that keeps reports coming: someone who never hears back
   * concludes that reporting does nothing.
   */
  app.put('/admin/bugs/:id', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    return bugs.triage(id, bugTriageSchema.parse(request.body), context.user.id);
  });

  // ---- Health ----

  /**
   * What needs attention right now, as opposed to what happened.
   *
   * Everything here is derived from rows already being written, so there is no
   * second source of truth to drift from the thing it describes.
   */
  app.get('/admin/health', async () => health.report());

  /**
   * Re-hashes a game's files and records whether each still matches.
   *
   * Only files that were hashed once already have anything to compare against;
   * the rest are left alone. Findings surface on the health page.
   */
  app.post('/admin/games/:id/verify', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (checksums.isRunning) {
      throw ApiError.conflict('A checksum run is already in progress');
    }
    void checksums.start(id, { verify: true });
    return reply.code(202).send({ started: true });
  });

  app.get('/admin/verify/progress', async () => checksums.getProgress());

  // ---- Backups ----

  /**
   * Archives of everything in the data directory that cannot be recreated.
   *
   * The library itself is not in them: it is enormous, an operator already has
   * it, and a scan rebuilds every catalog row from it. What is in them is the
   * database, every player's cloud saves, uploaded media and the published
   * installer — none of which exists anywhere else.
   */
  app.get('/admin/backups', async () => {
    const current = settings.get();
    return {
      backups: await backups.list(),
      settings: {
        keep: current.backupKeep,
        everyHours: current.backupEveryHours,
        includeImages: current.backupIncludeImages,
      },
    };
  });

  app.post('/admin/backups', async (request, reply) => {
    const current = settings.get();
    const info = await backups.create({
      keep: current.backupKeep,
      everyHours: current.backupEveryHours,
      includeImages: current.backupIncludeImages,
    });
    return reply.code(201).send(info);
  });

  app.get('/admin/backups/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const target = backups.pathFor(name);
    if (!target) throw ApiError.badRequest('That is not a backup name');

    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw ApiError.notFound('Backup not found');

    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', String(info.size))
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(createReadStream(target));
  });

  app.delete('/admin/backups/:name', async (request) => {
    const { name } = request.params as { name: string };
    if (!(await backups.remove(name))) throw ApiError.badRequest('That is not a backup name');
    return { ok: true };
  });

  // ---- Save-path suggestions ----

  /**
   * Where saves live, for tens of thousands of games.
   *
   * The alternative is an operator playing every title to find out where it
   * wrote, which is the job this replaces. Suggestions are never applied on
   * their own: a title match across 11,000 games is occasionally confident and
   * wrong, and these paths are where the client will later read and write a
   * player's saves.
   */
  /* -------------------------------------------------------------- Discord */

  /**
   * What the operator has configured, with the secrets write-only.
   *
   * Same shape as the rest of settings: the server says whether a secret is
   * set, never what it is, so a token cannot be read back out of the panel.
   */
  app.get('/admin/discord', async () => {
    const s = settings.get();
    return {
      clientId: s.discordClientId,
      clientSecretSet: Boolean(s.discordClientSecret),
      botTokenSet: Boolean(s.discordBotToken),
      guildId: s.discordGuildId,
      inviteUrl: s.discordInviteUrl,
      channelId: s.discordChannelId,
      publicUrl: s.discordPublicUrl,
      announceNewGames: s.discordAnnounceNewGames,
      announceRequests: s.discordAnnounceRequests,
      requireGuild: s.discordRequireGuild,
      linkedAccounts: discord.linkedCount(),

      bot: discordBot.status,
      presence: {
        status: s.discordPresenceStatus,
        activityType: s.discordActivityType,
        activityName: s.discordActivityName ?? '',
        preview: discordBot.activityPreview(),
      },
      tickets: {
        enabled: s.discordTicketsEnabled,
        supportChannelId: s.discordSupportChannelId,
        categoryId: s.discordTicketCategoryId,
        staffRoleId: s.discordStaffRoleId,
        panelTitle: s.discordTicketPanelTitle ?? '',
        panelMessage: s.discordTicketPanelMessage ?? '',
        counts: discordBot.ticketCounts(),
      },
    };
  });

  app.patch('/admin/discord', async (request) => {
    const input = discordSettingsSchema.parse(request.body);

    // Turning announcements on starts the clock now rather than announcing the
    // entire back catalogue; turning them off leaves the watermark alone so a
    // brief pause does not replay everything since.
    const wasOn = settings.get().discordAnnounceNewGames;
    settings.update({
      ...(input.clientId !== undefined ? { discordClientId: input.clientId || null } : {}),
      ...(input.clientSecret ? { discordClientSecret: input.clientSecret } : {}),
      ...(input.botToken ? { discordBotToken: input.botToken } : {}),
      ...(input.guildId !== undefined ? { discordGuildId: input.guildId || null } : {}),
      ...(input.inviteUrl !== undefined ? { discordInviteUrl: input.inviteUrl || null } : {}),
      ...(input.channelId !== undefined ? { discordChannelId: input.channelId || null } : {}),
      ...(input.publicUrl !== undefined ? { discordPublicUrl: input.publicUrl || null } : {}),
      ...(input.announceNewGames !== undefined
        ? { discordAnnounceNewGames: input.announceNewGames }
        : {}),
      ...(input.announceRequests !== undefined
        ? { discordAnnounceRequests: input.announceRequests }
        : {}),
      ...(input.requireGuild !== undefined ? { discordRequireGuild: input.requireGuild } : {}),
    });

    if (!wasOn && input.announceNewGames) {
      settings.update({ discordLastAnnouncedAt: new Date().toISOString() });
    }
    // A token is write-only in settings, so validate a replacement now instead
    // of waiting for the next scheduled announcement to expose a bad token.
    const bot = input.botToken ? await discord.startBot() : null;
    return { ok: true, bot };
  });

  /* ---------------------------------------------------------------- roles */

  app.get('/admin/discord/roles', async (request) => {
    requireAdmin(request);
    const s = settings.get();
    return {
      autoRoleId: s.discordAutoRoleId ?? '',
      reactionRolesEnabled: s.discordReactionRolesEnabled,
      bindings: db
        .select()
        .from(discordReactionRoles)
        .orderBy(desc(discordReactionRoles.createdAt))
        .all(),
    };
  });

  /**
   * Turning either feature on changes which gateway events the bot needs, and
   * intents are only read when the connection identifies — so the bot is
   * reconnected rather than left listening for events it never asked for.
   */
  app.patch('/admin/discord/roles', async (request) => {
    requireAdmin(request);
    const input = discordRoleSettingsSchema.parse(request.body);

    settings.update({
      ...(input.autoRoleId !== undefined ? { discordAutoRoleId: input.autoRoleId || null } : {}),
      ...(input.reactionRolesEnabled !== undefined
        ? { discordReactionRolesEnabled: input.reactionRolesEnabled }
        : {}),
    });
    discordBot.reconnectIfIntentsChanged();

    const s = settings.get();
    return {
      autoRoleId: s.discordAutoRoleId ?? '',
      reactionRolesEnabled: s.discordReactionRolesEnabled,
      // Auto-roles need a privileged intent, and the one thing an operator
      // reliably forgets is enabling it in the developer portal.
      needsMembersIntent: Boolean(s.discordAutoRoleId?.trim()),
    };
  });

  app.post('/admin/discord/roles/reactions', async (request) => {
    requireAdmin(request);
    const input = discordReactionRoleSchema.parse(request.body);

    const guildId = settings.get().discordGuildId?.trim();
    if (!guildId) throw ApiError.badRequest('Set the Discord server ID first');

    // One role per emoji per message: binding the same emoji twice would make
    // which role a press grants depend on row order.
    const clash = db
      .select({ id: discordReactionRoles.id })
      .from(discordReactionRoles)
      .where(
        and(
          eq(discordReactionRoles.messageId, input.messageId),
          eq(discordReactionRoles.emoji, input.emoji),
        ),
      )
      .get();
    if (clash) throw ApiError.conflict('That emoji is already bound on that message');

    const row = {
      id: newId('drr'),
      guildId,
      channelId: input.channelId,
      messageId: input.messageId,
      emoji: input.emoji,
      roleId: input.roleId,
      note: input.note ?? null,
      createdAt: isoNow(),
    };
    db.insert(discordReactionRoles).values(row).run();

    // Put the emoji on the message so players have something to click. A
    // failure here is worth reporting but not worth losing the binding over —
    // somebody can always react first.
    const reacted = await discord
      .addReaction(input.channelId, input.messageId, input.emoji)
      .then(() => true)
      .catch(() => false);

    return { binding: row, reacted };
  });

  app.delete('/admin/discord/roles/reactions/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };

    const result = db.delete(discordReactionRoles).where(eq(discordReactionRoles.id, id)).run();
    if (result.changes === 0) throw ApiError.notFound('That binding no longer exists');
    return { deleted: true };
  });

  /** Clearing a secret needs to be possible without a way to read it back. */
  app.delete('/admin/discord/secret/:which', async (request) => {
    const { which } = request.params as { which: string };
    if (which === 'clientSecret') settings.update({ discordClientSecret: null });
    else if (which === 'botToken') settings.update({ discordBotToken: null });
    else throw ApiError.badRequest('Unknown secret');
    return { ok: true };
  });

  /**
   * Walks every step between a stored token and a message arriving.
   *
   * A token that is merely stored tells you nothing, and neither does one that
   * merely authenticates: the usual reasons nothing is posted are a bot that
   * was never invited, a channel ID from the wrong place, and a missing Send
   * Messages permission. Each is reported separately, so the answer names the
   * step to fix instead of saying it did not work.
   */
  app.post('/admin/discord/test', async () => {
    const result = await discord.diagnose();
    return { ok: result.checks.every((check) => check.ok), ...result };
  });

  /* ----------------------------------------------------------- the bot */

  /**
   * Brings the gateway connection up, which is what makes the bot *online*.
   *
   * Distinct from having a token: a token lets the server post, and posting is
   * something a webhook could do. Being in the member list, answering a slash
   * command and reacting to a button all need a live connection, and that is
   * what this switch is.
   */
  app.post('/admin/discord/bot/start', async () => {
    discordBot.start();
    return { ok: true, bot: discordBot.status };
  });

  app.post('/admin/discord/bot/stop', async () => {
    discordBot.stop();
    return { ok: true, bot: discordBot.status };
  });

  /** How the bot presents itself: the dot, and the line under its name. */
  app.patch('/admin/discord/bot/presence', async (request) => {
    const input = discordPresenceSchema.parse(request.body ?? {});
    settings.update({
      ...(input.status !== undefined ? { discordPresenceStatus: input.status } : {}),
      ...(input.activityType !== undefined ? { discordActivityType: input.activityType } : {}),
      ...(input.activityName !== undefined
        ? { discordActivityName: input.activityName || null }
        : {}),
    });
    // Pushed over the open socket rather than by reconnecting: a reconnect
    // would take the bot offline and back for what is a cosmetic edit.
    discordBot.applyPresence();
    return { ok: true, preview: discordBot.activityPreview(), bot: discordBot.status };
  });

  /**
   * The guild's channels and roles, so the pickers are pickers.
   *
   * Every id on this page used to be a text box expecting a snowflake copied
   * out of a right-click menu, with no feedback until something failed to post.
   */
  /**
   * People the panel can offer as mention targets.
   *
   * Accounts linked here come from this server's own records; guild members
   * come from Discord and only when the privileged Members intent is on. The
   * service merges the two, so the picker works either way.
   */
  app.get('/admin/discord/members', async () => ({ members: await discord.listMembers() }));

  app.get('/admin/discord/channels', async () => {
    const [channels, roles] = await Promise.all([discord.listChannels(), discord.listRoles()]);
    return { channels, roles };
  });

  /* --------------------------------------------------------- attachments */

  /**
   * Takes the image for a post, before the post itself is sent.
   *
   * Two steps rather than one multipart request because everything else in
   * this panel speaks JSON, and because the upload is the slow part: it can
   * finish, and be previewed, while the operator is still writing the message.
   * The bytes go to the ordinary media store, so the size and type checks are
   * the same ones every other upload gets.
   */
  app.post(
    '/admin/discord/attachment',
    { bodyLimit: MAX_DISCORD_ATTACHMENT_BYTES },
    async (request, reply) => {
      const context = requireAdmin(request);
      const contentType = request.headers['content-type'];
      if (!contentType) throw ApiError.badRequest('A Content-Type header is required');

      const declared = Number(request.headers['content-length'] ?? 0);
      const info = await media.store(
        context.user.id,
        {
          kind: 'image',
          contentType,
          sizeBytes: Number.isFinite(declared) && declared > 0 ? declared : 1,
        },
        request.raw,
        MAX_DISCORD_ATTACHMENT_BYTES,
      );
      return reply.code(201).send(info);
    },
  );

  /* -------------------------------------------------------------- tickets */

  app.get('/admin/discord/tickets', async (request) => {
    const { status } = request.query as { status?: string };
    return { tickets: discordBot.listTickets(status), counts: discordBot.ticketCounts() };
  });

  /**
   * Close a ticket and drop the record of it.
   *
   * The in-Discord close button keeps the row on purpose, so there is still an
   * account of who asked for what. This is for the ones an operator wants gone
   * outright — spam, duplicates, anything long since dealt with.
   */
  app.delete('/admin/discord/tickets/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };

    if (!(await discordBot.deleteTicket(id))) {
      throw ApiError.notFound('That ticket no longer exists');
    }
    return reply.code(200).send({ deleted: true });
  });

  app.patch('/admin/discord/tickets/settings', async (request) => {
    const input = discordTicketSettingsSchema.parse(request.body ?? {});
    settings.update({
      ...(input.enabled !== undefined ? { discordTicketsEnabled: input.enabled } : {}),
      ...(input.supportChannelId !== undefined
        ? { discordSupportChannelId: input.supportChannelId || null }
        : {}),
      ...(input.categoryId !== undefined
        ? { discordTicketCategoryId: input.categoryId || null }
        : {}),
      ...(input.staffRoleId !== undefined ? { discordStaffRoleId: input.staffRoleId || null } : {}),
      ...(input.panelTitle !== undefined
        ? { discordTicketPanelTitle: input.panelTitle || null }
        : {}),
      ...(input.panelMessage !== undefined
        ? { discordTicketPanelMessage: input.panelMessage || null }
        : {}),
    });
    return { ok: true };
  });

  /** Posts the panel with the button people press. */
  app.post('/admin/discord/tickets/panel', async () => {
    if (!settings.get().discordTicketsEnabled) {
      throw ApiError.badRequest('Turn tickets on first, or the button will refuse every press');
    }
    const result = await discordBot.publishPanel();
    return { ok: true, ...result };
  });

  /**
   * Posts whatever the operator typed, wherever they chose.
   *
   * An attached image is sent as a real Discord attachment rather than as a
   * URL in the embed: the media route needs authentication, so a link to it
   * would give Discord a 401, and opening the whole media store to the world
   * to avoid that is not a trade worth making for an announcement.
   */
  app.post('/admin/discord/announce', async (request) => {
    const input = discordAnnounceSchema.parse(request.body);
    if (!input.message && !input.imageMediaId) {
      throw ApiError.badRequest('Write something, or attach an image');
    }

    const file = input.imageMediaId ? await readMedia(media, input.imageMediaId) : undefined;

    // The permission list is built here rather than left to Discord's default,
    // which is "notify anything that looks like a mention". Naming the exact
    // ids the operator typed is what separates a deliberate tag from a string
    // that merely resembles one.
    const mentions = extractMentions(input.title, input.message);
    const allowed = allowedMentions(mentions, { allowEveryone: input.allowEveryone });

    if (input.asEmbed) {
      // Discord will not notify for anything inside an embed, whatever the
      // token looks like — a role pill in a description reaches nobody. The
      // fix, and the only one there is, is to repeat the mentions in the
      // content that carries the embed.
      const ping = input.pingMentions
        ? pingLine(mentions, { allowEveryone: input.allowEveryone })
        : null;

      await discord.postMessage(
        {
          content: ping ?? undefined,
          embeds: [
            {
              title: input.title || undefined,
              description: input.message || undefined,
              color: 0x7c5cff,
              // `attachment://` is how an embed refers to a file travelling in
              // the same request.
              image: file ? { url: `attachment://${file.fileName}` } : undefined,
            },
          ],
          allowed_mentions: allowed,
        },
        { channelId: input.channelId, file },
      );
    } else {
      const content = input.title ? `**${input.title}**\n${input.message}` : input.message;
      await discord.postMessage(
        { content: content || undefined, allowed_mentions: allowed },
        {
          channelId: input.channelId,
          file,
        },
      );
    }

    // Discord has its own copy now, and this one is referenced by nothing —
    // no post, no profile — so leaving it would grow the media store by an
    // image per announcement for ever, against the admin's own quota.
    // Deliberately after the post and deliberately not fatal: an announcement
    // that went out and then failed to tidy up is a housekeeping problem, not
    // a failed announcement.
    if (input.imageMediaId) {
      const context = requireAdmin(request);
      await media
        .delete(context.user.id, input.imageMediaId)
        .catch((error: unknown) =>
          app.log.warn({ err: error }, 'could not clean up a posted Discord attachment'),
        );
    }

    return { ok: true };
  });

  /** Runs the new-game announcer now, rather than waiting for the schedule. */
  app.post('/admin/discord/announce-new-games', async () => {
    const posted = await discord.announceNewGames();
    return { posted };
  });

  app.get('/admin/save-manifest', async () => saveManifest.status());

  app.post('/admin/save-manifest/refresh', async () => saveManifest.refresh());

  app.get('/admin/save-manifest/suggestions', async () => {
    const entries = await saveManifest.load();
    if (entries.length === 0) {
      return { suggestions: [], needsRefresh: true };
    }

    const withRules = new Set(
      db
        .select({ gameId: gameSaveRules.gameId })
        .from(gameSaveRules)
        .all()
        .map((r) => r.gameId),
    );

    const catalog = db
      .select({ id: games.id, title: games.title })
      .from(games)
      .where(isNull(games.missingAt))
      .all()
      .map((game) => ({ ...game, hasRule: withRules.has(game.id) }));

    return { suggestions: matchCatalog(catalog, entries), needsRefresh: false };
  });

  /**
   * Writes the confirmed suggestions as save rules.
   *
   * Each entry names the path the operator picked rather than the server
   * choosing again, so what is stored is what they saw on screen.
   */
  app.post('/admin/save-manifest/apply', async (request) => {
    const input = applySaveSuggestionsSchema.parse(request.body);
    let applied = 0;

    db.transaction((tx) => {
      for (const entry of input.rules) {
        const game = tx
          .select({ id: games.id })
          .from(games)
          .where(eq(games.id, entry.gameId))
          .get();
        if (!game) continue;

        // One rule per game, as elsewhere: a save replaces rather than adds.
        tx.delete(gameSaveRules).where(eq(gameSaveRules.gameId, entry.gameId)).run();
        tx.insert(gameSaveRules)
          .values({
            id: newId('svr'),
            gameId: entry.gameId,
            pathTemplate: entry.pathTemplate,
            include: entry.include ?? null,
            exclude: null,
            note: 'From the save-path manifest',
            createdAt: isoNow(),
          })
          .run();
        applied += 1;
      }
    });

    return { applied };
  });

  /**
   * Games whose achievements are being read out of a folder nobody is syncing.
   *
   * An unlock rule reads a file the game wrote into its own save directory —
   * a Goldberg `achievements.json`, an emulator's progress log, a stats file
   * next to the slots. So a game with unlock rules and no save rule is not a
   * game whose save location is unknown: it is one whose save location was
   * written down in the wrong column, and whose players will lose their
   * achievements along with their saves the first time they move machine.
   *
   * The manifest suggester next door cannot help with these — it only knows
   * titles it recognises, and this catalog's unmatched folder names are most
   * of what it does not.
   */
  app.get('/admin/save-rules/gaps', async () => {
    const withSaveRule = new Set(
      db
        .select({ gameId: gameSaveRules.gameId })
        .from(gameSaveRules)
        .all()
        .map((row) => row.gameId),
    );

    const rules = db
      .select({
        gameId: gameAchievementRules.gameId,
        sourceTemplate: gameAchievementRules.sourceTemplate,
        achievementKey: gameAchievementRules.achievementKey,
      })
      .from(gameAchievementRules)
      .all();

    const sourcesByGame = new Map<string, string[]>();
    const keysByGame = new Map<string, Set<string>>();
    for (const rule of rules) {
      if (withSaveRule.has(rule.gameId)) continue;
      const list = sourcesByGame.get(rule.gameId) ?? [];
      list.push(rule.sourceTemplate);
      sourcesByGame.set(rule.gameId, list);

      const keys = keysByGame.get(rule.gameId) ?? new Set<string>();
      keys.add(rule.achievementKey);
      keysByGame.set(rule.gameId, keys);
    }

    if (sourcesByGame.size === 0) {
      return { gaps: [], gamesWithoutSaveRule: countGamesWithoutSaveRule(db, withSaveRule) };
    }

    const titles = new Map(
      db
        .select({ id: games.id, title: games.title })
        .from(games)
        .where(inArray(games.id, [...sourcesByGame.keys()]))
        .all()
        .map((row) => [row.id, row.title] as const),
    );

    const gaps = [...sourcesByGame.entries()]
      .map(([gameId, sources]) => ({
        gameId,
        title: titles.get(gameId) ?? gameId,
        achievementCount: keysByGame.get(gameId)?.size ?? 0,
        candidates: deriveSaveTemplates(sources),
      }))
      // A game whose rules all read bare filenames yields nothing to propose,
      // and offering a row with no action on it is just noise.
      .filter((gap) => gap.candidates.length > 0 && titles.has(gap.gameId))
      .sort((a, b) => a.title.localeCompare(b.title));

    return { gaps, gamesWithoutSaveRule: countGamesWithoutSaveRule(db, withSaveRule) };
  });

  /** Writes the chosen folders as save rules. */
  app.post('/admin/save-rules/from-achievements', async (request) => {
    const input = applySaveSuggestionsSchema.parse(request.body);
    let applied = 0;

    db.transaction((tx) => {
      for (const entry of input.rules) {
        const game = tx
          .select({ id: games.id })
          .from(games)
          .where(eq(games.id, entry.gameId))
          .get();
        if (!game) continue;

        // Deliberately does not overwrite: this list is built from games with
        // no rule, so a row that has gained one since the page loaded has been
        // settled by somebody and should not be quietly replaced.
        const existing = tx
          .select({ id: gameSaveRules.id })
          .from(gameSaveRules)
          .where(eq(gameSaveRules.gameId, entry.gameId))
          .get();
        if (existing) continue;

        tx.insert(gameSaveRules)
          .values({
            id: newId('svr'),
            gameId: entry.gameId,
            pathTemplate: entry.pathTemplate,
            include: entry.include ?? null,
            exclude: null,
            note: "Derived from this game's achievement rules",
            createdAt: isoNow(),
          })
          .run();
        applied += 1;
      }
    });

    return { applied };
  });

  // ---- Announcements ----

  app.post('/admin/announcements', async (request) => {
    const context = requireAdmin(request);
    const input = announcementSchema.parse(request.body);

    // An empty target list means everyone with an active account.
    const targets =
      input.userIds.length > 0
        ? input.userIds
        : db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.isActive, true))
            .all()
            .map((r) => r.id);

    const sent = notifications.createMany(targets, {
      kind: 'announcement',
      title: input.title,
      body: input.body ?? null,
      icon: input.icon ?? null,
      actorId: context.user.id,
    });

    // A notification is read once and gone. Publishing keeps the announcement
    // somewhere people can come back to and reply to — never for one aimed at
    // named accounts, which is a message rather than a notice.
    const post =
      input.publish && input.userIds.length === 0
        ? social.publishAnnouncement(context.user.id, {
            title: input.title,
            body: input.body ?? null,
          })
        : null;

    return { sent, postId: post?.id ?? null };
  });

  // ---- Game requests ----

  /**
   * The operator's view of the request queue.
   *
   * Unlike the player-facing list this names who asked, which is what makes a
   * duplicate-looking pair of requests resolvable.
   */
  app.get('/admin/requests', async (request) => {
    const context = requireAdmin(request);
    const query = gameRequestQuerySchema.parse(request.query);
    return {
      items: gameRequests.list(query, context.user.id, true),
      counts: gameRequests.counts(),
    };
  });

  app.patch('/admin/requests/:id', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = decideGameRequestSchema.parse(request.body);

    // A request marked as added should point at something real; a stale id
    // would render as a dead "open it" link in every client.
    if (input.gameId) {
      const game = db.select({ id: games.id }).from(games).where(eq(games.id, input.gameId)).get();
      if (!game) throw ApiError.badRequest('That game is not in the catalog');
    }

    const decided = gameRequests.decide(context.user.id, id, input);

    // Telling the Discord that something people asked for has landed is the
    // most useful thing the bot does. Fire-and-forget: a Discord outage must
    // not fail the decision, which has already been recorded.
    if (input.status === 'added' && settings.get().discordAnnounceRequests) {
      void discord
        .post(`**${decided.title}** was requested and has just been added.`)
        .catch((error: unknown) =>
          request.log.warn({ err: error }, 'could not announce a granted request'),
        );
    }

    return decided;
  });

  app.delete('/admin/requests/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    gameRequests.remove(id);
    return { ok: true };
  });

  /** Profile moderation: an admin can reset a display name or hide a profile. */
  app.get('/admin/profiles/:id', async (request) => {
    const context = requireAdmin(request);
    const { id } = request.params as { id: string };
    return profiles.detail(id, context.user.id);
  });
}

/**
 * Reads a stored upload back into memory so it can travel to Discord.
 *
 * Buffered rather than streamed because Discord's multipart body needs a known
 * length, and because the cap on these is a few megabytes — small enough that
 * holding one briefly costs nothing, and small enough that the alternative
 * (a temporary file and a second read) would be more moving parts for no gain.
 */
async function readMedia(store: MediaStore, mediaId: string): Promise<DiscordUpload> {
  const { stream, record } = await store.open(mediaId);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  const extension =
    record.contentType.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg') ?? 'png';
  return {
    fileName: `attachment.${extension}`,
    contentType: record.contentType,
    bytes: Buffer.concat(chunks),
  };
}

/**
 * How many live games have no save rule at all.
 *
 * The headline the gap list needs: "thirty of your games cannot sync" is the
 * problem, and the rows below it are the share of that problem this page can
 * do something about.
 */
function countGamesWithoutSaveRule(db: Db, withSaveRule: Set<string>): number {
  return db
    .select({ id: games.id })
    .from(games)
    .where(isNull(games.missingAt))
    .all()
    .filter((row) => !withSaveRule.has(row.id)).length;
}
