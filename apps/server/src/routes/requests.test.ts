import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CSRF_HEADER,
  type CollectionInfo,
  type GameRequestDigest,
  type GameRequestInfo,
} from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { games, libraries } from '../db/schema.js';
import { requestKey } from '../services/gameRequests.js';

interface Account {
  cookie: string;
  csrf: string;
  id: string;
}

/**
 * The request queue and per-account game groups.
 *
 * Both are player-facing features an administrator also touches, so most of
 * what matters here is the boundary: what an ordinary account may see and do,
 * versus what only the operator can.
 */
describe('requests and collections', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: Account;
  let player: Account;
  let gameId: string;

  const auth = (account: Account) => ({
    cookie: account.cookie,
    [CSRF_HEADER]: account.csrf,
  });

  /** Finds a request by title; the list is ranked, so positions move. */
  const findRequest = async (title: string): Promise<GameRequestInfo> => {
    const list = (
      await app.inject({ method: 'GET', url: '/api/requests', headers: auth(admin) })
    ).json() as GameRequestInfo[];
    const found = list.find((entry) => entry.title.toLowerCase() === title.toLowerCase());
    if (!found) throw new Error(`no request titled ${title}`);
    return found;
  };

  const signUp = async (username: string, inviteCode?: string): Promise<Account> => {
    const response = await app.inject({
      method: 'POST',
      url: inviteCode ? '/api/auth/register' : '/api/auth/setup',
      payload: { username, password: 'a-long-enough-password', inviteCode },
    });
    const raw = response.headers['set-cookie'];
    const body = response.json() as { csrfToken: string; user: { id: string } };
    return {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
      id: body.user.id,
    };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-requests-test-'));
    app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
      } as NodeJS.ProcessEnv),
    );
    await app.ready();

    admin = await signUp('archivist');

    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(admin),
      payload: { role: 'user', maxUses: 5 },
    });
    player = await signUp('player', (invite.json() as { code: string }).code);

    // One catalog entry, so a fulfilled request can point at something real.
    const db = app.gameblade.db;
    db.insert(libraries).values({ id: 'lib1', name: 'Main', path: '/srv/games' }).run();
    gameId = 'game1';
    db.insert(games)
      .values({
        id: gameId,
        libraryId: 'lib1',
        relPath: 'Bastion',
        kind: 'folder',
        title: 'Bastion',
        sortTitle: 'bastion',
        searchTitle: 'bastion',
      })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* -------------------------------------------------------------- requests */

  it('normalises titles so the same game collides however it is typed', () => {
    expect(requestKey('Half-Life 2: Episode One')).toBe(requestKey('half life 2 episode one'));
    // But not so aggressively that a sequel merges with its parent.
    expect(requestKey('Halo')).not.toBe(requestKey('Halo Wars'));
  });

  it('counts the requester as a backer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: auth(player),
      payload: { title: 'Hollow Knight: Silksong', note: 'Please.' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as GameRequestInfo;
    expect(body.votes).toBe(1);
    expect(body.hasVoted).toBe(true);
    expect(body.status).toBe('pending');
  });

  it('says whether a request was created or merely backed', async () => {
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: auth(player),
      payload: { title: 'A Brand New Ask' },
    });
    expect((fresh.json() as { created: boolean }).created).toBe(true);

    const again = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: auth(admin),
      payload: { title: 'a brand new ask' },
    });
    // The client needs this to say "your vote went to the existing one"
    // rather than claiming the ask was filed fresh.
    expect((again.json() as { created: boolean }).created).toBe(false);
  });

  it('folds a second ask for the same title into the first', async () => {
    const again = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: auth(admin),
      // Different spelling, same game.
      payload: { title: 'hollow knight silksong' },
    });

    const body = again.json() as GameRequestInfo;
    expect(body.votes).toBe(2);

    const list = (
      await app.inject({ method: 'GET', url: '/api/requests', headers: auth(player) })
    ).json() as GameRequestInfo[];
    // Two people asking must strengthen one row, not produce two the operator
    // has to reconcile by hand.
    expect(list.filter((entry) => entry.title.includes('Silksong'))).toHaveLength(1);
  });

  it('lets a backer take their vote back', async () => {
    const id = (await findRequest('Hollow Knight: Silksong')).id;

    const dropped = await app.inject({
      method: 'DELETE',
      url: `/api/requests/${id}/vote`,
      headers: auth(admin),
    });
    expect(dropped.json()).toMatchObject({ votes: 1, hasVoted: false });

    const again = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/vote`,
      headers: auth(admin),
    });
    expect(again.json()).toMatchObject({ votes: 2, hasVoted: true });
  });

  it('hides who asked from other players but names them for an admin', async () => {
    const asPlayer = (
      await app.inject({ method: 'GET', url: '/api/requests', headers: auth(player) })
    ).json() as GameRequestInfo[];
    expect(asPlayer.every((entry) => entry.requestedBy === null)).toBe(true);

    const asAdmin = (
      await app.inject({ method: 'GET', url: '/api/admin/requests', headers: auth(admin) })
    ).json() as { items: GameRequestInfo[] };
    const silksong = asAdmin.items.find((entry) => entry.title.includes('Silksong'));
    expect(silksong?.requestedBy?.username).toBe('player');
  });

  it('keeps request triage away from ordinary accounts', async () => {
    const request = await findRequest('Hollow Knight: Silksong');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/requests/${request.id}`,
      headers: auth(player),
      payload: { status: 'added' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses to mark a request as fulfilled by a game that is not there', async () => {
    const request = await findRequest('Hollow Knight: Silksong');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/requests/${request.id}`,
      headers: auth(admin),
      payload: { status: 'added', gameId: 'game-that-never-was' },
    });
    // A dangling id renders as a dead "open it" link in every client.
    expect(response.statusCode).toBe(400);
  });

  it('moves a decided request into the right digest panel', async () => {
    const request = await findRequest('Hollow Knight: Silksong');

    await app.inject({
      method: 'PATCH',
      url: `/api/admin/requests/${request.id}`,
      headers: auth(admin),
      payload: { status: 'coming-soon', adminNote: 'Sourcing a copy.' },
    });

    const digest = (
      await app.inject({ method: 'GET', url: '/api/requests/digest', headers: auth(player) })
    ).json() as GameRequestDigest;

    expect(digest.comingSoon.map((entry) => entry.title)).toContain('Hollow Knight: Silksong');
    expect(digest.mostRequested.map((entry) => entry.title)).not.toContain(
      'Hollow Knight: Silksong',
    );
    expect(digest.counts['coming-soon']).toBe(1);
    // It is still the player's own request, so it stays in their list.
    expect(digest.yours.map((entry) => entry.title)).toContain('Hollow Knight: Silksong');
  });

  it('reopens a denied title when somebody else asks for it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: auth(player),
      payload: { title: 'A Game Nobody Wants' },
    });
    const id = (created.json() as GameRequestInfo).id;

    await app.inject({
      method: 'PATCH',
      url: `/api/admin/requests/${id}`,
      headers: auth(admin),
      payload: { status: 'denied', adminNote: 'Not something we can host.' },
    });

    const asked = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: auth(admin),
      payload: { title: 'a game nobody wants' },
    });

    // The second asker has not seen that decision, and a request nobody can
    // re-raise is a dead end.
    expect((asked.json() as GameRequestInfo).status).toBe('pending');
  });

  /* ------------------------------------------------------------ collections */

  it('creates a group and lists it with a count', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: auth(player),
      payload: { name: 'Co-op night', color: 'violet' },
    });
    expect(created.statusCode).toBe(201);

    const collection = created.json() as CollectionInfo;
    expect(collection.gameCount).toBe(0);

    await app.inject({
      method: 'POST',
      url: `/api/collections/${collection.id}/games`,
      headers: auth(player),
      payload: { gameIds: [gameId] },
    });

    const list = (
      await app.inject({ method: 'GET', url: '/api/collections', headers: auth(player) })
    ).json() as CollectionInfo[];
    expect(list[0]).toMatchObject({ name: 'Co-op night', gameCount: 1 });
  });

  it('filters the catalog to one group', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/api/collections', headers: auth(player) })
    ).json() as CollectionInfo[];
    const id = list[0]?.id as string;

    const inGroup = await app.inject({
      method: 'GET',
      url: `/api/games?collectionId=${id}`,
      headers: auth(player),
    });
    expect((inGroup.json() as { total: number }).total).toBe(1);

    // Somebody else's group id must match nothing rather than list their games.
    const asAdmin = await app.inject({
      method: 'GET',
      url: `/api/games?collectionId=${id}`,
      headers: auth(admin),
    });
    expect((asAdmin.json() as { total: number }).total).toBe(0);
  });

  it('refuses to rename a group somebody else owns', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/api/collections', headers: auth(player) })
    ).json() as CollectionInfo[];

    const response = await app.inject({
      method: 'PUT',
      url: `/api/collections/${list[0]?.id}`,
      headers: auth(admin),
      payload: { name: 'Mine now', color: 'blade' },
    });
    // Filtering on the owner makes this a 404 rather than a silent success.
    expect(response.statusCode).toBe(404);
  });

  it('rejects a duplicate group name for the same account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: auth(player),
      payload: { name: 'Co-op night', color: 'blade' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('reports which groups a game is already in', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/api/collections', headers: auth(player) })
    ).json() as CollectionInfo[];

    const membership = (
      await app.inject({
        method: 'POST',
        url: '/api/collections/membership',
        headers: auth(player),
        payload: { gameIds: [gameId] },
      })
    ).json() as Record<string, string[]>;

    expect(membership[gameId]).toEqual([list[0]?.id]);
  });

  it('removes a game from a group without touching the game', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/api/collections', headers: auth(player) })
    ).json() as CollectionInfo[];

    const removed = await app.inject({
      method: 'POST',
      url: `/api/collections/${list[0]?.id}/games/remove`,
      headers: auth(player),
      payload: { gameIds: [gameId] },
    });
    expect(removed.statusCode).toBe(204);

    const after = (
      await app.inject({ method: 'GET', url: '/api/collections', headers: auth(player) })
    ).json() as CollectionInfo[];
    expect(after[0]?.gameCount).toBe(0);

    // Put it back, so the deletion test below still has something to prove.
    await app.inject({
      method: 'POST',
      url: `/api/collections/${list[0]?.id}/games`,
      headers: auth(player),
      payload: { gameIds: [gameId] },
    });
  });

  it('deleting a group leaves the games alone', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/api/collections', headers: auth(player) })
    ).json() as CollectionInfo[];

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/collections/${list[0]?.id}`,
      headers: auth(player),
    });
    expect(removed.statusCode).toBe(204);

    const games = await app.inject({
      method: 'GET',
      url: '/api/games',
      headers: auth(player),
    });
    expect((games.json() as { total: number }).total).toBe(1);
  });
});
