import type { DeviceInfo, PublicUser } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut, Swords } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Field, FormError, PageLoader, Spinner } from '../components/ui.js';
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
