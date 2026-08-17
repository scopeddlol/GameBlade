import { registerSchema, type SessionInfo } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Field, FormError, Spinner } from '../components/ui.js';
import { useSession } from '../hooks/useSession.js';
import { api, ApiRequestError, setCsrfToken } from '../lib/api.js';
import { AuthShell } from './LoginPage.js';

export function RegisterPage() {
  const { user, status, refresh } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [inviteCode, setInviteCode] = useState(searchParams.get('invite') ?? '');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fromUrl = searchParams.get('invite');
    if (fromUrl) setInviteCode(fromUrl);
  }, [searchParams]);

  // Check the invite up front so a bad link fails before the form is filled in.
  const inviteQuery = useQuery({
    queryKey: ['invite', inviteCode],
    queryFn: () => api.get<{ valid: boolean; role: string | null }>(`/auth/invite/${inviteCode}`),
    enabled: inviteCode.trim().length > 0,
    retry: false,
  });

  if (user) return <Navigate to="/" replace />;

  const inviteRequired = !status?.allowSelfRegistration;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    const parsed = registerSchema.safeParse({
      username,
      password,
      email: email || undefined,
      inviteCode: inviteCode || undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details above.');
      return;
    }

    setSubmitting(true);
    try {
      const session = await api.post<SessionInfo>('/auth/register', {
        username,
        password,
        email: email || undefined,
        inviteCode: inviteCode || undefined,
      });
      setCsrfToken(session.csrfToken);
      await refresh();
      // A new account has nothing to do on the web. The landing page is where
      // the Windows client download lives, which is the actual next step.
      navigate(session.user.role === 'admin' ? '/admin' : '/', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  };

  const inviteInvalid =
    inviteCode.trim().length > 0 && inviteQuery.isFetched && inviteQuery.data?.valid === false;

  return (
    <AuthShell
      title="Create your account"
      subtitle={inviteRequired ? 'An invite code is required on this server' : undefined}
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-blade-400 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormError message={error} />
        {inviteInvalid ? (
          <FormError message="That invite code is not valid, has expired, or has already been used." />
        ) : null}

        <Field
          label={inviteRequired ? 'Invite code' : 'Invite code (optional)'}
          htmlFor="invite"
          hint={inviteQuery.data?.valid ? 'Invite accepted.' : undefined}
        >
          <input
            id="invite"
            className="gb-input font-mono tracking-wider uppercase"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            required={inviteRequired}
          />
        </Field>

        <Field label="Username" htmlFor="username">
          <input
            id="username"
            className="gb-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>

        <Field label="Email (optional)" htmlFor="email">
          <input
            id="email"
            type="email"
            className="gb-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
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

        <button
          type="submit"
          className="gb-btn-primary w-full"
          disabled={submitting || inviteInvalid}
        >
          {submitting ? <Spinner className="h-4 w-4" /> : null}
          Create account
        </button>
      </form>
    </AuthShell>
  );
}
