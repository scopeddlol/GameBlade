import type { SessionInfo } from '@gameblade/shared';
import { Swords } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Field, FormError, Spinner } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { api, ApiRequestError, setCsrfToken } from '../lib/api.js';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Swords className="text-blade-400 h-9 w-9" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="text-ink-300 text-sm">{subtitle}</p> : null}
        </div>
        <div className="gb-card p-6">{children}</div>
        {footer ? <div className="text-ink-400 mt-4 text-center text-sm">{footer}</div> : null}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { user, status, refresh, isLoading } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isLoading && status?.needsSetup) {
    return <Navigate to="/setup" replace />;
  }
  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await api.post<SessionInfo>('/auth/login', { username, password });
      setCsrfToken(session.csrfToken);
      await refresh();
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/', { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title={status?.serverName ?? 'GameBlade'}
      subtitle="Sign in to browse the library"
      footer={
        status?.allowSelfRegistration ? (
          <>
            Need an account?{' '}
            <Link to="/register" className="text-blade-400 hover:underline">
              Register
            </Link>
          </>
        ) : (
          'This server is invite-only.'
        )
      }
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
        <Field label="Password" htmlFor="password">
          <input
            id="password"
            type="password"
            className="gb-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <button type="submit" className="gb-btn-primary w-full" disabled={submitting}>
          {submitting ? <Spinner className="h-4 w-4" /> : null}
          Sign in
        </button>
      </form>
    </AuthShell>
  );
}
