import type { MeshAnalytics, MeshNodeStats } from '@gameblade/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

/**
 * The requests every page in the Nodes section shares.
 *
 * One place so the four tabs agree about the refresh cadence and, more to the
 * point, so moving between them costs nothing: the query keys match, so the
 * fleet list a tab already fetched is what the next tab renders from while its
 * own request is in flight.
 */

export interface EnrolmentInfo {
  tokenHash: string;
  label: string;
  role: 'origin' | 'mirror' | 'peer';
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  nodeId: string | null;
}

export interface NodesResponse {
  nodes: MeshNodeStats[];
  enrolments: EnrolmentInfo[];
}

export interface LibraryOption {
  id: string;
  name: string;
}

/** What the operator sees next to each node's name. */
export const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  online: 'success',
  stale: 'warning',
  blocked: 'danger',
  pending: 'neutral',
};

export function useMeshNodes() {
  return useQuery({
    queryKey: ['admin', 'mesh'],
    queryFn: () => api.get<NodesResponse>('/mesh/nodes'),
    // Nodes go stale on a 90-second timer; a page that only refreshed on
    // navigation would show a machine as online long after it stopped.
    refetchInterval: 15_000,
  });
}

export function useMeshAnalytics(days: number) {
  return useQuery({
    queryKey: ['admin', 'mesh', 'analytics', days],
    queryFn: () => api.get<MeshAnalytics>(`/mesh/analytics?days=${days}`),
    // Aggregates over days; a minute of staleness is invisible and the query
    // touches every transfer row in the window.
    refetchInterval: 60_000,
  });
}
