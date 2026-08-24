use crate::api::{ApiClient, DownloadManifest, ManifestFile};
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, Semaphore};

/// Files smaller than this are fetched on one connection; splitting them costs
/// more in extra round trips than it recovers in throughput.
const MULTI_SEGMENT_THRESHOLD: u64 = 32 * 1024 * 1024;

/// Per-file connection count when segmenting. Four is enough to saturate a
/// tunnelled link without looking like abuse to the server.
const SEGMENTS_PER_FILE: u64 = 4;

const MAX_ATTEMPTS: u32 = 6;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Verifying,
    Completed,
    Failed,
    Canceled,
    Paused,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadState {
    pub game_id: String,
    pub title: String,
    pub status: DownloadStatus,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub bytes_per_second: u64,
    pub files_total: usize,
    pub files_completed: usize,
    pub current_file: Option<String>,
    pub destination: String,
    pub error: Option<String>,
}

/// Resume state persisted beside a partially downloaded file.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PartFile {
    size: u64,
    segments: Vec<Segment>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Segment {
    start: u64,
    end: u64,
    /// Bytes already written for this segment, relative to `start`.
    done: u64,
}

impl Segment {
    fn is_complete(&self) -> bool {
        self.start + self.done > self.end
    }

    fn remaining_from(&self) -> u64 {
        self.start + self.done
    }
}

struct Handle {
    cancel: Arc<AtomicBool>,
    /// Set by `pause`, never by `cancel` — both stop the same in-flight
    /// segments, but this is what tells the finalizer to report `Paused`
    /// (and leave the `.gbpart` sidecars alone for a later resume) instead
    /// of `Canceled`.
    paused: Arc<AtomicBool>,
    /// Set alongside `cancel` when the user asked for the bytes already on
    /// disk to go too. Read by the finalizer once every segment has stopped
    /// writing, so a purge can never race a write.
    purge: Arc<AtomicBool>,
    state: Arc<Mutex<DownloadState>>,
    /// Exactly what this download is responsible for, so cancelling can remove
    /// what it wrote and nothing else.
    cleanup: Arc<CleanupPlan>,
}

/// The paths one download owns.
///
/// Held rather than derived at deletion time because `forget` can be asked to
/// clean up a download whose task ended long ago and whose manifest is gone.
#[derive(Debug)]
pub struct CleanupPlan {
    root: PathBuf,
    /// True only when `root` was created for this download alone — a folder
    /// game unpacks into a directory named after its title, where a
    /// single-archive game lands directly in the folder the user picked.
    owns_root: bool,
    /// Relative to `root`, already sanitised.
    files: Vec<PathBuf>,
}

impl CleanupPlan {
    fn new(manifest: &DownloadManifest, root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            owns_root: manifest.kind == "folder",
            files: manifest
                .files
                .iter()
                .filter_map(|file| sanitise_relative_path(&file.path).ok())
                .collect(),
        }
    }
}

/// Removes what a cancelled download wrote, and nothing else.
///
/// Path by path from the manifest rather than a recursive delete of `root`:
/// for a single-archive game `root` is the install folder the user chose,
/// which may well hold every other game they own. Directories this download
/// created are pruned deepest-first and only while they are empty, so a folder
/// that already had something else in it survives. `root` itself goes only
/// when this download created it.
///
/// Every failure is ignored on purpose. A file the user has since opened, or
/// moved, or that was never written in the first place, is not a reason to
/// leave the rest of a 100 GB abandoned transfer sitting on the disk.
async fn purge_download(plan: &CleanupPlan) {
    let mut directories: Vec<PathBuf> = Vec::new();

    for relative in &plan.files {
        let dest = plan.root.join(relative);
        // The sidecar first: on its own it is worthless, and leaving one
        // behind would make a later download think it can resume into a file
        // that is no longer there.
        let _ = tokio::fs::remove_file(part_path_for(&dest)).await;
        let _ = tokio::fs::remove_file(&dest).await;

        let mut parent = dest.parent().map(Path::to_path_buf);
        while let Some(directory) = parent {
            if directory == plan.root || !directory.starts_with(&plan.root) {
                break;
            }
            if !directories.contains(&directory) {
                directories.push(directory.clone());
            }
            parent = directory.parent().map(Path::to_path_buf);
        }
    }

    // Deepest first, so a nested tree empties from the leaves inwards.
    directories.sort_by_key(|directory| std::cmp::Reverse(directory.components().count()));
    for directory in directories {
        // Fails while anything is left inside, which is exactly the guard that
        // keeps a shared folder from being taken with the download.
        let _ = tokio::fs::remove_dir(&directory).await;
    }

    if plan.owns_root {
        let _ = tokio::fs::remove_dir(&plan.root).await;
    }
}

#[derive(Default)]
pub struct DownloadManager {
    downloads: Mutex<HashMap<String, Handle>>,
}

impl DownloadManager {
    pub async fn snapshot(&self) -> Vec<DownloadState> {
        let downloads = self.downloads.lock().await;
        let mut out = Vec::with_capacity(downloads.len());
        for handle in downloads.values() {
            out.push(handle.state.lock().await.clone());
        }
        out.sort_by(|a, b| a.title.cmp(&b.title));
        out
    }

    /// Stops a transfer, optionally taking the bytes already on disk with it.
    ///
    /// A cancelled 250 GB download that got 100 GB in used to leave all 100 GB
    /// behind with nothing in the app ever mentioning them again. The deletion
    /// itself happens in the finalizer rather than here: segments are still
    /// writing at this point, and removing a file out from under them would
    /// only recreate it.
    pub async fn cancel(&self, game_id: &str, delete_files: bool) -> bool {
        let downloads = self.downloads.lock().await;
        match downloads.get(game_id) {
            Some(handle) => {
                // Recorded before the stop signal, so the finalizer cannot
                // observe the transfer ending before it observes the intent.
                if delete_files {
                    handle.purge.store(true, Ordering::SeqCst);
                }
                handle.cancel.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Stops the transfer without discarding progress. The same `.gbpart`
    /// resume machinery that lets a failed download pick up where it left
    /// off makes "resume" nothing more than starting the same game again.
    pub async fn pause(&self, game_id: &str) -> bool {
        let downloads = self.downloads.lock().await;
        match downloads.get(game_id) {
            Some(handle) => {
                handle.paused.store(true, Ordering::SeqCst);
                handle.cancel.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Drops a finished entry from the queue, optionally deleting what it left.
    ///
    /// The counterpart to `cancel` for a download that has already stopped: a
    /// paused or failed one keeps every byte it fetched, and dismissing its row
    /// was the last time anyone was ever told about them.
    pub async fn forget(&self, game_id: &str, delete_files: bool) {
        let handle = self.downloads.lock().await.remove(game_id);
        if !delete_files {
            return;
        }
        let Some(handle) = handle else { return };

        // A live download is `cancel`'s job — it waits for the segments to stop
        // before deleting under them, which this cannot do.
        let status = handle.state.lock().await.status;
        if matches!(
            status,
            DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Verifying
        ) {
            return;
        }

        purge_download(&handle.cleanup).await;
    }

    /// Begin (or resume) a download. Returns immediately; progress arrives as
    /// `download://progress` events.
    pub async fn start(
        self: Arc<Self>,
        app: AppHandle,
        client: ApiClient,
        manifest: DownloadManifest,
        destination: PathBuf,
    ) -> AppResult<()> {
        let game_id = manifest.game_id.clone();

        {
            let downloads = self.downloads.lock().await;
            if let Some(existing) = downloads.get(&game_id) {
                let status = existing.state.lock().await.status;
                if matches!(
                    status,
                    DownloadStatus::Queued
                        | DownloadStatus::Downloading
                        | DownloadStatus::Verifying
                ) {
                    return Err(AppError::Other(
                        "That game is already downloading".to_string(),
                    ));
                }
            }
        }

        // Folder games unpack into a directory named after the title; a
        // single-archive game lands directly in the chosen folder.
        let root = if manifest.kind == "folder" {
            destination.join(sanitise_component(&manifest.title))
        } else {
            destination.clone()
        };

        let state = Arc::new(Mutex::new(DownloadState {
            game_id: game_id.clone(),
            title: manifest.title.clone(),
            status: DownloadStatus::Queued,
            total_bytes: manifest.total_bytes,
            downloaded_bytes: 0,
            bytes_per_second: 0,
            files_total: manifest.files.len(),
            files_completed: 0,
            current_file: None,
            destination: root.to_string_lossy().to_string(),
            error: None,
        }));

        let cancel = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let purge = Arc::new(AtomicBool::new(false));
        let cleanup = Arc::new(CleanupPlan::new(&manifest, &root));
        self.downloads.lock().await.insert(
            game_id.clone(),
            Handle {
                cancel: cancel.clone(),
                paused: paused.clone(),
                purge: purge.clone(),
                state: state.clone(),
                cleanup: cleanup.clone(),
            },
        );

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = run_download(
                app.clone(),
                client,
                manifest,
                root,
                state.clone(),
                cancel.clone(),
            )
            .await;

            // Every segment has stopped writing by the time `run_download`
            // returns, so this is the first moment a purge cannot race one.
            // It runs before the final event, so the queue never shows a
            // cancelled download for the seconds it takes to free the space.
            let purged = purge.load(Ordering::SeqCst);
            if purged {
                purge_download(&cleanup).await;
            }

            let mut guard = state.lock().await;
            guard.status = match result {
                // Ahead of `paused`: pausing and then cancelling with deletion
                // sets both, and what the user last asked for was to cancel.
                Ok(()) if purged => DownloadStatus::Canceled,
                Ok(()) if paused.load(Ordering::SeqCst) => DownloadStatus::Paused,
                Ok(()) if cancel.load(Ordering::SeqCst) => DownloadStatus::Canceled,
                Ok(()) => DownloadStatus::Completed,
                Err(err) => {
                    guard.error = Some(err.to_string());
                    DownloadStatus::Failed
                }
            };
            // Nothing is on disk any more, so a progress bar left at 40% would
            // be describing files that no longer exist.
            if purged {
                guard.downloaded_bytes = 0;
            }
            guard.bytes_per_second = 0;
            guard.current_file = None;
            let snapshot = guard.clone();
            drop(guard);

            let _ = app.emit("download://progress", &snapshot);
            let _ = manager; // keep the manager alive for the task's lifetime
        });

        Ok(())
    }
}

async fn run_download(
    app: AppHandle,
    client: ApiClient,
    manifest: DownloadManifest,
    root: PathBuf,
    state: Arc<Mutex<DownloadState>>,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    tokio::fs::create_dir_all(&root).await?;

    {
        let mut guard = state.lock().await;
        guard.status = DownloadStatus::Downloading;
    }

    let downloaded = Arc::new(AtomicU64::new(0));

    // Drive the progress event from one place so the UI gets a steady rate
    // reading rather than a spike per chunk.
    let reporter = {
        let app = app.clone();
        let state = state.clone();
        let downloaded = downloaded.clone();
        let cancel = cancel.clone();
        tauri::async_runtime::spawn(async move {
            let mut last_bytes = 0u64;
            let mut last_at = Instant::now();
            loop {
                tokio::time::sleep(PROGRESS_INTERVAL).await;

                let current = downloaded.load(Ordering::Relaxed);
                let elapsed = last_at.elapsed().as_secs_f64();
                let rate = if elapsed > 0.0 {
                    ((current.saturating_sub(last_bytes)) as f64 / elapsed) as u64
                } else {
                    0
                };
                last_bytes = current;
                last_at = Instant::now();

                let snapshot = {
                    let mut guard = state.lock().await;
                    guard.downloaded_bytes = current;
                    guard.bytes_per_second = rate;
                    if !matches!(
                        guard.status,
                        DownloadStatus::Downloading | DownloadStatus::Verifying
                    ) {
                        break;
                    }
                    guard.clone()
                };

                let _ = app.emit("download://progress", &snapshot);

                if cancel.load(Ordering::SeqCst) {
                    break;
                }
            }
        })
    };

    let mut completed = 0usize;
    let mut result = Ok(());

    for file in &manifest.files {
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        {
            let mut guard = state.lock().await;
            guard.current_file = Some(file.path.clone());
        }

        match download_file(
            &client,
            &manifest,
            file,
            &root,
            downloaded.clone(),
            cancel.clone(),
        )
        .await
        {
            Ok(()) => {
                completed += 1;
                let mut guard = state.lock().await;
                guard.files_completed = completed;
            }
            Err(err) => {
                result = Err(err);
                break;
            }
        }
    }

    {
        let mut guard = state.lock().await;
        guard.downloaded_bytes = downloaded.load(Ordering::Relaxed);
        // Ends the reporter loop.
        guard.status = if result.is_ok() {
            DownloadStatus::Verifying
        } else {
            DownloadStatus::Failed
        };

        if result.is_ok() {
            if let Some(path) = archive_file_path(&root, &manifest.kind, &manifest.files) {
                guard.destination = path.to_string_lossy().to_string();
            }
        }
    }
    reporter.abort();

    result
}

/// The path a finished download should be reported at.
///
/// `destination` starts out as the containing folder, which is right for a
/// folder game — several files land there, and there is nothing to extract.
/// An archive game is exactly one file, and `finish_install` decides whether
/// to extract by checking this path's extension, so reporting the folder
/// instead of the `.zip` inside it meant that check never matched: the
/// archive sat there unextracted, install fell through to treating the
/// folder as an already-installed one, and no executable was ever found in
/// it. Returns `None` for a folder game, where the original folder path is
/// already correct and nothing needs to change.
fn archive_file_path(root: &Path, kind: &str, files: &[ManifestFile]) -> Option<PathBuf> {
    if kind == "folder" {
        return None;
    }
    let [only] = files else { return None };
    sanitise_relative_path(&only.path)
        .ok()
        .map(|rel| root.join(rel))
}

async fn download_file(
    client: &ApiClient,
    manifest: &DownloadManifest,
    file: &ManifestFile,
    root: &Path,
    downloaded: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let relative = sanitise_relative_path(&file.path)?;
    let dest = root.join(&relative);

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let part_path = part_path_for(&dest);

    // Already complete from an earlier run: count it and move on.
    if let Ok(meta) = tokio::fs::metadata(&dest).await {
        if meta.len() == file.size_bytes && !part_path.exists() {
            downloaded.fetch_add(file.size_bytes, Ordering::Relaxed);
            return Ok(());
        }
    }

    // The signed manifest token authorises every segment request, so the
    // device token is not replayed across dozens of parallel connections.
    let url = format!(
        "{}?token={}",
        client.endpoint(&format!("/download/{}/files/{}", manifest.game_id, file.id)),
        urlencode(&manifest.token)
    );

    let part = load_or_create_part(&part_path, file.size_bytes).await?;

    // Count bytes recovered from a previous run so progress starts where it left off.
    let already: u64 = part.segments.iter().map(|s| s.done).sum();
    downloaded.fetch_add(already, Ordering::Relaxed);

    // truncate(false) is load-bearing on a resume: the bytes already on disk are
    // exactly what the .gbpart journal accounts for, and discarding them here
    // would restart every segment from zero. set_len only sizes the file so the
    // segments can seek and write at their own offsets.
    let handle = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&dest)
        .await?;
    handle.set_len(file.size_bytes).await?;
    drop(handle);

    let part = Arc::new(Mutex::new(part));
    let semaphore = Arc::new(Semaphore::new(SEGMENTS_PER_FILE as usize));
    let mut tasks = Vec::new();

    let segment_count = { part.lock().await.segments.len() };

    for index in 0..segment_count {
        let segment = { part.lock().await.segments[index] };
        if segment.is_complete() {
            continue;
        }

        let permit = semaphore.clone().acquire_owned().await.map_err(|err| {
            AppError::Other(format!("Could not schedule a download segment: {err}"))
        })?;

        let client = client.clone();
        let url = url.clone();
        let dest = dest.clone();
        let part = part.clone();
        let part_path = part_path.clone();
        let downloaded = downloaded.clone();
        let cancel = cancel.clone();

        tasks.push(tauri::async_runtime::spawn(async move {
            let _permit = permit;
            download_segment(
                &client, &url, &dest, part, &part_path, index, downloaded, cancel,
            )
            .await
        }));
    }

    for task in tasks {
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return Err(err),
            Err(err) => return Err(AppError::Other(format!("Download task failed: {err}"))),
        }
    }

    if cancel.load(Ordering::SeqCst) {
        // Leave the .gbpart sidecar in place so the transfer can resume later.
        return Ok(());
    }

    // Everything landed, so the resume sidecar is no longer needed.
    let _ = tokio::fs::remove_file(&part_path).await;

    if let Some(expected) = file.sha256.as_ref() {
        let actual = hash_file(&dest).await?;
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&dest).await;
            return Err(AppError::Other(format!(
                "{} failed its checksum and was removed. Try downloading it again.",
                file.path
            )));
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn download_segment(
    client: &ApiClient,
    url: &str,
    dest: &Path,
    part: Arc<Mutex<PartFile>>,
    part_path: &Path,
    index: usize,
    downloaded: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let mut attempt = 0u32;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }

        let segment = { part.lock().await.segments[index] };
        if segment.is_complete() {
            return Ok(());
        }

        let from = segment.remaining_from();
        let range = format!("bytes={}-{}", from, segment.end);

        let attempt_result = async {
            let response = client
                .http()
                .get(url)
                .header(reqwest::header::RANGE, &range)
                .send()
                .await?;

            if !response.status().is_success() {
                return Err(AppError::Server(format!(
                    "Server returned {} for a range request",
                    response.status()
                )));
            }

            let mut file = tokio::fs::OpenOptions::new().write(true).open(dest).await?;
            file.seek(std::io::SeekFrom::Start(from)).await?;

            let mut stream = response.bytes_stream();
            let mut written_since_save = 0u64;

            while let Some(chunk) = stream.next().await {
                if cancel.load(Ordering::SeqCst) {
                    file.flush().await?;
                    save_part(part_path, &*part.lock().await).await?;
                    return Ok(());
                }

                let chunk = chunk?;
                file.write_all(&chunk).await?;

                let len = chunk.len() as u64;
                downloaded.fetch_add(len, Ordering::Relaxed);
                written_since_save += len;

                {
                    let mut guard = part.lock().await;
                    guard.segments[index].done += len;
                }

                // Persist resume state periodically, not per chunk.
                if written_since_save >= 8 * 1024 * 1024 {
                    file.flush().await?;
                    save_part(part_path, &*part.lock().await).await?;
                    written_since_save = 0;
                }
            }

            file.flush().await?;
            save_part(part_path, &*part.lock().await).await?;
            Ok(())
        }
        .await;

        match attempt_result {
            Ok(()) => {
                let segment = { part.lock().await.segments[index] };
                // A truncated response is not an error at the HTTP layer, so
                // treat a short segment as a retryable failure.
                if segment.is_complete() || cancel.load(Ordering::SeqCst) {
                    return Ok(());
                }
                attempt += 1;
            }
            Err(err) => {
                attempt += 1;
                if attempt >= MAX_ATTEMPTS {
                    return Err(err);
                }
            }
        }

        if attempt >= MAX_ATTEMPTS {
            return Err(AppError::Other(
                "The connection kept dropping. The download was paused and can be resumed."
                    .to_string(),
            ));
        }

        // Exponential backoff, capped, so a flaky tunnel recovers on its own.
        let delay = Duration::from_millis(500u64.saturating_mul(1 << attempt.min(5)));
        tokio::time::sleep(delay.min(Duration::from_secs(20))).await;
    }
}

async fn load_or_create_part(part_path: &Path, size: u64) -> AppResult<PartFile> {
    if let Ok(contents) = tokio::fs::read(part_path).await {
        if let Ok(existing) = serde_json::from_slice::<PartFile>(&contents) {
            // Only trust the sidecar if it describes the same file.
            if existing.size == size {
                return Ok(existing);
            }
        }
    }

    let part = PartFile {
        size,
        segments: plan_segments(size),
    };
    save_part(part_path, &part).await?;
    Ok(part)
}

fn plan_segments(size: u64) -> Vec<Segment> {
    if size == 0 {
        return vec![Segment {
            start: 0,
            end: 0,
            done: 1,
        }];
    }

    if size < MULTI_SEGMENT_THRESHOLD {
        return vec![Segment {
            start: 0,
            end: size - 1,
            done: 0,
        }];
    }

    let count = SEGMENTS_PER_FILE;
    let chunk = size / count;
    (0..count)
        .map(|i| {
            let start = i * chunk;
            let end = if i == count - 1 {
                size - 1
            } else {
                start + chunk - 1
            };
            Segment {
                start,
                end,
                done: 0,
            }
        })
        .collect()
}

async fn save_part(path: &Path, part: &PartFile) -> AppResult<()> {
    let encoded = serde_json::to_vec(part)?;
    tokio::fs::write(path, encoded).await?;
    Ok(())
}

fn part_path_for(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".gbpart");
    dest.with_file_name(name)
}

async fn hash_file(path: &Path) -> AppResult<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];

    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex::encode(hasher.finalize()))
}

/// Reject anything that would write outside the chosen destination folder.
fn sanitise_relative_path(relative: &str) -> AppResult<PathBuf> {
    let mut out = PathBuf::new();
    for part in relative.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(AppError::Other(format!(
                "The server sent an unsafe file path: {relative}"
            )));
        }
        out.push(sanitise_component(part));
    }

    if out.as_os_str().is_empty() {
        return Err(AppError::Other("The server sent an empty file path".into()));
    }
    Ok(out)
}

fn sanitise_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches([' ', '.']).to_string();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed
    }
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> ManifestFile {
        ManifestFile {
            id: "f1".to_string(),
            path: path.to_string(),
            size_bytes: 0,
            sha256: None,
        }
    }

    #[test]
    fn archive_file_path_points_at_the_file_inside_the_folder() {
        let root = Path::new("/games/Cave Story");
        let path = archive_file_path(root, "archive", &[file("Cave Story.zip")]);
        assert_eq!(path, Some(root.join("Cave Story.zip")));
    }

    #[test]
    fn archive_file_path_is_none_for_a_folder_game() {
        let root = Path::new("/games/Cave Story");
        let path = archive_file_path(root, "folder", &[file("data/game.dat"), file("game.exe")]);
        assert_eq!(path, None);
    }

    #[test]
    fn archive_file_path_is_none_without_exactly_one_file() {
        let root = Path::new("/games/Cave Story");
        assert_eq!(archive_file_path(root, "archive", &[]), None);
        assert_eq!(
            archive_file_path(root, "archive", &[file("a.zip"), file("b.zip")]),
            None,
        );
    }

    /* ------------------------------------------------------------- purging */

    fn manifest(kind: &str, paths: &[&str]) -> DownloadManifest {
        DownloadManifest {
            game_id: "g1".to_string(),
            title: "Cave Story".to_string(),
            kind: kind.to_string(),
            total_bytes: 0,
            files: paths.iter().map(|path| file(path)).collect(),
            token: String::new(),
        }
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "gb-purge-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, b"partial").unwrap();
    }

    #[tokio::test]
    async fn purging_removes_the_files_and_their_resume_sidecars() {
        let destination = temp_root();
        let root = destination.join("Cave Story");
        let plan = CleanupPlan::new(&manifest("folder", &["data/game.dat", "game.exe"]), &root);

        write(&root.join("data/game.dat"));
        write(&part_path_for(&root.join("data/game.dat")));
        write(&root.join("game.exe"));

        purge_download(&plan).await;

        // The whole tree goes: this download created the folder it sits in.
        assert!(!root.exists(), "the game folder should be gone");
        std::fs::remove_dir_all(&destination).ok();
    }

    #[tokio::test]
    async fn purging_an_archive_game_leaves_the_install_folder_alone() {
        // The case that rules out a recursive delete: `root` here is the folder
        // the user picked, which holds everything else they have installed.
        let root = temp_root();
        let plan = CleanupPlan::new(&manifest("archive", &["Cave Story.zip"]), &root);

        write(&root.join("Cave Story.zip"));
        let neighbour = root.join("Some Other Game/game.exe");
        write(&neighbour);

        purge_download(&plan).await;

        assert!(
            !root.join("Cave Story.zip").exists(),
            "the archive should go"
        );
        assert!(neighbour.exists(), "a neighbouring game must survive");
        assert!(root.exists(), "the chosen install folder must survive");
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn purging_keeps_a_directory_that_still_holds_something_else() {
        let destination = temp_root();
        let root = destination.join("Cave Story");
        let plan = CleanupPlan::new(&manifest("folder", &["data/game.dat"]), &root);

        write(&root.join("data/game.dat"));
        let stranger = root.join("data/save.bin");
        write(&stranger);

        purge_download(&plan).await;

        assert!(!root.join("data/game.dat").exists());
        assert!(
            stranger.exists(),
            "a file this download did not write must stay"
        );
        std::fs::remove_dir_all(&destination).ok();
    }

    #[tokio::test]
    async fn purging_a_download_that_wrote_nothing_is_not_an_error() {
        let destination = temp_root();
        let root = destination.join("Cave Story");
        let plan = CleanupPlan::new(&manifest("folder", &["data/game.dat"]), &root);

        // Cancelled before the first byte landed, so nothing exists to remove.
        purge_download(&plan).await;

        std::fs::remove_dir_all(&destination).ok();
    }
}
