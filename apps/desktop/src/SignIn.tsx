import { useState, type FormEvent } from 'react';
import { ipc, type SessionInfo } from './lib/ipc.js';

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
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <h1 style={{ textAlign: 'center', fontSize: 22, marginBottom: 4 }}>GameBlade</h1>
        <p className="muted" style={{ textAlign: 'center', marginTop: 0, marginBottom: 20 }}>
          Sign in to your server
        </p>

        <form className="card" onSubmit={handleSubmit}>
          {error ? <div className="error">{error}</div> : null}

          <div className="field">
            <label className="label" htmlFor="server">
              Server address
            </label>
            <input
              id="server"
              className="input"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="games.example.com"
              autoFocus
              required
            />
            <p className="tile-sub" style={{ marginTop: 6 }}>
              https:// is assumed unless you type http://
            </p>
          </div>

          <div className="field">
            <label className="label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={busy}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="tile-sub" style={{ marginTop: 12, textAlign: 'center' }}>
            This device is registered separately and can be revoked from the web UI.
          </p>
        </form>
      </div>
    </div>
  );
}
