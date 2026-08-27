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
