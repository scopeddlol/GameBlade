import type { PublicUser } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, FormError, RowSkeleton } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<PublicUser[]>('/admin/users'),
  });

  const [error, setError] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.patch(`/admin/users/${id}`, patch),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not update user.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not delete user.'),
  });

  // Shown once, next to the account it belongs to. There is no mail server
  // here, so handing the link to the player is the administrator's job — and
  // the token is never readable again after this.
  const [resetLink, setResetLink] = useState<{ username: string; url: string } | null>(null);

  const resetMutation = useMutation({
    mutationFn: (user: PublicUser) =>
      api
        .post<{ path: string }>(`/admin/users/${user.id}/password-reset`, {})
        .then((result) => ({ user, result })),
    onSuccess: ({ user, result }) => {
      setError(null);
      setResetLink({ username: user.username, url: `${window.location.origin}${result.path}` });
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not create a reset link.',
      ),
  });

  if (usersQuery.isLoading) return <RowSkeleton rows={5} />;

  return (
    <section className="gb-card gb-page p-5">
      <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Users</h2>
      <FormError message={error} />
      <div className="divide-ink-700/70 divide-y">
        {(usersQuery.data ?? []).map((user) => (
          <div key={user.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-[160px] flex-1">
              <p className="text-sm font-medium">
                {user.username} {user.role === 'admin' ? <Badge tone="info">Admin</Badge> : null}
                {user.isActive ? null : <Badge tone="danger">Disabled</Badge>}
              </p>
              <p className="text-ink-400 text-xs">
                {user.email ?? 'No email'} · joined {formatDateTime(user.createdAt)} · last login{' '}
                {formatRelative(user.lastLoginAt)}
              </p>
            </div>

            <select
              className="gb-input w-auto"
              value={user.role}
              onChange={(e) =>
                updateMutation.mutate({ id: user.id, patch: { role: e.target.value } })
              }
              aria-label={`Role for ${user.username}`}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>

            <button
              type="button"
              className="gb-btn-ghost"
              onClick={() =>
                updateMutation.mutate({ id: user.id, patch: { isActive: !user.isActive } })
              }
            >
              {user.isActive ? 'Disable' : 'Enable'}
            </button>

            <button
              type="button"
              className="gb-btn-ghost"
              title="Create a single-use password reset link"
              onClick={() => resetMutation.mutate(user)}
              disabled={resetMutation.isPending}
            >
              <KeyRound className="h-4 w-4" aria-hidden />
            </button>

            <button
              type="button"
              className="gb-btn-danger"
              onClick={() => {
                if (confirm(`Permanently delete "${user.username}"?`)) {
                  deleteMutation.mutate(user.id);
                }
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>

            {resetLink && resetLink.username === user.username ? (
              <div className="border-blade-500/40 bg-ink-900/60 w-full rounded-lg border p-3">
                <p className="text-ink-300 mb-2 text-xs">
                  Single-use reset link for <strong>{user.username}</strong>. It is shown once —
                  copy it now, and send it to them yourself.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    readOnly
                    className="gb-input flex-1 font-mono text-xs"
                    value={resetLink.url}
                  />
                  <button
                    type="button"
                    className="gb-btn-ghost text-xs"
                    onClick={() => void navigator.clipboard?.writeText(resetLink.url)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="gb-btn-ghost text-xs"
                    onClick={() => setResetLink(null)}
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
