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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFile {
    pub id: String,
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub sha256: Option<String>,
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
