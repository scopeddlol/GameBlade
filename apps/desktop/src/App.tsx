import type { GameSummary, NotificationInfo, NotificationKind } from '@gameblade/shared';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import clsx from 'clsx';
import {
  Bell,
  Download,
  Gamepad2,
  Heart,
  Home,
  LibraryBig,
  Megaphone,
  MessageSquare,
  Settings,
  Store,
  Swords,
  Trophy,
  UserCheck,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DownloadQueue } from './components/DownloadQueue.js';
import { FriendsRail } from './components/FriendsRail.js';
import { ProfileDrawer } from './components/ProfileDrawer.js';
import { TitleBar } from './components/TitleBar.js';
import { GameDetailPanel } from './components/GameDetail.js';
import { Avatar, Loading } from './components/ui.js';
import { RealtimeProvider, useRealtime } from './hooks/useRealtime.js';
import { SessionProvider, useSession } from './hooks/useSession.js';
import { formatRelative } from './lib/format.js';
import { ipc, type DownloadState, type RunningGame } from './lib/ipc.js';
import { SignIn } from './SignIn.js';
import { HomeTab } from './tabs/HomeTab.js';
import { LibraryTab } from './tabs/LibraryTab.js';
import { SettingsTab } from './tabs/SettingsTab.js';
import { SocialTab } from './tabs/SocialTab.js';
import { StoreTab } from './tabs/StoreTab.js';

/** Falls back to this whenever a notification has no custom icon of its own. */
const NOTIFICATION_ICONS: Record<NotificationKind, typeof Bell> = {
  'friend-request': UserPlus,
  'friend-accepted': UserCheck,
  'post-comment': MessageSquare,
  'post-reaction': Heart,
  achievement: Trophy,
  announcement: Megaphone,
};

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
  const [friendsCollapsed, setFriendsCollapsed] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);

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
          .catch((error: unknown) => {
            // A silently swallowed failure here (a corrupt archive, a full
            // disk, a permissions error) used to leave the download entry
            // sitting at "Completed" forever with the game never actually
            // installed and nothing telling the user why. Surfacing it
            // through the same download entry reuses the queue's existing
            // failed-state UI instead of adding a new one.
            setDownloads((current) =>
              current.map((d) =>
                d.game_id === event.payload.game_id
                  ? {
                      ...d,
                      status: 'failed',
                      error: error instanceof Error ? error.message : 'Could not finish installing',
                    }
                  : d,
              ),
            );
          });
      }
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, [session]);

  const openGame = useCallback((game: GameSummary) => setOpenGameId(game.id), []);

  if (isRestoring) {
    return (
      <div className="app frameless">
        <TitleBar />
        <Loading label="Signing in" />
      </div>
    );
  }
  if (!session) {
    return (
      <div className="app frameless">
        <TitleBar />
        <SignIn onSignedIn={setSession} />
      </div>
    );
  }

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
        <TitleBar>
          <TopBar running={running} />
        </TitleBar>

        <div className="scroll">
          {tab === 'home' ? <HomeTab onOpenGame={openGame} /> : null}
          {tab === 'library' ? (
            <LibraryTab onOpenGame={openGame} installed={installed} running={running} />
          ) : null}
          {tab === 'store' ? <StoreTab onOpenGame={openGame} /> : null}
          {tab === 'social' ? <SocialTab onOpenProfile={setProfileId} /> : null}
          {tab === 'settings' ? <SettingsTab /> : null}
        </div>
      </div>

      {tab === 'settings' ? null : (
        <FriendsRail
          collapsed={friendsCollapsed}
          onToggle={() => setFriendsCollapsed((current) => !current)}
          onOpenSocial={() => setTab('social')}
          onOpenProfile={setProfileId}
        />
      )}

      {profileId ? <ProfileDrawer userId={profileId} onClose={() => setProfileId(null)} /> : null}

      {openGameId ? (
        <GameDetailPanel
          gameId={openGameId}
          onClose={() => setOpenGameId(null)}
          installed={installed.find((game) => game.gameId === openGameId)}
          isRunning={running?.gameId === openGameId}
          download={downloads.find((d) => d.game_id === openGameId)}
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
      <div className="brand" data-tauri-drag-region>
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
  const queryClient = useQueryClient();

  const notificationsQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      ipc.get<{ items: NotificationInfo[]; unreadCount: number }>('/notifications?limit=15'),
    refetchInterval: 60_000,
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => ipc.del(`/notifications/${id}`),
    // The list is short and this is a background clean-up action, not
    // something that needs its own error UI — a failed dismiss just leaves
    // the card there for next time.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const [open, setOpen] = useState(false);
  const unread = notificationsQuery.data?.unreadCount ?? 0;
  const items = notificationsQuery.data?.items ?? [];

  return (
    <div className="topbar" data-tauri-drag-region>
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
            {items.length === 0 ? (
              <p className="muted small">Nothing new.</p>
            ) : (
              items.map((notification) => {
                // Read-all just fired above, but this render still holds the
                // pre-read snapshot until the next refetch — which is exactly
                // what lets "was unread when I opened this" stay visible for
                // the one glance the user actually gets at it.
                const wasUnread = !notification.readAt;
                const KindIcon = NOTIFICATION_ICONS[notification.kind];
                return (
                  <div key={notification.id} className={clsx('notif', wasUnread && 'unread')}>
                    <div className="notif-icon" aria-hidden>
                      {notification.icon ?? <KindIcon size={15} />}
                    </div>
                    <div className="notif-body">
                      <strong>{notification.title}</strong>
                      {notification.body ? (
                        <span className="muted small">{notification.body}</span>
                      ) : null}
                      <span className="muted small">{formatRelative(notification.createdAt)}</span>
                    </div>
                    <button
                      type="button"
                      className="icon-btn small-icon-btn"
                      onClick={() => dismissMutation.mutate(notification.id)}
                      aria-label={`Dismiss ${notification.title}`}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
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
