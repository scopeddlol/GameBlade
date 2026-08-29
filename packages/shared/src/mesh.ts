/**
 * The vocabulary the mesh is built from: chunks, sources and nodes.
 *
 * Three ideas carry the whole design, and they are all here rather than in the
 * server or the client because both ends have to agree on them exactly.
 *
 * * **A chunk is addressed by its content, not by its location.** A file is cut
 *   into fixed-size chunks and each is named by its SHA-256. Any node holding
 *   that hash can serve it and the client verifies what arrives regardless of
 *   where it came from, so a stale replica cannot quietly hand over the wrong
 *   bytes. This is what makes more than one source possible at all.
 * * **A source is somewhere bytes can come from**, not a server. The origin over
 *   HTTP is one; a node reached directly over QUIC is another; the same node
 *   reached through the coordinator's relay is a third. The downloader picks
 *   between them per chunk and can fall back without restarting anything.
 * * **A grant is permission to move bytes**, signed by the coordinator and
 *   checked by whoever serves them. Nodes never hold the signing key — only the
 *   public half — so enrolling a node does not hand it the ability to mint
 *   authority for itself.
 */

/**
 * Bytes per chunk, everywhere: the hashes the server records, the ranges the
 * client asks for, and the units a node advertises.
 *
 * This matches the download engine's existing work-queue chunk size on purpose.
 * The engine already cuts transfers here, so aligning content addressing to the
 * same boundary means a chunk it fetches is exactly a chunk it can verify —
 * no re-hashing across a different grid, and a failed chunk retried against a
 * different source lines up byte for byte with the one that failed.
 */
export const MESH_CHUNK_BYTES = 8 * 1024 * 1024;

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
 * `origin` is the server's own HTTP download routes — the path that exists
 * today and stays the permanent fallback. `node` is a mesh node reached
 * directly. `relay` is a mesh node reached through the coordinator because a
 * direct path could not be established; it works everywhere and is slow, which
 * is exactly the trade a fallback should make.
 */
export const MESH_SOURCE_KINDS = ['origin', 'node', 'relay'] as const;
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
}

/* -------------------------------------------------------------------- nodes */

/**
 * What a node is allowed to be.
 *
 * `origin` is the machine holding the canonical library — the one the scanner
 * reads. `mirror` is an operator-run node holding a copy. `peer` is somebody's
 * client seeding what it has already downloaded, which is trusted least and
 * gated hardest.
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
 * How a node believes it can be reached.
 *
 * Both ends send every candidate they know and let the connection attempt sort
 * it out, because none of them can be trusted in advance: a node behind NAT
 * cannot see its own public address, and the address the coordinator observes
 * is useless if the NAT is not endpoint-independent.
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
}

/* ------------------------------------------------------------------- grants */

/**
 * Permission for one account to pull one game's bytes from one node.
 *
 * Direct transfers never touch the server, so the server cannot meter them by
 * watching a stream the way `BandwidthService` does today. A grant is the
 * replacement: the coordinator issues a ceiling, the node enforces it locally
 * and reports back what it actually served. A node that never reports is a node
 * whose grants stop being renewed.
 */
export interface MeshGrantClaims {
  userId: string;
  gameId: string;
  nodeId: string;
  /** Bytes this grant authorises in total. */
  maxBytes: number;
  /** Unix seconds. */
  expiresAt: number;
  /** Random, so a replayed grant can be told from a reissued one. */
  nonce: string;
}

/**
 * How long a grant is good for.
 *
 * Long enough that a slow transfer does not spend its life renewing, short
 * enough that revoking an account's access takes effect within one window.
 */
export const MESH_GRANT_TTL_SECONDS = 60 * 60;

/** Seconds without a heartbeat after which a node is considered stale. */
export const MESH_HEARTBEAT_TIMEOUT_SECONDS = 90;

/** How often a node should heartbeat. Three misses is a timeout. */
export const MESH_HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * The largest number of sources the coordinator will hand a client for one
 * game.
 *
 * Racing costs a handshake each, and past a handful the marginal source adds
 * connection overhead rather than throughput.
 */
export const MESH_MAX_SOURCES_PER_GAME = 4;

/* ------------------------------------------------------------- rendezvous */

/**
 * One side telling the other where to aim a punch.
 *
 * Hole punching only works if both ends send at roughly the same moment: each
 * one's outbound packet is what teaches its own NAT to accept the other's. A
 * client can start whenever it likes, but a node has no idea the client exists
 * until it connects — which it cannot do until the node has punched. The
 * coordinator breaks that circle by telling the node to punch first.
 */
export interface MeshPunchRequest {
  /** Where the node should send its punch packets. */
  address: string;
  port: number;
  /** Which client asked, so a node can rate-limit per account if it needs to. */
  userId: string;
  /** When the coordinator queued it, so a node can drop a stale one. */
  queuedAt: string;
  /**
   * Present when the client gave up on a direct path and wants the relay.
   *
   * The node dials the relay and presents this instead of punching. It arrives
   * on the same channel as a punch because it answers the same question — a
   * client is trying to reach you, here is how — and a second channel would be
   * a second thing to keep alive for no gain.
   */
  relay?: {
    /** Where the relay is, as clients and nodes both reach it. */
    address: string;
    port: number;
    /** This node's half of the pairing. */
    ticket: string;
  };
}

/**
 * How long a queued punch stays worth acting on.
 *
 * A NAT mapping for a socket that has gone quiet lapses in well under a minute,
 * and a client that asked ten seconds ago has already given up and fallen back
 * to HTTP. Punching at a stale address is not harmful, only useless.
 */
export const MESH_PUNCH_TTL_SECONDS = 10;

/**
 * How long a node's long-poll for punch requests is held open.
 *
 * Comfortably under the sixty seconds most proxies will hold an idle response,
 * so the request completes normally rather than being cut off.
 */
export const MESH_RENDEZVOUS_POLL_SECONDS = 25;

/* ------------------------------------------------------------------- relay */

/**
 * Permission to use the relay for one transfer, signed by the coordinator.
 *
 * The relay verifies this with the coordinator's public key alone and pairs on
 * the session id, so it needs no database, no lookup and no conversation with
 * anything — which is what lets it be a small process that does nothing but
 * move bytes.
 */
export interface MeshRelayTicket {
  /** Both sides of one transfer present the same id; that is how they pair. */
  sessionId: string;
  nodeId: string;
  userId: string;
  /** Which end of the pipe this ticket is for. */
  side: 'client' | 'node';
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * How long a relay ticket is good for.
 *
 * Short: it only has to survive the moment between being issued and both ends
 * arriving. The QUIC session it carries lives as long as it likes afterwards —
 * the ticket admits you to the pipe, it does not hold it open.
 */
export const MESH_RELAY_TICKET_TTL_SECONDS = 60;

/**
 * How long a paired relay session survives with no traffic.
 *
 * Long enough to outlast a stalled disk or a paused download, short enough that
 * a client which vanished stops occupying a slot.
 */
export const MESH_RELAY_IDLE_SECONDS = 90;

/** Default UDP port the relay listens on. */
export const MESH_RELAY_DEFAULT_PORT = 47_821;

/**
 * The first packet each side sends the relay, before any QUIC.
 *
 * A fixed prefix so it cannot be mistaken for the QUIC that follows: the relay
 * treats the first packet from an unknown address as a hello and everything
 * from a known one as traffic to forward, so the two never have to be told
 * apart by guesswork.
 */
export const MESH_RELAY_HELLO_MAGIC = 'GBRELAY1';

/* ---------------------------------------------------------------- protocol */

/**
 * ALPN for the node protocol.
 *
 * Versioned because a node and a client can be on different releases for a
 * long time; a mismatch should fail the handshake cleanly and fall back to
 * HTTP rather than misparse a frame.
 */
export const MESH_ALPN = 'gameblade-mesh/1';

/** Default UDP port a node listens on when nothing else is configured. */
export const MESH_DEFAULT_PORT = 47_820;

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
 * The whole mesh at a glance, plus enough history to see a trend.
 *
 * The number that matters most is `meshShare`: the mesh exists to keep game
 * bytes off the coordinator's connection, and the only honest measure of
 * whether it is working is what fraction of delivered bytes never touched it.
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
    /** Nodes an operator runs, as opposed to players' clients seeding. */
    operator: number;
    peers: number;
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
  /** Whether a relay is configured, and what it has been asked to carry. */
  relay: {
    configured: boolean;
    address: string | null;
    sessions24h: number;
    activeSessions: number;
  };
  history: MeshDailyPoint[];
  /** Which nodes moved the most this week, most first. */
  topNodes: { nodeId: string; label: string; bytes: number }[];
  /** Which games moved the most over the mesh this week, most first. */
  topGames: { gameId: string; title: string; bytes: number }[];
}

/**
 * One connection the coordinator currently believes is open.
 *
 * "Believes" is exact and worth keeping: a direct transfer never touches this
 * server, so what is known about it is what the node last reported — which is
 * on its heartbeat, so up to half a minute old. That is far better than the
 * alternative (nothing at all), and the map says how old rather than pretending
 * to be live.
 */
export interface MeshTunnel {
  /** The grant's nonce: one tunnel, from the moment permission was issued. */
  id: string;
  nodeId: string;
  nodeLabel: string;
  nodeRole: MeshNodeRole;
  userId: string | null;
  username: string | null;
  gameId: string | null;
  gameTitle: string | null;
  /** Direct is node-to-client; relayed goes through the coordinator's relay. */
  via: 'direct' | 'relay';
  state: 'connecting' | 'transferring' | 'idle';
  openedAt: string;
  lastReportAt: string | null;
  bytesServed: number;
  /** Bytes per second between the last two reports, when there were two. */
  bytesPerSecond: number | null;
  /**
   * The client's address, reduced to a network.
   *
   * A tunnel map is watched by an operator, not by the person on the other end
   * of it, and a player's full address is not something to put on a screen that
   * is left open. The first two octets are enough to tell two players apart and
   * to see that somebody is on the same LAN.
   */
  clientNetwork: string | null;
  /** How many punch instructions this tunnel has needed. */
  punches: number;
}

/** What the map draws: the nodes, the relay, and every tunnel between them. */
export interface MeshTunnelMap {
  generatedAt: string;
  coordinator: { label: string; relay: string | null };
  nodes: {
    id: string;
    label: string;
    role: MeshNodeRole;
    status: MeshNodeStatus;
    /** Best guess at where this node is reachable, for a label on the map. */
    address: string | null;
    lastSeenAt: string | null;
    gameCount: number;
    bytesServed: number;
  }[];
  tunnels: MeshTunnel[];
}

/**
 * How long a tunnel stays on the map after its last sign of life.
 *
 * Longer than a heartbeat interval by a wide margin, because a node reports
 * transfers on its heartbeat: anything shorter would blink every tunnel out
 * between reports and back in again.
 */
export const MESH_TUNNEL_IDLE_SECONDS = 300;
