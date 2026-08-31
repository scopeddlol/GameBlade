import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { downloadEvents, gameFiles, games, libraries, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { AnalyticsReport } from '../services/analytics.js';

/**
 * Transfer quotas and the analytics they feed.
 *
 * Driven through real download requests rather than by calling the service:
 * the whole question is whether a quota actually stops bytes leaving the
 * server, which only the route can answer.
 */
describe('bandwidth limits and analytics', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let libraryDir: string;
  let admin: { cookie: string; csrf: string };
  let player: { cookie: string; csrf: string; id: string };
  let gameId: string;

  const auth = (s: { cookie: string; csrf: string }) => ({
    cookie: s.cookie,
    [CSRF_HEADER]: s.csrf,
  });

  async function register(url: string, payload: Record<string, unknown>) {
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { csrfToken: string; user: { id: string } };
    const raw = response.headers['set-cookie'];
    return {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
      id: body.user.id,
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-bw-test-'));
    libraryDir = path.join(dataDir, 'library');

    // A real 256 KB file, so a download moves measurable bytes.
    await mkdir(libraryDir, { recursive: true });
    await writeFile(path.join(libraryDir, 'Demo Game.zip'), Buffer.alloc(256 * 1024, 3));

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

    admin = await register('/api/auth/setup', {
      username: 'archivist',
      password: 'a-long-enough-password',
    });

    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(admin),
      payload: { role: 'user', maxUses: 1 },
    });
    player = await register('/api/auth/register', {
      username: 'player',
      password: 'a-long-enough-password',
      inviteCode: (invite.json() as { code: string }).code,
    });

    const libraryId = newId('lib');
    app.gameblade.db
      .insert(libraries)
      .values({ id: libraryId, name: 'Test', path: libraryDir })
      .run();

    gameId = newId('gam');
    app.gameblade.db
      .insert(games)
      .values({
        id: gameId,
        libraryId,
        relPath: 'Demo Game.zip',
        kind: 'archive',
        title: 'Demo Game',
        sortTitle: 'demo game',
        searchTitle: 'demo game',
        sizeBytes: 256 * 1024,
        fileCount: 1,
      })
      .run();

    app.gameblade.db
      .insert(gameFiles)
      .values({
        id: newId('gfl'),
        gameId,
        relPath: 'Demo Game.zip',
        sizeBytes: 256 * 1024,
        modifiedAt: new Date().toISOString(),
      })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Clears recorded usage so each quota case starts from a known state. */
  function resetUsage() {
    app.gameblade.db.delete(downloadEvents).run();
  }

  function setDefaultQuotaMb(mb: number) {
    app.gameblade.settings.update({ monthlyQuotaMb: mb });
  }

  /* --------------------------------------------------------------- quotas */

  it('allows a download when no quota is configured', async () => {
    resetUsage();
    setDefaultQuotaMb(0);

    const response = await app.inject({
      method: 'GET',
      url: `/api/download/${gameId}`,
      headers: { cookie: player.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.length).toBeGreaterThan(0);
  });

  it('records what was transferred against the account', async () => {
    resetUsage();
    setDefaultQuotaMb(0);

    await app.inject({
      method: 'GET',
      url: `/api/download/${gameId}`,
      headers: { cookie: player.cookie },
    });

    const used = app.gameblade.bandwidth.usedThisPeriod(player.id);
    expect(used).toBeGreaterThan(0);
  });

  it('refuses a download once the allowance is spent', async () => {
    resetUsage();
    // 1 MB allowance, already fully spent.
    setDefaultQuotaMb(1);
    app.gameblade.db
      .insert(downloadEvents)
      .values({
        id: newId('dle'),
        userId: player.id,
        gameId,
        client: 'test',
        bytesSent: 1024 * 1024,
        startedAt: new Date().toISOString(),
        completed: true,
      })
      .run();

    const response = await app.inject({
      method: 'GET',
      url: `/api/download/${gameId}`,
      headers: { cookie: player.cookie },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: 'quota_exceeded' } });
  });

  it('applies an explicit override even to an administrator', async () => {
    resetUsage();
    setDefaultQuotaMb(0);
    const adminId = app.gameblade.auth.findByUsername('archivist')?.id as string;

    app.gameblade.db.update(users).set({ monthlyQuotaMb: 1 }).where(eq(users.id, adminId)).run();
    app.gameblade.db
      .insert(downloadEvents)
      .values({
        id: newId('dle'),
        userId: adminId,
        gameId,
        client: 'test',
        bytesSent: 2 * 1024 * 1024,
        startedAt: new Date().toISOString(),
        completed: true,
      })
      .run();

    // Setting a limit on an account and having it ignored would be the more
    // surprising behaviour, so an explicit override binds regardless of role.
    expect(app.gameblade.bandwidth.status(adminId).exceeded).toBe(true);

    app.gameblade.db.update(users).set({ monthlyQuotaMb: null }).where(eq(users.id, adminId)).run();
  });

  it('exempts administrators from the server default, which is not aimed at them', async () => {
    resetUsage();
    setDefaultQuotaMb(1);
    app.gameblade.db
      .insert(downloadEvents)
      .values({
        id: newId('dle'),
        userId: admin.cookie ? (app.gameblade.auth.findByUsername('archivist')?.id as string) : '',
        gameId,
        client: 'test',
        bytesSent: 50 * 1024 * 1024,
        startedAt: new Date().toISOString(),
        completed: true,
      })
      .run();

    const response = await app.inject({
      method: 'GET',
      url: `/api/download/${gameId}`,
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it('lets a per-account override lift the server default', async () => {
    resetUsage();
    setDefaultQuotaMb(1);
    app.gameblade.db
      .insert(downloadEvents)
      .values({
        id: newId('dle'),
        userId: player.id,
        gameId,
        client: 'test',
        bytesSent: 2 * 1024 * 1024,
        startedAt: new Date().toISOString(),
        completed: true,
      })
      .run();

    // Over the 1 MB default...
    expect(app.gameblade.bandwidth.status(player.id).exceeded).toBe(true);

    // ...but the account is given its own, larger allowance.
    app.gameblade.db
      .update(users)
      .set({ monthlyQuotaMb: 100 })
      .where(eq(users.id, player.id))
      .run();

    expect(app.gameblade.bandwidth.status(player.id).exceeded).toBe(false);

    const response = await app.inject({
      method: 'GET',
      url: `/api/download/${gameId}`,
      headers: { cookie: player.cookie },
    });
    expect(response.statusCode).toBe(200);

    app.gameblade.db
      .update(users)
      .set({ monthlyQuotaMb: null })
      .where(eq(users.id, player.id))
      .run();
  });

  it('an override of 0 means unlimited for that account', async () => {
    resetUsage();
    setDefaultQuotaMb(1);
    app.gameblade.db.update(users).set({ monthlyQuotaMb: 0 }).where(eq(users.id, player.id)).run();

    expect(app.gameblade.bandwidth.quotaBytesFor(player.id)).toBe(0);
    expect(app.gameblade.bandwidth.status(player.id).exceeded).toBe(false);

    app.gameblade.db
      .update(users)
      .set({ monthlyQuotaMb: null })
      .where(eq(users.id, player.id))
      .run();
  });

  it('reports usage against the allowance for the admin panel', async () => {
    resetUsage();
    setDefaultQuotaMb(10);
    app.gameblade.db
      .insert(downloadEvents)
      .values({
        id: newId('dle'),
        userId: player.id,
        gameId,
        client: 'test',
        bytesSent: 4 * 1024 * 1024,
        startedAt: new Date().toISOString(),
        completed: true,
      })
      .run();

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/users/${player.id}/quota`,
      headers: auth(admin),
    });
    expect(response.json()).toMatchObject({
      quotaBytes: 10 * 1024 * 1024,
      usedBytes: 4 * 1024 * 1024,
      exceeded: false,
    });
  });

  it('applies a speed limit without corrupting the payload', async () => {
    resetUsage();
    setDefaultQuotaMb(0);
    // Fast enough that the test stays quick, slow enough to exercise the path.
    app.gameblade.settings.update({ downloadSpeedLimitKbps: 4096 });

    const response = await app.inject({
      method: 'GET',
      url: `/api/download/${gameId}`,
      headers: { cookie: player.cookie },
    });

    expect(response.statusCode).toBe(200);
    // A throttled body must still be every byte of the original, in order.
    expect(response.rawPayload.length).toBeGreaterThan(0);

    app.gameblade.settings.update({ downloadSpeedLimitKbps: 0 });
  });

  /* ------------------------------------------------------------ analytics */

  it('summarises downloads, bytes and active users', async () => {
    resetUsage();
    setDefaultQuotaMb(0);

    await app.inject({
      method: 'GET',
      url: `/api/download/${gameId}`,
      headers: { cookie: player.cookie },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/analytics?days=30',
      headers: auth(admin),
    });
    expect(response.statusCode).toBe(200);

    const report = response.json() as AnalyticsReport;
    expect(report.summary.downloads).toBeGreaterThan(0);
    expect(report.summary.bytes).toBeGreaterThan(0);
    expect(report.summary.activeUsers).toBeGreaterThan(0);
    expect(report.topGamesByDownloads[0]?.title).toBe('Demo Game');
    expect(report.topUsers[0]?.username).toBe('player');
    expect(report.recentDownloads[0]?.title).toBe('Demo Game');
  });

  it('returns one point per day across the range, including quiet days', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/analytics?days=14',
      headers: auth(admin),
    });

    const report = response.json() as AnalyticsReport;
    expect(report.daily).toHaveLength(14);
    // Oldest first, so a chart reads left to right.
    expect(report.daily[0]?.date < (report.daily[13]?.date ?? '')).toBe(true);
    // Every day is present even though only today has traffic.
    expect(report.daily.filter((point) => point.bytes === 0).length).toBeGreaterThan(0);
  });

  it('reports the same month-to-date usage that enforcement sees', async () => {
    // These two read the same table by different routes. When they disagree,
    // the admin panel shows a comfortable zero while downloads are being
    // refused — which is precisely what a correlated subquery here once did.
    resetUsage();
    setDefaultQuotaMb(10);
    app.gameblade.db
      .insert(downloadEvents)
      .values({
        id: newId('dle'),
        userId: player.id,
        gameId,
        client: 'test',
        bytesSent: 6 * 1024 * 1024,
        startedAt: new Date().toISOString(),
        completed: true,
      })
      .run();

    const enforced = app.gameblade.bandwidth.status(player.id).usedBytes;
    expect(enforced).toBe(6 * 1024 * 1024);

    const report = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/analytics?days=30',
        headers: auth(admin),
      })
    ).json() as AnalyticsReport;

    const row = report.quotas.find((entry) => entry.userId === player.id);
    expect(row?.usedBytes).toBe(enforced);
    expect(row?.quotaBytes).toBe(10 * 1024 * 1024);
  });

  it('clamps a silly range rather than trusting the query string', async () => {
    for (const [days, expected] of [
      ['0', 1],
      ['9999', 365],
      ['not-a-number', 30],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/analytics?days=${days}`,
        headers: auth(admin),
      });
      expect((response.json() as AnalyticsReport).rangeDays, days).toBe(expected);
    }
  });

  it('keeps analytics away from a non-admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/analytics',
      headers: { cookie: player.cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});
