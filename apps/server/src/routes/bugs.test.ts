import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type BugReportInfo } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

interface Session {
  cookie: string;
  csrf: string;
  id: string;
}

/**
 * Bug reports.
 *
 * This archive is tested by the people using it, so the tests that matter are
 * about the loop staying closed: an operator sees what was reported with the
 * detail they need, and the reporter hears back.
 */
describe('bug reports', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: Session;
  let player: Session;
  let other: Session;

  const auth = (s: Session) => ({ cookie: s.cookie, [CSRF_HEADER]: s.csrf });

  const signIn = async (username: string, password: string): Promise<Session> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    });
    const raw = res.headers['set-cookie'];
    const body = res.json() as { csrfToken: string; user: { id: string } };
    return {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
      id: body.user.id,
    };
  };

  const register = async (username: string): Promise<Session> => {
    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(admin),
      payload: { maxUses: 1 },
    });
    const { code } = invite.json() as { code: string };
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'another-long-password', inviteCode: code },
    });
    return signIn(username, 'another-long-password');
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-bugs-test-'));
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
    const body = setup.json() as { csrfToken: string; user: { id: string } };
    admin = {
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
      id: body.user.id,
    };

    player = await register('player');
    other = await register('other');
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const file = (session: Session, over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/bugs',
      headers: auth(session),
      payload: {
        title: 'Downloads stall at 90%',
        body: 'Every time, on the same game.',
        severity: 'broken',
        clientVersion: '0.4.3',
        platform: 'Windows 11 x64',
        diagnostics: 'TypeError: cannot read x',
        ...over,
      },
    });

  it('files a report and keeps the diagnostics the client sent', async () => {
    const response = await file(player);
    expect(response.statusCode).toBe(201);

    const list = (
      await app.inject({ method: 'GET', url: '/api/admin/bugs', headers: auth(admin) })
    ).json() as BugReportInfo[];

    expect(list[0]).toMatchObject({
      title: 'Downloads stall at 90%',
      status: 'open',
      clientVersion: '0.4.3',
      platform: 'Windows 11 x64',
      diagnostics: 'TypeError: cannot read x',
    });
  });

  it('does not echo diagnostics or the reporter back to a player', async () => {
    // A reporter has no use for their own machine details repeated at them,
    // and no business seeing anyone else's.
    const mine = (
      await app.inject({ method: 'GET', url: '/api/bugs/mine', headers: auth(player) })
    ).json() as BugReportInfo[];

    expect(mine[0]?.diagnostics).toBeNull();
    expect(mine[0]?.reporter).toBeNull();
  });

  it('shows a player only their own reports', async () => {
    await file(other, { title: 'Someone else’s problem' });

    const mine = (
      await app.inject({ method: 'GET', url: '/api/bugs/mine', headers: auth(player) })
    ).json() as BugReportInfo[];

    expect(mine.every((report) => report.title !== 'Someone else’s problem')).toBe(true);
  });

  it('tells the reporter when the status changes', async () => {
    // The whole point: someone who never hears back stops reporting.
    const list = (
      await app.inject({ method: 'GET', url: '/api/admin/bugs', headers: auth(admin) })
    ).json() as BugReportInfo[];
    const target = list.find((report) => report.title === 'Downloads stall at 90%');

    await app.inject({
      method: 'PUT',
      url: `/api/admin/bugs/${target?.id}`,
      headers: auth(admin),
      payload: { status: 'fixed', reply: 'Resume logic was off by a chunk. Update to 0.4.4.' },
    });

    const notifications = (
      await app.inject({
        method: 'GET',
        url: '/api/notifications?limit=10',
        headers: { cookie: player.cookie },
      })
    ).json() as { items: Array<{ kind: string; title: string; body: string | null }> };

    const notice = notifications.items.find((item) => item.kind === 'bug-report');
    expect(notice?.title).toContain('Fixed');
    expect(notice?.body).toContain('off by a chunk');
  });

  it('shows the reporter the reply on their own report', async () => {
    const mine = (
      await app.inject({ method: 'GET', url: '/api/bugs/mine', headers: auth(player) })
    ).json() as BugReportInfo[];
    const report = mine.find((entry) => entry.title === 'Downloads stall at 90%');

    expect(report).toMatchObject({ status: 'fixed' });
    expect(report?.reply).toContain('off by a chunk');
  });

  it('filters the queue by status', async () => {
    const open = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/bugs?status=open',
        headers: auth(admin),
      })
    ).json() as BugReportInfo[];

    expect(open.every((report) => report.status === 'open')).toBe(true);
  });

  it('counts unanswered reports on the health page', async () => {
    const report = (
      await app.inject({ method: 'GET', url: '/api/admin/health', headers: auth(admin) })
    ).json() as { findings: Array<{ id: string; count?: number }> };

    expect(report.findings.find((finding) => finding.id === 'open-bugs')?.count).toBe(1);
  });

  it('keeps the queue and triage to administrators', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/bugs', headers: auth(player) }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/admin/bugs/anything',
          headers: auth(player),
          payload: { status: 'fixed' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('rejects a report with nothing in it', async () => {
    const response = await file(player, { title: 'x', body: '' });
    expect(response.statusCode).toBe(400);
  });
});
