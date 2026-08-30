//! The GameBlade node agent.
//!
//! Runs on a machine holding game files and serves them straight to clients,
//! so those bytes never cross the reverse proxy. Coordination still goes
//! through it — that traffic is kilobytes.
//!
//! Nothing has to be configured for it to start. Every value below has a
//! working default, and the two that cannot — which coordinator, and the code
//! that proves you are allowed to join it — can be answered from the setup page
//! the node serves instead of from a compose file:
//!
//!     GAMEBLADE_SERVER      https://games.example.com   (or from the state file)
//!     GAMEBLADE_LIBRARY     /library                     (or read off the mounts)
//!     GAMEBLADE_ENROLMENT   <code from Admin → Nodes>    (or from the state file)
//!     GAMEBLADE_STATE       /data/node-state.json        (default)
//!     GAMEBLADE_PORT        47820                        (default; 0 for any)
//!
//! An unconfigured agent waits rather than exiting. It is one half of a node
//! and the other half is serving the page somebody is about to fill in, so
//! "not told yet" is a state to sit in, not an error to die of.
//!
//! The enrolment code is spent on first run and cleared from the state file.
//! After that the agent identifies itself with its key, so nothing anywhere
//! needs to keep the code.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use gameblade_mesh::agent::{
    Agent, AgentState, CatalogGame, LibraryChunks, LibraryIndex, RendezvousReply, RETRY_DELAY,
};
use gameblade_mesh::diagnostics::DEFAULT_STUN_SERVERS;
use gameblade_mesh::node::NodeServer;
use gameblade_mesh::transport::MeshEndpoint;
use gameblade_mesh::{
    library_roots, MeshError, MeshResult, DEFAULT_STATE_PATH, MESH_DEFAULT_PORT,
    MULTI_LIBRARY_ROOT, UNCONFIGURED_POLL,
};
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

#[derive(Debug, Deserialize)]
struct RegistrationChallenge {
    challenge: String,
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

fn optional(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
        _ => None,
    }
}

/// Which coordinator to talk to: the environment, else whatever the setup page
/// wrote, else nothing yet.
///
/// Re-read every time round the wait loop rather than captured once, because
/// the whole point is that it can be answered while this process is running.
fn coordinator_url(state_path: &std::path::Path) -> Option<String> {
    optional("GAMEBLADE_SERVER")
        .or_else(|| AgentState::load(state_path).coordinator_url)
        .map(|url| url.trim_end_matches('/').to_string())
}

#[tokio::main]
async fn main() {
    // Several, because a node can hold several disks. Declared with
    // GAMEBLADE_LIBRARY, or read off the mounts when it is not — the same two
    // places the server half beside this process looks, so both halves agree
    // about what this machine holds without either being configured twice.
    let library_roots = library_roots(optional("GAMEBLADE_LIBRARY").as_deref());
    let state_path = PathBuf::from(
        optional("GAMEBLADE_STATE").unwrap_or_else(|| DEFAULT_STATE_PATH.to_string()),
    );
    let port: u16 = optional("GAMEBLADE_PORT")
        .and_then(|value| value.parse().ok())
        .unwrap_or(MESH_DEFAULT_PORT);

    println!("GameBlade node agent");
    if library_roots.is_empty() {
        println!("  library: (none found)");
    } else {
        for root in &library_roots {
            println!("  library: {}", root.display());
        }
    }
    println!("  state:   {}", state_path.display());

    if library_roots.is_empty() {
        // Not fatal, and deliberately so: the library is a volume mount, and a
        // compose file whose mount is wrong is fixed by editing the compose
        // file — which is a great deal easier to do against a node that is
        // running and saying what is wrong than against one in a crash loop.
        eprintln!(
            "  warning: nothing is mounted at /library, and {MULTI_LIBRARY_ROOT} is empty. \
             Mount the games at one of those, read-only; nothing can be served until you do."
        );
    }

    // Wait to be told, rather than exiting for want of an answer.
    //
    // The other half of this node is already serving its setup page, and the
    // whole design is that somebody fills that in. Exiting here would take the
    // container down in a restart loop underneath the page they are typing
    // into.
    let server_url = {
        let mut waited = 0u64;
        loop {
            if let Some(url) = coordinator_url(&state_path) {
                break url;
            }
            // Said once, then once a minute. The poll is a small file read and
            // wants to be frequent — somebody is at the setup page waiting for
            // this to notice — but a node left unconfigured overnight should
            // not write twenty thousand identical lines about it.
            if waited % 20 == 0 {
                println!(
                    "  waiting: no coordinator set yet — set one on this node's page, or in GAMEBLADE_SERVER"
                );
            }
            waited += 1;
            tokio::time::sleep(UNCONFIGURED_POLL).await;
        }
    };

    println!("  server:  {server_url}");

    // Retried rather than fatal, for the same reason: a coordinator that is
    // down, or an agent that came up before the server beside it, is a wait
    // rather than a crash.
    let agent = loop {
        match start(&server_url, &state_path, port).await {
            Ok(agent) => break agent,
            Err(err) => {
                let mut state = AgentState::load(&state_path);
                state.registration_error = Some(err.to_string());
                if let Err(save_err) = state.save(&state_path) {
                    eprintln!("could not write the registration error to node state: {save_err}");
                }
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

    run(agent, server_url, library_roots, state_path).await;
}

async fn start(server_url: &str, state_path: &std::path::Path, port: u16) -> MeshResult<Agent> {
    let mut state = AgentState::load(state_path);
    let identity = state.identity()?;

    // Persist the identity before the first network request. Registration can
    // be refused (a mistyped or expired code is ordinary), and the server
    // process beside this agent reads the shared state for its status page.
    // Waiting until a successful response left that page saying the key had
    // not been generated while the agent retried an error only its container
    // log could see.
    state.save(state_path)?;

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

    // The environment first, then whatever the setup page wrote. Either way it
    // is spent once and cleared below.
    let enrolment = optional("GAMEBLADE_ENROLMENT")
        .or_else(|| state.enrolment_token.clone())
        .unwrap_or_default();

    let registration = if enrolment.is_empty() {
        // A partially lost state file can retain the private key while losing
        // its replaceable token. Prove that key rather than asking an operator
        // for a second code. An unknown key still needs ordinary enrolment.
        register_with_proof(&http, server_url, &identity, &endpoints)
            .await
            .map_err(|_| {
                MeshError::Refused(
                    "no enrolment code: paste one from Admin → Nodes into this node's setup page"
                        .into(),
                )
            })?
    } else {
        let body = serde_json::json!({
            "enrolmentToken": enrolment,
            "publicKey": identity.public_key_base64(),
            "agentVersion": env!("CARGO_PKG_VERSION"),
            "endpoints": &endpoints,
        });

        let response = http
            .post(format!("{server_url}/api/mesh/register"))
            .json(&body)
            .send()
            .await
            .map_err(|err| MeshError::Unreachable(format!("registering: {err}")))?;

        if response.status().is_success() {
            response
                .json()
                .await
                .map_err(|err| MeshError::Protocol(format!("registration reply: {err}")))?
        } else {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();

            // The key may already be registered even though this process has
            // only the old one-time code. A proof recovers that same node; an
            // unknown key preserves the coordinator's useful enrolment error.
            match register_with_proof(&http, server_url, &identity, &endpoints).await {
                Ok(registration) => registration,
                Err(_) => {
                    return Err(MeshError::Refused(format!(
                        "registration refused ({status}): {text}"
                    )))
                }
            }
        }
    };

    state.node_id = Some(registration.node_id.clone());
    state.node_token = Some(registration.node_token.clone());
    state.coordinator_key = Some(registration.coordinator_public_key.clone());
    state.registration_error = None;
    // Spent. Cleared so it is not sitting on disk being useless, and so a
    // restart cannot look like it still has something to enrol with.
    state.enrolment_token = None;
    // Remembered, so a node pointed at its coordinator through the setup page
    // stays pointed there across restarts without the environment knowing.
    state.coordinator_url = Some(server_url.to_string());
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

/// Whether the coordinator has just told us this credential is no longer good.
///
/// 401 and 403 are the two ways it says so: the node was deleted, its token was
/// rotated by a registration somewhere else, or an operator blocked and then
/// unblocked it. Every one of those is recoverable without a human, because the
/// key in the state file is the identity and registering again with it is how a
/// node says "still me".
fn credential_rejected(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN
}

fn advertised_endpoints(endpoint: &MeshEndpoint) -> Vec<serde_json::Value> {
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
    endpoints
}

/// Mark the node alive, optionally replacing its advertised holdings.
///
/// A liveness-only heartbeat deliberately omits `games`: the coordinator then
/// preserves the last accepted catalog while a large library is being checked.
#[allow(clippy::too_many_arguments)]
async fn send_heartbeat(
    http: &reqwest::Client,
    server_url: &str,
    identity: &gameblade_mesh::NodeIdentity,
    node_id: &str,
    node_token: &Arc<RwLock<String>>,
    endpoint: &MeshEndpoint,
    state_path: &std::path::Path,
    games: Option<Vec<serde_json::Value>>,
) {
    let mut body = serde_json::json!({ "endpoints": advertised_endpoints(endpoint) });
    if let Some(games) = games {
        body["games"] = serde_json::Value::Array(games);
    }

    let token = node_token.read().await.clone();
    let sent = http
        .post(format!("{server_url}/api/mesh/heartbeat"))
        .header("authorization", format!("Bearer {token}"))
        .header("x-gameblade-node", node_id)
        .json(&body)
        .send()
        .await;

    match sent {
        Ok(response) if response.status().is_success() => {}
        Ok(response) if credential_rejected(response.status()) => {
            eprintln!(
                "the coordinator rejected this node's credential ({}); registering again",
                response.status()
            );
            match reregister(http, server_url, identity, endpoint, state_path).await {
                Ok(fresh) => {
                    *node_token.write().await = fresh;
                    println!("re-registered; the node is listed again");
                }
                Err(err) => eprintln!("could not register again: {err}"),
            }
        }
        Ok(response) => eprintln!("heartbeat refused: {}", response.status()),
        Err(err) => eprintln!("heartbeat did not reach the coordinator: {err}"),
    }
}

async fn run(agent: Agent, server_url: String, library_roots: Vec<PathBuf>, state_path: PathBuf) {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .expect("an HTTP client with only a timeout set always builds");

    let Agent {
        identity,
        node_id,
        node_token,
        endpoint,
        index,
        server,
        heartbeat,
        ..
    } = agent;

    let endpoint = Arc::new(endpoint);

    // The credential rotates; the identity does not.
    //
    // A node is its keypair and the socket that keypair answers on, both of
    // which outlive any particular token — so a rejected credential is
    // replaced in place rather than by tearing the agent down and rebuilding
    // it. Shared because the rendezvous poll below runs on its own task and
    // must not go on presenting a token this loop has already replaced.
    let node_token = Arc::new(RwLock::new(node_token));

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
        let node_token = Arc::clone(&node_token);
        let endpoint = Arc::clone(&endpoint);

        tokio::spawn(async move {
            loop {
                // Read per poll, so a token replaced by the heartbeat loop is
                // picked up on the next one rather than at the next restart.
                let token = node_token.read().await.clone();
                let reply = http
                    .get(format!("{server_url}/api/mesh/rendezvous"))
                    .header("authorization", format!("Bearer {token}"))
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

        // The first tick is immediate, so an already-enrolled node becomes
        // Active as soon as its process starts. Do this before the catalog
        // refresh: validating a large archive can take minutes and liveness
        // must not wait behind disk work.
        send_heartbeat(
            &http,
            &server_url,
            &identity,
            &node_id,
            &node_token,
            &endpoint,
            &state_path,
            None,
        )
        .await;

        // Refresh what this machine actually holds, then announce it. Done on
        // the heartbeat rather than once at startup so a library that gains a
        // game becomes servable without restarting anything.
        refresh(
            &http,
            &server_url,
            &node_id,
            &node_token.read().await.clone(),
            &library_roots,
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

        send_heartbeat(
            &http,
            &server_url,
            &identity,
            &node_id,
            &node_token,
            &endpoint,
            &state_path,
            Some(games),
        )
        .await;

        // Report what was served, so transfer allowances still mean something
        // when the bytes never crossed the server. A rejection here needs no
        // handling of its own: the next heartbeat is thirty seconds away and
        // deals with it, and the ledger keeps the report until it lands.
        let token = node_token.read().await.clone();
        let pending = server.ledger().lock().await.pending_reports();
        for (nonce, bytes) in pending {
            let _ = http
                .post(format!("{server_url}/api/mesh/report"))
                .header("authorization", format!("Bearer {token}"))
                .header("x-gameblade-node", &node_id)
                .json(&serde_json::json!({ "nonce": nonce, "bytesServed": bytes }))
                .send()
                .await;
        }
    }
}

/// Present this node's key again and take the credential that comes back.
///
/// Not enrolment: the coordinator matches on the public key, challenges this
/// process to prove it owns the private half, and issues a fresh token. No
/// enrolment code is involved or kept.
async fn reregister(
    http: &reqwest::Client,
    server_url: &str,
    identity: &gameblade_mesh::NodeIdentity,
    endpoint: &MeshEndpoint,
    state_path: &std::path::Path,
) -> MeshResult<String> {
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

    let registration = register_with_proof(http, server_url, identity, &endpoints).await?;

    // Written through so the server process beside this one, which reads the
    // same file, is not left presenting the credential that was just replaced.
    let mut state = AgentState::load(state_path);
    state.node_id = Some(registration.node_id);
    state.node_token = Some(registration.node_token.clone());
    state.coordinator_key = Some(registration.coordinator_public_key);
    state.registration_error = None;
    state.save(state_path)?;

    Ok(registration.node_token)
}

/** Recover a known registration by proving possession of its private key. */
async fn register_with_proof(
    http: &reqwest::Client,
    server_url: &str,
    identity: &gameblade_mesh::NodeIdentity,
    endpoints: &[serde_json::Value],
) -> MeshResult<Registration> {
    let public_key = identity.public_key_base64();
    let response = http
        .get(format!("{server_url}/api/mesh/register/challenge"))
        .query(&[("publicKey", public_key.as_str())])
        .send()
        .await
        .map_err(|err| MeshError::Unreachable(format!("requesting key challenge: {err}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(MeshError::Refused(format!(
            "key challenge refused ({status}): {body}"
        )));
    }

    let challenge: RegistrationChallenge = response
        .json()
        .await
        .map_err(|err| MeshError::Protocol(format!("key challenge reply: {err}")))?;
    let message = format!("gameblade-register-v1:{public_key}:{}", challenge.challenge);
    let signature = URL_SAFE_NO_PAD.encode(identity.sign(message.as_bytes()));

    let response = http
        .post(format!("{server_url}/api/mesh/register"))
        .json(&serde_json::json!({
            "publicKey": public_key,
            "agentVersion": env!("CARGO_PKG_VERSION"),
            "endpoints": endpoints,
            "proof": {
                "challenge": challenge.challenge,
                "signature": signature,
            },
        }))
        .send()
        .await
        .map_err(|err| MeshError::Unreachable(format!("re-registering: {err}")))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(MeshError::Refused(format!("({status}): {body}")));
    }

    response
        .json()
        .await
        .map_err(|err| MeshError::Protocol(format!("registration reply: {err}")))
}

/// Rebuild the index of what this machine can serve.
async fn refresh(
    http: &reqwest::Client,
    server_url: &str,
    node_id: &str,
    node_token: &str,
    library_roots: &[PathBuf],
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

        rebuilt.offer_from_roots(library_roots, &game);
    }

    let held = rebuilt.len();
    *index.write().await = rebuilt;

    // Only worth a line when it changed. This runs on a timer, and a node that
    // is working prints the same number for ever otherwise.
    if reused != held {
        println!("library: holding {held} game(s) the coordinator knows about");
    }
}
