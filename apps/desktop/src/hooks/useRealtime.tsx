import type { RealtimeEvent } from '@gameblade/shared';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ipc } from '../lib/ipc.js';
import { useAchievementCheck } from './useAchievementCheck.js';

interface RealtimeContextValue {
  connected: boolean;
  /** The most recent unlock, so the UI can raise a toast for it. */
  lastAchievement: Extract<RealtimeEvent, { type: 'achievement' }> | null;
  dismissAchievement: () => void;
}

/** How long a drop must persist before the UI admits to being disconnected. */
const DISCONNECT_GRACE_MS = 6000;

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  lastAchievement: null,
  dismissAchievement: () => {},
});

/**
 * Bridges the Rust socket to React Query.
 *
 * Rather than threading every event into component state, an incoming frame
 * invalidates the queries it affects and lets the normal fetch path refill
 * them. That keeps one source of truth for each screen and means a dropped
 * socket degrades to slightly stale data instead of a wrong UI.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const checkAchievements = useAchievementCheck();
  const [connected, setConnected] = useState(false);
  const [lastAchievement, setLastAchievement] = useState<Extract<
    RealtimeEvent,
    { type: 'achievement' }
  > | null>(null);

  useEffect(() => {
    // A reconnect takes a couple of seconds at most, and the socket carries
    // nothing the UI cannot also fetch over REST. Showing "reconnecting" the
    // instant a frame drops just makes the indicator flicker, so a short grace
    // period has to elapse before the user is told anything is wrong.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const markConnected = () => {
      clearTimeout(graceTimer);
      setConnected(true);
    };

    const markDisconnected = () => {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => setConnected(false), DISCONNECT_GRACE_MS);
    };

    /*
     * Asked once on mount, because the connection is *announced* by an event
     * and an event fires once. Registering a listener is itself a round trip
     * through the IPC bridge, so a socket that connects quickly — the normal
     * case — opens before anything is listening, the frame is gone for good,
     * and the app reads as disconnected for the entire time it is connected.
     * That is what the yellow crossed-out icon was.
     */
    void ipc
      .realtimeConnected()
      .then((open) => {
        if (open) markConnected();
      })
      .catch(() => undefined);

    const unlisteners: Array<Promise<() => void>> = [
      listen('realtime://connected', markConnected),
      listen('realtime://disconnected', markDisconnected),

      listen<RealtimeEvent>('realtime://event', (event) => {
        const frame = event.payload;
        switch (frame.type) {
          case 'presence':
            void queryClient.invalidateQueries({ queryKey: ['friends'] });
            void queryClient.invalidateQueries({ queryKey: ['home'] });
            break;
          case 'activity':
            void queryClient.invalidateQueries({ queryKey: ['home'] });
            void queryClient.invalidateQueries({ queryKey: ['activity'] });
            break;
          case 'notification':
            void queryClient.invalidateQueries({ queryKey: ['notifications'] });
            break;
          case 'friend-request':
            void queryClient.invalidateQueries({ queryKey: ['friends'] });
            void queryClient.invalidateQueries({ queryKey: ['notifications'] });
            break;
          case 'achievement':
            setLastAchievement(frame);
            void queryClient.invalidateQueries({ queryKey: ['achievements'] });
            break;
          // Refreshes the thread rather than splicing the frame in, so one
          // source of truth draws the list however the message arrived.
          case 'message':
            void queryClient.invalidateQueries({
              queryKey: ['messages', 'thread', frame.message.conversationId],
            });
            void queryClient.invalidateQueries({ queryKey: ['messages', 'conversations'] });
            void queryClient.invalidateQueries({ queryKey: ['messages', 'unread'] });
            break;
          case 'message-removed':
            void queryClient.invalidateQueries({
              queryKey: ['messages', 'thread', frame.conversationId],
            });
            break;
          case 'conversation':
            void queryClient.invalidateQueries({ queryKey: ['messages', 'conversations'] });
            break;
          default:
            break;
        }
      }),

      // A finished session changes playtime everywhere it is displayed.
      listen<{ gameId?: string }>('play://ended', (event) => {
        void queryClient.invalidateQueries({ queryKey: ['home'] });
        void queryClient.invalidateQueries({ queryKey: ['games'] });
        void queryClient.invalidateQueries({ queryKey: ['running'] });

        // The one moment the game's own files are finished being written.
        const gameId = event.payload?.gameId;
        if (gameId) void checkAchievements(gameId);
      }),
    ];

    return () => {
      clearTimeout(graceTimer);
      for (const pending of unlisteners) {
        void pending.then((off) => off());
      }
    };
  }, [queryClient, checkAchievements]);

  // An unlock toast should not linger; six seconds is long enough to read.
  useEffect(() => {
    if (!lastAchievement) return;
    const timer = setTimeout(() => setLastAchievement(null), 6000);
    return () => clearTimeout(timer);
  }, [lastAchievement]);

  const value = useMemo(
    () => ({
      connected,
      lastAchievement,
      dismissAchievement: () => setLastAchievement(null),
    }),
    [connected, lastAchievement],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}
