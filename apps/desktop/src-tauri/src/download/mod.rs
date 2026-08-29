//! The download system: a persistent, serial game queue driving a segmented
//! HTTP transfer engine (`engine`).
//!
//! One game downloads at a time. Everything else sits in a queue that survives
//! app restarts, because a killed process must not lose what the user asked
//! for — the previous manager kept its whole queue in memory and a crash took
//! every pending install with it.

pub(crate) mod engine;
pub(crate) mod mesh;
pub(crate) mod seeder;
pub(crate) mod seeding;

use crate::api::{ApiClient, DownloadManifest};
use crate::error::{AppError, AppResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};

/// Builds the API client used when a queued download reaches the front of the
/// queue. Read at activation time rather than at enqueue time so a session
/// that was signed out and back in between cannot strand hours of transfers
/// behind a dead token.
pub type ClientProvider =
    Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, AppResult<ApiClient>> + Send + Sync>;

/// The two transfer preferences a download honours.
#[derive(Debug, Clone, Copy)]
pub struct TransferOptions {
    /// How many HTTP connections one download may open at once.
    pub connections: usize,
    /// Check each finished file against the server's SHA-256 where it has one.
    pub verify: bool,
}

impl Default for TransferOptions {
    fn default() -> Self {
        Self {
            connections: 4,
            verify: true,
        }
    }
}

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

impl DownloadStatus {
    fn is_live(self) -> bool {
        matches!(
            self,
            DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Verifying
        )
    }
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

/// What the queue remembers about one download, on disk as well as in memory.
///
/// The file list is kept even though the server could be asked again, because
/// cancelling with deletion has to work offline too: a user on a flaky
/// connection still deserves to reclaim the space a half-finished transfer
/// holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct QueueEntry {
    game_id: String,
    title: String,
    kind: String,
    /// The folder bytes land in directly. Folder games include their own name
    /// below the chosen destination; archive games do not.
    root: PathBuf,
    /// What the UI reports as the download's location. Becomes the archive's
    /// own path once an archive game completes.
    destination: String,
    total_bytes: u64,
    files_total: usize,
    /// Relative paths already sanitised, for purging without the server.
    files: Vec<String>,
    status: DownloadStatus,
    error: Option<String>,
    added_at: String,
    /// Set while the download is actually running so a restart can tell an
    /// interrupted transfer from one the user deliberately paused, and pick
    /// the interrupted ones back up on their own.
    auto_resume: bool,
}

impl QueueEntry {
    fn from_manifest(manifest: &DownloadManifest, destination: PathBuf) -> Self {
        let root = if manifest.kind == "folder" {
            destination.join(sanitise_component(&manifest.title))
        } else {
            destination
        };

        let mut files = Vec::with_capacity(manifest.files.len());
        for file in &manifest.files {
            // A path the client refuses to write is a path it would never have
            // downloaded either, so dropping it here costs nothing later.
            if let Ok(relative) = sanitise_relative_path(&file.path) {
                // Stored with forward slashes whatever the platform separator
                // is. This list is persisted to the queue file and read back
                // to clean up after a cancelled download; Windows accepts
                // either form when joining, so writing the one that does not
                // depend on where the file was written keeps the queue
                // readable and its assertions meaningful.
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }

        Self {
            game_id: manifest.game_id.clone(),
            title: manifest.title.clone(),
            kind: manifest.kind.clone(),
            root: root.clone(),
            destination: root.to_string_lossy().to_string(),
            total_bytes: manifest.total_bytes,
            files_total: manifest.files.len(),
            files,
            status: DownloadStatus::Queued,
            error: None,
            added_at: Utc::now().to_rfc3339(),
            auto_resume: false,
        }
    }
}

/// The paths one download owns, so cancelling can remove what it wrote and
/// nothing else.
///
/// Held rather than derived at deletion time because `forget` can be asked to
/// clean up a download whose task ended long ago.
#[derive(Debug)]
struct CleanupPlan {
    root: PathBuf,
    /// True only when `root` was created for this download alone — a folder
    /// game unpacks into a directory named after its title, where a
    /// single-archive game lands directly in the folder the user picked.
    owns_root: bool,
    /// Relative to `root`, already sanitised.
    files: Vec<PathBuf>,
}

impl CleanupPlan {
    fn from_entry(entry: &QueueEntry) -> Self {
        Self {
            root: entry.root.clone(),
            owns_root: entry.kind == "folder",
            files: entry.files.iter().map(PathBuf::from).collect(),
        }
    }
}

/// Removes what a cancelled download wrote, and nothing else.
///
/// Path by path from the queue entry rather than a recursive delete of
/// `root`: for a single-archive game `root` is the install folder the user
/// chose, which may well hold every other game they own. Directories this
/// download created are pruned deepest-first and only while they are empty.
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
        // that is no longer there. Its half-written twin goes too — a crash
        // during a journal save can leave one, and a purge is meant to leave
        // nothing at all.
        let sidecar = part_path_for(&dest);
        let _ = tokio::fs::remove_file(sidecar.with_extension("gbpart.tmp")).await;
        let _ = tokio::fs::remove_file(&sidecar).await;
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

struct Handle {
    entry: QueueEntry,
    state: Arc<Mutex<DownloadState>>,
    /// Both flags are read by the running engine between chunks; they do
    /// nothing once that engine has returned, which is why commands arriving
    /// after completion mutate the entry directly instead.
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    /// Set alongside `cancel` when the user asked for the bytes already on
    /// disk to go too. Read by the finalizer once the engine has stopped
    /// writing, so a purge can never race a write.
    purge: Arc<AtomicBool>,
    cleanup: Arc<CleanupPlan>,
}

impl Handle {
    fn fresh(entry: QueueEntry) -> Self {
        let state = Arc::new(Mutex::new(download_state_for(&entry)));
        Self::build(entry, state)
    }

    fn build(entry: QueueEntry, state: Arc<Mutex<DownloadState>>) -> Self {
        Self {
            cleanup: Arc::new(CleanupPlan::from_entry(&entry)),
            cancel: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(entry.status == DownloadStatus::Paused)),
            purge: Arc::new(AtomicBool::new(false)),
            entry,
            state,
        }
    }
}

struct Inner {
    /// Queue positions, oldest first. Every id here has an entry in `entries`.
    order: Vec<String>,
    entries: HashMap<String, Handle>,
    /// The download whose engine task is currently running, if any. The serial
    /// queue is this one field: nothing else starts while it is set.
    active: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PersistedQueue {
    version: u32,
    entries: Vec<QueueEntry>,
}

const QUEUE_VERSION: u32 = 1;

pub struct DownloadManager {
    inner: Mutex<Inner>,
    notify: Notify,
    queue_path: PathBuf,
    provider: ClientProvider,
    /// Read fresh for every download, so changing the preference applies to
    /// the next transfer without restarting anything.
    connections: AtomicU64,
    verify: AtomicBool,
    scheduler_started: AtomicBool,
}

impl DownloadManager {
    /// Loads any queue a previous run left behind.
    ///
    /// A transfer caught mid-flight by the last run becomes queued again and
    /// picks up from its `.gbpart` journals once a session exists; one the
    /// user deliberately paused stays paused. Finished and cancelled rows are
    /// kept too — losing the list of what happened made the panel lie about a
    /// game that was halfway onto the disk.
    pub fn new(app_data: &Path, provider: ClientProvider) -> Arc<Self> {
        let queue_path = app_data.join("download-queue.json");
        let entries = std::fs::read(&queue_path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<PersistedQueue>(&raw).ok())
            .filter(|queue| queue.version == QUEUE_VERSION)
            .map(|queue| queue.entries)
            .unwrap_or_default();

        let mut order = Vec::new();
        let mut handles = HashMap::new();
        for mut entry in entries {
            // Interrupted by the last run means resumed by this one; the user
            // never asked to stop it. An explicitly paused or finished entry
            // keeps whatever status it was left in.
            if entry.auto_resume || entry.status == DownloadStatus::Downloading {
                entry.status = DownloadStatus::Queued;
                entry.error = None;
                entry.auto_resume = false;
            } else if !entry.status.is_live() {
                entry.auto_resume = false;
            } else {
                // Queued or verifying from an older format: still wanted, but
                // not something to start before the user signs in and any
                // explicit pause is honoured.
                entry.status = DownloadStatus::Queued;
            }

            order.push(entry.game_id.clone());
            let state = download_state_for(&entry);
            handles.insert(
                entry.game_id.clone(),
                Handle::build(entry, Arc::new(Mutex::new(state))),
            );
        }

        Arc::new(Self {
            inner: Mutex::new(Inner {
                order,
                entries: handles,
                active: None,
            }),
            notify: Notify::new(),
            queue_path,
            provider,
            connections: AtomicU64::new(4),
            verify: AtomicBool::new(true),
            scheduler_started: AtomicBool::new(false),
        })
    }

    /// Applies the current preferences, so the next download honours them.
    pub fn set_transfer_options(&self, options: TransferOptions) {
        self.connections
            .store(options.connections.clamp(1, 16) as u64, Ordering::SeqCst);
        self.verify.store(options.verify, Ordering::SeqCst);
    }

    /// Starts the single consumer that turns queued entries into running
    /// downloads, one at a time, forever.
    pub fn start_scheduler(self: &Arc<Self>, app: AppHandle) {
        if self.scheduler_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let next = {
                    let inner = manager.inner.lock().await;
                    if inner.active.is_some() {
                        None
                    } else {
                        inner
                            .order
                            .iter()
                            .find(|id| inner.entries[*id].entry.status == DownloadStatus::Queued)
                    }
                    .cloned()
                };

                match next {
                    Some(id) => {
                        {
                            let mut inner = manager.inner.lock().await;
                            // It may have been paused between the check above
                            // and here; re-read rather than trusting `next`.
                            let runnable = inner
                                .entries
                                .get(&id)
                                .is_some_and(|h| h.entry.status == DownloadStatus::Queued);
                            if !runnable {
                                continue;
                            }
                            inner.active = Some(id.clone());
                        }
                        manager.run_one(app.clone(), id).await;
                    }
                    None => manager.notify.notified().await,
                }
            }
        });
    }

    /// Wakes the scheduler. Cheap and safe to call from anywhere, repeatedly.
    fn kick(&self) {
        self.notify.notify_one();
    }

    /// The public nudge, for when something outside the queue changes what it
    /// can do — signing in above all: queued entries held for lack of a
    /// session can start the moment one exists.
    pub async fn wake(&self) {
        self.kick();
    }

    /// Runs one queued download through to a terminal state, then releases
    /// the queue for whatever is next.
    async fn run_one(self: &Arc<Self>, app: AppHandle, game_id: String) {
        let preparation = {
            let inner = self.inner.lock().await;
            let Some(handle) = inner.entries.get(&game_id) else {
                // Forgotten while queued. Nothing to run; `active` is cleared
                // below regardless.
                return;
            };

            Some((
                handle.state.clone(),
                handle.paused.clone(),
                handle.purge.clone(),
                handle.cleanup.clone(),
                handle.entry.root.clone(),
            ))
        };
        let Some((state, paused, purge, cleanup, root)) = preparation else {
            self.clear_active(&game_id).await;
            return;
        };

        // Read outside the queue lock: building a client touches the session
        // lock, and nothing here needs both held together.
        let client = match (self.provider)().await {
            Ok(client) => client,
            // Signed out between enqueuing and starting: hold the place in
            // line rather than failing it — signing back in resumes.
            Err(_) => {
                self.pause_entry(&game_id, Some("Sign in to continue downloading."))
                    .await;
                self.clear_active(&game_id).await;
                return;
            }
        };

        let connections = self.connections.load(Ordering::SeqCst).clamp(1, 16) as usize;
        let verify = self.verify.load(Ordering::SeqCst);

        {
            let mut guard = state.lock().await;
            guard.status = DownloadStatus::Downloading;
            guard.error = None;
            guard.bytes_per_second = 0;
        }
        self.mark_running(&game_id).await;

        let outcome = engine::run(engine::GameJob {
            app: app.clone(),
            client,
            game_id: game_id.clone(),
            root,
            state: state.clone(),
            cancel_flag: self.cancel_flag(&game_id).await,
            connections,
            verify,
        })
        .await;

        // Every writer has stopped by the time `run` returns, so this is the
        // first moment a purge cannot race one.
        let purged = purge.load(Ordering::SeqCst);
        if purged {
            purge_download(&cleanup).await;
        }

        let (final_status, error, reset_bytes, destination) = match outcome {
            engine::Outcome::Done => {
                // An archive game reports the archive itself, not the folder
                // around it, so `finish_install` can see the extension.
                (
                    DownloadStatus::Completed,
                    None,
                    false,
                    self.archive_destination(&game_id).await,
                )
            }
            // Ahead of `paused`: pausing and then cancelling with deletion
            // sets both, and what the user last asked for was to cancel.
            engine::Outcome::Stopped if purged => (DownloadStatus::Canceled, None, true, None),
            engine::Outcome::Stopped if paused.load(Ordering::SeqCst) => {
                (DownloadStatus::Paused, None, false, None)
            }
            engine::Outcome::Stopped => (DownloadStatus::Canceled, None, false, None),
            engine::Outcome::Quota(message) => (DownloadStatus::Paused, Some(message), false, None),
            engine::Outcome::Fatal(err) => {
                (DownloadStatus::Failed, Some(err.to_string()), false, None)
            }
        };

        let snapshot = {
            let mut guard = state.lock().await;
            guard.status = final_status;
            guard.error = error.clone();
            guard.bytes_per_second = 0;
            guard.current_file = None;
            if reset_bytes {
                // Nothing is on disk any more, so a progress bar left at 40%
                // would be describing files that no longer exist.
                guard.downloaded_bytes = 0;
            }
            if let Some(destination) = &destination {
                guard.destination = destination.clone();
            }
            guard.clone()
        };

        let _ = app.emit("download://progress", &snapshot);
        self.commit_result(&game_id, final_status, error, destination)
            .await;

        self.clear_active(&game_id).await;
        self.kick();
    }

    async fn cancel_flag(&self, game_id: &str) -> Arc<AtomicBool> {
        self.inner
            .lock()
            .await
            .entries
            .get(game_id)
            .expect("engine started only for an existing entry")
            .cancel
            .clone()
    }

    async fn clear_active(&self, game_id: &str) {
        let mut inner = self.inner.lock().await;
        if inner.active.as_deref() == Some(game_id) {
            inner.active = None;
        }
    }

    /// Adds a game to the queue, or replaces a stopped entry for the same
    /// game in place. Progress arrives as `download://progress` events.
    pub async fn enqueue(
        &self,
        manifest: &DownloadManifest,
        destination: PathBuf,
    ) -> AppResult<()> {
        let mut entry = QueueEntry::from_manifest(manifest, destination);

        let mut inner = self.inner.lock().await;
        if let Some(existing) = inner.entries.get(&manifest.game_id) {
            if existing.entry.status.is_live() {
                return Err(AppError::Other(
                    "That game is already downloading".to_string(),
                ));
            }
            // Reinstalling a finished or cancelled game replaces its row, but
            // keeps its position in the queue rather than jumping the line.
            entry.added_at = existing.entry.added_at.clone();
        }

        let game_id = entry.game_id.clone();
        inner.entries.insert(game_id.clone(), Handle::fresh(entry));
        if !inner.order.contains(&game_id) {
            inner.order.push(game_id);
        }
        drop(inner);

        self.persist().await;
        self.kick();
        Ok(())
    }

    /// Resumes a stopped entry without touching the network.
    ///
    /// Returns false when there is nothing resumable, which tells the caller
    /// to go to the server for a fresh manifest instead. Resuming deliberately
    /// does *not* refetch the manifest: the point of Resume is to work when
    /// the network currently does not.
    pub async fn resume_stopped(&self, game_id: &str) -> bool {
        let resumed = {
            let mut inner = self.inner.lock().await;
            let Some(handle) = inner.entries.get_mut(game_id) else {
                return false;
            };
            if handle.entry.status.is_live() {
                return false;
            }

            handle.entry.status = DownloadStatus::Queued;
            handle.entry.error = None;
            handle.cancel.store(false, Ordering::SeqCst);
            handle.paused.store(false, Ordering::SeqCst);
            handle.purge.store(false, Ordering::SeqCst);

            let mut state = handle.state.lock().await;
            state.status = DownloadStatus::Queued;
            state.error = None;
            true
        };

        if resumed {
            self.persist().await;
            self.kick();
        }
        resumed
    }

    /// Stops a transfer without discarding progress.
    ///
    /// A running engine notices the flag between chunks and finishes as
    /// `Paused`; a merely-queued entry has no engine to wait for, so it is
    /// flipped directly.
    pub async fn pause(&self, game_id: &str) -> bool {
        let is_active = self.is_active(game_id).await;
        if is_active {
            let handle = {
                let inner = self.inner.lock().await;
                inner
                    .entries
                    .get(game_id)
                    .map(|h| (h.paused.clone(), h.cancel.clone()))
            };
            let Some((paused, cancel)) = handle else {
                return false;
            };
            paused.store(true, Ordering::SeqCst);
            cancel.store(true, Ordering::SeqCst);
            true
        } else {
            self.pause_entry(game_id, None).await
        }
    }

    /// Whether this game's engine task is the one currently running.
    async fn is_active(&self, game_id: &str) -> bool {
        self.inner.lock().await.active.as_deref() == Some(game_id)
    }

    /// The direct mutation behind pausing something that is not running, plus
    /// the signed-out case the scheduler itself needs to record.
    async fn pause_entry(&self, game_id: &str, error: Option<&str>) -> bool {
        let was_queued = {
            let mut inner = self.inner.lock().await;
            let Some(handle) = inner.entries.get_mut(game_id) else {
                return false;
            };

            let was_queued = handle.entry.status == DownloadStatus::Queued;
            handle.entry.status = DownloadStatus::Paused;
            handle.entry.auto_resume = false;
            handle.entry.error = error.map(str::to_string);
            handle.cancel.store(false, Ordering::SeqCst);
            handle.paused.store(true, Ordering::SeqCst);

            let mut state = handle.state.lock().await;
            state.status = DownloadStatus::Paused;
            state.error = error.map(str::to_string);
            was_queued
        };

        // Only a queue position changed, so the scheduler needs waking; a
        // running engine stops on its own and wakes it via the finalizer.
        if was_queued {
            self.kick();
        }
        self.persist().await;
        true
    }

    /// Stops a transfer, optionally taking the bytes already on disk with it.
    ///
    /// For a running download the deletion happens in the finalizer rather
    /// than here: the engine is still writing at this point, and removing a
    /// file out from under it would only recreate it. A stopped download has
    /// no finalizer coming, so this does the whole job itself.
    pub async fn cancel(&self, game_id: &str, delete_files: bool) -> bool {
        if self.is_active(game_id).await {
            let flags = {
                let inner = self.inner.lock().await;
                inner
                    .entries
                    .get(game_id)
                    .map(|h| (h.purge.clone(), h.cancel.clone()))
            };
            let Some((purge, cancel)) = flags else {
                return false;
            };
            // Recorded before the stop signal, so the finalizer cannot observe
            // the transfer ending before it observes the intent.
            if delete_files {
                purge.store(true, Ordering::SeqCst);
            }
            cancel.store(true, Ordering::SeqCst);
            return true;
        }

        {
            let mut inner = self.inner.lock().await;
            let Some(handle) = inner.entries.get_mut(game_id) else {
                return false;
            };
            handle.entry.status = DownloadStatus::Canceled;
            handle.entry.auto_resume = false;
            handle.cancel.store(true, Ordering::SeqCst);
        }

        if delete_files {
            self.delete_files_of(game_id).await;
        }

        {
            let mut inner = self.inner.lock().await;
            if let Some(handle) = inner.entries.get_mut(game_id) {
                handle.entry.status = DownloadStatus::Canceled;
                let mut state = handle.state.lock().await;
                state.status = DownloadStatus::Canceled;
                if delete_files {
                    state.downloaded_bytes = 0;
                }
            }
        }

        self.persist().await;
        true
    }

    /// Drops a stopped entry from the queue, optionally deleting what it left.
    ///
    /// The counterpart to `cancel` for a download that has already stopped: a
    /// paused or failed one keeps every byte it fetched, and dismissing its row
    /// was the last time anyone was ever told about them.
    pub async fn forget(&self, game_id: &str, delete_files: bool) {
        if self.is_active(game_id).await {
            // A live download is `cancel`'s job — it waits for the engine to
            // stop before deleting under it, which this cannot do.
            return;
        }

        if delete_files {
            self.delete_files_of(game_id).await;
        }

        {
            let mut inner = self.inner.lock().await;
            inner.order.retain(|id| id != game_id);
            inner.entries.remove(game_id);
        }
        self.persist().await;
    }

    /// Deletes everything a stopped download wrote, keeping its row so the
    /// user sees the space come back.
    async fn delete_files_of(&self, game_id: &str) {
        let plan = {
            let inner = self.inner.lock().await;
            inner.entries.get(game_id).map(|h| h.cleanup.clone())
        };
        if let Some(plan) = plan {
            purge_download(&plan).await;
        }
        let mut inner = self.inner.lock().await;
        if let Some(handle) = inner.entries.get_mut(game_id) {
            handle.state.lock().await.downloaded_bytes = 0;
        }
    }

    pub async fn snapshot(&self) -> Vec<DownloadState> {
        let inner = self.inner.lock().await;
        let mut out = Vec::with_capacity(inner.entries.len());
        for id in &inner.order {
            if let Some(handle) = inner.entries.get(id) {
                out.push(handle.state.lock().await.clone());
            }
        }
        out.sort_by(|a, b| a.title.cmp(&b.title));
        out
    }

    /// Where a finished archive's single file ended up, for reporting.
    async fn archive_destination(&self, game_id: &str) -> Option<String> {
        let inner = self.inner.lock().await;
        let handle = inner.entries.get(game_id)?;
        if handle.entry.kind != "archive" || handle.entry.files.len() != 1 {
            return None;
        }
        Some(
            handle
                .entry
                .root
                .join(&handle.entry.files[0])
                .to_string_lossy()
                .to_string(),
        )
    }

    /// Records that the engine is running, so a crash before the next save
    /// still reads as an interrupted transfer rather than a forgotten one.
    async fn mark_running(&self, game_id: &str) {
        {
            let mut inner = self.inner.lock().await;
            if let Some(handle) = inner.entries.get_mut(game_id) {
                handle.entry.status = DownloadStatus::Downloading;
                handle.entry.auto_resume = true;
            }
        }
        self.persist().await;
    }

    /// Records a terminal status on both the runtime handle and the disk.
    async fn commit_result(
        &self,
        game_id: &str,
        status: DownloadStatus,
        error: Option<String>,
        destination: Option<String>,
    ) {
        {
            let mut inner = self.inner.lock().await;
            if let Some(handle) = inner.entries.get_mut(game_id) {
                handle.entry.status = status;
                handle.entry.error = error;
                handle.entry.auto_resume = false;
                if let Some(destination) = destination {
                    handle.entry.destination = destination;
                }
            }
        }
        self.persist().await;
    }

    /// Writes the queue to disk.
    ///
    /// Called on every transition but never on progress ticks: the file is a
    /// list of intentions, not a progress log, and the `.gbpart` journals
    /// beside each file remain the source of truth for how much arrived.
    async fn persist(&self) {
        let snapshot = {
            let inner = self.inner.lock().await;
            let mut entries: Vec<QueueEntry> = Vec::with_capacity(inner.order.len());
            for id in &inner.order {
                if let Some(handle) = inner.entries.get(id) {
                    entries.push(handle.entry.clone());
                }
            }
            PersistedQueue {
                version: QUEUE_VERSION,
                entries,
            }
        };

        if let Ok(encoded) = serde_json::to_vec_pretty(&snapshot) {
            // Write-then-rename keeps a crash mid-write from taking the whole
            // queue with it.
            let temp = self.queue_path.with_extension("json.tmp");
            if tokio::fs::write(&temp, &encoded).await.is_ok() {
                let _ = tokio::fs::rename(&temp, &self.queue_path).await;
            }
        }
    }
}

fn download_state_for(entry: &QueueEntry) -> DownloadState {
    DownloadState {
        game_id: entry.game_id.clone(),
        title: entry.title.clone(),
        status: entry.status,
        total_bytes: entry.total_bytes,
        downloaded_bytes: 0,
        bytes_per_second: 0,
        files_total: entry.files_total,
        files_completed: 0,
        current_file: None,
        destination: entry.destination.clone(),
        error: entry.error.clone(),
    }
}

fn part_path_for(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".gbpart");
    dest.with_file_name(name)
}

/// Reject anything that would write outside the chosen destination folder.
pub(crate) fn sanitise_relative_path(relative: &str) -> AppResult<PathBuf> {
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

pub(crate) fn sanitise_component(value: &str) -> String {
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

pub(crate) fn urlencode(value: &str) -> String {
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
    use crate::api::ManifestFile;

    /* ------------------------------------------------------------- purging */

    fn entry(kind: &str, root: &Path, paths: &[&str]) -> QueueEntry {
        QueueEntry {
            game_id: "g1".to_string(),
            title: "Cave Story".to_string(),
            kind: kind.to_string(),
            root: root.to_path_buf(),
            destination: root.to_string_lossy().to_string(),
            total_bytes: 0,
            files_total: paths.len(),
            files: paths.iter().map(|p| p.to_string()).collect(),
            status: DownloadStatus::Canceled,
            error: None,
            added_at: Utc::now().to_rfc3339(),
            auto_resume: false,
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
        let plan = CleanupPlan::from_entry(&entry("folder", &root, &["data/game.dat", "game.exe"]));

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
        let plan = CleanupPlan::from_entry(&entry("archive", &root, &["Cave Story.zip"]));

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
        let plan = CleanupPlan::from_entry(&entry("folder", &root, &["data/game.dat"]));

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
        let plan = CleanupPlan::from_entry(&entry("folder", &root, &["data/game.dat"]));

        // Cancelled before the first byte landed, so nothing exists to remove.
        purge_download(&plan).await;

        std::fs::remove_dir_all(&destination).ok();
    }

    /* -------------------------------------------------------- queue shapes */

    fn manifest() -> DownloadManifest {
        DownloadManifest {
            game_id: "g1".to_string(),
            title: "Hero: Re/birth".to_string(),
            kind: "folder".to_string(),
            total_bytes: 42,
            files: vec![ManifestFile {
                id: "f1".to_string(),
                path: "data/game file<>.dat".to_string(),
                size_bytes: 42,
                sha256: None,
                chunks: None,
            }],
            token: String::new(),
            expires_at: None,
            chunk_bytes: None,
            sources: None,
        }
    }

    #[test]
    fn a_queue_entry_sanitises_paths_and_the_root_folder_name() {
        let queued = QueueEntry::from_manifest(&manifest(), PathBuf::from("/games"));

        assert_eq!(queued.root, PathBuf::from("/games/Hero_ Re_birth"));
        assert_eq!(queued.files, vec!["data/game file__.dat"]);
    }

    #[test]
    fn an_archive_game_lands_directly_in_the_chosen_folder() {
        let mut m = manifest();
        m.kind = "archive".to_string();
        m.files[0].path = "Cave Story.zip".to_string();

        let queued = QueueEntry::from_manifest(&m, PathBuf::from("/games"));

        assert_eq!(queued.root, PathBuf::from("/games"));
    }

    /* --------------------------------------------------------- persistence */

    fn persisted(entries: Vec<QueueEntry>) -> PersistedQueue {
        PersistedQueue {
            version: QUEUE_VERSION,
            entries,
        }
    }

    /// A provider the queue must never call in these tests: it would mean a
    /// download activating without anything arranging for that not to happen.
    fn no_provider() -> ClientProvider {
        Arc::new(|| unreachable!("tests must not activate downloads"))
    }

    #[tokio::test]
    async fn a_restored_queue_resumes_what_was_interrupted_and_keeps_what_was_paused() {
        // Nanoseconds rather than a debug-printed SystemTime: that format
        // contains colons on Windows, which cannot appear in a file name, so
        // the directory was never created and the test failed at its setup.
        let dir = std::env::temp_dir().join(format!(
            "gb-queue-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let mut interrupted = entry("archive", Path::new("/games/a"), &["a.zip"]);
        interrupted.game_id = "interrupted".to_string();
        interrupted.status = DownloadStatus::Downloading;
        interrupted.auto_resume = true;

        let mut deliberate = entry("archive", Path::new("/games/b"), &["b.zip"]);
        deliberate.game_id = "deliberate".to_string();
        deliberate.status = DownloadStatus::Paused;

        std::fs::write(
            dir.join("download-queue.json"),
            serde_json::to_vec(&persisted(vec![interrupted, deliberate])).unwrap(),
        )
        .unwrap();

        let manager = DownloadManager::new(&dir, no_provider());
        let snapshot = manager.snapshot().await;

        let interrupted = snapshot
            .iter()
            .find(|d| d.game_id == "interrupted")
            .unwrap();
        assert_eq!(interrupted.status, DownloadStatus::Queued);
        let deliberate = snapshot.iter().find(|d| d.game_id == "deliberate").unwrap();
        assert_eq!(deliberate.status, DownloadStatus::Paused);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_corrupt_queue_file_starts_empty_instead_of_failing_the_app() {
        let dir = std::env::temp_dir().join(format!("gb-queue-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("download-queue.json"), b"{not json").unwrap();

        let manager = DownloadManager::new(&dir, no_provider());

        assert!(manager.snapshot().await.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn resuming_a_paused_entry_queues_it_without_the_network() {
        let dir = std::env::temp_dir().join(format!("gb-queue-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let mut paused = entry("archive", Path::new("/games/a"), &["a.zip"]);
        paused.game_id = "paused-game".to_string();
        paused.status = DownloadStatus::Paused;

        let payload = persisted(vec![paused]);
        std::fs::write(
            dir.join("download-queue.json"),
            serde_json::to_vec(&payload).unwrap(),
        )
        .unwrap();

        let manager = DownloadManager::new(&dir, no_provider());
        assert!(manager.resume_stopped("paused-game").await);
        assert!(!manager.resume_stopped("unknown-game").await);

        let snapshot = manager.snapshot().await;
        assert_eq!(snapshot[0].status, DownloadStatus::Queued);

        std::fs::remove_dir_all(&dir).ok();
    }
}
