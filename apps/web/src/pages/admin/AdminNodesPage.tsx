import type { MeshNodeStats } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, HardDrive, Radio, ShieldOff, Trash2 } from 'lucide-react';
import { StatTile } from '../../components/charts.js';
import { Badge, RowSkeleton } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { formatBytes, formatDateTime, formatRelative } from '../../lib/format.js';
import { STATUS_TONE, useMeshAnalytics, useMeshNodes, type LibraryOption } from './meshData.js';

/**
 * The fleet: every machine holding game files, and how it is doing.
 *
 * This used to be a tab inside Settings, next to Discord credentials and API
 * keys, which put "is my archive being served" in the drawer you open once
 * during setup. It is a section of its own now because it is the thing an
 * operator checks — a node that quietly stopped reporting is a catalog that
 * quietly stopped being downloadable, and nothing else on the panel says so.
 */
export function AdminNodesPage() {
  const queryClient = useQueryClient();
  const nodesQuery = useMeshNodes();
  const analyticsQuery = useMeshAnalytics(14);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'mesh'] });

  const statusMutation = useMutation({
    mutationFn: (input: { nodeId: string; status: 'online' | 'blocked' }) =>
      api.post(`/mesh/nodes/${input.nodeId}/status`, { status: input.status }),
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: (nodeId: string) => api.delete(`/mesh/nodes/${nodeId}`),
    onSuccess: invalidate,
  });

  const libraryMutation = useMutation({
    mutationFn: (input: { nodeId: string; libraryId: string | null }) =>
      api.post(`/mesh/nodes/${input.nodeId}/library`, { libraryId: input.libraryId }),
    onSuccess: invalidate,
  });

  const librariesQuery = useQuery({
    queryKey: ['admin', 'libraries'],
    queryFn: () => api.get<LibraryOption[]>('/admin/libraries'),
  });

  const nodes = nodesQuery.data?.nodes ?? [];
  const summary = analyticsQuery.data;

  return (
    <div className="gb-page">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Online"
          value={`${summary?.nodes.online ?? 0} of ${summary?.nodes.total ?? 0}`}
          hint={
            summary && summary.nodes.stale > 0 ? `${summary.nodes.stale} stale` : 'nodes enrolled'
          }
        />
        <StatTile
          label="Served by nodes"
          value={formatBytes(summary?.bytes.mesh7d ?? 0)}
          hint="last 7 days"
        />
        <StatTile
          label="Kept off this server"
          value={`${Math.round((summary?.bytes.meshShare ?? 0) * 100)}%`}
          hint="of delivered bytes"
        />
        <StatTile
          label="Games with no node"
          value={(summary?.coverage.uncovered ?? 0).toLocaleString('en')}
          hint="every download costs this server"
        />
      </div>

      {summary && summary.coverage.uncovered > 0 && summary.nodes.total > 0 ? (
        <p className="flex items-start gap-2 text-sm text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {summary.coverage.uncovered.toLocaleString('en')} games are not held by any online node,
            so every download of one comes from this server. That is usually games whose files a
            node has not finished hashing — start the pass from the node&rsquo;s own page.
          </span>
        </p>
      ) : null}

      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Nodes</h2>

        {nodesQuery.isLoading ? <RowSkeleton rows={3} /> : null}

        {!nodesQuery.isLoading && nodes.length === 0 ? (
          <p className="text-ink-400 text-sm">
            No nodes yet. Until one is enrolled and holding a game, every download comes from this
            server. Generate a code on the <strong>Enrolment</strong> tab, then open the
            node&rsquo;s own page and paste it in.
          </p>
        ) : null}

        <div className="space-y-3">
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              libraries={librariesQuery.data ?? []}
              onLibrary={(libraryId) => libraryMutation.mutate({ nodeId: node.id, libraryId })}
              onToggleBlock={() =>
                statusMutation.mutate({
                  nodeId: node.id,
                  status: node.status === 'blocked' ? 'online' : 'blocked',
                })
              }
              onRemove={() => {
                if (
                  confirm(
                    `Remove "${node.label}"? Its games stay in the catalog and stop being offered ` +
                      'from this machine. The node re-enrols with a new code.',
                  )
                ) {
                  removeMutation.mutate(node.id);
                }
              }}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * One node, with the numbers that explain it rather than just describe it.
 *
 * The pairing that matters is "games held" against "games in its library": a
 * node announcing four hundred of two thousand games is working perfectly and
 * still not serving most of the archive, because the rest are not hashed yet.
 * Two counts next to each other say that; either one alone does not.
 */
function NodeCard({
  node,
  libraries,
  onLibrary,
  onToggleBlock,
  onRemove,
}: {
  node: MeshNodeStats;
  libraries: LibraryOption[];
  onLibrary: (libraryId: string | null) => void;
  onToggleBlock: () => void;
  onRemove: () => void;
}) {
  const coverage = node.libraryGames > 0 ? node.gameCount / node.libraryGames : 0;

  return (
    <div className="bg-ink-800 rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{node.label}</span>
          <Badge tone={STATUS_TONE[node.status] ?? 'neutral'}>{node.status}</Badge>
          <Badge tone="neutral">{node.role}</Badge>
          {node.activeTransfers > 0 ? (
            <span className="text-blade-300 flex items-center gap-1 text-xs">
              <Radio className="h-3.5 w-3.5" aria-hidden />
              {node.activeTransfers} live
            </span>
          ) : null}
          {node.ownerUsername ? (
            <span className="text-ink-500 text-xs">{node.ownerUsername}&rsquo;s client</span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button type="button" className="gb-btn-ghost text-xs" onClick={onToggleBlock}>
            <ShieldOff className="h-3.5 w-3.5" aria-hidden />
            {node.status === 'blocked' ? 'Unblock' : 'Block'}
          </button>
          <button type="button" className="gb-btn-ghost text-xs" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Remove
          </button>
        </div>
      </div>

      <dl className="text-ink-400 mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
        <Stat label="Offering">
          {node.gameCount.toLocaleString('en')}
          {node.libraryGames > 0 ? (
            <span className="text-ink-500"> of {node.libraryGames.toLocaleString('en')}</span>
          ) : null}
        </Stat>
        <Stat label="Served, all time">{formatBytes(node.bytesServed)}</Stat>
        <Stat label="Served, 24h">{formatBytes(node.bytesServed24h)}</Stat>
        <Stat label="Served, 7d">{formatBytes(node.bytesServed7d)}</Stat>
        <Stat label="Players, 7d">{node.players7d.toLocaleString('en')}</Stat>
        <Stat label="Transfers, 24h">{node.transfers24h.toLocaleString('en')}</Stat>
        <Stat label="Last seen">{node.lastSeenAt ? formatRelative(node.lastSeenAt) : 'never'}</Stat>
        <Stat label="Agent">{node.agentVersion ?? 'unknown'}</Stat>
      </dl>

      {node.libraryGames > 0 ? (
        <div className="mt-3">
          <div className="bg-ink-900 h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-blade-500 h-full rounded-full"
              style={{ width: `${Math.min(100, Math.round(coverage * 100))}%` }}
            />
          </div>
          <p className="text-ink-500 mt-1 text-[11px]">
            {Math.round(coverage * 100)}% of this library is hashed and being offered. The rest
            cannot be served over the mesh until the node has read it —{' '}
            {node.servableGames.toLocaleString('en')} games are hashed on this coordinator.
          </p>
        </div>
      ) : null}

      <div className="mt-3">
        <label className="text-ink-400 block text-xs" htmlFor={`lib-${node.id}`}>
          Reports its catalog into
        </label>
        <select
          id={`lib-${node.id}`}
          className="gb-input mt-1 w-auto text-sm"
          value={node.libraryId ?? ''}
          onChange={(e) => onLibrary(e.target.value || null)}
        >
          <option value="">Not assigned — reports refused</option>
          {libraries.map((library) => (
            <option key={library.id} value={library.id}>
              {library.name}
            </option>
          ))}
        </select>
        <p className="text-ink-500 mt-1 text-[11px]">
          Pick the library these games are <em>already</em> in. Games are matched by folder path, so
          reporting into the existing library updates those entries and every game keeps its
          achievements, save rules and artwork. Pointing a node at a different library would add the
          whole catalog again as new games.
        </p>
        {node.catalogStatus ? (
          <p className="text-ink-500 mt-1 text-[11px]">
            Last report: {node.catalogStatus}
            {node.catalogReportedAt ? ` · ${formatDateTime(node.catalogReportedAt)}` : ''}
          </p>
        ) : null}
      </div>

      {node.endpoints.length > 0 ? (
        <p className="text-ink-500 mt-2 flex items-start gap-1.5 font-mono text-[11px] break-all">
          <HardDrive className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {node.endpoints.map((e) => `${e.address}:${e.port}`).join('  ')}
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-ink-200 tabular-nums">{children}</dd>
    </div>
  );
}
