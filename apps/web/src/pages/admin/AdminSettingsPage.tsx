import type { ClientInstallerInfo, ServerSettings } from '@gameblade/shared';
import { MAX_INSTALLER_BYTES } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Field, FormError, Spinner, Notice, SectionSkeleton } from '../../components/ui.js';
import { api, ApiRequestError, queryString, uploadFile } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';

export function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    serverName: '',
    tagline: '',
    downloadUrl: '',
    clientVersion: '',
    igdbClientId: '',
    downloadSpeedLimitKbps: '0',
    monthlyQuotaMb: '0',
    meshEnabled: false,
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
    queryFn: () => api.get<ServerSettings>('/admin/settings'),
  });

  /**
   * Seeds the form from the server's answer.
   *
   * In an effect rather than inside `queryFn`, which is where it used to be:
   * react-query only calls the fetcher on a cache miss, so leaving this page
   * and coming back inside the stale window seeded nothing and left every box
   * blank — with a save from that state about to write the blanks back.
   *
   * Keyed on the query's own object, so it runs when the server's answer
   * changes and not on every keystroke; and each field keeps whatever is
   * already typed, so a refetch landing mid-edit does not overwrite it.
   */
  const settings = settingsQuery.data;
  useEffect(() => {
    if (!settings) return;
    setForm((current) => ({
      serverName: current.serverName || settings.serverName,
      tagline: current.tagline || settings.tagline,
      downloadUrl: current.downloadUrl || (settings.downloadUrl ?? ''),
      clientVersion: current.clientVersion || (settings.clientVersion ?? ''),
      igdbClientId: current.igdbClientId || (settings.igdbClientId ?? ''),
      downloadSpeedLimitKbps: String(settings.downloadSpeedLimitKbps ?? 0),
      monthlyQuotaMb: String(settings.monthlyQuotaMb ?? 0),
      meshEnabled: settings.meshEnabled ?? false,
    }));
  }, [settings]);

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
        downloadSpeedLimitKbps: Number(form.downloadSpeedLimitKbps) || 0,
        monthlyQuotaMb: Number(form.monthlyQuotaMb) || 0,
        meshEnabled: form.meshEnabled,
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

  if (settingsQuery.isLoading) return <SectionSkeleton rows={4} />;

  return (
    <div className="gb-page-narrow">
      <FormError message={error} />
      <Notice message={notice} />

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
            // It reads as a setting that does nothing because most of the time
            // it is overridden: the landing page's hero block has a
            // Subheadline field of its own, and anything typed there wins.
            hint="The line under the headline on the landing page, used whenever the hero block's own Subheadline is left blank. Appearance → Landing page sets that."
          >
            <input
              id="tagline"
              className="gb-input"
              value={form.tagline}
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
            />
          </Field>

          <InstallerField installer={settings?.installer ?? null} />

          <Field
            label="Windows client download URL"
            htmlFor="downloadUrl"
            hint={
              settings?.installer
                ? 'Ignored while an installer is uploaded above. Kept so clearing the upload restores it.'
                : 'Where the Download button points when no installer is uploaded. Leave blank to hide it.'
            }
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
          <h2 className="text-sm font-semibold tracking-wide uppercase">Bandwidth</h2>
          <p className="text-ink-400 -mt-2 text-xs">
            Both default to 0, which means no limit. Administrators are exempt from the allowance —
            they can change it at will, so enforcing one against them only risks locking you out of
            your own server.
          </p>

          <Field
            label="Download speed limit"
            htmlFor="speedLimit"
            hint="KB/s per download stream. A client opening several connections gets this much on each."
          >
            <input
              id="speedLimit"
              type="number"
              min={0}
              className="gb-input"
              value={form.downloadSpeedLimitKbps}
              onChange={(e) => setForm({ ...form, downloadSpeedLimitKbps: e.target.value })}
            />
          </Field>

          <Field
            label="Monthly allowance per account"
            htmlFor="monthlyQuota"
            hint="MB per calendar month, resetting on the 1st. Override it per account on the Users page."
          >
            <input
              id="monthlyQuota"
              type="number"
              min={0}
              className="gb-input"
              value={form.monthlyQuotaMb}
              onChange={(e) => setForm({ ...form, monthlyQuotaMb: e.target.value })}
            />
          </Field>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.meshEnabled}
              onChange={(e) => setForm({ ...form, meshEnabled: e.target.checked })}
            />
            <span>
              Deliver downloads from Nodes
              <span className="text-ink-400 block text-xs">
                The Coordinator requests verified chunks from a Node and streams them to the Desktop
                over HTTPS. Nodes only make outbound HTTPS connections and do not need an open
                inbound port. Enrol Nodes on the Nodes page.
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

/**
 * Uploads the Windows installer straight to the server, so an operator does not
 * have to host the build somewhere else and paste a link that will eventually
 * rot. The uploaded file takes precedence over the URL field below it.
 */
function InstallerField({ installer }: { installer: ClientInstallerInfo | null }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    await queryClient.invalidateQueries({ queryKey: ['public', 'info'] });
  };

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadFile<ClientInstallerInfo>(
        `/admin/client-installer${queryString({ fileName: file.name })}`,
        file,
        { onProgress: (fraction) => setProgress(fraction) },
      ),
    onSuccess: async () => {
      setError(null);
      setProgress(null);
      await refresh();
    },
    onError: (caught) => {
      setProgress(null);
      setError(caught instanceof ApiRequestError ? caught.message : 'The upload failed.');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete('/admin/client-installer'),
    onSuccess: refresh,
  });

  return (
    <Field
      label="Windows client installer"
      htmlFor="installerFile"
      hint={`Uploaded here and served from this server. Up to ${formatBytes(MAX_INSTALLER_BYTES)}.`}
    >
      {installer ? (
        <div className="bg-ink-800 mb-2 flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{installer.fileName}</p>
            <p className="text-ink-400 text-xs">
              {formatBytes(installer.sizeBytes)} · uploaded{' '}
              {new Date(installer.uploadedAt).toLocaleDateString()}
            </p>
          </div>
          <a className="gb-btn-ghost" href={installer.url}>
            Download
          </a>
          <button
            type="button"
            className="gb-btn-danger"
            disabled={remove.isPending}
            onClick={() => {
              if (
                !confirm(
                  'Remove the uploaded installer? The Download button falls back to the URL below.',
                )
              )
                return;
              remove.mutate();
            }}
          >
            {remove.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden />
            )}
            Remove
          </button>
        </div>
      ) : null}

      <input
        id="installerFile"
        ref={inputRef}
        type="file"
        className="gb-input"
        accept=".exe,.msi,.msix,.appinstaller,.zip"
        disabled={upload.isPending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setProgress(0);
          upload.mutate(file);
          // Clear the picker so choosing the same file twice re-uploads it.
          if (inputRef.current) inputRef.current.value = '';
        }}
      />

      {upload.isPending ? (
        <div className="mt-2">
          <div className="bg-ink-800 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-blade-500 h-full transition-[width]"
              style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
            />
          </div>
          <p className="text-ink-400 mt-1 text-xs">
            <Upload className="mr-1 inline h-3 w-3" aria-hidden />
            Uploading… {Math.round((progress ?? 0) * 100)}%
          </p>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
    </Field>
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
