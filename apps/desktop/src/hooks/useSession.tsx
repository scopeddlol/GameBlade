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
import { forgetMessageSecrets } from './useMessages.js';
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

  /**
   * Restore the saved device token, then confirm the server still accepts it.
   *
   * The confirmation can fail two ways and they are not the same thing. A
   * revoked device is the server saying no, and belongs at the sign-in screen.
   * An unreachable server is not saying anything — and treating that as a
   * rejection is exactly why the whole client was unusable offline: the check
   * failed, the app fell back to sign-in, and sign-in could not reach the
   * server either. The Rust side now answers a network failure with the stored
   * session rather than an error, so this only lands in the failure branch
   * when the token is genuinely gone.
   */
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
    // And every conversation key held in memory. The Rust side destroys this
    // device's message identity at the same moment, so leaving the opened keys
    // in a JavaScript map would be the one copy of them left anywhere.
    forgetMessageSecrets();
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
