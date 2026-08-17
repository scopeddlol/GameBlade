import type { ServerSettings } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge, Field, FormError, PageLoader, Spinner } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';

export function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    serverName: '',
    tagline: '',
    downloadUrl: '',
    clientVersion: '',
    igdbClientId: '',
  });
  // Secrets are write-only: the server reports whether one is set but never
  // returns it, so a blank box means "leave what is stored alone".
  const [secrets, setSecrets] = useState({
    igdbClientSecret: '',
    steamGridDbKey: '',
    steamApiKey: '',
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => {
      const data = await api.get<ServerSettings>('/admin/settings');
      setForm((current) => ({
        serverName: current.serverName || data.serverName,
        tagline: current.tagline || data.tagline,
        downloadUrl: current.downloadUrl || (data.downloadUrl ?? ''),
        clientVersion: current.clientVersion || (data.clientVersion ?? ''),
        igdbClientId: current.igdbClientId || (data.igdbClientId ?? ''),
      }));
      return data;
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch<ServerSettings>('/admin/settings', {
        serverName: form.serverName || undefined,
        tagline: form.tagline || undefined,
        downloadUrl: form.downloadUrl,
        clientVersion: form.clientVersion || null,
        igdbClientId: form.igdbClientId || undefined,
        igdbClientSecret: secrets.igdbClientSecret || undefined,
        steamGridDbKey: secrets.steamGridDbKey || undefined,
        steamApiKey: secrets.steamApiKey || undefined,
      }),
    onSuccess: async () => {
      setNotice('Settings saved.');
      setError(null);
      setSecrets({ igdbClientSecret: '', steamGridDbKey: '', steamApiKey: '' });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
      await queryClient.invalidateQueries({ queryKey: ['public', 'info'] });
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
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <FormError message={error} />
      {notice ? (
        <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </p>
      ) : null}

      <form
        className="space-y-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          saveMutation.mutate();
        }}
      >
        <section className="gb-card space-y-4 p-5">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Public page</h2>

          <Field label="Server name" htmlFor="serverName">
            <input
              id="serverName"
              className="gb-input"
              value={form.serverName}
              onChange={(e) => setForm({ ...form, serverName: e.target.value })}
            />
          </Field>

          <Field
            label="Tagline"
            htmlFor="tagline"
            hint="Shown under the headline on the landing page."
          >
            <input
              id="tagline"
              className="gb-input"
              value={form.tagline}
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
            />
          </Field>

          <Field
            label="Windows client download URL"
            htmlFor="downloadUrl"
            hint="Where the Download button points. Leave blank to hide it."
          >
            <input
              id="downloadUrl"
              type="url"
              className="gb-input"
              value={form.downloadUrl}
              onChange={(e) => setForm({ ...form, downloadUrl: e.target.value })}
              placeholder="https://github.com/…/GameBlade-Setup.exe"
            />
          </Field>

          <Field label="Client version" htmlFor="clientVersion">
            <input
              id="clientVersion"
              className="gb-input"
              value={form.clientVersion}
              onChange={(e) => setForm({ ...form, clientVersion: e.target.value })}
              placeholder="1.0.0"
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
        </section>

        <section className="gb-card space-y-4 p-5">
          <div className="flex items-center justify-between">
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

          <div className="flex flex-wrap gap-2">
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

          <Field
            label="IGDB client ID"
            htmlFor="igdbId"
            hint="Create a Twitch application at dev.twitch.tv to get these."
          >
            <input
              id="igdbId"
              className="gb-input"
              value={form.igdbClientId}
              onChange={(e) => setForm({ ...form, igdbClientId: e.target.value })}
              autoComplete="off"
            />
          </Field>

          <SecretField
            id="igdbSecret"
            label="IGDB client secret"
            isSet={settings?.igdbClientSecretSet ?? false}
            value={secrets.igdbClientSecret}
            onChange={(value) => setSecrets({ ...secrets, igdbClientSecret: value })}
          />

          <SecretField
            id="sgdbKey"
            label="SteamGridDB API key"
            isSet={settings?.steamGridDbKeySet ?? false}
            hint="Get one from your SteamGridDB account preferences."
            value={secrets.steamGridDbKey}
            onChange={(value) => setSecrets({ ...secrets, steamGridDbKey: value })}
          />

          <SecretField
            id="steamKey"
            label="Steam Web API key"
            isSet={settings?.steamApiKeySet ?? false}
            hint="Only used to read published achievement lists. No player data is requested."
            value={secrets.steamApiKey}
            onChange={(value) => setSecrets({ ...secrets, steamApiKey: value })}
          />
        </section>

        <button type="submit" className="gb-btn-primary" disabled={saveMutation.isPending}>
          {saveMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
          Save settings
        </button>
      </form>
    </div>
  );
}

function SecretField({
  id,
  label,
  isSet,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  isSet: boolean;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={isSet ? 'A value is saved. Leave blank to keep it.' : hint}
    >
      <input
        id={id}
        type="password"
        className="gb-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        placeholder={isSet ? '••••••••' : ''}
      />
    </Field>
  );
}
