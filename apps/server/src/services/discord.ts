import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { discordLinks, games, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import type { SettingsService } from './settings.js';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_CDN = 'https://cdn.discordapp.com';

/**
 * Where a *browser* is sent to authorise, which is not the REST API.
 *
 * This used to be built from `DISCORD_API`, so everyone was sent to
 * `/api/v10/oauth2/authorize` — a path that only answers to the token
 * exchange's POST and refuses the browser's GET. The consent screen never
 * appeared, which took the whole integration down with it: no consent, no
 * code, no link, and so no account for the bot's guild-join to act on.
 */
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';

/**
 * Discord requires applications to identify themselves and will answer a
 * request without a User-Agent with a Cloudflare challenge page rather than
 * an API error — which, arriving as a 403 full of HTML, reads exactly like a
 * rejected token.
 */
const USER_AGENT = 'GameBlade (https://github.com/scopeddlol/gameblade, 0.5.0)';

/**
 * What the OAuth flow asks for, and why each one.
 *
 * `identify` is the account itself. `guilds` is how membership of the
 * operator's server is checked without the bot needing to be in it first.
 * `guilds.join` is what lets someone be added to that server rather than
 * merely told to go and find it.
 *
 * Deliberately absent: anything touching messages or email. A link is for
 * signing in and finding the other people here, and neither needs more.
 */
export const DISCORD_SCOPES = ['identify', 'guilds', 'guilds.join'] as const;

export interface DiscordIdentity {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

/** One linked account, as the rest of the app sees it. */
export interface DiscordLinkInfo {
  discordId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  showUsername: boolean;
  inGuild: boolean;
  linkedAt: string;
}

/** Someone else here who is in the same Discord, offered as a friend suggestion. */
export interface DiscordNeighbour {
  userId: string;
  username: string;
  /** Only when they have chosen to show it. */
  discordUsername: string | null;
  avatarUrl: string | null;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Discord, as far as this server is concerned.
 *
 * Two halves that share credentials and nothing else: OAuth on behalf of a
 * player, and a bot acting as the server. They are one service because they
 * are configured together and are useless apart — the bot is what adds a
 * player to the guild after they authorise, and the guild is what the bot
 * announces into.
 *
 * A note on what is *not* here, because it is the obvious thing to expect:
 * Discord publishes no friends list to third-party applications. There is no
 * scope for it and no endpoint. "Friends from Discord" therefore means the
 * people you share the operator's server with, which is the closest thing the
 * platform actually exposes — and, since linking pushes everyone into that one
 * server, is very nearly the same set in practice.
 */
export class DiscordService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly basePath = '',
    private readonly logger?: FastifyBaseLogger,
  ) {}

  /* --------------------------------------------------------------- config */

  /**
   * The bot token as Discord wants it.
   *
   * Trimmed, and with a leading `Bot ` removed. The portal's Reset Token
   * button copies the bare token, but the docs and every tutorial show it
   * written as `Bot <token>` in an Authorization header — so it is pasted that
   * way often enough to be worth handling. Sending `Bot Bot <token>` gets a
   * 401 that reads exactly like a wrong token, which is the worst kind of
   * configuration mistake: the operator re-copies a token that was already
   * right.
   */
  private get botToken(): string | null {
    const raw = this.settings.get().discordBotToken?.trim();
    if (!raw) return null;
    return raw.replace(/^bot\s+/i, '').trim() || null;
  }

  /** Whether linking and signing in are available at all. */
  get isConfigured(): boolean {
    const { discordClientId, discordClientSecret } = this.settings.get();
    return Boolean(discordClientId?.trim() && discordClientSecret?.trim());
  }

  /** Whether the bot half — posting, adding people to the guild — can work. */
  get hasBot(): boolean {
    return this.botToken !== null;
  }

  /** What the client is allowed to know about the configuration. */
  status(): {
    configured: boolean;
    hasBot: boolean;
    guildId: string | null;
    inviteUrl: string | null;
    requireGuild: boolean;
  } {
    const s = this.settings.get();
    return {
      configured: this.isConfigured,
      hasBot: this.hasBot,
      guildId: s.discordGuildId,
      inviteUrl: s.discordInviteUrl,
      requireGuild: s.discordRequireGuild,
    };
  }

  /**
   * Where to send someone to authorise.
   *
   * `state` is generated by the caller and checked on the way back; without it
   * the callback would accept a code obtained anywhere, which is how an
   * attacker attaches their own Discord account to someone else's session.
   */
  authorizeUrl(state: string, redirectUri: string): string {
    const { discordClientId } = this.settings.get();
    if (!discordClientId) throw ApiError.badRequest('Discord is not configured on this server');

    const params = new URLSearchParams({
      client_id: discordClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DISCORD_SCOPES.join(' '),
      state,
      // Always re-ask: a silent re-auth would make "link a different account"
      // impossible without visiting Discord's own settings.
      prompt: 'consent',
    });
    return `${DISCORD_AUTHORIZE}?${params.toString()}`;
  }

  /* ----------------------------------------------------------------- http */

  private async call<T>(path: string, init: RequestInit & { auth: string }): Promise<T> {
    const { auth, ...rest } = init;

    // Discord rate-limits per route and says how long to wait. One retry is
    // enough for the bursts this server makes — a handful of announcements in
    // a row — and refusing to retry at all is how a five-game scan posts two
    // games and drops three.
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${DISCORD_API}${path}`, {
        ...rest,
        headers: {
          ...(rest.headers ?? {}),
          Authorization: auth,
          // Discord asks applications to identify themselves, and answers a
          // request with no User-Agent with a Cloudflare block page rather
          // than an API error — which reads as "the token is wrong".
          'User-Agent': USER_AGENT,
          // Only when there is something to describe. A GET carrying a JSON
          // content-type is malformed, and Cloudflare is entitled to say so.
          ...(rest.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      });

      if (response.status === 429 && attempt === 0) {
        const wait = retryAfterMs(response.headers.get('retry-after'));
        this.logger?.warn({ path, wait }, 'Discord rate-limited the request; retrying once');
        await sleep(wait);
        continue;
      }

      if (response.status === 204) return undefined as T;

      const text = await response.text();
      if (!response.ok) {
        // Discord's own message is far more useful than a status code — it
        // names the missing permission, the bad snowflake, the unverified bot.
        throw ApiError.badRequest(`${explain(response.status, path)} ${text.slice(0, 300)}`.trim());
      }
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  /* ---------------------------------------------------------------- oauth */

  /** Trades the callback's code for tokens. */
  async exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
    const { discordClientId, discordClientSecret } = this.settings.get();
    if (!discordClientId || !discordClientSecret) {
      throw ApiError.badRequest('Discord is not configured on this server');
    }

    const response = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: discordClientId,
        client_secret: discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      throw ApiError.badRequest(
        `Discord would not exchange that code (${response.status}). Check the redirect URI matches the one registered on the application.`,
      );
    }
    return (await response.json()) as TokenResponse;
  }

  async identify(accessToken: string): Promise<DiscordIdentity> {
    return this.call<DiscordIdentity>('/users/@me', { auth: `Bearer ${accessToken}` });
  }

  /** Whether this access token's owner is in the operator's guild. */
  async isInGuild(accessToken: string): Promise<boolean> {
    const guildId = this.settings.get().discordGuildId;
    if (!guildId) return false;

    const guilds = await this.call<Array<{ id: string }>>('/users/@me/guilds', {
      auth: `Bearer ${accessToken}`,
    });
    return guilds.some((guild) => guild.id === guildId);
  }

  /**
   * Adds someone to the guild, using the `guilds.join` grant they gave.
   *
   * Being told "go and join the Discord" is a step people do not take. This is
   * why the scope is asked for. Returns false when it could not be done — no
   * bot, no guild configured, or the bot lacking Create Invite — so the caller
   * can fall back to showing the invite link.
   */
  async addToGuild(discordId: string, accessToken: string): Promise<boolean> {
    const botToken = this.botToken;
    const { discordGuildId } = this.settings.get();
    if (!botToken || !discordGuildId) return false;

    try {
      await this.call(`/guilds/${discordGuildId}/members/${discordId}`, {
        method: 'PUT',
        auth: `Bot ${botToken}`,
        body: JSON.stringify({ access_token: accessToken }),
      });
      return true;
    } catch (error) {
      // A 204 means "already a member", which `call` treats as success; any
      // real failure here is a permissions problem the invite link works
      // around. It is logged rather than swallowed, because the operator's
      // only other evidence is players quietly never landing in the server.
      this.logger?.warn(
        { err: error, discordId, guildId: discordGuildId },
        'could not add the linked account to the Discord server',
      );
      return false;
    }
  }

  /* ----------------------------------------------------------------- links */

  /** Records or refreshes a link. */
  link(
    userId: string,
    identity: DiscordIdentity,
    tokens: TokenResponse,
    inGuild: boolean,
  ): DiscordLinkInfo {
    const existing = this.db
      .select({ userId: discordLinks.userId })
      .from(discordLinks)
      .where(eq(discordLinks.discordId, identity.id))
      .get();

    if (existing && existing.userId !== userId) {
      throw ApiError.badRequest(
        'That Discord account is already linked to another account on this server.',
      );
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    const row = {
      userId,
      discordId: identity.id,
      username: identity.username,
      globalName: identity.global_name ?? null,
      avatar: identity.avatar ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: expiresAt,
      inGuild,
      guildCheckedAt: isoNow(),
      linkedAt: isoNow(),
    };

    this.db
      .insert(discordLinks)
      .values(row)
      .onConflictDoUpdate({
        target: discordLinks.userId,
        // `showUsername` is deliberately absent: re-linking must not quietly
        // republish a handle somebody had chosen to hide.
        set: {
          discordId: row.discordId,
          username: row.username,
          globalName: row.globalName,
          avatar: row.avatar,
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
          tokenExpiresAt: row.tokenExpiresAt,
          inGuild: row.inGuild,
          guildCheckedAt: row.guildCheckedAt,
        },
      })
      .run();

    return this.forUser(userId) as DiscordLinkInfo;
  }

  unlink(userId: string): void {
    this.db.delete(discordLinks).where(eq(discordLinks.userId, userId)).run();
  }

  /** Whether the handle is shown to other players. */
  setVisibility(userId: string, showUsername: boolean): DiscordLinkInfo {
    const link = this.db.select().from(discordLinks).where(eq(discordLinks.userId, userId)).get();
    if (!link) throw ApiError.notFound('No Discord account is linked');

    this.db.update(discordLinks).set({ showUsername }).where(eq(discordLinks.userId, userId)).run();
    return this.forUser(userId) as DiscordLinkInfo;
  }

  forUser(userId: string): DiscordLinkInfo | null {
    const row = this.db.select().from(discordLinks).where(eq(discordLinks.userId, userId)).get();
    if (!row) return null;

    return {
      discordId: row.discordId,
      username: row.username,
      globalName: row.globalName,
      avatarUrl: avatarUrl(row.discordId, row.avatar),
      showUsername: row.showUsername,
      inGuild: row.inGuild,
      linkedAt: row.linkedAt,
    };
  }

  /** How many players have linked, for the admin panel's own reassurance. */
  linkedCount(): number {
    return (
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(discordLinks)
        .get()?.count ?? 0
    );
  }

  /** The account a Discord id signs in as, if any. */
  userIdFor(discordId: string): string | null {
    return (
      this.db
        .select({ userId: discordLinks.userId })
        .from(discordLinks)
        .where(eq(discordLinks.discordId, discordId))
        .get()?.userId ?? null
    );
  }

  /**
   * The handle to show beside a player, or null.
   *
   * Every read of another player's Discord name goes through here, so the
   * default-off toggle cannot be forgotten at one call site.
   */
  visibleHandleFor(userId: string): string | null {
    const row = this.db
      .select({ username: discordLinks.username, show: discordLinks.showUsername })
      .from(discordLinks)
      .where(eq(discordLinks.userId, userId))
      .get();
    return row?.show ? row.username : null;
  }

  /** Handles for several players at once, honouring each one's choice. */
  visibleHandlesFor(userIds: string[]): Map<string, string> {
    if (userIds.length === 0) return new Map();
    const rows = this.db
      .select({
        userId: discordLinks.userId,
        username: discordLinks.username,
        show: discordLinks.showUsername,
      })
      .from(discordLinks)
      .where(inArray(discordLinks.userId, userIds))
      .all();
    return new Map(rows.filter((row) => row.show).map((row) => [row.userId, row.username]));
  }

  /**
   * Other players here who are also in the operator's Discord.
   *
   * The nearest thing to "your Discord friends" the platform allows: there is
   * no friends scope and no endpoint for it. Since linking pushes everyone
   * into the same server, sharing it is a real signal — these are the people
   * you are actually alongside.
   */
  neighbours(userId: string, limit = 24): DiscordNeighbour[] {
    const self = this.db
      .select({ inGuild: discordLinks.inGuild })
      .from(discordLinks)
      .where(eq(discordLinks.userId, userId))
      .get();
    if (!self?.inGuild) return [];

    return this.db
      .select({
        userId: discordLinks.userId,
        username: users.username,
        discordUsername: discordLinks.username,
        show: discordLinks.showUsername,
        discordId: discordLinks.discordId,
        avatar: discordLinks.avatar,
      })
      .from(discordLinks)
      .innerJoin(users, eq(users.id, discordLinks.userId))
      .where(and(eq(discordLinks.inGuild, true), ne(discordLinks.userId, userId)))
      .limit(limit)
      .all()
      .map((row) => ({
        userId: row.userId,
        username: row.username,
        discordUsername: row.show ? row.discordUsername : null,
        avatarUrl: row.show ? avatarUrl(row.discordId, row.avatar) : null,
      }));
  }

  /* ------------------------------------------------------------------ bot */

  /** Posts a plain message to the announcement channel. */
  async post(content: string, channelId?: string): Promise<void> {
    await this.send({ content }, channelId);
  }

  /** Posts an embed — what a game announcement looks like. */
  async postEmbed(embed: Record<string, unknown>, channelId?: string): Promise<void> {
    await this.send({ embeds: [embed] }, channelId);
  }

  private async send(payload: Record<string, unknown>, channelId?: string): Promise<void> {
    const botToken = this.botToken;
    const target = (channelId ?? this.settings.get().discordChannelId)?.trim();

    if (!botToken) throw ApiError.badRequest('No Discord bot token is configured');
    if (!target) throw ApiError.badRequest('No Discord channel is configured');

    await this.call(`/channels/${target}/messages`, {
      method: 'POST',
      auth: `Bot ${botToken}`,
      body: JSON.stringify(payload),
    });
  }

  /**
   * Announces games added since the last time this ran.
   *
   * A watermark rather than a flag per game: it survives restarts, and does
   * not need a column. Switching announcements on sets the watermark to now,
   * which is what stops a server with ten thousand existing games announcing
   * every one of them the moment the operator ticks the box.
   *
   * Only matched games are announced. An unmatched entry is a folder name and
   * nothing else — no cover, no blurb — and "Some.Game.REPACK-XYZ" is not
   * worth pushing to a Discord.
   *
   * Returns how many were posted. Failures are the caller's to log: a Discord
   * outage must not stop a scan or a schedule.
   */
  async announceNewGames(limit = 5): Promise<number> {
    const s = this.settings.get();
    if (!s.discordAnnounceNewGames || !this.hasBot || !s.discordChannelId?.trim()) return 0;

    // Without an absolute address the embed's artwork would resolve against
    // discord.com. Posting text-only would be worse than waiting for setup.
    const publicBaseUrl = s.discordPublicUrl?.replace(/\/+$/, '') ?? null;

    // First run: start the clock rather than announcing the whole back catalog.
    if (!s.discordLastAnnouncedAt) {
      this.settings.update({ discordLastAnnouncedAt: isoNow() });
      return 0;
    }

    const fresh = this.db
      .select({
        id: games.id,
        title: games.title,
        summary: games.summary,
        addedAt: games.addedAt,
        coverImageId: games.coverImageId,
        releaseDate: games.releaseDate,
        genres: games.genres,
      })
      .from(games)
      .where(
        and(
          gt(games.addedAt, s.discordLastAnnouncedAt),
          isNull(games.missingAt),
          ne(games.matchStatus, 'unmatched'),
        ),
      )
      .orderBy(asc(games.addedAt))
      .limit(limit)
      .all();

    if (fresh.length === 0) return 0;

    let posted = 0;
    for (const game of fresh) {
      await this.postEmbed({
        title: game.title,
        description: game.summary ? truncate(game.summary, 300) : undefined,
        color: 0x2bb7f5,
        // Absolute, because Discord fetches it itself rather than through a
        // player's browser — a relative path would resolve to discord.com.
        thumbnail:
          game.coverImageId && publicBaseUrl
            ? { url: `${publicBaseUrl}${this.basePath}/api/images/${game.coverImageId}` }
            : undefined,
        fields: [
          ...(game.releaseDate
            ? [{ name: 'Released', value: game.releaseDate.slice(0, 4), inline: true }]
            : []),
          ...(game.genres && game.genres.length > 0
            ? [{ name: 'Genres', value: game.genres.slice(0, 3).join(', '), inline: true }]
            : []),
        ],
        footer: { text: 'Just added to the archive' },
      });
      posted += 1;
      // Advance per game, so a failure part way through does not re-announce
      // the ones that already went out.
      this.settings.update({ discordLastAnnouncedAt: game.addedAt });
    }

    return posted;
  }

  /** Confirms the bot token works and says who it is. */
  async botIdentity(): Promise<{ id: string; username: string }> {
    const botToken = this.botToken;
    if (!botToken) throw ApiError.badRequest('No Discord bot token is configured');
    return this.call<{ id: string; username: string }>('/users/@me', {
      auth: `Bot ${botToken}`,
    });
  }

  /**
   * Everything that has to be true before an announcement can arrive, checked
   * one at a time.
   *
   * "Test" used to prove the token and stop. That answers the one question an
   * operator is least likely to have got wrong, and none of the three that
   * actually break this: a bot that was never invited to the server, a channel
   * id copied from the wrong place, and the Send Messages permission missing
   * on the channel itself. Each failure is reported against its own step, with
   * Discord's own words, so the panel says which part to go and fix rather
   * than "it did not work".
   */
  async diagnose(): Promise<{
    bot: { id: string; username: string } | null;
    checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  }> {
    const botToken = this.botToken;
    const s = this.settings.get();
    const checks: Array<{ id: string; label: string; ok: boolean; detail: string }> = [];
    let bot: { id: string; username: string } | null = null;

    if (!botToken) {
      checks.push({
        id: 'token',
        label: 'Bot token',
        ok: false,
        detail: 'No bot token is stored. Paste one from the application’s Bot tab.',
      });
      return { bot, checks };
    }

    try {
      bot = await this.botIdentity();
      checks.push({
        id: 'token',
        label: 'Bot token',
        ok: true,
        detail: `Discord answered as ${bot.username}.`,
      });
    } catch (error) {
      checks.push({ id: 'token', label: 'Bot token', ok: false, detail: reason(error) });
      // Nothing below can succeed without it, and each would fail the same way.
      return { bot, checks };
    }

    const guildId = s.discordGuildId?.trim();
    if (guildId) {
      try {
        const member = await this.call<{ nick?: string | null }>(
          `/guilds/${guildId}/members/${bot.id}`,
          { auth: `Bot ${botToken}` },
        );
        checks.push({
          id: 'guild',
          label: 'In your Discord server',
          ok: true,
          detail: member ? 'The bot is a member of the server.' : 'The bot is a member.',
        });
      } catch (error) {
        checks.push({
          id: 'guild',
          label: 'In your Discord server',
          ok: false,
          detail: `${reason(error)} Invite the bot to the server, or check the server ID.`,
        });
      }
    }

    const channelId = s.discordChannelId?.trim();
    if (!channelId) {
      checks.push({
        id: 'channel',
        label: 'Announcement channel',
        ok: false,
        detail: 'No channel ID is set, so there is nowhere to post.',
      });
      return { bot, checks };
    }

    try {
      const channel = await this.call<{ id: string; name?: string; type: number }>(
        `/channels/${channelId}`,
        { auth: `Bot ${botToken}` },
      );
      checks.push({
        id: 'channel',
        label: 'Announcement channel',
        ok: true,
        detail: channel.name ? `Found #${channel.name}.` : 'The channel is visible to the bot.',
      });
    } catch (error) {
      checks.push({
        id: 'channel',
        label: 'Announcement channel',
        ok: false,
        detail: `${reason(error)} Check the channel ID, and that the bot can see that channel.`,
      });
      return { bot, checks };
    }

    // The only check that proves the whole path, so it is worth the message:
    // View Channel without Send Messages passes every step above and still
    // posts nothing.
    try {
      await this.send({
        content: 'GameBlade is connected. This is a test message from your archive.',
      });
      checks.push({
        id: 'post',
        label: 'Posting',
        ok: true,
        detail: 'A test message was posted to the channel.',
      });
    } catch (error) {
      checks.push({
        id: 'post',
        label: 'Posting',
        ok: false,
        detail: `${reason(error)} Give the bot Send Messages on that channel.`,
      });
    }

    return { bot, checks };
  }

  /** Authenticates the REST-backed bot when the server starts. */
  async startBot(): Promise<{ id: string; username: string } | null> {
    if (!this.hasBot) return null;
    return this.botIdentity();
  }
}

/** How long Discord asked us to wait, clamped to something a request can sit through. */
function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1000;
  return Math.min(seconds * 1000, 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A status code in the operator's terms.
 *
 * The bare "Discord refused /channels/123 (403)" is accurate and useless: the
 * three codes that actually come up here each mean one specific thing that is
 * gone about differently.
 */
function explain(status: number, path: string): string {
  if (status === 401) return 'Discord rejected the bot token — it is wrong, or it has been reset.';
  if (status === 403) {
    return 'Discord allowed the token but refused the action — the bot is missing a permission here.';
  }
  if (status === 404) {
    return 'Discord has no such channel, server or member — check the ID, and that the bot can see it.';
  }
  return `Discord refused ${path} (${status}):`;
}

/** The message out of whatever `call` threw, for a check's detail line. */
function reason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Discord refused the request.';
}

/** Keeps an embed description inside something a reader will actually read. */
function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Discord's CDN path for an avatar, or null when they have never set one. */
function avatarUrl(discordId: string, avatar: string | null): string | null {
  if (!avatar) return null;
  const extension = avatar.startsWith('a_') ? 'gif' : 'png';
  return `${DISCORD_CDN}/avatars/${discordId}/${avatar}.${extension}?size=128`;
}
