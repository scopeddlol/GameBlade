//! Wiring the mesh into the transfer engine.
//!
//! The engine already fetches a file as independently scheduled 8 MiB chunks,
//! any idle connection taking the next unfinished one. That queue is exactly
//! what multi-source needs, so this adds one decision to it rather than a
//! second download path: for each chunk, which source should serve it.
//!
//! The rule everywhere here is that a node is an optimisation. Every failure
//! ends at the origin over HTTP — the path that worked before any of this
//! existed — and no failure of a node is ever allowed to fail a download.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gameblade_mesh::{
    connect_to_node, coordinator_key_from_spki, MeshEndpoint, MeshError, NodeCandidate,
    NodeIdentity, NodeSession, PublicKey, SourcePool,
};
use tokio::sync::Mutex;

use crate::api::{ApiClient, MeshResolution};

/// How long a node may take to deliver one chunk before it is written off.
///
/// Generous against a slow link, mean against a stalled one. The origin is
/// still there, so waiting a long time for a node that has gone quiet costs
/// throughput for no possible gain.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(45);

/// Everything a download needs to use nodes, or the knowledge that it cannot.
pub struct MeshContext {
    endpoint: MeshEndpoint,
    sessions: Mutex<Vec<Arc<NodeSession>>>,
    pool: Mutex<SourcePool>,
}

impl MeshContext {
    /// Set the mesh up for one game, or decide it is not available.
    ///
    /// Returns `None` for every reason a download should simply proceed over
    /// HTTP: the mesh is off, the server is older, the game has no chunk
    /// hashes, no node holds it, or nothing would connect. None of these are
    /// errors and none of them are worth telling anyone about.
    pub async fn prepare(client: &ApiClient, game_id: &str, chunked: bool) -> Option<Arc<Self>> {
        // Without chunk hashes a client cannot verify a piece, so it must not
        // accept one from anywhere but the origin.
        if !chunked {
            return None;
        }

        let resolution = client.resolve_mesh(game_id).await;
        if resolution.nodes.is_empty() {
            return None;
        }

        let coordinator = resolution
            .coordinator_public_key
            .as_deref()
            .and_then(|key| coordinator_key_from_spki(key).ok());
        // The client does not verify grants — the node does — but a coordinator
        // that would not publish a usable key is one whose grants no node will
        // accept either, so there is no point starting.
        coordinator?;

        let endpoint = MeshEndpoint::client(NodeIdentity::generate()).ok()?;
        let candidates = candidates_from(&resolution);
        if candidates.is_empty() {
            return None;
        }

        let mut pool = SourcePool::new("Origin");
        let mut sessions = Vec::new();

        // Connected up front rather than lazily. A handshake costs a round trip
        // and the first chunk should not pay for it, and how long the handshake
        // took is the first real signal of how good a source is.
        for (position, candidate) in candidates.iter().enumerate() {
            match connect_to_node(&endpoint, candidate).await {
                Ok(session) => {
                    pool.add_node(&candidate.node_id, &candidate.label, position);
                    sessions.push(Arc::new(session));
                }
                Err(err) => {
                    tracing_log(&format!(
                        "mesh: {} unreachable ({err}); continuing without it",
                        candidate.label
                    ));
                }
            }
        }

        if sessions.is_empty() {
            endpoint.close();
            return None;
        }

        Some(Arc::new(Self {
            endpoint,
            sessions: Mutex::new(sessions),
            pool: Mutex::new(pool),
        }))
    }

    /// Which source should serve the next chunk.
    pub async fn pick(&self) -> String {
        self.pool.lock().await.pick()
    }

    /// Try one chunk against a node.
    ///
    /// `None` means "not from here" — the caller should fall back to HTTP for
    /// this chunk without treating anything as broken. `Some(bytes)` is
    /// verified data. There is deliberately no error case in the signature at
    /// all: a download must never fail because a node did, and a `Result` here
    /// would invite a caller to propagate one.
    pub async fn fetch_chunk(
        &self,
        source_id: &str,
        game_id: &str,
        file_id: &str,
        index: u64,
        sha256: &str,
        length: u64,
    ) -> Option<Vec<u8>> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .iter()
                .find(|session| session.node_id == source_id)
                .map(Arc::clone)
        }?;

        let started = Instant::now();
        let result = tokio::time::timeout(
            CHUNK_TIMEOUT,
            session.fetch_chunk(game_id, file_id, index, sha256, length),
        )
        .await;

        let mut pool = self.pool.lock().await;

        match result {
            Ok(Ok(bytes)) => {
                pool.record_success(source_id, length, started.elapsed());
                Some(bytes)
            }
            Ok(Err(MeshError::ChunkMismatch { .. })) => {
                // The node served bytes that were not what it advertised. That
                // is not a transient fault and asking it again is pointless;
                // it is also caught here rather than being allowed anywhere
                // near the file on disk.
                pool.retire(source_id);
                None
            }
            Ok(Err(err)) if !err.is_fallback() => {
                pool.retire(source_id);
                None
            }
            Ok(Err(MeshError::GrantExhausted)) => {
                // The allowance for this node is spent. Another node may have
                // its own grant, and the origin enforces the same quota
                // server-side, so this is a source problem, not a stop.
                pool.retire(source_id);
                None
            }
            Ok(Err(_)) | Err(_) => {
                pool.record_failure(source_id);
                None
            }
        }
    }

    /// Whether any node is still worth asking.
    pub async fn has_live_node(&self) -> bool {
        self.pool.lock().await.has_live_node()
    }

    /// Which nodes actually delivered anything, for the diagnostic log.
    pub async fn describe(&self) -> String {
        let pool = self.pool.lock().await;
        let live: Vec<String> = pool
            .sources()
            .iter()
            .filter(|source| source.retirable && source.chunks_delivered() > 0)
            .map(|source| source.label.clone())
            .collect();

        if live.is_empty() {
            "Origin".to_string()
        } else {
            live.join(", ")
        }
    }

    pub async fn close(&self) {
        for session in self.sessions.lock().await.iter() {
            session.close();
        }
        self.endpoint.close();
    }
}

/// Turn what the coordinator said into things that can be dialled.
///
/// A node with no grant is dropped rather than tried: without one every request
/// to it would be refused, so dialling it would cost a handshake to learn
/// nothing. A node with no parseable address is dropped for the same reason.
fn candidates_from(resolution: &MeshResolution) -> Vec<NodeCandidate> {
    resolution
        .nodes
        .iter()
        .filter_map(|node| {
            let grant = resolution
                .grants
                .iter()
                .find(|grant| grant.node_id == node.id)?
                .grant
                .clone();

            let public_key = PublicKey::from_base64(&node.public_key).ok()?;

            let addresses: Vec<SocketAddr> = node
                .endpoints
                .iter()
                .filter_map(|endpoint| socket_address(&endpoint.address, endpoint.port))
                .collect();

            if addresses.is_empty() {
                return None;
            }

            Some(NodeCandidate {
                node_id: node.id.clone(),
                label: if node.label.is_empty() {
                    node.id.clone()
                } else {
                    node.label.clone()
                },
                public_key,
                addresses,
                grant,
            })
        })
        .collect()
}

/// Parse an address and port into something dialable.
///
/// IPv6 has to be bracketed before `SocketAddr` will read it: `2001:db8::1:47820`
/// is ambiguous with an address that simply has more groups. Getting this wrong
/// silently discards every IPv6 candidate — which are the ones most likely to
/// work, since two hosts with IPv6 need no traversal at all.
fn socket_address(address: &str, port: u16) -> Option<SocketAddr> {
    let literal = if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    };
    literal.parse().ok()
}

/// Mesh troubles are diagnostics, never user-facing failures.
fn tracing_log(message: &str) {
    // The engine's own logging goes through Tauri events tied to a download;
    // this is background detail about an optimisation that did not apply.
    eprintln!("{message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{MeshEndpoint as ApiEndpoint, MeshGrant, MeshNode};

    fn node(id: &str, key: &str, addresses: Vec<(&str, u16)>) -> MeshNode {
        MeshNode {
            id: id.to_string(),
            label: format!("Node {id}"),
            role: "mirror".to_string(),
            public_key: key.to_string(),
            endpoints: addresses
                .into_iter()
                .map(|(address, port)| ApiEndpoint {
                    kind: "local".to_string(),
                    address: address.to_string(),
                    port,
                })
                .collect(),
        }
    }

    fn valid_key() -> String {
        NodeIdentity::generate().public_key_base64()
    }

    #[test]
    fn a_node_without_a_grant_is_not_worth_dialling() {
        // Every request to it would be refused, so the handshake would buy
        // nothing but latency.
        let resolution = MeshResolution {
            nodes: vec![node("nod_1", &valid_key(), vec![("127.0.0.1", 47820)])],
            grants: vec![],
            coordinator_public_key: None,
        };

        assert!(candidates_from(&resolution).is_empty());
    }

    #[test]
    fn a_node_with_no_usable_address_is_dropped() {
        let resolution = MeshResolution {
            nodes: vec![node("nod_1", &valid_key(), vec![("not-an-address", 47820)])],
            grants: vec![MeshGrant {
                node_id: "nod_1".into(),
                grant: "v2.a.b".into(),
                expires_at: None,
            }],
            coordinator_public_key: None,
        };

        assert!(candidates_from(&resolution).is_empty());
    }

    #[test]
    fn a_node_with_an_unreadable_key_is_dropped_rather_than_trusted() {
        // Without a key there is nothing to pin the certificate against, and
        // connecting anyway would mean accepting whoever answered.
        let resolution = MeshResolution {
            nodes: vec![node("nod_1", "not-a-key", vec![("127.0.0.1", 47820)])],
            grants: vec![MeshGrant {
                node_id: "nod_1".into(),
                grant: "v2.a.b".into(),
                expires_at: None,
            }],
            coordinator_public_key: None,
        };

        assert!(candidates_from(&resolution).is_empty());
    }

    #[test]
    fn a_complete_node_becomes_a_candidate_with_all_its_addresses() {
        let key = valid_key();
        let resolution = MeshResolution {
            nodes: vec![node(
                "nod_1",
                &key,
                vec![("192.168.1.5", 47820), ("203.0.113.9", 47820)],
            )],
            grants: vec![MeshGrant {
                node_id: "nod_1".into(),
                grant: "v2.a.b".into(),
                expires_at: None,
            }],
            coordinator_public_key: None,
        };

        let candidates = candidates_from(&resolution);
        assert_eq!(candidates.len(), 1);
        // Both are kept: neither can be known good in advance, and they are
        // raced rather than tried in turn.
        assert_eq!(candidates[0].addresses.len(), 2);
        assert_eq!(candidates[0].grant, "v2.a.b");
    }

    #[test]
    fn ipv6_addresses_survive_parsing() {
        // If both ends have IPv6 there is no traversal problem to solve at all,
        // which makes these the most valuable candidates in the list.
        let key = valid_key();
        let resolution = MeshResolution {
            nodes: vec![node("nod_1", &key, vec![("2001:db8::1", 47820)])],
            grants: vec![MeshGrant {
                node_id: "nod_1".into(),
                grant: "v2.a.b".into(),
                expires_at: None,
            }],
            coordinator_public_key: None,
        };

        assert_eq!(candidates_from(&resolution)[0].addresses.len(), 1);
    }

    #[test]
    fn ipv6_needs_brackets_and_ipv4_must_not_have_them() {
        // The bug this pins: `2001:db8::1:47820` is not an address with a port,
        // it is an ambiguous address, so an unbracketed IPv6 candidate parses
        // as nothing and is silently dropped.
        assert!(socket_address("2001:db8::1", 47820).is_some());
        assert!(socket_address("::1", 47820).unwrap().is_ipv6());
        assert!(socket_address("192.168.1.5", 47820).unwrap().is_ipv4());
        assert!(socket_address("not-an-address", 47820).is_none());
    }

    #[tokio::test]
    async fn a_game_without_chunk_hashes_never_uses_a_node() {
        // A client cannot verify a piece without them, so it must not accept
        // one from anywhere but the origin.
        let client = ApiClient::new("http://localhost:9", None).unwrap();

        assert!(MeshContext::prepare(&client, "gam_1", false)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn an_unreachable_coordinator_falls_back_to_the_origin_silently() {
        // Port 9 is discard; nothing answers. This must read as "no mesh",
        // not as a failed download.
        let client = ApiClient::new("http://localhost:9", None).unwrap();

        assert!(MeshContext::prepare(&client, "gam_1", true).await.is_none());
    }
}
