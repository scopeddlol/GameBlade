import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ipc, type SessionInfo } from '../lib/ipc.js';

interface SessionContextValue {
  session: SessionInfo | null;
  /** Undefined while the stored token is still being checked. */
  isRestoring: boolean;
  isAdmin: boolean;
  setSession: (session: SessionInfo) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSessionState] = useState<SessionInfo | null | undefined>(undefined);

  // Restore the saved device token, then confirm the server still accepts it.
  useEffect(() => {
    let canceled = false;

    void (async () => {
      const restored = await ipc.currentSession().catch(() => null);
      if (canceled) return;
      if (!restored) {
        setSessionState(null);
        return;
      }
      try {
        await ipc.verifySession();
        if (!canceled) setSessionState(restored);
      } catch {
        // Token revoked or server unreachable — fall back to the sign-in screen.
        if (!canceled) setSessionState(null);
      }
    })();

    return () => {
      canceled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    await ipc.signOut().catch(() => undefined);
    setSessionState(null);
    // Drop every cached query so nothing from the previous account lingers.
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session: session ?? null,
      isRestoring: session === undefined,
      isAdmin: session?.role === 'admin',
      setSession: setSessionState,
      signOut,
    }),
    [session, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}
