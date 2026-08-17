import type { InviteInfo } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Field, PageLoader } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { BASE_PATH } from '../../lib/base.js';
import { formatDateTime } from '../../lib/format.js';

export function AdminInvitesPage() {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [maxUses, setMaxUses] = useState(1);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(14);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const invitesQuery = useQuery({
    queryKey: ['admin', 'invites'],
    queryFn: () => api.get<InviteInfo[]>('/admin/invites'),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/admin/invites', { role, maxUses, expiresInDays, note: note || undefined }),
    onSuccess: () => {
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/invites/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] }),
  });

  const inviteLink = (code: string) =>
    `${window.location.origin}${BASE_PATH}/register?invite=${code}`;

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access can be denied; the link is visible for manual copying.
      setCopied(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Invites</h1>
      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Create an invite</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createMutation.mutate();
          }}
        >
          <Field label="Role" htmlFor="inviteRole">
            <select
              id="inviteRole"
              className="gb-input w-auto"
              value={role}
              onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Field label="Uses" htmlFor="inviteUses">
            <input
              id="inviteUses"
              type="number"
              min={1}
              max={100}
              className="gb-input w-24"
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value))}
            />
          </Field>
          <Field label="Expires" htmlFor="inviteExpiry">
            <select
              id="inviteExpiry"
              className="gb-input w-auto"
              value={expiresInDays === null ? 'never' : String(expiresInDays)}
              onChange={(e) =>
                setExpiresInDays(e.target.value === 'never' ? null : Number(e.target.value))
              }
            >
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="never">Never</option>
            </select>
          </Field>
          <div className="min-w-[160px] flex-1">
            <Field label="Note (optional)" htmlFor="inviteNote">
              <input
                id="inviteNote"
                className="gb-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="For Alex"
              />
            </Field>
          </div>
          <button type="submit" className="gb-btn-primary" disabled={createMutation.isPending}>
            Create invite
          </button>
        </form>
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Active invites</h2>
        {invitesQuery.isLoading ? (
          <PageLoader label="Loading invites" />
        ) : (invitesQuery.data ?? []).length === 0 ? (
          <p className="text-ink-400 text-sm">No invites yet.</p>
        ) : (
          <div className="divide-ink-700/70 divide-y">
            {(invitesQuery.data ?? []).map((invite) => (
              <div key={invite.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-[220px] flex-1">
                  <p className="font-mono text-sm font-medium tracking-wider">
                    {invite.code}{' '}
                    {invite.isValid ? (
                      <Badge tone="success">Valid</Badge>
                    ) : (
                      <Badge tone="neutral">Used / expired</Badge>
                    )}
                  </p>
                  <p className="text-ink-400 text-xs">
                    {invite.role} · {invite.uses}/{invite.maxUses} used · expires{' '}
                    {invite.expiresAt ? formatDateTime(invite.expiresAt) : 'never'}
                    {invite.note ? ` · ${invite.note}` : ''}
                  </p>
                </div>
                <button type="button" className="gb-btn-ghost" onClick={() => copy(invite.code)}>
                  {copied === invite.code ? (
                    <Check className="h-4 w-4" aria-hidden />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden />
                  )}
                  {copied === invite.code ? 'Copied' : 'Copy link'}
                </button>
                {invite.isValid ? (
                  <button
                    type="button"
                    className="gb-btn-danger"
                    onClick={() => revokeMutation.mutate(invite.id)}
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
