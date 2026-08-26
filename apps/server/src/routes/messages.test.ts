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
  /** Stands in for a device's published X25519 key. */
  publicKey: string;
}

/**
 * Conversations the server routes and cannot read.
 *
 * These tests are about the two halves the server is actually responsible for.
 * The first is that it stays ignorant: whatever goes in comes back out
 * unchanged, and there is nowhere in the request path where a body could be
 * inspected. The second is access control — who may start a conversation, who
 * may read one, and who may withdraw a message — because encryption does
 * nothing at all if the wrong account can ask for the ciphertext and its key.
 *
 * The cryptography itself is tested on the client, in Rust, where it lives.
 * Nothing here does any: the "keys" are opaque strings, which is exactly what
 * they are to the server.
 */
describe('private conversations', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let alice: Account;
  let bob: Account;
  let mallory: Account;

  const auth = (account: Account) => ({ cookie: account.cookie, [CSRF_HEADER]: account.csrf });

  const register = async (username: string, publicKey: string): Promise<Account> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'a-long-enough-password' },
    });
    const raw = response.headers['set-cookie'];
    const body = response.json() as { csrfToken: string; user: { id: string } };
    const account: Account = {
      id: body.user.id,
      username,
      cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '',
      csrf: body.csrfToken,
      publicKey,
    };

    await app.inject({
      method: 'POST',
      url: '/api/messages/devices',
      headers: auth(account),
      payload: { publicKey, label: `${username}'s desktop` },
    });

    return account;
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
      payload: {
        kind: 'direct',
        memberIds: [to.id],
        keys: [from, to].map((account) => ({
          publicKey: account.publicKey,
          ephemeralPublic: 'ZXBoZW1lcmFs',
          nonce: 'bm9uY2U=',
          ciphertext: `d3JhcHBlZC0ke${account.id.length}=`.replace(/[^A-Za-z0-9+/=]/g, ''),
        })),
      },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { conversation: ConversationInfo }).conversation;
  };

  const send = (account: Account, conversationId: string, ciphertext: string) =>
    app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversationId}/messages`,
      headers: auth(account),
      payload: { body: { nonce: 'bm9uY2U=', ciphertext } },
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

    alice = await register('alice', 'QUxJQ0VLRVlBTElDRUtFWUFMSUNFS0VZQUxJQ0U=');
    bob = await register('bob', 'Qk9CS0VZQk9CS0VZQk9CS0VZQk9CS0VZQk9CS0U=');
    mallory = await register('mallory', 'TUFMTE9SWUtFWU1BTExPUllLRVlNQUxMT1JZS0U=');

    befriend(alice, bob);
  });

  afterAll(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------- devices */

  it('publishes a device key with a fingerprint for comparing by hand', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/messages/keys?userIds=${bob.id}`,
      headers: auth(alice),
    });

    const keys = (response.json() as { keys: Array<{ publicKey: string; fingerprint: string }> })
      .keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]?.publicKey).toBe(bob.publicKey);
    // Eight groups of four: the format two people can actually read to each
    // other, which is the only defence against a substituted key.
    expect(keys[0]?.fingerprint.split(' ')).toHaveLength(8);
  });

  it('re-publishing the same key does not create a second device', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/messages/devices',
      headers: auth(bob),
      payload: { publicKey: bob.publicKey },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/messages/keys?userIds=${bob.id}`,
      headers: auth(alice),
    });
    expect((response.json() as { keys: unknown[] }).keys).toHaveLength(1);
  });

  it('will not hand out the keys of somebody you cannot message', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/messages/keys?userIds=${mallory.id}`,
      headers: auth(alice),
    });

    // Otherwise this doubles as a way to enumerate the server's accounts.
    expect((response.json() as { keys: unknown[] }).keys).toEqual([]);
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

  it('gives each side only the key wraps addressed to their own devices', async () => {
    const forAlice = await startDirect(alice, bob);
    const forBob = (
      (
        await app.inject({
          method: 'GET',
          url: `/api/messages/conversations/${forAlice.id}`,
          headers: auth(bob),
        })
      ).json() as { conversation: ConversationInfo }
    ).conversation;

    expect(forAlice.keys.map((key) => key.publicKey)).toEqual([alice.publicKey]);
    expect(forBob.keys.map((key) => key.publicKey)).toEqual([bob.publicKey]);
  });

  it('refuses to start one with somebody who is not a friend', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages/conversations',
      headers: auth(alice),
      payload: { kind: 'direct', memberIds: [mallory.id], keys: [] },
    });

    expect(response.statusCode).toBe(403);
  });

  /* ------------------------------------------------------------ messages */

  it('stores the ciphertext exactly as it arrived', async () => {
    const conversation = await startDirect(alice, bob);
    const ciphertext = 'c2VhbGVkLWJvZHktZm9yLWJvYg==';

    await send(alice, conversation.id, ciphertext);

    // Byte for byte, both through the API and in the row itself: anything
    // else would mean something in the path had opinions about the contents.
    expect((await history(bob, conversation.id)).at(-1)?.body.ciphertext).toBe(ciphertext);

    const stored = app.gameblade.db
      .select()
      .from(messages)
      .all()
      .find((row) => row.ciphertext === ciphertext);
    expect(stored).toBeDefined();
  });

  it('does not let a stranger read a conversation they are not in', async () => {
    const conversation = await startDirect(alice, bob);
    await send(alice, conversation.id, 'c2VjcmV0');

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
    expect((await send(mallory, conversation.id, 'aGVsbG8=')).statusCode).toBe(404);
  });

  it('counts unread messages for the other side only', async () => {
    const conversation = await startDirect(alice, bob);
    await send(alice, conversation.id, 'dW5yZWFkLW9uZQ==');
    await send(alice, conversation.id, 'dW5yZWFkLXR3bw==');

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
    await send(alice, conversation.id, 'bWFyay1tZS1yZWFk');

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

  it('withdraws a message by clearing the ciphertext, not by hiding it', async () => {
    const conversation = await startDirect(alice, bob);
    const sent = (
      (await send(alice, conversation.id, 'cmVncmV0dGFibGU=')).json() as { message: MessageInfo }
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

    // The row survives so every client agrees it is gone; the ciphertext does
    // not, so there is nothing left to decrypt.
    expect(stored?.deletedAt).not.toBeNull();
    expect(stored?.ciphertext).toBe('');
  });

  it('will not let somebody withdraw a message they did not send', async () => {
    const conversation = await startDirect(alice, bob);
    const sent = (
      (await send(alice, conversation.id, 'bWluZQ==')).json() as { message: MessageInfo }
    ).message;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${sent.id}`,
      headers: auth(bob),
    });
    expect(response.statusCode).toBe(403);
  });

  /* -------------------------------------------------------------- groups */

  it('starts a group and names it', async () => {
    const carol = await register('carol', 'Q0FST0xLRVlDQVJPTEtFWUNBUk9MS0VZQ0FSTw==');
    befriend(alice, carol);

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages/conversations',
      headers: auth(alice),
      payload: {
        kind: 'group',
        title: 'Raid night',
        memberIds: [bob.id, carol.id],
        keys: [alice, bob, carol].map((account) => ({
          publicKey: account.publicKey,
          ephemeralPublic: 'ZXBoZW1lcmFs',
          nonce: 'bm9uY2U=',
          ciphertext: 'd3JhcHBlZA==',
        })),
      },
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
          payload: {
            kind: 'group',
            title: 'First name',
            memberIds: [bob.id],
            keys: [],
          },
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
          payload: { kind: 'group', title: 'Leavers', memberIds: [bob.id], keys: [] },
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
          payload: { kind: 'group', title: 'History', memberIds: [bob.id], keys: [] },
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

  it('ignores a key wrap addressed to somebody outside the room', async () => {
    const created = (
      (
        await app.inject({
          method: 'POST',
          url: '/api/messages/conversations',
          headers: auth(alice),
          payload: {
            kind: 'group',
            title: 'Closed',
            memberIds: [bob.id],
            keys: [
              {
                publicKey: mallory.publicKey,
                ephemeralPublic: 'ZXBoZW1lcmFs',
                nonce: 'bm9uY2U=',
                ciphertext: 'd3JhcHBlZA==',
              },
            ],
          },
        })
      ).json() as { conversation: ConversationInfo }
    ).conversation;

    // A stray wrap is a client bug rather than an attack, but storing one
    // would leave key material addressed to a device with no business holding
    // it — so it is dropped.
    const asMallory = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${created.id}`,
      headers: auth(mallory),
    });
    expect(asMallory.statusCode).toBe(404);
  });
});
