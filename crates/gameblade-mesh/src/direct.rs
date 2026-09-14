//! Serving verified chunks straight to a client, when the machine can be reached.
//!
//! Every transfer used to go the same way: the Desktop asked the Coordinator,
//! the Coordinator asked a Node over its outbound connection, the Node uploaded
//! the chunk, and the Coordinator streamed it onward. That is the only thing
//! that works for a machine behind a home router, and it costs the
//! Coordinator's uplink twice for every byte — which on a small VPS is the
//! ceiling on everybody's downloads.
//!
//! A Node with an address of its own does not need that hop. This is the
//! listener it answers on: a very small HTTP/1.1 server that serves one thing,
//! to clients carrying a grant the Coordinator signed.
//!
//! Three properties make it safe to expose:
//!
//! * **It serves nothing without a grant.** Grants are Ed25519-signed by the
//!   Coordinator, name this node and one file, and expire in minutes. The node
//!   holds only the Coordinator's *public* key, so it can check one and can
//!   never mint one.
//! * **It cannot be made to read anything else.** A request names a chunk index
//!   of the file the grant names. No path from a request ever reaches the
//!   filesystem — the index maps ids to absolute paths and nothing else does.
//! * **The bytes are checked on the way out.** The chunk store hashes what it
//!   read before returning it, so a bit-rotted copy is a refusal rather than a
//!   download that fails its verification an hour later.
//!
//! Written directly on tokio rather than on a web framework. The whole surface
//! is three GET routes with no bodies, no cookies, no sessions and no
//! templates; a framework would be the largest dependency in a binary whose job
//! is to move bytes off a disk.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

use crate::agent::ChunkStore;
use crate::MESH_CHUNK_BYTES;

/// Where chunks are requested, matching `MESH_DIRECT_CHUNK_PATH` on the server.
pub const CHUNK_PATH: &str = "/gb/v1/chunk";
/// Where a client measures this link, matching `MESH_DIRECT_PROBE_PATH`.
pub const PROBE_PATH: &str = "/gb/v1/probe";
/// Unauthenticated liveness, so "is the port even open" is answerable.
pub const HEALTH_PATH: &str = "/gb/v1/health";

/// Largest request head accepted. A GET with no body needs a fraction of this.
const MAX_HEAD_BYTES: usize = 8 * 1024;

/// How long a client has to send its request line before the socket is dropped.
const HEAD_TIMEOUT: Duration = Duration::from_secs(15);

/// A grant issued by the Coordinator, as the node reads it back.
///
/// Deliberately a separate type from anything the agent sends upward: this is
/// parsed from bytes a stranger supplied, and the only thing it is trusted for
/// after the signature checks out is naming a file this node already holds.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantClaims {
    pub v: u8,
    pub node_id: String,
    pub game_id: String,
    pub file_id: String,
    #[serde(default)]
    pub user_id: String,
    /// Seconds since the epoch.
    pub expires_at: i64,
}

/// Why a grant was refused. Kept apart so the reasons can be counted and
/// logged without a string comparison, and so the client is told which of them
/// is worth retrying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantError {
    /// This node has not been told the Coordinator's key yet.
    NoKey,
    Malformed,
    BadSignature,
    Expired,
    /// Addressed to a different node. Presenting it here proves nothing.
    WrongNode,
}

impl GrantError {
    fn status(self) -> u16 {
        match self {
            // Not the client's fault and worth retrying: the agent asks for the
            // key on every heartbeat, so this heals on its own within seconds.
            GrantError::NoKey => 503,
            GrantError::Malformed | GrantError::BadSignature | GrantError::WrongNode => 403,
            GrantError::Expired => 401,
        }
    }

    fn message(self) -> &'static str {
        match self {
            GrantError::NoKey => "this node has not yet received the coordinator's key",
            GrantError::Malformed => "malformed grant",
            GrantError::BadSignature => "invalid grant",
            GrantError::Expired => "expired grant",
            GrantError::WrongNode => "grant is for another node",
        }
    }
}

/// What this listener has done, for the node's own status page.
#[derive(Debug, Default)]
pub struct DirectStats {
    pub requests: AtomicU64,
    pub bytes_served: AtomicU64,
    pub refused: AtomicU64,
}

/// The node's half of direct delivery: a key, an index, and a counter.
pub struct DirectServer {
    node_id: String,
    chunks: Arc<dyn ChunkStore>,
    /// The Coordinator's Ed25519 public key, once it has sent one.
    ///
    /// Behind a lock because it arrives on a heartbeat and can change: rotating
    /// the Coordinator's key must not need every node restarted.
    key: RwLock<Option<VerifyingKey>>,
    stats: Arc<DirectStats>,
}

impl DirectServer {
    pub fn new(node_id: String, chunks: Arc<dyn ChunkStore>, stats: Arc<DirectStats>) -> Self {
        Self {
            node_id,
            chunks,
            key: RwLock::new(None),
            stats,
        }
    }

    /// Accept the Coordinator's public key, in the form it publishes it.
    ///
    /// That form is base64url SPKI DER: a fixed twelve-byte header naming the
    /// algorithm, then the thirty-two key bytes. The raw key is also accepted
    /// so that a hand-configured value, or a future Coordinator that publishes
    /// the bare key, does not need a code change on every node in the fleet.
    pub async fn set_coordinator_key(&self, encoded: &str) -> bool {
        let Ok(raw) = URL_SAFE_NO_PAD.decode(encoded.trim()) else {
            return false;
        };

        let key_bytes: [u8; 32] = match raw.len() {
            32 => match raw.as_slice().try_into() {
                Ok(bytes) => bytes,
                Err(_) => return false,
            },
            44 => match raw[12..].try_into() {
                Ok(bytes) => bytes,
                Err(_) => return false,
            },
            _ => return false,
        };

        match VerifyingKey::from_bytes(&key_bytes) {
            Ok(key) => {
                *self.key.write().await = Some(key);
                true
            }
            Err(_) => false,
        }
    }

    pub async fn has_key(&self) -> bool {
        self.key.read().await.is_some()
    }

    /// Check a grant and return what it permits.
    ///
    /// The signature is over the encoded payload exactly as it appears in the
    /// token, so nothing here has to agree with the Coordinator about how JSON
    /// is serialised — only about which bytes were signed.
    pub async fn verify_grant(&self, token: &str) -> Result<GrantClaims, GrantError> {
        let key = { *self.key.read().await }.ok_or(GrantError::NoKey)?;

        // `v2.` marks a token signed with the Ed25519 key rather than the older
        // HMAC secret. A node has never been able to check an HMAC token — it
        // does not hold that secret and must not — so anything else is refused.
        let body = token.strip_prefix("v2.").ok_or(GrantError::Malformed)?;
        let (payload, signature) = body.split_once('.').ok_or(GrantError::Malformed)?;

        let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| GrantError::Malformed)?
            .as_slice()
            .try_into()
            .map_err(|_| GrantError::Malformed)?;

        key.verify_strict(payload.as_bytes(), &Signature::from_bytes(&signature_bytes))
            .map_err(|_| GrantError::BadSignature)?;

        let decoded = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| GrantError::Malformed)?;
        let claims: GrantClaims =
            serde_json::from_slice(&decoded).map_err(|_| GrantError::Malformed)?;

        if claims.v != 1 {
            return Err(GrantError::Malformed);
        }
        if claims.node_id != self.node_id {
            return Err(GrantError::WrongNode);
        }
        if claims.expires_at <= now_seconds() {
            return Err(GrantError::Expired);
        }

        Ok(claims)
    }
}

/// Seconds since the epoch. A clock before 1970 is a broken clock, not a date.
fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0)
}

/* ------------------------------------------------------------------ serving */

/// Answer direct requests until the process ends.
///
/// One task per connection, and nothing shared between them but the index and
/// a counter. A node's uplink is the limit on how many of these can be useful
/// at once, so there is no pool: the operating system's accept queue already
/// does that job, and better.
pub async fn serve(listener: TcpListener, server: Arc<DirectServer>) {
    loop {
        let Ok((stream, _peer)) = listener.accept().await else {
            // A transient accept failure (a descriptor limit, a connection
            // reset between the SYN and the accept) is not a reason to stop
            // serving; a tight loop on it would be.
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };

        let server = Arc::clone(&server);
        tokio::spawn(async move {
            if let Err(err) = handle(stream, server).await {
                tracing::debug!("direct request ended: {err}");
            }
        });
    }
}

async fn handle(mut stream: TcpStream, server: Arc<DirectServer>) -> std::io::Result<()> {
    let Some(request) = read_request(&mut stream).await? else {
        return write_response(&mut stream, 400, "text/plain", b"bad request").await;
    };

    server.stats.requests.fetch_add(1, Ordering::Relaxed);

    // GET only, deliberately. Nothing here has anything to accept.
    if request.method != "GET" {
        return write_response(&mut stream, 405, "text/plain", b"method not allowed").await;
    }

    match request.path.as_str() {
        HEALTH_PATH => {
            let ready = server.has_key().await;
            let body = format!(
                "{{\"ok\":true,\"node\":\"{}\",\"ready\":{}}}",
                escape_json(&server.node_id),
                ready
            );
            write_response(&mut stream, 200, "application/json", body.as_bytes()).await
        }
        CHUNK_PATH => serve_chunk(&mut stream, &server, &request).await,
        PROBE_PATH => serve_probe(&mut stream, &server, &request).await,
        _ => write_response(&mut stream, 404, "text/plain", b"not found").await,
    }
}

async fn serve_chunk(
    stream: &mut TcpStream,
    server: &Arc<DirectServer>,
    request: &Request,
) -> std::io::Result<()> {
    let claims = match authorise(stream, server, request).await? {
        Some(claims) => claims,
        None => return Ok(()),
    };

    let Some(index) = request
        .query
        .get("index")
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return write_response(stream, 400, "text/plain", b"a chunk index is required").await;
    };

    let Some(bytes) = server
        .chunks
        .read_chunk(&claims.game_id, &claims.file_id, index)
        .await
    else {
        // Either this node does not hold that game any more, or the bytes on
        // disk no longer hash to what was announced. Both mean the same thing
        // to a client — ask somebody else — and neither is worth distinguishing
        // to a stranger.
        server.stats.refused.fetch_add(1, Ordering::Relaxed);
        return write_response(stream, 404, "text/plain", b"chunk not available").await;
    };

    server
        .stats
        .bytes_served
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
    write_response(stream, 200, "application/octet-stream", &bytes).await
}

/// A real read of real bytes, so a measurement measures the download.
///
/// The alternative — a synthetic payload from memory — measures a path nobody
/// downloads over: it leaves out the disk, the page cache and the chunk
/// verification, which on a node with spinning disks is most of what decides
/// whether it is a good source.
async fn serve_probe(
    stream: &mut TcpStream,
    server: &Arc<DirectServer>,
    request: &Request,
) -> std::io::Result<()> {
    let claims = match authorise(stream, server, request).await? {
        Some(claims) => claims,
        None => return Ok(()),
    };

    let requested = request
        .query
        .get("bytes")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(2 * 1024 * 1024)
        .clamp(1, MESH_CHUNK_BYTES);

    let index = request
        .query
        .get("index")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    let Some(mut bytes) = server
        .chunks
        .read_chunk(&claims.game_id, &claims.file_id, index)
        .await
    else {
        server.stats.refused.fetch_add(1, Ordering::Relaxed);
        return write_response(stream, 404, "text/plain", b"chunk not available").await;
    };

    bytes.truncate(requested as usize);
    server
        .stats
        .bytes_served
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
    write_response(stream, 200, "application/octet-stream", &bytes).await
}

/// Check the grant, answering the client itself when it does not hold up.
///
/// Returns `None` once a refusal has been written, so the caller returns
/// without writing a second response onto the same socket.
async fn authorise(
    stream: &mut TcpStream,
    server: &Arc<DirectServer>,
    request: &Request,
) -> std::io::Result<Option<GrantClaims>> {
    let Some(grant) = request.query.get("grant") else {
        server.stats.refused.fetch_add(1, Ordering::Relaxed);
        write_response(stream, 403, "text/plain", b"a grant is required").await?;
        return Ok(None);
    };

    match server.verify_grant(grant).await {
        Ok(claims) => Ok(Some(claims)),
        Err(err) => {
            server.stats.refused.fetch_add(1, Ordering::Relaxed);
            write_response(stream, err.status(), "text/plain", err.message().as_bytes()).await?;
            Ok(None)
        }
    }
}

/* ------------------------------------------------------------------- HTTP/1 */

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
}

/// Read one request head, and nothing more.
///
/// Bounded in both directions — a size cap and a timeout — because this is the
/// one part of a node that answers strangers, and an unbounded read from one is
/// how a machine runs out of memory over a single open socket.
async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut head = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];

    loop {
        let read = match tokio::time::timeout(HEAD_TIMEOUT, stream.read(&mut buffer)).await {
            Ok(Ok(0)) | Err(_) => return Ok(None),
            Ok(Ok(read)) => read,
            Ok(Err(err)) => return Err(err),
        };

        head.extend_from_slice(&buffer[..read]);
        if head.len() > MAX_HEAD_BYTES {
            return Ok(None);
        }
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    Ok(parse_request_line(&head))
}

/// The first line of a request, which is all of it that matters here.
fn parse_request_line(head: &[u8]) -> Option<Request> {
    let text = std::str::from_utf8(head).ok()?;
    let line = text.lines().next()?;
    let mut parts = line.split_whitespace();

    let method = parts.next()?.to_string();
    let target = parts.next()?;

    let (path, raw_query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };

    Some(Request {
        method,
        path: path.to_string(),
        query: parse_query(raw_query),
    })
}

/// Percent-decoded `a=b&c=d`. Unknown escapes are left as written rather than
/// guessed at: a grant that arrives mangled should fail its signature, not be
/// silently repaired into something else.
fn parse_query(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in raw.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(key), percent_decode(value));
    }
    out
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&out).into_owned()
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        503 => "Service Unavailable",
        _ => "Error",
    };

    // `Connection: close` rather than keep-alive: one chunk is ten megabytes
    // and a client opens several connections on purpose, so reusing one buys
    // nothing and holding sockets open for strangers costs something.
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );

    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    Ok(())
}

/// Escapes the two characters that can appear in a node label and break JSON.
fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    struct NoChunks;

    #[async_trait::async_trait]
    impl ChunkStore for NoChunks {
        async fn read_chunk(&self, _game: &str, _file: &str, _index: u64) -> Option<Vec<u8>> {
            None
        }
    }

    fn server(node_id: &str) -> Arc<DirectServer> {
        Arc::new(DirectServer::new(
            node_id.to_string(),
            Arc::new(NoChunks),
            Arc::new(DirectStats::default()),
        ))
    }

    /// A grant in exactly the shape the Coordinator mints one.
    fn grant(key: &SigningKey, claims: serde_json::Value) -> String {
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes());
        let signature = key.sign(payload.as_bytes());
        format!(
            "v2.{payload}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    fn claims(node: &str, expires_at: i64) -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "nodeId": node,
            "gameId": "gam_1",
            "fileId": "gfl_1",
            "userId": "usr_1",
            "expiresAt": expires_at,
            "nonce": "abc",
        })
    }

    #[tokio::test]
    async fn refuses_everything_before_it_has_the_coordinator_key() {
        let node = server("nod_1");
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let token = grant(&key, claims("nod_1", now_seconds() + 60));

        assert_eq!(
            node.verify_grant(&token).await.unwrap_err(),
            GrantError::NoKey
        );
    }

    #[tokio::test]
    async fn accepts_a_grant_the_coordinator_signed() {
        let node = server("nod_1");
        let key = SigningKey::from_bytes(&[7u8; 32]);
        assert!(
            node.set_coordinator_key(&URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()))
                .await
        );

        let token = grant(&key, claims("nod_1", now_seconds() + 60));
        let verified = node.verify_grant(&token).await.expect("grant verifies");
        assert_eq!(verified.game_id, "gam_1");
        assert_eq!(verified.file_id, "gfl_1");
    }

    #[tokio::test]
    async fn reads_the_key_in_the_wrapped_form_the_coordinator_publishes() {
        let node = server("nod_1");
        let key = SigningKey::from_bytes(&[9u8; 32]);

        // SPKI: twelve bytes of algorithm identifier, then the key itself.
        let mut spki = hex::decode("302a300506032b6570032100").expect("fixed prefix");
        spki.extend_from_slice(&key.verifying_key().to_bytes());
        assert!(
            node.set_coordinator_key(&URL_SAFE_NO_PAD.encode(spki))
                .await
        );

        let token = grant(&key, claims("nod_1", now_seconds() + 60));
        assert!(node.verify_grant(&token).await.is_ok());
    }

    #[tokio::test]
    async fn refuses_a_grant_addressed_to_another_node() {
        let node = server("nod_1");
        let key = SigningKey::from_bytes(&[7u8; 32]);
        node.set_coordinator_key(&URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()))
            .await;

        let token = grant(&key, claims("nod_2", now_seconds() + 60));
        assert_eq!(
            node.verify_grant(&token).await.unwrap_err(),
            GrantError::WrongNode
        );
    }

    #[tokio::test]
    async fn refuses_an_expired_grant() {
        let node = server("nod_1");
        let key = SigningKey::from_bytes(&[7u8; 32]);
        node.set_coordinator_key(&URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()))
            .await;

        let token = grant(&key, claims("nod_1", now_seconds() - 1));
        assert_eq!(
            node.verify_grant(&token).await.unwrap_err(),
            GrantError::Expired
        );
    }

    #[tokio::test]
    async fn refuses_a_grant_signed_by_somebody_else() {
        let node = server("nod_1");
        let coordinator = SigningKey::from_bytes(&[7u8; 32]);
        let impostor = SigningKey::from_bytes(&[8u8; 32]);
        node.set_coordinator_key(&URL_SAFE_NO_PAD.encode(coordinator.verifying_key().to_bytes()))
            .await;

        let token = grant(&impostor, claims("nod_1", now_seconds() + 60));
        assert_eq!(
            node.verify_grant(&token).await.unwrap_err(),
            GrantError::BadSignature
        );
    }

    #[tokio::test]
    async fn refuses_a_payload_edited_after_signing() {
        let node = server("nod_1");
        let key = SigningKey::from_bytes(&[7u8; 32]);
        node.set_coordinator_key(&URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()))
            .await;

        let token = grant(&key, claims("nod_1", now_seconds() + 60));
        let (payload, signature) = token
            .strip_prefix("v2.")
            .and_then(|rest| rest.split_once('.'))
            .expect("well-formed token");

        // Somebody swapping in another game id, which is the attack the
        // signature exists to stop.
        let mut tampered = claims("nod_1", now_seconds() + 60);
        tampered["gameId"] = serde_json::json!("gam_somebody_elses");
        let edited = URL_SAFE_NO_PAD.encode(tampered.to_string());
        assert_ne!(edited, payload);

        assert_eq!(
            node.verify_grant(&format!("v2.{edited}.{signature}"))
                .await
                .unwrap_err(),
            GrantError::BadSignature
        );
    }

    #[test]
    fn reads_the_request_line_and_its_query() {
        let request = parse_request_line(
            b"GET /gb/v1/chunk?index=4&grant=v2.abc%2Ddef HTTP/1.1\r\nHost: x\r\n\r\n",
        )
        .expect("parses");

        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/gb/v1/chunk");
        assert_eq!(request.query.get("index").map(String::as_str), Some("4"));
        assert_eq!(
            request.query.get("grant").map(String::as_str),
            Some("v2.abc-def")
        );
    }

    #[test]
    fn a_request_without_a_query_is_still_a_request() {
        let request = parse_request_line(b"GET /gb/v1/health HTTP/1.1\r\n\r\n").expect("parses");
        assert_eq!(request.path, "/gb/v1/health");
        assert!(request.query.is_empty());
    }
}
