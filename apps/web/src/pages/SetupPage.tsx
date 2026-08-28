import { registerSchema, type SessionInfo } from '@gameblade/shared';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Field, FormError, Spinner } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { api, ApiRequestError, setCsrfToken } from '../lib/api.js';
import { AuthShell } from './LoginPage.js';

/**
 * First-run screen. The server only accepts this while no accounts exist, so it
 * cannot be used to mint an extra administrator later.
 */
export function SetupPage() {
  const { status, refresh, isLoading } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isLoading && status && !status.needsSetup) {
    return <Navigate to="/login" replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    // Validate locally first so the rules are shown before a round trip.
    const parsed = registerSchema.omit({ inviteCode: true }).safeParse({ username, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details above.');
      return;
    }

    setSubmitting(true);
    try {
      const session = await api.post<SessionInfo>('/auth/setup', { username, password });
      setCsrfToken(session.csrfToken);
      await refresh();
      navigate(status?.role === 'node' ? '/' : '/admin', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Welcome to GameBlade"
      subtitle="Create the administrator account to get started"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormError message={error} />
        <Field label="Username" htmlFor="username">
          <input
            id="username"
            className="gb-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters.">
          <input
            id="password"
            type="password"
            className="gb-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <input
            id="confirm"
            type="password"
            className="gb-input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <button type="submit" className="gb-btn-primary w-full" disabled={submitting}>
          {submitting ? <Spinner className="h-4 w-4" /> : null}
          Create administrator
        </button>
      </form>
    </AuthShell>
  );
}
