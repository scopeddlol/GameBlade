import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const ROLE = '222222222222222222';
const USER = '111111111111111111';
const CHANNEL = '333333333333333333';

interface SentMessage {
  content?: string;
  embeds?: Array<{ title?: string; description?: string }>;
  allowed_mentions?: { parse: string[]; users: string[]; roles: string[] };
}

/**
 * Tagging people, roles and channels in what the bot posts.
 *
 * Two rules of Discord's collide here and both have to be handled, because
 * getting either wrong produces a post that looks right and behaves wrong.
 *
 * An embed never notifies. A `<@&id>` in a description renders as a role pill
 * and reaches nobody, so an announcement addressed to a role has to repeat the
 * tokens in the content carrying the embed.
 *
 * And omitting `allowed_mentions` means "notify anything that looks like a
 * mention", which is how a game summary containing the word `@everyone` would
 * ping an entire server.
 */
describe('mentions in what the bot posts', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let admin: { cookie: string; csrf: string };
  let sent: SentMessage[];

  const auth = () => ({ cookie: admin.cookie, [CSRF_HEADER]: admin.csrf });

  const announce = async (payload: Record<string, unknown>) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/discord/announce',
      headers: auth(),
      payload,
    });
    expect(response.statusCode).toBe(200);
    return sent.at(-1);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-mentions-test-'));
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

    app.gameblade.settings.update({
      discordBotToken: 'a-bot-token',
      discordChannelId: '555',
    });
  });

  beforeEach(() => {
    sent = [];
    // Stands in for Discord, capturing exactly what would have gone over the
    // wire. Nothing else in this file reaches the network.
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = init?.body;
      if (typeof body === 'string') sent.push(JSON.parse(body) as SentMessage);
      return new Response(JSON.stringify({ id: 'm1', channel_id: '555' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('permits exactly the ids the operator typed', async () => {
    const message = await announce({
      message: `Patch notes for <@&${ROLE}> — thanks <@${USER}>`,
      asEmbed: true,
    });

    expect(message?.allowed_mentions).toEqual({
      parse: [],
      users: [USER],
      roles: [ROLE],
    });
  });

  it('repeats an embed’s mentions above it, because embeds never notify', async () => {
    const message = await announce({
      title: 'Server maintenance',
      message: `<@&${ROLE}> we are going down at eight`,
      asEmbed: true,
    });

    expect(message?.content).toBe(`<@&${ROLE}>`);
    expect(message?.embeds?.[0]?.description).toContain(`<@&${ROLE}>`);
  });

  it('leaves the ping line off when the operator does not want one', async () => {
    const message = await announce({
      message: `a quiet note for <@&${ROLE}>`,
      asEmbed: true,
      pingMentions: false,
    });

    expect(message?.content).toBeUndefined();
  });

  it('does not add a ping line to a plain message, which already notifies', async () => {
    const message = await announce({
      message: `<@&${ROLE}> heads up`,
      asEmbed: false,
    });

    expect(message?.content).toBe(`<@&${ROLE}> heads up`);
    expect(message?.allowed_mentions?.roles).toEqual([ROLE]);
  });

  it('keeps a channel link out of the ping line, since it notifies nobody', async () => {
    const message = await announce({
      message: `see <#${CHANNEL}> for details`,
      asEmbed: true,
    });

    expect(message?.content).toBeUndefined();
    expect(message?.embeds?.[0]?.description).toContain(`<#${CHANNEL}>`);
  });

  it('refuses @everyone unless it was deliberately allowed', async () => {
    const denied = await announce({ message: 'hello @everyone', asEmbed: false });
    expect(denied?.allowed_mentions?.parse).toEqual([]);

    const allowed = await announce({
      message: 'hello @everyone',
      asEmbed: false,
      allowEveryone: true,
    });
    expect(allowed?.allowed_mentions?.parse).toEqual(['everyone']);
  });

  it('does not let a stray mention in ordinary prose notify anyone', async () => {
    // The realistic case: an operator pastes a blurb, or a provider summary
    // reaches an embed. Nothing here was typed as a tag, so nothing pings.
    const message = await announce({
      message: 'The @everyone achievement is now available',
      asEmbed: true,
    });

    expect(message?.allowed_mentions).toEqual({ parse: [], users: [], roles: [] });
    expect(message?.content).toBeUndefined();
  });
});
