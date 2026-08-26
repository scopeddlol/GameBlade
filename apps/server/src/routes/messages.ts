import {
  addMembersSchema,
  backfillKeysSchema,
  createConversationSchema,
  messageQuerySchema,
  publishDeviceKeySchema,
  renameConversationSchema,
  sendMessageSchema,
} from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/middleware.js';

/**
 * Private conversations.
 *
 * Every route here handles ciphertext it cannot read and metadata it can. The
 * server's whole job is routing and access control: is this person in this
 * conversation, are these two allowed to talk at all, and does this attachment
 * belong to whoever is claiming it. What is *in* any of it is not a question
 * these routes are able to ask.
 */
export async function messageRoutes(app: FastifyInstance): Promise<void> {
  const { messaging } = app.gameblade;

  /* ------------------------------------------------------------- devices */

  /**
   * Publishes the calling device's public key.
   *
   * Called on every start rather than once at setup: a client that has been
   * reinstalled has a new key, and one that has not gets a cheap no-op.
   */
  app.post('/messages/devices', async (request) => {
    const context = requireUser(request);
    const input = publishDeviceKeySchema.parse(request.body ?? {});
    return { device: messaging.publishDeviceKey(context.user.id, input) };
  });

  /** Retires a key, because the private half has just been destroyed. */
  app.delete('/messages/devices/:publicKey', async (request) => {
    const context = requireUser(request);
    const { publicKey } = request.params as { publicKey: string };
    return { retired: messaging.retireDeviceKey(context.user.id, decodeURIComponent(publicKey)) };
  });

  /**
   * The keys belonging to a set of people, so a client can seal a conversation
   * key for each of their devices.
   *
   * Public by design — that is what a public key is for — but only for people
   * the caller could message anyway, so this cannot double as a way to
   * enumerate the server's accounts.
   */
  app.get('/messages/keys', async (request) => {
    const context = requireUser(request);
    const { userIds } = request.query as { userIds?: string };
    const requested = (userIds ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    const reachable = app.gameblade.profiles.friendIds(context.user.id);
    const allowed = requested.filter((id) => id === context.user.id || reachable.has(id));

    return { keys: messaging.deviceKeysFor(allowed) };
  });

  /* -------------------------------------------------------- conversations */

  app.get('/messages/conversations', async (request) => {
    const context = requireUser(request);
    return { conversations: messaging.list(context.user.id) };
  });

  app.post('/messages/conversations', async (request, reply) => {
    const context = requireUser(request);
    const input = createConversationSchema.parse(request.body);
    const conversation = messaging.create(context.user.id, input);
    return reply.code(201).send({ conversation });
  });

  app.get('/messages/conversations/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    return { conversation: messaging.get(context.user.id, id) };
  });

  app.patch('/messages/conversations/:id', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = renameConversationSchema.parse(request.body ?? {});
    return { conversation: messaging.rename(context.user.id, id, input.title) };
  });

  /** Seals the key for a device that did not exist when this started. */
  app.post('/messages/conversations/:id/keys', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = backfillKeysSchema.parse(request.body);
    return { stored: messaging.backfillKeys(context.user.id, id, input.keys) };
  });

  app.post('/messages/conversations/:id/members', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = addMembersSchema.parse(request.body);
    return { conversation: messaging.addMembers(context.user.id, id, input) };
  });

  /** Leaving, or — for the owner — removing somebody. */
  app.delete('/messages/conversations/:id/members/:userId', async (request) => {
    const context = requireUser(request);
    const { id, userId } = request.params as { id: string; userId: string };
    messaging.removeMember(context.user.id, id, userId);
    return { ok: true };
  });

  /* ------------------------------------------------------------ messages */

  app.get('/messages/conversations/:id/messages', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const query = messageQuerySchema.parse(request.query ?? {});
    return { messages: messaging.history(context.user.id, id, query) };
  });

  app.post('/messages/conversations/:id/messages', async (request, reply) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    const input = sendMessageSchema.parse(request.body);
    const message = messaging.send(context.user.id, id, input);
    return reply.code(201).send({ message });
  });

  app.post('/messages/conversations/:id/read', async (request) => {
    const context = requireUser(request);
    const { id } = request.params as { id: string };
    messaging.markRead(context.user.id, id);
    return { ok: true };
  });

  app.delete('/messages/:messageId', async (request) => {
    const context = requireUser(request);
    const { messageId } = request.params as { messageId: string };
    messaging.remove(context.user.id, messageId);
    return { ok: true };
  });

  /** The badge on the tab. */
  app.get('/messages/unread', async (request) => {
    const context = requireUser(request);
    return { unread: messaging.unreadTotal(context.user.id) };
  });
}
