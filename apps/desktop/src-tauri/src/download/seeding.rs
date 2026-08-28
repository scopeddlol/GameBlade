//! Letting a client serve chunks it already holds.
//!
//! This is the stage where the mesh stops being "the operator's machines" and
//! becomes players distributing each other's downloads. That is a genuinely
//! different thing, so it is gated twice and defaults to off at both: the
//! operator has to turn seeding on for the server, and each player has to turn
//! it on for themselves. Neither switch implies the other, and neither is ever
//! flipped on someone's behalf.
//!
//! What a seeding client serves is narrow on purpose. Only games it has fully
//! installed, only chunks that still hash to what the manifest said, and only
//! to accounts carrying a coordinator-signed grant. It never serves its own
//! owner — that is the copy they already have — and it stops the moment either
//! switch goes off or the account signs out.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gameblade_mesh::{ChunkStore, MESH_CHUNK_BYTES};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::RwLock;

/// One installed file this client can serve pieces of.
#[derive(Debug, Clone)]
pub struct SeedableFile {
    pub file_id: String,
    /// Path relative to the game root, as the server records it.
    ///
    /// Kept alongside the absolute path because the fingerprint is computed
    /// over these, and it has to match the server's byte for byte.
    pub rel_path: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    /// The whole-file hash, for the fingerprint.
    pub whole_sha256: Option<String>,
    /// Per-chunk hashes from the manifest this copy was installed against.
    pub chunk_hashes: Vec<String>,
}

/// What this client is currently offering, by game.
#[derive(Default)]
pub struct SeedIndex {
    games: HashMap<String, Vec<SeedableFile>>,
}

impl SeedIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Offer a game's installed files.
    ///
    /// Called after an install finishes and after a start-up scan. Replacing
    /// wholesale rather than merging: a game that was reinstalled or partly
    /// deleted should not keep offering pieces from the copy before it.
    pub fn offer(&mut self, game_id: &str, files: Vec<SeedableFile>) {
        self.games.insert(game_id.to_string(), files);
    }

    pub fn withdraw(&mut self, game_id: &str) {
        self.games.remove(game_id);
    }

    /// Stop offering everything — sign-out, or either switch going off.
    pub fn clear(&mut self) {
        self.games.clear();
    }

    pub fn game_ids(&self) -> Vec<String> {
        self.games.keys().cloned().collect()
    }

    /// The fingerprint to announce for a game.
    ///
    /// Must match what the server computes over the same files, byte for byte,
    /// or the coordinator drops the announcement — which is the intended
    /// behaviour when a copy has drifted, and a silent failure to seed anything
    /// when the two implementations merely disagree. Hence the NUL delimiter
    /// and the sort: both are the server's, and both matter.
    pub fn content_hash(&self, game_id: &str) -> Option<String> {
        let files = self.games.get(game_id)?;
        if files.is_empty() {
            return None;
        }

        let mut ordered: Vec<&SeedableFile> = files.iter().collect();
        ordered.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

        let mut digest = Sha256::new();
        for file in ordered {
            let whole = file.whole_sha256.as_ref()?;
            digest.update(file.rel_path.as_bytes());
            digest.update([0]);
            digest.update(whole.as_bytes());
            digest.update([0]);
        }

        Some(hex::encode(digest.finalize()))
    }

    fn find(&self, game_id: &str, file_id: &str) -> Option<&SeedableFile> {
        self.games
            .get(game_id)?
            .iter()
            .find(|file| file.file_id == file_id)
    }
}

/// Serves chunks out of what this client has installed.
pub struct InstalledChunks {
    index: Arc<RwLock<SeedIndex>>,
}

impl InstalledChunks {
    pub fn new(index: Arc<RwLock<SeedIndex>>) -> Self {
        Self { index }
    }
}

#[async_trait::async_trait]
impl ChunkStore for InstalledChunks {
    /// Read one chunk off disk, and only hand it back if it is still right.
    ///
    /// The hash check is what makes seeding safe to leave on. A player's install
    /// is a directory they can edit, a mod can rewrite, and a filesystem can
    /// corrupt — so "I downloaded this file once" is not a claim that the bytes
    /// on disk are still the archive's. Checking here means the worst a
    /// tampered install can do is stop being a useful source.
    async fn read_chunk(&self, game_id: &str, file_id: &str, index: u64) -> Option<Vec<u8>> {
        let (path, size_bytes, expected) = {
            let guard = self.index.read().await;
            let file = guard.find(game_id, file_id)?;
            let expected = file.chunk_hashes.get(index as usize)?.clone();
            (file.path.clone(), file.size_bytes, expected)
        };

        let bytes = read_chunk_at(&path, index, size_bytes).await?;

        let actual = hex::encode(Sha256::digest(&bytes));
        actual.eq_ignore_ascii_case(&expected).then_some(bytes)
    }
}

/// The bytes of one chunk of a file on disk.
async fn read_chunk_at(path: &Path, index: u64, size_bytes: u64) -> Option<Vec<u8>> {
    let start = index.checked_mul(MESH_CHUNK_BYTES)?;
    if start >= size_bytes {
        return None;
    }

    // Only the last chunk of a file is ever short.
    let length = MESH_CHUNK_BYTES.min(size_bytes - start);

    let mut file = tokio::fs::File::open(path).await.ok()?;
    file.seek(std::io::SeekFrom::Start(start)).await.ok()?;

    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer).await.ok()?;
    Some(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        path
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    async fn store_with(files: Vec<SeedableFile>) -> InstalledChunks {
        let mut index = SeedIndex::new();
        index.offer("gam_1", files);
        InstalledChunks::new(Arc::new(RwLock::new(index)))
    }

    #[tokio::test]
    async fn a_chunk_of_an_offered_file_is_served() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![7u8; 4_096];
        let path = write_file(dir.path(), "game.bin", &bytes);

        let store = store_with(vec![SeedableFile {
            file_id: "gfl_1".into(),
            rel_path: "game.bin".into(),
            path,
            size_bytes: 4_096,
            whole_sha256: Some(sha(&bytes)),
            chunk_hashes: vec![sha(&bytes)],
        }])
        .await;

        assert_eq!(store.read_chunk("gam_1", "gfl_1", 0).await, Some(bytes));
    }

    #[tokio::test]
    async fn a_file_edited_since_install_stops_being_served() {
        // This is what makes seeding safe to leave on. An install is a
        // directory the player can edit and a mod can rewrite; having
        // downloaded it once is not a promise about what is there now.
        let dir = tempfile::tempdir().unwrap();
        let original = vec![1u8; 2_048];
        let path = write_file(dir.path(), "game.bin", &original);

        let store = store_with(vec![SeedableFile {
            file_id: "gfl_1".into(),
            rel_path: "game.bin".into(),
            path: path.clone(),
            size_bytes: 2_048,
            whole_sha256: Some(sha(&original)),
            chunk_hashes: vec![sha(&original)],
        }])
        .await;
        assert!(store.read_chunk("gam_1", "gfl_1", 0).await.is_some());

        write_file(dir.path(), "game.bin", &vec![2u8; 2_048]);
        assert!(store.read_chunk("gam_1", "gfl_1", 0).await.is_none());
    }

    #[tokio::test]
    async fn a_game_that_is_not_offered_is_not_served() {
        let store = store_with(vec![]).await;
        assert!(store.read_chunk("gam_other", "gfl_1", 0).await.is_none());
    }

    #[tokio::test]
    async fn a_chunk_past_the_end_of_the_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![3u8; 512];
        let path = write_file(dir.path(), "game.bin", &bytes);

        let store = store_with(vec![SeedableFile {
            file_id: "gfl_1".into(),
            rel_path: "game.bin".into(),
            path,
            size_bytes: 512,
            whole_sha256: Some(sha(&bytes)),
            chunk_hashes: vec![sha(&bytes)],
        }])
        .await;

        assert!(store.read_chunk("gam_1", "gfl_1", 9).await.is_none());
    }

    #[tokio::test]
    async fn a_missing_file_is_refused_rather_than_panicking() {
        // A player can delete a game without telling anyone.
        let store = store_with(vec![SeedableFile {
            file_id: "gfl_1".into(),
            rel_path: "game.bin".into(),
            path: PathBuf::from("/nonexistent/game.bin"),
            size_bytes: 1_024,
            whole_sha256: None,
            chunk_hashes: vec!["a".repeat(64)],
        }])
        .await;

        assert!(store.read_chunk("gam_1", "gfl_1", 0).await.is_none());
    }

    #[tokio::test]
    async fn clearing_the_index_stops_everything_at_once() {
        // Sign-out and either switch going off all land here, and none of them
        // can afford to leave a game still being offered.
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![5u8; 128];
        let path = write_file(dir.path(), "game.bin", &bytes);

        let index = Arc::new(RwLock::new(SeedIndex::new()));
        index.write().await.offer(
            "gam_1",
            vec![SeedableFile {
                file_id: "gfl_1".into(),
                rel_path: "game.bin".into(),
                path,
                size_bytes: 128,
                whole_sha256: Some(sha(&bytes)),
                chunk_hashes: vec![sha(&bytes)],
            }],
        );

        let store = InstalledChunks::new(Arc::clone(&index));
        assert!(store.read_chunk("gam_1", "gfl_1", 0).await.is_some());

        index.write().await.clear();
        assert!(store.read_chunk("gam_1", "gfl_1", 0).await.is_none());
        assert!(index.read().await.game_ids().is_empty());
    }

    #[tokio::test]
    async fn reoffering_a_game_replaces_the_previous_copy() {
        // A reinstalled or partly deleted game must not keep offering pieces
        // of the copy from before.
        let mut index = SeedIndex::new();
        index.offer(
            "gam_1",
            vec![SeedableFile {
                file_id: "old".into(),
                rel_path: "old.bin".into(),
                path: PathBuf::from("/old"),
                size_bytes: 1,
                whole_sha256: None,
                chunk_hashes: vec![],
            }],
        );
        index.offer(
            "gam_1",
            vec![SeedableFile {
                file_id: "new".into(),
                rel_path: "new.bin".into(),
                path: PathBuf::from("/new"),
                size_bytes: 1,
                whole_sha256: None,
                chunk_hashes: vec![],
            }],
        );

        assert!(index.find("gam_1", "old").is_none());
        assert!(index.find("gam_1", "new").is_some());
    }

    #[test]
    fn the_fingerprint_matches_what_the_server_computes() {
        // The server hashes `relPath NUL sha256 NUL` per file, sorted by
        // relative path. If these two ever disagree the coordinator silently
        // drops every announcement, and a peer that appears to be working
        // seeds nothing at all — so the algorithm is pinned here rather than
        // left to be discovered.
        let mut index = SeedIndex::new();
        index.offer(
            "gam_1",
            vec![
                SeedableFile {
                    file_id: "b".into(),
                    rel_path: "b.bin".into(),
                    path: PathBuf::from("/b"),
                    size_bytes: 1,
                    whole_sha256: Some("22".repeat(32)),
                    chunk_hashes: vec![],
                },
                SeedableFile {
                    file_id: "a".into(),
                    rel_path: "a.bin".into(),
                    path: PathBuf::from("/a"),
                    size_bytes: 1,
                    whole_sha256: Some("11".repeat(32)),
                    chunk_hashes: vec![],
                },
            ],
        );

        let mut expected = Sha256::new();
        for (rel, hash) in [("a.bin", "11".repeat(32)), ("b.bin", "22".repeat(32))] {
            expected.update(rel.as_bytes());
            expected.update([0]);
            expected.update(hash.as_bytes());
            expected.update([0]);
        }

        assert_eq!(
            index.content_hash("gam_1"),
            Some(hex::encode(expected.finalize()))
        );
    }

    #[test]
    fn a_file_without_a_whole_hash_makes_the_fingerprint_unavailable() {
        // Rather than a fingerprint over a subset, which would collide with a
        // genuinely different copy.
        let mut index = SeedIndex::new();
        index.offer(
            "gam_1",
            vec![SeedableFile {
                file_id: "a".into(),
                rel_path: "a.bin".into(),
                path: PathBuf::from("/a"),
                size_bytes: 1,
                whole_sha256: None,
                chunk_hashes: vec![],
            }],
        );

        assert!(index.content_hash("gam_1").is_none());
    }

    #[tokio::test]
    async fn a_short_final_chunk_reads_at_its_real_length() {
        // Reading a full chunk's worth off the end would fail the read and
        // silently stop the last piece of every game from being seeded.
        let dir = tempfile::tempdir().unwrap();
        let size = MESH_CHUNK_BYTES + 100;
        let bytes = vec![4u8; size as usize];
        let path = write_file(dir.path(), "big.bin", &bytes);

        let tail = &bytes[MESH_CHUNK_BYTES as usize..];
        let store = store_with(vec![SeedableFile {
            file_id: "gfl_1".into(),
            rel_path: "big.bin".into(),
            path,
            size_bytes: size,
            whole_sha256: Some(sha(&bytes)),
            chunk_hashes: vec![sha(&bytes[..MESH_CHUNK_BYTES as usize]), sha(tail)],
        }])
        .await;

        let served = store.read_chunk("gam_1", "gfl_1", 1).await.unwrap();
        assert_eq!(served.len(), 100);
    }
}
