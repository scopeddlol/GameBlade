import {
  DISCORD_ACTIVITY_LABELS,
  type DiscordBotState,
  type DiscordActivityType,
} from '@gameblade/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { discordLinks, discordTickets, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isoNow } from '../lib/time.js';
import type { DiscordService, DiscordUpload } from './discord.js';
import { DiscordGateway } from './discordGateway.js';
import type { MediaStore } from './media.js';
import type { ProfileService } from './profiles.js';
import type { SettingsService } from './settings.js';

/**
 * The bot half: a live connection, slash commands, buttons and tickets.
 *
 * Split from `DiscordService` because the two have genuinely different jobs.
 * That one is a stateless REST client — post this, check that — and is used by
 * the scanner and the request queue without anybody thinking about it. This
 * one owns a socket, a session, and a set of things Discord will call back
 * into. Keeping them together would mean every announcement went through an
 * object with a connection lifecycle.
 */

/* ------------------------------------------------------------- interactions */

/** Discord's interaction types, only the ones answered here. */
const INTERACTION = {
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
} as const;

/** Interaction callback types. */
const CALLBACK = {
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
  MODAL: 9,
} as const;

/** Only the caller sees the reply. */
const EPHEMERAL = 1 << 6;

/**
 * Custom ids for the components this bot owns.
 *
 * Namespaced, because a custom id is global to the message and an id like
 * `close` would collide with any other bot's button in the same channel.
 */
const ID = {
  OPEN: 'gb:ticket:open',
  OPEN_MODAL: 'gb:ticket:modal',
  CLOSE: 'gb:ticket:close',
  CONFIRM_CLOSE: 'gb:ticket:confirm',
} as const;

/** Discord permission bits, as strings because they exceed Number.MAX_SAFE_INTEGER. */
const PERM = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_HISTORY: 1n << 16n,
  ATTACH_FILES: 1n << 15n,
  EMBED_LINKS: 1n << 14n,
} as const;

const TICKET_MEMBER_ALLOW = (
  PERM.VIEW_CHANNEL |
  PERM.SEND_MESSAGES |
  PERM.READ_HISTORY |
  PERM.ATTACH_FILES |
  PERM.EMBED_LINKS
).toString();

interface Interaction {
  id: string;
  token: string;
  type: number;
  application_id?: string;
  guild_id?: string;
  channel_id?: string;
  data?: {
    name?: string;
    custom_id?: string;
    components?: Array<{ components?: Array<{ custom_id?: string; value?: string }> }>;
  };
  member?: { user?: DiscordUser; roles?: string[] };
  user?: DiscordUser;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface TicketRow {
  id: string;
  number: number;
  channelId: string | null;
  openerDiscordId: string;
  openerName: string;
  username: string | null;
  subject: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
}

export class DiscordBotService {
  private readonly gateway: DiscordGateway;
  /** Set once READY lands; for a bot this is also the application id. */
  private applicationId: string | null = null;
  private commandsRegistered = false;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly discord: DiscordService,
    private readonly profiles: ProfileService,
    private readonly media: MediaStore,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.gateway = new DiscordGateway(logger, {
      onDispatch: (event, data) => this.onDispatch(event, data),
      onStateChange: (state) => {
        // Commands are registered once the bot is actually online: doing it
        // earlier means guessing the application id, and doing it on every
        // reconnect would spend a heavily rate-limited call on a no-op.
        if (state === 'ready' && !this.commandsRegistered) void this.registerCommands();
      },
    });
  }

  /* -------------------------------------------------------------- lifecycle */

  get status(): {
    state: DiscordBotState;
    detail: string | null;
    botId: string | null;
    readyAt: string | null;
    enabled: boolean;
  } {
    return { ...this.gateway.status, enabled: this.settings.get().discordBotEnabled };
  }

  /**
   * Brings the bot up if the operator left it switched on.
   *
   * Called at boot. Silent when it was switched off or there is no token, so a
   * server with no Discord configured starts exactly as it did before.
   */
  restore(): void {
    const s = this.settings.get();
    if (!s.discordBotEnabled || !this.discord.hasBot) return;
    this.startNow();
  }

  start(): void {
    if (!this.discord.hasBot) {
      throw ApiError.badRequest('Add a bot token before starting the bot');
    }
    this.settings.update({ discordBotEnabled: true });
    this.startNow();
  }

  stop(): void {
    this.settings.update({ discordBotEnabled: false });
    this.gateway.stop();
  }

  /**
   * Drops the connection without changing what the operator asked for.
   *
   * The distinction matters: `stop()` is somebody pressing the button and must
   * be remembered, while this is the process going away and must not be — a
   * restart would otherwise come back with the bot switched off.
   */
  shutdown(): void {
    this.gateway.stop('The server is shutting down');
  }

  private startNow(): void {
    const token = this.discord.credentials;
    if (!token) return;
    this.commandsRegistered = false;
    this.gateway.start(token, this.presence());
  }

  /** Pushes a changed status or activity to the live connection. */
  applyPresence(): void {
    this.gateway.setPresence(this.presence());
  }

  private presence() {
    const s = this.settings.get();
    return {
      status: s.discordPresenceStatus,
      activityType: (s.discordActivityName?.trim() ? s.discordActivityType : null) as number | null,
      activityName: s.discordActivityName,
    };
  }

  /** What the activity reads as, for the panel's own preview. */
  activityPreview(): string | null {
    const s = this.settings.get();
    const name = s.discordActivityName?.trim();
    if (!name) return null;
    const type = s.discordActivityType as DiscordActivityType;
    return type === 4 ? name : `${DISCORD_ACTIVITY_LABELS[type] ?? 'Playing'} ${name}`;
  }

  /* ---------------------------------------------------------------- commands */

  /**
   * Registers the slash commands against the operator's guild.
   *
   * Guild commands rather than global ones: a global command takes up to an
   * hour to appear, which makes setting this up feel broken, and there is
   * exactly one server that matters here anyway.
   */
  private async registerCommands(): Promise<void> {
    const guildId = this.settings.get().discordGuildId?.trim();
    this.applicationId = this.gateway.status.botId;
    if (!this.applicationId || !guildId) return;

    try {
      await this.discord.botCall(`/applications/${this.applicationId}/guilds/${guildId}/commands`, {
        method: 'PUT',
        body: JSON.stringify([
          {
            name: 'profile',
            description: 'Show your GameBlade profile',
            type: 1,
          },
        ]),
      });
      this.commandsRegistered = true;
      this.logger.info('registered the Discord slash commands');
    } catch (error) {
      // Worth logging loudly and not worth taking the bot down for: the
      // announcements and the ticket buttons all still work without it.
      this.logger.error({ err: error }, 'could not register the Discord slash commands');
    }
  }

  /* ------------------------------------------------------------- dispatching */

  private onDispatch(event: string, data: unknown): void {
    if (event !== 'INTERACTION_CREATE') return;
    // Deliberately not awaited: Discord expects the socket to keep being read
    // while a handler works, and every path below answers over REST.
    void this.onInteraction(data as Interaction).catch((error: unknown) => {
      this.logger.error({ err: error }, 'a Discord interaction failed');
    });
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    const user = interaction.member?.user ?? interaction.user;
    if (!user) return;

    if (interaction.type === INTERACTION.APPLICATION_COMMAND) {
      if (interaction.data?.name === 'profile') await this.profileCommand(interaction, user);
      return;
    }

    if (interaction.type === INTERACTION.MESSAGE_COMPONENT) {
      const id = interaction.data?.custom_id;
      if (id === ID.OPEN) await this.openModal(interaction);
      else if (id === ID.CLOSE) await this.confirmClose(interaction);
      else if (id === ID.CONFIRM_CLOSE) await this.closeTicket(interaction, user);
      return;
    }

    if (interaction.type === INTERACTION.MODAL_SUBMIT) {
      if (interaction.data?.custom_id === ID.OPEN_MODAL) await this.createTicket(interaction, user);
    }
  }

  /** Answers an interaction. Discord allows three seconds, and means it. */
  private respond(
    interaction: Interaction,
    type: number,
    data?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.discord.botCall(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: 'POST',
      body: JSON.stringify({ type, data }),
    });
  }

  /** Replaces a deferred reply once the slow part is done. */
  private followUp(
    interaction: Interaction,
    payload: Record<string, unknown>,
    file?: DiscordUpload,
  ): Promise<unknown> {
    const appId = this.applicationId ?? interaction.application_id;
    return this.discord.botCall(`/webhooks/${appId}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      body: file ? uploadBody(payload, file) : JSON.stringify(payload),
    });
  }

  /* ----------------------------------------------------------------- profile */

  /**
   * `/profile` — the caller's GameBlade profile, in the channel.
   *
   * Deferred first. Reading their artwork off disk and posting it as a real
   * attachment is fast but not free, and Discord's three-second window is not
   * a budget worth spending on an operation that touches the filesystem.
   *
   * The artwork is attached rather than linked because the media route needs
   * authentication — Discord fetching a URL from this server would get a 401,
   * and making profile pictures publicly readable to avoid that is not a trade
   * anybody asked for.
   */
  private async profileCommand(interaction: Interaction, user: DiscordUser): Promise<void> {
    await this.respond(interaction, CALLBACK.DEFERRED_CHANNEL_MESSAGE);

    const userId = this.discord.userIdFor(user.id);
    if (!userId) {
      await this.followUp(interaction, {
        content:
          'That Discord account is not linked to anyone here yet. Sign in on the website, open your account page and link it — then try again.',
        flags: EPHEMERAL,
      });
      return;
    }

    const detail = this.profiles.detail(userId, userId);
    const attachment = await this.readMedia(detail.avatarUrl, 'avatar');

    const hours = Math.round(detail.totalPlaySeconds / 360) / 10;
    const embed: Record<string, unknown> = {
      author: {
        name: detail.displayName || detail.username,
        icon_url: discordAvatar(user),
      },
      title: detail.username,
      description: detail.bio ? truncate(detail.bio, 280) : undefined,
      color: colorOf(detail.accentColor),
      thumbnail: attachment ? { url: `attachment://${attachment.fileName}` } : undefined,
      fields: [
        { name: 'Games', value: detail.gameCount.toLocaleString(), inline: true },
        { name: 'Played', value: `${hours.toLocaleString()} h`, inline: true },
        { name: 'Achievements', value: detail.achievementCount.toLocaleString(), inline: true },
        { name: 'Friends', value: detail.friendCount.toLocaleString(), inline: true },
        {
          name: 'Here since',
          value: `<t:${Math.floor(Date.parse(detail.createdAt) / 1000)}:D>`,
          inline: true,
        },
        {
          name: 'Now',
          value: detail.playingGameTitle ? `Playing ${detail.playingGameTitle}` : 'Not in a game',
          inline: true,
        },
      ],
      footer: { text: this.settings.get().serverName },
    };

    await this.followUp(interaction, { embeds: [embed] }, attachment ?? undefined);
  }

  /**
   * Reads one of this server's own media files, for attaching.
   *
   * Null rather than throwing for anything missing: a profile with no avatar
   * is ordinary, and a card without a picture is much better than a command
   * that answers with an error.
   */
  private async readMedia(url: string | null, label: string): Promise<DiscordUpload | null> {
    const id = url?.split('/').pop()?.split('?')[0];
    if (!id) return null;

    try {
      const { stream, record } = await this.media.open(id);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const extension = record.contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      return {
        fileName: `${label}.${extension}`,
        contentType: record.contentType,
        bytes: Buffer.concat(chunks),
      };
    } catch {
      return null;
    }
  }

  /* ----------------------------------------------------------------- tickets */

  /**
   * Publishes (or replaces) the panel people press to open a ticket.
   *
   * Posted fresh each time rather than edited: the operator may have changed
   * the channel, and an edit to a message in a channel they have moved away
   * from is a silent no-op.
   */
  async publishPanel(): Promise<{ channelId: string; messageId: string }> {
    const s = this.settings.get();
    const channelId = s.discordSupportChannelId?.trim();
    if (!channelId) throw ApiError.badRequest('Pick a support channel first');

    const message = await this.discord.postMessage(
      {
        embeds: [
          {
            title: s.discordTicketPanelTitle?.trim() || 'Need a hand?',
            description:
              s.discordTicketPanelMessage?.trim() ||
              'Open a ticket and someone will get back to you. It creates a private channel that only you and the staff can see.',
            color: 0x2bb7f5,
            footer: { text: s.serverName },
          },
        ],
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: 'Open a ticket',
                emoji: { name: '🎫' },
                custom_id: ID.OPEN,
              },
            ],
          },
        ],
      },
      { channelId },
    );

    return { channelId, messageId: message.id };
  }

  /** The button was pressed: ask what it is about before making a channel. */
  private async openModal(interaction: Interaction): Promise<void> {
    // The panel is a message and messages outlive the setting that produced
    // them: switching tickets off cannot unpost it, so the button has to
    // refuse rather than the panel having to be deleted by hand.
    if (!this.settings.get().discordTicketsEnabled) {
      await this.respond(interaction, CALLBACK.CHANNEL_MESSAGE, {
        content: 'Tickets are closed at the moment. Try again later.',
        flags: EPHEMERAL,
      });
      return;
    }

    await this.respond(interaction, CALLBACK.MODAL, {
      custom_id: ID.OPEN_MODAL,
      title: 'Open a ticket',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'subject',
              label: 'What do you need help with?',
              style: 1,
              min_length: 3,
              max_length: 100,
              required: true,
              placeholder: 'A short summary',
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'detail',
              label: 'Anything else worth knowing?',
              style: 2,
              max_length: 1000,
              required: false,
            },
          ],
        },
      ],
    });
  }

  /**
   * Creates the private channel and records the ticket.
   *
   * The overwrites are the whole security model: @everyone is denied View
   * Channel outright, and the opener, the staff role and the bot are granted
   * it back. Getting this wrong publishes somebody's support request to the
   * whole server, so the deny comes first and the grants are explicit.
   */
  private async createTicket(interaction: Interaction, user: DiscordUser): Promise<void> {
    await this.respond(interaction, CALLBACK.DEFERRED_CHANNEL_MESSAGE, { flags: EPHEMERAL });

    const s = this.settings.get();
    const guildId = interaction.guild_id ?? s.discordGuildId?.trim();
    if (!guildId) {
      await this.followUp(interaction, {
        content: 'This server is not configured for tickets yet.',
        flags: EPHEMERAL,
      });
      return;
    }

    const existing = this.db
      .select({ channelId: discordTickets.channelId })
      .from(discordTickets)
      .where(and(eq(discordTickets.openerDiscordId, user.id), eq(discordTickets.status, 'open')))
      .get();

    if (existing?.channelId) {
      // One at a time. Otherwise a bored click opens forty channels.
      await this.followUp(interaction, {
        content: `You already have a ticket open: <#${existing.channelId}>`,
        flags: EPHEMERAL,
      });
      return;
    }

    const fields = interaction.data?.components?.flatMap((row) => row.components ?? []) ?? [];
    const subject = fields.find((f) => f.custom_id === 'subject')?.value?.trim() || 'No subject';
    const detail = fields.find((f) => f.custom_id === 'detail')?.value?.trim() ?? '';

    const number = s.discordTicketCounter + 1;
    this.settings.update({ discordTicketCounter: number });

    const overwrites: Array<Record<string, string>> = [
      // @everyone's id is the guild's own id. Denied first.
      { id: guildId, type: '0', deny: PERM.VIEW_CHANNEL.toString() },
      { id: user.id, type: '1', allow: TICKET_MEMBER_ALLOW },
    ];
    const botId = this.gateway.status.botId;
    if (botId) overwrites.push({ id: botId, type: '1', allow: TICKET_MEMBER_ALLOW });
    const staffRole = s.discordStaffRoleId?.trim();
    if (staffRole) overwrites.push({ id: staffRole, type: '0', allow: TICKET_MEMBER_ALLOW });

    let channel: { id: string };
    try {
      channel = await this.discord.botCall<{ id: string }>(`/guilds/${guildId}/channels`, {
        method: 'POST',
        body: JSON.stringify({
          name: `ticket-${String(number).padStart(4, '0')}`,
          type: 0,
          parent_id: s.discordTicketCategoryId?.trim() || undefined,
          topic: `${subject} — opened by ${user.username}`,
          permission_overwrites: overwrites,
        }),
      });
    } catch (error) {
      this.logger.error({ err: error }, 'could not create a ticket channel');
      await this.followUp(interaction, {
        content:
          'Sorry — the ticket channel could not be created. The bot may be missing Manage Channels here. An admin has it in the logs.',
        flags: EPHEMERAL,
      });
      return;
    }

    const linkedUserId = this.discord.userIdFor(user.id);
    this.db
      .insert(discordTickets)
      .values({
        id: newId('tkt'),
        number,
        guildId,
        channelId: channel.id,
        openerDiscordId: user.id,
        openerName: user.username,
        userId: linkedUserId,
        subject,
        status: 'open',
        openedAt: isoNow(),
      })
      .run();

    await this.discord.postMessage(
      {
        content: `<@${user.id}>${staffRole ? ` <@&${staffRole}>` : ''}`,
        embeds: [
          {
            title: `Ticket #${String(number).padStart(4, '0')}`,
            description: detail || subject,
            color: 0x2bb7f5,
            fields: [
              { name: 'Subject', value: subject },
              {
                name: 'GameBlade account',
                value: linkedUserId
                  ? (this.db
                      .select({ username: users.username })
                      .from(users)
                      .where(eq(users.id, linkedUserId))
                      .get()?.username ?? 'linked')
                  : 'Not linked',
              },
            ],
            footer: { text: 'Press Close when this is done.' },
          },
        ],
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 4,
                label: 'Close ticket',
                emoji: { name: '🔒' },
                custom_id: ID.CLOSE,
              },
            ],
          },
        ],
      },
      { channelId: channel.id },
    );

    await this.followUp(interaction, {
      content: `Your ticket is open: <#${channel.id}>`,
      flags: EPHEMERAL,
    });
  }

  /** Close is destructive, so it asks once. */
  private async confirmClose(interaction: Interaction): Promise<void> {
    await this.respond(interaction, CALLBACK.CHANNEL_MESSAGE, {
      content: 'Close this ticket? The channel is deleted; the record is kept in the admin panel.',
      flags: EPHEMERAL,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: 'Yes, close it',
              custom_id: ID.CONFIRM_CLOSE,
            },
          ],
        },
      ],
    });
  }

  private async closeTicket(interaction: Interaction, user: DiscordUser): Promise<void> {
    const channelId = interaction.channel_id;
    if (!channelId) return;

    const ticket = this.db
      .select()
      .from(discordTickets)
      .where(eq(discordTickets.channelId, channelId))
      .get();

    await this.respond(interaction, CALLBACK.CHANNEL_MESSAGE, {
      content: 'Closing — this channel disappears in a moment.',
      flags: EPHEMERAL,
    });

    if (ticket) {
      this.db
        .update(discordTickets)
        .set({
          status: 'closed',
          closedAt: isoNow(),
          closedBy: user.username,
          // The channel is about to stop existing; a stale id would render as
          // a broken #mention everywhere the ticket is listed.
          channelId: null,
        })
        .where(eq(discordTickets.id, ticket.id))
        .run();
    }

    // A beat, so the person pressing the button sees the acknowledgement
    // rather than the channel vanishing from under them.
    setTimeout(() => {
      void this.discord
        .botCall(`/channels/${channelId}`, { method: 'DELETE' })
        .catch((error: unknown) =>
          this.logger.warn({ err: error, channelId }, 'could not delete a closed ticket channel'),
        );
    }, 3000).unref?.();
  }

  /* -------------------------------------------------------------- admin view */

  /**
   * Close a ticket and remove the record of it entirely.
   *
   * Distinct from the in-Discord close button, which keeps the row so there is
   * still an account of who asked for what. This is the admin saying they are
   * finished with it — spam, a duplicate, something resolved long ago — so the
   * channel goes if it is still there and the row goes with it.
   *
   * The channel is deleted first and awaited: a row removed while its channel
   * survives leaves an orphan nothing in the panel can reach any more.
   */
  async deleteTicket(id: string): Promise<boolean> {
    const ticket = this.db.select().from(discordTickets).where(eq(discordTickets.id, id)).get();
    if (!ticket) return false;

    if (ticket.channelId) {
      await this.discord
        .botCall(`/channels/${ticket.channelId}`, { method: 'DELETE' })
        .catch((error: unknown) => {
          // A channel somebody already deleted by hand is not a reason to
          // refuse to tidy up the row that points at it.
          this.logger.warn(
            { err: error, channelId: ticket.channelId },
            'could not delete a ticket channel; removing the record anyway',
          );
        });
    }

    this.db.delete(discordTickets).where(eq(discordTickets.id, id)).run();
    return true;
  }

  listTickets(status: string | undefined, limit = 50): TicketRow[] {
    const rows = this.db
      .select({
        ticket: discordTickets,
        username: users.username,
      })
      .from(discordTickets)
      .leftJoin(users, eq(users.id, discordTickets.userId))
      .where(
        status === 'open' || status === 'closed' ? eq(discordTickets.status, status) : undefined,
      )
      .orderBy(desc(discordTickets.openedAt))
      .limit(limit)
      .all();

    return rows.map((row) => ({
      id: row.ticket.id,
      number: row.ticket.number,
      channelId: row.ticket.channelId,
      openerDiscordId: row.ticket.openerDiscordId,
      openerName: row.ticket.openerName,
      username: row.username,
      subject: row.ticket.subject,
      status: row.ticket.status,
      openedAt: row.ticket.openedAt,
      closedAt: row.ticket.closedAt,
    }));
  }

  ticketCounts(): { open: number; closed: number } {
    const rows = this.db
      .select({ status: discordTickets.status, count: sql<number>`count(*)` })
      .from(discordTickets)
      .groupBy(discordTickets.status)
      .all();

    return {
      open: Number(rows.find((r) => r.status === 'open')?.count ?? 0),
      closed: Number(rows.find((r) => r.status === 'closed')?.count ?? 0),
    };
  }

  /** How many players could use `/profile` at all. */
  linkedCount(): number {
    return (
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(discordLinks)
        .get()?.count ?? 0
    );
  }
}

/* --------------------------------------------------------------- helpers */

/** A follow-up carrying a file, in the multipart shape Discord expects. */
function uploadBody(payload: Record<string, unknown>, file: DiscordUpload): FormData {
  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({ ...payload, attachments: [{ id: 0, filename: file.fileName }] }),
  );
  const bytes = new Uint8Array(file.bytes.byteLength);
  bytes.set(file.bytes);
  form.append('files[0]', new Blob([bytes], { type: file.contentType }), file.fileName);
  return form;
}

/** Discord's own CDN path for the caller's avatar, or their default one. */
function discordAvatar(user: DiscordUser): string {
  if (user.avatar) {
    const extension = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
  }
  // The default avatar for a post-migration username is keyed off the id.
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** `#rrggbb` as the integer an embed's colour has to be. */
function colorOf(accent: string | null): number {
  const hex = accent?.replace('#', '').trim();
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return 0x2bb7f5;
  return Number.parseInt(hex, 16);
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}
