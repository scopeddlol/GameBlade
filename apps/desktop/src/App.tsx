import type { GameSummary, Paginated } from '@gameblade/shared';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignIn } from './SignIn.js';
import { GameTile } from './components/GameTile.js';
import { DownloadQueue } from './components/DownloadQueue.js';
import { ipc, type DownloadState, type SessionInfo } from './lib/ipc.js';

type Tab = 'library' | 'downloads';

export function App() {
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('library');
  const [games, setGames] = useState<GameSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadState[]>([]);

  // Restore the saved device token, then confirm the server still accepts it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await ipc.currentSession();
      if (cancelled) return;
      if (!restored) {
        setSession(null);
        return;
      }
      try {
        await ipc.verifySession();
        if (!cancelled) setSession(restored);
      } catch {
        // Token revoked or server unreachable — fall back to the sign-in screen.
        if (!cancelled) setSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Progress arrives from the Rust downloader as events rather than polling.
  useEffect(() => {
    const unlisten = listen<DownloadState>('download://progress', (event) => {
      setDownloads((current) => {
        const next = current.filter((d) => d.game_id !== event.payload.game_id);
        next.push(event.payload);
        return next.sort((a, b) => a.title.localeCompare(b.title));
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    void ipc.listDownloads().then(setDownloads);
  }, [session]);

  const loadGames = useCallback(
    async (term: string) => {
      if (!session) return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '120', sort: 'title', order: 'asc' });
        if (term.trim()) params.set('search', term.trim());
        const page: Paginated<GameSummary> = await ipc.fetchGames(`?${params.toString()}`);
        setGames(page.items);
        setTotal(page.total);
      } catch (caught) {
        setError(String(caught));
      } finally {
        setLoading(false);
      }
    },
    [session],
  );

  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => void loadGames(search), 300);
    return () => clearTimeout(timer);
  }, [session, search, loadGames]);

  const handleDownload = async (game: GameSummary) => {
    const destination = await open({
      directory: true,
      multiple: false,
      title: `Where should "${game.title}" be saved?`,
    });
    if (typeof destination !== 'string') return;

    try {
      await ipc.startDownload(game.id, destination);
      setTab('downloads');
    } catch (caught) {
      setError(String(caught));
    }
  };

  const handleSignOut = async () => {
    await ipc.signOut();
    setSession(null);
    setGames([]);
    setDownloads([]);
  };

  const activeCount = useMemo(
    () => downloads.filter((d) => d.status === 'downloading' || d.status === 'queued').length,
    [downloads],
  );

  if (session === undefined) {
    return (
      <div className="signin">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (session === null) {
    return <SignIn onSignedIn={(info) => setSession(info)} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <SwordIcon />
          <span>GameBlade</span>
        </div>

        <nav className="tabs" style={{ border: 'none', margin: 0 }}>
          <button
            type="button"
            className={tab === 'library' ? 'tab active' : 'tab'}
            onClick={() => setTab('library')}
          >
            Library
          </button>
          <button
            type="button"
            className={tab === 'downloads' ? 'tab active' : 'tab'}
            onClick={() => setTab('downloads')}
          >
            Downloads{activeCount > 0 ? ` (${activeCount})` : ''}
          </button>
        </nav>

        <div className="spacer" />

        {tab === 'library' ? (
          <input
            className="input"
            style={{ width: 220 }}
            type="search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        ) : null}

        <span className="muted">{session.username}</span>
        <button type="button" className="btn btn-ghost" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <main className="content">
        {error ? <div className="error">{error}</div> : null}

        {tab === 'library' ? (
          loading && games.length === 0 ? (
            <p className="muted">Loading library…</p>
          ) : games.length === 0 ? (
            <div className="empty">
              <p>{search ? 'No games match that search.' : 'This library is empty.'}</p>
            </div>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                {total} {total === 1 ? 'game' : 'games'}
              </p>
              <div className="grid">
                {games.map((game) => (
                  <GameTile key={game.id} game={game} onDownload={handleDownload} />
                ))}
              </div>
            </>
          )
        ) : (
          <DownloadQueue
            downloads={downloads}
            onCancel={(id) => void ipc.cancelDownload(id)}
            onClear={(id) => {
              void ipc.clearDownload(id);
              setDownloads((current) => current.filter((d) => d.game_id !== id));
            }}
          />
        )}
      </main>
    </div>
  );
}

function SwordIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
      <path d="M13 19l6-6M16 16l4 4M19 21l2-2" />
    </svg>
  );
}
