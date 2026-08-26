import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type ProfileDetail, type ProfileSummary } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { discordLinks } from '../db/schema.js';

/**
 * Showing a Discord handle on a profile.
 *
 * The bug: the toggle wrote its value, the friends rail honoured it, and the
 * profile page — the one thing it is named after — did not. `detail()` built
 * its own summary rather than going through the batch path, and the batch path
 * was the only place the handle was ever attached. So somebody ticked "show my
 * Discord on my profile", opened their profile, and saw exactly what they saw
 * before.
 */
describe('a Discord handle on a profile', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string; id: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  const profile = async (): Promise<ProfileDetail> =>
    (
      await app.inject({ method: 'GET', url: `/api/profiles/${admin.id}`, headers: auth() })
    ).json() as ProfileDetail;

  const setVisibility = (showUsername: boolean) =>
    app.inject({
      method: 'PATCH',
      url: '/api/account/discord',
      headers: auth(),
      payload: { showUsername },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-profile-discord-test-'));
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

    // Stands in for the OAuth round trip, which is not what is under test here.
    app.gameblade.db
      .insert(discordLinks)
      .values({
        userId: admin.id,
        discordId: '111111111111111111',
        username: 'archivist#0',
        globalName: 'Archivist',
        avatar: null,
        showUsername: false,
        inGuild: true,
      })
      .run();
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('shows nothing while the toggle is off', async () => {
    await setVisibility(false);
    expect((await profile()).discordUsername ?? null).toBeNull();
  });

  it('shows the handle on the profile page once the toggle is on', async () => {
    const response = await setVisibility(true);
    expect(response.statusCode).toBe(200);

    // The assertion the bug was hiding from: the profile page, not the rail.
    expect((await profile()).discordUsername).toBe('archivist#0');
  });

  it('shows it in the browsable member list too, so the answer is the same everywhere', async () => {
    await setVisibility(true);

    const members = (
      await app.inject({ method: 'GET', url: '/api/members', headers: auth() })
    ).json() as { items: ProfileSummary[] };

    const self = members.items.find((entry) => entry.userId === admin.id);
    expect(self?.discordUsername).toBe('archivist#0');
  });

  it('takes it off everywhere again when the toggle goes off', async () => {
    await setVisibility(false);
    expect((await profile()).discordUsername ?? null).toBeNull();

    const members = (
      await app.inject({ method: 'GET', url: '/api/members', headers: auth() })
    ).json() as { items: ProfileSummary[] };
    expect(
      members.items.find((entry) => entry.userId === admin.id)?.discordUsername ?? null,
    ).toBeNull();
  });
});
