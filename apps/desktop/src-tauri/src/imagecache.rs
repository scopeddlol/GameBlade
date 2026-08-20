use crate::error::AppResult;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Artwork is small and rarely changes, but there is a lot of it: a library of
/// a few hundred games is a few hundred covers re-fetched on every cold start.
/// Capped so a long-lived install cannot grow without bound.
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;

/// Files below this are almost certainly an error page rather than an image.
const MIN_IMAGE_BYTES: u64 = 64;

/// Where a cached copy of one artwork path lives.
///
/// Named by the digest of the *path*, not of the bytes: the point is to answer
/// "have I already fetched this cover" before fetching anything. The extension
/// is carried over so the webview picks the right decoder.
pub fn cache_path(root: &Path, url_path: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    // The token rides in the query string and rotates per device, so it is cut
    // off before hashing — otherwise every session would miss the whole cache.
    hasher.update(url_path.split('?').next().unwrap_or(url_path).as_bytes());
    let digest = format!("{:x}", hasher.finalize());

    let extension = url_path
        .split('?')
        .next()
        .unwrap_or(url_path)
        .rsplit('.')
        .next()
        .filter(|ext| ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("img");

    // Two levels of fan-out: a single directory with 10,000 covers in it is
    // slow to list on Windows and unpleasant to inspect by hand.
    root.join(&digest[0..2])
        .join(format!("{digest}.{extension}"))
}

/// Whether a usable copy is already on disk.
pub fn is_cached(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.len() >= MIN_IMAGE_BYTES)
        .unwrap_or(false)
}

/// Total size of everything under the cache root.
pub fn size_on_disk(root: &Path) -> u64 {
    fn walk(dir: &Path, total: &mut u64) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            match entry.metadata() {
                Ok(meta) if meta.is_dir() => walk(&entry.path(), total),
                Ok(meta) => *total += meta.len(),
                Err(_) => {}
            }
        }
    }
    let mut total = 0;
    walk(root, &mut total);
    total
}

/// Deletes the whole cache. Artwork is derived data, so this is always safe.
pub fn clear(root: &Path) -> AppResult<()> {
    if root.exists() {
        std::fs::remove_dir_all(root)?;
    }
    Ok(())
}

/// Drops the oldest files until the cache is back under its ceiling.
///
/// Least-recently-modified first rather than a true LRU: reading a file does
/// not reliably update its access time on Windows, and modification time is
/// close enough when every entry is written once and never changed.
pub fn evict_if_needed(root: &Path) -> AppResult<u64> {
    let total = size_on_disk(root);
    if total <= MAX_CACHE_BYTES {
        return Ok(0);
    }

    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    fn collect(dir: &Path, out: &mut Vec<(PathBuf, u64, std::time::SystemTime)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            match entry.metadata() {
                Ok(meta) if meta.is_dir() => collect(&entry.path(), out),
                Ok(meta) => out.push((
                    entry.path(),
                    meta.len(),
                    meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                )),
                Err(_) => {}
            }
        }
    }
    collect(root, &mut files);
    files.sort_by_key(|(_, _, modified)| *modified);

    let mut freed = 0;
    let mut remaining = total;
    for (path, size, _) in files {
        if remaining <= MAX_CACHE_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            remaining -= size;
            freed += size;
        }
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_path_maps_to_the_same_file() {
        let root = Path::new("/cache");
        assert_eq!(
            cache_path(root, "/api/images/abc.webp"),
            cache_path(root, "/api/images/abc.webp")
        );
    }

    #[test]
    fn a_rotating_token_does_not_miss_the_cache() {
        // The device token is appended to every artwork URL and changes per
        // session; hashing it in would make the cache useless on day two.
        let root = Path::new("/cache");
        assert_eq!(
            cache_path(root, "/api/images/abc.webp?token=one"),
            cache_path(root, "/api/images/abc.webp?token=two")
        );
    }

    #[test]
    fn different_artwork_does_not_collide() {
        let root = Path::new("/cache");
        assert_ne!(
            cache_path(root, "/api/images/abc.webp"),
            cache_path(root, "/api/images/def.webp")
        );
    }

    #[test]
    fn the_extension_is_kept_so_the_webview_can_decode_it() {
        let path = cache_path(Path::new("/cache"), "/api/images/abc.png?token=x");
        assert_eq!(path.extension().unwrap(), "png");
    }

    #[test]
    fn a_path_without_a_usable_extension_still_produces_a_file() {
        let path = cache_path(Path::new("/cache"), "/api/images/abc");
        assert_eq!(path.extension().unwrap(), "img");
    }

    #[test]
    fn a_truncated_file_is_not_treated_as_cached() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("small.webp");
        std::fs::write(&file, b"nope").unwrap();
        assert!(
            !is_cached(&file),
            "a 4-byte file is an error page, not artwork"
        );
    }

    #[test]
    fn eviction_leaves_the_cache_under_its_ceiling() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Two files over the ceiling between them.
        let big = vec![0u8; (MAX_CACHE_BYTES / 2) as usize + 1024];
        for name in ["a", "b", "c"] {
            let sub = root.join(name);
            std::fs::create_dir_all(&sub).unwrap();
            std::fs::write(sub.join(format!("{name}.webp")), &big).unwrap();
        }
        assert!(size_on_disk(root) > MAX_CACHE_BYTES);

        let freed = evict_if_needed(root).unwrap();
        assert!(freed > 0);
        assert!(
            size_on_disk(root) <= MAX_CACHE_BYTES,
            "cache still over its ceiling after eviction"
        );
    }

    #[test]
    fn clearing_removes_everything_and_is_safe_to_repeat() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("images");
        std::fs::create_dir_all(root.join("ab")).unwrap();
        std::fs::write(root.join("ab/one.webp"), vec![0u8; 2048]).unwrap();

        clear(&root).unwrap();
        assert_eq!(size_on_disk(&root), 0);
        clear(&root).unwrap();
    }
}
