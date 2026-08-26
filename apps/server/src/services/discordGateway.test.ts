import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DiscordGateway, GATEWAY_INTENTS } from './discordGateway.js';

/**
 * The gateway protocol itself, against a fake socket.
 *
 * Discord is unreachable from a test run, and the parts most likely to be
 * wrong are the ones that never involve the network anyway: what gets sent in
 * response to HELLO, whether a zombie connection is noticed, and whether a
 * fatal close is retried for ever.
 */
class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 1;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames() {
    return this.sent.map((raw) => JSON.parse(raw) as { op: number; d?: any });
  }
}

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;

describe('the Discord gateway protocol', () => {
  let original: typeof WebSocket;
  beforeEach(() => {
    original = globalThis.WebSocket;
    (globalThis as any).WebSocket = FakeSocket;
    vi.useFakeTimers();
  });
  afterEach(() => {
    (globalThis as any).WebSocket = original;
    vi.useRealTimers();
  });

  const start = (
    presence = { status: 'online', activityType: 0, activityName: 'the archive' },
    intents?: number,
  ) => {
    const states: string[] = [];
    const dispatched: Array<[string, unknown]> = [];
    const gateway = new DiscordGateway(logger, {
      onDispatch: (event, data) => dispatched.push([event, data]),
      onStateChange: (state) => states.push(state),
    });
    gateway.start('a-token', presence, intents);
    return { gateway, states, dispatched, socket: FakeSocket.last! };
  };

  it('identifies with no intents at all, and with the presence it was given', () => {
    const { socket } = start();
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });

    const identify = socket.frames().find((f) => f.op === 2);
    expect(identify).toBeDefined();
    // Zero intents is what keeps this bot installable without the operator
    // enabling a privileged intent, and means it cannot read any messages.
    expect(identify!.d.intents).toBe(0);
    expect(identify!.d.token).toBe('a-token');
    expect(identify!.d.presence.activities).toEqual([{ type: 0, name: 'the archive' }]);
  });

  /**
   * Intents are opt-in per feature, so a server using neither role feature
   * keeps a bot that is told about nothing and needs nothing enabling.
   */
  it('asks for the members intent only when auto-roles need it', () => {
    const { socket } = start(undefined, GATEWAY_INTENTS.guildMembers);
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });

    const identify = socket.frames().find((f) => f.op === 2);
    expect(identify!.d.intents).toBe(GATEWAY_INTENTS.guildMembers);
  });

  it('combines intents when both role features are on', () => {
    const both = GATEWAY_INTENTS.guildMembers | GATEWAY_INTENTS.guildMessageReactions;
    const { socket, gateway } = start(undefined, both);
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });

    expect(socket.frames().find((f) => f.op === 2)!.d.intents).toBe(both);
    // Read back so the bot can tell a live connection is asking for the wrong
    // set and reconnect, rather than listening for events it never requested.
    expect(gateway.currentIntents).toBe(both);
  });

  it('hands every dispatch to the handler, not only interactions', () => {
    const { socket, dispatched } = start(undefined, GATEWAY_INTENTS.guildMembers);
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });
    socket.receive({ op: 0, t: 'GUILD_MEMBER_ADD', s: 1, d: { guild_id: 'g', user: { id: 'u' } } });

    expect(dispatched.map(([event]) => event)).toContain('GUILD_MEMBER_ADD');
  });

  it('puts a custom status in `state`, where Discord reads it from', () => {
    const { socket } = start({ status: 'dnd', activityType: 4, activityName: 'keeping watch' });
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });

    const identify = socket.frames().find((f) => f.op === 2)!;
    expect(identify.d.presence.activities[0]).toMatchObject({
      type: 4,
      state: 'keeping watch',
    });
  });

  it('sends no activity at all when the text is blank', () => {
    const { socket } = start({ status: 'online', activityType: 0, activityName: '' });
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });
    expect(socket.frames().find((f) => f.op === 2)!.d.presence.activities).toEqual([]);
  });

  it('reaches ready on READY and reports the session', () => {
    const { gateway, socket, states } = start();
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });
    socket.receive({
      op: 0,
      s: 1,
      t: 'READY',
      d: {
        session_id: 'abc',
        resume_gateway_url: 'wss://resume.example',
        user: { id: '99', username: 'gameblade' },
      },
    });

    expect(states).toContain('ready');
    expect(gateway.status.botId).toBe('99');
  });

  it('resumes rather than re-identifying after a drop', () => {
    const first = start();
    first.socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });
    first.socket.receive({
      op: 0,
      s: 7,
      t: 'READY',
      d: { session_id: 'abc', resume_gateway_url: 'wss://resume.example', user: { id: '99' } },
    });

    first.socket.close(1006, 'network');
    vi.advanceTimersByTime(60_000);

    const next = FakeSocket.last!;
    expect(next).not.toBe(first.socket);
    // Back to the URL READY handed us, not the published gateway.
    expect(next.url).toContain('resume.example');

    next.receive({ op: 10, d: { heartbeat_interval: 45000 } });
    const frames = next.frames();
    expect(frames.find((f) => f.op === 6)?.d).toMatchObject({ session_id: 'abc', seq: 7 });
    expect(frames.find((f) => f.op === 2)).toBeUndefined();
  });

  it('gives up rather than looping when Discord rejects the token', () => {
    const { gateway, socket, states } = start();
    socket.close(4004, 'Authentication failed');
    vi.advanceTimersByTime(120_000);

    expect(gateway.status.state).toBe('failed');
    expect(gateway.isRunning).toBe(false);
    expect(states).not.toContain('reconnecting');
    // Nothing new was opened.
    expect(FakeSocket.last).toBe(socket);
  });

  it('restarts a connection whose heartbeats stop being acknowledged', () => {
    const { socket } = start();
    socket.receive({ op: 10, d: { heartbeat_interval: 1000 } });

    // First beat goes out (jittered inside the interval), unacknowledged.
    vi.advanceTimersByTime(1000);
    expect(socket.frames().some((f) => f.op === 1)).toBe(true);

    // Second beat finds the first unacknowledged and tears the socket down.
    vi.advanceTimersByTime(1000);
    expect(socket.closed).not.toBeNull();
  });

  it('pushes a presence change over the open socket instead of reconnecting', () => {
    const { gateway, socket } = start();
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });
    socket.receive({ op: 0, s: 1, t: 'READY', d: { session_id: 'a', user: { id: '1' } } });

    gateway.setPresence({ status: 'idle', activityType: 3, activityName: 'the queue' });

    const update = socket.frames().find((f) => f.op === 3);
    expect(update!.d.status).toBe('idle');
    expect(update!.d.activities).toEqual([{ type: 3, name: 'the queue' }]);
    expect(socket.closed).toBeNull();
  });

  it('gives up on a handshake that never arrives instead of sitting in "connecting"', () => {
    // A socket to a host that silently drops packets neither opens nor closes.
    // Without a deadline the panel reports "connecting" for ever.
    const { gateway, socket } = start();
    expect(gateway.status.state).toBe('connecting');

    vi.advanceTimersByTime(25_000);
    expect(socket.closed).not.toBeNull();

    // And the usual backoff takes over rather than the attempt being dropped.
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.last).not.toBe(socket);
    expect(gateway.status.state).toBe('reconnecting');
  });

  it('closes cleanly on stop, so Discord marks it offline at once', () => {
    const { gateway, socket } = start();
    socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });
    gateway.stop();

    expect(socket.closed?.code).toBe(1000);
    expect(gateway.status.state).toBe('stopped');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.last).toBe(socket);
  });
});
