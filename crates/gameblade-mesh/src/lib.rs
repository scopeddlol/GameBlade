//! Direct node-to-client transfer for GameBlade.
//!
//! This crate is the answer to one problem: every byte of every download
//! currently crosses a VPS with a thin pipe, because that VPS is the only thing
//! on the public internet. The fix is to let a client talk straight to the
//! machine holding the files, and to leave the VPS doing the part that is
//! actually small — saying who is out there and granting permission.
//!
//! # It is not a VPN
//!
//! The obvious shape for this is a mesh VPN, and that shape is wrong. A VPN
//! means a virtual network interface, which on Windows means a driver, an
//! elevation prompt, antivirus attention and a firewall dialog — all so the
//! operating system can route packets that only ever go to one process. What is
//! actually needed is a byte stream between two machines that is encrypted,
//! survives NAT, and controls congestion. QUIC is exactly that, and terminating
//! it inside the process gets all of it with nothing for a user to install,
//! notice, or agree to.
//!
//! # What holds it together
//!
//! * [`identity`] — a node is its Ed25519 key, not its address. Addresses
//!   change; identities must not.
//! * [`transport`] — QUIC with that key pinned as the certificate, so "did I
//!   reach the machine the coordinator meant" is a local check.
//! * [`grant`] — coordinator-signed permission slips a node can verify but
//!   never mint, which is what keeps enrolling a node from being a decision
//!   about trust.
//! * [`client`] — racing every candidate address, because none of them can be
//!   known good in advance.
//! * [`node`] — serving a chunk to whoever presents a valid grant.
//! * [`selection`] — deciding which source to use, from measurement rather than
//!   from assumption.
//!
//! Nothing here is load-bearing for correctness on its own. Every chunk is
//! verified against a hash the origin computed, so a node can be wrong, stale,
//! hostile or simply gone and the worst outcome is a slower download.

pub mod agent;
pub mod client;
pub mod diagnostics;
pub mod error;
pub mod grant;
pub mod identity;
pub mod node;
pub mod protocol;
pub mod selection;
pub mod stun;
pub mod transport;

pub use client::{connect_to_node, NodeCandidate, NodeSession};
pub use diagnostics::{probe, NatMapping, NetworkReport};
pub use error::{MeshError, MeshResult, SourceHealth};
pub use grant::{verify_grant, GrantClaims, GrantLedger};
pub use identity::{coordinator_key_from_spki, NodeIdentity, PublicKey};
pub use node::{ChunkStore, NodeServer};
pub use selection::{SourcePool, SourceStats};
pub use transport::{MeshEndpoint, MESH_ALPN};

/// Bytes per chunk. Must match the server's `MESH_CHUNK_BYTES` exactly.
///
/// Duplicated here rather than fetched, because it is the one number that must
/// be identical in three codebases and a value read at runtime could differ
/// between them without anything noticing until a download was already corrupt.
/// The manifest carries the server's value and the client refuses to use chunk
/// hashes when the two disagree.
pub const MESH_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

/// Default UDP port a node listens on.
pub const MESH_DEFAULT_PORT: u16 = 47_820;
