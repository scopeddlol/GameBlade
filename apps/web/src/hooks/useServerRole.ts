import type { PublicServerInfo, ServerRole } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';

/**
 * What this deployment is: one machine, or the coordinator half of two.
 *
 * Read from the public info endpoint the app already fetches for its theme, on
 * the same query key, so this costs nothing beyond the request that was going
 * to happen anyway.
 *
 * Defaults to `standalone` while the request is in flight. That is the shape
 * GameBlade has always had and the one that shows the most, so the panel does
 * not flicker sections into existence — and the server refuses anything a role
 * should not be doing regardless of what the panel drew.
 */
export function useServerRole(): ServerRole {
  const info = useQuery({
    queryKey: ['public', 'info'],
    queryFn: () => api.get<PublicServerInfo>('/public/info'),
    staleTime: 60_000,
  });

  return info.data?.role ?? 'standalone';
}
