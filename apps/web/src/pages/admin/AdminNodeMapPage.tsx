import type { MeshTunnel, MeshTunnelMap } from '@gameblade/shared';
import { Pause, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, SectionSkeleton } from '../../components/ui.js';
import { formatBytes, formatRelative } from '../../lib/format.js';
import { useMeshTunnels } from './meshData.js';

/**
 * Every connection the coordinator currently believes is open, drawn.
 *
 * A table of transfers answers "how much"; it does not answer the question an
 * operator actually has about a mesh, which is *shape*: is this traffic going
 * straight from a node to a player, or is it doubling back through the
 * coordinator because nobody can punch a hole to that machine? Those two are a
 * row apart in a table and unmistakable on a diagram — a relayed tunnel is
 * drawn through the middle, so a fleet that has quietly fallen back to the
 * relay looks like a fleet that has quietly fallen back to the relay.
 *
 * Everything here is the coordinator's belief rather than a measurement. A
 * direct transfer never touches this machine, so what is known about it is what
 * the node last said on its heartbeat — up to half a minute ago. The page says
 * that rather than implying it is watching the wire.
 */
export function AdminNodeMapPage() {
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState<'all' | 'transferring' | 'relay'>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const mapQuery = useMeshTunnels(live);
  const map = mapQuery.data;

  const tunnels = useMemo(() => {
    const all = map?.tunnels ?? [];
    if (filter === 'transferring') return all.filter((t) => t.state === 'transferring');
    if (filter === 'relay') return all.filter((t) => t.via === 'relay');
    return all;
  }, [map, filter]);

  if (!map) return <SectionSkeleton rows={4} />;

  const relayed = map.tunnels.filter((tunnel) => tunnel.via === 'relay').length;
  const moving = map.tunnels.filter((tunnel) => tunnel.state === 'transferring').length;
  const throughput = map.tunnels.reduce((sum, tunnel) => sum + (tunnel.bytesPerSecond ?? 0), 0);
  const chosen = map.tunnels.find((tunnel) => tunnel.id === selected) ?? null;

  return (
    <div className="gb-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={moving > 0 ? 'success' : 'neutral'}>
            {moving} moving of {map.tunnels.length}
          </Badge>
          <Badge tone={relayed > 0 ? 'warning' : 'neutral'}>{relayed} relayed</Badge>
          <span className="text-ink-400 text-xs tabular-nums">
            {formatBytes(throughput)}/s across the mesh
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {(['all', 'transferring', 'relay'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={option === filter ? 'gb-btn text-xs' : 'gb-btn-ghost text-xs'}
              onClick={() => setFilter(option)}
            >
              {option === 'all' ? 'Everything' : option === 'transferring' ? 'Moving' : 'Relayed'}
            </button>
          ))}
          {/* Pausing matters more here than anywhere else on the panel: the
              map redraws every few seconds, and reading one tunnel's detail
              while the thing under the pointer keeps moving is impossible. */}
          <button type="button" className="gb-btn-ghost text-xs" onClick={() => setLive(!live)}>
            {live ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {live ? 'Pause' : 'Resume'}
          </button>
        </div>
      </div>

      <section className="gb-card overflow-hidden p-0">
        <TunnelDiagram
          map={map}
          tunnels={tunnels}
          selected={selected}
          onSelect={(id) => setSelected((current) => (current === id ? null : id))}
        />
      </section>

      {chosen ? <TunnelDetail tunnel={chosen} /> : null}

      <section className="gb-card p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide uppercase">Open tunnels</h2>
        <p className="text-ink-400 mb-3 text-xs">
          A tunnel appears the moment permission to fetch is issued and stays until nothing has been
          heard about it for five minutes. Last updated {formatRelative(map.generatedAt)}.
        </p>
        <TunnelTable tunnels={tunnels} selected={selected} onSelect={setSelected} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ layout */

const VIEW = { width: 920, height: 580 };
const CENTRE = { x: VIEW.width / 2, y: VIEW.height / 2 };
const NODE_RING = 168;
const CLIENT_RING = 252;

interface Placed {
  x: number;
  y: number;
}

function onCircle(angleDegrees: number, radius: number): Placed {
  const radians = (angleDegrees * Math.PI) / 180;
  return {
    x: CENTRE.x + Math.cos(radians) * radius * 1.28,
    y: CENTRE.y + Math.sin(radians) * radius,
  };
}

/**
 * The diagram itself: coordinator in the middle, nodes around it, players
 * outside.
 *
 * A ring rather than a free layout because the positions have to be stable —
 * this redraws every few seconds, and a node that moves between frames is a
 * node nobody can point at. Order comes from the node list, which is ordered by
 * enrolment, so a machine stays where it was as long as the fleet does.
 *
 * The ellipse is deliberate: a circle wastes the width of a landscape screen
 * and pushes the labels into each other.
 */
function TunnelDiagram({
  map,
  tunnels,
  selected,
  onSelect,
}: {
  map: MeshTunnelMap;
  tunnels: MeshTunnel[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const nodes = map.nodes;

  const nodeAt = new Map<string, Placed>();
  nodes.forEach((node, index) => {
    const angle = -90 + (index * 360) / Math.max(1, nodes.length);
    nodeAt.set(node.id, onCircle(angle, NODE_RING));
  });

  // Clients fan out around the node they are pulling from, so a node serving
  // six players reads as six lines from one place rather than a knot.
  const perNode = new Map<string, MeshTunnel[]>();
  for (const tunnel of tunnels) {
    perNode.set(tunnel.nodeId, [...(perNode.get(tunnel.nodeId) ?? []), tunnel]);
  }

  const clientAt = new Map<string, Placed>();
  for (const [nodeId, group] of perNode) {
    const index = nodes.findIndex((node) => node.id === nodeId);
    if (index < 0) continue;
    const base = -90 + (index * 360) / Math.max(1, nodes.length);
    const spread = Math.min(34, 360 / Math.max(1, nodes.length) / 2);

    group.forEach((tunnel, position) => {
      const offset = group.length === 1 ? 0 : (position / (group.length - 1) - 0.5) * spread * 2;
      clientAt.set(tunnel.id, onCircle(base + offset, CLIENT_RING));
    });
  }

  if (nodes.length === 0) {
    return (
      <p className="text-ink-400 p-10 text-center text-sm">
        No nodes are enrolled, so there is nothing to draw. Every download currently comes from this
        server.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <style>{`
        @keyframes gb-flow { to { stroke-dashoffset: -24; } }
        .gb-tunnel-flow { animation: gb-flow 1s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .gb-tunnel-flow { animation: none; } }
      `}</style>

      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        className="h-auto w-full min-w-[720px]"
        role="img"
        aria-label={`${tunnels.length} tunnels between ${nodes.length} nodes and their players`}
      >
        <defs>
          <radialGradient id="gb-core">
            <stop offset="0%" stopColor="rgba(43,183,245,0.35)" />
            <stop offset="100%" stopColor="rgba(43,183,245,0)" />
          </radialGradient>
        </defs>

        {/* Rings first, as the faintest thing on the diagram: they are scaffolding
            for reading distance from the centre, not data. */}
        <ellipse
          cx={CENTRE.x}
          cy={CENTRE.y}
          rx={NODE_RING * 1.28}
          ry={NODE_RING}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
        />
        <ellipse
          cx={CENTRE.x}
          cy={CENTRE.y}
          rx={CLIENT_RING * 1.28}
          ry={CLIENT_RING}
          fill="none"
          stroke="rgba(255,255,255,0.04)"
          strokeDasharray="3 6"
        />

        {tunnels.map((tunnel) => {
          const node = nodeAt.get(tunnel.nodeId);
          const client = clientAt.get(tunnel.id);
          if (!node || !client) return null;

          const isSelected = selected === tunnel.id;
          const relayed = tunnel.via === 'relay';
          const moving = tunnel.state === 'transferring';

          // A relayed tunnel is drawn *through* the coordinator, because that is
          // exactly what it does: the bytes cross this machine. A direct one
          // bows outward, away from the centre, so the two can never be
          // confused at a glance.
          const path = relayed
            ? `M ${client.x} ${client.y} Q ${CENTRE.x} ${CENTRE.y} ${node.x} ${node.y}`
            : `M ${client.x} ${client.y} Q ${
                (client.x + node.x) / 2 + (client.x - CENTRE.x) * 0.18
              } ${(client.y + node.y) / 2 + (client.y - CENTRE.y) * 0.18} ${node.x} ${node.y}`;

          const stroke = relayed
            ? 'var(--color-amber-400, #fbbf24)'
            : moving
              ? 'var(--color-blade-400, #38bdf8)'
              : 'rgba(148,163,184,0.55)';

          return (
            <g key={tunnel.id} onClick={() => onSelect(tunnel.id)} className="cursor-pointer">
              {/* A wide invisible copy underneath: a 2px line is not something
                  anybody can reliably put a pointer on. */}
              <path d={path} stroke="transparent" strokeWidth={14} fill="none" />
              <path
                d={path}
                stroke={stroke}
                strokeWidth={isSelected ? 3.5 : moving ? 2.2 : 1.2}
                strokeOpacity={isSelected ? 1 : 0.85}
                fill="none"
                strokeDasharray={moving ? '6 6' : undefined}
                className={moving ? 'gb-tunnel-flow' : undefined}
              />
              <circle
                cx={client.x}
                cy={client.y}
                r={isSelected ? 7 : 5}
                fill={
                  relayed ? 'var(--color-amber-400, #fbbf24)' : 'var(--color-blade-400, #38bdf8)'
                }
                fillOpacity={moving ? 1 : 0.5}
              />
              <title>
                {`${tunnel.username ?? 'someone'} · ${tunnel.gameTitle ?? 'a game'} · ${
                  relayed ? 'relayed' : 'direct'
                } · ${formatBytes(tunnel.bytesServed)}`}
              </title>
            </g>
          );
        })}

        {/* The coordinator. Drawn after the tunnels so relayed ones pass behind
            it rather than over the label. */}
        <circle cx={CENTRE.x} cy={CENTRE.y} r={64} fill="url(#gb-core)" />
        <circle
          cx={CENTRE.x}
          cy={CENTRE.y}
          r={26}
          fill="rgb(15,23,42)"
          stroke="var(--color-blade-400, #38bdf8)"
          strokeWidth={2}
        />
        <text
          x={CENTRE.x}
          y={CENTRE.y + 46}
          textAnchor="middle"
          className="fill-ink-200"
          fontSize={13}
          fontWeight={600}
        >
          {map.coordinator.label}
        </text>
        <text
          x={CENTRE.x}
          y={CENTRE.y + 62}
          textAnchor="middle"
          className="fill-ink-500"
          fontSize={11}
        >
          {map.coordinator.relay ? `relay ${map.coordinator.relay}` : 'no relay configured'}
        </text>

        {nodes.map((node) => {
          const at = nodeAt.get(node.id);
          if (!at) return null;
          const online = node.status === 'online';
          const busy = (perNode.get(node.id) ?? []).length;

          return (
            <g key={node.id}>
              <rect
                x={at.x - 13}
                y={at.y - 13}
                width={26}
                height={26}
                rx={7}
                fill="rgb(15,23,42)"
                stroke={
                  node.status === 'blocked'
                    ? 'var(--color-red-400, #f87171)'
                    : online
                      ? 'var(--color-emerald-400, #34d399)'
                      : 'var(--color-amber-400, #fbbf24)'
                }
                strokeWidth={2}
              />
              {busy > 0 ? (
                <text
                  x={at.x}
                  y={at.y + 4}
                  textAnchor="middle"
                  className="fill-ink-100"
                  fontSize={11}
                  fontWeight={600}
                >
                  {busy}
                </text>
              ) : null}
              <text
                x={at.x}
                y={at.y - 22}
                textAnchor="middle"
                className="fill-ink-200"
                fontSize={12}
                fontWeight={600}
              >
                {node.label}
              </text>
              <text
                x={at.x}
                y={at.y + 32}
                textAnchor="middle"
                className="fill-ink-500"
                fontSize={10}
              >
                {node.gameCount.toLocaleString('en')} games
              </text>
              <title>
                {`${node.label} · ${node.status} · ${formatBytes(node.bytesServed)} served${
                  node.address ? ` · ${node.address}` : ''
                }`}
              </title>
            </g>
          );
        })}
      </svg>

      <Legend />
    </div>
  );
}

/**
 * What the marks mean.
 *
 * Not optional decoration: the difference between a direct and a relayed tunnel
 * is the single most important thing on the diagram, and it is carried by
 * colour and by route. Colour alone would be unreadable to a good number of
 * people, which is why the routes differ too — and why this spells both out.
 */
function Legend() {
  return (
    <ul className="text-ink-400 flex flex-wrap gap-x-5 gap-y-1.5 px-5 pb-4 text-[11px]">
      <li className="flex items-center gap-1.5">
        <span className="bg-blade-400 inline-block h-0.5 w-6 rounded" />
        Direct — bows outward, never touches this server
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-6 rounded bg-amber-400" />
        Relayed — routed through the middle, costs this server bandwidth
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
        Node online
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
        Stale or pending
      </li>
      <li>Dashes flow while bytes are moving; a still line is idle.</li>
    </ul>
  );
}

/* ------------------------------------------------------------------ detail */

function TunnelDetail({ tunnel }: { tunnel: MeshTunnel }) {
  return (
    <section className="gb-card p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide uppercase">
          {tunnel.gameTitle ?? 'Unknown game'}
        </h2>
        <Badge tone={tunnel.via === 'relay' ? 'warning' : 'success'}>{tunnel.via}</Badge>
        <Badge tone={tunnel.state === 'transferring' ? 'success' : 'neutral'}>{tunnel.state}</Badge>
      </div>
      <dl className="text-ink-400 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <Detail label="Player">{tunnel.username ?? 'unknown'}</Detail>
        <Detail label="From node">{tunnel.nodeLabel}</Detail>
        <Detail label="Moved">{formatBytes(tunnel.bytesServed)}</Detail>
        <Detail label="Rate">
          {tunnel.bytesPerSecond === null ? '—' : `${formatBytes(tunnel.bytesPerSecond)}/s`}
        </Detail>
        <Detail label="Opened">{formatRelative(tunnel.openedAt)}</Detail>
        <Detail label="Last report">
          {tunnel.lastReportAt ? formatRelative(tunnel.lastReportAt) : 'nothing yet'}
        </Detail>
        <Detail label="Player network">{tunnel.clientNetwork ?? 'unknown'}</Detail>
        <Detail label="Punches">{tunnel.punches}</Detail>
      </dl>
      {tunnel.state === 'connecting' ? (
        <p className="text-ink-500 mt-3 text-[11px]">
          Permission has been issued and the node has not reported anything yet. For the first
          half-minute a handshake in progress and one that failed look the same from here; if it
          stays like this and the player falls back, the tunnel will reappear as relayed.
        </p>
      ) : null}
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-ink-200 tabular-nums">{children}</dd>
    </div>
  );
}

function TunnelTable({
  tunnels,
  selected,
  onSelect,
}: {
  tunnels: MeshTunnel[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (tunnels.length === 0) {
    return (
      <p className="text-ink-400 text-sm">
        Nothing open. Tunnels appear here the moment a player is given permission to fetch a game
        from a node.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-ink-500">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Player</th>
            <th className="py-1.5 pr-3 font-medium">Game</th>
            <th className="py-1.5 pr-3 font-medium">Node</th>
            <th className="py-1.5 pr-3 font-medium">Route</th>
            <th className="py-1.5 pr-3 text-right font-medium">Moved</th>
            <th className="py-1.5 pr-3 text-right font-medium">Rate</th>
            <th className="py-1.5 font-medium">Last report</th>
          </tr>
        </thead>
        <tbody className="divide-ink-800 divide-y">
          {tunnels.map((tunnel) => (
            <tr
              key={tunnel.id}
              onClick={() => onSelect(tunnel.id)}
              className={
                selected === tunnel.id
                  ? 'bg-ink-800 cursor-pointer'
                  : 'hover:bg-ink-800/50 cursor-pointer'
              }
            >
              <td className="text-ink-200 py-1.5 pr-3">{tunnel.username ?? '—'}</td>
              <td className="text-ink-200 max-w-[220px] truncate py-1.5 pr-3">
                {tunnel.gameTitle ?? '—'}
              </td>
              <td className="text-ink-300 py-1.5 pr-3">{tunnel.nodeLabel}</td>
              <td className="py-1.5 pr-3">
                <Badge tone={tunnel.via === 'relay' ? 'warning' : 'success'}>{tunnel.via}</Badge>
              </td>
              <td className="text-ink-300 py-1.5 pr-3 text-right tabular-nums">
                {formatBytes(tunnel.bytesServed)}
              </td>
              <td className="text-ink-300 py-1.5 pr-3 text-right tabular-nums">
                {tunnel.bytesPerSecond === null ? '—' : `${formatBytes(tunnel.bytesPerSecond)}/s`}
              </td>
              <td className="text-ink-400 py-1.5">
                {tunnel.lastReportAt ? formatRelative(tunnel.lastReportAt) : 'connecting'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
