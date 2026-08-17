use crate::error::AppResult;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// Matches the server's heartbeat expectation; missing two in a row is what
/// marks a client offline, so pings go out comfortably inside that window.
const PING_INTERVAL: Duration = Duration::from_secs(20);

/// Backoff bounds for reconnecting. A laptop that sleeps overnight should not
/// come back to a socket hammering the server once a second.
const RECONNECT_MIN: Duration = Duration::from_secs(2);
const RECONNECT_MAX: Duration = Duration::from_secs(60);

/// Keeps a WebSocket to the server open, forwarding events to the UI.
///
/// Everything that arrives here is also readable over REST, so the socket is
/// treated as a freshness optimisation rather than a source of truth: a
/// disconnect degrades the UI to whatever it last fetched, never breaks it.
pub struct RealtimeClient {
    running: Arc<AtomicBool>,
}

impl Default for RealtimeClient {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl RealtimeClient {
    /// Starts the connection loop. Safe to call repeatedly — a second call
    /// while already connected is a no-op.
    pub fn start(&self, app: AppHandle, server_url: String, token: String) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        let running = Arc::clone(&self.running);
        tokio::spawn(async move {
            let mut backoff = RECONNECT_MIN;

            while running.load(Ordering::SeqCst) {
                match connect(&app, &server_url, &token, &running).await {
                    // A clean end means the socket closed normally, so the next
                    // attempt starts from the short delay again.
                    Ok(()) => backoff = RECONNECT_MIN,
                    Err(_) => {
                        backoff = (backoff * 2).min(RECONNECT_MAX);
                    }
                }

                if !running.load(Ordering::SeqCst) {
                    break;
                }
                let _ = app.emit("realtime://disconnected", ());
                tokio::time::sleep(backoff).await;
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

async fn connect(
    app: &AppHandle,
    server_url: &str,
    token: &str,
    running: &Arc<AtomicBool>,
) -> AppResult<()> {
    let ws_url = to_websocket_url(server_url);

    let mut request = ws_url
        .into_client_request()
        .map_err(|err| crate::error::AppError::Other(format!("Bad server URL: {err}")))?;

    // The socket authenticates with the same device token as every other call,
    // so there is no separate socket credential to issue or revoke.
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| crate::error::AppError::Other("Bad token".to_string()))?,
    );

    let (stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|err| crate::error::AppError::Other(format!("Realtime connect failed: {err}")))?;

    let (mut write, mut read) = stream.split();
    let _ = app.emit("realtime://connected", ());

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;

    loop {
        tokio::select! {
            _ = ping.tick() => {
                if write.send(Message::Text(r#"{"type":"ping"}"#.to_string())).await.is_err() {
                    break;
                }
            }
            frame = read.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        // Forwarded verbatim; the UI owns the event shapes and
                        // parsing them twice would only add a place to drift.
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            let _ = app.emit("realtime://event", value);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }

        if !running.load(Ordering::SeqCst) {
            let _ = write.send(Message::Close(None)).await;
            break;
        }
    }

    Ok(())
}

/// `https://host/base` becomes `wss://host/base/api/realtime`.
fn to_websocket_url(server_url: &str) -> String {
    let trimmed = server_url.trim_end_matches('/');
    let base = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("wss://{trimmed}")
    };
    format!("{base}/api/realtime")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_url_follows_the_scheme() {
        assert_eq!(
            to_websocket_url("https://games.example.com"),
            "wss://games.example.com/api/realtime"
        );
        assert_eq!(
            to_websocket_url("http://127.0.0.1:8080"),
            "ws://127.0.0.1:8080/api/realtime"
        );
    }

    #[test]
    fn websocket_url_keeps_a_sub_path() {
        assert_eq!(
            to_websocket_url("https://example.com/gameblade/"),
            "wss://example.com/gameblade/api/realtime"
        );
    }
}
