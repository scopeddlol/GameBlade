import type { PublicUser } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, FormError, PageLoader } from '../../components/ui.js';
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

  if (usersQuery.isLoading) return <PageLoader label="Loading users" />;

  return (
    <section className="gb-card mx-auto max-w-5xl p-5">
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
              className="gb-btn-danger"
              onClick={() => {
                if (confirm(`Permanently delete "${user.username}"?`)) {
                  deleteMutation.mutate(user.id);
                }
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
