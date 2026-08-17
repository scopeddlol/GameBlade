import type { GameSummary, NotificationInfo } from '@gameblade/shared';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import clsx from 'clsx';
import {
  Bell,
  Download,
  Gamepad2,
  Home,
  LibraryBig,
  Settings,
  Store,
  Swords,
  Trophy,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DownloadQueue } from './components/DownloadQueue.js';
import { GameDetailPanel } from './components/GameDetail.js';
import { Avatar, Loading } from './components/ui.js';
import { RealtimeProvider, useRealtime } from './hooks/useRealtime.js';
import { SessionProvider, useSession } from './hooks/useSession.js';
import { ipc, type DownloadState, type RunningGame } from './lib/ipc.js';
import { SignIn } from './SignIn.js';
import { HomeTab } from './tabs/HomeTab.js';
import { LibraryTab } from './tabs/LibraryTab.js';
import { SettingsTab } from './tabs/SettingsTab.js';
import { SocialTab } from './tabs/SocialTab.js';
import { StoreTab } from './tabs/StoreTab.js';

const TABS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'library', label: 'Library', icon: LibraryBig },
  { id: 'store', label: 'Store', icon: Store },
  { id: 'social', label: 'Social', icon: Users },
  { id: 'settings', label: 'Settings', icon: Settings },
] as const;

type TabId = (typeof TABS)[number]['id'];

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A desktop app is expected to be current; refetching when the window
      // regains focus is what keeps a friends list from going stale on alt-tab.
      refetchOnWindowFocus: true,
      retry: 1,
      staleTime: 15_000,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RealtimeProvider>
          <Shell />
        </RealtimeProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

function Shell() {
  const { session, isRestoring, setSession } = useSession();
  const [tab, setTab] = useState<TabId>('home');
  const [openGameId, setOpenGameId] = useState<string | null>(null);
  const [showDownloads, setShowDownloads] = useState(false);
  const [downloads, setDownloads] = useState<DownloadState[]>([]);

  const installedQuery = useQuery({
    queryKey: ['installed'],
    queryFn: () => ipc.listInstalled(),
    enabled: Boolean(session),
  });

  const runningQuery = useQuery({
    queryKey: ['running'],
    queryFn: () => ipc.runningGame(),
    enabled: Boolean(session),
    // The Rust side pushes an event on exit, but a poll covers the case where
    // the app was reopened while a game was already running.
    refetchInterval: 20_000,
  });

  // Progress arrives from the Rust downloader as events rather than by polling.
  useEffect(() => {
    if (!session) return;

    void ipc.listDownloads().then(setDownloads);

    const unlisten = listen<DownloadState>('download://progress', (event) => {
      setDownloads((current) => {
        const next = current.filter((d) => d.game_id !== event.payload.game_id);
        next.push(event.payload);
        return next.sort((a, b) => a.title.localeCompare(b.title));
      });

      // A finished download becomes an installed game without the user having
      // to do anything, which is what makes install one click rather than two.
      if (event.payload.status === 'completed') {
        void ipc
          .finishInstall(event.payload.game_id, event.payload.title, event.payload.destination)
          .then(() => queryClient.invalidateQueries({ queryKey: ['installed'] }))
          .catch(() => undefined);
      }
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, [session]);

  const openGame = useCallback((game: GameSummary) => setOpenGameId(game.id), []);

  if (isRestoring) return <Loading label="Signing in" />;
  if (!session) return <SignIn onSignedIn={setSession} />;

  const installed = installedQuery.data ?? [];
  const running = runningQuery.data ?? null;
  const activeDownloads = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'verifying',
  );

  return (
    <div className="app">
      <Sidebar
        tab={tab}
        onTab={setTab}
        downloadCount={activeDownloads.length}
        onDownloads={() => setShowDownloads(true)}
      />

      <div className="main">
        <TopBar running={running} />

        <div className="scroll">
          {tab === 'home' ? <HomeTab onOpenGame={openGame} /> : null}
          {tab === 'library' ? (
            <LibraryTab onOpenGame={openGame} installed={installed} running={running} />
          ) : null}
          {tab === 'store' ? <StoreTab onOpenGame={openGame} /> : null}
          {tab === 'social' ? <SocialTab /> : null}
          {tab === 'settings' ? <SettingsTab /> : null}
        </div>
      </div>

      {openGameId ? (
        <GameDetailPanel
          gameId={openGameId}
          onClose={() => setOpenGameId(null)}
          installed={installed.find((game) => game.gameId === openGameId)}
          isRunning={running?.gameId === openGameId}
        />
      ) : null}

      {showDownloads ? (
        <DownloadQueue
          downloads={downloads}
          onClose={() => setShowDownloads(false)}
          onCancel={(id) => void ipc.cancelDownload(id)}
          onClear={(id) => {
            void ipc.clearDownload(id);
            setDownloads((current) => current.filter((d) => d.game_id !== id));
          }}
        />
      ) : null}

      <AchievementToast />
    </div>
  );
}

function Sidebar({
  tab,
  onTab,
  downloadCount,
  onDownloads,
}: {
  tab: TabId;
  onTab: (tab: TabId) => void;
  downloadCount: number;
  onDownloads: () => void;
}) {
  const { session } = useSession();

  return (
    <nav className="sidebar">
      <div className="brand">
        <Swords size={22} aria-hidden />
        <span>GameBlade</span>
      </div>

      <ul className="nav">
        {TABS.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={clsx('nav-item', tab === entry.id && 'active')}
              onClick={() => onTab(entry.id)}
              aria-current={tab === entry.id ? 'page' : undefined}
            >
              <entry.icon size={18} aria-hidden />
              <span>{entry.label}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar-foot">
        <button type="button" className="nav-item" onClick={onDownloads}>
          <Download size={18} aria-hidden />
          <span>Downloads</span>
          {downloadCount > 0 ? <span className="pill">{downloadCount}</span> : null}
        </button>

        <button type="button" className="nav-item user" onClick={() => onTab('settings')}>
          <Avatar url={null} name={session?.username ?? '?'} size={24} />
          <span>{session?.username}</span>
        </button>
      </div>
    </nav>
  );
}

function TopBar({ running }: { running: RunningGame | null }) {
  const { connected } = useRealtime();

  const notificationsQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      ipc.get<{ items: NotificationInfo[]; unreadCount: number }>('/notifications?limit=15'),
    refetchInterval: 60_000,
  });

  const [open, setOpen] = useState(false);
  const unread = notificationsQuery.data?.unreadCount ?? 0;

  return (
    <header className="topbar">
      {running ? (
        <span className="playing-chip">
          <Gamepad2 size={14} aria-hidden />
          Playing {running.title}
        </span>
      ) : null}

      <span className="spacer" />

      <span
        className={clsx('conn', connected ? 'ok' : 'off')}
        title={connected ? 'Connected' : 'Reconnecting…'}
      >
        {connected ? <Wifi size={14} aria-hidden /> : <WifiOff size={14} aria-hidden />}
      </span>

      <div className="notif-wrap">
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setOpen(!open);
            if (!open && unread > 0) void ipc.post('/notifications/read-all');
          }}
          aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        >
          <Bell size={17} aria-hidden />
          {unread > 0 ? <span className="dot-badge">{unread}</span> : null}
        </button>

        {open ? (
          <div className="notif-menu">
            {(notificationsQuery.data?.items ?? []).length === 0 ? (
              <p className="muted small">Nothing new.</p>
            ) : (
              (notificationsQuery.data?.items ?? []).map((notification) => (
                <div key={notification.id} className="notif">
                  <strong>{notification.title}</strong>
                  {notification.body ? (
                    <span className="muted small">{notification.body}</span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** Raised when the realtime socket reports an unlock, then fades on its own. */
function AchievementToast() {
  const { lastAchievement, dismissAchievement } = useRealtime();
  if (!lastAchievement) return null;

  return (
    <button type="button" className="toast" onClick={dismissAchievement}>
      <Trophy size={20} aria-hidden />
      <span>
        <strong>Achievement unlocked</strong>
        <span className="muted small">{lastAchievement.achievement.name}</span>
      </span>
    </button>
  );
}
