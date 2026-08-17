use crate::api::ApiClient;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

/// How often a running game reports in, banking its playtime so far.
const HEARTBEAT: Duration = Duration::from_secs(60);

/// How often the watcher checks whether the process has exited.
const POLL: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGame {
    pub game_id: String,
    pub title: String,
    pub session_id: String,
    pub started_at: String,
    pub seconds: u64,
}

#[derive(Debug, Deserialize)]
struct SessionResponse {
    id: String,
    #[serde(rename = "startedAt")]
    started_at: String,
}

/// Tracks the one game this client has running.
///
/// Deliberately single-slot: the server closes any open session when a new one
/// starts, so allowing two here would just produce playtime the server discards.
#[derive(Default)]
pub struct Launcher {
    running: RwLock<HashMap<String, RunningGame>>,
}

impl Launcher {
    pub async fn current(&self) -> Option<RunningGame> {
        self.running.read().await.values().next().cloned()
    }

    pub async fn is_running(&self, game_id: &str) -> bool {
        self.running.read().await.contains_key(game_id)
    }

    /// Starts a game and watches it until it exits.
    ///
    /// Playtime is opened on the server *before* the process starts, so a game
    /// that crashes on launch still leaves a session the server can close,
    /// rather than leaving the user permanently marked as in-game.
    pub async fn launch(
        self: Arc<Self>,
        app: AppHandle,
        client: ApiClient,
        game_id: String,
        title: String,
        executable: PathBuf,
        args: Option<String>,
        working_dir: Option<PathBuf>,
    ) -> AppResult<RunningGame> {
        if self.current().await.is_some() {
            return Err(AppError::Other(
                "Another game is already running. Quit it first.".to_string(),
            ));
        }
        if !executable.exists() {
            return Err(AppError::Other(format!(
                "Could not find {}. Try reinstalling the game.",
                executable.display()
            )));
        }

        let session: SessionResponse = client
            .post_json("/play/sessions", &serde_json::json!({ "gameId": game_id }))
            .await
            .and_then(|value| serde_json::from_value(value).map_err(AppError::from))?;

        let directory = working_dir
            .filter(|dir| dir.exists())
            .or_else(|| executable.parent().map(Path::to_path_buf));

        let mut command = tokio::process::Command::new(&executable);
        if let Some(dir) = &directory {
            command.current_dir(dir);
        }
        for arg in split_args(args.as_deref()) {
            command.arg(arg);
        }

        let child = command.spawn().map_err(|err| {
            AppError::Other(format!("Could not start {}: {err}", executable.display()))
        })?;

        let running = RunningGame {
            game_id: game_id.clone(),
            title,
            session_id: session.id.clone(),
            started_at: session.started_at,
            seconds: 0,
        };

        self.running
            .write()
            .await
            .insert(game_id.clone(), running.clone());

        let watcher = Arc::clone(&self);
        tokio::spawn(async move {
            watcher.watch(app, client, child, game_id, session.id).await;
        });

        Ok(running)
    }

    /// Polls the child, heartbeating playtime, and closes the session on exit.
    async fn watch(
        self: Arc<Self>,
        app: AppHandle,
        client: ApiClient,
        mut child: tokio::process::Child,
        game_id: String,
        session_id: String,
    ) {
        let started = Instant::now();
        let mut last_beat = Instant::now();

        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                // A failure to poll means the handle is unusable; treat the game
                // as finished rather than looping forever on a broken child.
                Err(_) => break,
                Ok(None) => {}
            }

            tokio::time::sleep(POLL).await;

            let elapsed = started.elapsed().as_secs();
            if last_beat.elapsed() >= HEARTBEAT {
                last_beat = Instant::now();

                if let Some(entry) = self.running.write().await.get_mut(&game_id) {
                    entry.seconds = elapsed;
                }

                // A dropped heartbeat is not worth aborting the session over —
                // the final close reports the real total anyway.
                let _ = client
                    .post_json(
                        &format!("/play/sessions/{session_id}/heartbeat"),
                        &serde_json::json!({ "seconds": elapsed }),
                    )
                    .await;

                let _ = app.emit(
                    "play://tick",
                    serde_json::json!({ "gameId": game_id, "seconds": elapsed }),
                );
            }
        }

        let seconds = started.elapsed().as_secs();
        self.running.write().await.remove(&game_id);

        let _ = client
            .post_json(
                &format!("/play/sessions/{session_id}/end"),
                &serde_json::json!({ "seconds": seconds }),
            )
            .await;

        let _ = app.emit(
            "play://ended",
            serde_json::json!({ "gameId": game_id, "seconds": seconds }),
        );
    }
}

/// Splits an argument string, honouring double quotes so a path with spaces
/// survives. Deliberately simple: these come from an admin-authored field, not
/// from a shell, so there is no escaping syntax to support.
fn split_args(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };

    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;

    for character in raw.chars() {
        match character {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }

    if !current.is_empty() {
        args.push(current);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_args_handles_none_and_empty() {
        assert!(split_args(None).is_empty());
        assert!(split_args(Some("   ")).is_empty());
    }

    #[test]
    fn split_args_splits_on_whitespace() {
        assert_eq!(
            split_args(Some("-windowed -novid")),
            vec!["-windowed", "-novid"]
        );
    }

    #[test]
    fn split_args_keeps_quoted_paths_together() {
        assert_eq!(
            split_args(Some(r#"-config "C:\My Games\cfg.ini" -safe"#)),
            vec!["-config", r"C:\My Games\cfg.ini", "-safe"]
        );
    }
}
