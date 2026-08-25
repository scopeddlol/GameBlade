import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, CircleCheck, MessageSquare, TestTube2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Field, FormError, Notice, SectionSkeleton, Spinner } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';
import {
  BotControl,
  ChannelPicker,
  PostSection,
  TicketSection,
  useGuild,
  type DiscordBotStatus,
  type DiscordPresenceConfig,
  type DiscordTicketConfig,
} from './discordSections.js';

/** One step between a stored token and a message actually arriving. */
interface DiscordCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface DiscordConfig {
  clientId: string | null;
  clientSecretSet: boolean;
  botTokenSet: boolean;
  guildId: string | null;
  inviteUrl: string | null;
  channelId: string | null;
  publicUrl: string | null;
  announceNewGames: boolean;
  announceRequests: boolean;
  requireGuild: boolean;
  linkedAccounts: number;
  bot: DiscordBotStatus;
  presence: DiscordPresenceConfig;
  tickets: DiscordTicketConfig;
}

/**
 * The operator's side of Discord.
 *
 * Two things that share credentials: an OAuth application, which is how
 * players link and sign in, and a bot, which is how the server speaks. Either
 * works without the other — an application with no bot still links accounts,
 * a bot with no application still posts — so the page is laid out as two
 * independent halves rather than one wizard.
 */
export function AdminDiscordPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checks, setChecks] = useState<DiscordCheck[] | null>(null);

  const [form, setForm] = useState({
    clientId: '',
    guildId: '',
    inviteUrl: '',
    channelId: '',
    publicUrl: '',
  });
  // Write-only: a blank box means "leave what is stored alone", so these are
  // never seeded from the server and are cleared after a save.
  const [secrets, setSecrets] = useState({ clientSecret: '', botToken: '' });

  const configQuery = useQuery({
    queryKey: ['admin', 'discord'],
    queryFn: () => api.get<DiscordConfig>('/admin/discord'),
    // Connecting takes a few seconds and goes through two or three states on
    // the way. Without a poll the badge would sit on "Connecting" until
    // somebody reloaded, which reads as a bot that never came up.
    refetchInterval: (query) => {
      const state = query.state.data?.bot.state;
      return state === 'connecting' || state === 'reconnecting' ? 2000 : false;
    },
  });

  // Seeded in an effect rather than inside `queryFn` — the fetcher only runs
  // on a cache miss, so seeding there leaves the form blank on a revisit.
  const config = configQuery.data;
  useEffect(() => {
    if (!config) return;
    setForm((current) => ({
      clientId: current.clientId || (config.clientId ?? ''),
      guildId: current.guildId || (config.guildId ?? ''),
      inviteUrl: current.inviteUrl || (config.inviteUrl ?? ''),
      channelId: current.channelId || (config.channelId ?? ''),
      publicUrl: current.publicUrl || (config.publicUrl ?? ''),
    }));
  }, [config]);

  // Shared by every channel and role picker on the page. Only worth asking
  // for once the bot has a token and a server to look at.
  const guild = useGuild(Boolean(configQuery.data?.botTokenSet && configQuery.data?.guildId));

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiRequestError ? caught.message : 'Could not save.');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'discord'] });

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch('/admin/discord', patch),
    onSuccess: async () => {
      setError(null);
      setNotice('Saved.');
      setSecrets({ clientSecret: '', botToken: '' });
      await refresh();
    },
    onError: fail,
  });

  const clearSecret = useMutation({
    mutationFn: (which: string) => api.delete(`/admin/discord/secret/${which}`),
    onSuccess: async () => {
      setNotice('Cleared.');
      await refresh();
    },
    onError: fail,
  });

  /**
   * Runs every step, and keeps the ones that failed on screen.
   *
   * A single "it worked / it did not" line is what made this unfixable: the
   * three things that actually go wrong — never invited, wrong channel, no
   * Send Messages — all look identical from outside. The list stays until the
   * next run so the operator can work down it.
   */
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; checks: DiscordCheck[] }>('/admin/discord/test'),
    onSuccess: (result) => {
      setError(null);
      setChecks(result.checks);
      setNotice(result.ok ? 'Everything works — a test message was posted to the channel.' : null);
    },
    onError: (caught) => {
      setChecks(null);
      fail(caught);
    },
  });

  const announceGames = useMutation({
    mutationFn: () => api.post<{ posted: number }>('/admin/discord/announce-new-games'),
    onSuccess: (result) => {
      setError(null);
      setNotice(
        result.posted === 0
          ? 'Nothing new to announce.'
          : `Announced ${result.posted} ${result.posted === 1 ? 'game' : 'games'}.`,
      );
    },
    onError: fail,
  });

  if (configQuery.isLoading || !config) return <SectionSkeleton rows={3} />;

  return (
    <div className="gb-page-narrow">
      <FormError message={error} />
      <Notice message={notice} />

      {/* First, because it is the thing an operator comes here to check: is
          the bot on, and what does it look like in the member list. */}
      <BotControl
        status={config.bot}
        presence={config.presence}
        hasToken={config.botTokenSet}
        onError={setError}
        onNotice={setNotice}
      />

      {/* ------------------------------------------------------ application */}
      <section className="gb-card space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Sign in with Discord</h2>
          {config.clientId && config.clientSecretSet ? (
            <Badge tone="success">Set up</Badge>
          ) : (
            <Badge tone="neutral">Not set up</Badge>
          )}
          {config.linkedAccounts > 0 ? (
            <span className="text-ink-400 ml-auto text-xs">
              {config.linkedAccounts} linked {config.linkedAccounts === 1 ? 'account' : 'accounts'}
            </span>
          ) : null}
        </div>

        <p className="text-ink-400 text-xs leading-relaxed">
          From a Discord application&rsquo;s OAuth2 tab. The redirect URI it must list is{' '}
          <code className="font-mono">
            {form.publicUrl || 'https://your-server'}/api/auth/discord/callback
          </code>{' '}
          — Discord refuses the exchange if it does not match exactly.
        </p>

        <Field label="Client ID" htmlFor="d-client">
          <input
            id="d-client"
            className="gb-input font-mono"
            value={form.clientId}
            onChange={(e) => setForm({ ...form, clientId: e.target.value })}
          />
        </Field>

        <Field
          label="Client secret"
          htmlFor="d-secret"
          hint={config.clientSecretSet ? 'Stored. Type a new one to replace it.' : 'Not set.'}
        >
          <div className="flex gap-2">
            <input
              id="d-secret"
              type="password"
              className="gb-input font-mono"
              placeholder={config.clientSecretSet ? '••••••••' : ''}
              value={secrets.clientSecret}
              onChange={(e) => setSecrets({ ...secrets, clientSecret: e.target.value })}
            />
            {config.clientSecretSet ? (
              <button
                type="button"
                className="gb-btn-danger shrink-0 px-2"
                aria-label="Clear the client secret"
                onClick={() => clearSecret.mutate('clientSecret')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
          </div>
        </Field>

        <Field
          label="Server (guild) ID"
          htmlFor="d-guild"
          hint="Right-click your Discord server with Developer Mode on, then Copy Server ID."
        >
          <input
            id="d-guild"
            className="gb-input font-mono"
            value={form.guildId}
            onChange={(e) => setForm({ ...form, guildId: e.target.value })}
          />
        </Field>

        <Field
          label="Invite link"
          htmlFor="d-invite"
          hint="Where somebody is sent if the bot cannot add them. Use a link that does not expire."
        >
          <input
            id="d-invite"
            className="gb-input"
            placeholder="https://discord.gg/…"
            value={form.inviteUrl}
            onChange={(e) => setForm({ ...form, inviteUrl: e.target.value })}
          />
        </Field>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={config.requireGuild}
            onChange={(e) => save.mutate({ requireGuild: e.target.checked })}
          />
          <span>
            Require players to be in the server
            <span className="text-ink-400 block text-xs">
              They are added automatically when they authorise. This refuses the link if that fails
              and they are not already a member.
            </span>
          </span>
        </label>
      </section>

      {/* -------------------------------------------------------------- bot */}
      <section className="gb-card space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">The bot</h2>
          {config.botTokenSet ? (
            <Badge tone="success">Token stored</Badge>
          ) : (
            <Badge tone="neutral">No token</Badge>
          )}
          <button
            type="button"
            className="gb-btn-ghost ml-auto"
            disabled={!config.botTokenSet || test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <TestTube2 className="h-4 w-4" aria-hidden />
            )}
            Test
          </button>
        </div>

        <p className="text-ink-400 text-xs leading-relaxed">
          From the application&rsquo;s Bot tab. Invite it to your server with the{' '}
          <strong>Send Messages</strong> permission, and <strong>Create Instant Invite</strong> if
          you want it to add people who link.
        </p>

        {checks ? (
          <ul className="divide-ink-700/70 bg-ink-800/50 divide-y rounded-lg">
            {checks.map((check) => (
              <li key={check.id} className="flex items-start gap-2 px-3 py-2">
                {check.ok ? (
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                ) : (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{check.label}</span>
                  <span className="text-ink-400 block text-xs leading-relaxed">{check.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <Field
          label="Bot token"
          htmlFor="d-bot"
          hint={config.botTokenSet ? 'Stored. Type a new one to replace it.' : 'Not set.'}
        >
          <div className="flex gap-2">
            <input
              id="d-bot"
              type="password"
              className="gb-input font-mono"
              placeholder={config.botTokenSet ? '••••••••' : ''}
              value={secrets.botToken}
              onChange={(e) => setSecrets({ ...secrets, botToken: e.target.value })}
            />
            {config.botTokenSet ? (
              <button
                type="button"
                className="gb-btn-danger shrink-0 px-2"
                aria-label="Clear the bot token"
                onClick={() => clearSecret.mutate('botToken')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
          </div>
        </Field>

        <Field
          label="Announcement channel"
          htmlFor="d-channel"
          hint="Where new games and granted requests are posted, and the default for a post below."
        >
          <ChannelPicker
            id="d-channel"
            value={form.channelId}
            guild={guild}
            onChange={(channelId) => setForm({ ...form, channelId })}
          />
        </Field>

        <Field
          label="This server's public address"
          htmlFor="d-public"
          hint="Needed for cover art: Discord fetches the image itself, so a relative path would resolve against discord.com."
        >
          <input
            id="d-public"
            className="gb-input"
            placeholder="https://archive.example.com"
            value={form.publicUrl}
            onChange={(e) => setForm({ ...form, publicUrl: e.target.value })}
          />
        </Field>

        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={config.announceNewGames}
              onChange={(e) => save.mutate({ announceNewGames: e.target.checked })}
            />
            <span>
              Announce new games
              <span className="text-ink-400 block text-xs">
                Checked every fifteen minutes. Only games whose metadata matched are posted, and
                turning this on starts from now rather than announcing everything already here.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={config.announceRequests}
              onChange={(e) => save.mutate({ announceRequests: e.target.checked })}
            />
            <span>
              Announce granted requests
              <span className="text-ink-400 block text-xs">
                When a requested game is marked as added.
              </span>
            </span>
          </label>
        </div>

        <button
          type="button"
          className="gb-btn-ghost"
          disabled={!config.botTokenSet || announceGames.isPending}
          onClick={() => announceGames.mutate()}
        >
          {announceGames.isPending ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <Check className="h-4 w-4" aria-hidden />
          )}
          Run the new-game announcer now
        </button>
      </section>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="gb-btn-primary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              ...form,
              ...(secrets.clientSecret ? { clientSecret: secrets.clientSecret } : {}),
              ...(secrets.botToken ? { botToken: secrets.botToken } : {}),
            })
          }
        >
          {save.isPending ? <Spinner className="h-4 w-4" /> : null}
          Save Discord settings
        </button>
      </div>

      <PostSection
        hasToken={config.botTokenSet}
        defaultChannelId={config.channelId}
        guild={guild}
        onError={setError}
        onNotice={setNotice}
      />

      <TicketSection
        config={config.tickets}
        guild={guild}
        botOnline={config.bot.state === 'ready'}
        onError={setError}
        onNotice={setNotice}
      />

      {!config.clientId && !config.botTokenSet ? (
        <p className="text-ink-500 flex items-start gap-2 text-xs">
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Nothing here is required. With none of it set, GameBlade behaves exactly as it did
            before Discord existed.
          </span>
        </p>
      ) : null}
    </div>
  );
}
