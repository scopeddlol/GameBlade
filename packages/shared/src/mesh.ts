/**
 * The vocabulary the mesh is built from: chunks, sources and nodes.
 *
 * These definitions are shared because the Coordinator, Node worker and
 * Desktop client must agree on chunk boundaries and friendly source labels.
 *
 * * **A chunk is addressed by its content, not by its location.** A file is cut
 *   into fixed-size chunks and each is named by its SHA-256. Any node holding
 *   that hash can serve it and the client verifies what arrives regardless of
 *   where it came from, so a stale replica cannot quietly hand over the wrong
 *   bytes. This is what makes more than one source possible at all.
 * * **A source is who supplied the bytes.** Every client request uses HTTPS to
 *   the Coordinator; the Coordinator either reads locally or obtains verified
 *   chunks over a Node's outbound authenticated HTTPS connection.
 */

/**
 * Bytes per chunk, everywhere: the hashes the server records, the ranges the
 * client asks for, and the units a node advertises.
 *
 * Ten MiB keeps request and proxy overhead low for the single large ZIP every
 * game is distributed as, while still leaving enough pieces for several HTTPS
 * connections to stay busy on ordinary game sizes.
 * The engine already cuts transfers here, so aligning content addressing to the
 * same boundary means a chunk it fetches is exactly a chunk it can verify —
 * no re-hashing across a different grid, and a failed chunk retried against a
 * different source lines up byte for byte with the one that failed.
 */
export const MESH_CHUNK_BYTES = 10 * 1024 * 1024;

/** How many chunks a file of this size is cut into. */
export function chunkCountFor(sizeBytes: number): number {
  if (sizeBytes <= 0) return 0;
  return Math.ceil(sizeBytes / MESH_CHUNK_BYTES);
}

/** The byte range chunk `index` covers within a file of `sizeBytes`. */
export function chunkRange(
  index: number,
  sizeBytes: number,
): { start: number; end: number; length: number } {
  const start = index * MESH_CHUNK_BYTES;
  const length = Math.min(MESH_CHUNK_BYTES, Math.max(0, sizeBytes - start));
  return { start, end: start + length - 1, length };
}

/* --------------------------------------------------------------- addressing */

/** One content-addressed piece of a file. */
export interface ChunkRef {
  /** Position in the file, zero-based. The byte offset is implied by the size. */
  index: number;
  /** Lowercase hex SHA-256 of exactly this chunk's bytes. */
  sha256: string;
  /** Bytes in this chunk; only the last chunk of a file is ever short. */
  sizeBytes: number;
}

/**
 * Where a chunk can be fetched from.
 *
 * `origin` is a standalone server's local copy. `node` is a friendly label for
 * a Node supplying chunks through the Coordinator's HTTP download routes.
 */
export const MESH_SOURCE_KINDS = ['origin', 'node'] as const;
export type MeshSourceKind = (typeof MESH_SOURCE_KINDS)[number];

export interface MeshSource {
  kind: MeshSourceKind;
  /** Node identifier, absent for `origin`. */
  nodeId?: string;
  /** Human-facing label for the downloads panel, e.g. "Home archive". */
  label: string;
  /**
   * Preference order, lowest first. The client still measures for itself; this
   * only decides what it tries before it has measurements of its own.
   */
  priority: number;
  /**
   * The Node's own address, when it has one a client can reach.
   *
   * Present only for a Node that advertises a public URL and is currently
   * online. Its absence is not a failure — it is the ordinary case for a
   * machine behind a home router — and the client falls back to the
   * Coordinator, which is the transport every source has.
   */
  directUrl?: string;
  /** The signed permission a direct fetch presents. Absent without `directUrl`. */
  grant?: string;
  grantExpiresAt?: string;
  /**
   * The game and file *this* source holds.
   *
   * Two machines can hold the same game as two catalog entries that were
   * merged into one. They agree byte for byte — the chunk hashes prove it —
   * but each knows its copy by its own id, so a request has to be addressed in
   * the ids the Node it is going to actually has.
   */
  gameId?: string;
  fileId?: string;
  /**
   * What the last client to measure this source saw, bytes per second.
   *
   * A starting order, not a promise: a source that is fast from Frankfurt says
   * little about Melbourne. The client measures for itself and prefers its own
   * numbers as soon as it has them.
   */
  observedBytesPerSecond?: number | null;
}

/* -------------------------------------------------------------------- nodes */

/**
 * What a node is allowed to be.
 *
 * `origin` is the machine holding the canonical library and `mirror` is an
 * operator-run copy. `peer` remains only for database compatibility with older
 * installations; v0.7 clients do not register as Nodes.
 */
export const MESH_NODE_ROLES = ['origin', 'mirror', 'peer'] as const;
export type MeshNodeRole = (typeof MESH_NODE_ROLES)[number];

/**
 * Whether the coordinator will currently hand this node out as a source.
 *
 * `pending` has enrolled but never completed a handshake; `online` has
 * heartbeated recently; `stale` has not, and is withheld from new downloads
 * while existing ones drain; `blocked` has been switched off by an operator and
 * is never handed out.
 */
export const MESH_NODE_STATUS = ['pending', 'online', 'stale', 'blocked'] as const;
export type MeshNodeStatus = (typeof MESH_NODE_STATUS)[number];

/**
 * Legacy endpoint vocabulary accepted from pre-v0.7 agents. The Coordinator
 * discards these values and never exposes them to clients or the Admin UI.
 */
export const MESH_ENDPOINT_KINDS = ['local', 'observed', 'configured'] as const;
export type MeshEndpointKind = (typeof MESH_ENDPOINT_KINDS)[number];

export interface MeshEndpoint {
  kind: MeshEndpointKind;
  /** IPv4 or IPv6 literal. Hostnames are resolved before they get here. */
  address: string;
  port: number;
}

export interface MeshNodeInfo {
  id: string;
  label: string;
  role: MeshNodeRole;
  status: MeshNodeStatus;
  /** Base64url Ed25519 public key; the node's identity on the wire. */
  publicKey: string;
  endpoints: MeshEndpoint[];
  lastSeenAt: string | null;
  /** Bytes this node has served since the counter was last reset. */
  bytesServed: number;
  /** Games this node advertises a complete copy of. */
  gameCount: number;
  /** What the client measured last time, if anything. Coordinator-visible only. */
  observedRttMs: number | null;
  /**
   * Where clients may fetch from this node directly, if anywhere.
   *
   * A node with a routable address — a VPS, or a forwarded port — carries its
   * own downloads and the Coordinator's uplink stops being the ceiling on
   * everybody's transfers. Null is the ordinary case and costs only the proxy
   * hop that has always been there.
   */
  publicUrl?: string | null;
  /** When a client last reported a successful direct fetch from this node. */
  directOkAt?: string | null;
}

/** Seconds without a heartbeat after which a node is considered stale. */
export const MESH_HEARTBEAT_TIMEOUT_SECONDS = 90;

/** How often a node should heartbeat. Three misses is a timeout. */
export const MESH_HEARTBEAT_INTERVAL_SECONDS = 30;

/** Maximum Node sources the Coordinator tries for one game. */
export const MESH_MAX_SOURCES_PER_GAME = 4;

/** How long a Node holds its outbound HTTPS long-poll open. */
export const MESH_TRANSFER_POLL_SECONDS = 25;

/* --------------------------------------------------------- administration */

/**
 * Everything the panel shows about one node.
 *
 * Separate from `MeshNodeInfo`, which is what a *client* is told when it asks
 * where a game can be found — a public list of addresses and keys. This is the
 * operator's view, and it carries things no client has any business seeing:
 * which library the node reports into, how much it has moved for whom, and how
 * far through hashing its own catalog it is.
 */
export interface MeshNodeStats extends MeshNodeInfo {
  /** The agent build this node last registered with, if it said. */
  agentVersion: string | null;
  createdAt: string;
  /** Which library this node's catalog reports land in, and its name. */
  libraryId: string | null;
  libraryName: string | null;
  /** When the node last reported a catalog, and how that went. */
  catalogReportedAt: string | null;
  catalogStatus: string | null;
  /** Games in the library this node reports into, whatever it is announcing. */
  libraryGames: number;
  /** Of those, how many have chunk hashes and so could be served at all. */
  servableGames: number;
  /** Bytes this node has served in the last day and the last week. */
  bytesServed24h: number;
  bytesServed7d: number;
  /** Grants issued against this node in the last day, and how many delivered. */
  transfers24h: number;
  activeTransfers: number;
  /** Distinct accounts this node has served in the last week. */
  players7d: number;
  /** When this node last reported serving anything. */
  lastTransferAt: string | null;
  /** Set for a peer node: whose client it is. */
  ownerUsername: string | null;
  /** Seconds since this node was last heard from; null if never. */
  secondsSinceSeen: number | null;
  /** Bytes clients reported pulling straight from this node, lifetime. */
  directBytesServed: number;
  /** What clients have measured against this node lately, bytes per second. */
  probeBytesPerSecond: number | null;
  /** How many measurements that median is drawn from. */
  probeSamples: number;
}

/** One day of the fleet's history. */
export interface MeshDailyPoint {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** Bytes nodes served that day. */
  meshBytes: number;
  /** Bytes the coordinator itself served that day, for comparison. */
  originBytes: number;
  transfers: number;
}

/**
 * Node-backed delivery at a glance, plus enough history to see a trend.
 */
export interface MeshAnalytics {
  generatedAt: string;
  days: number;
  nodes: {
    total: number;
    online: number;
    stale: number;
    blocked: number;
    pending: number;
    operator: number;
  };
  bytes: {
    meshLifetime: number;
    mesh24h: number;
    mesh7d: number;
    origin24h: number;
    origin7d: number;
    /** Fraction of the last week's delivered bytes that came from nodes, 0–1. */
    meshShare: number;
  };
  coverage: {
    /** Games in the catalog that are not flagged missing. */
    games: number;
    /** Games at least one online node is currently announcing. */
    covered: number;
    /** Games exactly one online node is announcing — a drive failure away from gone. */
    singleSource: number;
    /** Games no online node has, which every download therefore costs the coordinator. */
    uncovered: number;
  };
  history: MeshDailyPoint[];
  /** Which nodes moved the most this week, most first. */
  topNodes: { nodeId: string; label: string; bytes: number }[];
  /** Which games moved the most over the mesh this week, most first. */
  topGames: { gameId: string; title: string; bytes: number }[];
}

/* ------------------------------------------------------- direct delivery */

/**
 * How a client may reach the bytes of one source.
 *
 * `proxy` is the original path and the one that always works: the Desktop asks
 * the Coordinator, which pulls verified chunks over the Node's outbound
 * connection. `direct` is a Node that is reachable on its own address — a VPS,
 * or a home machine with a port forwarded — where the Coordinator's uplink is
 * the slowest part of a transfer it contributes nothing else to.
 *
 * Both are safe for the same reason: a chunk is named by its SHA-256 and the
 * Desktop checks every one. A direct Node cannot hand over different bytes than
 * the proxy would, only faster or slower ones.
 */
export const MESH_TRANSPORTS = ['proxy', 'direct'] as const;
export type MeshTransport = (typeof MESH_TRANSPORTS)[number];

/**
 * The path a direct Node answers chunk requests on, below its public URL.
 *
 * Versioned because a Node is upgraded on somebody else's schedule: a client
 * that knows only this path must never be answered by a Node that means
 * something else by it.
 */
export const MESH_DIRECT_CHUNK_PATH = '/gb/v1/chunk';

/** Where a direct Node answers "are you there, and how fast is this link". */
export const MESH_DIRECT_PROBE_PATH = '/gb/v1/probe';

/** Port a Node listens on for direct delivery unless it is told otherwise. */
export const MESH_DIRECT_DEFAULT_PORT = 8099;

/**
 * Largest sample a speed probe may ask for.
 *
 * One chunk. A measurement wants to be long enough to leave TCP slow start
 * behind and short enough that testing four sources is a few seconds rather
 * than a download of its own.
 */
export const MESH_PROBE_MAX_BYTES = MESH_CHUNK_BYTES;

/** Sample size a client uses when it has no reason to choose another. */
export const MESH_PROBE_DEFAULT_BYTES = 2 * 1024 * 1024;

/**
 * A short-lived, signed permission for one client to pull from one Node.
 *
 * Minted by the Coordinator, verified by the Node against the Coordinator's
 * published Ed25519 key. This is what lets a Node serve somebody it has never
 * heard of without the Coordinator being in the data path: the grant names the
 * account, the game and the file, expires in minutes, and proves who issued it.
 */
export interface DeliveryGrantClaims {
  /** Grant format; bumped if the meaning of any field below ever changes. */
  v: 1;
  /** The Node this grant is addressed to. Presenting it to another is refused. */
  nodeId: string;
  /** The game *as that Node knows it* — its replica, not the merged entry. */
  gameId: string;
  fileId: string;
  userId: string;
  /** Seconds since the epoch, after which the Node refuses it. */
  expiresAt: number;
  /** Makes two grants for the same triple distinguishable in Node logs. */
  nonce: string;
}

/**
 * How long a delivery grant stays good for.
 *
 * Long enough to cover a slow chunk and a retry or two, short enough that a
 * grant captured off a wire is worthless by the time anyone reads it. The
 * Desktop refreshes its manifest rather than reusing one for a whole download.
 */
export const MESH_GRANT_TTL_SECONDS = 30 * 60;

/**
 * What a client measured against one source, reported back so the Coordinator
 * can order sources for the next person before they have measured anything.
 */
export interface SourceProbeReport {
  nodeId: string | null;
  transport: MeshTransport;
  /** Time to first byte, milliseconds. */
  latencyMs: number | null;
  /** Sustained throughput over the sample, bytes per second. Null on failure. */
  bytesPerSecond: number | null;
  ok: boolean;
  /** Short, human-readable failure reason. Never shown to other users. */
  detail?: string | null;
}

/** One measured source, as the Desktop shows it in the downloads panel. */
export interface SourceProbeResult extends SourceProbeReport {
  label: string;
  /** True when the Node answered on its own address rather than through the VPS. */
  direct: boolean;
}
