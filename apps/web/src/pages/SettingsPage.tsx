import { changePasswordSchema, type DeviceInfo } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Field, FormError, PageLoader, Spinner } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { api, ApiRequestError } from '../lib/api.js';
import { formatDateTime, formatRelative } from '../lib/format.js';

export function SettingsPage() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<DeviceInfo[]>('/auth/devices'),
  });

  const revokeMutation = useMutation({
    mutationFn: (deviceId: string) => api.delete(`/auth/devices/${deviceId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['devices'] }),
  });

  const passwordMutation = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: () => {
      // The server invalidates every other session, so warn rather than silently log out.
      setNotice('Password updated. All other sessions and desktop devices were signed out.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (caught) => {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not update password.');
    },
  });

  const handlePasswordSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (newPassword !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    const parsed = changePasswordSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details above.');
      return;
    }
    passwordMutation.mutate();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="text-ink-400 mt-1 text-sm">
          Signed in as <span className="text-ink-200">{user?.username}</span>
          {user?.role === 'admin' ? (
            <>
              {' '}
              <Badge tone="info">Administrator</Badge>
            </>
          ) : null}
        </p>
      </div>

      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Change password</h2>
        <form onSubmit={handlePasswordSubmit} className="max-w-sm space-y-4">
          <FormError message={error} />
          {notice ? (
            <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
              {notice}
            </p>
          ) : null}
          <Field label="Current password" htmlFor="current">
            <input
              id="current"
              type="password"
              className="gb-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password" htmlFor="new" hint="At least 10 characters.">
            <input
              id="new"
              type="password"
              className="gb-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirmNew">
            <input
              id="confirmNew"
              type="password"
              className="gb-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <button type="submit" className="gb-btn-primary" disabled={passwordMutation.isPending}>
            {passwordMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
            Update password
          </button>
        </form>
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">Desktop devices</h2>
        <p className="text-ink-400 mb-4 text-sm">
          Each sign-in from the desktop app gets its own token. Revoking one signs out only that
          device.
        </p>

        {devicesQuery.isLoading ? (
          <PageLoader label="Loading devices" />
        ) : (devicesQuery.data ?? []).length === 0 ? (
          <p className="text-ink-400 text-sm">No desktop devices have signed in yet.</p>
        ) : (
          <div className="divide-ink-700/70 divide-y">
            {(devicesQuery.data ?? []).map((device) => (
              <div key={device.id} className="flex items-center gap-3 py-3">
                <Laptop className="text-ink-400 h-5 w-5 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {device.name}
                    {device.isCurrent ? (
                      <>
                        {' '}
                        <Badge tone="success">This device</Badge>
                      </>
                    ) : null}
                  </p>
                  <p className="text-ink-400 text-xs">
                    {device.platform ?? 'Unknown platform'} · last seen{' '}
                    {formatRelative(device.lastSeenAt)} · expires {formatDateTime(device.expiresAt)}
                  </p>
                </div>
                <button
                  type="button"
                  className="gb-btn-danger shrink-0"
                  onClick={() => revokeMutation.mutate(device.id)}
                  disabled={revokeMutation.isPending}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
