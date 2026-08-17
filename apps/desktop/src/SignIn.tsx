import { Swords } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ErrorNote, Spinner } from './components/ui.js';
import { errorMessage, ipc, type SessionInfo } from './lib/ipc.js';

export function SignIn({ onSignedIn }: { onSignedIn: (session: SessionInfo) => void }) {
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await ipc.signIn(serverUrl, username, password);
      const session = await ipc.currentSession();
      if (session) onSignedIn(session);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <Swords size={34} aria-hidden />
          <h1>GameBlade</h1>
          <p className="muted small">Sign in to your server</p>
        </div>

        <form className="card" onSubmit={handleSubmit}>
          <ErrorNote message={error} />

          <label className="field">
            <span>Server address</span>
            <input
              className="input"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="games.example.com"
              autoFocus
              required
            />
            <span className="muted small">
              https:// is assumed unless you type http:// yourself.
            </span>
          </label>

          <label className="field">
            <span>Username</span>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>
            This device gets its own token, revocable from Settings without affecting your other
            machines.
          </p>
        </form>
      </div>
    </div>
  );
}
