import { PRESENCE_STATUS, type PresenceStatus } from '@gameblade/shared';
import { isoNow } from '../lib/time.js';

export interface PresenceState {
  status: PresenceStatus;
  gameId: string | null;
  since: string;
  /** Last frame received; a stale entry is swept back to offline. */
  updatedAt: string;
  /** One user may be signed in on several machines. */
  connections: number;
}

/**
 * Presence is deliberately in-memory only. It is worthless after a restart —
 * nobody is still "in-game" from before the process died — and writing it would
 * mean a database round trip on every heartbeat from every connected client.
 *
 * The one durable part, `lastSeenAt`, is flushed to the profile row on
 * disconnect so offline friends can still be sorted by recency.
 */
export class PresenceService {
  private readonly states = new Map<string, PresenceState>();
  private readonly listeners = new Set<(userId: string, state: PresenceState) => void>();

  onChange(listener: (userId: string, state: PresenceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(userId: string): PresenceState {
    return (
      this.states.get(userId) ?? {
        status: 'offline',
        gameId: null,
        since: isoNow(),
        updatedAt: isoNow(),
        connections: 0,
      }
    );
  }

  /** Bulk lookup for rendering a friends list without a map miss per row. */
  getMany(userIds: string[]): Map<string, PresenceState> {
    return new Map(userIds.map((id) => [id, this.get(id)]));
  }

  isOnline(userId: string): boolean {
    return (this.states.get(userId)?.connections ?? 0) > 0;
  }

  connect(userId: string): void {
    const current = this.states.get(userId);
    if (current) {
      current.connections += 1;
      current.updatedAt = isoNow();
      return;
    }
    this.set(userId, 'online', null, 1);
  }

  disconnect(userId: string): void {
    const current = this.states.get(userId);
    if (!current) return;

    current.connections -= 1;
    if (current.connections > 0) {
      current.updatedAt = isoNow();
      return;
    }

    this.states.delete(userId);
    this.emit(userId, {
      status: 'offline',
      gameId: null,
      since: isoNow(),
      updatedAt: isoNow(),
      connections: 0,
    });
  }

  update(userId: string, status: PresenceStatus, gameId: string | null): void {
    const current = this.states.get(userId);
    // `in-game` without a game is meaningless; treat it as plain online so a
    // buggy client cannot pin a friend to "playing nothing".
    const resolved: PresenceStatus = status === 'in-game' && !gameId ? 'online' : status;

    if (!PRESENCE_STATUS.includes(resolved)) return;
    if (resolved === 'offline') {
      this.disconnect(userId);
      return;
    }

    const unchanged =
      current && current.status === resolved && current.gameId === (gameId ?? null);
    if (unchanged) {
      current.updatedAt = isoNow();
      return;
    }

    this.set(userId, resolved, gameId ?? null, current?.connections ?? 1);
  }

  /** Marks stale entries offline so a dropped socket cannot pin someone online. */
  sweep(maxAgeSeconds: number): string[] {
    const cutoff = Date.now() - maxAgeSeconds * 1000;
    const dropped: string[] = [];
    for (const [userId, state] of this.states) {
      if (new Date(state.updatedAt).getTime() >= cutoff) continue;
      this.states.delete(userId);
      dropped.push(userId);
      this.emit(userId, {
        status: 'offline',
        gameId: null,
        since: isoNow(),
        updatedAt: isoNow(),
        connections: 0,
      });
    }
    return dropped;
  }

  /** Everyone currently connected, for the admin dashboard. */
  onlineCount(): number {
    return this.states.size;
  }

  private set(
    userId: string,
    status: PresenceStatus,
    gameId: string | null,
    connections: number,
  ): void {
    const state: PresenceState = {
      status,
      gameId,
      since: isoNow(),
      updatedAt: isoNow(),
      connections,
    };
    this.states.set(userId, state);
    this.emit(userId, state);
  }

  private emit(userId: string, state: PresenceState): void {
    for (const listener of this.listeners) {
      try {
        listener(userId, state);
      } catch {
        // A broken listener must never take down presence for everyone else.
      }
    }
  }
}
