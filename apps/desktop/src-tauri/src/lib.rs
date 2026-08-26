mod api;
mod credentials;
mod download;
mod error;
mod install;
mod launcher;
mod offline;
mod realtime;
mod saves;
mod settings;

use api::{ApiClient, UserInfo};
use credentials::StoredSession;
use download::{DownloadManager, DownloadState};
use error::{AppError, AppResult};
use install::{InstallCandidate, InstallManager, InstalledGame};
use launcher::{LaunchRequest, Launcher, RunningGame};
use realtime::RealtimeClient;
use saves::{LocalSave, SaveRule};
use serde::Serialize;
use settings::Settings;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tokio::sync::RwLock;

/// The only server this client will talk to.
///
/// GameBlade is a single-instance archive, so the address is compiled in rather
/// than typed at sign-in: there is no second server to point at, and a field
/// asking for one only invites a phishing page that looks like the real client.
/// A local build can override it for development, but a shipped binary cannot
/// be repointed at run time.
pub const SERVER_URL: &str = match option_env!("GAMEBLADE_SERVER_URL") {
    Some(url) => url,
    None => "https://archive.scopedd.lol",
};

/// Everything the commands need. The session is behind a lock because signing
/// in and out mutates it while downloads may still be reading it.
struct AppState {
    /// Shared with the download queue's client provider, so a queued game
    /// always activates with whatever session is current, not whichever one
    /// existed when Install was clicked.
    session: Arc<RwLock<Option<StoredSession>>>,
    settings: RwLock<Settings>,
    app_data: PathBuf,
    downloads: Arc<DownloadManager>,
    installs: Arc<InstallManager>,
    launcher: Arc<Launcher>,
    realtime: RealtimeClient,
    /// Last known state of the server, from whichever request spoke to it most
    /// recently. Not a ping: the app finds out the same way the user does.
    online: Arc<AtomicBool>,
    /// The last answer to each GET, and the artwork, kept so the client is
    /// still a client with the server switched off.
    cache: Arc<offline::Cache>,
}

impl AppState {
    async fn client(&self) -> AppResult<ApiClient> {
        let session = self.session.read().await;
        let session = session.as_ref().ok_or(AppError::NotSignedIn)?;
        ApiClient::new(&session.server_url, Some(session.token.clone()))
    }

    async fn install_dir(&self) -> PathBuf {
        self.settings.read().await.install_dir.clone()
    }

    /// Records whether the server just answered, and says so once when it
    /// changes.
    ///
    /// Emitted on the transition rather than per request: every page makes
    /// several, and an event per response would either spam a banner into
    /// existence or be ignored entirely.
    fn set_online(&self, app: &tauri::AppHandle, online: bool) {
        if self.online.swap(online, Ordering::SeqCst) != online {
            let _ = app.emit(
                if online {
                    "net://online"
                } else {
                    "net://offline"
                },
                online,
            );
        }
    }

    fn is_online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }
}

/// What the UI is told about the current session.
///
/// Deliberately without the server address. The client only ever talks to one
/// server, so showing the address tells a user nothing they can act on, and
/// keeping it out of the frontend means it cannot end up on screen — or in a
/// screenshot — by accident. Rust still holds it in `StoredSession`, which is
/// where every request actually gets it from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    /// The account's own id.
    ///
    /// Needed by anything that has to recognise the caller in data the server
    /// returns — "is this message mine" is answered by comparing ids, and
    /// comparing usernames instead would be one rename away from wrong.
    /// Empty only for a session stored before this was recorded, which the
    /// next successful sign-in check fills in.
    user_id: String,
    username: String,
    role: String,
}

/* ------------------------------------------------------------------ session */

#[tauri::command]
async fn current_session(state: State<'_, AppState>) -> AppResult<Option<SessionInfo>> {
    let session = state.session.read().await;
    Ok(session.as_ref().map(|s| SessionInfo {
        user_id: s.user_id.clone().unwrap_or_default(),
        username: s.username.clone(),
        role: s.role.clone(),
    }))
}

#[tauri::command]
async fn sign_in(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> AppResult<UserInfo> {
    let client = ApiClient::new(SERVER_URL, None)?;
    let (token, user) = client.sign_in(&username, &password).await?;

    let stored = StoredSession {
        server_url: client.base_url().to_string(),
        token: token.clone(),
        username: user.username.clone(),
        role: user.role.clone(),
        user_id: Some(user.id.clone()),
    };

    // A different account than last time gets a clean slate: the cache holds
    // the previous one's library, friends and artwork.
    state.cache.clear();
    credentials::save(&stored)?;
    state.realtime.start(app, stored.server_url.clone(), token);
    *state.session.write().await = Some(stored);

    // Anything the queue was holding for a signed-in session can go now.
    state.downloads.wake().await;
    Ok(user)
}

#[tauri::command]
async fn sign_out(state: State<'_, AppState>) -> AppResult<()> {
    state.realtime.stop();
    credentials::clear()?;
    *state.session.write().await = None;
    // Everything the offline cache holds belongs to the account that just left:
    // its library, its friends, its artwork. Whoever signs in next must not
    // open onto it.
    state.cache.clear();
    Ok(())
}

/// Confirms the stored token is still accepted; a revoked device lands here.
#[tauri::command]
async fn verify_session(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<UserInfo> {
    let client = state.client().await?;
    match client.session().await {
        Ok(user) => {
            state.set_online(&app, true);
            // The id is only ever handed out here, and it is what lets a signed
            // -in session be restored offline next time.
            if let Some(session) = state.session.write().await.as_mut() {
                if session.user_id.as_deref() != Some(user.id.as_str()) {
                    session.user_id = Some(user.id.clone());
                    let _ = credentials::save(session);
                }
            }
            // A restored session has no socket yet, so opening it here is what
            // makes presence work after a restart rather than only after a login.
            if !state.realtime.is_running() {
                if let Some(session) = state.session.read().await.as_ref() {
                    state
                        .realtime
                        .start(app, session.server_url.clone(), session.token.clone());
                }
            }
            // Same for the download queue: a restored session means an
            // interrupted transfer from the last run can pick up now.
            state.downloads.wake().await;
            Ok(user)
        }

        // The server is not there. That is not a reason to sign anybody out —
        // and treating it as one is what made the whole client unusable
        // offline: the check failed, the app fell back to the sign-in screen,
        // and the sign-in screen could not reach the server either. The stored
        // session is still valid; it simply cannot be confirmed right now.
        Err(AppError::Network(_)) => {
            state.set_online(&app, false);
            let session = state.session.read().await;
            match session.as_ref() {
                Some(stored) => Ok(UserInfo {
                    id: stored.user_id.clone().unwrap_or_default(),
                    username: stored.username.clone(),
                    role: stored.role.clone(),
                }),
                None => Err(AppError::NotSignedIn),
            }
        }

        Err(err) => {
            // The token is gone or revoked, so drop it rather than retrying forever.
            if matches!(err, AppError::Server(_)) {
                let _ = credentials::clear();
                *state.session.write().await = None;
                state.realtime.stop();
                state.cache.clear();
            }
            Err(err)
        }
    }
}

/* ---------------------------------------------------------------------- api */

/// Generic pass-throughs. The server already owns validation and shaping, so
/// mirroring every endpoint in Rust would only create somewhere for the two to
/// disagree.
#[tauri::command]
async fn api_get(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<serde_json::Value> {
    let client = state.client().await?;
    match client.get_json(&path).await {
        Ok(value) => {
            state.set_online(&app, true);
            state.cache.put_json(&path, &value);
            Ok(value)
        }
        // Only a *network* failure falls back. A 404 or a 403 is the server
        // answering, and serving a cached page over the top of it would hide a
        // permissions change or a deleted game behind stale data.
        Err(AppError::Network(err)) => {
            state.set_online(&app, false);
            match state.cache.get_json(&path) {
                Some(cached) => Ok(cached),
                None => Err(AppError::Offline(err.to_string())),
            }
        }
        Err(other) => Err(other),
    }
}

/// Whether the server answered last time anybody asked, and what is on disk.
///
/// The client does not poll for this. Connectivity is discovered the same way
/// the user discovers it — by something failing — and a heartbeat would only
/// add traffic to a server that is either there or is not.
/// Whether the realtime socket is open right now.
///
/// The UI is told about connection changes by event, and an event fires once.
/// Registering the listener is itself a round trip through the IPC bridge, so
/// a socket that connects quickly can open before anything is listening — and
/// the app then reads as disconnected for the entire time it is connected.
/// This is what the UI asks when it starts, instead of waiting for a frame
/// that has already been and gone.
#[tauri::command]
async fn realtime_connected(state: State<'_, AppState>) -> AppResult<bool> {
    Ok(state.realtime.is_connected())
}

#[tauri::command]
async fn connectivity(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    // "Home", because it is the first thing every session asks for and so the
    // most reliable evidence that this client has ever spoken to the server.
    let cached_at = state
        .cache
        .cached_at("/home")
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64);

    Ok(serde_json::json!({
        "online": state.is_online(),
        "cachedAtMs": cached_at,
    }))
}

/// Ask the server whether it is there, and update the banner either way.
///
/// The one deliberate probe, behind the "try again" button — an app that has
/// decided it is offline has no other way back to online until the next thing
/// somebody clicks fails.
#[tauri::command]
async fn recheck_connection(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<bool> {
    let client = state.client().await?;
    let reachable = client.session().await.is_ok();
    state.set_online(&app, reachable);
    Ok(reachable)
}

/// Turns a transport failure into something the UI can say out loud.
///
/// A write has nothing to fall back on — there is no cached answer to
/// "post this" — so the only useful thing to do is name the reason. "GameBlade
/// cannot reach the server" is actionable; a TLS handshake error is not.
fn offline_if_unreachable(
    app: &tauri::AppHandle,
    state: &AppState,
    result: AppResult<serde_json::Value>,
    what: &str,
) -> AppResult<serde_json::Value> {
    match result {
        Ok(value) => {
            state.set_online(app, true);
            Ok(value)
        }
        Err(AppError::Network(_)) => {
            state.set_online(app, false);
            Err(AppError::RequiresConnection(what.to_string()))
        }
        Err(other) => Err(other),
    }
}

#[tauri::command]
async fn api_post(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    body: Option<serde_json::Value>,
) -> AppResult<serde_json::Value> {
    let result = state
        .client()
        .await?
        .post_json(&path, &body.unwrap_or(serde_json::Value::Null))
        .await;
    offline_if_unreachable(&app, &state, result, "That")
}

#[tauri::command]
async fn api_put(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    body: Option<serde_json::Value>,
) -> AppResult<serde_json::Value> {
    let result = state
        .client()
        .await?
        .put_json(&path, &body.unwrap_or(serde_json::Value::Null))
        .await;
    offline_if_unreachable(&app, &state, result, "That")
}

#[tauri::command]
async fn api_patch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    body: Option<serde_json::Value>,
) -> AppResult<serde_json::Value> {
    let result = state
        .client()
        .await?
        .patch_json(&path, &body.unwrap_or(serde_json::Value::Null))
        .await;
    offline_if_unreachable(&app, &state, result, "That")
}

#[tauri::command]
async fn api_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<serde_json::Value> {
    let result = state.client().await?.delete_json(&path).await;
    offline_if_unreachable(&app, &state, result, "That")
}

/// Artwork needs the device token, which an `<img>` tag cannot send, so the URL
/// carries it as a query parameter instead.
///
/// Serving artwork from a local cache was tried here and withdrawn: the webview
/// is bound by a content security policy that permits `self`, `data:`, `blob:`,
/// `http:` and `https:`, and a `file://` URL is none of those, so every cache
/// hit produced an image the webview refused to load. Reinstating it needs a
/// scheme the policy allows, verified on a real Windows client rather than
/// assumed.
#[tauri::command]
async fn image_url(state: State<'_, AppState>, path: String) -> AppResult<String> {
    // Straight at the server, with the device token in the query string.
    //
    // 0.5.3 briefly routed this through a custom URI scheme so artwork could be
    // cached on disk and survive the server going away. It did not work in a
    // packaged build — every image in the app went through it, so every image
    // in the app was broken — and an optimisation that takes the whole UI with
    // it when it fails is not worth having. An `<img>` cannot send an
    // Authorization header, which is the only reason the token rides here.
    let session = state.session.read().await;
    let session = session.as_ref().ok_or(AppError::NotSignedIn)?;
    let separator = if path.contains('?') { '&' } else { '?' };
    Ok(format!(
        "{}{}{}token={}",
        session.server_url, path, separator, session.token
    ))
}

/// The version this client was built as, for comparing against the server's.
#[tauri::command]
fn client_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Downloads the installer the operator published and starts it.
///
/// The running client is not replaced in place: the installer already knows how
/// to upgrade an install, and handing off to it means an update follows exactly
/// the same path as a fresh one. The app stays open — the installer asks the
/// user to close it if it needs to.
#[tauri::command]
async fn run_client_installer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let client = state.client().await?;

    // Named per download so two cannot collide, and left in the OS temp
    // directory so an abandoned update does not linger in app data.
    let name = format!("GameBlade-Setup-{}.exe", chrono::Utc::now().timestamp());
    let target = std::env::temp_dir().join(name);

    // Streamed to disk rather than buffered: installers now exceed what fits
    // comfortably in memory, and the old in-memory path silently returned
    // nothing past its cap and reported "no installer published".
    client.download_file("/client/download", &target).await?;
    if tokio::fs::metadata(&target)
        .await
        .map(|m| m.len())
        .unwrap_or(0)
        == 0
    {
        let _ = tokio::fs::remove_file(&target).await;
        return Err(AppError::Other(
            "The server has no client installer published.".to_string(),
        ));
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|err| AppError::Other(format!("Could not start the installer: {err}")))?;

    Ok(target.to_string_lossy().to_string())
}

/// Reads one of a game's own files, for evaluating achievement rules.
///
/// The path comes from a rule an administrator wrote, resolved against this
/// machine's own folders. Capped, and read as text with invalid bytes replaced
/// rather than refused: save files are frequently not valid UTF-8, and a rule
/// looking for an ASCII key in one should still find it.
#[tauri::command]
async fn read_rule_file(
    state: State<'_, AppState>,
    game_id: String,
    template: String,
) -> AppResult<Option<String>> {
    /// Larger than any save worth scanning for a key, small enough that a rule
    /// pointed at something enormous cannot exhaust memory.
    const MAX_BYTES: u64 = 8 * 1024 * 1024;

    let Some(installed) = state.installs.get(&game_id).await else {
        return Ok(None);
    };

    let path = saves::resolve_template(&template, &installed.install_path);

    let Ok(metadata) = std::fs::metadata(&path) else {
        // Not yet created is the ordinary state before a game has been played.
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Ok(None);
    }

    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(_) => Ok(None),
    }
}

/* ----------------------------------------------------------------- settings */

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    Ok(state.settings.read().await.clone())
}

#[tauri::command]
async fn update_settings(state: State<'_, AppState>, patch: Settings) -> AppResult<Settings> {
    let sanitised = patch.sanitised();
    settings::save(&state.app_data, &sanitised)?;
    *state.settings.write().await = sanitised.clone();

    // Transfer preferences reach the queue immediately rather than being read
    // once at startup — historically these two saved a value and changed
    // nothing, which is worse than not offering them.
    state
        .downloads
        .set_transfer_options(download::TransferOptions {
            connections: sanitised.download_concurrency,
            verify: sanitised.verify_downloads,
        });

    Ok(sanitised)
}

/* ---------------------------------------------------------------- downloads */

#[tauri::command]
async fn start_download(
    state: State<'_, AppState>,
    game_id: String,
    destination: Option<String>,
) -> AppResult<()> {
    // A stopped entry for this game resumes in place, without the network:
    // the manifest, destination and progress it already had are all it needs.
    // This is what makes Resume work on a connection that currently does not.
    if state.downloads.resume_stopped(&game_id).await {
        return Ok(());
    }

    let client = state.client().await?;
    let manifest = client.manifest(&game_id).await?;

    // Without an explicit destination the configured install directory is used,
    // which is what makes one-click install work from the Store.
    let target = match destination {
        Some(path) => PathBuf::from(path),
        None => state.install_dir().await,
    };

    state.downloads.enqueue(&manifest, target).await
}

#[tauri::command]
/// Stops a download. `delete_files` removes what it already wrote.
///
/// The choice reaches the user as a prompt rather than being decided here: a
/// half-finished 250 GB transfer is worth keeping when the plan is to resume
/// it and worth 100 GB of disk when it is not, and only they know which.
async fn cancel_download(
    state: State<'_, AppState>,
    game_id: String,
    delete_files: Option<bool>,
) -> AppResult<bool> {
    Ok(state
        .downloads
        .cancel(&game_id, delete_files.unwrap_or(false))
        .await)
}

#[tauri::command]
async fn pause_download(state: State<'_, AppState>, game_id: String) -> AppResult<bool> {
    Ok(state.downloads.pause(&game_id).await)
}

#[tauri::command]
/// Drops a stopped download from the queue. `delete_files` takes its bytes too.
///
/// Dismissing a paused or failed row is the other way a partial download used
/// to disappear from the app while staying on the disk.
async fn clear_download(
    state: State<'_, AppState>,
    game_id: String,
    delete_files: Option<bool>,
) -> AppResult<()> {
    state
        .downloads
        .forget(&game_id, delete_files.unwrap_or(false))
        .await;
    Ok(())
}

#[tauri::command]
async fn list_downloads(state: State<'_, AppState>) -> AppResult<Vec<DownloadState>> {
    Ok(state.downloads.snapshot().await)
}

#[derive(Serialize)]
struct DiskUsage {
    available_bytes: u64,
    total_bytes: u64,
}

/// Free/total space for the drive a path lives on. Walks up to the nearest
/// existing ancestor first, so a location that has been configured but never
/// installed into yet still resolves instead of erroring.
fn disk_stats_for(dir: &Path) -> AppResult<DiskUsage> {
    let mut probe = dir;
    while !probe.exists() {
        probe = match probe.parent() {
            Some(parent) => parent,
            None => break,
        };
    }
    Ok(DiskUsage {
        available_bytes: fs4::available_space(probe)?,
        total_bytes: fs4::total_space(probe)?,
    })
}

/// Free/total space for the drive the default install directory lives on,
/// for the downloads panel's disk gauge.
#[tauri::command]
async fn disk_usage(state: State<'_, AppState>) -> AppResult<DiskUsage> {
    disk_stats_for(&state.install_dir().await)
}

#[derive(Serialize)]
struct StorageLocation {
    path: String,
    is_default: bool,
    available_bytes: u64,
    total_bytes: u64,
}

/// Every configured storage location with its free space, for the in-app
/// install destination picker.
#[tauri::command]
async fn list_storage_locations(state: State<'_, AppState>) -> AppResult<Vec<StorageLocation>> {
    let settings = state.settings.read().await;
    let default_dir = settings.install_dir.clone();
    let dirs = settings.all_install_dirs();
    drop(settings);

    let mut out = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let usage = disk_stats_for(&dir)?;
        out.push(StorageLocation {
            is_default: dir == default_dir,
            path: dir.to_string_lossy().to_string(),
            available_bytes: usage.available_bytes,
            total_bytes: usage.total_bytes,
        });
    }
    Ok(out)
}

/* ----------------------------------------------------------------- installs */

#[tauri::command]
async fn list_installed(state: State<'_, AppState>) -> AppResult<Vec<InstalledGame>> {
    state.installs.prune_missing().await?;
    Ok(state.installs.list().await)
}

/// Turns a completed download into an installed game.
///
/// Archive games are extracted and the archive deleted; folder games are
/// already laid out on disk. Either way the executable is resolved once, here,
/// so launching later never has to guess.
#[tauri::command]
async fn finish_install(
    state: State<'_, AppState>,
    game_id: String,
    title: String,
    downloaded_path: String,
) -> AppResult<InstalledGame> {
    let source = PathBuf::from(&downloaded_path);
    let install_root = state.install_dir().await.join(sanitise_folder_name(&title));

    let is_archive = source
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));

    if is_archive {
        tokio::fs::create_dir_all(&install_root).await?;
        let archive = source.clone();
        let destination = install_root.clone();
        // Extraction is CPU- and IO-bound and fully synchronous, so it runs on
        // the blocking pool rather than stalling the async runtime.
        tokio::task::spawn_blocking(move || install::extract_zip(&archive, &destination))
            .await
            .map_err(|err| AppError::Other(format!("Extraction failed: {err}")))??;
        let _ = tokio::fs::remove_file(&source).await;
    }

    let root = if is_archive {
        install_root
    } else if source.is_dir() {
        source
    } else {
        source
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or(install_root)
    };

    let detect_root = root.clone();
    let detect_title = title.clone();
    let executable = tokio::task::spawn_blocking(move || {
        install::detect_executable(&detect_root, &detect_title)
    })
    .await
    .map_err(|err| AppError::Other(format!("Could not scan the install: {err}")))?;

    let size_root = root.clone();
    let size_bytes = tokio::task::spawn_blocking(move || install::directory_size(&size_root))
        .await
        .unwrap_or(0);

    let record = InstalledGame {
        game_id,
        title,
        install_path: root,
        executable,
        size_bytes,
        installed_at: chrono::Utc::now().to_rfc3339(),
        save_base_sha256: None,
    };

    state.installs.record(record.clone()).await?;
    Ok(record)
}

/// Folders that look like games, for the "I already have this installed" flow.
///
/// Scanning is deliberately dumb about *which* game each folder holds: it
/// reports names, and the server does the matching against catalog titles with
/// the same normalisation the library scanner uses. Guessing here as well
/// would mean two implementations to keep in agreement.
#[tauri::command]
async fn scan_install_candidates(
    state: State<'_, AppState>,
    roots: Option<Vec<String>>,
) -> AppResult<Vec<InstallCandidate>> {
    let roots: Vec<PathBuf> = match roots {
        Some(paths) if !paths.is_empty() => paths.into_iter().map(PathBuf::from).collect(),
        // With nothing specified, the places this client already installs to
        // are the obvious things to offer.
        _ => state.settings.read().await.all_install_dirs(),
    };

    // Walking a whole drive is slow and fully synchronous, so it goes to the
    // blocking pool rather than stalling every other command.
    tokio::task::spawn_blocking(move || install::scan_for_games(&roots))
        .await
        .map_err(|err| AppError::Other(format!("Could not scan that folder: {err}")))
}

/// Registers a folder already on disk as an installed game.
///
/// The counterpart to `finish_install` for a copy the user obtained some other
/// way. Nothing is copied or moved: the folder stays exactly where it is, which
/// is the entire point — a player with 400 GB of games already installed should
/// not have to download them a second time.
#[tauri::command]
async fn link_installed(
    state: State<'_, AppState>,
    game_id: String,
    title: String,
    path: String,
) -> AppResult<InstalledGame> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::Other(format!(
            "\"{path}\" is not a folder on this machine"
        )));
    }

    if let Some(existing) = state.installs.get(&game_id).await {
        return Err(AppError::Other(format!(
            "\"{}\" is already linked to {}",
            existing.title,
            existing.install_path.display()
        )));
    }

    let detect_root = root.clone();
    let detect_title = title.clone();
    let executable = tokio::task::spawn_blocking(move || {
        install::detect_executable(&detect_root, &detect_title)
    })
    .await
    .map_err(|err| AppError::Other(format!("Could not scan that folder: {err}")))?;

    let size_root = root.clone();
    let size_bytes = tokio::task::spawn_blocking(move || install::directory_size(&size_root))
        .await
        .unwrap_or(0);

    let record = InstalledGame {
        game_id,
        title,
        install_path: root,
        executable,
        size_bytes,
        installed_at: chrono::Utc::now().to_rfc3339(),
        save_base_sha256: None,
    };

    state.installs.record(record.clone()).await?;
    Ok(record)
}

/// Forgets an installed game without deleting anything.
///
/// Distinct from `uninstall_game`, which removes the files. A linked folder was
/// never ours to delete — the user had it before GameBlade did — so unlinking
/// has to be a separate, obviously non-destructive action.
#[tauri::command]
async fn unlink_installed(state: State<'_, AppState>, game_id: String) -> AppResult<()> {
    if state.launcher.is_running(&game_id).await {
        return Err(AppError::Other(
            "Quit the game before unlinking it".to_string(),
        ));
    }
    state.installs.forget(&game_id).await
}

/// Shows an installed game's folder in the system file manager.
#[tauri::command]
async fn open_install_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    game_id: String,
) -> AppResult<()> {
    let installed = state
        .installs
        .get(&game_id)
        .await
        .ok_or_else(|| AppError::Other("That game is not installed".to_string()))?;

    if !installed.install_path.exists() {
        return Err(AppError::Other(
            "That folder is no longer on this machine".to_string(),
        ));
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(installed.install_path.to_string_lossy(), None::<&str>)
        .map_err(|err| AppError::Other(format!("Could not open the folder: {err}")))
}

/// Opens an operator-defined button's link in the user's browser.
///
/// Restricted to http(s) here as well as in the server's schema: this is the
/// point where a URL becomes something the OS acts on, so it does not rely on
/// the server having validated it.
#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> AppResult<()> {
    let lowered = url.trim().to_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Err(AppError::Other(
            "Only http and https links can be opened".to_string(),
        ));
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| AppError::Other(format!("Could not open that link: {err}")))
}

#[tauri::command]
async fn uninstall_game(state: State<'_, AppState>, game_id: String) -> AppResult<()> {
    if state.launcher.is_running(&game_id).await {
        return Err(AppError::Other(
            "Quit the game before uninstalling it".to_string(),
        ));
    }
    state.installs.uninstall(&game_id).await
}

/* ------------------------------------------------------------------ playing */

#[tauri::command]
async fn launch_game(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    executable_override: Option<String>,
    args: Option<String>,
    working_dir: Option<String>,
) -> AppResult<RunningGame> {
    let installed = state
        .installs
        .get(&game_id)
        .await
        .ok_or_else(|| AppError::Other("That game is not installed".to_string()))?;

    let executable = executable_override
        .map(PathBuf::from)
        .map(|relative| {
            if relative.is_absolute() {
                relative
            } else {
                installed.install_path.join(relative)
            }
        })
        .or_else(|| installed.executable.clone())
        .ok_or_else(|| {
            AppError::Other(
                "No executable was found for this game. Set one in the admin panel.".to_string(),
            )
        })?;

    let working = working_dir.map(PathBuf::from).map(|dir| {
        if dir.is_absolute() {
            dir
        } else {
            installed.install_path.join(dir)
        }
    });

    let client = state.client().await?;
    let (minimize, share_activity) = {
        let settings = state.settings.read().await;
        (settings.minimize_on_launch, settings.share_activity)
    };

    let running = state
        .launcher
        .clone()
        .launch(
            app.clone(),
            client,
            LaunchRequest {
                game_id,
                title: installed.title,
                executable,
                args,
                working_dir: working,
                share_activity,
            },
        )
        .await?;

    // Only once the game actually started. Minimizing first and then failing to
    // launch hides the error the player needs to read.
    //
    // This preference has been in settings.json since the settings page was
    // written and nothing ever read it, so the switch saved a value and the
    // window stayed exactly where it was.
    if minimize {
        if let Some(window) = app.get_webview_window("main") {
            // A window that will not minimize is not a reason to report the
            // launch as failed — the game is running either way.
            let _ = window.minimize();
        }
    }

    Ok(running)
}

#[tauri::command]
async fn running_game(state: State<'_, AppState>) -> AppResult<Option<RunningGame>> {
    Ok(state.launcher.current().await)
}

/// Closes the running game from the app, rather than from the game.
///
/// The button this backs used to be a greyed-out "Running" — accurate, and no
/// help at all to somebody whose game has hung behind a fullscreen window they
/// cannot get back to. It asks the process to close first and kills it if it
/// will not, so a game that handles the request still gets to save.
///
/// `game_id` is optional because the client is single-slot: the player pressing
/// Stop on the title bar means "the one that is running", and making the UI
/// look up an id to say that is ceremony.
#[tauri::command]
async fn stop_game(state: State<'_, AppState>, game_id: Option<String>) -> AppResult<bool> {
    match game_id {
        Some(id) => Ok(state.launcher.stop(&id).await),
        None => Ok(state.launcher.stop_current().await.is_some()),
    }
}

/* -------------------------------------------------------------- cloud saves */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveStatus {
    /// What the server thinks, verbatim, so the UI has the remote version too.
    remote: serde_json::Value,
    local: Option<LocalSave>,
}

/// Compares the local save against the cloud without changing either side.
#[tauri::command]
async fn save_status(
    state: State<'_, AppState>,
    game_id: String,
    rule: SaveRule,
) -> AppResult<SaveStatus> {
    let installed = state.installs.get(&game_id).await;
    let install_dir = installed
        .as_ref()
        .map(|game| game.install_path.clone())
        .unwrap_or_else(|| PathBuf::from("."));

    let scan_rule = rule.clone();
    let local = tokio::task::spawn_blocking(move || saves::inspect(&scan_rule, &install_dir))
        .await
        .map_err(|err| AppError::Other(format!("Could not read the save folder: {err}")))??;

    let base = installed
        .as_ref()
        .and_then(|game| game.save_base_sha256.clone());

    let mut query = format!("/saves/status?gameId={game_id}&slot=default");
    if let Some(local) = &local {
        query.push_str(&format!(
            "&sha256={}&capturedAt={}",
            local.sha256,
            urlencode(&local.captured_at)
        ));
    }
    if let Some(base) = base {
        query.push_str(&format!("&baseSha256={base}"));
    }

    let remote = state.client().await?.get_json(&query).await?;
    Ok(SaveStatus { remote, local })
}

/// Packs the local save and uploads it as a new cloud version.
#[tauri::command]
async fn push_save(
    state: State<'_, AppState>,
    game_id: String,
    rule: SaveRule,
    force: bool,
) -> AppResult<serde_json::Value> {
    let installed = state
        .installs
        .get(&game_id)
        .await
        .ok_or_else(|| AppError::Other("That game is not installed".to_string()))?;

    let archive = state
        .app_data
        .join("save-uploads")
        .join(format!("{game_id}.zip"));

    let pack_rule = rule.clone();
    let install_dir = installed.install_path.clone();
    let archive_path = archive.clone();
    let local =
        tokio::task::spawn_blocking(move || saves::pack(&pack_rule, &install_dir, &archive_path))
            .await
            .map_err(|err| AppError::Other(format!("Could not pack the save: {err}")))??;

    let base = installed.save_base_sha256.clone();
    let mut query = format!(
        "/saves?gameId={}&slot=default&sha256={}&sizeBytes={}&fileCount={}&capturedAt={}",
        game_id,
        file_sha256(&archive).await?,
        tokio::fs::metadata(&archive).await?.len(),
        local.file_count,
        urlencode(&local.captured_at),
    );
    if let Some(base) = base {
        query.push_str(&format!("&baseSha256={base}"));
    }
    if force {
        query.push_str("&force=true");
    }

    let result = state
        .client()
        .await?
        .upload_file(&query, &archive, "application/zip")
        .await;

    let _ = tokio::fs::remove_file(&archive).await;
    let version = result?;

    // Remember what was just synced so the next comparison can tell a local
    // edit from a remote one.
    state
        .installs
        .set_save_base(&game_id, Some(local.sha256))
        .await?;

    Ok(version)
}

/// Downloads a cloud save and writes it over the local one.
#[tauri::command]
async fn pull_save(
    state: State<'_, AppState>,
    game_id: String,
    rule: SaveRule,
    slot_id: String,
    version_id: Option<String>,
) -> AppResult<PathBuf> {
    let installed = state
        .installs
        .get(&game_id)
        .await
        .ok_or_else(|| AppError::Other("That game is not installed".to_string()))?;

    let archive = state
        .app_data
        .join("save-downloads")
        .join(format!("{game_id}.zip"));

    let path = match &version_id {
        Some(version) => format!("/saves/{slot_id}/download?version={version}"),
        None => format!("/saves/{slot_id}/download"),
    };

    state.client().await?.download_file(&path, &archive).await?;

    let restore_rule = rule.clone();
    let install_dir = installed.install_path.clone();
    let archive_path = archive.clone();
    let root = tokio::task::spawn_blocking(move || {
        saves::restore(&restore_rule, &install_dir, &archive_path)
    })
    .await
    .map_err(|err| AppError::Other(format!("Could not restore the save: {err}")))??;

    let _ = tokio::fs::remove_file(&archive).await;

    // Re-read what actually landed on disk; the restored digest is what the
    // next sync compares against, and it may differ from the archive's own.
    let verify_rule = rule.clone();
    let verify_dir = installed.install_path.clone();
    let restored = tokio::task::spawn_blocking(move || saves::inspect(&verify_rule, &verify_dir))
        .await
        .map_err(|err| AppError::Other(format!("Could not verify the save: {err}")))??;

    state
        .installs
        .set_save_base(&game_id, restored.map(|save| save.sha256))
        .await?;

    Ok(root)
}

/// Uploads a screenshot or clip for a social post.
#[tauri::command]
async fn upload_media(
    state: State<'_, AppState>,
    file_path: String,
    kind: String,
) -> AppResult<serde_json::Value> {
    let path = PathBuf::from(&file_path);
    let content_type = content_type_for(&path)
        .ok_or_else(|| AppError::Other("That file type cannot be uploaded".to_string()))?;

    state
        .client()
        .await?
        .upload_file(&format!("/media?kind={kind}"), &path, content_type)
        .await
}

/* ------------------------------------------------------------------ helpers */

fn content_type_for(path: &std::path::Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        Some("mp4") => Some("video/mp4"),
        Some("webm") => Some("video/webm"),
        _ => None,
    }
}

async fn file_sha256(path: &std::path::Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Percent-encodes the few characters that would break a query string. These
/// values are ISO timestamps and digests, so a full encoder would be overkill.
fn urlencode(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            ':' => "%3A".to_string(),
            '+' => "%2B".to_string(),
            ' ' => "%20".to_string(),
            '&' => "%26".to_string(),
            other => other.to_string(),
        })
        .collect()
}

/// Turns a game title into something Windows will accept as a folder name.
fn sanitise_folder_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();

    // Windows also rejects a trailing dot or space.
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "Game".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            std::fs::create_dir_all(&app_data).ok();

            // A previously saved device token means the user stays signed in
            // across restarts without re-entering a password. A credential left
            // over from a build that pointed somewhere else is discarded rather
            // than silently used against the wrong host.
            let restored = credentials::load().unwrap_or(None).filter(|session| {
                let matches = ApiClient::new(SERVER_URL, None)
                    .map(|client| client.base_url() == session.server_url)
                    .unwrap_or(false);
                if !matches {
                    let _ = credentials::clear();
                }
                matches
            });
            let loaded = settings::load(&app_data);

            // One session holder shared by the commands and the download
            // queue: a queued game activates with whatever credentials are
            // current when it reaches the front of the line.
            let session = Arc::new(RwLock::new(restored));
            let provider_session = session.clone();
            let downloads = DownloadManager::new(
                &app_data,
                Arc::new(move || {
                    let session = provider_session.clone();
                    Box::pin(async move {
                        let guard = session.read().await;
                        match guard.as_ref() {
                            Some(stored) => {
                                ApiClient::new(&stored.server_url, Some(stored.token.clone()))
                            }
                            None => Err(AppError::NotSignedIn),
                        }
                    })
                }),
            );
            downloads.set_transfer_options(download::TransferOptions {
                connections: loaded.download_concurrency,
                verify: loaded.verify_downloads,
            });
            downloads.start_scheduler(app.handle().clone());

            let cache = Arc::new(offline::Cache::new(&app_data));

            app.manage(AppState {
                session,
                settings: RwLock::new(loaded),
                installs: Arc::new(InstallManager::load(&app_data)),
                app_data,
                downloads,
                launcher: Arc::new(Launcher::default()),
                realtime: RealtimeClient::default(),
                // Optimistic until something says otherwise: assuming the
                // server is down before anybody has tried would put an offline
                // banner over a perfectly healthy first launch.
                online: Arc::new(AtomicBool::new(true)),
                cache,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_session,
            sign_in,
            sign_out,
            verify_session,
            api_get,
            connectivity,
            recheck_connection,
            realtime_connected,
            api_post,
            api_put,
            api_patch,
            api_delete,
            image_url,
            read_rule_file,
            client_version,
            run_client_installer,
            get_settings,
            update_settings,
            start_download,
            cancel_download,
            pause_download,
            clear_download,
            list_downloads,
            disk_usage,
            list_storage_locations,
            list_installed,
            finish_install,
            scan_install_candidates,
            link_installed,
            unlink_installed,
            open_install_folder,
            open_external,
            uninstall_game,
            launch_game,
            running_game,
            stop_game,
            save_status,
            push_save,
            pull_save,
            upload_media,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GameBlade");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_is_pinned_to_one_server() {
        // Repointing a shipped build must not be possible at run time; the only
        // override is a compile-time env var for local development.
        let client = ApiClient::new(SERVER_URL, None).expect("client");
        assert_eq!(client.base_url(), "https://archive.scopedd.lol");
    }

    #[test]
    fn folder_names_drop_characters_windows_rejects() {
        assert_eq!(sanitise_folder_name("Hero: Rebirth"), "Hero_ Rebirth");
        assert_eq!(sanitise_folder_name("a/b\\c"), "a_b_c");
    }

    #[test]
    fn folder_names_never_end_in_a_dot_or_space() {
        assert_eq!(sanitise_folder_name("Portal 2. "), "Portal 2");
        assert_eq!(sanitise_folder_name("   "), "Game");
    }

    #[test]
    fn urlencode_escapes_timestamp_colons() {
        assert_eq!(
            urlencode("2026-01-01T12:30:00Z"),
            "2026-01-01T12%3A30%3A00Z"
        );
    }

    #[test]
    fn content_type_is_recognised_case_insensitively() {
        assert_eq!(
            content_type_for(std::path::Path::new("clip.MP4")),
            Some("video/mp4")
        );
        assert_eq!(
            content_type_for(std::path::Path::new("shot.PNG")),
            Some("image/png")
        );
        assert_eq!(content_type_for(std::path::Path::new("notes.txt")), None);
    }
}
