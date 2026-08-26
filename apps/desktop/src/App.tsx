import { type GameSummary, type NotificationInfo, type NotificationKind } from '@gameblade/shared';
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
  Bug,
  Download,
  ExternalLink,
  Gamepad2,
  Heart,
  Home,
  LibraryBig,
  Megaphone,
  MessageSquare,
  Settings,
  Sparkles,
  Square,
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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useClientButtons } from './components/GameContextMenu.js';
import { DownloadQueue } from './components/DownloadQueue.js';
import { FriendsRail } from './components/FriendsRail.js';
import { ProfileDrawer } from './components/ProfileDrawer.js';
import { TitleBar } from './components/TitleBar.js';
import { GameDetailPanel } from './components/GameDetail.js';
import { Avatar, Loading } from './components/ui.js';
import { useAutoSync } from './hooks/useAutoSync.js';
import { useUnreadMessages } from './hooks/useMessages.js';
import { ConnectivityProvider, useConnectivity } from './hooks/useConnectivity.js';
import { OfflineBanner } from './components/OfflineBanner.js';
import { RealtimeProvider, useRealtime } from './hooks/useRealtime.js';
import { SessionProvider, useSession } from './hooks/useSession.js';
import { useTheme } from './hooks/useTheme.js';
import { buttonIcon } from './lib/buttonIcons.js';
import { formatRelative } from './lib/format.js';
import { ipc, type DownloadState, type RunningGame } from './lib/ipc.js';
import { SignIn } from './SignIn.js';
import { HomeTab } from './tabs/HomeTab.js';
import { LibraryTab } from './tabs/LibraryTab.js';
import { SettingsTab } from './tabs/SettingsTab.js';
import { SocialTab } from './tabs/SocialTab.js';
import { StoreTab } from './tabs/StoreTab.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { MessagesTab } from './tabs/MessagesTab.js';
import { NewsTab } from './tabs/NewsTab.js';
import { RequestsTab } from './tabs/RequestsTab.js';
import { ReportBug } from './components/ReportBug.js';

/** Falls back to this whenever a notification has no custom icon of its own. */
const NOTIFICATION_ICONS: Record<NotificationKind, typeof Bell> = {
  'friend-request': UserPlus,
  'friend-accepted': UserCheck,
  'post-comment': MessageSquare,
  'post-reaction': Heart,
  achievement: Trophy,
  announcement: Megaphone,
  'bug-report': Bug,
};

const TABS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'library', label: 'Library', icon: LibraryBig },
  { id: 'store', label: 'Store', icon: Store },
  { id: 'requests', label: 'Requests', icon: Sparkles },
  { id: 'news', label: 'News', icon: Megaphone },
  { id: 'social', label: 'Social', icon: Users },
  { id: 'messages', label: 'Messages', icon: MessageSquare },
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
      // A minute. Tabs unmount when you leave them, so at fifteen seconds
      // every switch back re-asked the server for what it had just said —
      // and anything the app changes itself invalidates its own keys.
      staleTime: 60_000,
      // Ten minutes in cache after the last component stops using it, so
      // moving between tabs draws from what is already there instead of
      // starting from an empty screen each time.
      gcTime: 10 * 60_000,
    },
  },
});

/**
 * What each tab asks for the moment it opens.
 *
 * Pointing at a tab is a few hundred milliseconds of doing nothing, which is
 * most of what these requests cost — spending it means the tab usually has its
 * data by the time it renders. `prefetchQuery` is a no-op for anything already
 * cached and fresh, so running the pointer down the sidebar costs nothing.
 */
const TAB_PREFETCH: Partial<Record<TabId, { key: readonly unknown[]; path: string }[]>> = {
  home: [{ key: ['home'], path: '/home' }],
  // All three, because the tab renders all three and the shelves are the slow
  // one — asking for them only once the tab mounts is what made pressing
  // "Requests" show an empty page for a beat before anything appeared.
  requests: [
    { key: ['requests', 'digest'], path: '/requests/digest' },
    { key: ['requests', 'discover'], path: '/requests/discover' },
    { key: ['requests', 'list', ''], path: '/requests?sort=votes&limit=100' },
  ],
  news: [{ key: ['news'], path: '/feed?scope=everyone&kind=announcement&limit=50' }],
  social: [{ key: ['feed', 'friends'], path: '/feed?scope=friends&limit=30' }],
  messages: [{ key: ['messages', 'conversations'], path: '/messages/conversations' }],
};

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ConnectivityProvider>
          <RealtimeProvider>
            <Shell />
          </RealtimeProvider>
        </ConnectivityProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

function Shell() {
  const { session, isRestoring, setSession } = useSession();
  const [tab, setTab] = useState<TabId>('home');
  const [openGameId, setOpenGameId] = useState<string | null>(null);
  const [showDownloads, setShowDownloads] = useState(false);
  const [reportingBug, setReportingBug] = useState(false);
  const [downloads, setDownloads] = useState<DownloadState[]>([]);
  const [friendsCollapsed, setFriendsCollapsed] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);

  useTheme(Boolean(session));

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

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => ipc.getSettings(),
    enabled: Boolean(session),
  });

  // The half of "sync saves automatically" that never happened: pulling before
  // a launch was implemented, pushing afterwards was not.
  useAutoSync(settingsQuery.data, Boolean(session));

  // A game closing is what ends a session, so the chip in the title bar and
  // anything keyed on "is this running" have to hear about it immediately
  // rather than on the next twenty-second poll.
  useEffect(() => {
    if (!session) return;

    const unlisten = listen('play://ended', () => {
      void queryClient.invalidateQueries({ queryKey: ['running'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, [session]);

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

  /**
   * Remembers where each tab was scrolled to.
   *
   * One scroll container is reused for every tab, so without this switching
   * from halfway down the Library to the Store opened the Store already
   * scrolled — and coming back to the Library landed at the top, having lost
   * the place you were keeping.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTops = useRef<Partial<Record<TabId, number>>>({});
  const previousTab = useRef<TabId>(tab);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (previousTab.current !== tab) {
      // Before the browser paints, so the new tab is never seen at the old
      // tab's offset first.
      element.scrollTop = scrollTops.current[tab] ?? 0;
      previousTab.current = tab;
    }
  }, [tab]);

  const rememberScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element) scrollTops.current[previousTab.current] = element.scrollTop;
  }, []);

  /** Starts a tab's requests while the pointer is still travelling to it. */
  const prefetchTab = useCallback((next: TabId) => {
    for (const hint of TAB_PREFETCH[next] ?? []) {
      void queryClient.prefetchQuery({
        queryKey: [...hint.key],
        queryFn: () => ipc.get(hint.path),
        staleTime: 30_000,
      });
    }
  }, []);

  // The webview's built-in menu offers Reload and View Source, which are
  // meaningless in a packaged app and make it look like a browser. Suppressing
  // it here rather than per-component is what lets any surface opt back in by
  // calling preventDefault on its own handler — which is exactly what the
  // in-app menus do — while text inputs keep the native one for copy/paste.
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const editable =
        target?.closest('input, textarea, [contenteditable="true"]') !== null &&
        target?.closest('input, textarea, [contenteditable="true"]') !== undefined;
      if (!editable) event.preventDefault();
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

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
        onTab={(next) => {
          rememberScroll();
          setTab(next);
        }}
        onHoverTab={prefetchTab}
        downloadCount={activeDownloads.length}
        onDownloads={() => setShowDownloads(true)}
        onReportBug={() => setReportingBug(true)}
      />

      <div className="main">
        <TitleBar>
          <TopBar running={running} tab={tab} />
        </TitleBar>

        <UpdateBanner />
        <OfflineBanner />

        <div className="scroll" ref={scrollRef}>
          {/* Keyed on the tab so React remounts the wrapper and the enter
              animation actually replays; without the key the class is already
              on the element and the switch is a hard cut. */}
          <div key={tab} className="tab-enter">
            {tab === 'home' ? <HomeTab onOpenGame={openGame} onOpenGameId={setOpenGameId} /> : null}
            {tab === 'library' ? (
              <LibraryTab onOpenGame={openGame} installed={installed} running={running} />
            ) : null}
            {tab === 'store' ? (
              <StoreTab onOpenGame={openGame} onOpenGameId={setOpenGameId} />
            ) : null}
            {tab === 'requests' ? <RequestsTab onOpenGameId={setOpenGameId} /> : null}
            {tab === 'news' ? <NewsTab onOpenProfile={setProfileId} /> : null}
            {tab === 'social' ? <SocialTab onOpenProfile={setProfileId} /> : null}
            {tab === 'messages' ? <MessagesTab onOpenProfile={setProfileId} /> : null}
            {tab === 'settings' ? <SettingsTab /> : null}
          </div>
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

      {reportingBug ? (
        <ReportBug gameId={running?.gameId ?? null} onClose={() => setReportingBug(false)} />
      ) : null}

      {showDownloads ? (
        <DownloadQueue
          downloads={downloads}
          onClose={() => setShowDownloads(false)}
          onPause={(id) => void ipc.pauseDownload(id)}
          onResume={(id) => void ipc.startDownload(id)}
          // The row stays put: the Rust side reports the transfer stopping —
          // and, when asked, the space being freed — through the same progress
          // event as everything else.
          onCancel={(id, deleteFiles) => void ipc.cancelDownload(id, deleteFiles)}
          onClear={(id, deleteFiles) => {
            void ipc.clearDownload(id, deleteFiles);
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
  onHoverTab,
  downloadCount,
  onDownloads,
  onReportBug,
}: {
  tab: TabId;
  onTab: (tab: TabId) => void;
  onHoverTab: (tab: TabId) => void;
  downloadCount: number;
  onDownloads: () => void;
  onReportBug: () => void;
}) {
  const { session } = useSession();
  // Unread messages get a count on the sidebar, because the whole point of a
  // message is that somebody is waiting for an answer.
  const unreadMessages = useUnreadMessages(Boolean(session)).data ?? 0;

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
              onMouseEnter={() => onHoverTab(entry.id)}
              onFocus={() => onHoverTab(entry.id)}
              aria-current={tab === entry.id ? 'page' : undefined}
            >
              <entry.icon size={18} aria-hidden />
              <span>{entry.label}</span>
              {entry.id === 'messages' && unreadMessages > 0 ? (
                <span className="pill">{unreadMessages}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      <CustomButtons placement="sidebar" />

      <div className="sidebar-foot">
        {/* Reachable from every tab, because a bug is reported from wherever
            it happened rather than from a page someone has to go and find. */}
        <button type="button" className="nav-item" onClick={onReportBug}>
          <Bug size={18} aria-hidden />
          <span>Report a problem</span>
        </button>

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

/**
 * Operator-defined links, rendered wherever the admin put them.
 *
 * Nothing renders at all when none are configured, so a server that has not
 * set any up looks exactly as it did before the feature existed.
 */
function CustomButtons({ placement }: { placement: 'sidebar' | 'home' }) {
  const buttonsQuery = useClientButtons(placement);
  const buttons = buttonsQuery.data ?? [];
  if (buttons.length === 0) return null;

  return (
    <ul className={clsx('nav', 'custom-buttons', placement === 'home' && 'inline')}>
      {buttons.map((button) => (
        <li key={button.id}>
          <button
            type="button"
            className="nav-item"
            title={button.description ?? button.url}
            onClick={() => void ipc.openExternal(button.url)}
          >
            {buttonIcon(button.icon, 18) ?? <ExternalLink size={18} aria-hidden />}
            <span>{button.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TopBar({ running, tab }: { running: RunningGame | null; tab: TabId }) {
  const { connected } = useRealtime();
  const { online } = useConnectivity();
  const queryClient = useQueryClient();
  const wrapRef = useRef<HTMLDivElement>(null);

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

  // Changing tab is leaving what the panel was opened over, so it goes with it
  // rather than hanging above the new page until it is clicked away.
  useEffect(() => setOpen(false), [tab]);

  // The two ways any popover is expected to close. Bound only while it is
  // open, so the app is not listening on the document for nothing.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div className="topbar" data-tauri-drag-region>
      {running ? <PlayingChip running={running} /> : null}

      <span className="spacer" />

      <span
        className={clsx('conn', connected && online ? 'ok' : 'off')}
        title={!online ? 'The server is not reachable' : connected ? 'Connected' : 'Reconnecting…'}
      >
        {connected && online ? <Wifi size={14} aria-hidden /> : <WifiOff size={14} aria-hidden />}
      </span>

      <div className="notif-wrap" ref={wrapRef}>
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

/**
 * What is running, and the way to stop it.
 *
 * It used to be a label. That is fine right up until a game hangs behind a
 * fullscreen window, at which point the only thing the app could offer was the
 * observation that the game was running — which the player could see, and was
 * the problem. Hovering turns it into a Stop button; the process is asked to
 * close and killed if it will not, so a game that handles the request still
 * gets to save.
 */
function PlayingChip({ running }: { running: RunningGame }) {
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);

  return (
    <button
      type="button"
      className={clsx('playing-chip', stopping && 'is-stopping')}
      title={stopping ? 'Closing…' : `Stop ${running.title}`}
      disabled={stopping}
      onClick={() => {
        setStopping(true);
        void ipc
          .stopGame(running.gameId)
          .catch(() => undefined)
          .finally(() => {
            // The chip disappears when the watcher reports the exit; this only
            // covers a stop that failed outright, so the button comes back.
            void queryClient.invalidateQueries({ queryKey: ['running'] });
            setTimeout(() => setStopping(false), 4000);
          });
      }}
    >
      <Gamepad2 size={14} aria-hidden className="playing-chip-icon" />
      <Square size={13} aria-hidden className="playing-chip-stop" />
      <span className="playing-chip-label">
        {stopping ? `Closing ${running.title}…` : `Playing ${running.title}`}
      </span>
      <span className="playing-chip-action">Stop</span>
    </button>
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
