use crate::api::ApiClient;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

/// How often a running game reports in, banking its playtime so far.
const HEARTBEAT: Duration = Duration::from_secs(60);

/// How often the watcher checks whether the process has exited.
const POLL: Duration = Duration::from_millis(750);

/// How long a game is given to close itself before it is killed outright.
///
/// On Windows the polite request is a WM_CLOSE to the process's windows, which
/// a game may honour by saving and exiting — the whole reason to ask first. A
/// game that is hung, or that is showing a "really quit?" dialog nobody can
/// reach because it is fullscreen on a minimized window, will not answer, and
/// waiting on it forever is the state the player pressed Stop to get out of.
const GRACEFUL_EXIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGame {
    pub game_id: String,
    pub title: String,
    pub session_id: String,
    pub started_at: String,
    pub seconds: u64,
}

/// Everything needed to start one game. Grouped into a struct rather than
/// passed as seven positional arguments, which is both unreadable at the call
/// site and easy to get wrong when two of them are `Option<String>`.
pub struct LaunchRequest {
    pub game_id: String,
    pub title: String,
    pub executable: PathBuf,
    pub args: Option<String>,
    pub working_dir: Option<PathBuf>,
    /// Whether this machine publishes what is being played, from its own
    /// settings. Sent with the session because the server holds it for the
    /// session's lifetime — the heartbeat would otherwise re-publish the game
    /// a few seconds after any one-off override.
    pub share_activity: bool,
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
    /// Set by `stop`, read by the watcher on its next poll.
    ///
    /// A flag rather than a handle to the child, because the child is owned by
    /// the watcher task: handing a second owner the ability to kill it invites
    /// exactly the race where the process is reaped twice and the play session
    /// is closed with the wrong duration.
    stopping: RwLock<HashMap<String, Arc<AtomicBool>>>,
}

impl Launcher {
    pub async fn current(&self) -> Option<RunningGame> {
        self.running.read().await.values().next().cloned()
    }

    pub async fn is_running(&self, game_id: &str) -> bool {
        self.running.read().await.contains_key(game_id)
    }

    /// Ask the running game to close, and kill it if it will not.
    ///
    /// Returns false when nothing is running under that id, so the caller can
    /// say so rather than reporting a stop that stopped nothing.
    ///
    /// The playtime session is closed by the watcher on the way out, exactly as
    /// it is for a game that exited on its own — a force-quit still counts as
    /// time played, because it was.
    pub async fn stop(&self, game_id: &str) -> bool {
        let Some(flag) = self.stopping.read().await.get(game_id).cloned() else {
            return false;
        };
        flag.store(true, Ordering::SeqCst);
        true
    }

    /// Stop whatever is running, whichever game that is.
    pub async fn stop_current(&self) -> Option<String> {
        let game_id = self.current().await.map(|running| running.game_id)?;
        self.stop(&game_id).await.then_some(game_id)
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
        request: LaunchRequest,
    ) -> AppResult<RunningGame> {
        if self.current().await.is_some() {
            return Err(AppError::Other(
                "Another game is already running. Quit it first.".to_string(),
            ));
        }
        if !request.executable.exists() {
            return Err(AppError::Other(format!(
                "Could not find {}. Try reinstalling the game.",
                request.executable.display()
            )));
        }

        let game_id = request.game_id;
        let session: SessionResponse = client
            .post_json(
                "/play/sessions",
                &serde_json::json!({
                    "gameId": game_id,
                    "shareActivity": request.share_activity,
                }),
            )
            .await
            .and_then(|value| serde_json::from_value(value).map_err(AppError::from))?;

        let directory = request
            .working_dir
            .filter(|dir| dir.exists())
            .or_else(|| request.executable.parent().map(Path::to_path_buf));

        let mut command = tokio::process::Command::new(&request.executable);
        if let Some(dir) = &directory {
            command.current_dir(dir);
        }
        for arg in split_args(request.args.as_deref()) {
            command.arg(arg);
        }

        let child = command.spawn().map_err(|err| {
            AppError::Other(format!(
                "Could not start {}: {err}",
                request.executable.display()
            ))
        })?;

        let running = RunningGame {
            game_id: game_id.clone(),
            title: request.title,
            session_id: session.id.clone(),
            started_at: session.started_at,
            seconds: 0,
        };

        self.running
            .write()
            .await
            .insert(game_id.clone(), running.clone());

        let stopping = Arc::new(AtomicBool::new(false));
        self.stopping
            .write()
            .await
            .insert(game_id.clone(), Arc::clone(&stopping));

        let watcher = Arc::clone(&self);
        tokio::spawn(async move {
            watcher
                .watch(app, client, child, game_id, session.id, stopping)
                .await;
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
        stopping: Arc<AtomicBool>,
    ) {
        let started = Instant::now();
        let mut last_beat = Instant::now();
        let mut asked_to_close: Option<Instant> = None;

        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                // A failure to poll means the handle is unusable; treat the game
                // as finished rather than looping forever on a broken child.
                Err(_) => break,
                Ok(None) => {}
            }

            if stopping.load(Ordering::SeqCst) {
                match asked_to_close {
                    // First time round: ask nicely, so a game that handles the
                    // request gets to save and exit on its own terms.
                    None => {
                        request_close(&child);
                        asked_to_close = Some(Instant::now());
                        let _ =
                            app.emit("play://stopping", serde_json::json!({ "gameId": game_id }));
                    }
                    // It has had its chance.
                    Some(asked) if asked.elapsed() >= GRACEFUL_EXIT => {
                        let _ = child.start_kill();
                    }
                    Some(_) => {}
                }
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
        self.stopping.write().await.remove(&game_id);

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

/// Asks a running game to close itself.
///
/// On Windows this is `taskkill` without `/F`, which posts WM_CLOSE to the
/// process's windows — the same thing clicking the X does, and the request a
/// game can answer by saving first. Elsewhere it is SIGTERM, which is the same
/// idea in the same spirit. Either way the watcher kills it outright if the
/// grace period runs out, so a game that ignores the request still stops.
fn request_close(child: &tokio::process::Child) {
    let Some(pid) = child.id() else { return };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// Keeps taskkill's console window from flashing over a fullscreen game.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }

    #[cfg(unix)]
    {
        // SIGTERM by hand rather than through a crate: this is the one signal
        // needed, and `kill` is guaranteed to be there.
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
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
