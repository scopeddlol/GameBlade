import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type ConversationInfo, type MessageInfo } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { friendships, games, libraries } from '../db/schema.js';

interface Account {
  id: string;
  username: string;
  cookie: string;
  csrf: string;
}

/**
 * Replies, reactions, muting and shared games.
 *
 * The parts worth pinning down are the ones where getting it wrong leaks or
 * loses something: a reply must not be able to quote a message out of a room
 * the sender is not in, a reaction has to toggle rather than pile up, and a
 * mute has to be invisible from the other side while actually quieting the
 * badge — a mute that still lights it does nothing at all.
 */
describe('chat features', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let alice: Account;
  let bob: Account;
  let carol: Account;
  let conversation: ConversationInfo;

  const auth = (account: Account) => ({ cookie: account.cookie, [CSRF_HEADER]: account.csrf });

  const register = async (username: string): Promise<Account> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'a-long-enough-password' },
    });
    const raw = response.headers['set-cookie'];
    const body = response.json() as { csrfToken: string; user: { id: string } };
    return {
      id: body.user.id,
      username,
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
    };
  };

  const befriend = (a: Account, b: Account) => {
    const [first, second] = [a.id, b.id].sort();
    app.gameblade.db
      .insert(friendships)
      .values({
        id: `frn_${first}_${second}`,
        userAId: first as string,
        userBId: second as string,
        status: 'accepted',
        requestedBy: a.id,
        createdAt: new Date().toISOString(),
      })
      .run();
  };

  const send = async (account: Account, conversationId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversationId}/messages`,
      headers: auth(account),
      payload,
    });

  const history = async (account: Account, conversationId: string): Promise<MessageInfo[]> =>
    (
      (
        await app.inject({
          method: 'GET',
          url: `/api/messages/conversations/${conversationId}/messages`,
          headers: auth(account),
        })
      ).json() as { messages: MessageInfo[] }
    ).messages;

  const unread = async (account: Account): Promise<number> =>
    (
      (
        await app.inject({ method: 'GET', url: '/api/messages/unread', headers: auth(account) })
      ).json() as { unread: number }
    ).unread;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-chat-test-'));
    app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
        SCAN_ON_START: 'false',
        SCAN_INTERVAL_MINUTES: '0',
        ALLOW_SELF_REGISTRATION: 'true',
      } as NodeJS.ProcessEnv),
    );
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'archivist', password: 'a-long-enough-password' },
    });
    app.gameblade.settings.update({ allowSelfRegistration: true });

    alice = await register('alice');
    bob = await register('bob');
    carol = await register('carol');
    befriend(alice, bob);
    befriend(alice, carol);
    befriend(bob, carol);

    const db = app.gameblade.db;
    db.insert(libraries).values({ id: 'lib1', name: 'Main', path: '/srv/games' }).run();
    db.insert(games)
      .values({
        id: 'gam_cave',
        libraryId: 'lib1',
        relPath: 'Cave Story',
        kind: 'folder',
        title: 'Cave Story',
        sortTitle: 'cave story',
        searchTitle: 'cave story',
        releaseDate: '2004-12-20',
      })
      .run();

    conversation = (
      (
        await app.inject({
          method: 'POST',
          url: '/api/messages/conversations',
          headers: auth(alice),
          payload: { kind: 'group', memberIds: [bob.id, carol.id], title: 'Raid night' },
        })
      ).json() as { conversation: ConversationInfo }
    ).conversation;
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* -------------------------------------------------------------- replies */

  it('quotes the message a reply answers', async () => {
    const first = (
      await send(alice, conversation.id, { body: 'who is bringing snacks' })
    ).json() as {
      message: MessageInfo;
    };
    await send(bob, conversation.id, { body: 'me', replyToId: first.message.id });

    const thread = await history(alice, conversation.id);
    const reply = thread.find((message) => message.body === 'me');

    expect(reply?.replyTo?.id).toBe(first.message.id);
    expect(reply?.replyTo?.senderName).toBe('alice');
    expect(reply?.replyTo?.excerpt).toBe('who is bringing snacks');
  });

  it('refuses a reply pointing at a message in another conversation', async () => {
    const other = (
      (
        await app.inject({
          method: 'POST',
          url: '/api/messages/conversations',
          headers: auth(bob),
          payload: { kind: 'direct', memberIds: [carol.id] },
        })
      ).json() as { conversation: ConversationInfo }
    ).conversation;

    const secret = (await send(bob, other.id, { body: 'not for alice' })).json() as {
      message: MessageInfo;
    };

    // Without the check this would quote a private thread one line at a time.
    const response = await send(alice, conversation.id, {
      body: 'what did you say',
      replyToId: secret.message.id,
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps a reply when the message it answered is withdrawn', async () => {
    const original = (await send(alice, conversation.id, { body: 'delete me' })).json() as {
      message: MessageInfo;
    };
    await send(bob, conversation.id, { body: 'sure', replyToId: original.message.id });

    await app.inject({
      method: 'DELETE',
      url: `/api/messages/${original.message.id}`,
      headers: auth(alice),
    });

    const thread = await history(bob, conversation.id);
    const reply = thread.find((message) => message.body === 'sure');
    expect(reply).toBeDefined();
    expect(reply?.replyTo?.deleted).toBe(true);
    expect(reply?.replyTo?.excerpt).toBe('Message withdrawn');
  });

  /* ------------------------------------------------------------ reactions */

  it('toggles a reaction rather than piling them up', async () => {
    const message = (await send(alice, conversation.id, { body: 'we won' })).json() as {
      message: MessageInfo;
    };
    const react = (account: Account) =>
      app.inject({
        method: 'POST',
        url: `/api/messages/${message.message.id}/reactions`,
        headers: auth(account),
        payload: { emoji: '🎉' },
      });

    await react(bob);
    await react(carol);
    let thread = await history(bob, conversation.id);
    let row = thread.find((entry) => entry.id === message.message.id);
    expect(row?.reactions).toEqual([{ emoji: '🎉', count: 2, mine: true }]);

    // The same person clicking again takes theirs back.
    await react(bob);
    thread = await history(bob, conversation.id);
    row = thread.find((entry) => entry.id === message.message.id);
    expect(row?.reactions).toEqual([{ emoji: '🎉', count: 1, mine: false }]);
  });

  it('refuses a reaction from somebody outside the conversation', async () => {
    const other = await register('mallory');
    const message = (await send(alice, conversation.id, { body: 'private' })).json() as {
      message: MessageInfo;
    };

    const response = await app.inject({
      method: 'POST',
      url: `/api/messages/${message.message.id}/reactions`,
      headers: auth(other),
      payload: { emoji: '👍' },
    });
    // "Not found" rather than "forbidden": a stranger probing ids should not be
    // able to tell a real conversation from a made-up one.
    expect(response.statusCode).toBe(404);
  });

  it('refuses an emoji that is not on the offered set', async () => {
    const message = (await send(alice, conversation.id, { body: 'hello' })).json() as {
      message: MessageInfo;
    };
    const response = await app.inject({
      method: 'POST',
      url: `/api/messages/${message.message.id}/reactions`,
      headers: auth(bob),
      payload: { emoji: '🦆' },
    });
    expect(response.statusCode).toBe(400);
  });

  /* ---------------------------------------------------------------- mutes */

  it('folds a muted person away and stops them counting towards unread', async () => {
    const before = await unread(carol);
    await send(bob, conversation.id, { body: 'noise' });
    expect(await unread(carol)).toBeGreaterThan(before);

    await app.inject({
      method: 'PUT',
      url: `/api/messages/mutes/${bob.id}`,
      headers: auth(carol),
    });

    const quieted = await unread(carol);
    await send(bob, conversation.id, { body: 'more noise' });
    expect(await unread(carol)).toBe(quieted);

    const thread = await history(carol, conversation.id);
    expect(thread.find((message) => message.body === 'more noise')?.muted).toBe(true);
  });

  it('keeps a mute private to whoever set it', async () => {
    // Bob has been muted by Carol above; nothing he can read should say so.
    const thread = await history(bob, conversation.id);
    expect(thread.every((message) => message.muted === false)).toBe(true);

    const mutes = (
      (
        await app.inject({ method: 'GET', url: '/api/messages/mutes', headers: auth(bob) })
      ).json() as { muted: unknown[] }
    ).muted;
    expect(mutes).toEqual([]);
  });

  it('unmutes, and the messages come back', async () => {
    await app.inject({
      method: 'DELETE',
      url: `/api/messages/mutes/${bob.id}`,
      headers: auth(carol),
    });

    const thread = await history(carol, conversation.id);
    expect(thread.find((message) => message.body === 'more noise')?.muted).toBe(false);
  });

  it('refuses to mute yourself', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/messages/mutes/${carol.id}`,
      headers: auth(carol),
    });
    expect(response.statusCode).toBe(400);
  });

  /* --------------------------------------------------------- shared games */

  it('shares a game as a card, with no words needed', async () => {
    const response = await send(alice, conversation.id, { body: '', gameId: 'gam_cave' });
    expect(response.statusCode).toBe(201);

    const thread = await history(bob, conversation.id);
    const shared = thread.at(-1);
    expect(shared?.game).toMatchObject({
      gameId: 'gam_cave',
      title: 'Cave Story',
      releaseYear: 2004,
    });
  });

  it('names the shared game in the conversation preview', async () => {
    const conversations = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/messages/conversations',
          headers: auth(bob),
        })
      ).json() as { conversations: ConversationInfo[] }
    ).conversations;

    expect(conversations.find((entry) => entry.id === conversation.id)?.lastMessagePreview).toBe(
      'Shared a game',
    );
  });

  it('refuses a game that is not in the catalog', async () => {
    const response = await send(alice, conversation.id, { body: '', gameId: 'gam_nope' });
    expect(response.statusCode).toBe(400);
  });

  it('still refuses a message with nothing in it at all', async () => {
    const response = await send(alice, conversation.id, { body: '' });
    expect(response.statusCode).toBe(400);
  });
});
