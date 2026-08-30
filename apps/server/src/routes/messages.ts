import {
  addMembersSchema,
  createConversationSchema,
  messageQuerySchema,
  reactToMessageSchema,
  renameConversationSchema,
  sendMessageSchema,
} from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/middleware.js';

/**
 * Direct messages and group chats.
 *
 * The server's whole job here is routing and access control: is this person in
 * this conversation, are these two allowed to talk at all, and does this
 * attachment belong to whoever is claiming it.
 */
export async function messageRoutes(app: FastifyInstance): Promise<void> {
  const { messaging } = app.gameblade;

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

  /**
   * Adds a reaction, or takes it back when it is already there.
   *
   * One route rather than a POST and a DELETE: the gesture is one click on an
   * emoji that is either lit or not, and splitting it would make the client
   * decide which — from state that may be stale by the time the click lands.
   */
  app.post('/messages/:messageId/reactions', async (request) => {
    const context = requireUser(request);
    const { messageId } = request.params as { messageId: string };
    const input = reactToMessageSchema.parse(request.body);
    return { reactions: messaging.react(context.user.id, messageId, input.emoji) };
  });

  /* -------------------------------------------------------------- muting */

  /** Who this account has muted, for the list in settings. */
  app.get('/messages/mutes', async (request) => {
    const context = requireUser(request);
    return { muted: messaging.listMuted(context.user.id) };
  });

  app.put('/messages/mutes/:userId', async (request) => {
    const context = requireUser(request);
    const { userId } = request.params as { userId: string };
    messaging.setMuted(context.user.id, userId, true);
    return { ok: true, muted: true };
  });

  app.delete('/messages/mutes/:userId', async (request) => {
    const context = requireUser(request);
    const { userId } = request.params as { userId: string };
    messaging.setMuted(context.user.id, userId, false);
    return { ok: true, muted: false };
  });

  /** The badge on the tab. */
  app.get('/messages/unread', async (request) => {
    const context = requireUser(request);
    return { unread: messaging.unreadTotal(context.user.id) };
  });
}
