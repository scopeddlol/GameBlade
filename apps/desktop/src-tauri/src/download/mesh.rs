//! Wiring the mesh into the transfer engine.
//!
//! The engine already fetches a file as independently scheduled 8 MiB chunks,
//! any idle connection taking the next unfinished one. That queue is exactly
//! what multi-source needs, so this adds one decision to it rather than a
//! second download path: for each chunk, which source should serve it.
//!
//! On a standalone server a node is an optimisation over its HTTP origin. A
//! coordinator has no origin, however, so its node connection is the download
//! path rather than an optional acceleration. Keeping that distinction here is
//! what prevents a failed node attempt from becoming a guaranteed HTTP 410.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gameblade_mesh::{
    connect_to_node, coordinator_key_from_spki, MeshEndpoint, MeshError, NodeCandidate,
    NodeIdentity, NodeSession, PublicKey, SourcePool,
};
use tokio::sync::Mutex;

use super::DownloadSourceState;
use crate::api::{ApiClient, MeshResolution};

/// How long a node may take to deliver one chunk before it is written off.
///
/// Generous against a slow link, mean against a stalled one. The origin is
/// still there, so waiting a long time for a node that has gone quiet costs
/// throughput for no possible gain.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(45);

/// How long to let a node act on its punch instruction before dialling.
///
/// Hole punching needs both ends sending at roughly the same moment. The
/// coordinator wakes the node the instant this client asks, so this only has to
/// cover the node's own round trip — long enough for its packets to be in
/// flight, short enough not to be felt at the start of a download.
const PUNCH_LEAD: Duration = Duration::from_millis(300);

/// Everything a download needs to use nodes, or the knowledge that it cannot.
pub struct MeshContext {
    endpoint: MeshEndpoint,
    sessions: Mutex<Vec<Arc<NodeSession>>>,
    pool: Mutex<SourcePool>,
}

/// The result of discovering and connecting download sources.
pub struct MeshPreparation {
    pub context: Option<Arc<MeshContext>>,
    pub sources: Vec<DownloadSourceState>,
    pub failure: Option<String>,
}

impl MeshPreparation {
    fn unavailable(message: impl Into<String>, sources: Vec<DownloadSourceState>) -> Self {
        Self {
            context: None,
            sources,
            failure: Some(message.into()),
        }
    }
}

impl MeshContext {
    /// Set the mesh up for one game, or decide it is not available.
    ///
    /// The preparation result preserves every attempted source for the
    /// downloads panel. Its failure is fatal only when the manifest says there
    /// is no HTTP origin to fall back to.
    pub async fn prepare(
        client: &ApiClient,
        game_id: &str,
        chunked: bool,
        origin_available: bool,
    ) -> MeshPreparation {
        // Without chunk hashes a client cannot verify a piece, so it must not
        // accept one from anywhere but the origin.
        if !chunked {
            return MeshPreparation::unavailable(
                "This game has no compatible chunk hashes, so it cannot be verified from a node.",
                Vec::new(),
            );
        }

        // Bound and address-discovered before anything else: the reflexive
        // address belongs to this socket alone, and it is what the coordinator
        // needs in order to tell a node where to punch.
        let endpoint = match MeshEndpoint::client_with_discovery(
            NodeIdentity::generate(),
            gameblade_mesh::diagnostics::DEFAULT_STUN_SERVERS,
        ) {
            Ok(endpoint) => endpoint,
            Err(err) => {
                return MeshPreparation::unavailable(
                    format!("Could not open a node connection: {err}"),
                    Vec::new(),
                )
            }
        };

        let candidates: Vec<(String, u16)> = endpoint
            .reflexive_addr()
            .map(|address| vec![(address.ip().to_string(), address.port())])
            .unwrap_or_default();

        let resolution = match client.resolve_mesh(game_id, &candidates).await {
            Ok(resolution) => resolution,
            Err(err) => {
                endpoint.close();
                return MeshPreparation::unavailable(
                    format!("The coordinator could not resolve a download node: {err}"),
                    Vec::new(),
                );
            }
        };
        if resolution.nodes.is_empty() {
            endpoint.close();
            return MeshPreparation::unavailable(
                "The coordinator reported no active node holding this game.",
                Vec::new(),
            );
        }

        let coordinator = resolution
            .coordinator_public_key
            .as_deref()
            .and_then(|key| coordinator_key_from_spki(key).ok());
        // The client does not verify grants — the node does — but a coordinator
        // that would not publish a usable key is one whose grants no node will
        // accept either, so there is no point starting.
        if coordinator.is_none() {
            endpoint.close();
            return MeshPreparation::unavailable(
                "The coordinator published an unusable signing key for node access.",
                Vec::new(),
            );
        }

        let nodes = candidates_from(&resolution);
        if nodes.is_empty() {
            endpoint.close();
            return MeshPreparation::unavailable(
                "The coordinator offered nodes, but none had a usable address and access grant.",
                Vec::new(),
            );
        }

        // A beat for the nodes to act on the punch the coordinator just queued.
        // Both sides have to be sending at roughly the same time; dialling the
        // instant resolve returns means arriving before the far side's packet
        // has opened its NAT.
        tokio::time::sleep(PUNCH_LEAD).await;

        let mut pool = if origin_available {
            SourcePool::new("Coordinator")
        } else {
            SourcePool::nodes_only()
        };
        let mut sessions = Vec::new();
        let mut sources = Vec::new();

        // Connected up front rather than lazily. A handshake costs a round trip
        // and the first chunk should not pay for it, and how long the handshake
        // took is the first real signal of how good a source is.
        for (position, candidate) in nodes.iter().enumerate() {
            match connect_to_node(&endpoint, candidate).await {
                Ok(session) => {
                    pool.add_node(&candidate.node_id, &candidate.label, position);
                    sources.push(source_state(
                        &resolution,
                        candidate,
                        "direct",
                        "connected",
                        Some(format!("Connected in {} ms", session.handshake_ms)),
                    ));
                    sessions.push(Arc::new(session));
                }
                Err(err) => {
                    sources.push(source_state(
                        &resolution,
                        candidate,
                        "direct",
                        "failed",
                        Some("The private tunnel could not be established.".to_string()),
                    ));
                    tracing_log(&format!(
                        "mesh: {} unreachable ({err}); continuing without it",
                        candidate.label
                    ));
                }
            }
        }

        if sessions.is_empty() {
            endpoint.close();
            return MeshPreparation::unavailable(
                "A private Node-to-Client tunnel could not be established with any active node.",
                sources,
            );
        }

        MeshPreparation {
            context: Some(Arc::new(Self {
                endpoint,
                sessions: Mutex::new(sessions),
                pool: Mutex::new(pool),
            })),
            sources,
            failure: None,
        }
    }

    /// Which source should serve the next chunk.
    pub async fn pick(&self) -> Option<String> {
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
            "no node".to_string()
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

fn source_state(
    resolution: &MeshResolution,
    candidate: &NodeCandidate,
    route: &str,
    status: &str,
    detail: Option<String>,
) -> DownloadSourceState {
    let role = resolution
        .nodes
        .iter()
        .find(|node| node.id == candidate.node_id)
        .map(|node| node.role.as_str())
        .unwrap_or("mirror");
    let source_type = match role {
        "origin" => "origin_node",
        "peer" => "peer_client",
        _ => "mirror_node",
    };

    DownloadSourceState {
        node_id: Some(candidate.node_id.clone()),
        label: candidate.label.clone(),
        source_type: source_type.to_string(),
        route: route.to_string(),
        status: status.to_string(),
        detail,
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

        let prepared = MeshContext::prepare(&client, "gam_1", false, true).await;
        assert!(prepared.context.is_none());
    }

    #[tokio::test]
    async fn an_unreachable_coordinator_falls_back_to_the_origin_silently() {
        // Port 9 is discard; nothing answers. This must read as "no mesh",
        // not as a failed download.
        let client = ApiClient::new("http://localhost:9", None).unwrap();

        let prepared = MeshContext::prepare(&client, "gam_1", true, true).await;
        assert!(prepared.context.is_none());
        assert!(prepared.failure.is_some());
    }
}
