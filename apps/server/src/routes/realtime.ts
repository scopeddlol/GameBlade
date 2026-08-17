import {
  REALTIME_HEARTBEAT_SECONDS,
  presenceSchema,
  type RealtimeCommand,
} from '@gameblade/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/middleware.js';
import { newId } from '../lib/ids.js';

/**
 * The realtime socket carries presence, friend activity and notifications.
 *
 * Authentication reuses the ordinary request hook, so a desktop client's bearer
 * token is all that is needed — there is no separate socket credential to leak
 * or revoke. A browser can connect with its session cookie too, though nothing
 * in the web surface currently does.
 */
export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  const { realtime, presence } = app.gameblade;

  app.get('/realtime', { websocket: true }, (socket, request) => {
    // The auth hook has already run; an anonymous caller gets closed rather
    // than upgraded, since there is nothing to send them.
    if (!request.auth) {
      socket.close(4401, 'Authentication required');
      return;
    }

    const userId = request.auth.user.id;
    const connectionId = newId('rtc');

    realtime.add(connectionId, userId, {
      send: (data) => socket.send(data),
      close: () => socket.close(),
    });

    socket.on('message', (raw: Buffer) => {
      let command: RealtimeCommand;
      try {
        command = JSON.parse(raw.toString()) as RealtimeCommand;
      } catch {
        // A malformed frame is ignored rather than closing the socket; a client
        // bug should not cost the user their presence.
        return;
      }

      if (command.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', serverTime: new Date().toISOString() }));
        // A ping is also proof of life, which is what keeps the sweep from
        // marking an idle-but-connected client offline.
        presence.update(userId, presence.get(userId).status, presence.get(userId).gameId);
        return;
      }

      if (command.type === 'presence') {
        const parsed = presenceSchema.safeParse(command);
        if (!parsed.success) return;
        presence.update(userId, parsed.data.status, parsed.data.gameId ?? null);
      }
    });

    socket.on('close', () => realtime.remove(connectionId));
    socket.on('error', () => realtime.remove(connectionId));
  });

  /**
   * Lets a client discover the heartbeat interval instead of hard-coding it.
   * Signed-in only: the connection count is a small signal about who is around,
   * and there is no reason for an anonymous visitor to have it.
   */
  app.get('/realtime/config', async (request) => {
    requireUser(request);
    return {
      heartbeatSeconds: REALTIME_HEARTBEAT_SECONDS,
      connections: realtime.connectionCount(),
    };
  });
}
