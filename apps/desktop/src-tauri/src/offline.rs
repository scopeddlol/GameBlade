//! What the client keeps on disk so it still works with no server.
//!
//! The archive lives on somebody's own hardware, which means it is down
//! sometimes: a reboot, a moved cable, a laptop on a train. Before this, any of
//! those took the whole client with it — the sign-in check failed, the app fell
//! back to the login screen, and the login screen could not reach the server
//! either. A library of installed games sitting on the local disk was
//! unreachable because a *catalog* was.
//!
//! So two caches, both write-through and both best-effort:
//!
//! * the last successful answer to each GET, so the pages that only read the
//!   catalog still render what they last knew, and
//! * artwork, as files, because a grid of covers is most of what the library
//!   *is* and a hundred broken-image icons is not a usable offline mode.
//!
//! Nothing here is authoritative. A miss is a miss, and every caller treats a
//! cached answer as what it is: the last thing the server said, not the truth.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Beyond this a response is not worth keeping. Nothing the client reads is
/// anywhere near it; the cap exists so an unexpected endpoint cannot quietly
/// fill somebody's disk.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// The same, for one image.
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

/// How much artwork is kept before the oldest is dropped.
const IMAGE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

/// A filename-safe, collision-resistant key for an arbitrary request path.
fn key(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    // Half the digest: still 128 bits, and a shorter name on disk.
    hex::encode(&digest[..16])
}

/// Whether a GET is worth remembering.
///
/// The test is "would this page be worth showing from yesterday's copy". A
/// search someone is typing would not: it is one person's, momentary, and
/// caching every prefix writes a file per keystroke. Notifications would not
/// either — a stale unread badge is worse than none.
pub fn is_cacheable(path: &str) -> bool {
    if path.contains("/notifications") || path.contains("search") || path.contains("?q=") {
        return false;
    }
    // A download token is signed and short-lived; replaying a stale one just
    // produces a 403 that reads like a permissions problem.
    !path.contains("/download")
}

pub struct Cache {
    responses: PathBuf,
    images: PathBuf,
}

impl Cache {
    pub fn new(app_data: &Path) -> Self {
        let responses = app_data.join("offline").join("responses");
        let images = app_data.join("offline").join("images");
        std::fs::create_dir_all(&responses).ok();
        std::fs::create_dir_all(&images).ok();
        Self { responses, images }
    }

    /* --------------------------------------------------------- responses */

    fn response_path(&self, request_path: &str) -> PathBuf {
        self.responses.join(format!("{}.json", key(request_path)))
    }

    /// Remembers one successful answer. Failures are swallowed: a cache that
    /// cannot be written is a slower app, not a broken one.
    pub fn put_json(&self, request_path: &str, body: &serde_json::Value) {
        if !is_cacheable(request_path) {
            return;
        }
        let Ok(encoded) = serde_json::to_vec(body) else {
            return;
        };
        if encoded.len() > MAX_BODY_BYTES {
            return;
        }
        std::fs::write(self.response_path(request_path), encoded).ok();
    }

    /// The last thing the server said, if anything.
    pub fn get_json(&self, request_path: &str) -> Option<serde_json::Value> {
        let raw = std::fs::read(self.response_path(request_path)).ok()?;
        serde_json::from_slice(&raw).ok()
    }

    /// When that answer was stored, so the UI can say how old it is.
    pub fn cached_at(&self, request_path: &str) -> Option<SystemTime> {
        std::fs::metadata(self.response_path(request_path))
            .ok()?
            .modified()
            .ok()
    }

    /* ------------------------------------------------------------ images */

    pub fn image_path(&self, media_path: &str) -> PathBuf {
        self.images.join(key(media_path))
    }

    /// Stores one image, and takes the oldest ones out if the budget is blown.
    pub fn put_image(&self, media_path: &str, bytes: &[u8]) {
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return;
        }
        if std::fs::write(self.image_path(media_path), bytes).is_ok() {
            self.trim_images();
        }
    }

    pub fn read_image(&self, media_path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.image_path(media_path)).ok()
    }

    /// Drops the least recently written artwork once the budget is exceeded.
    ///
    /// Least-recently-*written* rather than least-recently-used, because
    /// reading a file does not reliably update its access time on Windows and
    /// pretending otherwise would evict whatever was most looked at.
    fn trim_images(&self) {
        let Ok(entries) = std::fs::read_dir(&self.images) else {
            return;
        };

        let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some((
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    meta.len(),
                    entry.path(),
                ))
            })
            .collect();

        let total: u64 = files.iter().map(|(_, size, _)| size).sum();
        if total <= IMAGE_BUDGET_BYTES {
            return;
        }

        files.sort_by_key(|(modified, _, _)| *modified);
        let mut remaining = total;
        for (_, size, path) in files {
            if remaining <= IMAGE_BUDGET_BYTES {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                remaining = remaining.saturating_sub(size);
            }
        }
    }

    /// Forgets everything. Used on sign-out, so the next account does not open
    /// onto the previous one's library.
    pub fn clear(&self) {
        for dir in [&self.responses, &self.images] {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    std::fs::remove_file(entry.path()).ok();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_cache(name: &str) -> (Cache, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "gameblade-offline-test-{}-{name}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        (Cache::new(&dir), dir)
    }

    #[test]
    fn a_response_survives_a_round_trip() {
        let (cache, dir) = temp_cache("roundtrip");
        let body = serde_json::json!({ "items": [1, 2, 3] });

        cache.put_json("/games?limit=60", &body);

        assert_eq!(cache.get_json("/games?limit=60"), Some(body));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn different_paths_do_not_share_an_entry() {
        let (cache, dir) = temp_cache("distinct");
        cache.put_json("/games?limit=60", &serde_json::json!(1));
        cache.put_json("/games?limit=30", &serde_json::json!(2));

        assert_eq!(
            cache.get_json("/games?limit=60"),
            Some(serde_json::json!(1))
        );
        assert_eq!(
            cache.get_json("/games?limit=30"),
            Some(serde_json::json!(2))
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_path_never_seen_is_a_miss_rather_than_an_error() {
        let (cache, dir) = temp_cache("miss");
        assert_eq!(cache.get_json("/nothing"), None);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A stale unread count is worse than none, and a search is one person's
    /// momentary business — caching every prefix writes a file per keystroke.
    #[test]
    fn momentary_and_personal_endpoints_are_not_kept() {
        assert!(is_cacheable("/games?limit=60"));
        assert!(is_cacheable("/home"));
        assert!(!is_cacheable("/notifications?limit=15"));
        assert!(!is_cacheable("/requests/search?q=hollow"));
        assert!(!is_cacheable("/download/abc/manifest"));
    }

    #[test]
    fn an_uncacheable_path_is_not_written_even_when_asked() {
        let (cache, dir) = temp_cache("refuse");
        cache.put_json("/notifications", &serde_json::json!({ "unreadCount": 3 }));
        assert_eq!(cache.get_json("/notifications"), None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn images_round_trip() {
        let (cache, dir) = temp_cache("images");
        assert_eq!(cache.read_image("/api/images/img_1"), None);

        cache.put_image("/api/images/img_1", b"not really a png");

        assert_eq!(
            cache.read_image("/api/images/img_1"),
            Some(b"not really a png".to_vec())
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn clearing_leaves_nothing_of_the_previous_account_behind() {
        let (cache, dir) = temp_cache("clear");
        cache.put_json("/games", &serde_json::json!([1]));
        cache.put_image("/api/images/img_1", b"bytes");

        cache.clear();

        assert_eq!(cache.get_json("/games"), None);
        assert_eq!(cache.read_image("/api/images/img_1"), None);
        std::fs::remove_dir_all(dir).ok();
    }
}
