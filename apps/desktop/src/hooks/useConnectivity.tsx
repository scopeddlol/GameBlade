import { listen } from '@tauri-apps/api/event';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ipc } from '../lib/ipc.js';

interface ConnectivityValue {
  /** Whether the server answered the last time anything asked it. */
  online: boolean;
  /** When this machine last had a full answer from the server, if ever. */
  lastSeenAt: Date | null;
  /** True while a deliberate re-check is in flight. */
  checking: boolean;
  /** Ask the server whether it is back. Resolves to what it found. */
  recheck: () => Promise<boolean>;
}

const ConnectivityContext = createContext<ConnectivityValue | null>(null);

/**
 * Whether the server is reachable, as one answer for the whole app.
 *
 * Deliberately not a heartbeat. The client finds out the same way the person
 * using it does — by something failing — and the Rust side raises an event when
 * that answer changes rather than on every request, so a page making six calls
 * does not flicker a banner six times. The only outbound probe in the whole
 * feature is behind the "try again" button, because an app that has decided it
 * is offline otherwise has no way back to online until the next click fails.
 */
export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [lastSeenAt, setLastSeenAt] = useState<Date | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void ipc
      .connectivity()
      .then((state) => {
        setOnline(state.online);
        setLastSeenAt(state.cachedAtMs ? new Date(state.cachedAtMs) : null);
      })
      .catch(() => undefined);

    const offListeners = [
      listen('net://online', () => {
        setOnline(true);
        setLastSeenAt(new Date());
      }),
      listen('net://offline', () => setOnline(false)),
    ];

    return () => {
      for (const off of offListeners) void off.then((stop) => stop());
    };
  }, []);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const reachable = await ipc.recheckConnection().catch(() => false);
      setOnline(reachable);
      if (reachable) setLastSeenAt(new Date());
      return reachable;
    } finally {
      setChecking(false);
    }
  }, []);

  const value = useMemo<ConnectivityValue>(
    () => ({ online, lastSeenAt, checking, recheck }),
    [online, lastSeenAt, checking, recheck],
  );

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): ConnectivityValue {
  const context = useContext(ConnectivityContext);
  if (!context) throw new Error('useConnectivity must be used inside a ConnectivityProvider');
  return context;
}
