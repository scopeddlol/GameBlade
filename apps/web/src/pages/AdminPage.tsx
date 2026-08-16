import type {
  InviteInfo,
  LibraryInfo,
  PublicUser,
  ScanProgress,
  ServerSettings,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, FolderPlus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Field, FormError, PageLoader, Spinner } from '../components/ui.js';
import { api, ApiRequestError } from '../lib/api.js';
import { BASE_PATH } from '../lib/base.js';
import { formatBytes, formatDateTime, formatRelative } from '../lib/format.js';

const TABS = [
  { id: 'libraries', label: 'Libraries' },
  { id: 'users', label: 'Users' },
  { id: 'invites', label: 'Invites' },
  { id: 'providers', label: 'Metadata' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function AdminPage() {
  const [tab, setTab] = useState<TabId>('libraries');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>

      <div className="border-ink-700 flex gap-1 border-b" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={
              tab === t.id
                ? 'border-blade-500 text-ink-100 -mb-px border-b-2 px-4 py-2 text-sm font-medium'
                : 'text-ink-400 hover:text-ink-200 -mb-px border-b-2 border-transparent px-4 py-2 text-sm font-medium'
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'libraries' ? <LibrariesTab /> : null}
      {tab === 'users' ? <UsersTab /> : null}
      {tab === 'invites' ? <InvitesTab /> : null}
      {tab === 'providers' ? <ProvidersTab /> : null}
    </div>
  );
}

function LibrariesTab() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const librariesQuery = useQuery({
    queryKey: ['admin', 'libraries'],
    queryFn: () => api.get<LibraryInfo[]>('/admin/libraries'),
  });

  // Poll while a scan is running so progress advances without a manual refresh.
  const progressQuery = useQuery({
    queryKey: ['admin', 'scan'],
    queryFn: () => api.get<ScanProgress>('/admin/scan/progress'),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'scanning' || state === 'matching' ? 1000 : false;
    },
  });

  const addMutation = useMutation({
    mutationFn: () => api.post('/admin/libraries', { name, path, enabled: true }),
    onSuccess: async () => {
      setName('');
      setPath('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'libraries'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not add library.'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/libraries/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'libraries'] }),
  });

  const scanMutation = useMutation({
    mutationFn: (libraryId?: string) =>
      api.post('/admin/scan', { libraryId, force: false, fetchMetadata: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'scan'] }),
  });

  const progress = progressQuery.data;
  const scanning = progress?.state === 'scanning' || progress?.state === 'matching';

  return (
    <div className="space-y-6">
      <section className="gb-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Scan</h2>
          <button
            type="button"
            className="gb-btn-primary"
            onClick={() => scanMutation.mutate(undefined)}
            disabled={scanning || scanMutation.isPending}
          >
            {scanning ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            {scanning ? 'Scanning…' : 'Scan all libraries'}
          </button>
        </div>

        {progress ? (
          <div className="space-y-2">
            <div className="text-ink-300 flex items-center gap-2 text-sm">
              <Badge
                tone={
                  progress.state === 'error'
                    ? 'danger'
                    : progress.state === 'idle'
                      ? 'neutral'
                      : 'info'
                }
              >
                {progress.state}
              </Badge>
              {scanning && progress.total > 0 ? (
                <span>
                  {progress.processed} / {progress.total}
                  {progress.currentItem ? ` · ${progress.currentItem}` : ''}
                </span>
              ) : null}
              {progress.finishedAt && !scanning ? (
                <span>Last finished {formatRelative(progress.finishedAt)}</span>
              ) : null}
            </div>

            {scanning && progress.total > 0 ? (
              <div className="bg-ink-700 h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="bg-blade-500 h-full transition-all"
                  style={{ width: `${Math.min(100, (progress.processed / progress.total) * 100)}%` }}
                />
              </div>
            ) : null}

            {progress.state === 'error' && progress.error ? (
              <FormError message={progress.error} />
            ) : null}

            {!scanning && progress.finishedAt ? (
              <p className="text-ink-400 text-xs">
                {progress.added} added · {progress.updated} updated · {progress.removed} missing
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Library folders</h2>

        {librariesQuery.isLoading ? (
          <PageLoader label="Loading libraries" />
        ) : (librariesQuery.data ?? []).length === 0 ? (
          <p className="text-ink-400 mb-4 text-sm">
            No libraries yet. Add the path <em>inside the container</em> — for example{' '}
            <code className="bg-ink-800 rounded px-1">/library</code> if you mounted your games
            there.
          </p>
        ) : (
          <div className="divide-ink-700/70 mb-4 divide-y">
            {(librariesQuery.data ?? []).map((library) => (
              <div key={library.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {library.name} {library.enabled ? null : <Badge tone="warning">Disabled</Badge>}
                  </p>
                  <p className="text-ink-400 truncate font-mono text-xs">{library.path}</p>
                  <p className="text-ink-400 mt-0.5 text-xs">
                    {library.gameCount} games · {formatBytes(library.totalBytes)} · scanned{' '}
                    {formatRelative(library.lastScanAt)}
                    {library.lastScanStatus?.startsWith('error') ? (
                      <span className="text-amber-400"> · {library.lastScanStatus}</span>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  className="gb-btn-ghost shrink-0"
                  onClick={() => scanMutation.mutate(library.id)}
                  disabled={scanning}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Scan
                </button>
                <button
                  type="button"
                  className="gb-btn-danger shrink-0"
                  onClick={() => {
                    if (
                      confirm(
                        `Remove "${library.name}" from GameBlade? Your files on disk are not touched.`,
                      )
                    ) {
                      removeMutation.mutate(library.id);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            addMutation.mutate();
          }}
        >
          <div className="min-w-[160px] flex-1">
            <Field label="Name" htmlFor="libName">
              <input
                id="libName"
                className="gb-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Games"
                required
              />
            </Field>
          </div>
          <div className="min-w-[240px] flex-[2]">
            <Field label="Path in container" htmlFor="libPath">
              <input
                id="libPath"
                className="gb-input font-mono"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/library"
                required
              />
            </Field>
          </div>
          <button type="submit" className="gb-btn-primary" disabled={addMutation.isPending}>
            <FolderPlus className="h-4 w-4" aria-hidden />
            Add
          </button>
        </form>
        <FormError message={error} />
      </section>
    </div>
  );
}

function UsersTab() {
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
    <section className="gb-card p-5">
      <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Users</h2>
      <FormError message={error} />
      <div className="divide-ink-700/70 divide-y">
        {(usersQuery.data ?? []).map((user) => (
          <div key={user.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-[160px] flex-1">
              <p className="text-sm font-medium">
                {user.username}{' '}
                {user.role === 'admin' ? <Badge tone="info">Admin</Badge> : null}
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

function InvitesTab() {
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
    <div className="space-y-6">
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

function ProvidersTab() {
  const queryClient = useQueryClient();
  const [igdbClientId, setIgdbClientId] = useState('');
  const [igdbClientSecret, setIgdbClientSecret] = useState('');
  const [steamGridDbKey, setSteamGridDbKey] = useState('');
  const [serverName, setServerName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => {
      const data = await api.get<ServerSettings>('/admin/settings');
      setServerName((current) => current || data.serverName);
      setIgdbClientId((current) => current || (data.igdbClientId ?? ''));
      return data;
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch<ServerSettings>('/admin/settings', {
        serverName: serverName || undefined,
        // Empty fields are left untouched so a stored secret is not wiped by a blank box.
        igdbClientId: igdbClientId || undefined,
        igdbClientSecret: igdbClientSecret || undefined,
        steamGridDbKey: steamGridDbKey || undefined,
      }),
    onSuccess: async () => {
      setNotice('Settings saved.');
      setError(null);
      setIgdbClientSecret('');
      setSteamGridDbKey('');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not save settings.'),
  });

  const registrationMutation = useMutation({
    mutationFn: (allow: boolean) => api.patch('/admin/settings', { allowSelfRegistration: allow }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => api.post('/admin/settings/test-providers'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }),
  });

  if (settingsQuery.isLoading) return <PageLoader label="Loading settings" />;
  const settings = settingsQuery.data;

  return (
    <div className="space-y-6">
      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Server</h2>
        <div className="max-w-sm space-y-4">
          <Field label="Server name" htmlFor="serverName">
            <input
              id="serverName"
              className="gb-input"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
            />
          </Field>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings?.allowSelfRegistration ?? false}
              onChange={(e) => registrationMutation.mutate(e.target.checked)}
            />
            <span>
              Allow self-registration
              <span className="text-ink-400 block text-xs">
                Off by default. When off, an invite code is required to create an account.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="gb-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Metadata providers</h2>
          <button
            type="button"
            className="gb-btn-ghost"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
          >
            {testMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
            Test connections
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {(settings?.providers ?? []).map((provider) => (
            <div key={provider.name} className="bg-ink-800 rounded-lg px-3 py-2 text-sm">
              <span className="font-medium">
                {provider.name === 'igdb' ? 'IGDB' : 'SteamGridDB'}
              </span>{' '}
              {!provider.configured ? (
                <Badge tone="neutral">Not configured</Badge>
              ) : provider.reachable === true ? (
                <Badge tone="success">Connected</Badge>
              ) : provider.reachable === false ? (
                <Badge tone="danger">Failed</Badge>
              ) : (
                <Badge tone="info">Configured</Badge>
              )}
              {provider.lastError ? (
                <p className="mt-1 max-w-xs text-xs text-amber-300">{provider.lastError}</p>
              ) : null}
            </div>
          ))}
        </div>

        <FormError message={error} />
        {notice ? (
          <p className="mb-3 rounded-lg border border-emerald-900/60 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
            {notice}
          </p>
        ) : null}

        <form
          className="max-w-md space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            saveMutation.mutate();
          }}
        >
          <Field
            label="IGDB client ID"
            htmlFor="igdbId"
            hint="Create a Twitch application at dev.twitch.tv to get these."
          >
            <input
              id="igdbId"
              className="gb-input"
              value={igdbClientId}
              onChange={(e) => setIgdbClientId(e.target.value)}
              autoComplete="off"
            />
          </Field>

          <Field
            label="IGDB client secret"
            htmlFor="igdbSecret"
            hint={settings?.igdbClientSecretSet ? 'A secret is saved. Leave blank to keep it.' : undefined}
          >
            <input
              id="igdbSecret"
              type="password"
              className="gb-input"
              value={igdbClientSecret}
              onChange={(e) => setIgdbClientSecret(e.target.value)}
              autoComplete="new-password"
              placeholder={settings?.igdbClientSecretSet ? '••••••••' : ''}
            />
          </Field>

          <Field
            label="SteamGridDB API key"
            htmlFor="sgdbKey"
            hint={
              settings?.steamGridDbKeySet
                ? 'A key is saved. Leave blank to keep it.'
                : 'Get one from your SteamGridDB account preferences.'
            }
          >
            <input
              id="sgdbKey"
              type="password"
              className="gb-input"
              value={steamGridDbKey}
              onChange={(e) => setSteamGridDbKey(e.target.value)}
              autoComplete="new-password"
              placeholder={settings?.steamGridDbKeySet ? '••••••••' : ''}
            />
          </Field>

          <button type="submit" className="gb-btn-primary" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
            Save
          </button>
        </form>
      </section>
    </div>
  );
}
