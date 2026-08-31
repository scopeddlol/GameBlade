//! GameBlade Node catalog, identity, and HTTPS chunk-delivery support.
//!
//! Nodes hold an authenticated outbound HTTPS poll to the Coordinator. When a
//! Desktop requests a byte range, the Node reads and verifies the corresponding
//! 8 MiB chunk, posts it to the Coordinator, and the Coordinator streams it to
//! the Desktop over the same public HTTPS service used by the rest of GameBlade.

pub mod agent;
pub mod error;
pub mod identity;
pub use error::{MeshError, MeshResult, SourceHealth};
pub use identity::NodeIdentity;

/// Bytes per chunk. Must match the server's `MESH_CHUNK_BYTES` exactly.
///
/// Duplicated here rather than fetched, because it is the one number that must
/// be identical in three codebases and a value read at runtime could differ
/// between them without anything noticing until a download was already corrupt.
/// The manifest carries the server's value and the client refuses to use chunk
/// hashes when the two disagree.
pub const MESH_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

/// Where a node's games are mounted, and where its identity is kept.
///
/// Defaults rather than required settings, because the image puts them there:
/// a node that has to be told its own layout is a node with two more things to
/// get wrong in a compose file.
pub const DEFAULT_LIBRARY_ROOT: &str = "/library";
pub const DEFAULT_STATE_PATH: &str = "/data/node-state.json";

/// Where a node with more than one library mounts each of them.
///
/// Every immediate subdirectory is one root. The server half of the node reads
/// exactly the same two locations, so both halves agree about what this machine
/// holds without either being told twice.
pub const MULTI_LIBRARY_ROOT: &str = "/libraries";

/// Every library root this node holds, in the order they should be searched.
///
/// `declared` is `GAMEBLADE_LIBRARY`, which may name several paths separated by
/// commas or semicolons — the same two separators the server half accepts for
/// `LIBRARY_PATHS`, so one list can be pasted into either. Given nothing, the
/// mounts decide: `/library` when it is there, plus one root per directory
/// under `/libraries`.
pub fn library_roots(declared: Option<&str>) -> Vec<std::path::PathBuf> {
    if let Some(value) = declared {
        let listed: Vec<std::path::PathBuf> = value
            .split([',', ';'])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(std::path::PathBuf::from)
            .collect();
        if !listed.is_empty() {
            return listed;
        }
    }

    discover_library_roots(DEFAULT_LIBRARY_ROOT, MULTI_LIBRARY_ROOT)
}

/// The mounts, read rather than declared. Split out so it can be tested.
pub fn discover_library_roots(single: &str, many: &str) -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();

    let single = std::path::PathBuf::from(single);
    if single.is_dir() {
        roots.push(single);
    }

    if let Ok(entries) = std::fs::read_dir(many) {
        // Sorted, so the search order does not depend on the order the
        // filesystem happens to hand these back.
        let mut found: Vec<std::path::PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            // `is_dir` follows symlinks, which a bind mount may well be.
            .filter(|path| path.is_dir())
            .collect();
        found.sort();
        roots.extend(found);
    }

    roots
}

/// How often an agent with no coordinator yet looks again.
///
/// Short, because somebody is standing at the setup page waiting for this to
/// notice, and the check is one small file read.
pub const UNCONFIGURED_POLL: std::time::Duration = std::time::Duration::from_secs(3);
