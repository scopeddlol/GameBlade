import type {
  AdvertiseSessionInput,
  GameInvite,
  JoinInstructions,
  JoinableSession,
  MultiplayerRule,
  MultiplayerRuleInput,
} from '@gameblade/shared';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameInvites, gameMultiplayerRules, gameSessions, games } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { ProfileService } from './profiles.js';

/**
 * How long an invitation stands.
 *
 * Short on purpose. It carries a connect string, and a connect string goes
 * stale the moment the host quits — an invite that still looks live an hour
 * later sends someone to a machine that is no longer listening.
 */
const INVITE_TTL_MS = 10 * 60_000;

/**
 * A session nobody has reported in longer than this is treated as over.
 *
 * A client that crashes never sends its "stopped" message, and a friends list
 * offering to join a game that ended yesterday is worse than one that offers
 * nothing.
 */
const SESSION_STALE_MS = 15 * 60_000;

/**
 * Addresses that may be handed to another machine as somewhere to connect.
 *
 * A hostname is refused outright: this value is substituted into arguments for
 * a game process, and the set of things that look like a hostname is much
 * larger and stranger than the set of things that are one. An address the
 * server derived from the connection is trusted; one the client supplied is
 * checked here first.
 */
export function isUsableAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 45) return false;

  // Dotted-quad IPv4, each octet in range.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (v4) {
    return v4.slice(1).every((part) => {
      const n = Number(part);
      return String(n) === part.replace(/^0+(?=\d)/, '') && n >= 0 && n <= 255;
    });
  }

  // IPv6, hex groups and at most one elision. Deliberately strict.
  if (/^[0-9a-fA-F:]+$/.test(trimmed) && trimmed.includes(':')) {
    return (trimmed.match(/::/g) ?? []).length <= 1 && trimmed.split(':').length <= 9;
  }

  return false;
}

/**
 * Fills a rule's template with an address and port.
 *
 * The result is split on whitespace by the caller into separate process
 * arguments; it never reaches a shell. Both values are validated before they
 * arrive here, so the template cannot be used to smuggle anything in.
 */
export function buildJoinArgs(template: string, address: string, port: number | null): string {
  return template
    .split('{address}')
    .join(address)
    .split('{port}')
    .join(port === null ? '' : String(port))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Inviting a friend into a game already in progress.
 *
 * The whole feature rests on one thing an operator supplies per title: the
 * arguments that make a copy of the game connect to another. Everything else —
 * who is playing what, who may be told, how long the answer stays good — is
 * this service's job.
 */
export class MultiplayerService {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileService,
  ) {}

  /* ------------------------------------------------------------- rules */

  ruleFor(gameId: string): MultiplayerRule | null {
    const row = this.db
      .select()
      .from(gameMultiplayerRules)
      .where(eq(gameMultiplayerRules.gameId, gameId))
      .get();
    return row ? this.toRule(row) : null;
  }

  setRule(gameId: string, input: MultiplayerRuleInput): MultiplayerRule {
    const game = this.db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get();
    if (!game) throw ApiError.notFound('Game not found');

    if (!input.joinArgs.includes('{address}')) {
      throw ApiError.badRequest('The join arguments must contain {address}');
    }

    // One rule per game, as with launch and save rules.
    this.db.delete(gameMultiplayerRules).where(eq(gameMultiplayerRules.gameId, gameId)).run();
    const record = {
      id: newId('mpr'),
      gameId,
      joinArgs: input.joinArgs,
      defaultPort: input.defaultPort ?? null,
      hostArgs: input.hostArgs ?? null,
      note: input.note ?? null,
      createdAt: isoNow(),
    };
    this.db.insert(gameMultiplayerRules).values(record).run();
    return this.toRule(record);
  }

  clearRule(gameId: string): void {
    this.db.delete(gameMultiplayerRules).where(eq(gameMultiplayerRules.gameId, gameId)).run();
  }

  /* ---------------------------------------------------------- sessions */

  /**
   * Records what someone is playing and whether it can be joined.
   *
   * `observedAddress` is what the server sees the request coming from. A client
   * may supply its own instead — useful on a LAN, where the address the server
   * sees is the router's — but only if it is a real address.
   */
  advertise(userId: string, input: AdvertiseSessionInput, observedAddress: string): void {
    const rule = this.ruleFor(input.gameId);

    const supplied = input.address?.trim();
    if (supplied && !isUsableAddress(supplied)) {
      throw ApiError.badRequest('That is not an address anyone could connect to');
    }

    const address = supplied || observedAddress;
    // Only offer to join something the client could actually join.
    const joinable = Boolean(input.joinable && rule && isUsableAddress(address));

    const record = {
      userId,
      gameId: input.gameId,
      address: joinable ? address : null,
      port: input.port ?? rule?.defaultPort ?? null,
      joinable,
      startedAt: isoNow(),
      lastSeenAt: isoNow(),
    };

    this.db.delete(gameSessions).where(eq(gameSessions.userId, userId)).run();
    this.db.insert(gameSessions).values(record).run();
  }

  /** Called when the game exits, or the client signs out. */
  endSession(userId: string): void {
    this.db.delete(gameSessions).where(eq(gameSessions.userId, userId)).run();
  }

  /** What the caller's friends are playing that the caller could join. */
  joinableFriends(userId: string): JoinableSession[] {
    const friendIds = [...this.profiles.friendIds(userId)];
    if (friendIds.length === 0) return [];

    const fresh = new Date(Date.now() - SESSION_STALE_MS).toISOString();

    return this.db
      .select({
        userId: gameSessions.userId,
        gameId: gameSessions.gameId,
        gameTitle: games.title,
        joinable: gameSessions.joinable,
        startedAt: gameSessions.startedAt,
      })
      .from(gameSessions)
      .innerJoin(games, eq(games.id, gameSessions.gameId))
      .where(
        and(
          inArray(gameSessions.userId, friendIds),
          eq(gameSessions.joinable, true),
          gt(gameSessions.lastSeenAt, fresh),
        ),
      )
      .all();
  }

  /* ----------------------------------------------------------- invites */

  /**
   * Offers a friend the connect string for whatever the caller is playing.
   *
   * Friends only, and never to someone who is not one: the invite reveals the
   * host's address, which is not something to hand out on request.
   */
  invite(fromUserId: string, toUserId: string): GameInvite {
    if (fromUserId === toUserId) throw ApiError.badRequest('You are already there');
    if (!this.profiles.friendIds(fromUserId).has(toUserId)) {
      throw ApiError.forbidden('You can only invite friends');
    }

    const session = this.db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.userId, fromUserId))
      .get();

    if (!session?.joinable || !session.address) {
      throw ApiError.badRequest('You are not in a game anyone can join');
    }

    const game = this.db
      .select({ title: games.title })
      .from(games)
      .where(eq(games.id, session.gameId))
      .get();
    if (!game) throw ApiError.notFound('Game not found');

    const record = {
      id: newId('gin'),
      fromUserId,
      toUserId,
      gameId: session.gameId,
      address: session.address,
      port: session.port,
      createdAt: isoNow(),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      respondedAt: null,
    };
    this.db.insert(gameInvites).values(record).run();

    const from = this.profiles.summarizeOne(fromUserId, toUserId);
    if (!from) throw ApiError.notFound('Your profile could not be read');

    return {
      id: record.id,
      from,
      gameId: session.gameId,
      gameTitle: game.title,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
  }

  /** Invitations still worth showing: unanswered and not yet expired. */
  pending(userId: string): GameInvite[] {
    const now = isoNow();
    return this.db
      .select({
        id: gameInvites.id,
        fromUserId: gameInvites.fromUserId,
        gameId: gameInvites.gameId,
        gameTitle: games.title,
        createdAt: gameInvites.createdAt,
        expiresAt: gameInvites.expiresAt,
      })
      .from(gameInvites)
      .innerJoin(games, eq(games.id, gameInvites.gameId))
      .where(
        and(
          eq(gameInvites.toUserId, userId),
          isNull(gameInvites.respondedAt),
          gt(gameInvites.expiresAt, now),
        ),
      )
      .all()
      .flatMap((row) => {
        // An invitation from an account that has since been removed is not
        // worth rendering, and there is nothing to render it as.
        const from = this.profiles.summarizeOne(row.fromUserId, userId);
        return from
          ? [
              {
                id: row.id,
                from,
                gameId: row.gameId,
                gameTitle: row.gameTitle,
                createdAt: row.createdAt,
                expiresAt: row.expiresAt,
              },
            ]
          : [];
      });
  }

  /**
   * Turns an invitation into something the client can launch.
   *
   * The connect string is built here rather than being handed out when the
   * invite was made, so a host who has since stopped cannot be connected to and
   * the address is never sitting in the invitee's client longer than it is good
   * for.
   */
  accept(userId: string, inviteId: string): JoinInstructions {
    const invite = this.db.select().from(gameInvites).where(eq(gameInvites.id, inviteId)).get();

    if (!invite || invite.toUserId !== userId) throw ApiError.notFound('Invitation not found');
    if (invite.respondedAt) throw ApiError.gone('That invitation has already been used');
    if (invite.expiresAt <= isoNow()) throw ApiError.gone('That invitation has expired');

    const rule = this.ruleFor(invite.gameId);
    if (!rule) throw ApiError.badRequest('This game has no join instructions');

    const game = this.db
      .select({ title: games.title })
      .from(games)
      .where(eq(games.id, invite.gameId))
      .get();
    if (!game) throw ApiError.notFound('Game not found');

    this.db
      .update(gameInvites)
      .set({ respondedAt: isoNow() })
      .where(eq(gameInvites.id, inviteId))
      .run();

    return {
      gameId: invite.gameId,
      gameTitle: game.title,
      args: buildJoinArgs(rule.joinArgs, invite.address, invite.port ?? rule.defaultPort),
    };
  }

  decline(userId: string, inviteId: string): void {
    this.db
      .update(gameInvites)
      .set({ respondedAt: isoNow() })
      .where(and(eq(gameInvites.id, inviteId), eq(gameInvites.toUserId, userId)))
      .run();
  }

  private toRule(row: {
    id: string;
    gameId: string;
    joinArgs: string;
    defaultPort: number | null;
    hostArgs: string | null;
    note: string | null;
  }): MultiplayerRule {
    return {
      id: row.id,
      gameId: row.gameId,
      joinArgs: row.joinArgs,
      defaultPort: row.defaultPort,
      hostArgs: row.hostArgs,
      note: row.note,
    };
  }
}
