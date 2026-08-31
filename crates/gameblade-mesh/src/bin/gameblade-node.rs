//! The GameBlade node agent.
//!
//! Runs on a machine holding game files. It keeps an authenticated outbound
//! HTTPS poll open to the Coordinator, reads requested 10 MiB chunks, and posts
//! them back over HTTPS. Nodes need no public listener or game-transfer port.
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
    AgentState, CatalogGame, ChunkStore, LibraryChunks, LibraryIndex, RETRY_DELAY,
};
use gameblade_mesh::{
    library_roots, MeshError, MeshResult, NodeIdentity, DEFAULT_STATE_PATH, MULTI_LIBRARY_ROOT,
    UNCONFIGURED_POLL,
};
use serde::Deserialize;
use sha2::Digest;
use tokio::sync::{RwLock, Semaphore};

#[derive(Debug, Deserialize)]
struct Registration {
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "nodeToken")]
    node_token: String,
    #[serde(rename = "heartbeatSeconds", default = "default_heartbeat")]
    heartbeat_seconds: u64,
}

struct Runtime {
    identity: NodeIdentity,
    node_id: String,
    node_token: String,
    index: Arc<RwLock<LibraryIndex>>,
    chunks: Arc<LibraryChunks>,
    heartbeat: Duration,
}

#[derive(Debug, Deserialize)]
struct TransferPoll {
    #[serde(default)]
    jobs: Vec<TransferJob>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferJob {
    request_id: String,
    game_id: String,
    file_id: String,
    chunk_index: u64,
    expected_bytes: usize,
    sha256: String,
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
        match start(&server_url, &state_path).await {
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
    println!("  transfer: outbound HTTPS through the coordinator");

    run(agent, server_url, library_roots, state_path).await;
}

async fn start(server_url: &str, state_path: &std::path::Path) -> MeshResult<Runtime> {
    let mut state = AgentState::load(state_path);
    let identity = state.identity()?;

    // Persist the identity before the first network request. Registration can
    // be refused (a mistyped or expired code is ordinary), and the server
    // process beside this agent reads the shared state for its status page.
    // Waiting until a successful response left that page saying the key had
    // not been generated while the agent retried an error only its container
    // log could see.
    state.save(state_path)?;

    // Already enrolled: use what is there rather than registering again.
    //
    // Registering rotates the node's credential, and in the usual deployment
    // this process is not the only one holding it — the scanner alongside it
    // registered first and wrote this file. Re-registering on every restart
    // would invalidate the token that process is still using and stop its
    // catalog reports, which is a confusing way to break something that looks
    // unrelated.
    if let (Some(node_id), Some(node_token)) = (state.node_id.clone(), state.node_token.clone()) {
        return Ok(assemble(
            identity,
            node_id,
            node_token,
            Duration::from_secs(30),
        ));
    }

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|err| MeshError::Protocol(format!("could not build an HTTP client: {err}")))?;

    // Every registration returns a fresh credential, so the enrolment code is
    // only needed the first time. After that the key is the identity.
    let endpoints: Vec<serde_json::Value> = Vec::new();

    // The environment first, then whatever the setup page wrote. Either way it
    // is spent once and cleared below.
    let enrolment = optional("GAMEBLADE_ENROLMENT")
        .or_else(|| state.enrolment_token.clone())
        .unwrap_or_default();

    let registration = if enrolment.is_empty() {
        // A partially lost state file can retain the private key while losing
        // its replaceable token. Prove that key rather than asking an operator
        // for a second code. An unknown key still needs ordinary enrolment.
        register_with_proof(&http, server_url, &identity)
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
            match register_with_proof(&http, server_url, &identity).await {
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
    state.registration_error = None;
    // Spent. Cleared so it is not sitting on disk being useless, and so a
    // restart cannot look like it still has something to enrol with.
    state.enrolment_token = None;
    // Remembered, so a node pointed at its coordinator through the setup page
    // stays pointed there across restarts without the environment knowing.
    state.coordinator_url = Some(server_url.to_string());
    state.save(state_path)?;

    Ok(assemble(
        identity,
        registration.node_id,
        registration.node_token,
        // Clamped: a coordinator asking for a heartbeat every second would put
        // every node into a hot loop, and one asking for an hour would leave
        // them all listed long after they died.
        Duration::from_secs(registration.heartbeat_seconds.clamp(10, 120)),
    ))
}

/// Build the agent around credentials, however they were obtained.
fn assemble(
    identity: NodeIdentity,
    node_id: String,
    node_token: String,
    heartbeat: Duration,
) -> Runtime {
    let index = Arc::new(RwLock::new(LibraryIndex::new()));
    let chunks = Arc::new(LibraryChunks::new(Arc::clone(&index)));

    Runtime {
        identity,
        node_id,
        node_token,
        index,
        chunks,
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

/// Mark the node alive, optionally replacing its advertised holdings.
///
/// A liveness-only heartbeat deliberately omits `games`: the coordinator then
/// preserves the last accepted catalog while a large library is being checked.
async fn send_heartbeat(
    http: &reqwest::Client,
    server_url: &str,
    identity: &NodeIdentity,
    node_id: &str,
    node_token: &Arc<RwLock<String>>,
    state_path: &std::path::Path,
    games: Option<Vec<serde_json::Value>>,
) {
    let mut body = serde_json::json!({ "endpoints": [] });
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
            match reregister(http, server_url, identity, state_path).await {
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

async fn run(agent: Runtime, server_url: String, library_roots: Vec<PathBuf>, state_path: PathBuf) {
    let http = reqwest::Client::builder()
        // A Node may have a modest upload connection. Eight MiB must not be
        // killed just because it needs more than the old forty-second control
        // request timeout.
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .expect("an HTTP client with only a timeout set always builds");

    let Runtime {
        identity,
        node_id,
        node_token,
        index,
        chunks,
        heartbeat,
    } = agent;

    // The credential rotates; the identity does not.
    //
    // A node is its keypair and the socket that keypair answers on, both of
    // which outlive any particular token — so a rejected credential is
    // replaced in place rather than by tearing the agent down and rebuilding
    // it. Shared because the transfer poll below runs on its own task and must
    // not go on presenting a token this loop has already replaced.
    let node_token = Arc::new(RwLock::new(node_token));

    // Transfer work: one outbound long-poll, with up to eight HTTPS uploads in
    // flight. The Coordinator hands each Desktop range to a Node and streams
    // the verified result onward; there is no listener or path back into this
    // network.
    {
        let http = http.clone();
        let server_url = server_url.clone();
        let node_id = node_id.clone();
        let node_token = Arc::clone(&node_token);
        let chunks = Arc::clone(&chunks);
        let concurrency = Arc::new(Semaphore::new(8));

        tokio::spawn(async move {
            loop {
                // Never claim more work than can start now. The old poll took
                // eight jobs even when eight uploads were already running,
                // leaving claimed requests hidden behind the semaphore until
                // the Coordinator timed them out. Waiting for one slot here
                // keeps every returned job immediately runnable.
                let Ok(slot) = Arc::clone(&concurrency).acquire_owned().await else {
                    return;
                };
                drop(slot);
                let capacity = concurrency.available_permits().clamp(1, 8);
                let token = node_token.read().await.clone();
                let reply = http
                    .get(format!("{server_url}/api/mesh/transfers/poll"))
                    .query(&[("limit", capacity)])
                    .header("authorization", format!("Bearer {token}"))
                    .header("x-gameblade-node", &node_id)
                    .send()
                    .await;

                let jobs = match reply {
                    Ok(response) if response.status().is_success() => response
                        .json::<TransferPoll>()
                        .await
                        .map(|body| body.jobs)
                        .unwrap_or_default(),
                    _ => {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                };

                for job in jobs {
                    let Ok(permit) = Arc::clone(&concurrency).acquire_owned().await else {
                        return;
                    };
                    let http = http.clone();
                    let server_url = server_url.clone();
                    let node_id = node_id.clone();
                    let node_token = Arc::clone(&node_token);
                    let chunks = Arc::clone(&chunks);
                    tokio::spawn(async move {
                        let _permit = permit;
                        deliver_job(&http, &server_url, &node_id, &node_token, &chunks, job).await;
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
            &state_path,
            Some(games),
        )
        .await;
    }
}

async fn deliver_job(
    http: &reqwest::Client,
    server_url: &str,
    node_id: &str,
    node_token: &Arc<RwLock<String>>,
    chunks: &LibraryChunks,
    job: TransferJob,
) {
    let token = node_token.read().await.clone();
    let bytes = chunks
        .read_chunk(&job.game_id, &job.file_id, job.chunk_index)
        .await;

    let valid = bytes.filter(|bytes| {
        bytes.len() == job.expected_bytes
            && hex::encode(sha2::Sha256::digest(bytes)).eq_ignore_ascii_case(&job.sha256)
    });

    if let Some(bytes) = valid {
        let response = http
            .post(format!(
                "{server_url}/api/mesh/transfers/{}",
                job.request_id
            ))
            .header("authorization", format!("Bearer {token}"))
            .header("x-gameblade-node", node_id)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                eprintln!(
                    "the Coordinator refused a requested chunk ({status}): {}",
                    body.chars().take(300).collect::<String>()
                );
            }
            Err(error) => eprintln!("could not upload a requested chunk: {error}"),
        }
    } else {
        let _ = http
            .post(format!(
                "{server_url}/api/mesh/transfers/{}/fail",
                job.request_id
            ))
            .header("authorization", format!("Bearer {token}"))
            .header("x-gameblade-node", node_id)
            .json(&serde_json::json!({ "message": "The requested chunk is no longer readable on this Node" }))
            .send()
            .await;
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
    identity: &NodeIdentity,
    state_path: &std::path::Path,
) -> MeshResult<String> {
    let registration = register_with_proof(http, server_url, identity).await?;

    // Written through so the server process beside this one, which reads the
    // same file, is not left presenting the credential that was just replaced.
    let mut state = AgentState::load(state_path);
    state.node_id = Some(registration.node_id);
    state.node_token = Some(registration.node_token.clone());
    state.registration_error = None;
    state.save(state_path)?;

    Ok(registration.node_token)
}

/** Recover a known registration by proving possession of its private key. */
async fn register_with_proof(
    http: &reqwest::Client,
    server_url: &str,
    identity: &NodeIdentity,
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
            "endpoints": [],
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
