import {
  DISCORD_ACTIVITY_LABELS,
  DISCORD_ACTIVITY_TYPES,
  DISCORD_PRESENCE_LABELS,
  DISCORD_PRESENCE_STATUS,
  MAX_DISCORD_ATTACHMENT_BYTES,
  type DiscordActivityType,
  type DiscordBotState,
  type DiscordPresenceStatus,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ImagePlus,
  LifeBuoy,
  Play,
  RefreshCw,
  Send,
  Square,
  Ticket,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, EmptyState, Field, RowSkeleton, Spinner } from '../../components/ui.js';
import { api, ApiRequestError, uploadFile } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';

/* ------------------------------------------------------------------- types */

export interface DiscordBotStatus {
  state: DiscordBotState;
  detail: string | null;
  botId: string | null;
  readyAt: string | null;
  enabled: boolean;
}

export interface DiscordPresenceConfig {
  status: string;
  activityType: number;
  activityName: string;
  preview: string | null;
}

export interface DiscordTicketConfig {
  enabled: boolean;
  supportChannelId: string | null;
  categoryId: string | null;
  staffRoleId: string | null;
  panelTitle: string;
  panelMessage: string;
  counts: { open: number; closed: number };
}

interface Channel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
}

interface Guild {
  channels: Channel[];
  roles: Array<{ id: string; name: string }>;
}

interface TicketRow {
  id: string;
  number: number;
  channelId: string | null;
  openerName: string;
  username: string | null;
  subject: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
}

/** Discord's channel type numbers, for the two the pickers care about. */
const TEXT_CHANNEL_TYPES = [0, 5];
const CATEGORY_TYPE = 4;

/* --------------------------------------------------------------- the guild */

/**
 * The guild's channels and roles, fetched once and shared by every picker.
 *
 * Only when the bot has a token: without one the call is a guaranteed 400, and
 * a page that fires a doomed request on mount reports an error before the
 * operator has done anything wrong.
 */
export function useGuild(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'discord', 'guild'],
    queryFn: () => api.get<Guild>('/admin/discord/channels'),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** A channel picker that degrades to a plain id box when the bot is offline. */
export function ChannelPicker({
  id,
  value,
  onChange,
  guild,
  types = TEXT_CHANNEL_TYPES,
  placeholder = 'The default announcement channel',
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  guild: ReturnType<typeof useGuild>;
  types?: number[];
  placeholder?: string;
}) {
  const channels = (guild.data?.channels ?? []).filter((channel) => types.includes(channel.type));

  // No token, no guild id, or the bot cannot see the server: the operator can
  // still paste a snowflake, which is all this ever was before.
  if (guild.isError || (!guild.isLoading && channels.length === 0)) {
    return (
      <input
        id={id}
        className="gb-input font-mono"
        value={value}
        placeholder="Channel ID"
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <select
      id={id}
      className="gb-input"
      value={value}
      disabled={guild.isLoading}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {channels.map((channel) => (
        <option key={channel.id} value={channel.id}>
          {channel.type === CATEGORY_TYPE ? channel.name : `#${channel.name}`}
        </option>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------- the bot itself */

const STATE_TONES: Record<DiscordBotState, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> =
  {
    ready: 'success',
    connecting: 'info',
    reconnecting: 'warning',
    failed: 'danger',
    stopped: 'neutral',
  };

const STATE_LABELS: Record<DiscordBotState, string> = {
  ready: 'Online',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  failed: 'Failed',
  stopped: 'Offline',
};

/**
 * The switch that puts the bot in the member list.
 *
 * Worth being explicit about what this is, because "the bot has a token" and
 * "the bot is running" look the same from the outside and are not: a token
 * lets this server post, which a webhook could also do. Being *online*,
 * answering `/profile` and reacting to a button all need a live connection,
 * and that connection is what this starts.
 */
export function BotControl({
  status,
  presence,
  hasToken,
  onError,
  onNotice,
}: {
  status: DiscordBotStatus;
  presence: DiscordPresenceConfig;
  hasToken: boolean;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    status: presence.status,
    activityType: presence.activityType,
    activityName: presence.activityName,
  });

  // Re-seeded when the server's answer changes, but never while typing: the
  // poll below lands every few seconds and would eat a half-typed activity.
  const activityName = presence.activityName;
  useEffect(() => {
    setDraft((current) =>
      current.activityName === '' && activityName ? { ...current, activityName } : current,
    );
  }, [activityName]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'discord'] });

  const toggle = useMutation({
    mutationFn: (start: boolean) => api.post(`/admin/discord/bot/${start ? 'start' : 'stop'}`),
    onSuccess: async (_result, start) => {
      onError(null);
      onNotice(start ? 'Starting the bot — it should appear online in a moment.' : 'Bot stopped.');
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['admin', 'discord', 'guild'] });
    },
    onError: (caught) =>
      onError(caught instanceof ApiRequestError ? caught.message : 'Could not change the bot.'),
  });

  const savePresence = useMutation({
    mutationFn: () => api.patch('/admin/discord/bot/presence', draft),
    onSuccess: async () => {
      onError(null);
      onNotice('Updated.');
      await refresh();
    },
    onError: (caught) =>
      onError(caught instanceof ApiRequestError ? caught.message : 'Could not update the status.'),
  });

  const running = status.state !== 'stopped' && status.state !== 'failed';

  return (
    <section className="gb-card space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide uppercase">The bot</h2>
        <Badge tone={STATE_TONES[status.state]}>{STATE_LABELS[status.state]}</Badge>
        {presence.preview ? <span className="text-ink-400 text-xs">{presence.preview}</span> : null}

        <button
          type="button"
          className={running ? 'gb-btn-danger ml-auto' : 'gb-btn-primary ml-auto'}
          disabled={!hasToken || toggle.isPending}
          onClick={() => toggle.mutate(!running)}
        >
          {toggle.isPending ? (
            <Spinner className="h-4 w-4" />
          ) : running ? (
            <Square className="h-4 w-4" aria-hidden />
          ) : (
            <Play className="h-4 w-4" aria-hidden />
          )}
          {running ? 'Stop the bot' : 'Start the bot'}
        </button>
      </div>

      <p className="text-ink-400 text-xs leading-relaxed">
        Starting opens a live connection, which is what puts the bot in your server&rsquo;s member
        list and lets it answer <code className="font-mono">/profile</code> and the ticket buttons.
        Announcements work without it. The switch is remembered, so the bot comes back by itself
        after a restart.
      </p>

      {status.detail ? (
        <p
          className={
            status.state === 'failed'
              ? 'gb-note-danger text-xs'
              : 'text-ink-400 text-xs leading-relaxed'
          }
        >
          {status.detail}
        </p>
      ) : null}

      {!hasToken ? (
        <p className="text-ink-500 text-xs">Add a bot token below before starting it.</p>
      ) : null}

      {/* ------------------------------------------------------- presence */}
      <div className="border-ink-700/70 space-y-3 border-t pt-4">
        <h3 className="text-ink-300 text-xs font-medium tracking-wide uppercase">How it appears</h3>

        <div className="flex flex-wrap gap-3">
          <Field label="Status" htmlFor="b-status">
            <select
              id="b-status"
              className="gb-input w-auto"
              value={draft.status}
              onChange={(event) => setDraft({ ...draft, status: event.target.value })}
            >
              {DISCORD_PRESENCE_STATUS.map((option) => (
                <option key={option} value={option}>
                  {DISCORD_PRESENCE_LABELS[option as DiscordPresenceStatus]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Activity" htmlFor="b-activity-type">
            <select
              id="b-activity-type"
              className="gb-input w-auto"
              value={draft.activityType}
              onChange={(event) => setDraft({ ...draft, activityType: Number(event.target.value) })}
            >
              {DISCORD_ACTIVITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {DISCORD_ACTIVITY_LABELS[type as DiscordActivityType]}
                </option>
              ))}
            </select>
          </Field>

          <div className="min-w-[200px] flex-1">
            <Field
              label="Text"
              htmlFor="b-activity-name"
              hint="Blank shows the coloured dot and nothing else."
            >
              <input
                id="b-activity-name"
                className="gb-input"
                maxLength={128}
                value={draft.activityName}
                placeholder={draft.activityType === 4 ? 'keeping the lights on' : 'the archive'}
                onChange={(event) => setDraft({ ...draft, activityName: event.target.value })}
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="gb-btn-ghost"
            disabled={savePresence.isPending}
            onClick={() => savePresence.mutate()}
          >
            {savePresence.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Apply
          </button>
          <span className="text-ink-500 text-xs">
            {draft.activityName.trim()
              ? `Reads as “${
                  draft.activityType === 4
                    ? draft.activityName
                    : `${DISCORD_ACTIVITY_LABELS[draft.activityType as DiscordActivityType]} ${draft.activityName}`
                }”`
              : 'No activity line.'}
            {running ? ' Applied immediately.' : ' Applied when the bot next starts.'}
          </span>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ posting */

/**
 * A post, to a channel of the operator's choosing, optionally with a picture.
 *
 * The image is uploaded to this server first and sent on as a real Discord
 * attachment rather than as a link. The media route needs authentication, so a
 * link would hand Discord a 401 — and opening the whole media store to the
 * internet to work around that is not a trade worth making for an
 * announcement.
 */
export function PostSection({
  hasToken,
  defaultChannelId,
  guild,
  onError,
  onNotice,
}: {
  hasToken: boolean;
  defaultChannelId: string | null;
  guild: ReturnType<typeof useGuild>;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [post, setPost] = useState({ title: '', message: '', asEmbed: true, channelId: '' });
  const [image, setImage] = useState<{
    id: string;
    name: string;
    size: number;
    preview: string;
  } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  // The object URL is revoked when the picture is replaced or cleared;
  // without it every re-pick leaks a blob for the life of the page.
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.preview);
    },
    [image],
  );

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadFile<{ id: string }>('/admin/discord/attachment', file, {
        onProgress: setProgress,
      }).then((info) => ({ info, file })),
    onSuccess: ({ info, file }) => {
      onError(null);
      setProgress(null);
      setImage({
        id: info.id,
        name: file.name,
        size: file.size,
        preview: URL.createObjectURL(file),
      });
    },
    onError: (caught) => {
      setProgress(null);
      onError(caught instanceof ApiRequestError ? caught.message : 'That image would not upload.');
    },
  });

  const announce = useMutation({
    mutationFn: () =>
      api.post('/admin/discord/announce', {
        title: post.title,
        message: post.message,
        asEmbed: post.asEmbed,
        channelId: post.channelId || undefined,
        imageMediaId: image?.id,
      }),
    onSuccess: () => {
      onError(null);
      onNotice('Posted.');
      setPost({ title: '', message: '', asEmbed: true, channelId: post.channelId });
      setImage(null);
    },
    onError: (caught) =>
      onError(caught instanceof ApiRequestError ? caught.message : 'Could not post that.'),
  });

  return (
    <section className="gb-card space-y-3 p-5">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Post something</h2>
      <p className="text-ink-400 text-xs leading-relaxed">
        Goes out as the bot. An image is attached to the message itself, so this works whether or
        not the server is reachable from the internet.
      </p>

      <Field label="Channel" htmlFor="a-channel" hint="Blank uses the announcement channel above.">
        <ChannelPicker
          id="a-channel"
          value={post.channelId}
          onChange={(channelId) => setPost({ ...post, channelId })}
          guild={guild}
          placeholder={defaultChannelId ? 'The announcement channel' : 'Pick a channel…'}
        />
      </Field>

      <Field label="Title" htmlFor="a-title" hint="Optional.">
        <input
          id="a-title"
          className="gb-input"
          maxLength={200}
          value={post.title}
          onChange={(event) => setPost({ ...post, title: event.target.value })}
        />
      </Field>

      <Field label="Message" htmlFor="a-body" hint="Optional when a picture is attached.">
        <textarea
          id="a-body"
          className="gb-input min-h-28"
          maxLength={1800}
          value={post.message}
          onChange={(event) => setPost({ ...post, message: event.target.value })}
        />
      </Field>

      {/* --------------------------------------------------------- image */}
      <Field
        label="Image"
        htmlFor="a-image"
        hint={`PNG, JPEG, WebP, GIF or AVIF, up to ${formatBytes(MAX_DISCORD_ATTACHMENT_BYTES)}.`}
      >
        {image ? (
          <div className="bg-ink-800 flex items-center gap-3 rounded-lg p-2">
            <img
              src={image.preview}
              alt=""
              className="bg-ink-900 h-16 w-16 shrink-0 rounded object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{image.name}</p>
              <p className="text-ink-400 text-xs">{formatBytes(image.size)}</p>
            </div>
            <button
              type="button"
              className="gb-btn-ghost"
              aria-label="Remove the image"
              onClick={() => setImage(null)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <input
            id="a-image"
            ref={inputRef}
            type="file"
            className="gb-input"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            disabled={upload.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setProgress(0);
              upload.mutate(file);
              // Cleared so re-picking the same file uploads it again.
              if (inputRef.current) inputRef.current.value = '';
            }}
          />
        )}

        {progress !== null ? (
          <div className="bg-ink-800 mt-2 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-blade-500 h-full transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        ) : null}
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={post.asEmbed}
          onChange={(event) => setPost({ ...post, asEmbed: event.target.checked })}
        />
        Send as an embed
        <span className="text-ink-500 text-xs">
          (reads as the server speaking; unchecked reads as a person)
        </span>
      </label>

      <button
        type="button"
        className="gb-btn-primary"
        disabled={
          !hasToken || upload.isPending || announce.isPending || (!post.message.trim() && !image)
        }
        onClick={() => announce.mutate()}
      >
        {announce.isPending ? (
          <Spinner className="h-4 w-4" />
        ) : image ? (
          <ImagePlus className="h-4 w-4" aria-hidden />
        ) : (
          <Send className="h-4 w-4" aria-hidden />
        )}
        Post to Discord
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ tickets */

/**
 * Support tickets, the way Ticket Tool does them.
 *
 * A panel with a button in one channel; pressing it asks what the problem is
 * and opens a private channel for that person and the staff role. Closing
 * deletes the channel and keeps the record here — a server that accumulates
 * two hundred dead #ticket-0042 channels is worse than no ticket system.
 */
export function TicketSection({
  config,
  guild,
  botOnline,
  onError,
  onNotice,
}: {
  config: DiscordTicketConfig;
  guild: ReturnType<typeof useGuild>;
  botOnline: boolean;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    supportChannelId: config.supportChannelId ?? '',
    categoryId: config.categoryId ?? '',
    staffRoleId: config.staffRoleId ?? '',
    panelTitle: config.panelTitle,
    panelMessage: config.panelMessage,
  });
  const [showClosed, setShowClosed] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'discord'] });

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch('/admin/discord/tickets/settings', patch),
    onSuccess: async () => {
      onError(null);
      onNotice('Saved.');
      await refresh();
    },
    onError: (caught) =>
      onError(caught instanceof ApiRequestError ? caught.message : 'Could not save.'),
  });

  const publish = useMutation({
    mutationFn: () => api.post('/admin/discord/tickets/panel'),
    onSuccess: () => {
      onError(null);
      onNotice('Panel posted. Anyone in that channel can open a ticket now.');
    },
    onError: (caught) =>
      onError(caught instanceof ApiRequestError ? caught.message : 'Could not post the panel.'),
  });

  const deleteTicketMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/discord/tickets/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'discord', 'tickets'] }),
  });

  const ticketsQuery = useQuery({
    queryKey: ['admin', 'discord', 'tickets', showClosed],
    queryFn: () =>
      api.get<{ tickets: TicketRow[] }>(
        `/admin/discord/tickets${showClosed ? '' : '?status=open'}`,
      ),
  });

  return (
    <section className="gb-card space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Support tickets</h2>
        {config.enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
        <span className="text-ink-400 ml-auto text-xs">
          {config.counts.open} open · {config.counts.closed} closed
        </span>
      </div>

      <p className="text-ink-400 text-xs leading-relaxed">
        Posts a panel with a button. Pressing it asks what the problem is and opens a private
        channel that only that person, the staff role and the bot can see. Closing deletes the
        channel and keeps the record here — the bot needs <strong>Manage Channels</strong> for both.
      </p>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={config.enabled}
          onChange={(event) => save.mutate({ enabled: event.target.checked })}
        />
        <span>
          Enable tickets
          <span className="text-ink-400 block text-xs">
            The button stops working when this is off, and the panel says so.
          </span>
        </span>
      </label>

      <Field
        label="Support channel"
        htmlFor="t-channel"
        hint="Where the panel with the button is posted."
      >
        <ChannelPicker
          id="t-channel"
          value={form.supportChannelId}
          onChange={(supportChannelId) => setForm({ ...form, supportChannelId })}
          guild={guild}
          placeholder="Pick a channel…"
        />
      </Field>

      <Field
        label="Ticket category"
        htmlFor="t-category"
        hint="Optional. New ticket channels are created under it, which keeps them out of the main list."
      >
        <ChannelPicker
          id="t-category"
          value={form.categoryId}
          onChange={(categoryId) => setForm({ ...form, categoryId })}
          guild={guild}
          types={[CATEGORY_TYPE]}
          placeholder="No category"
        />
      </Field>

      <Field
        label="Staff role"
        htmlFor="t-role"
        hint="Given access to every ticket channel. Without one, only the person who opened it can see it."
      >
        {guild.isError || (guild.data?.roles.length ?? 0) === 0 ? (
          <input
            id="t-role"
            className="gb-input font-mono"
            placeholder="Role ID"
            value={form.staffRoleId}
            onChange={(event) => setForm({ ...form, staffRoleId: event.target.value })}
          />
        ) : (
          <select
            id="t-role"
            className="gb-input"
            value={form.staffRoleId}
            onChange={(event) => setForm({ ...form, staffRoleId: event.target.value })}
          >
            <option value="">No role — tickets are private to the opener</option>
            {(guild.data?.roles ?? []).map((role) => (
              <option key={role.id} value={role.id}>
                @{role.name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Panel heading" htmlFor="t-title">
        <input
          id="t-title"
          className="gb-input"
          maxLength={200}
          placeholder="Need a hand?"
          value={form.panelTitle}
          onChange={(event) => setForm({ ...form, panelTitle: event.target.value })}
        />
      </Field>

      <Field label="Panel text" htmlFor="t-message">
        <textarea
          id="t-message"
          className="gb-input min-h-20"
          maxLength={1500}
          placeholder="Open a ticket and someone will get back to you."
          value={form.panelMessage}
          onChange={(event) => setForm({ ...form, panelMessage: event.target.value })}
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="gb-btn-primary"
          disabled={save.isPending}
          onClick={() => save.mutate(form)}
        >
          {save.isPending ? <Spinner className="h-4 w-4" /> : null}
          Save ticket settings
        </button>

        <button
          type="button"
          className="gb-btn-ghost"
          disabled={!botOnline || !form.supportChannelId || publish.isPending}
          onClick={() => publish.mutate()}
          title={
            botOnline
              ? 'Posts the panel people press to open a ticket'
              : 'The bot has to be running to post the panel'
          }
        >
          {publish.isPending ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <Ticket className="h-4 w-4" aria-hidden />
          )}
          Post the panel
        </button>
      </div>

      {/* ------------------------------------------------------- the list */}
      <div className="border-ink-700/70 space-y-2 border-t pt-4">
        <div className="flex items-center gap-2">
          <h3 className="text-ink-300 text-xs font-medium tracking-wide uppercase">Tickets</h3>
          <label className="text-ink-400 ml-auto flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(event) => setShowClosed(event.target.checked)}
            />
            Include closed
          </label>
        </div>

        {ticketsQuery.isLoading ? (
          <RowSkeleton rows={3} />
        ) : (ticketsQuery.data?.tickets ?? []).length === 0 ? (
          <EmptyState
            title={showClosed ? 'No tickets yet' : 'Nothing open'}
            message="They appear here the moment somebody presses the button."
          />
        ) : (
          <div className="divide-ink-700/70 bg-ink-800/40 divide-y rounded-lg">
            {(ticketsQuery.data?.tickets ?? []).map((ticket) => (
              <div key={ticket.id} className="flex items-start gap-3 px-3 py-2">
                <LifeBuoy
                  className={
                    ticket.status === 'open'
                      ? 'mt-0.5 h-4 w-4 shrink-0 text-emerald-400'
                      : 'text-ink-500 mt-0.5 h-4 w-4 shrink-0'
                  }
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    #{String(ticket.number).padStart(4, '0')} — {ticket.subject}
                  </p>
                  <p className="text-ink-400 text-xs">
                    {ticket.openerName}
                    {ticket.username ? ` (${ticket.username})` : ' · not linked'} ·{' '}
                    {new Date(ticket.openedAt).toLocaleDateString()}
                    {ticket.closedAt
                      ? ` · closed ${new Date(ticket.closedAt).toLocaleDateString()}`
                      : ''}
                  </p>
                </div>
                {ticket.status === 'open' ? (
                  <Badge tone="success">Open</Badge>
                ) : (
                  <Badge tone="neutral">Closed</Badge>
                )}
                <button
                  type="button"
                  className="gb-btn-danger shrink-0 px-2 py-1"
                  title="Close and delete this ticket"
                  disabled={deleteTicketMutation.isPending}
                  onClick={() => {
                    const label = `#${String(ticket.number).padStart(4, '0')}`;
                    // The Discord channel goes with it, so this is worth a
                    // confirmation even for a ticket already marked closed.
                    if (
                      confirm(
                        `Delete ticket ${label}? Its Discord channel is removed and the record is gone for good.`,
                      )
                    ) {
                      deleteTicketMutation.mutate(ticket.id);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------- roles */

interface ReactionRoleRow {
  id: string;
  channelId: string;
  messageId: string;
  emoji: string;
  roleId: string;
  note: string | null;
}

interface RoleConfig {
  autoRoleId: string;
  reactionRolesEnabled: boolean;
  bindings: ReactionRoleRow[];
}

/**
 * Roles handed out without anybody pressing anything in the panel: one on
 * join, and one per emoji on a message.
 *
 * Both need the bot to be told about events it does not otherwise ask for, so
 * turning either on reconnects the gateway. Auto-roles need the privileged
 * Server Members intent, which is the step operators reliably miss — so it is
 * spelled out next to the field rather than left in the docs.
 */
export function RoleSection({
  guild,
  botOnline,
  onError,
  onNotice,
}: {
  guild: ReturnType<typeof useGuild>;
  botOnline: boolean;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const rolesQuery = useQuery({
    queryKey: ['admin', 'discord', 'roles'],
    queryFn: () => api.get<RoleConfig>('/admin/discord/roles'),
  });

  const [binding, setBinding] = useState({
    channelId: '',
    messageId: '',
    emoji: '',
    roleId: '',
    note: '',
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'discord', 'roles'] });

  const saveSettings = useMutation({
    mutationFn: (patch: { autoRoleId?: string; reactionRolesEnabled?: boolean }) =>
      api.patch('/admin/discord/roles', patch),
    onSuccess: () => {
      onError(null);
      onNotice('Role settings saved. The bot reconnects when what it listens for changes.');
      void invalidate();
    },
    onError: (caught) =>
      onError(caught instanceof ApiRequestError ? caught.message : 'Could not save role settings.'),
  });

  const addBinding = useMutation({
    mutationFn: () =>
      api.post<{ reacted: boolean }>('/admin/discord/roles/reactions', {
        channelId: binding.channelId,
        messageId: binding.messageId,
        emoji: binding.emoji,
        roleId: binding.roleId,
        ...(binding.note ? { note: binding.note } : {}),
      }),
    onSuccess: (result) => {
      onError(null);
      onNotice(
        result.reacted
          ? 'Bound, and the emoji is on the message.'
          : 'Bound. The bot could not add the emoji itself — react to the message once so players have something to click.',
      );
      setBinding({ channelId: '', messageId: '', emoji: '', roleId: '', note: '' });
      void invalidate();
    },
    onError: (caught) =>
      onError(caught instanceof ApiRequestError ? caught.message : 'Could not add that binding.'),
  });

  const removeBinding = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/discord/roles/reactions/${id}`),
    onSuccess: () => void invalidate(),
  });

  const config = rolesQuery.data;
  const canSubmit =
    binding.channelId.trim() && binding.messageId.trim() && binding.emoji.trim() && binding.roleId;

  const rolePicker = (
    id: string,
    value: string,
    onChange: (next: string) => void,
    empty: string,
  ) =>
    guild.isError || (guild.data?.roles.length ?? 0) === 0 ? (
      <input
        id={id}
        className="gb-input font-mono"
        placeholder="Role ID"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    ) : (
      <select
        id={id}
        className="gb-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{empty}</option>
        {(guild.data?.roles ?? []).map((role) => (
          <option key={role.id} value={role.id}>
            @{role.name}
          </option>
        ))}
      </select>
    );

  if (rolesQuery.isLoading || !config) return <RowSkeleton rows={3} />;

  return (
    <section className="gb-card space-y-5 p-5">
      <div>
        <h2 className="text-sm font-semibold tracking-wide uppercase">Roles</h2>
        <p className="text-ink-400 mt-1 text-xs">
          The bot has to sit <strong>above</strong> any role it hands out in the server&rsquo;s role
          list, or Discord refuses every attempt.
        </p>
      </div>

      {/* ------------------------------------------------------------ auto */}

      <div className="space-y-2">
        <Field
          label="Auto-role on join"
          htmlFor="auto-role"
          hint="Given to everyone who joins the server."
        >
          {rolePicker(
            'auto-role',
            config.autoRoleId,
            (next) => saveSettings.mutate({ autoRoleId: next }),
            'No role — nothing is given on join',
          )}
        </Field>
        {config.autoRoleId ? (
          <p className="text-xs text-amber-400">
            This needs the privileged <strong>Server Members Intent</strong>, enabled on the
            application&rsquo;s Bot tab in the Discord developer portal. Without it the bot cannot
            connect at all.
          </p>
        ) : null}
      </div>

      {/* -------------------------------------------------------- reactions */}

      <div className="border-ink-700/70 space-y-3 border-t pt-4">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={config.reactionRolesEnabled}
            onChange={(event) =>
              saveSettings.mutate({ reactionRolesEnabled: event.target.checked })
            }
          />
          <span>
            Reaction roles
            <span className="text-ink-400 block text-xs">
              Players give themselves a role by reacting to a message you choose.
            </span>
          </span>
        </label>

        {config.reactionRolesEnabled ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Channel" htmlFor="rr-channel">
                <ChannelPicker
                  id="rr-channel"
                  value={binding.channelId}
                  onChange={(next) => setBinding({ ...binding, channelId: next })}
                  guild={guild}
                  placeholder="Channel ID"
                />
              </Field>
              <Field
                label="Message ID"
                htmlFor="rr-message"
                hint="Right-click the message → Copy Message ID, with Developer Mode on."
              >
                <input
                  id="rr-message"
                  className="gb-input font-mono"
                  value={binding.messageId}
                  onChange={(event) => setBinding({ ...binding, messageId: event.target.value })}
                />
              </Field>
              <Field
                label="Emoji"
                htmlFor="rr-emoji"
                hint="A single emoji, or name:id for a custom one."
              >
                <input
                  id="rr-emoji"
                  className="gb-input"
                  placeholder="🎮"
                  value={binding.emoji}
                  onChange={(event) => setBinding({ ...binding, emoji: event.target.value })}
                />
              </Field>
              <Field label="Role" htmlFor="rr-role">
                {rolePicker(
                  'rr-role',
                  binding.roleId,
                  (next) => setBinding({ ...binding, roleId: next }),
                  'Pick a role',
                )}
              </Field>
            </div>

            <button
              type="button"
              className="gb-btn-primary"
              disabled={!canSubmit || addBinding.isPending || !botOnline}
              onClick={() => addBinding.mutate()}
            >
              {addBinding.isPending ? <Spinner className="h-4 w-4" /> : null}
              Bind this emoji
            </button>
            {!botOnline ? (
              <p className="text-ink-500 text-xs">Start the bot to add a binding.</p>
            ) : null}

            {config.bindings.length === 0 ? (
              <EmptyState
                title="Nothing bound yet"
                message="Pick a message and an emoji above, and the bot will react to it for you."
              />
            ) : (
              <div className="divide-ink-700/70 bg-ink-800/40 divide-y rounded-lg">
                {config.bindings.map((row) => (
                  <div key={row.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="text-lg">{row.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        @
                        {guild.data?.roles.find((role) => role.id === row.roleId)?.name ??
                          row.roleId}
                      </p>
                      <p className="text-ink-400 truncate font-mono text-xs">
                        message {row.messageId}
                        {row.note ? ` · ${row.note}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="gb-btn-danger shrink-0 px-2 py-1"
                      title="Remove this binding"
                      onClick={() => removeBinding.mutate(row.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
