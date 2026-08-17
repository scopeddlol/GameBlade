mod api;
mod credentials;
mod downloader;
mod error;
mod install;
mod launcher;
mod realtime;
mod saves;
mod settings;

use api::{ApiClient, UserInfo};
use credentials::StoredSession;
use downloader::{DownloadManager, DownloadState};
use error::{AppError, AppResult};
use install::{InstallManager, InstalledGame};
use launcher::{Launcher, RunningGame};
use realtime::RealtimeClient;
use saves::{LocalSave, SaveRule};
use serde::Serialize;
use settings::Settings;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::RwLock;

/// Everything the commands need. The session is behind a lock because signing
/// in and out mutates it while downloads may still be reading it.
struct AppState {
    session: RwLock<Option<StoredSession>>,
    settings: RwLock<Settings>,
    app_data: PathBuf,
    downloads: Arc<DownloadManager>,
    installs: Arc<InstallManager>,
    launcher: Arc<Launcher>,
    realtime: RealtimeClient,
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
}

#[derive(Serialize)]
struct SessionInfo {
    server_url: String,
    username: String,
    role: String,
}

/* ------------------------------------------------------------------ session */

#[tauri::command]
async fn current_session(state: State<'_, AppState>) -> AppResult<Option<SessionInfo>> {
    let session = state.session.read().await;
    Ok(session.as_ref().map(|s| SessionInfo {
        server_url: s.server_url.clone(),
        username: s.username.clone(),
        role: s.role.clone(),
    }))
}

#[tauri::command]
async fn sign_in(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_url: String,
    username: String,
    password: String,
) -> AppResult<UserInfo> {
    let client = ApiClient::new(&server_url, None)?;
    let (token, user) = client.sign_in(&username, &password).await?;

    let stored = StoredSession {
        server_url: client.base_url().to_string(),
        token: token.clone(),
        username: user.username.clone(),
        role: user.role.clone(),
    };

    credentials::save(&stored)?;
    state.realtime.start(app, stored.server_url.clone(), token);
    *state.session.write().await = Some(stored);
    Ok(user)
}

#[tauri::command]
async fn sign_out(state: State<'_, AppState>) -> AppResult<()> {
    state.realtime.stop();
    credentials::clear()?;
    *state.session.write().await = None;
    Ok(())
}

/// Confirms the stored token is still accepted; a revoked device lands here.
#[tauri::command]
async fn verify_session(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<UserInfo> {
    let client = state.client().await?;
    match client.session().await {
        Ok(user) => {
            // A restored session has no socket yet, so opening it here is what
            // makes presence work after a restart rather than only after a login.
            if !state.realtime.is_running() {
                if let Some(session) = state.session.read().await.as_ref() {
                    state
                        .realtime
                        .start(app, session.server_url.clone(), session.token.clone());
                }
            }
            Ok(user)
        }
        Err(err) => {
            // The token is gone or revoked, so drop it rather than retrying forever.
            if matches!(err, AppError::Server(_)) {
                let _ = credentials::clear();
                *state.session.write().await = None;
                state.realtime.stop();
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
async fn api_get(state: State<'_, AppState>, path: String) -> AppResult<serde_json::Value> {
    state.client().await?.get_json(&path).await
}

#[tauri::command]
async fn api_post(
    state: State<'_, AppState>,
    path: String,
    body: Option<serde_json::Value>,
) -> AppResult<serde_json::Value> {
    state
        .client()
        .await?
        .post_json(&path, &body.unwrap_or(serde_json::Value::Null))
        .await
}

#[tauri::command]
async fn api_put(
    state: State<'_, AppState>,
    path: String,
    body: Option<serde_json::Value>,
) -> AppResult<serde_json::Value> {
    state
        .client()
        .await?
        .put_json(&path, &body.unwrap_or(serde_json::Value::Null))
        .await
}

#[tauri::command]
async fn api_delete(state: State<'_, AppState>, path: String) -> AppResult<serde_json::Value> {
    state.client().await?.delete_json(&path).await
}

/// Artwork needs the device token, which an `<img>` tag cannot send, so the URL
/// carries it as a query parameter instead.
#[tauri::command]
async fn image_url(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let session = state.session.read().await;
    let session = session.as_ref().ok_or(AppError::NotSignedIn)?;
    let separator = if path.contains('?') { '&' } else { '?' };
    Ok(format!(
        "{}{}{}token={}",
        session.server_url, path, separator, session.token
    ))
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
    Ok(sanitised)
}

/* ---------------------------------------------------------------- downloads */

#[tauri::command]
async fn start_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    destination: Option<String>,
) -> AppResult<()> {
    let client = state.client().await?;
    let manifest = client.manifest(&game_id).await?;

    // Without an explicit destination the configured install directory is used,
    // which is what makes one-click install work from the Store.
    let target = match destination {
        Some(path) => PathBuf::from(path),
        None => state.install_dir().await,
    };

    state
        .downloads
        .clone()
        .start(app, client, manifest, target)
        .await
}

#[tauri::command]
async fn cancel_download(state: State<'_, AppState>, game_id: String) -> AppResult<bool> {
    Ok(state.downloads.cancel(&game_id).await)
}

#[tauri::command]
async fn clear_download(state: State<'_, AppState>, game_id: String) -> AppResult<()> {
    state.downloads.forget(&game_id).await;
    Ok(())
}

#[tauri::command]
async fn list_downloads(state: State<'_, AppState>) -> AppResult<Vec<DownloadState>> {
    Ok(state.downloads.snapshot().await)
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
    state
        .launcher
        .clone()
        .launch(
            app,
            client,
            game_id,
            installed.title,
            executable,
            args,
            working,
        )
        .await
}

#[tauri::command]
async fn running_game(state: State<'_, AppState>) -> AppResult<Option<RunningGame>> {
    Ok(state.launcher.current().await)
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
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            std::fs::create_dir_all(&app_data).ok();

            // A previously saved device token means the user stays signed in
            // across restarts without re-entering a password.
            let restored = credentials::load().unwrap_or(None);
            let loaded = settings::load(&app_data);

            app.manage(AppState {
                session: RwLock::new(restored),
                settings: RwLock::new(loaded),
                installs: Arc::new(InstallManager::load(&app_data)),
                app_data,
                downloads: Arc::new(DownloadManager::default()),
                launcher: Arc::new(Launcher::default()),
                realtime: RealtimeClient::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_session,
            sign_in,
            sign_out,
            verify_session,
            api_get,
            api_post,
            api_put,
            api_delete,
            image_url,
            get_settings,
            update_settings,
            start_download,
            cancel_download,
            clear_download,
            list_downloads,
            list_installed,
            finish_install,
            uninstall_game,
            launch_game,
            running_game,
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
