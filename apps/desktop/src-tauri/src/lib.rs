mod api;
mod credentials;
mod downloader;
mod error;

use api::{ApiClient, UserInfo};
use credentials::StoredSession;
use downloader::{DownloadManager, DownloadState};
use error::{AppError, AppResult};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::RwLock;

/// Everything the commands need. The session is behind a lock because signing
/// in and out mutates it while downloads may still be reading it.
struct AppState {
    session: RwLock<Option<StoredSession>>,
    downloads: Arc<DownloadManager>,
}

impl AppState {
    async fn client(&self) -> AppResult<ApiClient> {
        let session = self.session.read().await;
        let session = session.as_ref().ok_or(AppError::NotSignedIn)?;
        ApiClient::new(&session.server_url, Some(session.token.clone()))
    }
}

#[derive(Serialize)]
struct SessionInfo {
    server_url: String,
    username: String,
    role: String,
}

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
    state: State<'_, AppState>,
    server_url: String,
    username: String,
    password: String,
) -> AppResult<UserInfo> {
    let client = ApiClient::new(&server_url, None)?;
    let (token, user) = client.sign_in(&username, &password).await?;

    let stored = StoredSession {
        server_url: client.base_url().to_string(),
        token,
        username: user.username.clone(),
        role: user.role.clone(),
    };

    credentials::save(&stored)?;
    *state.session.write().await = Some(stored);
    Ok(user)
}

#[tauri::command]
async fn sign_out(state: State<'_, AppState>) -> AppResult<()> {
    credentials::clear()?;
    *state.session.write().await = None;
    Ok(())
}

/// Confirms the stored token is still accepted; a revoked device lands here.
#[tauri::command]
async fn verify_session(state: State<'_, AppState>) -> AppResult<UserInfo> {
    let client = state.client().await?;
    match client.session().await {
        Ok(user) => Ok(user),
        Err(err) => {
            // The token is gone or revoked, so drop it rather than retrying forever.
            if matches!(err, AppError::Server(_)) {
                let _ = credentials::clear();
                *state.session.write().await = None;
            }
            Err(err)
        }
    }
}

/// Pass-through to the server's game listing, so filters stay server-side.
#[tauri::command]
async fn fetch_games(state: State<'_, AppState>, query: String) -> AppResult<serde_json::Value> {
    let client = state.client().await?;
    client.get_json(&format!("/games{query}")).await
}

#[tauri::command]
async fn fetch_game(state: State<'_, AppState>, game_id: String) -> AppResult<serde_json::Value> {
    let client = state.client().await?;
    client.get_json(&format!("/games/{game_id}")).await
}

/// Artwork needs the device token, which an <img> tag cannot send, so the URL
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

#[tauri::command]
async fn start_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    destination: String,
) -> AppResult<()> {
    let client = state.client().await?;
    let manifest = client.manifest(&game_id).await?;

    state
        .downloads
        .clone()
        .start(app, client, manifest, PathBuf::from(destination))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // A previously saved device token means the user stays signed in
            // across restarts without re-entering a password.
            let restored = credentials::load().unwrap_or(None);
            app.manage(AppState {
                session: RwLock::new(restored),
                downloads: Arc::new(DownloadManager::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_session,
            sign_in,
            sign_out,
            verify_session,
            fetch_games,
            fetch_game,
            image_url,
            start_download,
            cancel_download,
            clear_download,
            list_downloads,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GameBlade");
}
