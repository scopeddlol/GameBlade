import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * Linking a Discord account, and using one to get in.
 *
 * The parts worth pinning down are the ones that decide who gets to be whom:
 * the state check that stops a code obtained elsewhere being replayed against
 * somebody else's session, the refusal to mint accounts on an invite-only
 * server, and the handle staying private until its owner says otherwise.
 */
describe('discord', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-discord-test-'));
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
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------ unconfigured */

  it('reports itself as unconfigured before an operator sets it up', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/discord/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: false, hasBot: false });
  });

  it('will not start a round trip with no application configured', async () => {
    // Otherwise the player is sent to a Discord URL with an empty client id
    // and gets Discord's own error page rather than ours.
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/discord/start',
      headers: auth(),
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain(
      'not set up',
    );
  });

  /* ----------------------------------------------------------------- state */

  describe('once configured', () => {
    beforeAll(() => {
      app.gameblade.settings.update({
        discordClientId: '123456789',
        discordClientSecret: 'a-secret',
        discordGuildId: '987654321',
        discordInviteUrl: 'https://discord.gg/example',
      });
    });

    it('hands back an authorize URL and sets a state cookie', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/discord/start',
        headers: auth(),
      });
      expect(response.statusCode).toBe(200);

      const { url } = response.json() as { url: string };
      // The consent screen, not the REST API. Building this from the API base
      // sent everyone to /api/v10/oauth2/authorize, which answers no GET — so
      // the screen never appeared and nothing downstream could ever run.
      expect(url.startsWith('https://discord.com/oauth2/authorize?')).toBe(true);
      expect(url).not.toContain('/api/');
      expect(url).toContain('client_id=123456789');
      // The scopes are the whole security surface of the integration.
      expect(url).toContain('identify');
      expect(url).toContain('guilds.join');
      // Nothing about messages or email is ever requested.
      expect(url).not.toContain('email');

      const cookies = String(response.headers['set-cookie']);
      expect(cookies).toContain('gb_discord_state');
    });

    it('refuses a callback whose state does not match the cookie', async () => {
      // This is the check that stops a code obtained anywhere being replayed
      // against someone else's session to attach an attacker's Discord to it.
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/discord/callback?code=abc&state=not-the-one',
        headers: { cookie: 'gb_discord_state=the-real-one' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('expired');
      expect(response.body).not.toContain('Discord connected');
    });

    it('refuses a callback with no state cookie at all', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/discord/callback?code=abc&state=anything',
      });
      expect(response.body).toContain('expired');
    });

    it('says so plainly when the visitor cancelled at Discord', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/discord/callback?error=access_denied',
      });
      expect(response.body).toContain('cancelled');
    });

    /**
     * The landing page used to end at "you can close this window", which in an
     * ordinary tab is a dead end with the panel nowhere in reach.
     */
    it('sends a browser tab back to the account page after linking', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/discord/callback?error=access_denied',
        // No intent cookie means link, which is where the account page is.
      });
      expect(response.body).toContain('/account');
      expect(response.body).toContain('window.location.replace');
    });

    it('sends a browser tab to the landing page after a sign-in attempt', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/discord/callback?error=access_denied',
        cookies: { gb_discord_intent: 'signin' },
      });
      expect(response.body).not.toContain('/account');
    });

    it('escapes the operator-typed invite URL into the result page', async () => {
      // The message can carry text an operator typed; it lands in HTML.
      app.gameblade.settings.update({
        discordInviteUrl: 'https://discord.gg/x"><script>alert(1)</script>',
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/discord/callback?error=access_denied',
      });
      expect(response.body).not.toContain('<script>alert(1)</script>');
      app.gameblade.settings.update({ discordInviteUrl: 'https://discord.gg/example' });
    });
  });

  /* ------------------------------------------------------------- account */

  it('reports no link before one is made', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/account/discord',
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { link: unknown }).link).toBeNull();
  });

  it('will not let a signed-out caller read or change a link', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/account/discord' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/account/discord' })).statusCode).toBe(
      401,
    );
  });

  /* ----------------------------------------------------------- announcing */

  /**
   * The new-game announcer.
   *
   * The failure that matters is not "a post did not go out" — it is a server
   * with ten thousand existing games announcing every one of them the moment
   * the operator ticks the box.
   */
  describe('announcing new games', () => {
    it('does nothing at all while no bot is configured', async () => {
      // No token means no channel to post to; it must not throw either, since
      // this runs on a timer where a throw would only fill the log.
      await expect(app.gameblade.discord.announceNewGames()).resolves.toBe(0);
    });

    it('starts the clock instead of announcing the back catalogue', async () => {
      app.gameblade.settings.update({
        discordBotToken: 'a-bot-token',
        discordChannelId: '555',
        discordAnnounceNewGames: true,
        discordLastAnnouncedAt: null,
      });

      // First run with no watermark: sets one and posts nothing, however many
      // games already exist.
      await expect(app.gameblade.discord.announceNewGames()).resolves.toBe(0);
      expect(app.gameblade.settings.get().discordLastAnnouncedAt).not.toBeNull();
    });

    it('stays quiet when the operator has switched announcements off', async () => {
      app.gameblade.settings.update({ discordAnnounceNewGames: false });
      await expect(app.gameblade.discord.announceNewGames()).resolves.toBe(0);
      app.gameblade.settings.update({ discordAnnounceNewGames: true });
    });

    it('refuses to post with no channel set rather than guessing one', async () => {
      app.gameblade.settings.update({ discordChannelId: null });
      await expect(app.gameblade.discord.post('hello')).rejects.toThrow(/channel/i);
      app.gameblade.settings.update({ discordChannelId: '555' });
    });

    it('refuses to post with no bot token rather than failing at Discord', async () => {
      app.gameblade.settings.update({ discordBotToken: null });
      await expect(app.gameblade.discord.post('hello')).rejects.toThrow(/bot token/i);
    });

    it('treats a token pasted as "Bot <token>" as configured', () => {
      // The portal copies the bare token, but every example writes it with the
      // prefix, so it gets pasted that way — and sending "Bot Bot <token>"
      // fails with a 401 that reads exactly like a wrong token.
      app.gameblade.settings.update({ discordBotToken: 'Bot a-bot-token' });
      expect(app.gameblade.discord.hasBot).toBe(true);
      app.gameblade.settings.update({ discordBotToken: '   ' });
      expect(app.gameblade.discord.hasBot).toBe(false);
      app.gameblade.settings.update({ discordBotToken: null });
    });
  });

  /* ------------------------------------------------------------ visibility */

  describe('handle visibility', () => {
    beforeAll(() => {
      // Stand in for a completed round trip; the OAuth half is Discord's.
      app.gameblade.discord.link(
        app.gameblade.auth.findByUsername('archivist')!.id,
        { id: '42', username: 'archivist#0', global_name: 'Archivist', avatar: null },
        { access_token: 'token' },
        true,
      );
    });

    it('starts hidden, because linking is not publishing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/account/discord',
        headers: auth(),
      });
      expect((response.json() as { link: { showUsername: boolean } }).link.showUsername).toBe(
        false,
      );
    });

    it('keeps the handle out of other players sight until it is turned on', () => {
      const id = app.gameblade.auth.findByUsername('archivist')!.id;
      expect(app.gameblade.discord.visibleHandleFor(id)).toBeNull();

      app.gameblade.discord.setVisibility(id, true);
      expect(app.gameblade.discord.visibleHandleFor(id)).toBe('archivist#0');

      app.gameblade.discord.setVisibility(id, false);
      expect(app.gameblade.discord.visibleHandleFor(id)).toBeNull();
    });

    it('does not republish a hidden handle when the account is linked again', () => {
      // Re-linking happens on every Discord sign-in. Quietly flipping the
      // toggle back on there would undo a deliberate choice.
      const id = app.gameblade.auth.findByUsername('archivist')!.id;
      app.gameblade.discord.setVisibility(id, false);

      app.gameblade.discord.link(
        id,
        { id: '42', username: 'archivist#0', global_name: 'Archivist', avatar: null },
        { access_token: 'token2' },
        true,
      );

      expect(app.gameblade.discord.visibleHandleFor(id)).toBeNull();
    });

    it('refuses to attach one Discord account to two accounts here', async () => {
      const other = await app.gameblade.auth.createUser({
        username: 'someone-else',
        password: 'a-long-enough-password',
        role: 'user',
      });

      expect(() =>
        app.gameblade.discord.link(
          other.id,
          { id: '42', username: 'archivist#0', global_name: null, avatar: null },
          { access_token: 'token' },
          true,
        ),
      ).toThrow(/already linked/i);
    });
  });
});
