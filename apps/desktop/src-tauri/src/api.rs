use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub username: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
struct LoginResponse {
    token: String,
    user: UserInfo,
}

/// One content-addressed piece of a file, on the mesh chunk grid.
///
/// The offset is the index times the grid size; the server sends no offset and
/// this deliberately stores none, so the two can never disagree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkRef {
    pub index: u64,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFile {
    pub id: String,
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub sha256: Option<String>,
    /// Per-chunk hashes, when the server has computed them.
    ///
    /// Absent from older servers and from games that have not been hashed yet,
    /// which is why every use of this is behind an `Option`: their absence is
    /// normal, not an error, and simply means falling back to verifying the
    /// whole file at the end.
    #[serde(default)]
    pub chunks: Option<Vec<ChunkRef>>,
}

/// Somewhere a game's bytes can be fetched from.
///
/// Unknown `kind` values deserialize rather than failing the manifest, because
/// a newer server will list source kinds this build has never heard of and the
/// right response is to ignore them and use the origin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestSource {
    pub kind: String,
    #[serde(rename = "nodeId", default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadManifest {
    #[serde(rename = "gameId")]
    pub game_id: String,
    pub title: String,
    pub kind: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    pub files: Vec<ManifestFile>,
    pub token: String,
    /// When the signed token stops working. Absent from older servers; the
    /// downloader then falls back to refreshing reactively on a 403 alone.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<String>,
    /// The grid `chunks` was hashed on.
    ///
    /// Checked rather than assumed: if a later release changes the grid, this
    /// build sees a size it does not implement and ignores the chunk hashes
    /// instead of verifying arriving bytes against boundaries nobody uses.
    #[serde(rename = "chunkBytes", default)]
    pub chunk_bytes: Option<u64>,
    #[serde(default)]
    pub sources: Option<Vec<ManifestSource>>,
}

/// One node the coordinator is offering, with the grant to use it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MeshNode {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub role: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(default)]
    pub endpoints: Vec<MeshEndpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshEndpoint {
    #[serde(default)]
    pub kind: String,
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshGrant {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub grant: String,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<String>,
}

/// What `POST /mesh/resolve/:gameId` hands back.
///
/// Defaults to empty on purpose: an older server, a disabled mesh and a
/// network hiccup all mean "download from the origin", and the caller should
/// not have to tell them apart.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MeshResolution {
    #[serde(default)]
    pub nodes: Vec<MeshNode>,
    #[serde(default)]
    pub grants: Vec<MeshGrant>,
    #[serde(rename = "coordinatorPublicKey", default)]
    pub coordinator_public_key: Option<String>,
}

/// What the coordinator hands back when this machine offers to be a peer.
#[derive(Debug, Clone, Deserialize)]
pub struct PeerRegistration {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    /// Returned once. Only its hash is stored server-side.
    #[serde(rename = "nodeToken")]
    pub node_token: String,
    #[serde(rename = "heartbeatSeconds", default = "default_heartbeat")]
    pub heartbeat_seconds: u64,
}

fn default_heartbeat() -> u64 {
    30
}

/// Where the relay is, and this client's half of the pairing.
///
/// The response also carries the node's id and public key. Neither is read:
/// the client already holds both from the resolve that chose this node, and
/// pins the certificate against *that* copy. Taking the key from here instead
/// would mean trusting a second, later answer about who it is talking to —
/// weaker for no benefit — so the extra fields are deliberately ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct RelaySession {
    pub relay: RelayAddress,
    pub ticket: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelayAddress {
    pub address: String,
    pub port: u16,
}

/// What `POST /download/:gameId/token` hands back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssuedDownloadToken {
    pub token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

/// The machine-readable half of a server error.
///
/// Download failures are classified by this code rather than by message text:
/// `quota_exceeded` becomes a paused transfer, `token_expired` becomes a
/// refresh-and-retry, and everything else stays an ordinary failure.
#[derive(Debug, Clone)]
pub struct ApiFailure {
    pub status: u16,
    pub code: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorEnvelope {
    error: ApiErrorBody,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    message: String,
}

/// Thin client over the GameBlade HTTP API, authenticated with a device token.
#[derive(Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    base_url: String,
    token: Option<String>,
}

impl ApiClient {
    pub fn new(base_url: &str, token: Option<String>) -> AppResult<Self> {
        let http = reqwest::Client::builder()
            // Only the initial handshake is bounded; a download body can take hours.
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent(concat!("GameBlade-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()?;

        Ok(Self {
            http,
            base_url: normalise_base_url(base_url),
            token,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn endpoint(&self, path: &str) -> String {
        format!("{}/api{}", self.base_url, path)
    }

    fn authorised(&self, builder: reqwest::RequestBuilder) -> AppResult<reqwest::RequestBuilder> {
        let token = self.token.as_ref().ok_or(AppError::NotSignedIn)?;
        Ok(builder.bearer_auth(token))
    }

    /// Exchange credentials for a device token. The server issues a separately
    /// revocable token when a device name is supplied.
    pub async fn sign_in(&self, username: &str, password: &str) -> AppResult<(String, UserInfo)> {
        let device_name = hostname_or_default();
        let response = self
            .http
            .post(self.endpoint("/auth/login"))
            .json(&serde_json::json!({
                "username": username,
                "password": password,
                "deviceName": device_name,
                "devicePlatform": std::env::consts::OS,
            }))
            .send()
            .await?;

        let response = check_status(response).await?;
        let body: LoginResponse = response.json().await?;
        Ok((body.token, body.user))
    }

    pub async fn session(&self) -> AppResult<UserInfo> {
        let request = self.authorised(self.http.get(self.endpoint("/auth/session")))?;
        let response = check_status(request.send().await?).await?;
        #[derive(Deserialize)]
        struct SessionBody {
            user: UserInfo,
        }
        let body: SessionBody = response.json().await?;
        Ok(body.user)
    }

    /// Raw pass-through so the UI can reuse the server's own query parameters.
    pub async fn get_json(&self, path: &str) -> AppResult<serde_json::Value> {
        let request = self.authorised(self.http.get(self.endpoint(path)))?;
        let response = check_status(request.send().await?).await?;
        Ok(response.json().await?)
    }

    pub async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        let request = self.authorised(self.http.post(self.endpoint(path)).json(body))?;
        let response = check_status(request.send().await?).await?;
        // Some endpoints answer with an empty body; treat that as null rather
        // than as a malformed response.
        let text = response.text().await?;
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn put_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        let request = self.authorised(self.http.put(self.endpoint(path)).json(body))?;
        let response = check_status(request.send().await?).await?;
        let text = response.text().await?;
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn patch_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        let request = self.authorised(self.http.patch(self.endpoint(path)).json(body))?;
        let response = check_status(request.send().await?).await?;
        let text = response.text().await?;
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn delete_json(&self, path: &str) -> AppResult<serde_json::Value> {
        let request = self.authorised(self.http.delete(self.endpoint(path)))?;
        let response = check_status(request.send().await?).await?;
        let text = response.text().await?;
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// Uploads a file as a raw body. Used for cloud saves and social uploads,
    /// both of which stream rather than being buffered into a multipart form.
    pub async fn upload_file(
        &self,
        path: &str,
        file: &std::path::Path,
        content_type: &str,
    ) -> AppResult<serde_json::Value> {
        let handle = tokio::fs::File::open(file).await?;
        let length = handle.metadata().await?.len();
        // Streamed rather than read into memory: a save archive or a gameplay
        // clip can be hundreds of megabytes.
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(handle));

        let request = self.authorised(
            self.http
                .post(self.endpoint(path))
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .header(reqwest::header::CONTENT_LENGTH, length)
                .body(body),
        )?;

        let response = check_status(request.send().await?).await?;
        let text = response.text().await?;
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// Uploads bytes already in memory as a raw body.
    ///
    /// The counterpart to `upload_file` for content that never was a file. An
    /// image pasted from the clipboard is the case that matters: writing it to
    /// disk first, uploading it and deleting it again leaves a copy of whatever
    /// somebody copied — a password manager screenshot, a private message —
    /// sitting in a temp folder for as long as it takes to notice. Buffered
    /// rather than streamed because a clipboard image is bounded by what a
    /// screen can hold.
    pub async fn upload_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> AppResult<serde_json::Value> {
        let length = bytes.len() as u64;

        let request = self.authorised(
            self.http
                .post(self.endpoint(path))
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .header(reqwest::header::CONTENT_LENGTH, length)
                .body(bytes),
        )?;

        let response = check_status(request.send().await?).await?;
        let text = response.text().await?;
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// Downloads to a path, returning the SHA-256 the server declared for it.
    pub async fn download_file(
        &self,
        path: &str,
        target: &std::path::Path,
    ) -> AppResult<Option<String>> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        let request = self.authorised(self.http.get(self.endpoint(path)))?;
        let response = check_status(request.send().await?).await?;

        let declared = response
            .headers()
            .get("x-gameblade-sha256")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::File::create(target).await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk?).await?;
        }
        file.flush().await?;

        Ok(declared)
    }

    pub async fn manifest(&self, game_id: &str) -> AppResult<DownloadManifest> {
        let request = self.authorised(
            self.http
                .get(self.endpoint(&format!("/games/{game_id}/manifest"))),
        )?;
        let response = check_status(request.send().await?).await?;
        Ok(response.json().await?)
    }

    /// A fresh signed download token for a game.
    ///
    /// Long transfers outlive the manifest token's six hours; refreshing is
    /// what lets them keep streaming instead of failing at hour six.
    pub async fn download_token(&self, game_id: &str) -> AppResult<IssuedDownloadToken> {
        let request = self.authorised(
            self.http
                .post(self.endpoint(&format!("/download/{game_id}/token"))),
        )?;
        let response = check_status(request.send().await?).await?;
        Ok(response.json().await?)
    }

    /// Ask the coordinator where a game can be fetched from, and for
    /// permission to fetch it.
    ///
    /// One call rather than two: knowing about a node is useless without a
    /// grant, and a grant is meaningless for a node you were not told about.
    /// A server that has never heard of the mesh 404s here, which is an empty
    /// answer rather than an error — the origin was always going to be the
    /// fallback anyway.
    pub async fn resolve_mesh(
        &self,
        game_id: &str,
        candidates: &[(String, u16)],
    ) -> MeshResolution {
        let Ok(request) = self.authorised(
            self.http
                .post(self.endpoint(&format!("/mesh/resolve/{game_id}"))),
        ) else {
            return MeshResolution::default();
        };

        // The client's own external address, so nodes can punch toward it. The
        // address this request arrives from is a different NAT mapping on a
        // different port, and punching at that would open a hole nothing uses.
        let body = serde_json::json!({
            "endpoints": candidates
                .iter()
                .map(|(address, port)| serde_json::json!({
                    "kind": "observed",
                    "address": address,
                    "port": port,
                }))
                .collect::<Vec<_>>(),
        });
        let request = request.json(&body);

        match request.send().await {
            Ok(response) if response.status().is_success() => {
                response.json().await.unwrap_or_default()
            }
            // Every failure here means the same thing: use the origin. There is
            // nothing a caller could usefully do with the distinction.
            _ => MeshResolution::default(),
        }
    }

    /// Offer this machine as a peer node.
    ///
    /// Fails when the operator has seeding switched off, which is a refusal to
    /// respect rather than an error to retry: the answer will not change until
    /// they change it.
    pub async fn register_peer(
        &self,
        public_key: &str,
        label: &str,
        endpoints: &[(String, u16)],
    ) -> AppResult<PeerRegistration> {
        let body = serde_json::json!({
            "publicKey": public_key,
            "label": label,
            "endpoints": endpoints
                .iter()
                .map(|(address, port)| serde_json::json!({
                    "kind": "local",
                    "address": address,
                    "port": port,
                }))
                .collect::<Vec<_>>(),
        });

        let request = self.authorised(self.http.post(self.endpoint("/mesh/peer")))?;
        let response = check_status(request.json(&body).send().await?).await?;
        Ok(response.json().await?)
    }

    /// Stay registered, and say what is currently on offer.
    pub async fn peer_heartbeat(
        &self,
        node_id: &str,
        node_token: &str,
        games: &[(String, String)],
    ) -> AppResult<()> {
        let body = serde_json::json!({
            "endpoints": [],
            "games": games
                .iter()
                .map(|(game_id, content_hash)| serde_json::json!({
                    "gameId": game_id,
                    "contentHash": content_hash,
                }))
                .collect::<Vec<_>>(),
        });

        let response = self
            .http
            .post(self.endpoint("/mesh/heartbeat"))
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {node_token}"),
            )
            .header("x-gameblade-node", node_id)
            .json(&body)
            .send()
            .await?;

        check_status(response).await?;
        Ok(())
    }

    /// Stop being a peer — sign-out, or the switch going off.
    pub async fn withdraw_peer(&self) -> AppResult<()> {
        let request = self.authorised(self.http.delete(self.endpoint("/mesh/peer")))?;
        check_status(request.send().await?).await?;
        Ok(())
    }

    /// Ask for a relay session, having failed to reach a node directly.
    ///
    /// Asked for only after the direct attempt failed, because relaying spends
    /// the coordinator's bandwidth — the very thing the mesh exists to save. A
    /// server with no relay answers plainly and this returns nothing, which is
    /// the right outcome: there is no path, and pretending otherwise would fail
    /// slowly instead of quickly.
    pub async fn request_relay(&self, game_id: &str, node_id: &str) -> Option<RelaySession> {
        let request = self
            .authorised(
                self.http
                    .post(self.endpoint(&format!("/mesh/relay/{game_id}"))),
            )
            .ok()?;

        let response = request
            .json(&serde_json::json!({ "nodeId": node_id }))
            .send()
            .await
            .ok()?;

        if !response.status().is_success() {
            return None;
        }
        response.json().await.ok()
    }

    /// Reads a non-2xx response into its structured parts without turning it
    /// into an `AppError` yet — the downloader classifies before it decides.
    pub async fn classify_failure(response: reqwest::Response) -> ApiFailure {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();

        #[derive(Deserialize)]
        struct Envelope {
            error: Body,
        }
        #[derive(Deserialize)]
        struct Body {
            code: Option<String>,
            #[serde(default)]
            message: Option<String>,
        }

        let parsed = serde_json::from_str::<Envelope>(&body).ok();
        let message = parsed
            .as_ref()
            .and_then(|e| e.error.message.clone())
            .unwrap_or_else(|| match status {
                401 => "Not signed in".to_string(),
                403 => "You do not have access to that".to_string(),
                404 => "Not found".to_string(),
                410 => "No longer available on the server".to_string(),
                _ => format!("Server returned {status}"),
            });
        let code = parsed.and_then(|e| e.error.code);

        ApiFailure {
            status,
            code,
            message,
        }
    }
}

/// Turn a non-2xx response into an error carrying the server's own message.
async fn check_status(response: reqwest::Response) -> AppResult<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    let message = serde_json::from_str::<ApiErrorEnvelope>(&body)
        .map(|envelope| envelope.error.message)
        .unwrap_or_else(|_| match status.as_u16() {
            401 => "Incorrect username or password".to_string(),
            403 => "You do not have access to that".to_string(),
            404 => "Not found".to_string(),
            _ => format!("Server returned {status}"),
        });

    Err(AppError::Server(message))
}

/// Accepts `example.com`, `https://example.com/` and `https://example.com/gameblade`
/// alike, so a user can paste whatever their browser shows.
fn normalise_base_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn hostname_or_default() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Desktop".to_string())
}
