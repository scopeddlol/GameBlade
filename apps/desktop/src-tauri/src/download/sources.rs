//! Where each chunk is fetched from, and how that decision improves as a
//! download runs.
//!
//! A game can now be held on several machines, and a machine with an address of
//! its own can hand bytes to this client without the server relaying them. That
//! turns "download the file" into a choice, and the choice is worth making well:
//! on a library split between a home server and a VPS, the difference between
//! the best and the worst source is routinely ten times.
//!
//! Three rules shape everything here.
//!
//! * **The server is always a candidate.** It is the one source that is known
//!   to work, and every direct source is an optimisation on top of it. A
//!   download can never fail because a node went away.
//! * **Measurement beats configuration.** The server can say which node it
//!   thinks is best, but only this machine can know what its own link to that
//!   node does on a Tuesday evening. Every completed chunk is a measurement,
//!   and the scheduler follows them within seconds.
//! * **A source is dropped, not retried forever.** Two failures in a row and it
//!   sits out the rest of the download. The alternative — treating every source
//!   as equally worth another try — is how one unreachable node makes a
//!   download slower than having no nodes at all.
//!
//! None of this affects what arrives: every chunk is named by its SHA-256 and
//! checked. A bad source can waste time; it cannot produce a bad install.

use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Mutex;

use crate::api::{ApiClient, DeliveredBytes, ManifestSource, SourceMeasurement};

/// How many consecutive failures retire a direct source for this download.
///
/// Two rather than one: a single failure is a dropped connection, which happens
/// to healthy links. Two in a row is a node that is not going to work from here.
const FAILURES_BEFORE_RETIRED: u32 = 2;

/// Weight given to a source nothing has measured yet, in bytes per second.
///
/// Roughly a fast home connection. High enough that an untried source is
/// actually tried — which is the only way it is ever measured — and low enough
/// that one bad guess does not hand it most of a download before the first
/// chunk comes back.
const UNMEASURED_WEIGHT: f64 = 8_000_000.0;

/// How much of the running average one chunk replaces.
///
/// A tenth: fast enough to notice a source degrading within a few chunks, slow
/// enough that one unlucky 10 MiB does not retire a good node.
const SMOOTHING: f64 = 0.1;

/// Refuse to re-fetch a manifest more often than this while a download runs.
///
/// Grants expire on a timer shorter than a large download, so they are
/// refreshed — but a source failing every request must not turn into a request
/// per chunk against the server.
const GRANT_REFRESH_DEBOUNCE: Duration = Duration::from_secs(60);

/// What one attempt is addressed to.
#[derive(Debug, Clone)]
pub(crate) enum Target {
    /// Straight to a node, at its own address.
    Direct {
        node_id: String,
        /// Fully-formed, including the grant and the node's own ids.
        url: String,
    },
    /// Through the server, which is where every download started and ends up.
    Proxy,
}

impl Target {
    pub(crate) fn node_id(&self) -> Option<&str> {
        match self {
            Target::Direct { node_id, .. } => Some(node_id),
            Target::Proxy => None,
        }
    }

    pub(crate) fn is_direct(&self) -> bool {
        matches!(self, Target::Direct { .. })
    }
}

/// One measured source, as the downloads panel shows it.
#[derive(Debug, Clone, Serialize)]
pub struct SourceProbe {
    pub node_id: Option<String>,
    pub label: String,
    /// True when the node answered on its own address rather than via the server.
    pub direct: bool,
    pub ok: bool,
    /// Time to the first byte, milliseconds.
    pub latency_ms: Option<f64>,
    pub bytes_per_second: Option<f64>,
    pub detail: Option<String>,
}

/// One source's standing: what it is, and how it has behaved.
#[derive(Debug, Clone)]
struct Entry {
    node_id: Option<String>,
    label: String,
    /// Absent for the server's own route, which needs no address or grant.
    direct_url: Option<String>,
    grant: Option<String>,
    /// The ids this particular machine knows the game and file by.
    game_id: Option<String>,
    file_id: Option<String>,
    /// Running average throughput, bytes per second; `None` until measured.
    measured: Option<f64>,
    /// Smooth weighted round-robin credit. Nothing but the scheduler reads it.
    credit: f64,
    consecutive_failures: u32,
    retired: bool,
    /// Bytes this source has actually delivered during this download.
    delivered: u64,
}

impl Entry {
    fn weight(&self) -> f64 {
        self.measured.unwrap_or(UNMEASURED_WEIGHT).max(1.0)
    }
}

/// The set of sources one download may use, and their live standing.
pub(crate) struct SourcePool {
    entries: Mutex<Vec<Entry>>,
    game_id: String,
    /// The catalog entry's own file id, for the server's route.
    file_id: String,
    /// When a grant refresh was last attempted, so failures cannot loop.
    last_refresh: Mutex<Option<Instant>>,
}

impl SourcePool {
    /// Build a pool from a manifest's source list.
    ///
    /// The server is added unconditionally and first. Everything else is an
    /// optimisation layered on top of a path that is known to work.
    pub(crate) fn new(game_id: &str, file_id: &str, sources: &[ManifestSource]) -> Self {
        let mut entries = vec![Entry {
            node_id: None,
            label: "GameBlade server".to_string(),
            direct_url: None,
            grant: None,
            game_id: None,
            file_id: None,
            measured: None,
            credit: 0.0,
            consecutive_failures: 0,
            retired: false,
            delivered: 0,
        }];

        for source in sources {
            // Only a node with an address adds anything: a node without one is
            // reached through the server, which is already in this list.
            let (Some(url), Some(grant)) = (source.direct_url.clone(), source.grant.clone()) else {
                continue;
            };
            let Some(node_id) = source.node_id.clone() else {
                continue;
            };

            entries.push(Entry {
                node_id: Some(node_id),
                label: if source.label.is_empty() {
                    "Node".to_string()
                } else {
                    source.label.clone()
                },
                direct_url: Some(url),
                grant: Some(grant),
                game_id: source.game_id.clone(),
                file_id: source.file_id.clone(),
                measured: source.observed_bytes_per_second.filter(|rate| *rate > 0.0),
                credit: 0.0,
                consecutive_failures: 0,
                retired: false,
                delivered: 0,
            });
        }

        Self {
            entries: Mutex::new(entries),
            game_id: game_id.to_string(),
            file_id: file_id.to_string(),
            last_refresh: Mutex::new(None),
        }
    }

    /// Who should fetch this chunk.
    ///
    /// Smooth weighted round-robin over measured throughput: each source
    /// accumulates credit at its own rate, the one with the most is chosen, and
    /// it then pays the total back. Two sources measured at 90 and 10 MB/s get
    /// nine chunks and one, interleaved rather than in runs — which matters,
    /// because a run of ten chunks on the slow one is ten chunks the fast one
    /// spent idle.
    pub(crate) async fn pick(&self, chunk_index: u64) -> Target {
        let mut entries = self.entries.lock().await;

        let total: f64 = entries
            .iter()
            .filter(|entry| !entry.retired)
            .map(Entry::weight)
            .sum();

        // Credit first, then choose. Done in one pass the borrow checker
        // rightly objects to: the comparison needs every entry's new credit,
        // and half of them have not been given theirs yet.
        for entry in entries.iter_mut() {
            if entry.retired {
                continue;
            }
            entry.credit += entry.weight();
        }

        let best = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| !entry.retired)
            .max_by(|(_, left), (_, right)| {
                left.credit
                    .partial_cmp(&right.credit)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(index, _)| index);

        let Some(index) = best else {
            // Everything retired, which cannot happen: the server is never
            // retired. Belt and braces, and the fallback is the right one.
            return Target::Proxy;
        };

        entries[index].credit -= total;

        let entry = &entries[index];
        match (&entry.direct_url, &entry.grant, &entry.node_id) {
            (Some(url), Some(grant), Some(node_id)) => Target::Direct {
                node_id: node_id.clone(),
                url: direct_chunk_url(url, grant, chunk_index),
            },
            _ => Target::Proxy,
        }
    }

    /// Record a chunk that arrived, and how fast.
    pub(crate) async fn succeeded(&self, target: &Target, bytes: u64, elapsed: Duration) {
        let seconds = elapsed.as_secs_f64();
        let rate = if seconds > 0.0 {
            bytes as f64 / seconds
        } else {
            return;
        };

        let mut entries = self.entries.lock().await;
        let Some(entry) = find_mut(&mut entries, target.node_id()) else {
            return;
        };

        entry.consecutive_failures = 0;
        entry.delivered += bytes;
        entry.measured = Some(match entry.measured {
            Some(current) => current * (1.0 - SMOOTHING) + rate * SMOOTHING,
            None => rate,
        });
    }

    /// Record an attempt that did not deliver, and retire the source if it keeps
    /// happening.
    ///
    /// Only direct sources are ever retired. Retiring the server would leave a
    /// download with nowhere to go, and its failures are already handled where
    /// they belong — by the retry loop that waits out an outage.
    pub(crate) async fn failed(&self, target: &Target, reason: &str) -> bool {
        let mut entries = self.entries.lock().await;
        let Some(entry) = find_mut(&mut entries, target.node_id()) else {
            return false;
        };
        if entry.direct_url.is_none() {
            return false;
        }

        entry.consecutive_failures += 1;
        if entry.consecutive_failures >= FAILURES_BEFORE_RETIRED {
            entry.retired = true;
            tracing_note(&format!(
                "{} is not answering directly ({reason}); using the server for the rest of this download",
                entry.label
            ));
            return true;
        }
        false
    }

    /// Replace grants from a fresh manifest, for a download that outlives them.
    ///
    /// A grant lives for minutes and a download can take hours, so the first
    /// 401 from a node is expected rather than alarming: it means this download
    /// has been running for a while. Refreshing keeps it on the fast path
    /// instead of quietly falling back to the server for the remaining 40 GB.
    ///
    /// Debounced, and never fatal: if the refresh fails the pool is unchanged
    /// and the source retires on its next failure like any other.
    pub(crate) async fn refresh_grants(&self, client: &ApiClient) -> bool {
        {
            let mut last = self.last_refresh.lock().await;
            if last.is_some_and(|at| at.elapsed() < GRANT_REFRESH_DEBOUNCE) {
                return false;
            }
            *last = Some(Instant::now());
        }

        // The source list rather than the whole manifest: refreshing a grant
        // is not a fresh install request, and the manifest route treats it as
        // one.
        let Ok(fresh) = client.game_sources(&self.game_id).await else {
            return false;
        };

        let mut entries = self.entries.lock().await;
        let mut refreshed = false;

        for source in fresh.sources {
            let (Some(node_id), Some(url), Some(grant)) =
                (source.node_id, source.direct_url, source.grant)
            else {
                continue;
            };
            for entry in entries.iter_mut() {
                if entry.node_id.as_deref() == Some(node_id.as_str()) {
                    entry.direct_url = Some(url.clone());
                    entry.grant = Some(grant.clone());
                    entry.game_id = source.game_id.clone();
                    entry.file_id = source.file_id.clone();
                    // A refreshed grant is a second chance: the failure that
                    // prompted it was the expiry, not the node.
                    entry.retired = false;
                    entry.consecutive_failures = 0;
                    refreshed = true;
                }
            }
        }

        refreshed
    }

    /// The server's own route for this file, for the proxy path.
    pub(crate) fn proxy_path(&self) -> String {
        format!("/download/{}/files/{}", self.game_id, self.file_id)
    }

    /// What this download measured, in the shape the server records.
    pub(crate) async fn measurements(&self) -> Vec<SourceMeasurement> {
        self.entries
            .lock()
            .await
            .iter()
            .filter(|entry| entry.measured.is_some() || entry.retired)
            .map(|entry| SourceMeasurement {
                node_id: entry.node_id.clone(),
                transport: if entry.direct_url.is_some() {
                    "direct".to_string()
                } else {
                    "proxy".to_string()
                },
                latency_ms: None,
                bytes_per_second: entry.measured,
                ok: !entry.retired,
                detail: None,
            })
            .collect()
    }

    /// What each node handed over without the server seeing it.
    pub(crate) async fn delivered(&self) -> Vec<DeliveredBytes> {
        self.entries
            .lock()
            .await
            .iter()
            .filter(|entry| entry.direct_url.is_some() && entry.delivered > 0)
            .filter_map(|entry| {
                entry.node_id.clone().map(|node_id| DeliveredBytes {
                    node_id,
                    bytes: entry.delivered,
                })
            })
            .collect()
    }

    /// A snapshot for the downloads panel: who is being used, and how well.
    pub(crate) async fn snapshot(&self) -> Vec<SourceProbe> {
        self.entries
            .lock()
            .await
            .iter()
            .map(|entry| SourceProbe {
                node_id: entry.node_id.clone(),
                label: entry.label.clone(),
                direct: entry.direct_url.is_some(),
                ok: !entry.retired,
                latency_ms: None,
                bytes_per_second: entry.measured,
                detail: None,
            })
            .collect()
    }
}

/// The URL one direct chunk request is made to.
fn direct_chunk_url(base: &str, grant: &str, index: u64) -> String {
    format!("{base}?index={index}&grant={}", urlencode(grant))
}

fn find_mut<'a>(entries: &'a mut [Entry], node_id: Option<&str>) -> Option<&'a mut Entry> {
    entries
        .iter_mut()
        .find(|entry| entry.node_id.as_deref() == node_id)
}

/// Percent-encodes everything that is not unreserved, so a grant survives a
/// query string exactly as it was signed.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A note worth having in the log without pulling a logging framework into a
/// module that otherwise has no opinions about output.
fn tracing_note(message: &str) {
    eprintln!("gameblade: {message}");
}

/* ------------------------------------------------------------- measuring */

/// Measure every source a game is offered from, one after another.
///
/// Sequential on purpose. Measuring in parallel measures the client's own
/// connection being shared four ways, which answers a question nobody asked:
/// what is wanted is what each source can do with the link to itself.
///
/// A real read of real bytes, from the same routes a download uses. A synthetic
/// endpoint would leave out the node's disk, the server's relay and the
/// verification on both — most of what actually decides whether a source is
/// good.
pub async fn measure_sources(
    client: &ApiClient,
    game_id: &str,
    file_id: &str,
    sources: &[ManifestSource],
    sample_bytes: u64,
) -> Vec<SourceProbe> {
    let mut results = Vec::new();

    // The server first: it is the source every download can use, so it is the
    // one a player most wants a number for.
    results.push(measure_proxy(client, game_id, file_id, sample_bytes).await);

    for source in sources {
        // A source with no probe URL is one this build cannot measure directly
        // — an older server, or a node without an address. It is skipped here
        // rather than guessed at; the relay above already measured the path
        // such a source is actually fetched over.
        let (Some(url), Some(grant), Some(node_id)) = (
            source.probe_url.as_ref(),
            source.grant.as_ref(),
            source.node_id.as_ref(),
        ) else {
            continue;
        };

        let label = if source.label.is_empty() {
            "Node".to_string()
        } else {
            source.label.clone()
        };
        results.push(measure_direct(client, node_id, &label, url, grant, sample_bytes).await);
    }

    results
}

async fn measure_proxy(
    client: &ApiClient,
    game_id: &str,
    file_id: &str,
    sample_bytes: u64,
) -> SourceProbe {
    let probe = SourceProbe {
        node_id: None,
        label: "GameBlade server".to_string(),
        direct: false,
        ok: false,
        latency_ms: None,
        bytes_per_second: None,
        detail: None,
    };

    let token = match client.download_token(game_id).await {
        Ok(issued) => issued.token,
        Err(error) => {
            return SourceProbe {
                detail: Some(error.to_string()),
                ..probe
            }
        }
    };

    let url = format!(
        "{}?token={}",
        client.endpoint(&format!("/download/{game_id}/files/{file_id}")),
        urlencode(&token)
    );

    let request = client
        .http()
        .get(&url)
        .header(reqwest::header::RANGE, format!("bytes=0-{}", sample_bytes - 1));

    time_request(request, probe).await
}

async fn measure_direct(
    client: &ApiClient,
    node_id: &str,
    label: &str,
    base_url: &str,
    grant: &str,
    sample_bytes: u64,
) -> SourceProbe {
    let probe = SourceProbe {
        node_id: Some(node_id.to_string()),
        label: label.to_string(),
        direct: true,
        ok: false,
        latency_ms: None,
        bytes_per_second: None,
        detail: None,
    };

    // The node's probe route rather than its chunk route: it reads the same
    // bytes off the same disk and stops at the sample size, so a measurement
    // costs a couple of megabytes instead of a full chunk.
    let url = format!("{base_url}?bytes={sample_bytes}&grant={}", urlencode(grant));

    let request = client
        .http()
        .get(&url)
        // A node that is not reachable should say so in seconds. The default
        // would have a player watching a spinner for a minute per dead source.
        .timeout(Duration::from_secs(20));

    time_request(request, probe).await
}

/// Time one request end to end, and turn it into a verdict.
async fn time_request(request: reqwest::RequestBuilder, probe: SourceProbe) -> SourceProbe {
    let started = Instant::now();

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return SourceProbe {
                detail: Some(friendly_error(&error)),
                ..probe
            }
        }
    };

    // Time to the response head, which is latency plus whatever the source
    // needed to find the file. The rest is throughput.
    let latency_ms = started.elapsed().as_secs_f64() * 1000.0;

    if !response.status().is_success() {
        return SourceProbe {
            latency_ms: Some(latency_ms),
            detail: Some(format!("refused with HTTP {}", response.status().as_u16())),
            ..probe
        };
    }

    let body = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return SourceProbe {
                latency_ms: Some(latency_ms),
                detail: Some(friendly_error(&error)),
                ..probe
            }
        }
    };

    let seconds = started.elapsed().as_secs_f64();
    let rate = if seconds > 0.0 {
        Some(body.len() as f64 / seconds)
    } else {
        None
    };

    SourceProbe {
        ok: true,
        latency_ms: Some(latency_ms),
        bytes_per_second: rate,
        ..probe
    }
}

/// A sentence a player can act on, rather than a Rust error chain.
fn friendly_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timed out".to_string()
    } else if error.is_connect() {
        "could not be reached".to_string()
    } else {
        "the connection failed".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn source(label: &str, node: &str, direct: bool, measured: Option<f64>) -> ManifestSource {
        ManifestSource {
            kind: "node".to_string(),
            node_id: Some(node.to_string()),
            label: label.to_string(),
            priority: 0,
            direct_url: direct.then(|| "https://vps.example.com:8099/gb/v1/chunk".to_string()),
            probe_url: direct.then(|| "https://vps.example.com:8099/gb/v1/probe".to_string()),
            grant: direct.then(|| "v2.grant".to_string()),
            game_id: Some("gam_copy".to_string()),
            file_id: Some("gfl_copy".to_string()),
            observed_bytes_per_second: measured,
        }
    }

    #[tokio::test]
    async fn a_game_with_no_reachable_nodes_uses_the_server() {
        let pool = SourcePool::new("gam_1", "gfl_1", &[source("Home", "nod_1", false, None)]);

        // Nothing to choose: a node without an address is reached through the
        // server, which is the source already in the pool.
        assert!(matches!(pool.pick(0).await, Target::Proxy));
    }

    #[tokio::test]
    async fn a_node_with_an_address_is_addressed_in_its_own_ids() {
        let pool = SourcePool::new("gam_1", "gfl_1", &[source("VPS", "nod_1", true, None)]);

        // The grant already names the node's copy, so the URL carries the
        // chunk index and the grant and nothing else.
        let mut seen_direct = false;
        for index in 0..8 {
            if let Target::Direct { url, node_id, .. } = pool.pick(index).await {
                assert_eq!(node_id, "nod_1");
                assert!(url.contains(&format!("index={index}")));
                assert!(url.contains("grant=v2.grant"));
                seen_direct = true;
            }
        }
        assert!(seen_direct);
    }

    #[tokio::test]
    async fn work_goes_where_the_measurements_say() {
        let pool = SourcePool::new(
            "gam_1",
            "gfl_1",
            &[
                source("Fast", "nod_fast", true, Some(90_000_000.0)),
                source("Slow", "nod_slow", true, Some(10_000_000.0)),
            ],
        );

        let mut counts: HashMap<String, usize> = HashMap::new();
        for index in 0..100 {
            let target = pool.pick(index).await;
            *counts
                .entry(target.node_id().unwrap_or("proxy").to_string())
                .or_default() += 1;
        }

        let fast = *counts.get("nod_fast").unwrap_or(&0);
        let slow = *counts.get("nod_slow").unwrap_or(&0);
        assert!(
            fast > slow * 3,
            "expected the fast node to carry most of it, got fast={fast} slow={slow}"
        );
        // And the server still gets a share: it is the source that is known to
        // work, and a download that never touches it cannot notice it is fine.
        assert!(counts.get("proxy").copied().unwrap_or(0) > 0);
    }

    #[tokio::test]
    async fn a_source_that_keeps_failing_sits_out_the_rest_of_the_download() {
        let pool = SourcePool::new("gam_1", "gfl_1", &[source("Flaky", "nod_1", true, None)]);
        let target = Target::Direct {
            node_id: "nod_1".to_string(),
            url: "https://vps.example.com:8099/gb/v1/chunk".to_string(),
        };

        assert!(!pool.failed(&target, "connection refused").await);
        assert!(pool.failed(&target, "connection refused").await);

        // Everything from here goes through the server, which is exactly what a
        // download with an unreachable node should do.
        for index in 0..10 {
            assert!(matches!(pool.pick(index).await, Target::Proxy));
        }
    }

    #[tokio::test]
    async fn the_server_is_never_retired() {
        let pool = SourcePool::new("gam_1", "gfl_1", &[]);
        for _ in 0..10 {
            assert!(!pool.failed(&Target::Proxy, "500").await);
        }
        assert!(matches!(pool.pick(0).await, Target::Proxy));
    }

    #[tokio::test]
    async fn measurements_follow_what_actually_arrived() {
        let pool = SourcePool::new(
            "gam_1",
            "gfl_1",
            &[source("Optimistic", "nod_1", true, Some(500_000_000.0))],
        );
        let target = Target::Direct {
            node_id: "nod_1".to_string(),
            url: "https://vps.example.com:8099/gb/v1/chunk".to_string(),
        };

        // Somebody else measured half a gigabyte a second. From here it is one
        // megabyte a second, and this machine's own experience has to win —
        // repeatedly, because the average is smoothed rather than replaced.
        for _ in 0..80 {
            pool.succeeded(&target, 1_000_000, Duration::from_millis(1000))
                .await;
        }

        let measured = pool.measurements().await;
        let node = measured
            .iter()
            .find(|entry| entry.node_id.as_deref() == Some("nod_1"))
            .expect("the node was measured");
        assert!(node.bytes_per_second.unwrap_or(0.0) < 10_000_000.0);

        let delivered = pool.delivered().await;
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].bytes, 80_000_000);
    }

    #[test]
    fn a_grant_survives_the_query_string_it_is_put_in() {
        // Base64url needs no escaping, which is the point — but the encoder has
        // to know that, or a signature check fails on bytes nobody changed.
        assert_eq!(urlencode("v2.abc-_DEF.xyz"), "v2.abc-_DEF.xyz");
        assert_eq!(urlencode("a+b/c=" ), "a%2Bb%2Fc%3D");
    }
}
