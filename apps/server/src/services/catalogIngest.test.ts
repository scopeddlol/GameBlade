import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MESH_CHUNK_BYTES, type ReportedGame } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDb, type Db, type DbHandle } from '../db/index.js';
import {
  gameFileChunks,
  gameFiles,
  games,
  libraries,
  meshNodes,
  userGameState,
  users,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { CatalogIngestService } from './catalogIngest.js';

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Moving the coordinator off the machine that holds the games is only safe if
 * a node reporting a library it already knows about *updates* what is there.
 *
 * The fear this addresses is concrete and correct: if reports re-added every
 * game under a new id, every achievement, save rule, artwork match, favourite
 * and playtime record would silently detach from the games they describe, and
 * an operator would discover it long after the old copy was gone. These tests
 * exist to make that outcome impossible to ship.
 */
describe('CatalogIngestService', () => {
  let dataDir: string;
  let db: Db;
  let sqlite: DbHandle['sqlite'];
  let ingest: CatalogIngestService;
  let libraryId: string;
  let nodeId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-ingest-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    ({ db, sqlite } = createDb(config.databasePath));
    ingest = new CatalogIngestService(db, silent);

    libraryId = newId('lib');
    db.insert(libraries).values({ id: libraryId, name: 'Archive', path: '/library' }).run();

    nodeId = newId('nod');
    db.insert(meshNodes)
      .values({
        id: nodeId,
        label: 'Home archive',
        role: 'origin',
        status: 'online',
        publicKey: 'k'.repeat(44),
        tokenHash: 'h'.repeat(64),
        libraryId,
      })
      .run();
  });

  afterEach(async () => {
    sqlite.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function reported(overrides: Partial<ReportedGame> = {}): ReportedGame {
    return {
      relPath: 'Demo Game',
      kind: 'folder',
      sizeBytes: 1_024,
      contentMtime: '2026-01-01T00:00:00.000Z',
      files: [
        {
          relPath: 'game.bin',
          sizeBytes: 1_024,
          modifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      ...overrides,
    };
  }

  /** A game already in the catalog, with the kind of curation people care about. */
  function seedExistingGame(): string {
    const gameId = newId('gam');
    db.insert(games)
      .values({
        id: gameId,
        libraryId,
        relPath: 'Demo Game',
        kind: 'folder',
        title: 'A Title Somebody Fixed By Hand',
        sortTitle: 'title somebody fixed by hand',
        searchTitle: 'title somebody fixed by hand',
        sizeBytes: 1_024,
        fileCount: 1,
        contentMtime: '2026-01-01T00:00:00.000Z',
        matchStatus: 'matched',
      })
      .run();
    return gameId;
  }

  /* ------------------------------------------------------- the core promise */

  it('keeps the id of a game it already knows', () => {
    // The whole migration rests on this one line being true.
    const original = seedExistingGame();

    ingest.ingest(nodeId, [reported({ sizeBytes: 2_048 })]);

    const rows = db.select().from(games).where(eq(games.libraryId, libraryId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(original);
  });

  it('never adds a second copy of a game it already has', () => {
    const original = seedExistingGame();

    // Three reports, as a node heartbeating would send.
    ingest.ingest(nodeId, [reported()]);
    ingest.ingest(nodeId, [reported({ sizeBytes: 4_096 })]);
    ingest.ingest(nodeId, [reported()]);

    const rows = db.select().from(games).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(original);
  });

  it('leaves everything an operator curated alone', () => {
    // A scan knows what is on a disk. It has no opinion about titles, matches
    // or artwork, and must not overwrite the opinions somebody else formed.
    const gameId = seedExistingGame();

    ingest.ingest(nodeId, [reported({ sizeBytes: 9_999 })]);

    const row = db.select().from(games).where(eq(games.id, gameId)).get();
    expect(row?.title).toBe('A Title Somebody Fixed By Hand');
    expect(row?.matchStatus).toBe('matched');
    // But the file-derived fields did move.
    expect(row?.sizeBytes).toBe(9_999);
  });

  it('keeps things attached to a game across a report', () => {
    // The real fear, stated as a test: a favourite is keyed to a game id, so if
    // the id changed the favourite would point at nothing.
    const gameId = seedExistingGame();

    const userId = newId('usr');
    db.insert(users)
      .values({ id: userId, username: 'player', usernameLower: 'player', passwordHash: 'x' })
      .run();
    db.insert(userGameState).values({ userId, gameId, isFavorite: true }).run();

    ingest.ingest(nodeId, [reported({ sizeBytes: 2_048 })]);

    const state = db.select().from(userGameState).where(eq(userGameState.gameId, gameId)).get();
    expect(state?.isFavorite).toBe(true);
  });

  /* ------------------------------------------------------------- new games */

  it('adds a game it has never seen', () => {
    const result = ingest.ingest(nodeId, [reported({ relPath: 'Brand New Game' })]);

    expect(result.added).toBe(1);
    const row = db.select().from(games).where(eq(games.relPath, 'Brand New Game')).get();
    expect(row?.matchStatus).toBe('unmatched');
    expect(row?.title).toBe('Brand New Game');
  });

  it('reports an unchanged game as unchanged and writes nothing', () => {
    const gameId = seedExistingGame();
    const before = db.select().from(games).where(eq(games.id, gameId)).get();

    const result = ingest.ingest(nodeId, [reported()]);

    expect(result.unchanged).toBe(1);
    expect(result.updated).toBe(0);
    const after = db.select().from(games).where(eq(games.id, gameId)).get();
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  /* --------------------------------------------------------------- missing */

  it('flags a game the node no longer has, rather than deleting it', () => {
    // Deleting would destroy hand-made metadata over what may be an unmounted
    // drive. Flagging lets an operator decide.
    const gameId = seedExistingGame();

    const result = ingest.ingest(nodeId, []);

    expect(result.missing).toBe(1);
    const row = db.select().from(games).where(eq(games.id, gameId)).get();
    expect(row?.missingAt).not.toBeNull();
    expect(row?.title).toBe('A Title Somebody Fixed By Hand');
  });

  it('does not flag anything when the report is only part of a library', () => {
    // A partial report says nothing about what it left out. Treating silence
    // as absence would flag a whole catalog because a node sent it in pieces.
    const gameId = seedExistingGame();

    const result = ingest.ingest(nodeId, [], { complete: false });

    expect(result.missing).toBe(0);
    expect(db.select().from(games).where(eq(games.id, gameId)).get()?.missingAt).toBeNull();
  });

  it('un-flags a game that has come back', () => {
    const gameId = seedExistingGame();
    ingest.ingest(nodeId, []);
    expect(db.select().from(games).where(eq(games.id, gameId)).get()?.missingAt).not.toBeNull();

    ingest.ingest(nodeId, [reported()]);

    expect(db.select().from(games).where(eq(games.id, gameId)).get()?.missingAt).toBeNull();
  });

  /* ---------------------------------------------------------------- chunks */

  it('stores the chunk hashes the node computed', () => {
    // The node read every byte to produce these. The coordinator has no copy of
    // the file, so if they did not arrive here nobody could ever compute them.
    ingest.ingest(nodeId, [
      reported({
        files: [
          {
            relPath: 'game.bin',
            sizeBytes: 1_024,
            modifiedAt: '2026-01-01T00:00:00.000Z',
            sha256: 'a'.repeat(64),
            chunks: [{ index: 0, sha256: 'b'.repeat(64), sizeBytes: 1_024 }],
          },
        ],
      }),
    ]);

    const file = db.select().from(gameFiles).get();
    expect(file?.sha256).toBe('a'.repeat(64));
    expect(file?.chunkBytes).toBe(MESH_CHUNK_BYTES);

    const chunk = db.select().from(gameFileChunks).get();
    expect(chunk?.sha256).toBe('b'.repeat(64));
  });

  it('takes the hashes a node computed after it first reported the game', () => {
    /*
     * The whole mesh rests on this, and it was silently false.
     *
     * A node reports its catalog within minutes of starting and then spends
     * hours hashing. Hashing changes nothing about a game that anybody was
     * comparing — not its size, not its file count, not its modification time —
     * so every game came back "unchanged" and the hashes it had just spent the
     * afternoon computing were dropped on the floor. Nothing errored. The
     * catalog was complete, the node was online and reporting, and not one game
     * was ever servable from it.
     */
    ingest.ingest(nodeId, [reported()]);

    const before = db.select().from(gameFiles).all();
    expect(before).toHaveLength(1);
    expect(before[0]!.chunkBytes).toBeNull();

    // The same game, same everything, now hashed.
    ingest.ingest(nodeId, [
      reported({
        files: [
          {
            relPath: 'game.bin',
            sizeBytes: 1_024,
            modifiedAt: '2026-01-01T00:00:00.000Z',
            sha256: 'a'.repeat(64),
            chunks: [{ index: 0, sha256: 'b'.repeat(64), sizeBytes: 1_024 }],
          },
        ],
      }),
    ]);

    const after = db.select().from(gameFiles).all();
    expect(after).toHaveLength(1);
    expect(after[0]!.chunkBytes).toBe(MESH_CHUNK_BYTES);
    expect(db.select().from(gameFileChunks).all()).toHaveLength(1);
  });

  it('still calls a hashed game unchanged when it reports again', () => {
    // The other half: once the hashes are there, a node reporting the same
    // library every five minutes must not rewrite every file row for ever.
    const hashed = reported({
      files: [
        {
          relPath: 'game.bin',
          sizeBytes: 1_024,
          modifiedAt: '2026-01-01T00:00:00.000Z',
          sha256: 'a'.repeat(64),
          chunks: [{ index: 0, sha256: 'b'.repeat(64), sizeBytes: 1_024 }],
        },
      ],
    });

    ingest.ingest(nodeId, [hashed]);
    const settled = ingest.ingest(nodeId, [hashed]);

    expect(settled.unchanged).toBe(1);
    expect(settled.updated).toBe(0);
  });

  it('replaces a game’s files rather than accumulating them', () => {
    ingest.ingest(nodeId, [reported()]);
    ingest.ingest(nodeId, [
      reported({
        sizeBytes: 2_048,
        files: [{ relPath: 'other.bin', sizeBytes: 2_048, modifiedAt: '2026-02-01T00:00:00.000Z' }],
      }),
    ]);

    const files = db.select().from(gameFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.relPath).toBe('other.bin');
  });

  /* ------------------------------------------------------------- refusals */

  it('refuses a node with no library assigned rather than guessing', () => {
    // Guessing — or helpfully making a new library — would re-add the whole
    // catalog as strangers. Refusing is the only safe answer.
    db.update(meshNodes).set({ libraryId: null }).where(eq(meshNodes.id, nodeId)).run();

    expect(() => ingest.ingest(nodeId, [reported()])).toThrow(/no library assigned/i);
  });

  it('refuses an unknown node', () => {
    expect(() => ingest.ingest('nod_nonexistent', [reported()])).toThrow(/Unknown node/);
  });

  it('records that the node reported, and what came of it', () => {
    ingest.ingest(nodeId, [reported()]);

    const node = db.select().from(meshNodes).where(eq(meshNodes.id, nodeId)).get();
    expect(node?.catalogReportedAt).not.toBeNull();
    expect(node?.catalogStatus).toContain('1 entries');
  });

  /* ------------------------------------------------------------ many games */

  it('handles a library larger than one SQLite statement can bind', () => {
    // A real archive is thousands of entries, and a naive single insert would
    // blow the bound-parameter cap partway through and leave it half written.
    const many = Array.from({ length: 750 }, (_, index) => reported({ relPath: `Game ${index}` }));

    const result = ingest.ingest(nodeId, many);

    expect(result.added).toBe(750);
    expect(db.select().from(games).all()).toHaveLength(750);
  });
});
