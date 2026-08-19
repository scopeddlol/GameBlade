import {
  API_SCOPE_DESCRIPTIONS,
  API_SCOPES,
  type ApiKeyInfo,
  type ApiScope,
  type CreatedApiKey,
} from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, ShieldAlert, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, EmptyState, Field, FormError, PageLoader, Spinner } from '../../components/ui.js';
import { api, ApiRequestError } from '../../lib/api.js';

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '', label: 'Never' },
] as const;

/**
 * API keys for the external API.
 *
 * The plaintext token exists in exactly one response, so the screen is built
 * around that fact: a freshly minted key gets a panel of its own that will not
 * come back, rather than a row in a list the operator might assume they can
 * return to.
 */
export function AdminApiPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<string>('365');
  const [scopes, setScopes] = useState<ApiScope[]>(['users:read']);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const keysQuery = useQuery({
    queryKey: ['admin', 'api-keys'],
    queryFn: () => api.get<ApiKeyInfo[]>('/admin/api-keys'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'api-keys'] });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<CreatedApiKey>('/admin/api-keys', {
        name,
        scopes,
        expiresInDays: expiry === '' ? null : Number(expiry),
      }),
    onSuccess: (key) => {
      setError(null);
      setCreated(key);
      setCopied(false);
      setName('');
      void invalidate();
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not create the key.'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/api-keys/${id}/revoke`),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/api-keys/${id}`),
    onSuccess: invalidate,
  });

  const keys = keysQuery.data ?? [];

  const toggleScope = (scope: ApiScope) =>
    setScopes((current) =>
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope],
    );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
      <p className="text-ink-300 -mt-3 text-sm">
        Keys authenticate the external API at <code className="font-mono">/api/v1</code> — for
        provisioning accounts from another system, or reading stats. They are not accounts: a key
        cannot sign in to the desktop client.
      </p>

      <FormError message={error} />

      {created ? (
        <section className="space-y-3 rounded-xl border border-emerald-900/60 bg-emerald-950/30 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
            <KeyRound className="h-4 w-4" aria-hidden />
            Copy this key now
          </h2>
          <p className="text-ink-200 text-sm">
            This is the only time <strong>{created.name}</strong> will be shown. Only a digest is
            stored, so it cannot be recovered — if you lose it, delete the key and make another.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              className="gb-input font-mono text-xs"
              value={created.token}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="The new API key"
            />
            <button
              type="button"
              className="gb-btn-ghost shrink-0"
              onClick={() => {
                void navigator.clipboard.writeText(created.token).then(() => setCopied(true));
              }}
            >
              {copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button type="button" className="gb-btn-ghost" onClick={() => setCreated(null)}>
            Done
          </button>
        </section>
      ) : null}

      <form
        className="gb-card space-y-4 p-5"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          createMutation.mutate();
        }}
      >
        <h2 className="text-sm font-semibold tracking-wide uppercase">Create a key</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="keyName" hint="So you can recognise it later.">
            <input
              id="keyName"
              className="gb-input"
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Provisioning service"
              required
            />
          </Field>

          <Field label="Expires" htmlFor="keyExpiry">
            <select
              id="keyExpiry"
              className="gb-input"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="gb-label">Permissions</legend>
          {API_SCOPES.map((scope) => (
            <label key={scope} className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              <span>
                <code className="font-mono text-xs">{scope}</code>
                <span className="text-ink-400 block text-xs">{API_SCOPE_DESCRIPTIONS[scope]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {scopes.includes('users:admin') ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              <code className="font-mono">users:admin</code> lets this key create administrators and
              change existing ones. A provisioning integration almost never needs it.
            </span>
          </p>
        ) : null}

        <button
          type="submit"
          className="gb-btn-primary"
          disabled={createMutation.isPending || scopes.length === 0 || !name.trim()}
        >
          {createMutation.isPending ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <KeyRound className="h-4 w-4" aria-hidden />
          )}
          Create key
        </button>
      </form>

      {keysQuery.isLoading ? (
        <PageLoader label="Loading keys" />
      ) : keys.length === 0 ? (
        <EmptyState title="No keys yet" message="Create one above to start using the API." />
      ) : (
        <div className="divide-ink-700/70 gb-card divide-y">
          {keys.map((key) => (
            <div key={key.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {key.name}
                  {key.isValid ? null : (
                    <Badge tone="danger">{key.revokedAt ? 'Revoked' : 'Expired'}</Badge>
                  )}
                </p>
                <p className="text-ink-400 font-mono text-xs">{key.prefix}…</p>
                <p className="text-ink-400 mt-1 flex flex-wrap gap-1 text-xs">
                  {key.scopes.map((scope) => (
                    <span key={scope} className="bg-ink-800 rounded px-1.5 py-0.5 font-mono">
                      {scope}
                    </span>
                  ))}
                </p>
                <p className="text-ink-500 mt-1 text-xs">
                  {key.lastUsedAt
                    ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                    : 'Never used'}
                  {key.expiresAt
                    ? ` · Expires ${new Date(key.expiresAt).toLocaleDateString()}`
                    : ' · No expiry'}
                </p>
              </div>

              {key.isValid ? (
                <button
                  type="button"
                  className="gb-btn-ghost"
                  onClick={() => {
                    if (!confirm(`Revoke "${key.name}"? Anything using it stops working at once.`))
                      return;
                    revokeMutation.mutate(key.id);
                  }}
                >
                  Revoke
                </button>
              ) : null}
              <button
                type="button"
                className="gb-btn-danger"
                aria-label={`Delete ${key.name}`}
                onClick={() => {
                  if (!confirm(`Delete "${key.name}" entirely?`)) return;
                  deleteMutation.mutate(key.id);
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
