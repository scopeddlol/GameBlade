import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  API_KEY_PREFIX,
  CSRF_HEADER,
  type CreatedApiKey,
  type PublicUser,
} from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { apiKeys, users } from '../db/schema.js';

/**
 * The external API.
 *
 * Most of what matters here is what a key is *not* allowed to do, so the
 * negative cases carry as much weight as the happy path: this is the one
 * surface a third party holds credentials for.
 */
describe('the v1 API', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  /** Keys minted once in beforeAll and reused across the cases below. */
  let fullKey: string;
  let readOnlyKey: string;
  let writeNoAdminKey: string;

  const adminAuth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  async function mintKey(name: string, scopes: string[]): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/api-keys',
      headers: adminAuth(),
      payload: { name, scopes, expiresInDays: 30 },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as CreatedApiKey).token;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-api-test-'));
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

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'archivist', password: 'a-long-enough-password' },
    });
    const raw = setup.headers['set-cookie'];
    admin = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: (setup.json() as { csrfToken: string }).csrfToken,
    };

    fullKey = await mintKey('full', [
      'users:read',
      'users:write',
      'users:admin',
      'invites:write',
      'games:read',
      'stats:read',
    ]);
    readOnlyKey = await mintKey('read only', ['users:read']);
    writeNoAdminKey = await mintKey('provisioner', ['users:read', 'users:write', 'invites:write']);
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------ authentication */

  it('issues a key whose plaintext is returned exactly once', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/api-keys',
      headers: adminAuth(),
      payload: { name: 'one-shot', scopes: ['stats:read'], expiresInDays: 1 },
    });
    const created = response.json() as CreatedApiKey;
    expect(created.token.startsWith(API_KEY_PREFIX)).toBe(true);

    // The listing must never carry it back, and the stored row must not hold
    // the plaintext at all.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/api-keys',
      headers: adminAuth(),
    });
    expect(listed.payload).not.toContain(created.token);

    const stored = app.gameblade.db.select().from(apiKeys).where(eq(apiKeys.id, created.id)).get();
    expect(stored?.tokenHash).toBeDefined();
    expect(stored?.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(stored)).not.toContain(created.token.slice(API_KEY_PREFIX.length));
  });

  it('rejects a request with no key, a junk key, or a non-bearer scheme', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer gbk_totally-made-up' },
      { authorization: 'Basic Z2I6Z2I=' },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/whoami', headers });
      expect(response.statusCode).toBe(401);
    }
  });

  it('does not accept an admin session cookie in place of a key', async () => {
    // The whole point of a separate surface: an authenticated browser must not
    // be able to reach the integration API, or a malicious page could.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it('reports its own name and scopes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: bearer(readOnlyKey),
    });
    expect(response.json()).toEqual({ name: 'read only', scopes: ['users:read'] });
  });

  it('stops accepting a key once it is revoked', async () => {
    const token = await mintKey('short lived', ['stats:read']);
    const listed = (
      await app.inject({ method: 'GET', url: '/api/admin/api-keys', headers: adminAuth() })
    ).json() as Array<{ id: string; name: string }>;
    const id = listed.find((key) => key.name === 'short lived')?.id as string;

    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/stats', headers: bearer(token) }))
        .statusCode,
    ).toBe(200);

    await app.inject({
      method: 'POST',
      url: `/api/admin/api-keys/${id}/revoke`,
      headers: adminAuth(),
    });

    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/stats', headers: bearer(token) }))
        .statusCode,
    ).toBe(401);
  });

  it('stops accepting a key once it has expired', async () => {
    const token = await mintKey('expiring', ['stats:read']);
    app.gameblade.db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(apiKeys.name, 'expiring'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stats',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps key management away from a non-admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/api-keys',
      headers: bearer(fullKey),
    });
    // The admin panel takes sessions, not API keys — so this is unauthenticated
    // rather than merely forbidden.
    expect(response.statusCode).toBe(401);
  });

  /* ------------------------------------------------------------- scopes */

  it('refuses an endpoint the key has no scope for', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(readOnlyKey),
      payload: { username: 'nope', password: 'a-long-enough-password' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('users:write') },
    });
  });

  /* -------------------------------------------------------- provisioning */

  it('provisions an account and generates a password when none is given', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(writeNoAdminKey),
      payload: { username: 'provisioned' },
    });
    expect(response.statusCode).toBe(201);

    const body = response.json() as PublicUser & { generatedPassword?: string };
    expect(body.username).toBe('provisioned');
    expect(body.role).toBe('user');
    expect(body.generatedPassword).toBeTruthy();

    // The generated password must actually work.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'provisioned', password: body.generatedPassword },
    });
    expect(signIn.statusCode).toBe(200);
  });

  it('echoes no password back when the caller supplied one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(writeNoAdminKey),
      payload: { username: 'byo-password', password: 'a-long-enough-password' },
    });
    expect(response.json()).not.toHaveProperty('generatedPassword');
  });

  it('will not let a users:write key mint an administrator', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(writeNoAdminKey),
      payload: { username: 'sneaky-admin', role: 'admin' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('users:admin') },
    });
  });

  it('will not let a users:write key promote an existing account', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(writeNoAdminKey),
      payload: { username: 'promote-me' },
    });
    const id = (created.json() as PublicUser).id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: bearer(writeNoAdminKey),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets a users:admin key mint an administrator', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(fullKey),
      payload: { username: 'second-admin', role: 'admin' },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as PublicUser).role).toBe('admin');
  });

  it('refuses to remove the last remaining administrator', async () => {
    // 'second-admin' exists from the case above, so demote it first to get back
    // to exactly one, then try to take that one away.
    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/users?role=admin',
        headers: bearer(fullKey),
      })
    ).json() as { items: PublicUser[] };

    const extra = list.items.find((user) => user.username === 'second-admin');
    if (extra) {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${extra.id}`,
        headers: bearer(fullKey),
        payload: { role: 'user' },
      });
    }

    const original = list.items.find((user) => user.username === 'archivist') as PublicUser;
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${original.id}`,
      headers: bearer(fullKey),
    });
    expect(response.statusCode).toBe(409);
  });

  it('deactivating over the API also ends that account’s sessions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(writeNoAdminKey),
      payload: { username: 'to-disable' },
    });
    const body = created.json() as PublicUser & { generatedPassword: string };

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'to-disable', password: body.generatedPassword },
    });
    const raw = login.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';

    expect(
      (await app.inject({ method: 'GET', url: '/api/home', headers: { cookie } })).statusCode,
    ).toBe(200);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${body.id}`,
      headers: bearer(writeNoAdminKey),
      payload: { isActive: false },
    });

    expect(
      (await app.inject({ method: 'GET', url: '/api/home', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  /* -------------------------------------------------------------- reads */

  it('lists and filters users', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/api/v1/users?limit=100',
      headers: bearer(readOnlyKey),
    });
    const body = all.json() as { items: PublicUser[]; total: number };
    expect(body.total).toBeGreaterThan(1);
    // A listing must never carry password material of any kind.
    expect(all.payload).not.toContain('passwordHash');

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/users?query=provisioned',
      headers: bearer(readOnlyKey),
    });
    const found = (filtered.json() as { items: PublicUser[] }).items;
    expect(found).toHaveLength(1);
    expect(found[0]?.username).toBe('provisioned');
  });

  it('generates an invite code', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: bearer(writeNoAdminKey),
      payload: { role: 'user', maxUses: 3, expiresInDays: 7 },
    });
    expect(response.statusCode).toBe(201);

    const invite = response.json() as { code: string; maxUses: number };
    expect(invite.code).toMatch(/^[A-Z0-9]+$/);
    expect(invite.maxUses).toBe(3);

    // And it must actually work for registering.
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'via-invite',
        password: 'a-long-enough-password',
        inviteCode: invite.code,
      },
    });
    expect(registered.statusCode).toBe(201);
  });

  it('refuses an administrator invite without users:admin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: bearer(writeNoAdminKey),
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('reports server statistics', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stats',
      headers: bearer(fullKey),
    });
    const body = response.json() as { users: { total: number }; games: { total: number } };
    expect(body.users.total).toBeGreaterThan(0);
    expect(body.games.total).toBe(0);
  });

  it('lists the catalog without per-user flags leaking in', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/games',
      headers: bearer(fullKey),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 0, items: [] });
  });

  it('records when a key was last used', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/whoami', headers: bearer(readOnlyKey) });
    const row = app.gameblade.db.select().from(apiKeys).where(eq(apiKeys.name, 'read only')).get();
    expect(row?.lastUsedAt).toBeTruthy();
  });

  it('leaves the administrator account itself untouched by all of this', async () => {
    const row = app.gameblade.db.select().from(users).where(eq(users.username, 'archivist')).get();
    expect(row?.role).toBe('admin');
    expect(row?.isActive).toBe(true);
  });
});
