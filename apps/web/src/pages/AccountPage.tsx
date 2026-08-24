import type { DeviceInfo, PublicUser } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut, Swords } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Field, FormError, PageLoader, Spinner } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { api, ApiRequestError } from '../lib/api.js';
import { formatRelative } from '../lib/format.js';

/**
 * Self-service account management — the destination for anyone who signs in
 * on the web without an admin role, who previously had nowhere to go at all.
 * Admins reach it too, from the sidebar, since PATCH /admin/users/:id was
 * never a comfortable place to rename yourself out of a table of every user
 * on the server.
 */
export function AccountPage() {
  const { user, refresh, signOut } = useSession();
  const navigate = useNavigate();

  if (!user) return <PageLoader label="Loading your account" />;

  const handleSignOut = async () => {
    await signOut();
    navigate('/', { replace: true });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-5 py-10">
      <div className="flex items-center gap-3">
        <Link to="/" className="inline-flex items-center gap-2">
          <Swords className="text-blade-400 h-6 w-6" aria-hidden />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
          <p className="text-ink-400 text-sm">Signed in as {user.username}</p>
        </div>
        <button type="button" onClick={handleSignOut} className="gb-btn-ghost ml-auto">
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </div>

      <ProfileSection user={user} onSaved={refresh} />
      <PasswordSection />
      <DiscordSection />
      <DevicesSection />
    </div>
  );
}

function ProfileSection({ user, onSaved }: { user: PublicUser; onSaved: () => Promise<void> }) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.patch<PublicUser>('/account', { username, email: email || null }),
    onSuccess: async () => {
      setNotice('Saved.');
      setError(null);
      await onSaved();
    },
    onError: (caught) => {
      setNotice(null);
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save changes.');
    },
  });

  return (
    <form
      className="gb-card space-y-4 p-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <h2 className="text-sm font-semibold tracking-wide uppercase">Profile</h2>
      <FormError message={error} />
      {notice ? <p className="text-sm text-emerald-300">{notice}</p> : null}

      <Field label="Username" htmlFor="accountUsername">
        <input
          id="accountUsername"
          className="gb-input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          minLength={3}
          maxLength={32}
          required
        />
      </Field>

      <Field
        label="Email"
        htmlFor="accountEmail"
        hint="Not used for anything yet — this is just where you're reachable."
      >
        <input
          id="accountEmail"
          type="email"
          className="gb-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </Field>

      <button type="submit" className="gb-btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? <Spinner className="h-4 w-4" /> : null}
        Save
      </button>
    </form>
  );
}

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: () => {
      setNotice('Password changed. You have been signed out everywhere else.');
      setError(null);
      setCurrentPassword('');
      setNewPassword('');
    },
    onError: (caught) => {
      setNotice(null);
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not change password.');
    },
  });

  return (
    <form
      className="gb-card space-y-4 p-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <h2 className="text-sm font-semibold tracking-wide uppercase">Password</h2>
      <FormError message={error} />
      {notice ? <p className="text-sm text-emerald-300">{notice}</p> : null}

      <Field label="Current password" htmlFor="currentPassword">
        <input
          id="currentPassword"
          type="password"
          className="gb-input"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>

      <Field
        label="New password"
        htmlFor="newPassword"
        hint="At least 10 characters. This signs out every other session and device, including the desktop client."
      >
        <input
          id="newPassword"
          type="password"
          className="gb-input"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          minLength={10}
          required
        />
      </Field>

      <button type="submit" className="gb-btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? <Spinner className="h-4 w-4" /> : null}
        Change password
      </button>
    </form>
  );
}

/**
 * Linking a Discord account, and deciding whether anyone else sees it.
 *
 * The whole section disappears on a server that has not set Discord up, which
 * is most of them: an integration nobody configured should not leave a dead
 * panel on everyone's account page.
 */
function DiscordSection() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['account', 'discord'],
    queryFn: () =>
      api.get<{
        link: {
          username: string;
          globalName: string | null;
          avatarUrl: string | null;
          showUsername: boolean;
          inGuild: boolean;
        } | null;
        status: { configured: boolean; inviteUrl: string | null; requireGuild: boolean };
      }>('/account/discord'),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['account', 'discord'] });

  const start = useMutation({
    mutationFn: () => api.get<{ url: string }>('/auth/discord/start?intent=link'),
    onSuccess: (result) => {
      // A full navigation rather than a popup: the callback needs this
      // origin's session cookie, and coming back here is the natural end.
      window.location.href = result.url;
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not start.'),
  });

  const unlink = useMutation({
    mutationFn: () => api.delete('/account/discord'),
    onSuccess: refresh,
  });

  const setVisibility = useMutation({
    mutationFn: (showUsername: boolean) => api.patch('/account/discord', { showUsername }),
    onSuccess: refresh,
  });

  const data = query.data;
  if (query.isLoading || !data?.status.configured) return null;

  return (
    <section className="gb-card space-y-4 p-5">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Discord</h2>
      <FormError message={error} />

      {data.link ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {data.link.avatarUrl ? (
              <img
                src={data.link.avatarUrl}
                alt=""
                className="h-10 w-10 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : null}
            <div className="min-w-0">
              <p className="text-sm font-medium">{data.link.globalName ?? data.link.username}</p>
              <p className="text-ink-400 font-mono text-xs">{data.link.username}</p>
            </div>
            {data.link.inGuild ? (
              <Badge tone="success">In the Discord</Badge>
            ) : (
              <Badge tone="warning">Not in the Discord</Badge>
            )}
            <button
              type="button"
              className="gb-btn-ghost ml-auto"
              onClick={() => unlink.mutate()}
              disabled={unlink.isPending}
            >
              Unlink
            </button>
          </div>

          {/* Off unless it is turned on. Linking is for signing in and finding
              people; neither needs a handle published to anyone. */}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={data.link.showUsername}
              onChange={(event) => setVisibility.mutate(event.target.checked)}
            />
            <span>
              Show my Discord username to other players
              <span className="text-ink-400 block text-xs">
                Off by default. With it off, your account stays linked and nobody here sees the
                handle.
              </span>
            </span>
          </label>

          {!data.link.inGuild && data.status.inviteUrl ? (
            <p className="gb-note-warning">
              You are not in the server.{' '}
              <a
                className="underline"
                href={data.status.inviteUrl}
                target="_blank"
                rel="noreferrer"
              >
                Join it
              </a>{' '}
              to show up alongside the other players here.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-ink-300 text-sm leading-relaxed">
            Link your Discord to sign in with it, and to find the other people on this server.
            {data.status.requireGuild ? ' You will be added to the server as part of linking.' : ''}
          </p>
          <button
            type="button"
            className="gb-btn-primary"
            onClick={() => start.mutate()}
            disabled={start.isPending}
          >
            {start.isPending ? <Spinner className="h-4 w-4" /> : null}
            Connect Discord
          </button>
        </>
      )}
    </section>
  );
}

function DevicesSection() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const devicesQuery = useQuery({
    queryKey: ['account', 'devices'],
    queryFn: () => api.get<DeviceInfo[]>('/auth/devices'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/devices/${id}`),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['account', 'devices'] });
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not sign that device out.',
      ),
  });

  // Web sign-ins use a cookie, not a device token, so this list is always
  // desktop clients — an empty list just means none have signed in yet.
  const devices = devicesQuery.data ?? [];

  return (
    <section className="gb-card space-y-4 p-5">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Signed-in devices</h2>
      <FormError message={error} />

      {devicesQuery.isLoading ? (
        <Spinner className="h-4 w-4" />
      ) : devices.length === 0 ? (
        <p className="text-ink-400 text-sm">
          No desktop client has signed in yet. Install it and sign in to see it here.
        </p>
      ) : (
        <ul className="divide-ink-700/70 divide-y">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3 py-3">
              <Laptop className="text-ink-400 h-5 w-5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {device.name}
                  {device.isCurrent ? (
                    <span className="text-blade-400 ml-2 text-xs font-normal">This device</span>
                  ) : null}
                </p>
                <p className="text-ink-400 text-xs">
                  {device.platform ?? 'Unknown platform'} · last used{' '}
                  {formatRelative(device.lastSeenAt)}
                </p>
              </div>
              <button
                type="button"
                className="gb-btn-ghost"
                disabled={revokeMutation.isPending}
                onClick={() => revokeMutation.mutate(device.id)}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
