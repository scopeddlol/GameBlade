import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MESH_CHUNK_BYTES, type ReportedGame } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDb, type Db, type DbHandle } from '../db/index.js';
import {
  gameFiles,
  games,
  libraries,
  meshNodeGames,
  meshNodes,
  userGameStats,
  userLibrary,
  users,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { CatalogIngestService } from './catalogIngest.js';
import { DuplicateService } from './duplicates.js';
import { MeshService } from './mesh.js';

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Moving an archive onto a second machine must not double the catalog.
 *
 * This is the failure these tests exist to prevent, and it is not hypothetical:
 * a node reports into a library of its own because relative paths only mean
 * anything within one, so the same game arriving from a second host is, to
 * every query in the system, a second game. The store shows everything twice,
 * the new copy has none of the achievements or playtime, and the two drift
 * apart from the moment they appear.
 *
 * What is asserted here is the shape of the fix rather than any particular
 * heuristic: the entry keeps its id and everything hanging off it, the copy
 * keeps its own files so its machine can still serve them, and either one going
 * offline leaves the game downloadable from the other.
 */
describe('DuplicateService', () => {
  let dataDir: string;
  let db: Db;
  let sqlite: DbHandle['sqlite'];
  let duplicates: DuplicateService;
  let mesh: MeshService;
  let ingest: CatalogIngestService;

  /** Two libraries, as two nodes reporting into the same coordinator produce. */
  let homeLibrary: string;
  let vpsLibrary: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-duplicates-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    ({ db, sqlite } = createDb(config.databasePath));

    duplicates = new DuplicateService(db, silent);
    mesh = new MeshService(db, silent);
    ingest = new CatalogIngestService(db, silent, duplicates);

    homeLibrary = newId('lib');
    vpsLibrary = newId('lib');
    db.insert(libraries)
      .values([
        { id: homeLibrary, name: 'Home archive', path: '/nodes/home' },
        { id: vpsLibrary, name: 'VPS', path: '/nodes/vps' },
      ])
      .run();
  });

  afterEach(async () => {
    sqlite.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------- fixtures */

  /** A node assigned to a library, as enrolment leaves one. */
  function node(label: string, libraryId: string): string {
    const id = newId('nod');
    db.insert(meshNodes)
      .values({
        id,
        label,
        role: 'mirror',
        status: 'online',
        publicKey: `key-${id}`,
        tokenHash: `hash-${id}`,
        libraryId,
        lastSeenAt: new Date().toISOString(),
      })
      .run();
    return id;
  }

  /**
   * One reported game: a single ZIP, hashed on the current grid.
   *
   * The hash is what decides whether two copies are the same bytes, so it is a
   * parameter rather than derived — half these tests are about what happens
   * when two machines hold packages that are not identical.
   */
  function reported(name: string, sha: string, sizeBytes = MESH_CHUNK_BYTES): ReportedGame {
    return {
      relPath: name,
      kind: 'archive',
      sizeBytes,
      contentMtime: '2026-01-01T00:00:00.000Z',
      files: [
        {
          relPath: name,
          sizeBytes,
          modifiedAt: '2026-01-01T00:00:00.000Z',
          sha256: sha,
          chunkBytes: MESH_CHUNK_BYTES,
          chunks: [{ index: 0, sizeBytes, sha256: `${sha.slice(0, 60)}c000` }],
        },
      ],
    } as ReportedGame;
  }

  function user(name = 'player'): string {
    const id = newId('usr');
    db.insert(users)
      .values({
        id,
        username: name,
        usernameLower: name.toLowerCase(),
        passwordHash: 'x',
      })
      .run();
    return id;
  }

  /** Tell the coordinator a node is holding what it reported. */
  function announce(nodeId: string, gameId: string): void {
    const contentHash = mesh.contentHashFor(gameId);
    expect(contentHash).not.toBeNull();
    mesh.heartbeat({
      nodeId,
      endpoints: [],
      games: [{ gameId, contentHash: contentHash as string }],
    });
  }

  const sha = (seed: string) => seed.repeat(64).slice(0, 64);

  /* ---------------------------------------------------------------- tests */

  it('keeps one entry when a second machine reports the same package', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Celeste.zip', sha('a'))]);
    const entry = db.select().from(games).all()[0];
    expect(entry).toBeDefined();

    ingest.ingest(vps, [reported('Celeste.zip', sha('a'))]);

    const rows = db.select().from(games).all();
    // Both rows survive — each describes a real file on a real disk — but only
    // one of them is an entry anybody is shown.
    expect(rows).toHaveLength(2);
    const entries = rows.filter((row) => row.mergedIntoId === null);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(entry?.id);

    const copy = rows.find((row) => row.mergedIntoId !== null);
    expect(copy?.mergedIntoId).toBe(entry?.id);
    expect(copy?.mergeReason).toBe('content');
    // The copy keeps its own file rows: without them its machine cannot serve
    // the bytes it is holding, which is the entire reason it was kept.
    expect(db.select().from(gameFiles).where(eq(gameFiles.gameId, copy!.id)).all()).toHaveLength(1);
  });

  it('merges a copy that has not been hashed yet on name and size alone', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Hollow Knight.zip', sha('b'))]);

    // A node reports its catalog within minutes and then spends hours hashing.
    // Waiting for that would mean the store showed everything twice all day.
    const unhashed = reported('Hollow Knight.zip', sha('b'));
    unhashed.files[0]!.sha256 = null;
    unhashed.files[0]!.chunks = [];
    delete (unhashed.files[0] as { chunkBytes?: number }).chunkBytes;
    ingest.ingest(vps, [unhashed]);

    const entries = db.select().from(games).all();
    expect(entries.filter((row) => row.mergedIntoId === null)).toHaveLength(1);
    expect(entries.find((row) => row.mergedIntoId !== null)?.mergeReason).toBe('package');
  });

  it('leaves two different packages of the same game as two entries to judge', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Doom.zip', sha('c'), 3 * MESH_CHUNK_BYTES)]);
    ingest.ingest(vps, [reported('Doom.zip', sha('d'), 5 * MESH_CHUNK_BYTES)]);

    // Same name, different bytes and different sizes: two builds, or one of
    // them is wrong. Either way it is not a decision to make automatically.
    expect(
      db
        .select()
        .from(games)
        .all()
        .filter((row) => row.mergedIntoId === null),
    ).toHaveLength(2);

    const offered = duplicates.suggestions();
    expect(offered).toHaveLength(1);
    expect(offered[0]?.reason).toBe('metadata');
    expect(offered[0]?.duplicates).toHaveLength(1);
  });

  it('never merges two copies that live on the same machine', () => {
    const home = node('Home', homeLibrary);

    ingest.ingest(home, [
      reported('Braid.zip', sha('e')),
      // Same bytes, deliberately kept twice by somebody who wanted two copies.
      { ...reported('Braid backup.zip', sha('e')), relPath: 'Braid backup.zip' },
    ]);

    expect(
      db
        .select()
        .from(games)
        .all()
        .filter((row) => row.mergedIntoId === null),
    ).toHaveLength(2);
  });

  it('moves what a player owns onto the entry that survives', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);
    const player = user();

    ingest.ingest(home, [reported('Hades.zip', sha('f'))]);
    const entry = db.select().from(games).all()[0]!;

    // A player who installed it before the second machine existed.
    db.insert(userLibrary).values({ userId: player, gameId: entry.id }).run();
    db.insert(userGameStats)
      .values({ userId: player, gameId: entry.id, totalSeconds: 3_600, launchCount: 2 })
      .run();

    ingest.ingest(vps, [reported('Hades.zip', sha('f'))]);
    const copy = db
      .select()
      .from(games)
      .all()
      .find((row) => row.mergedIntoId !== null)!;

    // Playtime against the copy, as it would be if somebody played it in the
    // window before the merge happened.
    db.insert(userGameStats)
      .values({ userId: player, gameId: copy.id, totalSeconds: 1_800, launchCount: 1 })
      .run();
    duplicates.merge(entry.id, [copy.id], 'manual');

    const stats = db.select().from(userGameStats).where(eq(userGameStats.gameId, entry.id)).all();
    expect(stats).toHaveLength(1);
    // Added, not replaced: two rows for one player are two halves of the same
    // history and picking one would delete hours somebody actually played.
    expect(stats[0]?.totalSeconds).toBe(5_400);
    expect(stats[0]?.launchCount).toBe(3);
    expect(db.select().from(userGameStats).where(eq(userGameStats.gameId, copy.id)).all()).toEqual(
      [],
    );
    expect(
      db.select().from(userLibrary).where(eq(userLibrary.gameId, entry.id)).all(),
    ).toHaveLength(1);
  });

  it('keeps the entry in the catalog when the original copy is deleted', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Outer Wilds.zip', sha('1'))]);
    const entry = db.select().from(games).all()[0]!;
    ingest.ingest(vps, [reported('Outer Wilds.zip', sha('1'))]);

    // The move completes: the operator deletes the local copy and the home
    // node reports an empty library.
    ingest.ingest(home, []);

    const after = db.select().from(games).where(eq(games.id, entry.id)).get();
    expect(after?.missingAt).toBeNull();

    // And when the remaining copy goes too, the entry is honestly marked gone.
    ingest.ingest(vps, []);
    expect(db.select().from(games).where(eq(games.id, entry.id)).get()?.missingAt).not.toBeNull();
  });

  it('brings an entry back when a copy of it turns up on another machine', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Tunic.zip', sha('2'))]);
    const entry = db.select().from(games).all()[0]!;

    // Deleted locally before anything else had it: honestly missing.
    ingest.ingest(home, []);
    expect(db.select().from(games).where(eq(games.id, entry.id)).get()?.missingAt).not.toBeNull();

    // Restored from a backup onto the VPS a day later.
    ingest.ingest(vps, [reported('Tunic.zip', sha('2'))]);

    const restored = db.select().from(games).where(eq(games.id, entry.id)).get();
    expect(restored?.missingAt).toBeNull();
    expect(
      db
        .select()
        .from(games)
        .all()
        .filter((row) => row.mergedIntoId === null),
    ).toHaveLength(1);
  });

  it('offers every machine holding the entry as a download source', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Outer Wilds.zip', sha('3'))]);
    const entry = db.select().from(games).all()[0]!;
    ingest.ingest(vps, [reported('Outer Wilds.zip', sha('3'))]);
    const copy = db
      .select()
      .from(games)
      .all()
      .find((row) => row.mergedIntoId !== null)!;

    announce(home, entry.id);
    announce(vps, copy.id);

    const plan = mesh.deliveryPlan(entry.id);
    expect(plan?.holders.map((holder) => holder.label).sort()).toEqual(['Home', 'VPS']);
    // Each machine is addressed in its own ids: a node asked for a row it does
    // not have answers "not found" however much of the game it is holding.
    const byLabel = new Map(plan!.holders.map((holder) => [holder.label, holder]));
    expect(byLabel.get('Home')?.gameId).toBe(entry.id);
    expect(byLabel.get('VPS')?.gameId).toBe(copy.id);
    expect(mesh.hostCounts([entry.id]).get(entry.id)).toBe(2);
  });

  it('keeps serving from the machine that is still online', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Stray.zip', sha('4'))]);
    const entry = db.select().from(games).all()[0]!;
    ingest.ingest(vps, [reported('Stray.zip', sha('4'))]);
    const copy = db
      .select()
      .from(games)
      .all()
      .find((row) => row.mergedIntoId !== null)!;

    announce(home, entry.id);
    announce(vps, copy.id);

    db.update(meshNodes).set({ status: 'stale' }).where(eq(meshNodes.id, home)).run();

    const plan = mesh.deliveryPlan(entry.id);
    expect(plan?.holders.map((holder) => holder.label)).toEqual(['VPS']);
    expect(mesh.offeredGameIds([entry.id]).has(entry.id)).toBe(true);
  });

  it('pulls a copy back out into an entry of its own', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Inside.zip', sha('5'))]);
    const entry = db.select().from(games).all()[0]!;
    ingest.ingest(vps, [reported('Inside.zip', sha('5'))]);
    const copy = db
      .select()
      .from(games)
      .all()
      .find((row) => row.mergedIntoId !== null)!;

    duplicates.unmerge(copy.id);

    const rows = db.select().from(games).all();
    expect(rows.filter((row) => row.mergedIntoId === null)).toHaveLength(2);
    expect(rows.find((row) => row.id === copy.id)?.mergeReason).toBeNull();
  });

  it('refuses to merge an entry into something that is already a copy', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Limbo.zip', sha('6'))]);
    const entry = db.select().from(games).all()[0]!;
    ingest.ingest(vps, [reported('Limbo.zip', sha('6'))]);
    const copy = db
      .select()
      .from(games)
      .all()
      .find((row) => row.mergedIntoId !== null)!;

    // Chains would mean every reader had to walk one, so they are refused at
    // the point where one would be created.
    expect(() => duplicates.merge(copy.id, [entry.id], 'manual')).toThrow(/copy of another/i);
  });

  it('does not announce a second machine as new games', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Portal.zip', sha('7'))]);
    const result = ingest.ingest(vps, [reported('Portal.zip', sha('7'))]);

    // The report did add a row — the copy — and the catalog did not grow.
    expect(result.added).toBe(1);
    expect(
      db
        .select()
        .from(games)
        .all()
        .filter((row) => row.mergedIntoId === null),
    ).toHaveLength(1);
  });

  it('counts a merged entry once in the mesh index', () => {
    const home = node('Home', homeLibrary);
    const vps = node('VPS', vpsLibrary);

    ingest.ingest(home, [reported('Tetris.zip', sha('8'))]);
    const entry = db.select().from(games).all()[0]!;
    ingest.ingest(vps, [reported('Tetris.zip', sha('8'))]);
    const copy = db
      .select()
      .from(games)
      .all()
      .find((row) => row.mergedIntoId !== null)!;

    announce(vps, copy.id);
    db.update(meshNodes).set({ status: 'stale' }).where(eq(meshNodes.id, home)).run();

    // Only the copy is announced, and the entry is what the store asks about.
    expect(mesh.offeredGameIds([entry.id])).toEqual(new Set([entry.id]));
    expect(db.select().from(meshNodeGames).all()).toHaveLength(1);
    expect(duplicates.mergedCount()).toBe(1);
  });
});
