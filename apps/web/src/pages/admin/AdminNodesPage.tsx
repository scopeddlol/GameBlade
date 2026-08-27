import type { MeshNodeInfo, MeshNodeRole } from '@gameblade/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Field, RowSkeleton } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';

interface EnrolmentInfo {
  label: string;
  role: MeshNodeRole;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  nodeId: string | null;
}

interface NodesResponse {
  nodes: MeshNodeInfo[];
  enrolments: EnrolmentInfo[];
}

/** What the operator sees next to each node's name. */
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  online: 'success',
  stale: 'warning',
  blocked: 'danger',
  pending: 'neutral',
};

export function AdminNodesPage() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<'origin' | 'mirror'>('mirror');
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['admin', 'mesh'],
    queryFn: () => api.get<NodesResponse>('/mesh/nodes'),
    // Nodes go stale on a 90-second timer; a page that only refreshed on
    // navigation would show a machine as online long after it stopped.
    refetchInterval: 15_000,
  });

  const enrolMutation = useMutation({
    mutationFn: () => api.post<{ token: string }>('/mesh/enrolments', { label, role }),
    onSuccess: (result) => {
      // Shown once and never again: only its hash is stored.
      setIssued(result.token);
      setLabel('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'mesh'] });
    },
  });

  const statusMutation = useMutation({
    mutationFn: (input: { nodeId: string; status: 'online' | 'blocked' }) =>
      api.post(`/mesh/nodes/${input.nodeId}/status`, { status: input.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'mesh'] }),
  });

  const removeMutation = useMutation({
    mutationFn: (nodeId: string) => api.delete(`/mesh/nodes/${nodeId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'mesh'] }),
  });

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the code stays on screen to copy by hand.
      setCopied(false);
    }
  };

  const nodes = nodesQuery.data?.nodes ?? [];

  return (
    <div className="gb-page">
      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">Enrol a node</h2>
        <p className="text-ink-400 mb-4 text-xs">
          A node is a machine that holds game files and serves them straight to clients, so those
          bytes never cross this server. Run the agent on it and give it this code; it registers
          itself, and the code is spent the moment it does.
        </p>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            enrolMutation.mutate();
          }}
        >
          <Field label="Name" htmlFor="nodeLabel">
            <input
              id="nodeLabel"
              className="gb-input w-64"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Home archive"
              required
            />
          </Field>
          <Field label="Role" htmlFor="nodeRole">
            <select
              id="nodeRole"
              className="gb-input w-auto"
              value={role}
              onChange={(e) => setRole(e.target.value as 'origin' | 'mirror')}
            >
              <option value="mirror">Mirror</option>
              <option value="origin">Origin</option>
            </select>
          </Field>
          <button type="submit" className="gb-btn" disabled={enrolMutation.isPending}>
            Generate code
          </button>
        </form>

        {issued ? (
          <div className="bg-ink-800 mt-4 rounded-lg p-3">
            <p className="text-ink-400 mb-2 text-xs">
              Copy this now — it is stored only as a hash, so it cannot be shown again. It expires
              in 24 hours if unused.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-sm break-all">{issued}</code>
              <button type="button" className="gb-btn-ghost" onClick={() => void copy(issued)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Nodes</h2>

        {nodesQuery.isLoading ? <RowSkeleton rows={3} /> : null}

        {!nodesQuery.isLoading && nodes.length === 0 ? (
          <p className="text-ink-400 text-sm">
            No nodes yet. Until one is enrolled and holding a game, every download comes from this
            server.
          </p>
        ) : null}

        <div className="space-y-3">
          {nodes.map((node) => (
            <div key={node.id} className="bg-ink-800 rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{node.label}</span>
                  <Badge tone={STATUS_TONE[node.status] ?? 'neutral'}>{node.status}</Badge>
                  <Badge tone="neutral">{node.role}</Badge>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="gb-btn-ghost text-xs"
                    onClick={() =>
                      statusMutation.mutate({
                        nodeId: node.id,
                        status: node.status === 'blocked' ? 'online' : 'blocked',
                      })
                    }
                  >
                    {node.status === 'blocked' ? 'Unblock' : 'Block'}
                  </button>
                  <button
                    type="button"
                    className="gb-btn-ghost text-xs"
                    onClick={() => removeMutation.mutate(node.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>

              <dl className="text-ink-400 mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                <div>
                  <dt className="inline">Games held: </dt>
                  <dd className="text-ink-200 inline">{node.gameCount}</dd>
                </div>
                <div>
                  <dt className="inline">Served: </dt>
                  <dd className="text-ink-200 inline">{formatBytes(node.bytesServed)}</dd>
                </div>
                <div>
                  <dt className="inline">Last seen: </dt>
                  <dd className="text-ink-200 inline">
                    {node.lastSeenAt ? formatDateTime(node.lastSeenAt) : 'never'}
                  </dd>
                </div>
                <div>
                  <dt className="inline">Addresses: </dt>
                  <dd className="text-ink-200 inline">{node.endpoints.length}</dd>
                </div>
              </dl>

              {node.endpoints.length > 0 ? (
                <p className="text-ink-500 mt-2 font-mono text-[11px] break-all">
                  {node.endpoints.map((e) => `${e.address}:${e.port}`).join('  ')}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="gb-card p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide uppercase">Enrolment codes</h2>
        <div className="space-y-2">
          {(nodesQuery.data?.enrolments ?? []).map((enrolment) => (
            <div
              key={`${enrolment.label}-${enrolment.createdAt}`}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span>{enrolment.label}</span>
              <span className="text-ink-400 text-xs">
                {enrolment.usedAt
                  ? `used ${formatDateTime(enrolment.usedAt)}`
                  : `expires ${formatDateTime(enrolment.expiresAt)}`}
              </span>
            </div>
          ))}
          {(nodesQuery.data?.enrolments ?? []).length === 0 ? (
            <p className="text-ink-400 text-sm">No codes have been generated.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
