import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Field, FormError, Spinner } from '../components/ui.js';
import { api, ApiRequestError } from '../lib/api.js';
import { AuthShell } from './LoginPage.js';

/**
 * Where an admin-issued reset link lands.
 *
 * Deliberately unauthenticated: whoever is here is somebody who cannot sign
 * in, and the token in the URL is the whole credential.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const resetMutation = useMutation({
    mutationFn: () => api.post('/auth/reset-password', { token, newPassword: password }),
    onSuccess: () => {
      setDone(true);
      setError(null);
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not reset that password.',
      ),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('Those passwords do not match');
      return;
    }
    setError(null);
    resetMutation.mutate();
  };

  if (!token) {
    return (
      <AuthShell title="Reset password" subtitle="That link is incomplete.">
        <FormError message="This link is missing its token. Ask an administrator for a new one." />
        <div className="mt-4 text-center">
          <Link to="/login" className="gb-btn-ghost">
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Password changed" subtitle="You can sign in with it now.">
        <p className="text-ink-300 text-sm">
          Every other session and device signed into this account has been signed out.
        </p>
        <div className="mt-4">
          <Link to="/login" className="gb-btn-primary w-full">
            Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset password" subtitle="Choose a new password for your account.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password" htmlFor="new-password">
          <input
            id="new-password"
            type="password"
            className="gb-input"
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm-password">
          <input
            id="confirm-password"
            type="password"
            className="gb-input"
            value={confirm}
            autoComplete="new-password"
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </Field>
        {error ? <FormError message={error} /> : null}
        <button type="submit" className="gb-btn-primary w-full" disabled={resetMutation.isPending}>
          {resetMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
          Set new password
        </button>
      </form>
    </AuthShell>
  );
}
