import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * Admin-issued password resets.
 *
 * There is no mail server here, so the link is handed back to the admin to
 * pass on. That makes the token the whole credential, and the things worth
 * pinning down are that it works exactly once and says nothing useful when it
 * does not.
 */
describe('password reset links', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let adminCookie: string;
  let adminCsrf: string;
  let playerId: string;

  const auth = () => ({ cookie: adminCookie, [CSRF_HEADER]: adminCsrf });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-reset-'));
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
    const body = setup.json() as { csrfToken: string };
    const raw = setup.headers['set-cookie'];
    adminCookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
    adminCsrf = body.csrfToken;

    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(),
      payload: { role: 'user', maxUses: 1 },
    });
    const { code } = invite.json() as { code: string };

    const player = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'player', password: 'another-long-password', inviteCode: code },
    });
    playerId = (player.json() as { user: { id: string } }).user.id;
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const issue = async (): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${playerId}/password-reset`,
      headers: auth(),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { token: string }).token;
  };

  const redeem = (token: string, newPassword: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword },
    });

  const signIn = (password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'player', password },
    });

  it('hands back a link that points at the reset page', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${playerId}/password-reset`,
      headers: auth(),
      payload: {},
    });
    const body = response.json() as { token: string; path: string; expiresAt: string };
    expect(body.path).toBe(`/reset-password?token=${encodeURIComponent(body.token)}`);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('sets the new password', async () => {
    const token = await issue();
    expect((await redeem(token, 'a-brand-new-password')).statusCode).toBe(200);
    expect((await signIn('a-brand-new-password')).statusCode).toBe(200);
  });

  it('refuses to spend the same link twice', async () => {
    const token = await issue();
    expect((await redeem(token, 'first-new-password-here')).statusCode).toBe(200);

    const second = await redeem(token, 'second-new-password-here');
    expect(second.statusCode).toBe(400);
    // The old password must not have been replaced by the second attempt.
    expect((await signIn('first-new-password-here')).statusCode).toBe(200);
  });

  it('replaces an earlier unused link, so only the newest works', async () => {
    const first = await issue();
    const second = await issue();

    expect((await redeem(first, 'should-not-be-applied')).statusCode).toBe(400);
    expect((await redeem(second, 'the-newest-link-wins')).statusCode).toBe(200);
  });

  it('says nothing useful about a token that never existed', async () => {
    const response = await redeem('not-a-real-token', 'some-long-enough-password');
    expect(response.statusCode).toBe(400);
    // Same wording as a spent or expired link: no probing which links are real.
    expect((response.json() as { error: { message: string } }).error.message).toMatch(
      /no longer valid/i,
    );
  });

  it('is refused to a player asking for their own reset', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${playerId}/password-reset`,
      payload: {},
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(401);
  });
});
