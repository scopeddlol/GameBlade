import { eq, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

export interface RuntimeSettings {
  serverName: string;
  tagline: string;
  allowSelfRegistration: boolean;
  /** Where the landing page sends visitors to get the Windows client. */
  downloadUrl: string | null;
  clientVersion: string | null;
  igdbClientId: string | null;
  igdbClientSecret: string | null;
  steamGridDbKey: string | null;
  /** Reads the public Steam achievement schema; no user data is involved. */
  steamApiKey: string | null;
  /** Ceiling on one download stream, in KB/s. 0 disables the limit. */
  downloadSpeedLimitKbps: number;
  /** Default monthly transfer allowance per account, in MB. 0 disables it. */
  monthlyQuotaMb: number;
  /**
   * Whether clients may fetch game data from mesh nodes rather than from here.
   *
   * Off by default. With it off the coordinator still accepts registrations and
   * heartbeats, so a node can be enrolled and left to sync before any client is
   * ever pointed at it — turning it on is then a switch, not a migration.
   */
  meshEnabled: boolean;
  /** Named colour theme applied to the web app and the desktop client. */
  themePreset: string;
  /** Optional hex accent replacing the preset's own. */
  themeAccent: string | null;
  /** The landing page, as an ordered list of blocks. Null means "the default". */
  landingBlocks: unknown;
  /** Archives of the data directory to keep before the oldest is deleted. */
  backupKeep: number;
  /** Hours between automatic archives; 0 turns them off. */
  backupEveryHours: number;
  /** Whether cached artwork is archived too. Large, and re-fetchable. */
  backupIncludeImages: boolean;

  /* ------------------------------------------------------------- Discord */

  /** OAuth application credentials, for linking and signing in with Discord. */
  discordClientId: string | null;
  discordClientSecret: string | null;
  /** Bot token, for posting and for adding people to the guild. */
  discordBotToken: string | null;
  /** The server players are expected to be in. */
  discordGuildId: string | null;
  /** Where to send someone who is not in it yet. */
  discordInviteUrl: string | null;
  /** Channel the bot announces into. */
  discordChannelId: string | null;
  /**
   * The address players reach this server on, e.g. https://archive.example.com.
   *
   * Needed because Discord fetches embedded cover art itself rather than
   * through anyone's browser, so a relative path would resolve against
   * discord.com. There is no request to infer it from when a schedule posts.
   */
  discordPublicUrl: string | null;
  /** Whether a newly scanned game is announced. */
  discordAnnounceNewGames: boolean;
  /** Whether an approved request is announced. */
  discordAnnounceRequests: boolean;
  /**
   * Whether linking requires being in the guild.
   *
   * On by default: the point of pointing every player at one Discord is that
   * they end up in it.
   */
  discordRequireGuild: boolean;
  /**
   * How far the new-game announcer has got.
   *
   * A watermark rather than a flag per game: it survives restarts, and setting
   * it to "now" the moment announcements are switched on is what stops a
   * server with ten thousand existing games announcing all of them at once.
   */
  discordLastAnnouncedAt: string | null;

  /* ------------------------------------------------------------- the bot */

  /**
   * Whether the gateway connection is wanted.
   *
   * Persisted rather than held in memory so the bot comes back by itself after
   * a restart. An operator who turned it on does not expect to have to turn it
   * on again every deploy — and a bot that is quietly offline looks exactly
   * like a bot that is broken.
   */
  discordBotEnabled: boolean;
  /** online / idle / dnd / invisible, as Discord names them. */
  discordPresenceStatus: string;
  /** Discord's own activity type number: 0 Playing … 5 Competing in. */
  discordActivityType: number;
  /** The text beside it. Blank means no activity at all, just a presence. */
  discordActivityName: string | null;

  /* ----------------------------------------------------------------- roles */

  /**
   * A role handed to everyone who joins the Discord.
   *
   * Needs the privileged Guild Members intent, which the gateway only asks for
   * when this is set — an operator who does not want auto-roles never has to
   * turn anything on in the developer portal.
   */
  discordAutoRoleId: string | null;
  /** Whether emoji-on-a-message role bindings are acted on at all. */
  discordReactionRolesEnabled: boolean;

  /* --------------------------------------------------------------- tickets */

  discordTicketsEnabled: boolean;
  /** Where the panel with the button lives. */
  discordSupportChannelId: string | null;
  /** Optional category the per-ticket channels are created under. */
  discordTicketCategoryId: string | null;
  /** Optional role granted access to every ticket channel. */
  discordStaffRoleId: string | null;
  discordTicketPanelTitle: string | null;
  discordTicketPanelMessage: string | null;
  /** Counter behind the ticket-0001 names, so numbers never repeat. */
  discordTicketCounter: number;
}

const DEFAULT_TAGLINE = 'A private home for free-to-play and DRM-free games worth keeping.';

type SettingKey = keyof RuntimeSettings;

/**
 * Settings resolve database-first, then fall back to environment variables.
 *
 * That ordering lets an operator seed credentials through compose on first run
 * while still allowing an admin to change them later in the UI without editing
 * the stack and restarting the container.
 */
export class SettingsService {
  private cache: RuntimeSettings | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  get(): RuntimeSettings {
    if (this.cache) return this.cache;

    const rows = this.db.select().from(settings).all();
    const stored = new Map(rows.map((r) => [r.key, r.value as unknown]));

    const asString = (key: SettingKey, fallback: string | null): string | null => {
      const value = stored.get(key);
      if (typeof value === 'string' && value.length > 0) return value;
      if (value === null) return null;
      return fallback;
    };

    const asBoolean = (key: SettingKey, fallback: boolean): boolean => {
      const value = stored.get(key);
      return typeof value === 'boolean' ? value : fallback;
    };

    const asNumber = (key: SettingKey, fallback: number): number => {
      const value = stored.get(key);
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    };

    this.cache = {
      serverName: asString('serverName', 'GameBlade') ?? 'GameBlade',
      tagline: asString('tagline', DEFAULT_TAGLINE) ?? DEFAULT_TAGLINE,
      allowSelfRegistration: asBoolean('allowSelfRegistration', this.config.allowSelfRegistration),
      downloadUrl: asString('downloadUrl', this.config.clientDownloadUrl),
      clientVersion: asString('clientVersion', null),
      igdbClientId: asString('igdbClientId', this.config.igdb?.clientId ?? null),
      igdbClientSecret: asString('igdbClientSecret', this.config.igdb?.clientSecret ?? null),
      steamGridDbKey: asString('steamGridDbKey', this.config.steamGridDbKey),
      steamApiKey: asString('steamApiKey', this.config.steamApiKey),
      downloadSpeedLimitKbps: asNumber('downloadSpeedLimitKbps', 0),
      monthlyQuotaMb: asNumber('monthlyQuotaMb', 0),
      meshEnabled: asBoolean('meshEnabled', false),
      themePreset: asString('themePreset', 'midnight') ?? 'midnight',
      themeAccent: asString('themeAccent', null),
      backupKeep: asNumber('backupKeep', 7),
      backupEveryHours: asNumber('backupEveryHours', 24),
      backupIncludeImages: asBoolean('backupIncludeImages', false),
      landingBlocks: stored.get('landingBlocks') ?? null,
      discordClientId: asString('discordClientId', null),
      discordClientSecret: asString('discordClientSecret', null),
      discordBotToken: asString('discordBotToken', null),
      discordGuildId: asString('discordGuildId', null),
      discordInviteUrl: asString('discordInviteUrl', null),
      discordChannelId: asString('discordChannelId', null),
      discordPublicUrl: asString('discordPublicUrl', null),
      discordAnnounceNewGames: asBoolean('discordAnnounceNewGames', true),
      discordAnnounceRequests: asBoolean('discordAnnounceRequests', true),
      discordRequireGuild: asBoolean('discordRequireGuild', true),
      discordLastAnnouncedAt: asString('discordLastAnnouncedAt', null),
      discordBotEnabled: asBoolean('discordBotEnabled', false),
      discordPresenceStatus: asString('discordPresenceStatus', 'online') ?? 'online',
      discordActivityType: asNumber('discordActivityType', 0),
      discordActivityName: asString('discordActivityName', null),
      discordAutoRoleId: asString('discordAutoRoleId', null),
      discordReactionRolesEnabled: asBoolean('discordReactionRolesEnabled', false),
      discordTicketsEnabled: asBoolean('discordTicketsEnabled', false),
      discordSupportChannelId: asString('discordSupportChannelId', null),
      discordTicketCategoryId: asString('discordTicketCategoryId', null),
      discordStaffRoleId: asString('discordStaffRoleId', null),
      discordTicketPanelTitle: asString('discordTicketPanelTitle', null),
      discordTicketPanelMessage: asString('discordTicketPanelMessage', null),
      discordTicketCounter: asNumber('discordTicketCounter', 0),
    };
    return this.cache;
  }

  update(patch: Partial<RuntimeSettings>): RuntimeSettings {
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;

      // Clearing a field (e.g. an emptied secret box) means "explicitly unset",
      // which get() has to tell apart from "never configured" — the former
      // must not fall back to an env-var default, the latter should. That
      // requires storing a real JSON null rather than omitting the row, but
      // handing the driver a bare JS null on this NOT NULL column bypasses
      // Drizzle's JSON encoder instead of running it, so it writes SQL NULL
      // straight through and the insert fails its own NOT NULL constraint —
      // every save that touched a blank field (which is most of them; the
      // settings form always sends clientVersion as null when unset) 500'd.
      // A literal JSON text 'null' round-trips through the same column as the
      // real value null on read, without going anywhere near that path.
      const encoded = value === null ? sql`'null'` : (value as never);

      this.db
        .insert(settings)
        .values({ key, value: encoded, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: encoded, updatedAt: now },
        })
        .run();
    }
    this.cache = null;
    return this.get();
  }

  /**
   * Turn node-backed downloads on when an installation pairs its first node.
   *
   * An explicit stored value always wins, including `false`: an administrator
   * who deliberately switched the mesh off must not have a reconnecting node
   * switch it back on. Older releases failed to expose this setting through
   * the admin API, though, so installations with paired nodes generally have
   * no row at all. Their next successful registration or catalog report safely
   * completes the pairing that was already intended.
   */
  enableMeshWhenUnconfigured(): RuntimeSettings {
    const configured = this.db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, 'meshEnabled'))
      .get();

    return configured ? this.get() : this.update({ meshEnabled: true });
  }

  /** Drop a stored override so the environment value applies again. */
  clear(key: SettingKey): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
    this.cache = null;
  }

  invalidate(): void {
    this.cache = null;
  }
}
