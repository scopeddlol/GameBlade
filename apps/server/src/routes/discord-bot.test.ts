import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { discordTickets } from '../db/schema.js';

/**
 * The bot half: the switch, the presence, and the tickets behind it.
 *
 * Everything that talks to Discord itself is out of reach here, so what these
 * pin down is the half that is ours: that the switch is remembered across a
 * restart, that a presence edit is stored in the shape the gateway sends, that
 * the settings which decide who can see a ticket channel are validated, and
 * that a ticket record outlives the channel it was opened in.
 */
describe('the Discord bot', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-discord-bot-test-'));
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

  /* --------------------------------------------------------------- the switch */

  it('refuses to start without a token rather than sitting in "connecting"', async () => {
    // A bot with no token can never connect, and a switch that flips anyway
    // leaves the panel reporting a state the bot will never reach.
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/discord/bot/start',
      headers: auth(),
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(/token/i);
  });

  it('reports itself stopped before anyone starts it', async () => {
    const config = (
      await app.inject({ method: 'GET', url: '/api/admin/discord', headers: auth() })
    ).json() as { bot: { state: string; enabled: boolean } };

    expect(config.bot).toMatchObject({ state: 'stopped', enabled: false });
  });

  it('remembers being switched off, so a restart does not turn it back on', async () => {
    app.gameblade.settings.update({ discordBotToken: 'a-bot-token' });

    // Not asserting it reaches "ready" — that needs Discord. What matters is
    // that the operator's choice is persisted rather than held in memory.
    await app.inject({
      method: 'POST',
      url: '/api/admin/discord/bot/start',
      headers: auth(),
    });
    expect(app.gameblade.settings.get().discordBotEnabled).toBe(true);

    await app.inject({
      method: 'POST',
      url: '/api/admin/discord/bot/stop',
      headers: auth(),
    });
    expect(app.gameblade.settings.get().discordBotEnabled).toBe(false);
    expect(app.gameblade.discordBot.status.state).toBe('stopped');
  });

  /* ----------------------------------------------------------------- presence */

  it('stores an activity and previews it the way Discord will read it', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/discord/bot/presence',
      headers: auth(),
      payload: { status: 'dnd', activityType: 2, activityName: 'the archive grow' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { preview: string }).preview).toBe('Listening to the archive grow');

    const settings = app.gameblade.settings.get();
    expect(settings.discordPresenceStatus).toBe('dnd');
    expect(settings.discordActivityType).toBe(2);
  });

  it('treats a custom status as its own text rather than prefixing it', async () => {
    // Type 4 is the odd one out: its text goes in `state`, and Discord shows
    // it bare. "Custom keeping the lights on" would be wrong.
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/discord/bot/presence',
      headers: auth(),
      payload: { activityType: 4, activityName: 'keeping the lights on' },
    });
    expect((response.json() as { preview: string }).preview).toBe('keeping the lights on');
  });

  it('drops the activity line entirely when the name is cleared', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/discord/bot/presence',
      headers: auth(),
      payload: { activityName: '' },
    });
    expect((response.json() as { preview: string | null }).preview).toBeNull();
  });

  it('refuses an activity type Discord does not have', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/discord/bot/presence',
      headers: auth(),
      payload: { activityType: 99 },
    });
    expect(response.statusCode).toBe(400);
  });

  /* ------------------------------------------------------------------ posting */

  it('will not post an announcement that is neither text nor picture', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/discord/announce',
      headers: auth(),
      payload: { message: '' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(/attach/i);
  });

  /* ------------------------------------------------------------------ tickets */

  it('will not publish a panel whose button is switched off', async () => {
    // The panel is a message and outlives the setting that produced it, so a
    // panel posted while tickets are off is a button that refuses every press.
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/discord/tickets/panel',
      headers: auth(),
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(
      /turn tickets on/i,
    );
  });

  it('will not publish a ticket panel with nowhere to publish it', async () => {
    app.gameblade.settings.update({ discordTicketsEnabled: true });
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/discord/tickets/panel',
      headers: auth(),
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(
      /support channel/i,
    );
    app.gameblade.settings.update({ discordTicketsEnabled: false });
  });

  it('stores the ticket settings that decide who can see a ticket', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/discord/tickets/settings',
      headers: auth(),
      payload: {
        enabled: true,
        supportChannelId: '555',
        categoryId: '666',
        staffRoleId: '777',
        panelTitle: 'Need a hand?',
      },
    });
    expect(response.statusCode).toBe(200);

    const settings = app.gameblade.settings.get();
    expect(settings.discordSupportChannelId).toBe('555');
    expect(settings.discordTicketCategoryId).toBe('666');
    // The staff role is what grants anyone but the opener access to the
    // channel; losing it silently would make every ticket private to one person.
    expect(settings.discordStaffRoleId).toBe('777');
  });

  /**
   * A ticket outlives its channel.
   *
   * Closing deletes the channel — otherwise the server fills with dead
   * #ticket-0042 channels — so the row is the only record that the
   * conversation ever happened, and it has to survive with the channel id
   * cleared rather than pointing at something that no longer exists.
   */
  it('keeps a closed ticket as a record with no channel behind it', async () => {
    const db = app.gameblade.db;
    db.insert(discordTickets)
      .values({
        id: 'tkt_1',
        number: 1,
        guildId: '1',
        channelId: 'chan_1',
        openerDiscordId: '42',
        openerName: 'someone',
        subject: 'It will not install',
        status: 'open',
      })
      .run();
    db.insert(discordTickets)
      .values({
        id: 'tkt_2',
        number: 2,
        guildId: '1',
        channelId: null,
        openerDiscordId: '43',
        openerName: 'someone-else',
        subject: 'Fixed itself',
        status: 'closed',
        closedAt: new Date().toISOString(),
        closedBy: 'archivist',
      })
      .run();

    const all = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/discord/tickets',
        headers: auth(),
      })
    ).json() as {
      tickets: Array<{ number: number; status: string; channelId: string | null }>;
      counts: { open: number; closed: number };
    };

    expect(all.counts).toEqual({ open: 1, closed: 1 });
    expect(all.tickets.find((t) => t.number === 2)?.channelId).toBeNull();

    const open = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/discord/tickets?status=open',
        headers: auth(),
      })
    ).json() as { tickets: Array<{ number: number }> };

    expect(open.tickets.map((t) => t.number)).toEqual([1]);
  });

  /* -------------------------------------------------------------------- access */

  it('keeps every one of these away from anyone who is not an administrator', async () => {
    for (const [method, url] of [
      ['POST', '/api/admin/discord/bot/start'],
      ['POST', '/api/admin/discord/bot/stop'],
      ['PATCH', '/api/admin/discord/bot/presence'],
      ['GET', '/api/admin/discord/channels'],
      ['GET', '/api/admin/discord/tickets'],
      ['POST', '/api/admin/discord/tickets/panel'],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
