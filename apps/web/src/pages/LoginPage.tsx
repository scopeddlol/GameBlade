import type { SessionInfo } from '@gameblade/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
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
  const { user, isAdmin, status, refresh, isLoading } = useSession();
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
    // Playing happens in the desktop client either way, but a signed-in
    // visitor still has their own account to manage here.
    return (
      <Navigate
        to={from ?? (status?.role === 'node' ? '/' : isAdmin ? '/admin' : '/account')}
        replace
      />
    );
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
      navigate(
        from ??
          (status?.role === 'node' ? '/' : session.user.role === 'admin' ? '/admin' : '/account'),
        { replace: true },
      );
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title={status?.serverName ?? 'GameBlade'}
      subtitle="Sign in to your account"
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

      <DiscordSignIn />
    </AuthShell>
  );
}

/**
 * The other way in, for anyone who has linked an account.
 *
 * Hidden entirely unless Discord is configured *and* the visitor could
 * plausibly use it — a button that always fails is worse than no button. It
 * cannot create accounts: this server is invite-only, and the callback says so
 * rather than quietly making one.
 */
function DiscordSignIn() {
  const [error, setError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['auth', 'discord', 'status'],
    queryFn: () => api.get<{ configured: boolean }>('/auth/discord/status'),
    staleTime: 5 * 60_000,
  });

  const start = useMutation({
    mutationFn: () => api.get<{ url: string }>('/auth/discord/start?intent=signin'),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach Discord.'),
  });

  if (!statusQuery.data?.configured) return null;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className="bg-ink-700 h-px flex-1" />
        <span className="text-ink-500 text-xs">or</span>
        <span className="bg-ink-700 h-px flex-1" />
      </div>

      <FormError message={error} />

      <button
        type="button"
        className="gb-btn-ghost w-full"
        onClick={() => start.mutate()}
        disabled={start.isPending}
      >
        {start.isPending ? <Spinner className="h-4 w-4" /> : null}
        Sign in with Discord
      </button>
    </div>
  );
}
