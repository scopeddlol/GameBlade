//! The transfer engine: one game's files, fetched as dynamically scheduled
//! byte-range chunks over the server's per-file routes.
//!
//! Design notes, because three decisions here shape everything else:
//!
//! * Files are cut into fixed 8 MiB chunks and any idle connection takes the
//!   next unfinished one. Fixed segment counts made the last segment a
//!   straggler that throttled the whole file; small chunks make slow
//!   connections irrelevant because their remainder is simply picked up by
//!   someone faster.
//! * Transient failures retry indefinitely, with backoff. A tunnel that drops
//!   for two minutes used to fail a game six attempts deep; now it waits and
//!   resumes. Only things that cannot heal — gone files, refused access, an
//!   exhausted quota, a bad checksum — end a download.
//! * Every request carries `If-Range` once the file's ETag is known, so
//!   resuming after the server-side file changed produces an honest restart
//!   rather than a corrupt hybrid stitched from two versions.

use super::{part_path_for, sanitise_relative_path, urlencode, DownloadStatus, DownloadState};
use crate::api::{ApiClient, DownloadManifest, ManifestFile};
use crate::error::{AppError, AppResult};
use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, Semaphore};

/// Chunk size for the dynamic work queue. Small enough that a stalled
/// connection strands little, large enough that per-chunk overhead (a request
/// and a journal entry each) stays negligible even for a 100 GB archive.
const CHUNK_BYTES: u64 = 8 * 1024 * 1024;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);

/// Refresh the signed token this long before it actually expires, so it never
/// lapses underneath an in-flight request.
const TOKEN_REFRESH_MARGIN_MS: i64 = 10 * 60_000;

/// A refresh this recent means the server already saw a fresh token and
/// still said no; refreshing again would only spin.
const TOKEN_REFRESH_DEBOUNCE_MS: u128 = 30_000;

pub(crate) struct GameJob {
    pub app: tauri::AppHandle,
    pub client: ApiClient,
    pub game_id: String,
    pub root: PathBuf,
    pub state: Arc<Mutex<DownloadState>>,
    pub cancel_flag: Arc<AtomicBool>,
    pub connections: usize,
    pub verify: bool,
}

pub(crate) enum Outcome {
    Done,
    /// Cancel or pause was requested; the caller decides which it was.
    Stopped,
    /// The account's monthly allowance ran out mid-transfer. Paused, not
    /// failed: nothing is wrong with the data, and next month it resumes.
    Quota(String),
    Fatal(AppError),
}

/// Takes bytes back off the progress counter without ever wrapping.
///
/// The adds and subtractions are balanced by construction, but this is shared
/// mutable state read by the UI: an underflow here would show a download as
/// sixteen exabytes complete, which is a worse bug than the one it is
/// guarding against.
fn uncredit(counter: &AtomicU64, bytes: u64) {
    if bytes == 0 {
        return;
    }
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(bytes))
    });
}

/// Whether a response to a ranged request is really that range.
///
/// A 206 is. A 200 is only when the range asked for the whole file anyway —
/// otherwise the range was not honoured and the body is the entire file, which
/// written at this chunk's offset would scribble over everything after it.
///
/// The case that makes this matter is a fresh download: no chunk has an ETag
/// yet, so `If-Range` cannot catch it, and every task in the first wave would
/// write a full copy of the file at its own offset and mark it done.
fn range_was_honoured(status: reqwest::StatusCode, whole_file: bool) -> bool {
    status != reqwest::StatusCode::OK || whole_file
}

/// How many of an arriving buffer's bytes belong to this chunk.
///
/// The guard above turns away the ways a server ends up over-sending; this is
/// what makes writing past the chunk — over the *next* chunk's bytes, which
/// may already be done and journalled — impossible rather than merely
/// unlikely.
fn writable_len(buffer: usize, expected: u64, received: u64) -> usize {
    let room = expected.saturating_sub(received);
    (buffer as u64).min(room) as usize
}

fn cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

/* ------------------------------------------------------------------- tokens */

/// The signed download token currently authorising this game's transfers.
struct Tokens {
    game_id: String,
    token: String,
    /// Epoch milliseconds the token dies at, when the server said.
    expires_at_ms: Option<i64>,
    last_refresh: Option<Instant>,
}

impl Tokens {
    fn from_manifest(manifest: &DownloadManifest) -> Self {
        let expires_at_ms = manifest
            .expires_at
            .as_deref()
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
            .map(|when| when.timestamp_millis());

        Self {
            game_id: manifest.game_id.clone(),
            token: manifest.token.clone(),
            expires_at_ms,
            last_refresh: None,
        }
    }

    fn expires_soon(&self) -> bool {
        match self.expires_at_ms {
            Some(at) => at - Utc::now().timestamp_millis() < TOKEN_REFRESH_MARGIN_MS,
            // An older server that never said: rely on the reactive path.
            None => false,
        }
    }

    fn refreshed_recently(&self) -> bool {
        self.last_refresh
            .is_some_and(|at| at.elapsed().as_millis() < TOKEN_REFRESH_DEBOUNCE_MS)
    }

    async fn refresh(&mut self, client: &ApiClient) -> AppResult<()> {
        let issued = client.download_token(&self.game_id).await?;
        self.token = issued.token;
        self.expires_at_ms = chrono::DateTime::parse_from_rfc3339(&issued.expires_at)
            .ok()
            .map(|when| when.timestamp_millis());
        self.last_refresh = Some(Instant::now());
        Ok(())
    }

    /// Proactive refresh ahead of expiry. Best effort: if it fails here the
    /// transfer continues on the current token, and the reactive path below
    /// handles whatever that leads to.
    async fn ensure_fresh(&mut self, client: &ApiClient) {
        if self.expires_soon() {
            let _ = self.refresh(client).await;
        }
    }
}

/* ------------------------------------------------------------------ journal */

/// Resume state persisted beside a partially downloaded file.
///
/// `done` holds completed chunk indexes, always kept sorted. One journal per
/// file, named `<file>.gbpart`, rewritten on every chunk completion: a few
/// kilobytes every 8 MiB is nothing, and replacing a small file cannot leave
/// half-old-half-new contents behind the way appending to a log can.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChunkJournal {
    version: u32,
    size: u64,
    chunk_bytes: u64,
    /// The server's ETag for the file these chunks came from, captured on the
    /// first successful response. Present means every further request proves
    /// it is still talking about the same bytes.
    etag: Option<String>,
    done: Vec<u64>,
}

const JOURNAL_VERSION: u32 = 2;

impl ChunkJournal {
    fn fresh(size: u64) -> Self {
        Self {
            version: JOURNAL_VERSION,
            size,
            chunk_bytes: CHUNK_BYTES,
            etag: None,
            done: Vec::new(),
        }
    }

    /// Only trusts a sidecar describing exactly this layout; anything else —
    /// an older format, a different file size, another chunking — restarts
    /// the file rather than guessing.
    fn usable(&self, size: u64) -> bool {
        self.version == JOURNAL_VERSION
            && self.size == size
            && self.chunk_bytes == CHUNK_BYTES
    }

    fn total_chunks(&self) -> u64 {
        self.size.div_ceil(self.chunk_bytes)
    }

    fn is_done(&self, index: u64) -> bool {
        self.done.binary_search(&index).is_ok()
    }

    fn mark_done(&mut self, index: u64) {
        if let Err(at) = self.done.binary_search(&index) {
            self.done.insert(at, index);
        }
    }

    /// Bytes accounted complete, counting a partial final chunk at its true
    /// size rather than a full stride.
    fn done_bytes(&self) -> u64 {
        self.done
            .iter()
            .map(|index| {
                let start = index * self.chunk_bytes;
                let end = (start + self.chunk_bytes).min(self.size);
                end - start
            })
            .sum()
    }
}

async fn load_journal(path: &Path, size: u64) -> ChunkJournal {
    if size == 0 {
        return ChunkJournal::fresh(0);
    }
    if let Ok(raw) = tokio::fs::read(path).await {
        if let Ok(existing) = serde_json::from_slice::<ChunkJournal>(&raw) {
            if existing.usable(size) {
                return existing;
            }
        }
    }
    ChunkJournal::fresh(size)
}

/// Writes the journal so a crash cannot destroy it.
///
/// Write-then-rename, like the queue file. A plain write truncates first, so a
/// power cut between the truncate and the write leaves an empty sidecar —
/// which `load_journal` correctly refuses, and which costs the whole file.
/// Re-fetching 40 GB because the lights went out is exactly the outcome
/// chunked resume exists to prevent, so the one extra syscall is worth it.
///
/// Every caller holds the journal mutex, so two saves can never race for the
/// same temporary path.
async fn save_journal(path: &Path, journal: &ChunkJournal) -> AppResult<()> {
    let encoded = serde_json::to_vec(journal)?;
    let temp = path.with_extension("gbpart.tmp");
    tokio::fs::write(&temp, &encoded).await?;
    tokio::fs::rename(&temp, path).await?;
    Ok(())
}

/* --------------------------------------------------------------------- run */

enum Stop {
    Stopped,
    Quota(String),
    /// The server no longer has the bytes these chunks came from.
    Changed,
    Fatal(AppError),
}

pub(crate) async fn run(job: GameJob) -> Outcome {
    tokio::fs::create_dir_all(&job.root).await.ok();

    // Fetching the manifest is itself network work, so it gets the same
    // patience as the transfers: a server restarting just as the queue
    // reached this game should not fail it.
    let mut manifest = None;
    for attempt in 0..5u32 {
        if cancelled(&job.cancel_flag) {
            return Outcome::Stopped;
        }
        match job.client.manifest(&job.game_id).await {
            Ok(fetched) => {
                manifest = Some(fetched);
                break;
            }
            Err(err) => {
                // Refused access will not heal by waiting.
                if is_authorisation_error(&err) {
                    return Outcome::Fatal(err);
                }
                if attempt == 4 {
                    return Outcome::Fatal(err);
                }
                tokio::time::sleep(backoff_delay(attempt)).await;
            }
        }
    }
    let manifest = manifest.expect("the loop above either sets this or returns");

    let tokens = Arc::new(Mutex::new(Tokens::from_manifest(&manifest)));
    let downloaded = Arc::new(AtomicU64::new(0));
    let semaphore = Arc::new(Semaphore::new(job.connections));

    // Drive the progress event from one place so the UI gets a steady rate
    // reading rather than a spike per chunk.
    let reporter = {
        let app = job.app.clone();
        let state = job.state.clone();
        let downloaded = downloaded.clone();
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
                    // Ends the loop once the finalizer records an ending.
                    if !matches!(
                        guard.status,
                        DownloadStatus::Downloading | DownloadStatus::Verifying
                    ) {
                        break;
                    }
                    guard.downloaded_bytes = current;
                    guard.bytes_per_second = rate;
                    guard.clone()
                };

                let _ = app.emit("download://progress", &snapshot);
            }
        })
    };

    let mut outcome = Outcome::Done;
    for file in &manifest.files {
        if cancelled(&job.cancel_flag) {
            outcome = Outcome::Stopped;
            break;
        }

        {
            let mut guard = job.state.lock().await;
            guard.current_file = Some(file.path.clone());
        }

        match download_file(
            &job.client,
            &tokens,
            &job.game_id,
            file,
            &job.root,
            &job.state,
            &job.cancel_flag,
            &downloaded,
            &semaphore,
            job.connections,
            job.verify,
        )
        .await
        {
            FileOutcome::Done => {
                let mut guard = job.state.lock().await;
                guard.files_completed += 1;
            }
            FileOutcome::Stopped => {
                outcome = Outcome::Stopped;
                break;
            }
            FileOutcome::Quota(message) => {
                outcome = Outcome::Quota(message);
                break;
            }
            FileOutcome::Fatal(err) => {
                outcome = Outcome::Fatal(err);
                break;
            }
        }
    }

    {
        let mut guard = job.state.lock().await;
        guard.downloaded_bytes = downloaded.load(Ordering::Relaxed);
        guard.current_file = None;
    }
    reporter.abort();

    outcome
}

/// A refusal that waiting longer cannot fix, at the moment the manifest is
/// fetched. Message-matched because `check_status` folds status codes into
/// text before they reach us, and these two wordings come from exactly those
/// two codes and no others.
fn is_authorisation_error(err: &AppError) -> bool {
    matches!(err, AppError::NotSignedIn)
        || matches!(err, AppError::Server(message) if message.contains("signed in") || message.contains("access"))
}

/// Exponential backoff for transient trouble: quick at first so a blip costs
/// nothing, capped low enough that an outage recovers the moment it ends.
fn backoff_delay(attempt: u32) -> Duration {
    let millis = 500u64.saturating_mul(1 << attempt.min(7));
    Duration::from_millis(millis.min(60_000))
}

/* -------------------------------------------------------------------- files */

enum FileOutcome {
    Done,
    Stopped,
    Quota(String),
    Fatal(AppError),
}

impl From<Stop> for FileOutcome {
    fn from(stop: Stop) -> Self {
        match stop {
            Stop::Stopped => FileOutcome::Stopped,
            Stop::Quota(message) => FileOutcome::Quota(message),
            Stop::Fatal(err) => FileOutcome::Fatal(err),
            // A change propagating past its single allowed restart lands here
            // as a plain failure.
            Stop::Changed => FileOutcome::Fatal(AppError::Other(
                "The file changed on the server while it was downloading. Start it again."
                    .to_string(),
            )),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_file(
    client: &ApiClient,
    tokens: &Arc<Mutex<Tokens>>,
    game_id: &str,
    file: &ManifestFile,
    root: &Path,
    state: &Arc<Mutex<DownloadState>>,
    cancel: &Arc<AtomicBool>,
    downloaded: &Arc<AtomicU64>,
    semaphore: &Arc<Semaphore>,
    connections: usize,
    verify: bool,
) -> FileOutcome {
    let relative = match sanitise_relative_path(&file.path) {
        Ok(relative) => relative,
        Err(_) => {
            return FileOutcome::Fatal(AppError::Other(format!(
                "The server sent an unsafe file path: {}",
                file.path
            )))
        }
    };
    let dest = root.join(relative);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let journal_path = part_path_for(&dest);

    // Already complete from an earlier run: count it and move on.
    if let Ok(meta) = tokio::fs::metadata(&dest).await {
        if meta.len() == file.size_bytes && !journal_path.exists() {
            downloaded.fetch_add(file.size_bytes, Ordering::Relaxed);
            return FileOutcome::Done;
        }
    }

    let mut restarts = 0u32;

    loop {
        // Where the shared counter stood before this attempt touched it.
        //
        // A restart has to put the counter back exactly, and adding up what
        // this attempt contributed by hand does not survive contact with the
        // chunk tasks — they credit bytes as they stream. Reading the counter
        // is exact by construction. It is only this file's to reason about:
        // files are downloaded one at a time, and every chunk task is joined
        // before `fetch_all_chunks` returns.
        let before = downloaded.load(Ordering::Relaxed);

        let journal = load_journal(&journal_path, file.size_bytes).await;
        downloaded.fetch_add(journal.done_bytes(), Ordering::Relaxed);

        // truncate(false) is load-bearing on a resume: the bytes already on
        // disk are exactly what the journal accounts for, and discarding them
        // here would restart every chunk from zero. set_len only sizes the
        // file so chunks can seek and write at their own offsets.
        let opened = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&dest)
            .await;
        let target = match opened {
            Ok(target) => target,
            Err(err) => return FileOutcome::Fatal(AppError::Io(err)),
        };
        target.set_len(file.size_bytes).await.ok();
        drop(target);

        let result = fetch_all_chunks(
            client,
            tokens,
            game_id,
            file,
            &dest,
            journal,
            &journal_path,
            cancel,
            downloaded,
            semaphore,
            connections,
        )
        .await;

        match result {
            Ok(()) => break,
            Err(stop @ (Stop::Stopped | Stop::Quota(_) | Stop::Fatal(_))) => {
                return stop.into();
            }
            Err(Stop::Changed) => {
                // The file behind the URL is no longer the file the journal
                // describes. Everything for it goes, honestly, and it starts
                // again — once, because twice in a row means something is
                // rewriting the file repeatedly, and no amount of retrying
                // finishes underneath that.
                restarts += 1;
                if restarts > 1 {
                    return FileOutcome::from(Stop::Changed);
                }
                // None of this attempt's bytes survive, so none of them may
                // stay on the progress counter.
                uncredit(
                    downloaded,
                    downloaded.load(Ordering::Relaxed).saturating_sub(before),
                );
                let _ = tokio::fs::remove_file(&journal_path).await;
                let _ = tokio::fs::remove_file(&dest).await;
            }
        }
    }

    if cancelled(cancel) {
        return FileOutcome::Stopped;
    }

    // Everything landed, so the resume sidecar is no longer needed.
    let _ = tokio::fs::remove_file(&journal_path).await;

    // Hashing a 40 GB file costs real minutes on a slow disk, which is the
    // whole reason this is a preference.
    if let Some(expected) = file.sha256.as_ref().filter(|_| verify) {
        {
            let mut guard = state.lock().await;
            guard.status = DownloadStatus::Verifying;
        }
        let hashed = hash_file(&dest).await;
        {
            let mut guard = state.lock().await;
            guard.status = DownloadStatus::Downloading;
        }

        let actual = match hashed {
            Ok(digest) => digest,
            Err(err) => return FileOutcome::Fatal(err),
        };
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&dest).await;
            return FileOutcome::Fatal(AppError::Other(format!(
                "{} failed its checksum and was removed. Try downloading it again.",
                file.path
            )));
        }
    }

    FileOutcome::Done
}

/// Downloads every unfinished chunk of one file, several connections at a
/// time.
///
/// Work is taken in waves rather than spawning one task per chunk: a 100 GB
/// file is 12 800 chunks, and twelve thousand parked tasks are overhead paid
/// for no benefit. Each wave is a couple rounds of the connection budget, so
/// there is always more work ready when a connection frees up.
#[allow(clippy::too_many_arguments)]
async fn fetch_all_chunks(
    client: &ApiClient,
    tokens: &Arc<Mutex<Tokens>>,
    game_id: &str,
    file: &ManifestFile,
    dest: &Path,
    journal: ChunkJournal,
    journal_path: &Path,
    cancel: &Arc<AtomicBool>,
    downloaded: &Arc<AtomicU64>,
    semaphore: &Arc<Semaphore>,
    connections: usize,
) -> Result<(), Stop> {
    if file.size_bytes == 0 {
        return Ok(());
    }

    let url_base = format!("/download/{game_id}/files/{}", file.id);
    let journal_shared = Arc::new(Mutex::new(journal));
    let wave_size = connections.max(1).saturating_mul(2);

    // Raised when one chunk in a wave gives up, so its siblings stop too.
    //
    // Dropping a `JoinHandle` detaches the task rather than cancelling it, so
    // returning from the middle of a wave used to leave the rest of it running
    // — still fetching, still writing into the file this function's caller may
    // be about to delete and start over. On a `Changed` restart that is a
    // stale write landing on top of a freshly downloaded chunk that the new
    // journal has already marked done: a corrupt file that only a checksum
    // would catch, and checksums are optional.
    let abandon = Arc::new(AtomicBool::new(false));

    loop {
        if cancelled(cancel) {
            return Err(Stop::Stopped);
        }

        let pending: Vec<u64> = {
            let snapshot = journal_shared.lock().await;
            (0..snapshot.total_chunks())
                .filter(|index| !snapshot.is_done(*index))
                .collect()
        };
        if pending.is_empty() {
            return Ok(());
        }

        for wave in pending.chunks(wave_size) {
            if cancelled(cancel) {
                return Err(Stop::Stopped);
            }

            let mut tasks = Vec::with_capacity(wave.len());
            for index in wave {
                let permit = semaphore.clone().acquire_owned().await.map_err(|err| {
                    Stop::Fatal(AppError::Other(format!(
                        "Could not schedule a download: {err}"
                    )))
                })?;

                let start = index * CHUNK_BYTES;
                let end = (start + CHUNK_BYTES).min(file.size_bytes) - 1;

                tasks.push(tauri::async_runtime::spawn(download_chunk(
                    client.clone(),
                    tokens.clone(),
                    url_base.clone(),
                    dest.to_path_buf(),
                    journal_shared.clone(),
                    journal_path.to_path_buf(),
                    *index,
                    start,
                    end,
                    file.size_bytes,
                    downloaded.clone(),
                    cancel.clone(),
                    abandon.clone(),
                    permit,
                )));
            }

            // Joined as they finish rather than in the order they were
            // spawned, and every one of them is joined even after a failure.
            //
            // Both halves matter. Waiting for all of them is what guarantees
            // nothing is still writing to the file when this returns — a
            // dropped `JoinHandle` detaches its task, it does not cancel it.
            // And taking them out of order is what stops a fatal error being
            // held up behind a sibling: transient failures retry indefinitely
            // by design, so a chunk waiting out a server outage would
            // otherwise keep the wave — and the flag that tells it to stop —
            // pinned until the outage ended.
            let mut running: futures_util::stream::FuturesUnordered<_> =
                tasks.into_iter().collect();
            let mut failure: Option<Stop> = None;

            while let Some(result) = running.next().await {
                let stop = match result {
                    Ok(Ok(())) => continue,
                    Ok(Err(stop)) => stop,
                    Err(err) => Stop::Fatal(AppError::Other(format!(
                        "Download task failed: {err}"
                    ))),
                };
                // The first failure is the one reported; everything after it
                // is a sibling noticing the flag.
                if failure.is_none() {
                    abandon.store(true, Ordering::Relaxed);
                    failure = Some(stop);
                }
            }

            if let Some(stop) = failure {
                return Err(stop);
            }
        }
    }
}

/// Downloads one chunk, retrying transient failures indefinitely.
///
/// "Indefinitely" is the point: every previous failure mode here was a
/// countdown to giving up, and a server outage or a tunnel renegotiation that
/// outlasted six attempts turned into a failed 80 GB download. What cannot
/// heal refuses quickly instead — that is what the fatal branches are for.
#[allow(clippy::too_many_arguments)]
async fn download_chunk(
    client: ApiClient,
    tokens: Arc<Mutex<Tokens>>,
    url_base: String,
    dest: PathBuf,
    journal: Arc<Mutex<ChunkJournal>>,
    journal_path: PathBuf,
    index: u64,
    start: u64,
    end: u64,
    total_size: u64,
    downloaded: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
    abandon: Arc<AtomicBool>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(), Stop> {
    let expected = end - start + 1;
    // A 200 is a legitimate answer to a range that happens to cover the whole
    // file; for anything narrower it means the range was ignored.
    let whole_file = start == 0 && end + 1 == total_size;
    let mut attempt = 0u32;

    // Bytes this attempt has already added to the shared progress counter.
    // Declared out here so a failed attempt can take them back: the same range
    // is about to be fetched again, and counting a range twice is how a
    // progress bar sails past 100% on a flaky connection.
    let mut received: u64;

    loop {
        if cancelled(&cancel) || abandon.load(Ordering::Relaxed) {
            return Err(Stop::Stopped);
        }
        received = 0;

        // Fresh token, refreshed proactively near expiry so it never lapses
        // underneath an in-flight request.
        let url = {
            let mut guard = tokens.lock().await;
            guard.ensure_fresh(&client).await;
            format!(
                "{}?token={}",
                client.endpoint(&url_base),
                urlencode(&guard.token)
            )
        };

        let range = format!("bytes={start}-{end}");
        let etag = journal.lock().await.etag.clone();

        let mut request = client.http().get(&url).header(reqwest::header::RANGE, &range);
        if let Some(etag) = &etag {
            request = request.header(reqwest::header::IF_RANGE, etag);
        }

        enum Attempt {
            Delivered,
            Transient,
            Changed,
        }

        let result: Result<Attempt, Stop> = async {
            let response = match request.send().await {
                Ok(response) => response,
                // Connection refused, DNS failure, TLS hiccup, timeout: the
                // whole class of things waiting fixes.
                Err(_) => return Ok(Attempt::Transient),
            };

            let status = response.status();
            if !status.is_success() {
                let failure = ApiClient::classify_failure(response).await;
                return match (failure.status, failure.code.as_deref()) {
                    // The signed link lapsed mid-download. Refresh and keep
                    // going — precisely the case the refresh endpoint exists
                    // for. A fresh token being refused again is access being
                    // genuinely denied, not expiry.
                    (_, Some("token_expired")) => {
                        let recently_refreshed = tokens.lock().await.refreshed_recently();
                        if recently_refreshed {
                            Err(Stop::Fatal(AppError::Server(
                                "The server refused access to this download.".to_string(),
                            )))
                        } else {
                            match tokens.lock().await.refresh(&client).await {
                                Ok(()) => Ok(Attempt::Transient),
                                Err(err) => Err(Stop::Fatal(err)),
                            }
                        }
                    }
                    // Out of allowance: paused, not failed, with the server's
                    // own explanation carried through to the UI.
                    (_, Some("quota_exceeded")) => Err(Stop::Quota(failure.message)),
                    (401 | 403, _) => Err(Stop::Fatal(AppError::Server(failure.message))),
                    (404 | 410, _) => Err(Stop::Fatal(AppError::Server(failure.message))),
                    // The byte range no longer lines up with what is on disk.
                    (416, _) => Ok(Attempt::Changed),
                    // Rate limiting and server errors are the server asking
                    // for patience, not refusing the transfer.
                    (429 | 500..=599, _) => Ok(Attempt::Transient),
                    _ => Err(Stop::Fatal(AppError::Server(failure.message))),
                };
            }

            // 200 to a ranged request means the range was not honoured.
            //
            // With an ETag that is `If-Range` saying these are different bytes
            // than the ones already half-written. Without one it means the
            // range was ignored outright — a proxy that strips the header, say
            // — and the body is the *whole file*. That case matters more than
            // it looks: on a fresh download no chunk has an ETag yet, so every
            // task in the first wave would happily write a full copy of the
            // file at its own offset and mark it done. Checking the status
            // rather than the ETag catches both.
            if !range_was_honoured(status, whole_file) {
                return Ok(Attempt::Changed);
            }

            // First successful response: remember which bytes these are, so
            // every later request can prove it.
            if etag.is_none() {
                if let Some(latest) = response
                    .headers()
                    .get(reqwest::header::ETAG)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
                {
                    let mut guard = journal.lock().await;
                    if guard.etag.is_none() {
                        guard.etag = Some(latest);
                        let _ = save_journal(&journal_path, &guard).await;
                    }
                }
            }

            let mut target = match tokio::fs::OpenOptions::new().write(true).open(&dest).await {
                Ok(target) => target,
                Err(err) => return Err(Stop::Fatal(AppError::Io(err))),
            };
            if target.seek(std::io::SeekFrom::Start(start)).await.is_err() {
                return Err(Stop::Fatal(AppError::Other(
                    "Could not write to the download location".to_string(),
                )));
            }

            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                if cancelled(&cancel) || abandon.load(Ordering::Relaxed) {
                    return Err(Stop::Stopped);
                }
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    // Mid-body connection loss surfaces as an error here and
                    // would surface as truncation below anyway; both mean
                    // "keep trying".
                    Err(_) => break,
                };

                let writable = writable_len(chunk.len(), expected, received);
                if writable == 0 {
                    break;
                }
                let slice = &chunk[..writable];

                if target.write_all(slice).await.is_err() {
                    return Err(Stop::Fatal(AppError::Other(
                        "Could not write to the download location".to_string(),
                    )));
                }
                received += slice.len() as u64;
                downloaded.fetch_add(slice.len() as u64, Ordering::Relaxed);
            }
            let _ = target.flush().await;

            if received < expected {
                // A truncated body is not an error at the HTTP layer, so it
                // has to be noticed here. Partial bytes stay on disk; the
                // chunk simply is not done.
                return Ok(Attempt::Transient);
            }
            Ok(Attempt::Delivered)
        }
        .await;

        match result {
            Ok(Attempt::Delivered) => {
                let mut guard = journal.lock().await;
                guard.mark_done(index);
                return save_journal(&journal_path, &guard)
                    .await
                    .map_err(Stop::Fatal);
            }
            // Everything below leaves this chunk unfinished, so the bytes it
            // streamed are about to be fetched again — by the retry just
            // below, or by a later run reading the journal, which never
            // recorded them. Either way they must come back off the counter.
            Ok(Attempt::Transient) => {
                uncredit(&downloaded, received);
                attempt += 1;
            }
            Ok(Attempt::Changed) => {
                uncredit(&downloaded, received);
                return Err(Stop::Changed);
            }
            Err(stop) => {
                uncredit(&downloaded, received);
                return Err(stop);
            }
        }

        tokio::time::sleep(backoff_delay(attempt)).await;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(size: u64) -> ChunkJournal {
        ChunkJournal::fresh(size)
    }

    /* ------------------------------------------------------- progress */

    /// Bytes credited to the progress counter and then taken back.
    ///
    /// The retry path streams part of a chunk, fails, and fetches the same
    /// range again. Without the rollback each attempt left its bytes behind
    /// and a download over a flaky connection reported well past 100% —
    /// which is precisely the connection this engine set out to survive.
    #[test]
    fn taking_bytes_back_off_the_counter_never_wraps() {
        let counter = AtomicU64::new(100);

        uncredit(&counter, 40);
        assert_eq!(counter.load(Ordering::Relaxed), 60);

        // Nothing streamed, nothing to undo.
        uncredit(&counter, 0);
        assert_eq!(counter.load(Ordering::Relaxed), 60);

        // An underflow here would render as sixteen exabytes downloaded,
        // which is a worse bug than the one the rollback fixes.
        uncredit(&counter, 500);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
    }

    /* ----------------------------------------------------------- range */

    #[test]
    fn a_range_answered_with_the_whole_file_is_not_that_range() {
        use reqwest::StatusCode;

        // The ordinary answer to a ranged request.
        assert!(range_was_honoured(StatusCode::PARTIAL_CONTENT, false));

        // A one-chunk file: the range covered everything, so 200 is honest.
        assert!(range_was_honoured(StatusCode::OK, true));

        // The one that used to slip through. On a fresh download no chunk has
        // an ETag, so `If-Range` cannot catch a proxy that strips Range — and
        // every task in the first wave would write a whole copy of the file at
        // its own offset and mark the chunk done.
        assert!(!range_was_honoured(StatusCode::OK, false));
    }

    #[test]
    fn a_chunk_never_writes_past_its_own_window() {
        // Room for all of it.
        assert_eq!(writable_len(1024, 8192, 0), 1024);
        // Room for some of it: the rest belongs to the next chunk, which may
        // already be downloaded and journalled.
        assert_eq!(writable_len(1024, 8192, 7680), 512);
        // No room at all — an over-sending server gets nothing.
        assert_eq!(writable_len(1024, 8192, 8192), 0);
        // And nothing can talk it into a negative window.
        assert_eq!(writable_len(1024, 8192, 9000), 0);
    }

    /* --------------------------------------------------------- journal */

    /// A journal save must never be able to destroy the journal.
    ///
    /// A plain write truncates first, so a crash between the truncate and the
    /// write leaves an empty sidecar — refused on load, costing the whole
    /// file. Re-fetching 40 GB because the lights went out is the outcome
    /// chunked resume exists to prevent.
    #[tokio::test]
    async fn a_journal_is_replaced_atomically_and_leaves_no_litter() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("game.dat.gbpart");

        let mut first = ChunkJournal::fresh(CHUNK_BYTES * 4);
        first.mark_done(0);
        save_journal(&path, &first).await.unwrap();

        let mut second = ChunkJournal::fresh(CHUNK_BYTES * 4);
        second.mark_done(0);
        second.mark_done(1);
        save_journal(&path, &second).await.unwrap();

        assert_eq!(load_journal(&path, CHUNK_BYTES * 4).await.done, vec![0, 1]);
        // The temporary is renamed over the target, not left beside it.
        assert!(!path.with_extension("gbpart.tmp").exists());
    }

    #[test]
    fn chunk_counts_round_up_but_never_overshoot() {
        assert_eq!(journal(CHUNK_BYTES).total_chunks(), 1);
        assert_eq!(journal(CHUNK_BYTES + 1).total_chunks(), 2);
        assert_eq!(journal(0).total_chunks(), 0);
        assert_eq!(journal(CHUNK_BYTES * 3).total_chunks(), 3);
    }

    #[test]
    fn marking_chunks_done_keeps_the_list_sorted_and_unique() {
        let mut j = journal(CHUNK_BYTES * 10);
        j.mark_done(5);
        j.mark_done(1);
        j.mark_done(5);
        assert_eq!(j.done, vec![1, 5]);
        assert!(j.is_done(5));
        assert!(!j.is_done(2));
    }

    #[test]
    fn done_bytes_counts_partial_final_chunks_at_their_true_size() {
        let size = CHUNK_BYTES * 2 + 100;
        let mut j = journal(size);
        j.mark_done(2);
        assert_eq!(j.done_bytes(), 100);

        j.mark_done(0);
        assert_eq!(j.done_bytes(), CHUNK_BYTES + 100);
    }

    #[test]
    fn a_sidecar_from_another_layout_is_not_trusted() {
        let mut j = journal(CHUNK_BYTES);
        j.version = 1;
        assert!(!j.usable(CHUNK_BYTES), "old-format journals must not resume");

        let mut j = journal(CHUNK_BYTES);
        j.chunk_bytes = 1024;
        assert!(!j.usable(CHUNK_BYTES), "foreign chunk sizes must not resume");

        let j = journal(CHUNK_BYTES * 2);
        assert!(
            !j.usable(CHUNK_BYTES),
            "a journal for other bytes must not resume"
        );

        assert!(journal(CHUNK_BYTES).usable(CHUNK_BYTES));
    }

    #[tokio::test]
    async fn journals_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("gb-journal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("game.dat.gbpart");

        let mut j = journal(CHUNK_BYTES * 4);
        j.mark_done(2);
        j.etag = Some("\"abc\"".to_string());
        save_journal(&path, &j).await.unwrap();

        let loaded = load_journal(&path, CHUNK_BYTES * 4).await;
        assert_eq!(loaded.done, vec![2]);
        assert_eq!(loaded.etag.as_deref(), Some("\"abc\""));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_journal_for_a_different_file_size_starts_over() {
        let dir = std::env::temp_dir().join(format!("gb-journal-size-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("game.dat.gbpart");

        let mut j = journal(CHUNK_BYTES * 2);
        j.mark_done(0);
        save_journal(&path, &j).await.unwrap();

        let loaded = load_journal(&path, CHUNK_BYTES * 5).await;
        assert!(
            loaded.done.is_empty(),
            "progress for other bytes is worthless"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backoff_grows_quickly_then_stops_growing() {
        assert_eq!(backoff_delay(0), Duration::from_millis(500));
        assert_eq!(backoff_delay(1), Duration::from_millis(1_000));
        assert_eq!(backoff_delay(7), Duration::from_secs(60));
        assert_eq!(backoff_delay(20), Duration::from_secs(60));
    }

    #[test]
    fn unsafe_paths_are_refused_and_safe_ones_cleaned() {
        use super::super::sanitise_relative_path;
        assert!(sanitise_relative_path("../escape").is_err());
        assert_eq!(
            sanitise_relative_path("data/game file.dat").unwrap(),
            PathBuf::from("data/game file.dat")
        );
    }
}
