import type { PublicUser, SessionInfo } from '@gameblade/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { api, ApiRequestError, setCsrfToken } from '../lib/api.js';

export interface ServerStatus {
  serverName: string;
  needsSetup: boolean;
  allowSelfRegistration: boolean;
}

interface SessionContextValue {
  user: PublicUser | null;
  status: ServerStatus | null;
  isLoading: boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => api.get<ServerStatus>('/auth/status'),
    staleTime: 30_000,
  });

  const sessionQuery = useQuery({
    queryKey: ['auth', 'session'],
    queryFn: async () => {
      try {
        const session = await api.get<SessionInfo>('/auth/session', {
          allowUnauthorized: true,
        });
        setCsrfToken(session.csrfToken);
        return session;
      } catch (error) {
        // Being signed out is a normal state, not a failure to retry.
        if (error instanceof ApiRequestError && error.isUnauthorized) {
          setCsrfToken('');
          return null;
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['auth'] });
  }, [queryClient]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrfToken('');
      // Drop every cached query so no other user's data lingers in memory.
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
    }
  }, [queryClient]);

  const value = useMemo<SessionContextValue>(
    () => ({
      user: sessionQuery.data?.user ?? null,
      status: statusQuery.data ?? null,
      isLoading: sessionQuery.isLoading || statusQuery.isLoading,
      isAdmin: sessionQuery.data?.user.role === 'admin',
      refresh,
      signOut,
    }),
    [sessionQuery.data, sessionQuery.isLoading, statusQuery.data, statusQuery.isLoading, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}
