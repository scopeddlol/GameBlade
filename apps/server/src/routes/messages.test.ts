import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type ConversationInfo, type MessageInfo } from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { friendships, messages } from '../db/schema.js';

interface Account {
  id: string;
  username: string;
  cookie: string;
  csrf: string;
}

/**
 * Direct messages and group chats.
 *
 * Access control is the whole security model, so it is what these pin down:
 * who may start a conversation, who may read one, who may write into it, and
 * who may withdraw a message. Everything else about messaging is bookkeeping;
 * this is the part that would actually hurt somebody if it were wrong.
 */
describe('conversations', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let alice: Account;
  let bob: Account;
  let mallory: Account;

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

  /** Friendship is a precondition for messaging, so it is wired directly. */
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

  const startDirect = async (from: Account, to: Account): Promise<ConversationInfo> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages/conversations',
      headers: auth(from),
      payload: { kind: 'direct', memberIds: [to.id] },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { conversation: ConversationInfo }).conversation;
  };

  const send = (account: Account, conversationId: string, body: string) =>
    app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversationId}/messages`,
      headers: auth(account),
      payload: { body },
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

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'gameblade-messages-test-'));
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
    mallory = await register('mallory');

    befriend(alice, bob);
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* -------------------------------------------------------- conversations */

  it('starts a direct conversation between friends', async () => {
    const conversation = await startDirect(alice, bob);

    expect(conversation.kind).toBe('direct');
    expect(conversation.members.map((member) => member.userId).sort()).toEqual(
      [alice.id, bob.id].sort(),
    );
  });

  it('hands back the existing conversation rather than starting a second', async () => {
    const first = await startDirect(alice, bob);
    const second = await startDirect(bob, alice);

    // Two conversations with two keys would put half the history in the one
    // nobody is looking at.
    expect(second.id).toBe(first.id);
  });

  it('refuses to start one with somebody who is not a friend', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages/conversations',
      headers: auth(alice),
      payload: { kind: 'direct', memberIds: [mallory.id] },
    });

    expect(response.statusCode).toBe(403);
  });

  /* ------------------------------------------------------------ messages */

  it('delivers a message to the other side', async () => {
    const conversation = await startDirect(alice, bob);

    await send(alice, conversation.id, 'meet me at the bonfire');

    expect((await history(bob, conversation.id)).at(-1)?.body).toBe('meet me at the bonfire');
  });

  it('refuses a message that is neither text nor an attachment', async () => {
    const conversation = await startDirect(alice, bob);
    // A stray Enter, not something to store and show everybody.
    expect((await send(alice, conversation.id, '   ')).statusCode).toBe(400);
  });

  it('keeps a preview on the conversation, so the sidebar needs no thread', async () => {
    const conversation = await startDirect(alice, bob);
    await send(alice, conversation.id, 'the newest thing said');

    const listed = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/messages/conversations',
          headers: auth(bob),
        })
      ).json() as { conversations: ConversationInfo[] }
    ).conversations.find((entry) => entry.id === conversation.id);

    expect(listed?.lastMessagePreview).toBe('the newest thing said');
  });

  it('does not let a stranger read a conversation they are not in', async () => {
    const conversation = await startDirect(alice, bob);
    await send(alice, conversation.id, 'a secret');

    const response = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      headers: auth(mallory),
    });

    // "Not found" rather than "forbidden": a stranger probing ids should not
    // be able to tell a real conversation from one they invented.
    expect(response.statusCode).toBe(404);
  });

  it('does not let a stranger send into one either', async () => {
    const conversation = await startDirect(alice, bob);
    expect((await send(mallory, conversation.id, 'hello')).statusCode).toBe(404);
  });

  it('counts unread messages for the other side only', async () => {
    const conversation = await startDirect(alice, bob);
    await send(alice, conversation.id, 'unread one');
    await send(alice, conversation.id, 'unread two');

    const bobsView = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/messages/conversations',
          headers: auth(bob),
        })
      ).json() as { conversations: ConversationInfo[] }
    ).conversations.find((entry) => entry.id === conversation.id);

    const alicesView = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/messages/conversations',
          headers: auth(alice),
        })
      ).json() as { conversations: ConversationInfo[] }
    ).conversations.find((entry) => entry.id === conversation.id);

    expect(bobsView?.unreadCount).toBeGreaterThan(0);
    // Sending is reading, so the sender's own messages never count.
    expect(alicesView?.unreadCount).toBe(0);
  });

  it('clears the badge once the conversation is opened', async () => {
    const conversation = await startDirect(alice, bob);
    await send(alice, conversation.id, 'mark me read');

    await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/read`,
      headers: auth(bob),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/messages/unread',
      headers: auth(bob),
    });
    expect((response.json() as { unread: number }).unread).toBe(0);
  });

  it('withdraws a message by clearing the body, not by hiding the row', async () => {
    const conversation = await startDirect(alice, bob);
    const sent = (
      (await send(alice, conversation.id, 'regrettable')).json() as { message: MessageInfo }
    ).message;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${sent.id}`,
      headers: auth(alice),
    });
    expect(response.statusCode).toBe(200);

    const stored = app.gameblade.db
      .select()
      .from(messages)
      .all()
      .find((row) => row.id === sent.id);

    // The row survives so every client agrees it is gone; the text does not,
    // so there is nothing left for a client to render.
    expect(stored?.deletedAt).not.toBeNull();
    expect(stored?.body).toBe('');
  });

  it('will not let somebody withdraw a message they did not send', async () => {
    const conversation = await startDirect(alice, bob);
    const sent = ((await send(alice, conversation.id, 'mine')).json() as { message: MessageInfo })
      .message;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${sent.id}`,
      headers: auth(bob),
    });
    expect(response.statusCode).toBe(403);
  });

  /* -------------------------------------------------------------- groups */

  it('starts a group and names it', async () => {
    const carol = await register('carol');
    befriend(alice, carol);

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages/conversations',
      headers: auth(alice),
      payload: { kind: 'group', title: 'Raid night', memberIds: [bob.id, carol.id] },
    });

    expect(response.statusCode).toBe(201);
    const conversation = (response.json() as { conversation: ConversationInfo }).conversation;
    expect(conversation.title).toBe('Raid night');
    expect(conversation.members).toHaveLength(3);
    expect(conversation.members.find((m) => m.userId === alice.id)?.role).toBe('owner');
  });

  it('only lets the owner rename a group', async () => {
    const created = (
      (
        await app.inject({
          method: 'POST',
          url: '/api/messages/conversations',
          headers: auth(alice),
          payload: { kind: 'group', title: 'First name', memberIds: [bob.id] },
        })
      ).json() as { conversation: ConversationInfo }
    ).conversation;

    const asMember = await app.inject({
      method: 'PATCH',
      url: `/api/messages/conversations/${created.id}`,
      headers: auth(bob),
      payload: { title: 'Not allowed' },
    });
    expect(asMember.statusCode).toBe(403);

    const asOwner = await app.inject({
      method: 'PATCH',
      url: `/api/messages/conversations/${created.id}`,
      headers: auth(alice),
      payload: { title: 'Second name' },
    });
    expect((asOwner.json() as { conversation: ConversationInfo }).conversation.title).toBe(
      'Second name',
    );
  });

  it('lets somebody leave a group and stops listing it for them', async () => {
    const created = (
      (
        await app.inject({
          method: 'POST',
          url: '/api/messages/conversations',
          headers: auth(alice),
          payload: { kind: 'group', title: 'Leavers', memberIds: [bob.id] },
        })
      ).json() as { conversation: ConversationInfo }
    ).conversation;

    await app.inject({
      method: 'DELETE',
      url: `/api/messages/conversations/${created.id}/members/${bob.id}`,
      headers: auth(bob),
    });

    const list = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/messages/conversations',
          headers: auth(bob),
        })
      ).json() as { conversations: ConversationInfo[] }
    ).conversations;

    expect(list.map((entry) => entry.id)).not.toContain(created.id);
  });

  it('keeps a departed member listed, so their messages still have a name', async () => {
    const created = (
      (
        await app.inject({
          method: 'POST',
          url: '/api/messages/conversations',
          headers: auth(alice),
          payload: { kind: 'group', title: 'History', memberIds: [bob.id] },
        })
      ).json() as { conversation: ConversationInfo }
    ).conversation;

    await app.inject({
      method: 'DELETE',
      url: `/api/messages/conversations/${created.id}/members/${bob.id}`,
      headers: auth(bob),
    });

    const asOwner = (
      (
        await app.inject({
          method: 'GET',
          url: `/api/messages/conversations/${created.id}`,
          headers: auth(alice),
        })
      ).json() as { conversation: ConversationInfo }
    ).conversation;

    const departed = asOwner.members.find((member) => member.userId === bob.id);
    expect(departed?.leftAt).not.toBeNull();
  });
});
