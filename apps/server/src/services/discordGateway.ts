import type { DiscordBotState } from '@gameblade/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * A Discord gateway connection, and nothing else.
 *
 * The REST half of the integration can post announcements without any of
 * this — but a bot that only speaks REST is never *online*. It has no
 * presence, it cannot say what it is playing, and, most importantly, Discord
 * has nowhere to deliver an interaction to, so slash commands and buttons are
 * impossible. All three of those are what this is for.
 *
 * Written against Node's own `WebSocket` rather than pulling in discord.js.
 * The library is excellent and is roughly two hundred times the size of what
 * is needed here: identify, heartbeat, resume, one presence frame and one
 * dispatch event. Everything below is the v10 gateway protocol as documented,
 * and the parts that look fussy — the jittered first heartbeat, the resume
 * URL, the close-code table — are the parts that decide whether a bot stays up
 * for a week or drops off after an hour.
 */

/** Opcodes, only the ones this client sends or acts on. */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * Close codes Discord will not accept a retry for.
 *
 * Reconnecting after one of these is an infinite loop against an error the
 * operator has to fix — a revoked token, a privileged intent that was never
 * enabled in the portal, a malformed identify. The bot stops and says so.
 */
const FATAL_CLOSE_CODES = new Set([
  4004, // Authentication failed — the token is wrong.
  4010, // Invalid shard.
  4011, // Sharding required.
  4012, // Invalid API version.
  4013, // Invalid intents.
  4014, // Disallowed intents — a privileged one is not enabled in the portal.
]);

const FATAL_CLOSE_REASONS: Record<number, string> = {
  4004: 'Discord rejected the bot token. Reset it in the application’s Bot tab and paste the new one.',
  4010: 'Discord rejected the shard configuration.',
  4011: 'This bot is in too many servers to connect without sharding.',
  4012: 'Discord rejected the gateway API version.',
  4013: 'Discord rejected the requested intents.',
  4014: 'Discord refused a privileged intent. Enable it on the application’s Bot tab, or stop asking for it.',
};

/**
 * What the bot asks to be told about.
 *
 * Zero by default, deliberately. Interactions — slash commands and button
 * presses — are delivered regardless of intents, and for a long time they were
 * the only events this bot acted on. Asking for nothing means the operator
 * never has to enable anything in the portal, and the bot cannot read anybody's
 * messages even in principle, which is a much easier thing to be asked to
 * install.
 *
 * Each of the two below is added only when the feature that needs it is
 * actually configured, so that stays true for anyone not using them.
 */
export const GATEWAY_INTENTS = {
  none: 0,
  /**
   * Privileged. Needed for GUILD_MEMBER_ADD, and so for auto-roles — the
   * operator has to enable "Server Members Intent" on the application's Bot
   * tab, and Discord closes the socket with 4014 if they have not.
   */
  guildMembers: 1 << 1,
  /** Not privileged. Needed for MESSAGE_REACTION_ADD/REMOVE. */
  guildMessageReactions: 1 << 10,
} as const;

/**
 * How long to wait for HELLO before assuming the connection is going nowhere.
 *
 * Generous, because a slow network is not a broken one; short enough that a
 * blackholed connection is retried within the minute rather than leaving the
 * panel reporting "connecting" until somebody restarts the server.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

export interface GatewayPresence {
  status: string;
  /** Discord's activity type number, or null for no activity at all. */
  activityType: number | null;
  activityName: string | null;
}

export interface GatewayEvents {
  /** A dispatch frame: `t` is the event name, `d` its payload. */
  onDispatch: (event: string, data: unknown) => void;
  onStateChange: (state: DiscordBotState, detail: string | null) => void;
}

interface Frame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export class DiscordGateway {
  private socket: WebSocket | null = null;
  /** The repeating beat, once the jittered first one has fired. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** The jittered first beat, which has to be cancellable on its own. */
  private firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Gives the handshake a deadline.
   *
   * A refused socket reports itself, and a connected one sends HELLO within a
   * moment. A socket to a host that silently drops the packets — a firewall, a
   * proxy that does not pass upgrades, a captive network — does neither, and
   * without this the bot sits in "connecting" indefinitely while the panel
   * reports something that is never going to become true.
   */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Last sequence number seen, which RESUME replays from. */
  private sequence: number | null = null;
  private sessionId: string | null = null;
  /** Where to reconnect for a resume; Discord may move it between sessions. */
  private resumeUrl: string | null = null;

  /**
   * Whether the last heartbeat was acknowledged.
   *
   * An unacknowledged heartbeat is the only way to notice a "zombie"
   * connection — the socket is open, the process is happy, and Discord stopped
   * listening some time ago. Without this check the bot shows as online in the
   * panel and offline in the server, which is the single most confusing state
   * this can be in.
   */
  private acked = true;

  private attempts = 0;
  /** What the caller asked for, as opposed to what is currently true. */
  private wanted = false;
  private token: string | null = null;
  private presence: GatewayPresence = { status: 'online', activityType: 0, activityName: null };

  /**
   * Which events this connection asked for.
   *
   * Only read at IDENTIFY, so a change to it needs a reconnect to take — which
   * is what the bot does when the settings behind it change.
   */
  private intents: number = GATEWAY_INTENTS.none;

  private state: DiscordBotState = 'stopped';
  private detail: string | null = null;
  private botId: string | null = null;
  private readyAt: string | null = null;

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly events: GatewayEvents,
  ) {}

  /* -------------------------------------------------------------- lifecycle */

  get status(): {
    state: DiscordBotState;
    detail: string | null;
    botId: string | null;
    readyAt: string | null;
  } {
    return { state: this.state, detail: this.detail, botId: this.botId, readyAt: this.readyAt };
  }

  get isRunning(): boolean {
    return this.wanted;
  }

  /** What the live connection asked for, so a caller can tell it is stale. */
  get currentIntents(): number {
    return this.intents;
  }

  start(token: string, presence: GatewayPresence, intents: number = GATEWAY_INTENTS.none): void {
    this.token = token;
    this.presence = presence;
    this.intents = intents;
    this.wanted = true;
    this.attempts = 0;
    this.connect();
  }

  /**
   * Closes the connection and stays closed.
   *
   * 1000 rather than an abrupt teardown: a clean close tells Discord the
   * session is finished, so it marks the bot offline immediately instead of
   * waiting out the heartbeat window with a ghost showing as online.
   */
  stop(reason = 'Stopped from the admin panel'): void {
    this.wanted = false;
    this.clearTimers();
    this.sessionId = null;
    this.resumeUrl = null;
    this.sequence = null;

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      // The handlers are dropped first so the close does not schedule a
      // reconnect for a socket nobody wants any more.
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      try {
        socket.close(1000, 'going away');
      } catch {
        // Already closing; there is nothing else to do about it.
      }
    }
    this.botId = null;
    this.readyAt = null;
    this.setState('stopped', reason);
  }

  /**
   * Changes what the bot appears to be doing, without reconnecting.
   *
   * A presence update is a frame on the open socket. Reconnecting to change a
   * status would take the bot offline and back for a cosmetic edit, and
   * Discord rate-limits identifies far harder than it rate-limits this.
   */
  setPresence(presence: GatewayPresence): void {
    this.presence = presence;
    if (this.socket?.readyState === 1) this.send({ op: OP.PRESENCE_UPDATE, d: this.presenced() });
  }

  /* ------------------------------------------------------------- connecting */

  private connect(): void {
    if (!this.token || !this.wanted) return;

    this.clearTimers();
    // A resume goes back to the URL READY handed us; a fresh session does not.
    const url = this.sessionId && this.resumeUrl ? this.resumeUrl : 'wss://gateway.discord.gg';
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting', null);

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${url}/?v=10&encoding=json`);
    } catch (error) {
      // A malformed resume URL should not be fatal — drop it and try the
      // published gateway on the next attempt.
      this.resumeUrl = null;
      this.scheduleReconnect(messageOf(error));
      return;
    }

    this.socket = socket;
    this.acked = true;

    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.state === 'ready') return;
      this.logger.warn('Discord did not answer the handshake; retrying');
      // Closed rather than abandoned, so `onclose` runs the usual backoff
      // instead of this leaking one socket per attempt.
      try {
        socket.close(4000, 'handshake timed out');
      } catch {
        this.closed(4000, 'handshake timed out');
      }
    }, HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref?.();

    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {
      // `onclose` always follows, and carries the code worth reporting.
      this.logger.debug('the Discord gateway socket errored');
    };
    socket.onclose = (event) => this.closed(event.code, event.reason);
  }

  private closed(code: number, reason: string): void {
    this.clearTimers();
    this.socket = null;

    if (!this.wanted) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      this.wanted = false;
      this.sessionId = null;
      this.setState(
        'failed',
        FATAL_CLOSE_REASONS[code] ?? `Discord closed the connection (${code}).`,
      );
      this.logger.error({ code, reason }, 'the Discord gateway refused this bot');
      return;
    }

    // 1000 and 1001 mean the session is finished rather than interrupted, so
    // there is nothing left to resume from and the next attempt starts fresh.
    if (code === 1000 || code === 1001) {
      this.sessionId = null;
      this.sequence = null;
    }

    this.scheduleReconnect(reason || `closed with ${code}`);
  }

  /**
   * Backs off, with a ceiling.
   *
   * Discord bans an application that hammers IDENTIFY, and a server that is
   * down comes back on its own schedule rather than ours. Capped at half a
   * minute so a bot that dropped at 3am is back within it rather than an hour
   * later, which is what an unbounded exponential gets you.
   */
  private scheduleReconnect(detail: string): void {
    if (!this.wanted) return;

    this.attempts += 1;
    const wait = Math.min(1000 * 2 ** Math.min(this.attempts, 5), 30_000);
    // Spread out, so several servers restarting together do not identify in
    // lockstep for ever.
    const jittered = wait * (0.8 + Math.random() * 0.4);

    this.setState('reconnecting', `${detail} — retrying in ${Math.round(jittered / 1000)}s`);
    this.logger.warn(
      { attempt: this.attempts, detail },
      'the Discord gateway dropped; reconnecting',
    );

    this.reconnectTimer = setTimeout(() => this.connect(), jittered);
    this.reconnectTimer.unref?.();
  }

  /* ---------------------------------------------------------------- frames */

  private receive(raw: unknown): void {
    let frame: Frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as Frame;
    } catch {
      this.logger.warn('the Discord gateway sent something that was not JSON');
      return;
    }

    if (typeof frame.s === 'number') this.sequence = frame.s;

    switch (frame.op) {
      case OP.HELLO: {
        // The handshake happened, so its deadline stops being interesting.
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
        }
        const interval = (frame.d as { heartbeat_interval?: number } | undefined)
          ?.heartbeat_interval;
        this.beginHeartbeat(typeof interval === 'number' && interval > 0 ? interval : 41_250);
        // Resuming replays what was missed; identifying starts a new session.
        if (this.sessionId && this.sequence !== null) {
          this.send({
            op: OP.RESUME,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
          });
        } else {
          this.identify();
        }
        return;
      }

      case OP.HEARTBEAT:
        // Discord may ask for one out of band; answer immediately.
        this.send({ op: OP.HEARTBEAT, d: this.sequence });
        return;

      case OP.HEARTBEAT_ACK:
        this.acked = true;
        return;

      case OP.RECONNECT:
        // Asked to move, politely. The session is still resumable.
        this.socket?.close(4000, 'reconnecting at Discord’s request');
        return;

      case OP.INVALID_SESSION: {
        // `d` is whether the session may still be resumed. When it may not,
        // everything that identifies it has to go or the retry loops.
        const resumable = frame.d === true;
        if (!resumable) {
          this.sessionId = null;
          this.sequence = null;
          this.resumeUrl = null;
        }
        this.socket?.close(4000, 'session invalidated');
        return;
      }

      case OP.DISPATCH:
        this.dispatch(frame.t ?? '', frame.d);
        return;

      default:
        return;
    }
  }

  private dispatch(event: string, data: unknown): void {
    if (event === 'READY') {
      const payload = data as {
        session_id?: string;
        resume_gateway_url?: string;
        user?: { id?: string; username?: string };
      };
      this.sessionId = payload.session_id ?? null;
      this.resumeUrl = payload.resume_gateway_url ?? null;
      this.botId = payload.user?.id ?? null;
      this.readyAt = new Date().toISOString();
      this.attempts = 0;
      this.setState('ready', payload.user?.username ? `Online as ${payload.user.username}.` : null);
      this.logger.info({ botId: this.botId }, 'the Discord bot is online');
    }

    if (event === 'RESUMED') {
      this.attempts = 0;
      this.readyAt = this.readyAt ?? new Date().toISOString();
      this.setState('ready', 'Reconnected and caught up.');
    }

    try {
      this.events.onDispatch(event, data);
    } catch (error) {
      // A handler that throws must not take the socket down with it.
      this.logger.error({ err: error, event }, 'a Discord gateway handler threw');
    }
  }

  private identify(): void {
    this.send({
      op: OP.IDENTIFY,
      d: {
        token: this.token,
        intents: this.intents,
        properties: { os: process.platform, browser: 'gameblade', device: 'gameblade' },
        presence: this.presenced(),
      },
    });
  }

  /** The presence object, in the shape both IDENTIFY and op 3 expect. */
  private presenced(): Record<string, unknown> {
    const { status, activityType, activityName } = this.presence;
    const name = activityName?.trim();

    return {
      since: null,
      afk: false,
      status,
      activities:
        activityType === null || !name
          ? []
          : [
              // A custom status is the one type whose text lives in `state`;
              // `name` is required but ignored for it, which is why it is set
              // to something rather than omitted.
              activityType === 4
                ? { type: 4, name: 'Custom Status', state: name }
                : { type: activityType, name },
            ],
    };
  }

  /**
   * Heartbeats, with the first one jittered.
   *
   * Discord asks for the jitter and it matters at scale rather than here: it
   * stops every bot that reconnected after an outage heartbeating on the same
   * millisecond for ever after.
   */
  private beginHeartbeat(interval: number): void {
    this.clearHeartbeat();
    this.acked = true;

    const beat = () => {
      if (!this.acked) {
        // Nothing came back for the last one, so the connection is a zombie:
        // open as far as this process knows, and long forgotten at Discord.
        this.logger.warn('Discord did not acknowledge a heartbeat; restarting the connection');
        this.socket?.close(4000, 'heartbeat not acknowledged');
        return;
      }
      this.acked = false;
      this.send({ op: OP.HEARTBEAT, d: this.sequence });
    };

    // Held in its own field so a stop() landing between HELLO and the first
    // beat still cancels it.
    this.firstBeatTimer = setTimeout(() => {
      this.firstBeatTimer = null;
      beat();
      this.heartbeatTimer = setInterval(beat, interval);
      this.heartbeatTimer.unref?.();
    }, interval * Math.random());
    this.firstBeatTimer.unref?.();
  }

  private send(frame: Frame): void {
    if (this.socket?.readyState !== 1) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.logger.warn({ err: error, op: frame.op }, 'could not write to the Discord gateway');
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.firstBeatTimer) {
      clearTimeout(this.firstBeatTimer);
      this.firstBeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private setState(state: DiscordBotState, detail: string | null): void {
    this.state = state;
    this.detail = detail;
    try {
      this.events.onStateChange(state, detail);
    } catch {
      // A listener's problem is not the connection's.
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'could not open the connection';
}
