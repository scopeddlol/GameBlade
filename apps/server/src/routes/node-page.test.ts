import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { bootstrap } from '../bootstrap.js';
import { discoverLibraryRoots, loadConfig } from '../config.js';
import { libraries } from '../db/schema.js';

/**
 * The page a node serves about itself, and the two things it can start.
 *
 * Every one of these pins a failure that is silent from the server's side. The
 * script being blocked by the content security policy produced a page whose
 * only symptom was a button that did nothing; a second mounted drive going
 * unread produced a node reporting half a library and no error anywhere. Both
 * shipped, and neither could have been noticed without looking at what the page
 * actually contains.
 */
describe('a node’s own page', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function bootNode(env: Record<string, string> = {}) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-node-page-'));
    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        ROLE: 'node',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
        ...env,
      } as NodeJS.ProcessEnv),
    );
    await app.ready();

    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    return { app, dataDir };
  }

  it('serves its script as a file, because an inline one is dropped by the CSP', async () => {
    // This is the whole bug. Every response from this server carries
    // `script-src 'self'`, so an inline block never ran: the setup form's
    // submit handler was never bound, "Connect this node" did nothing at all,
    // and the page did not even refresh itself to suggest something was wrong.
    const { app } = await bootNode();

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('src="/node.js"');
    // No inline script with a body in it. An empty `<script src=...>` is fine;
    // anything between the tags would be dropped again.
    expect(page.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);

    const script = await app.inject({ method: 'GET', url: '/node.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(script.body).toContain('/api/node/setup');
    // Status updates still reload the page, but never while somebody is in
    // the form or after they have pasted a one-time code. The old unconditional
    // three-second timer made a busy node almost impossible to enrol.
    expect(script.body).toContain('function setupInProgress()');
    expect(script.body).toContain('form.contains(document.activeElement)');
    expect(script.body).toContain('form.elements.enrolmentToken.value !==');
    expect(script.body).not.toContain(
      'var timer = setTimeout(function () { location.reload(); }, refreshIn);',
    );

    // And the policy that broke it is still on, so this cannot regress into an
    // inline block that happens to work in one browser.
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('finds every drive mounted under the multi-library root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gameblade-mounts-'));
    cleanups.push(() => rm(base, { recursive: true, force: true }));

    const single = path.join(base, 'library');
    const many = path.join(base, 'libraries');
    await mkdir(single, { recursive: true });
    await mkdir(path.join(many, '3TB'), { recursive: true });
    await mkdir(path.join(many, 'E'), { recursive: true });
    // A file under the multi-root is not a library.
    await writeFile(path.join(many, 'notes.txt'), 'x');

    expect(discoverLibraryRoots(single, many)).toEqual([
      single,
      path.join(many, '3TB'),
      path.join(many, 'E'),
    ]);
  });

  it('registers one library per mounted drive, named after it', async () => {
    // The reported bug: two drives in the compose file, one library on the
    // node, and nothing anywhere saying the second was ignored.
    const games = await mkdtemp(path.join(tmpdir(), 'gameblade-drives-'));
    cleanups.push(() => rm(games, { recursive: true, force: true }));

    const first = path.join(games, '3TB');
    const second = path.join(games, 'E');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    const { app } = await bootNode({ LIBRARY_PATHS: `${first},${second}` });
    await bootstrap(app);

    const rows = app.gameblade.db.select().from(libraries).all();
    expect(rows.map((row) => row.name).sort()).toEqual(['3TB', 'E']);
    expect(rows.every((row) => row.enabled)).toBe(true);

    const status = await app.gameblade.nodeStatus.snapshot();
    expect(status.libraries).toHaveLength(2);
    expect(status.libraries.every((library) => library.mounted)).toBe(true);

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.body).toContain('3TB');
    expect(page.body).toContain('E');
  });

  it('makes /library the primary root when both are mounted at once', async () => {
    /*
     * Which root is primary decides which games keep unprefixed paths on the
     * coordinator, and that is whichever library row is oldest. Rows added in
     * one pass would otherwise share a millisecond and fall through to the
     * path tiebreak — where `/libraries/E` sorts *before* `/library`, so the
     * secondary drive would have become the primary and the main one would
     * have had its paths rewritten. On a node that has already reported, that
     * is every game becoming a stranger and every achievement, save rule and
     * playtime record orphaned.
     */
    const games = await mkdtemp(path.join(tmpdir(), 'gameblade-primary-'));
    const single = path.join(games, 'library');
    const many = path.join(games, 'libraries');
    await mkdir(single, { recursive: true });
    await mkdir(path.join(many, 'E'), { recursive: true });
    cleanups.push(() => rm(games, { recursive: true, force: true }));

    const { app } = await bootNode({
      LIBRARY_PATHS: discoverLibraryRoots(single, many).join(','),
    });
    await bootstrap(app);

    const rows = app.gameblade.db
      .select()
      .from(libraries)
      .orderBy(libraries.createdAt, libraries.path)
      .all();

    expect(rows).toHaveLength(2);
    // The order `pathPrefixes` reads: the first is the one left unprefixed.
    expect(rows[0]!.path).toBe(single);
    expect(rows[1]!.path).toBe(path.join(many, 'E'));
    // And it is decided by time rather than by the name sorting the wrong way.
    expect(rows[0]!.createdAt < rows[1]!.createdAt).toBe(true);
  });

  it('keeps a library whose drive went away, rather than emptying its catalog', async () => {
    // Deleting it would take the catalog with it, and a mount that failed on
    // this boot is far more often one that will be back than a drive somebody
    // meant to remove. Disabled means the scanner skips it, which is what stops
    // one unmounted drive flagging every game on it as missing.
    const games = await mkdtemp(path.join(tmpdir(), 'gameblade-gone-'));
    const drive = path.join(games, 'E');
    await mkdir(drive, { recursive: true });
    cleanups.push(() => rm(games, { recursive: true, force: true }));

    const { app } = await bootNode({ LIBRARY_PATHS: drive });
    await bootstrap(app);
    expect(app.gameblade.db.select().from(libraries).all()).toHaveLength(1);

    await rm(drive, { recursive: true, force: true });
    await bootstrap(app);

    const rows = app.gameblade.db.select().from(libraries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);

    // And back again when the drive returns.
    await mkdir(drive, { recursive: true });
    await bootstrap(app);
    expect(app.gameblade.db.select().from(libraries).all()[0]!.enabled).toBe(true);
  });

  it('starts a scan and a hashing pass when asked, and refuses a second', async () => {
    // A node's timers already do both; the point of the buttons is that a
    // machine plugged in five minutes ago should not have to wait for them.
    const games = await mkdtemp(path.join(tmpdir(), 'gameblade-jobs-'));
    await mkdir(path.join(games, 'Demo Game'), { recursive: true });
    await writeFile(path.join(games, 'Demo Game', 'game.bin'), Buffer.alloc(64));
    cleanups.push(() => rm(games, { recursive: true, force: true }));

    const { app } = await bootNode({ LIBRARY_PATHS: games });

    const scan = await app.inject({ method: 'POST', url: '/api/node/scan', payload: {} });
    expect(scan.statusCode).toBe(202);
    // The mount check happens as part of it, so a drive attached after the
    // container started is found without restarting anything.
    expect(app.gameblade.db.select().from(libraries).all()).toHaveLength(1);

    const hash = await app.inject({ method: 'POST', url: '/api/node/hash', payload: {} });
    expect(hash.statusCode).toBe(202);
    // The pass ran, whether or not it found anything to do — which is the
    // number the page shows, and what tells an operator the button worked.
    expect(app.gameblade.chunks.getSweepProgress().startedAt).not.toBeNull();

    // Stopping something that is not running is refused rather than silently
    // succeeding, so the page never claims to have stopped a pass that had
    // already finished.
    const stop = await app.inject({ method: 'POST', url: '/api/node/hash/cancel', payload: {} });
    expect(stop.statusCode).toBe(409);
  });

  it('says how to add a second drive while a node still has one', async () => {
    const games = await mkdtemp(path.join(tmpdir(), 'gameblade-hint-'));
    await mkdir(path.join(games, 'library'), { recursive: true });
    cleanups.push(() => rm(games, { recursive: true, force: true }));

    // Discovered rather than declared: the hint is for somebody who has not
    // set LIBRARY_PATHS, which is every node running the shipped image.
    const { app } = await bootNode();
    await bootstrap(app);

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.body).toContain('/libraries');
  });

  it('shows the coordinator’s actual enrolment failure on the setup page', async () => {
    const { app, dataDir } = await bootNode();
    await writeFile(
      path.join(dataDir, 'node-state.json'),
      JSON.stringify({
        secretKey: 'generated',
        coordinatorUrl: 'https://games.example.com',
        enrolmentToken: 'expired-code',
        registrationError: 'registration refused (403): That enrolment code has expired',
      }),
      'utf8',
    );

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.body).toContain('That enrolment code has expired');
    expect(page.body).toContain('enrolment failed');
  });
});
