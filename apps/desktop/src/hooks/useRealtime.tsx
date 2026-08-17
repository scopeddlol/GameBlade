import type { RealtimeEvent } from '@gameblade/shared';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface RealtimeContextValue {
  connected: boolean;
  /** The most recent unlock, so the UI can raise a toast for it. */
  lastAchievement: Extract<RealtimeEvent, { type: 'achievement' }> | null;
  dismissAchievement: () => void;
}

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
  const [connected, setConnected] = useState(false);
  const [lastAchievement, setLastAchievement] = useState<Extract<
    RealtimeEvent,
    { type: 'achievement' }
  > | null>(null);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      listen('realtime://connected', () => setConnected(true)),
      listen('realtime://disconnected', () => setConnected(false)),

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
          default:
            break;
        }
      }),

      // A finished session changes playtime everywhere it is displayed.
      listen('play://ended', () => {
        void queryClient.invalidateQueries({ queryKey: ['home'] });
        void queryClient.invalidateQueries({ queryKey: ['games'] });
        void queryClient.invalidateQueries({ queryKey: ['running'] });
      }),
    ];

    return () => {
      for (const pending of unlisteners) {
        void pending.then((off) => off());
      }
    };
  }, [queryClient]);

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
