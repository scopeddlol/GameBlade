import { REALTIME_HEARTBEAT_SECONDS, type RealtimeEvent } from '@gameblade/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { PresenceService, PresenceState } from './presence.js';
import type { ProfileService } from './profiles.js';

/** Anything able to receive a serialised frame; a WebSocket in practice. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
}

interface Connection {
  userId: string;
  socket: RealtimeSocket;
}

/**
 * Fans server events out to connected desktop clients.
 *
 * Sockets are held in memory and keyed by connection rather than by user, so
 * one account signed in on two machines gets both updated. Delivery is
 * best-effort by design: everything pushed here is also readable from a REST
 * endpoint, so a missed frame costs a client freshness, never correctness.
 */
export class RealtimeGateway {
  private readonly connections = new Map<string, Connection>();
  private readonly byUser = new Map<string, Set<string>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly presence: PresenceService,
    private readonly profiles: ProfileService,
    private readonly logger: FastifyBaseLogger,
  ) {
    // A presence change is interesting to the person's friends and to nobody
    // else, so routing happens here rather than in every caller.
    this.presence.onChange((userId, state) => this.publishPresence(userId, state));
  }

  /** Starts the stale-connection sweep. Idempotent, so tests can call it twice. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(
      () => this.presence.sweep(REALTIME_HEARTBEAT_SECONDS * 3),
      REALTIME_HEARTBEAT_SECONDS * 1000,
    );
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const connection of this.connections.values()) {
      try {
        connection.socket.close();
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.connections.clear();
    this.byUser.clear();
  }

  add(connectionId: string, userId: string, socket: RealtimeSocket): void {
    this.connections.set(connectionId, { userId, socket });
    const set = this.byUser.get(userId) ?? new Set<string>();
    set.add(connectionId);
    this.byUser.set(userId, set);

    this.presence.connect(userId);
    this.sendTo(connectionId, { type: 'hello', userId, serverTime: new Date().toISOString() });
  }

  remove(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    this.connections.delete(connectionId);
    const set = this.byUser.get(connection.userId);
    set?.delete(connectionId);
    if (set && set.size === 0) this.byUser.delete(connection.userId);

    this.presence.disconnect(connection.userId);
    this.profiles.touchLastSeen(connection.userId);
  }

  /** Delivers to every device the user has connected. */
  send(userId: string, event: RealtimeEvent): void {
    const connectionIds = this.byUser.get(userId);
    if (!connectionIds) return;
    for (const id of connectionIds) this.sendTo(id, event);
  }

  sendMany(userIds: Iterable<string>, event: RealtimeEvent): void {
    for (const userId of userIds) this.send(userId, event);
  }

  connectionCount(): number {
    return this.connections.size;
  }

  private publishPresence(userId: string, _state: PresenceState): void {
    const friends = this.profiles.friendIds(userId);
    if (friends.size === 0) return;

    // Each friend gets the summary as *they* are allowed to see it, which is
    // what keeps a "friends-only" profile from leaking its current game.
    for (const friendId of friends) {
      const profile = this.profiles.summariseOne(userId, friendId);
      if (profile) this.send(friendId, { type: 'presence', profile });
    }
  }

  private sendTo(connectionId: string, event: RealtimeEvent): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    try {
      connection.socket.send(JSON.stringify(event));
    } catch (error) {
      this.logger.debug({ err: error, connectionId }, 'dropping a dead realtime socket');
      this.remove(connectionId);
    }
  }
}
