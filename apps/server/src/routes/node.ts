import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARCHIVE_EXTENSIONS, IGNORED_ENTRIES } from '@gameblade/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { syncLibraryRoots } from '../bootstrap.js';
import { games, libraries, nodeEntryPolicies } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { NODE_PAGE_SCRIPT, renderNodePage } from './nodePage.js';

/**
 * What setup accepts, and nothing else.
 *
 * The URL is parsed rather than trusted as a string so a typo is refused here
 * rather than becoming a node that retries an unresolvable host for ever, and
 * the scheme list is what stops `file:` or anything else exotic being written
 * into a field two processes later hand to an HTTP client.
 */
const setupSchema = z.object({
  coordinatorUrl: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    }, 'Enter the coordinator’s full address, e.g. https://games.example.com'),
  enrolmentToken: z.string().trim().min(1).max(512),
});

const entryDecisionSchema = z.object({
  relPath: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => !value.includes('/') && !value.includes('\\') && value !== '.', {
      message: 'Choose one top-level library entry',
    }),
  decision: z.enum(['automatic', 'approved', 'ignored']),
});

const ignoredEntries = new Set(IGNORED_ENTRIES.map((entry) => entry.toLowerCase()));

function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * What a node serves over HTTP: a page about itself, and the same thing as JSON.
 *
 * Everything else a node does happens somewhere other than this port — it scans
 * local disk, reports upward over HTTPS, and supplies requested chunks through
 * the agent process beside this one. This exists because a machine that does
 * all of that invisibly is a machine whose only diagnostic is `docker logs`.
 *
 * Deliberately unauthenticated, and deliberately given nothing worth
 * authenticating: counts, paths that are already in the compose file, and
 * whether the coordinator answered. No game data, no accounts and no keys are
 * readable from here.
 *
 * Three things can be *started* from here — enrolment, a scan, and the hashing
 * pass — and each is bounded to the same shape: work this node already does on
 * its own timers, brought forward. None of them reads out anything the page
 * does not already show, none writes to the library (which is mounted
 * read-only), and none can be made to touch another machine. Starting a pass
 * that is already running is refused rather than queued, so the worst a flood
 * of requests achieves is a great many 409s. It is still meant to stay off the
 * public internet, and the compose file binds it to localhost for that reason.
 *
 * Registered instead of the SPA and the whole coordinator API, not alongside
 * them. A node runs its own empty database, so serving the admin bundle would
 * offer a second, wrong panel over it — first-run administrator screen and all.
 */
export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  const { nodeStatus, nodeBackups, config, db, scanner, chunks } = app.gameblade;

  const send = async (reply: FastifyReply): Promise<FastifyReply> =>
    reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(renderNodePage(await nodeStatus.snapshot(), config.basePath));

  app.get(`${config.basePath}/api/node/status`, async () => nodeStatus.snapshot());

  /**
   * The page's script, as a file.
   *
   * A file because this server sets `script-src 'self'` on every response, and
   * an inline block is therefore dropped by the browser without a word to
   * anyone — which is exactly what happened: the setup form's submit handler
   * never bound, so "Connect this node" did nothing at all, and the page did
   * not even refresh itself to hint that something was wrong.
   *
   * Cached, unlike the page: it changes only when the image does, and the
   * version keeps a stale copy from outliving an upgrade.
   */
  app.get(`${config.basePath}/node.js`, async (_request, reply) =>
    reply
      .header('Cache-Control', 'public, max-age=300')
      .type('text/javascript; charset=utf-8')
      .send(NODE_PAGE_SCRIPT),
  );

  /**
   * Start a scan, having first looked for mounts that were not there at boot.
   *
   * The mount check is part of pressing this rather than a button of its own,
   * because they are the same intention: a drive was plugged in, or a compose
   * file was fixed, and somebody wants this node to notice. Doing it here means
   * a new library is found, registered and walked in one action instead of
   * needing the container restarted first.
   */
  app.post(`${config.basePath}/api/node/scan`, async (_request, reply) => {
    if (scanner.isRunning) throw ApiError.conflict('A scan is already running.');

    const mounts = await syncLibraryRoots(app);

    // Fire and forget: a real archive takes a long time to walk, and the page
    // polls rather than holding a request open for the length of it.
    void scanner.scan({ fetchMetadata: false });

    const found =
      mounts.added.length > 0
        ? ` Found ${mounts.added.length} new librar${mounts.added.length === 1 ? 'y' : 'ies'}.`
        : '';
    return reply.code(202).send({ started: true, message: `Scanning.${found}`, mounts });
  });

  app.post(`${config.basePath}/api/node/scan/cancel`, async () => {
    if (!scanner.cancel()) throw ApiError.conflict('No scan is running.');
    return { message: 'Stopping after the current item.' };
  });

  /**
   * Start hashing everything that is not hashed yet.
   *
   * A node's timer already does this every ten minutes, which is right for one
   * that has been running for a month and useless for one plugged in five
   * minutes ago: nothing here is servable until its game is hashed, and the
   * first pass over a real archive is hours. This is that pass, now.
   */
  app.post(`${config.basePath}/api/node/hash`, async (_request, reply) => {
    if (!chunks.startSweep(() => scanner.isRunning)) {
      throw ApiError.conflict('Files are already being hashed.');
    }
    return reply.code(202).send({ started: true, message: 'Hashing every unhashed game.' });
  });

  app.post(`${config.basePath}/api/node/hash/cancel`, async () => {
    if (!chunks.stopSweep()) throw ApiError.conflict('Nothing is being hashed.');
    return { message: 'Stopping after the game being read now.' };
  });

  /* ---------------------------------------------------------- game intake */

  /**
   * A safe, top-level view of a mounted library.
   *
   * GameBlade deliberately treats only top-level folders and supported archive
   * files as games, so browsing deeper would offer controls that cannot have a
   * meaningful effect. No absolute path is accepted from the browser and no
   * file contents are returned.
   */
  app.get(`${config.basePath}/api/node/libraries/:libraryId/entries`, async (request) => {
    const { libraryId } = request.params as { libraryId: string };
    const library = db.select().from(libraries).where(eq(libraries.id, libraryId)).get();
    if (!library) throw ApiError.notFound('Library not found');

    const diskEntries = await readdir(library.path, { withFileTypes: true }).catch(() => null);
    if (!diskEntries) throw ApiError.notFound('That library is not mounted or readable');

    const policies = new Map(
      db
        .select({ relPath: nodeEntryPolicies.relPath, decision: nodeEntryPolicies.decision })
        .from(nodeEntryPolicies)
        .where(eq(nodeEntryPolicies.libraryId, library.id))
        .all()
        .map((row) => [row.relPath, row.decision]),
    );
    const catalog = new Map(
      db
        .select({
          relPath: games.relPath,
          sizeBytes: games.sizeBytes,
          missingAt: games.missingAt,
        })
        .from(games)
        .where(eq(games.libraryId, library.id))
        .all()
        .map((game) => [game.relPath, game]),
    );

    const entries = await Promise.all(
      diskEntries.map(async (entry) => {
        const archive = entry.isFile() && isArchive(entry.name);
        const eligible = entry.isDirectory() || archive;
        const systemIgnored =
          entry.name.startsWith('.') || ignoredEntries.has(entry.name.toLowerCase());
        const policy = policies.get(entry.name) ?? 'automatic';
        const known = catalog.get(entry.name);
        const info = entry.isFile()
          ? await stat(path.join(library.path, entry.name)).catch(() => null)
          : null;
        const willRead =
          policy !== 'ignored' && eligible && (policy === 'approved' || !systemIgnored);

        return {
          name: entry.name,
          kind: entry.isDirectory() ? 'folder' : archive ? 'archive' : 'file',
          eligible,
          systemIgnored,
          decision: policy,
          willRead,
          cataloged: Boolean(known && !known.missingAt),
          sizeBytes: known?.sizeBytes ?? info?.size ?? null,
          modifiedAt: info ? new Date(info.mtimeMs).toISOString() : null,
        };
      }),
    );

    entries.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return { library: { id: library.id, name: library.name, path: library.path }, entries };
  });

  app.put(`${config.basePath}/api/node/libraries/:libraryId/entries/decision`, async (request) => {
    const { libraryId } = request.params as { libraryId: string };
    const input = entryDecisionSchema.parse(request.body);
    const library = db.select().from(libraries).where(eq(libraries.id, libraryId)).get();
    if (!library) throw ApiError.notFound('Library not found');

    const entry = (await readdir(library.path, { withFileTypes: true }).catch(() => [])).find(
      (candidate) => candidate.name === input.relPath,
    );
    if (!entry) throw ApiError.notFound('That library entry is no longer on disk');
    if (
      input.decision === 'approved' &&
      !entry.isDirectory() &&
      !(entry.isFile() && isArchive(entry.name))
    ) {
      throw ApiError.badRequest('Only folders and supported game archives can be approved');
    }

    const where = and(
      eq(nodeEntryPolicies.libraryId, library.id),
      eq(nodeEntryPolicies.relPath, input.relPath),
    );
    db.transaction((tx) => {
      tx.delete(nodeEntryPolicies).where(where).run();
      if (input.decision !== 'automatic') {
        tx.insert(nodeEntryPolicies)
          .values({
            libraryId: library.id,
            relPath: input.relPath,
            decision: input.decision,
            updatedAt: new Date().toISOString(),
          })
          .run();
      }

      // Withdrawal is safe immediately. Restoration is deliberately left to
      // the next scan: the bytes may have changed while this entry was ignored,
      // and advertising its old file list/hashes in that window would make the
      // Node promise chunks it no longer has.
      if (input.decision === 'ignored') {
        tx.update(games)
          .set({ missingAt: new Date().toISOString() })
          .where(and(eq(games.libraryId, library.id), eq(games.relPath, input.relPath)))
          .run();
      }
    });

    return {
      ok: true,
      decision: input.decision,
      message:
        input.decision === 'ignored'
          ? 'Ignored. It will no longer be reported to the Coordinator.'
          : 'Saved. Run a scan to read any newly approved game files.',
    };
  });

  /* -------------------------------------------------------------- backups */

  app.post(`${config.basePath}/api/node/backups`, async (_request, reply) => {
    const status = await nodeStatus.snapshot();
    if (!status.enrolled) {
      throw ApiError.conflict('Finish enrolling this Node before starting a Coordinator backup.');
    }
    if (!nodeBackups.start(true)) throw ApiError.conflict('A backup is already in progress.');
    return reply
      .code(202)
      .send({ started: true, message: 'Creating a complete Coordinator backup.' });
  });

  app.delete(`${config.basePath}/api/node/backups/:name`, async (request) => {
    const { name } = request.params as { name: string };
    if (!(await nodeBackups.remove(name))) throw ApiError.badRequest('That is not a backup name');
    return { ok: true, message: 'Backup removed from this Node.' };
  });

  /**
   * Point this node at a coordinator, once.
   *
   * The one piece of a node's own state a request may write, and it exists
   * because the alternative is worse: without it, joining a node to a coordinator means
   * editing a compose file on the machine holding the games and restarting the
   * container, for two values that are only ever entered once. That is a poor
   * trade for an operator and a genuinely bad one for anybody setting this up
   * for the first time.
   *
   * Bounded exactly like the coordinator's own first-run administrator screen,
   * which is the same shape of problem — a privileged action that has to be
   * possible before there is anybody to authenticate:
   *
   * * It works only while this node is not enrolled. After that it is gone, so
   *   an enrolled node is back to having nothing a request can alter.
   * * It grants nothing by itself. The enrolment code is checked by the
   *   coordinator, not here; a wrong one produces a node that fails to
   *   register, which is exactly what a wrong one in an environment variable
   *   produces.
   * * The page it belongs to is bound to localhost by default and is meant to
   *   stay off the public internet either way.
   *
   * The values go into the shared state file rather than into this process,
   * because the mesh agent alongside is the half that registers and it reads
   * the same file. Writing there means one answer configures both, and it
   * survives a restart without being in the environment.
   */
  app.post(`${config.basePath}/api/node/setup`, async (request, reply) => {
    const current = await nodeStatus.snapshot();
    if (current.enrolled) {
      throw ApiError.conflict(
        'This node is already enrolled. Remove it in Admin → Nodes and delete node-state.json to start again.',
      );
    }

    const input = setupSchema.parse(request.body);

    // Read, merge, write. The agent owns the key in this file and may be
    // generating it right now; replacing the file wholesale would lose it and
    // this node would enrol twice under two identities.
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(await readFile(config.nodeStatePath, 'utf8')) as Record<string, unknown>;
    } catch {
      // No file yet is the ordinary first run.
    }

    state.coordinatorUrl = input.coordinatorUrl.replace(/\/+$/, '');
    state.enrolmentToken = input.enrolmentToken;
    // This submission is a new attempt. Do not keep showing the reason the
    // previous code failed while the agent is trying the replacement.
    delete state.registrationError;

    await mkdir(path.dirname(config.nodeStatePath), { recursive: true });
    await writeFile(config.nodeStatePath, JSON.stringify(state, null, 2), 'utf8');

    app.log.info(
      { coordinator: state.coordinatorUrl },
      'this node was pointed at a coordinator from its setup page',
    );

    return reply.code(202).send({ accepted: true, coordinatorUrl: state.coordinatorUrl });
  });

  app.get(config.basePath === '' ? '/' : config.basePath, async (_request, reply) => send(reply));

  // Anything else is somebody looking for the panel, which is not here. The
  // page says where it is, so this is more useful than a bare 404.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith(`${config.basePath}/api`)) {
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message:
            'A Node serves health, status, setup, scan, hash, game-intake and backup controls only',
        },
      });
    }
    return send(reply.code(404));
  });
}
