//! The GameBlade node agent.
//!
//! Runs on a machine holding game files and serves them straight to clients,
//! so those bytes never cross the reverse proxy. Coordination still goes
//! through it — that traffic is kilobytes.
//!
//! Configured entirely by environment, because it is meant to sit in a compose
//! file next to the server:
//!
//!     GAMEBLADE_SERVER      https://games.example.com   (required)
//!     GAMEBLADE_LIBRARY     /library                     (required, read-only)
//!     GAMEBLADE_ENROLMENT   <code from Admin → Nodes>    (first run only)
//!     GAMEBLADE_STATE       /data/node-state.json        (default)
//!     GAMEBLADE_PORT        47820                        (default; 0 for any)
//!
//! The enrolment code is spent on first run. After that the agent identifies
//! itself with the key in its state file, so the code can be removed from the
//! environment and does not need to be kept anywhere.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gameblade_mesh::agent::{
    Agent, AgentState, CatalogGame, LibraryChunks, LibraryIndex, RendezvousReply, RETRY_DELAY,
};
use gameblade_mesh::diagnostics::DEFAULT_STUN_SERVERS;
use gameblade_mesh::node::NodeServer;
use gameblade_mesh::transport::MeshEndpoint;
use gameblade_mesh::{MeshError, MeshResult, MESH_DEFAULT_PORT};
use serde::Deserialize;
use tokio::sync::RwLock;

#[derive(Debug, Deserialize)]
struct Registration {
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "nodeToken")]
    node_token: String,
    #[serde(rename = "coordinatorPublicKey")]
    coordinator_public_key: String,
    #[serde(rename = "heartbeatSeconds", default = "default_heartbeat")]
    heartbeat_seconds: u64,
}

fn default_heartbeat() -> u64 {
    30
}

#[derive(Debug, Deserialize)]
struct CatalogList {
    games: Vec<CatalogEntry>,
}

#[derive(Debug, Deserialize)]
struct CatalogEntry {
    #[serde(rename = "gameId")]
    game_id: String,
    /// Changes whenever the game's contents do, which is what lets an index
    /// entry be reused instead of rebuilt.
    #[serde(rename = "contentHash")]
    content_hash: Option<String>,
}

fn required(name: &str) -> String {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            eprintln!("{name} must be set. See the comment at the top of this binary.");
            std::process::exit(2);
        }
    }
}

#[tokio::main]
async fn main() {
    let server_url = required("GAMEBLADE_SERVER")
        .trim_end_matches('/')
        .to_string();
    let library_root = PathBuf::from(required("GAMEBLADE_LIBRARY"));
    let state_path = PathBuf::from(
        std::env::var("GAMEBLADE_STATE").unwrap_or_else(|_| "/data/node-state.json".to_string()),
    );
    let port: u16 = std::env::var("GAMEBLADE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(MESH_DEFAULT_PORT);

    if !library_root.is_dir() {
        eprintln!(
            "GAMEBLADE_LIBRARY is not a directory: {}",
            library_root.display()
        );
        std::process::exit(2);
    }

    println!("GameBlade node agent");
    println!("  server:  {server_url}");
    println!("  library: {}", library_root.display());

    // Retried rather than fatal: an agent starting alongside the server in a
    // compose file will routinely come up first, and exiting would make that a
    // crash loop instead of a wait.
    let agent = loop {
        match start(&server_url, &state_path, port).await {
            Ok(agent) => break agent,
            Err(err) => {
                eprintln!(
                    "could not start: {err}; retrying in {}s",
                    RETRY_DELAY.as_secs()
                );
                tokio::time::sleep(RETRY_DELAY).await;
            }
        }
    };

    println!("  node:    {}", agent.node_id);
    match agent.endpoint.local_addr() {
        Ok(address) => println!("  serving: {address}"),
        Err(_) => println!("  serving: (unknown)"),
    }
    if let Some(reflexive) = agent.endpoint.reflexive_addr() {
        println!("  seen as: {reflexive}");
    } else {
        println!("  seen as: (could not determine — clients may not reach this node)");
    }

    run(agent, server_url, library_root).await;
}

async fn start(server_url: &str, state_path: &std::path::Path, port: u16) -> MeshResult<Agent> {
    let mut state = AgentState::load(state_path);
    let identity = state.identity()?;

    let stun: Vec<&str> = DEFAULT_STUN_SERVERS.to_vec();
    let endpoint = MeshEndpoint::node_with_discovery(identity.clone(), port, &stun)?;

    // Already enrolled: use what is there rather than registering again.
    //
    // Registering rotates the node's credential, and in the usual deployment
    // this process is not the only one holding it — the scanner alongside it
    // registered first and wrote this file. Re-registering on every restart
    // would invalidate the token that process is still using and stop its
    // catalog reports, which is a confusing way to break something that looks
    // unrelated.
    if let (Some(node_id), Some(node_token), Some(coordinator)) = (
        state.node_id.clone(),
        state.node_token.clone(),
        state.coordinator(),
    ) {
        return Ok(assemble(
            identity,
            node_id,
            node_token,
            coordinator,
            endpoint,
            Duration::from_secs(30),
        ));
    }

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|err| MeshError::Protocol(format!("could not build an HTTP client: {err}")))?;

    // Every registration returns a fresh credential, so the enrolment code is
    // only needed the first time. After that the key is the identity.
    let mut endpoints = Vec::new();
    if let Ok(local) = endpoint.local_addr() {
        endpoints.push(serde_json::json!({
            "kind": "local",
            "address": local.ip().to_string(),
            "port": local.port(),
        }));
    }
    if let Some(reflexive) = endpoint.reflexive_addr() {
        endpoints.push(serde_json::json!({
            "kind": "observed",
            "address": reflexive.ip().to_string(),
            "port": reflexive.port(),
        }));
    }

    let body = serde_json::json!({
        "enrolmentToken": std::env::var("GAMEBLADE_ENROLMENT").unwrap_or_default(),
        "publicKey": identity.public_key_base64(),
        "agentVersion": env!("CARGO_PKG_VERSION"),
        "endpoints": endpoints,
    });

    let response = http
        .post(format!("{server_url}/api/mesh/register"))
        .json(&body)
        .send()
        .await
        .map_err(|err| MeshError::Unreachable(format!("registering: {err}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(MeshError::Refused(format!(
            "registration refused ({status}): {text}"
        )));
    }

    let registration: Registration = response
        .json()
        .await
        .map_err(|err| MeshError::Protocol(format!("registration reply: {err}")))?;

    state.node_id = Some(registration.node_id.clone());
    state.node_token = Some(registration.node_token.clone());
    state.coordinator_key = Some(registration.coordinator_public_key.clone());
    state.save(state_path)?;

    let coordinator = state
        .coordinator()
        .ok_or_else(|| MeshError::Identity("the coordinator published an unusable key".into()))?;

    Ok(assemble(
        identity,
        registration.node_id,
        registration.node_token,
        coordinator,
        endpoint,
        // Clamped: a coordinator asking for a heartbeat every second would put
        // every node into a hot loop, and one asking for an hour would leave
        // them all listed long after they died.
        Duration::from_secs(registration.heartbeat_seconds.clamp(10, 120)),
    ))
}

/// Build the agent around credentials, however they were obtained.
fn assemble(
    identity: gameblade_mesh::NodeIdentity,
    node_id: String,
    node_token: String,
    coordinator: gameblade_mesh::PublicKey,
    endpoint: MeshEndpoint,
    heartbeat: Duration,
) -> Agent {
    let index = Arc::new(RwLock::new(LibraryIndex::new()));
    let store = Arc::new(LibraryChunks::new(Arc::clone(&index)));
    let server = Arc::new(NodeServer::new(node_id.clone(), store, coordinator));

    Agent {
        identity,
        node_id,
        node_token,
        coordinator_key: coordinator,
        endpoint,
        index,
        server,
        heartbeat,
    }
}

async fn run(agent: Agent, server_url: String, library_root: PathBuf) {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .expect("an HTTP client with only a timeout set always builds");

    let Agent {
        node_id,
        node_token,
        endpoint,
        index,
        server,
        heartbeat,
        ..
    } = agent;

    let endpoint = Arc::new(endpoint);

    // Accept: clients connecting, one chunk per stream.
    {
        let endpoint = Arc::clone(&endpoint);
        let server = Arc::clone(&server);
        tokio::spawn(async move {
            while let Some(incoming) = endpoint.inner().accept().await {
                let server = Arc::clone(&server);
                tokio::spawn(async move {
                    if let Ok(connection) = incoming.await {
                        server.serve(connection).await;
                    }
                });
            }
        });
    }

    // Rendezvous: held open, answered the instant a client asks for this node.
    //
    // This is what makes hole punching work at all. Both ends have to send at
    // roughly the same moment, and this node has no other way to know a client
    // exists before that client tries to connect — which it cannot do until
    // this punch has opened the way.
    {
        let http = http.clone();
        let server_url = server_url.clone();
        let node_id = node_id.clone();
        let node_token = node_token.clone();
        let endpoint = Arc::clone(&endpoint);

        tokio::spawn(async move {
            loop {
                let reply = http
                    .get(format!("{server_url}/api/mesh/rendezvous"))
                    .header("authorization", format!("Bearer {node_token}"))
                    .header("x-gameblade-node", &node_id)
                    .send()
                    .await;

                let punches = match reply {
                    Ok(response) if response.status().is_success() => response
                        .json::<RendezvousReply>()
                        .await
                        .map(|body| body.punches)
                        .unwrap_or_default(),
                    // A poll that times out or fails is ordinary — the whole
                    // point is a long-held request — so reconnect rather than
                    // treating it as an error.
                    _ => {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                };

                for punch in punches {
                    let Some(target) =
                        gameblade_mesh::agent::socket_address(&punch.address, punch.port)
                    else {
                        continue;
                    };
                    let endpoint = Arc::clone(&endpoint);

                    // Concurrently: several clients can be arriving at once and
                    // each of these takes a moment of deliberate spacing.
                    tokio::spawn(async move {
                        match punch.relay {
                            // The client could not reach us directly and has
                            // gone to the relay. Announce ourselves there so it
                            // can pair the two of us; QUIC then runs over the
                            // top exactly as it would have directly.
                            Some(relay) => {
                                let _ = endpoint.announce_to_relay(target, &relay.ticket).await;
                            }
                            None => {
                                let _ = endpoint.punch(target).await;
                            }
                        }
                    });
                }
            }
        });
    }

    // Heartbeat: stay listed, and say what is on offer.
    let mut interval = tokio::time::interval(heartbeat);
    loop {
        interval.tick().await;

        // Refresh what this machine actually holds, then announce it. Done on
        // the heartbeat rather than once at startup so a library that gains a
        // game becomes servable without restarting anything.
        refresh(
            &http,
            &server_url,
            &node_id,
            &node_token,
            &library_root,
            &index,
        )
        .await;

        let games: Vec<serde_json::Value> = index
            .read()
            .await
            .announcements()
            .into_iter()
            .map(|(game_id, content_hash)| {
                serde_json::json!({ "gameId": game_id, "contentHash": content_hash })
            })
            .collect();

        let mut endpoints = Vec::new();
        if let Ok(local) = endpoint.local_addr() {
            endpoints.push(serde_json::json!({
                "kind": "local",
                "address": local.ip().to_string(),
                "port": local.port(),
            }));
        }
        if let Some(reflexive) = endpoint.reflexive_addr() {
            endpoints.push(serde_json::json!({
                "kind": "observed",
                "address": reflexive.ip().to_string(),
                "port": reflexive.port(),
            }));
        }

        let sent = http
            .post(format!("{server_url}/api/mesh/heartbeat"))
            .header("authorization", format!("Bearer {node_token}"))
            .header("x-gameblade-node", &node_id)
            .json(&serde_json::json!({ "endpoints": endpoints, "games": games }))
            .send()
            .await;

        if let Ok(response) = sent {
            if !response.status().is_success() {
                eprintln!("heartbeat refused: {}", response.status());
            }
        }

        // Report what was served, so transfer allowances still mean something
        // when the bytes never crossed the server.
        let pending = server.ledger().lock().await.pending_reports();
        for (nonce, bytes) in pending {
            let _ = http
                .post(format!("{server_url}/api/mesh/report"))
                .header("authorization", format!("Bearer {node_token}"))
                .header("x-gameblade-node", &node_id)
                .json(&serde_json::json!({ "nonce": nonce, "bytesServed": bytes }))
                .send()
                .await;
        }
    }
}

/// Rebuild the index of what this machine can serve.
async fn refresh(
    http: &reqwest::Client,
    server_url: &str,
    node_id: &str,
    node_token: &str,
    library_root: &std::path::Path,
    index: &Arc<RwLock<LibraryIndex>>,
) {
    let listed = http
        .get(format!("{server_url}/api/mesh/catalog"))
        .header("authorization", format!("Bearer {node_token}"))
        .header("x-gameblade-node", node_id)
        .send()
        .await;

    let Ok(response) = listed else { return };
    if !response.status().is_success() {
        return;
    }
    let Ok(catalog) = response.json::<CatalogList>().await else {
        return;
    };

    // Taken out rather than borrowed: entries that survive are moved across
    // into the new index, and whatever is left behind is what this node has
    // stopped holding.
    let mut previous = std::mem::take(&mut *index.write().await);

    let mut rebuilt = LibraryIndex::new();
    let mut reused = 0usize;

    for entry in catalog.games {
        // Unchanged since the last pass: the fingerprint the coordinator is
        // announcing is the one this index already verified a copy against.
        // Nothing about the files can have moved without that changing, so
        // re-fetching the layout and re-stat-ing every file would confirm what
        // is already known. On a large library this is the difference between
        // a request per game every refresh and one request in total.
        if entry
            .content_hash
            .as_deref()
            .is_some_and(|hash| previous.content_hash(&entry.game_id) == Some(hash))
            && rebuilt.carry_over(&mut previous, &entry.game_id)
        {
            reused += 1;
            continue;
        }

        let detail = http
            .get(format!("{server_url}/api/mesh/catalog/{}", entry.game_id))
            .header("authorization", format!("Bearer {node_token}"))
            .header("x-gameblade-node", node_id)
            .send()
            .await;

        let Ok(response) = detail else { continue };
        if !response.status().is_success() {
            continue;
        }
        let Ok(game) = response.json::<CatalogGame>().await else {
            continue;
        };

        rebuilt.offer(library_root, &game);
    }

    let held = rebuilt.len();
    *index.write().await = rebuilt;

    // Only worth a line when it changed. This runs on a timer, and a node that
    // is working prints the same number for ever otherwise.
    if reused != held {
        println!("library: holding {held} game(s) the coordinator knows about");
    }
}
