//! The Node's local catalog and authenticated state.
//!
//! This runs on the machine holding the games. It reports its catalog and holds
//! an authenticated outbound HTTPS poll for chunk work from the Coordinator.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::RwLock;

use crate::error::{MeshError, MeshResult};
use crate::identity::NodeIdentity;
use crate::MESH_CHUNK_BYTES;

/// Where the agent keeps what it must not regenerate.
///
/// The identity in particular: a node is known to the coordinator by its public
/// key, so losing it means enrolling again as a stranger and abandoning
/// everything the old registration knew about what this machine holds.
///
/// **camelCase on disk, and it matters.** This file is not private to the
/// agent: the server process beside it reads the same path, waits for the key
/// this writes, and registers with it so that both halves of a node are one
/// node. That server is TypeScript and reads `secretKey`. Serialised in Rust's
/// own casing, the two processes wrote and read different files through the
/// same filename — the agent enrolled and served, the server sat waiting for a
/// key it could not see, and the catalog was never reported. The aliases read
/// back a file written by a version that got this wrong.
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    /// Base64url of the 32 secret bytes.
    #[serde(alias = "secret_key")]
    pub secret_key: Option<String>,
    #[serde(alias = "node_id")]
    pub node_id: Option<String>,
    #[serde(alias = "node_token")]
    pub node_token: Option<String>,
    /// Where this node reports, once somebody has said.
    ///
    /// In the state file rather than only in the environment so a node can be
    /// pointed at its coordinator from the setup page it serves, by somebody
    /// who is not going to edit a compose file and restart a container to do
    /// it. The environment still wins when it is set, so an operator who
    /// prefers to declare it keeps declaring it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_url: Option<String>,

    /// The one-time enrolment code, until it is spent.
    ///
    /// Written here by the setup page and cleared by whichever process
    /// successfully registers, so it lives exactly as long as it is useful and
    /// leaves nothing behind on disk afterwards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enrolment_token: Option<String>,

    /// Last reason registration failed, for the node's local status page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_error: Option<String>,
}

/// One file of one game, as the coordinator describes it.
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogFile {
    pub id: String,
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(default)]
    pub chunks: Vec<CatalogChunk>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogChunk {
    pub index: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogGame {
    #[serde(rename = "gameId")]
    pub game_id: String,
    pub kind: String,
    /// Where this game sits under the library root.
    #[serde(rename = "relPath")]
    pub rel_path: String,
    #[serde(rename = "contentHash")]
    pub content_hash: Option<String>,
    pub files: Vec<CatalogFile>,
}

/// The first path segment and everything after it, if there is more than one.
///
/// Forward slashes only: the coordinator normalises to them, and a backslash in
/// a relative path is a legitimate part of a name on the machine that scanned
/// it rather than a separator here.
fn split_first_segment(rel_path: &str) -> Option<(&str, &str)> {
    let (first, rest) = rel_path.split_once('/')?;
    if first.is_empty() || rest.is_empty() {
        return None;
    }
    Some((first, rest))
}

/// Whether a root's own directory name is the library segment in a path.
///
/// The coordinator sanitises a library's name before putting it in a path —
/// slashes become dashes — so the comparison is made against the same shape
/// rather than against the raw directory name.
fn root_is_named(root: &Path, segment: &str) -> bool {
    root.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == segment)
}

/// What this node can currently serve, and where it lives on disk.
#[derive(Default)]
pub struct LibraryIndex {
    games: HashMap<String, IndexedGame>,
}

struct IndexedGame {
    content_hash: String,
    files: HashMap<String, IndexedFile>,
}

struct IndexedFile {
    absolute: PathBuf,
    size_bytes: u64,
    chunk_hashes: Vec<String>,
}

impl LibraryIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take a game into the index from whichever root actually holds it.
    ///
    /// A node can hold several libraries, and the coordinator knows a game by
    /// one relative path — so finding it means trying the roots rather than
    /// being told which one. Two candidates per root, because a node with more
    /// than one library reports paths prefixed with the library's name to keep
    /// two roots' `Hollow Knight` from colliding upstream: the path as sent,
    /// and the path with that leading segment taken off.
    ///
    /// Stops at the first root whose files are all present, so a game held
    /// twice is served from whichever root comes first rather than being
    /// indexed twice.
    pub fn offer_from_roots(&mut self, roots: &[PathBuf], game: &CatalogGame) -> bool {
        for root in roots {
            if self.offer(root, game) {
                return true;
            }

            // `3TB/Hollow Knight` under a root already named `3TB`.
            let Some((first, rest)) = split_first_segment(&game.rel_path) else {
                continue;
            };
            if !root_is_named(root, first) {
                continue;
            }

            let unprefixed = CatalogGame {
                rel_path: rest.to_string(),
                ..game.clone()
            };
            if self.offer(root, &unprefixed) {
                return true;
            }
        }

        false
    }

    /// Take a game into the index, if this machine actually has its files.
    ///
    /// Presence and size are checked here; contents are not. Hashing a whole
    /// library at startup would delay serving by hours, and every chunk is
    /// hashed on the way out anyway — so a file that has rotted is caught the
    /// first time somebody asks for the affected piece, and only that piece.
    pub fn offer(&mut self, library_root: &Path, game: &CatalogGame) -> bool {
        let Some(content_hash) = game.content_hash.clone() else {
            return false;
        };

        let game_root = library_root.join(&game.rel_path);
        let mut files = HashMap::new();

        for file in &game.files {
            // An archive game is one file: the game's own path is the file.
            let absolute = if game.kind == "archive" {
                game_root.clone()
            } else {
                game_root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR))
            };

            let Ok(meta) = std::fs::metadata(&absolute) else {
                return false;
            };
            if !meta.is_file() || meta.len() != file.size_bytes {
                return false;
            }

            let mut chunk_hashes = vec![String::new(); file.chunks.len()];
            for chunk in &file.chunks {
                let Some(slot) = chunk_hashes.get_mut(chunk.index as usize) else {
                    return false;
                };
                *slot = chunk.sha256.clone();
            }
            if chunk_hashes.iter().any(String::is_empty) {
                return false;
            }

            files.insert(
                file.id.clone(),
                IndexedFile {
                    absolute,
                    size_bytes: file.size_bytes,
                    chunk_hashes,
                },
            );
        }

        // All or nothing. A partial copy would be announced as complete and
        // then refuse half the chunks anyone asked for.
        if files.len() != game.files.len() {
            return false;
        }

        self.games.insert(
            game.game_id.clone(),
            IndexedGame {
                content_hash,
                files,
            },
        );
        true
    }

    /// The fingerprint this index holds for a game, if it holds it at all.
    pub fn content_hash(&self, game_id: &str) -> Option<&str> {
        self.games
            .get(game_id)
            .map(|game| game.content_hash.as_str())
    }

    /// Move a game across from the previous index without re-checking it.
    ///
    /// Only ever called when the coordinator is still announcing the same
    /// fingerprint, which is the whole condition: a game whose content changed
    /// gets a new one, so a match means the copy this index verified is the
    /// copy still being asked for. Rebuilding it would mean re-fetching the
    /// file layout and re-stat-ing every file of every game on a timer, which
    /// on a real archive is thousands of syscalls a minute to learn nothing.
    pub fn carry_over(&mut self, previous: &mut LibraryIndex, game_id: &str) -> bool {
        match previous.games.remove(game_id) {
            Some(game) => {
                self.games.insert(game_id.to_string(), game);
                true
            }
            None => false,
        }
    }

    /// What to announce on the next heartbeat.
    pub fn announcements(&self) -> Vec<(String, String)> {
        self.games
            .iter()
            .map(|(id, game)| (id.clone(), game.content_hash.clone()))
            .collect()
    }

    pub fn len(&self) -> usize {
        self.games.len()
    }

    pub fn is_empty(&self) -> bool {
        self.games.is_empty()
    }
}

/// Serves chunks out of the library on disk.
pub struct LibraryChunks {
    index: Arc<RwLock<LibraryIndex>>,
}

#[async_trait::async_trait]
pub trait ChunkStore: Send + Sync {
    async fn read_chunk(&self, game_id: &str, file_id: &str, index: u64) -> Option<Vec<u8>>;
}

impl LibraryChunks {
    pub fn new(index: Arc<RwLock<LibraryIndex>>) -> Self {
        Self { index }
    }
}

#[async_trait::async_trait]
impl ChunkStore for LibraryChunks {
    async fn read_chunk(&self, game_id: &str, file_id: &str, index: u64) -> Option<Vec<u8>> {
        let (absolute, size_bytes, expected) = {
            let guard = self.index.read().await;
            let file = guard.games.get(game_id)?.files.get(file_id)?;
            let expected = file.chunk_hashes.get(index as usize)?.clone();
            (file.absolute.clone(), file.size_bytes, expected)
        };

        let bytes = read_chunk_at(&absolute, index, size_bytes).await?;

        // Checked here rather than trusted from the index. The library is a
        // directory on a disk that can rot, and a node that serves bytes it
        // advertised but no longer has is worse than one that admits it.
        let actual = hex::encode(Sha256::digest(&bytes));
        actual.eq_ignore_ascii_case(&expected).then_some(bytes)
    }
}

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

impl AgentState {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> MeshResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|err| MeshError::Protocol(format!("could not encode agent state: {err}")))?;
        std::fs::write(path, text)?;
        Ok(())
    }

    /// The identity this agent should use, generating one on first run.
    pub fn identity(&mut self) -> MeshResult<NodeIdentity> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

        if let Some(encoded) = &self.secret_key {
            if let Ok(raw) = URL_SAFE_NO_PAD.decode(encoded) {
                if let Ok(identity) = NodeIdentity::from_secret_bytes(&raw) {
                    return Ok(identity);
                }
            }
        }

        let identity = NodeIdentity::generate();
        self.secret_key = Some(URL_SAFE_NO_PAD.encode(identity.secret_bytes()));
        Ok(identity)
    }
}

/// How long the agent waits between failed registration attempts.
pub const RETRY_DELAY: Duration = Duration::from_secs(15);

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        path
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn game(files: Vec<CatalogFile>) -> CatalogGame {
        CatalogGame {
            game_id: "gam_1".into(),
            kind: "folder".into(),
            rel_path: "Demo Game".into(),
            content_hash: Some("a".repeat(64)),
            files,
        }
    }

    #[test]
    fn a_game_is_found_in_whichever_root_holds_it() {
        // Two libraries on one node, and the coordinator knows the game by one
        // relative path. Searching the roots is the only way to find it.
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let bytes = vec![4u8; 512];
        write_file(second.path(), "Demo Game/game.bin", &bytes);

        let mut index = LibraryIndex::new();
        let accepted = index.offer_from_roots(
            &[first.path().to_path_buf(), second.path().to_path_buf()],
            &game(vec![CatalogFile {
                id: "gfl_1".into(),
                path: "game.bin".into(),
                size_bytes: 512,
                chunks: vec![CatalogChunk {
                    index: 0,
                    sha256: sha(&bytes),
                }],
            }]),
        );

        assert!(accepted);
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn a_path_prefixed_with_its_library_name_still_resolves() {
        // A node with more than one root reports paths prefixed with the
        // library's name, so two roots' "Demo Game" do not collide upstream.
        // The prefix names the root, so it is not part of the path on disk.
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("3TB");
        let bytes = vec![9u8; 128];
        write_file(&root, "Demo Game/game.bin", &bytes);

        let mut prefixed = game(vec![CatalogFile {
            id: "gfl_1".into(),
            path: "game.bin".into(),
            size_bytes: 128,
            chunks: vec![CatalogChunk {
                index: 0,
                sha256: sha(&bytes),
            }],
        }]);
        prefixed.rel_path = "3TB/Demo Game".into();

        let mut index = LibraryIndex::new();
        assert!(index.offer_from_roots(std::slice::from_ref(&root), &prefixed));
        assert_eq!(index.len(), 1);

        // The prefix is only stripped for the root it names. A root called
        // something else must not have its own files reached through it.
        let other = parent.path().join("E");
        std::fs::create_dir_all(&other).unwrap();
        let mut elsewhere = LibraryIndex::new();
        assert!(!elsewhere.offer_from_roots(&[other], &prefixed));
    }

    #[test]
    fn the_mounts_decide_when_no_roots_are_declared() {
        let base = tempfile::tempdir().unwrap();
        let single = base.path().join("library");
        let many = base.path().join("libraries");
        std::fs::create_dir_all(&single).unwrap();
        std::fs::create_dir_all(many.join("3TB")).unwrap();
        std::fs::create_dir_all(many.join("E")).unwrap();
        // A file under /libraries is not a library.
        std::fs::write(many.join("notes.txt"), b"x").unwrap();

        let found = crate::discover_library_roots(single.to_str().unwrap(), many.to_str().unwrap());

        assert_eq!(
            found,
            vec![single, many.join("3TB"), many.join("E")],
            "the single root first, then one per directory, in name order"
        );
    }

    #[test]
    fn a_declared_list_wins_over_the_mounts() {
        let roots = crate::library_roots(Some("/a, /b ;/c"));
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/a"),
                PathBuf::from("/b"),
                PathBuf::from("/c")
            ]
        );
    }

    #[test]
    fn a_game_whose_files_are_all_present_is_offered() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![7u8; 2_048];
        write_file(dir.path(), "Demo Game/game.bin", &bytes);

        let mut index = LibraryIndex::new();
        let accepted = index.offer(
            dir.path(),
            &game(vec![CatalogFile {
                id: "gfl_1".into(),
                path: "game.bin".into(),
                size_bytes: 2_048,
                chunks: vec![CatalogChunk {
                    index: 0,
                    sha256: sha(&bytes),
                }],
            }]),
        );

        assert!(accepted);
        assert_eq!(index.len(), 1);
        assert_eq!(index.announcements().len(), 1);
    }

    #[test]
    fn a_game_missing_one_file_is_not_offered_at_all() {
        // A partial copy announced as complete would refuse half the chunks
        // anyone asked for, after they had already been routed here.
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "Demo Game/present.bin", &[1u8; 16]);

        let mut index = LibraryIndex::new();
        let accepted = index.offer(
            dir.path(),
            &game(vec![
                CatalogFile {
                    id: "a".into(),
                    path: "present.bin".into(),
                    size_bytes: 16,
                    chunks: vec![CatalogChunk {
                        index: 0,
                        sha256: sha(&[1u8; 16]),
                    }],
                },
                CatalogFile {
                    id: "b".into(),
                    path: "absent.bin".into(),
                    size_bytes: 16,
                    chunks: vec![CatalogChunk {
                        index: 0,
                        sha256: "b".repeat(64),
                    }],
                },
            ]),
        );

        assert!(!accepted);
        assert!(index.is_empty());
    }

    #[test]
    fn a_file_of_the_wrong_size_is_refused_without_reading_it() {
        // Cheap, and catches a truncated or half-copied file before anyone is
        // sent here for it.
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "Demo Game/game.bin", &[3u8; 10]);

        let mut index = LibraryIndex::new();
        let accepted = index.offer(
            dir.path(),
            &game(vec![CatalogFile {
                id: "gfl_1".into(),
                path: "game.bin".into(),
                size_bytes: 9_999,
                chunks: vec![CatalogChunk {
                    index: 0,
                    sha256: "c".repeat(64),
                }],
            }]),
        );

        assert!(!accepted);
    }

    #[test]
    fn a_game_with_a_gap_in_its_chunk_list_is_refused() {
        // Chunk hashes are looked up by position. A gap would leave part of a
        // file unservable while everything looked fine.
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "Demo Game/game.bin", &[5u8; 32]);

        let mut index = LibraryIndex::new();
        let accepted = index.offer(
            dir.path(),
            &game(vec![CatalogFile {
                id: "gfl_1".into(),
                path: "game.bin".into(),
                size_bytes: 32,
                // Index 1 with no index 0.
                chunks: vec![CatalogChunk {
                    index: 1,
                    sha256: "d".repeat(64),
                }],
            }]),
        );

        assert!(!accepted);
    }

    #[test]
    fn a_game_without_a_fingerprint_cannot_be_announced() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "Demo Game/game.bin", &[1u8; 8]);

        let mut unnamed = game(vec![CatalogFile {
            id: "gfl_1".into(),
            path: "game.bin".into(),
            size_bytes: 8,
            chunks: vec![CatalogChunk {
                index: 0,
                sha256: sha(&[1u8; 8]),
            }],
        }]);
        unnamed.content_hash = None;

        let mut index = LibraryIndex::new();
        assert!(!index.offer(dir.path(), &unnamed));
    }

    #[tokio::test]
    async fn a_chunk_that_no_longer_matches_is_not_served() {
        // The index says this file is fine; the disk disagrees. Catching it
        // here costs one refused chunk instead of a corrupt install.
        let dir = tempfile::tempdir().unwrap();
        let original = vec![7u8; 1_024];
        write_file(dir.path(), "Demo Game/game.bin", &original);

        let mut index = LibraryIndex::new();
        index.offer(
            dir.path(),
            &game(vec![CatalogFile {
                id: "gfl_1".into(),
                path: "game.bin".into(),
                size_bytes: 1_024,
                chunks: vec![CatalogChunk {
                    index: 0,
                    sha256: sha(&original),
                }],
            }]),
        );

        let store = LibraryChunks::new(Arc::new(RwLock::new(index)));
        assert!(store.read_chunk("gam_1", "gfl_1", 0).await.is_some());

        write_file(dir.path(), "Demo Game/game.bin", &vec![8u8; 1_024]);
        assert!(store.read_chunk("gam_1", "gfl_1", 0).await.is_none());
    }

    #[tokio::test]
    async fn an_archive_game_serves_from_the_games_own_path() {
        // An archive game is a single file, and its "relative path" is the
        // game itself rather than something beneath it.
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![4u8; 512];
        write_file(dir.path(), "Some Game.zip", &bytes);

        let mut index = LibraryIndex::new();
        let accepted = index.offer(
            dir.path(),
            &CatalogGame {
                game_id: "gam_1".into(),
                kind: "archive".into(),
                rel_path: "Some Game.zip".into(),
                content_hash: Some("a".repeat(64)),
                files: vec![CatalogFile {
                    id: "gfl_1".into(),
                    path: "Some Game.zip".into(),
                    size_bytes: 512,
                    chunks: vec![CatalogChunk {
                        index: 0,
                        sha256: sha(&bytes),
                    }],
                }],
            },
        );

        assert!(accepted);
        let store = LibraryChunks::new(Arc::new(RwLock::new(index)));
        assert_eq!(store.read_chunk("gam_1", "gfl_1", 0).await, Some(bytes));
    }

    #[test]
    fn an_identity_is_generated_once_and_then_reloaded() {
        // A node is known by its key. Regenerating one on restart would enrol
        // this machine as a stranger and abandon everything already registered.
        let mut state = AgentState::default();
        let first = state.identity().unwrap();
        let second = state.identity().unwrap();

        assert_eq!(first.public_key(), second.public_key());
    }

    #[test]
    fn agent_state_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");

        let mut state = AgentState::default();
        let identity = state.identity().unwrap();
        state.node_id = Some("nod_1".into());
        state.save(&path).unwrap();

        let mut reloaded = AgentState::load(&path);
        assert_eq!(reloaded.node_id.as_deref(), Some("nod_1"));
        assert_eq!(
            reloaded.identity().unwrap().public_key(),
            identity.public_key()
        );
    }

    #[test]
    fn agent_state_is_written_in_the_casing_the_server_reads() {
        // The server process beside this one is TypeScript and looks for
        // `secretKey`. Asserted on the bytes rather than on a round trip
        // through this struct, because a round trip passes whatever casing
        // both ends happen to agree on and this is about the end that is not
        // here.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");

        let mut state = AgentState::default();
        state.identity().unwrap();
        state.node_id = Some("nod_1".into());
        state.node_token = Some("tok_1".into());
        state.save(&path).unwrap();

        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        for key in ["secretKey", "nodeId", "nodeToken"] {
            assert!(
                written.get(key).is_some(),
                "{key} is missing from {written}"
            );
        }
        for key in ["secret_key", "node_id", "node_token", "coordinator_key"] {
            assert!(written.get(key).is_none(), "{key} should not be written");
        }
    }

    #[test]
    fn setup_written_by_the_server_is_read_by_the_agent() {
        // The setup page runs in the other process and writes this file; the
        // agent is what actually registers. If these two disagreed about the
        // field names, filling the form in would appear to do nothing at all.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(
            &path,
            r#"{"coordinatorUrl":"https://games.example.com","enrolmentToken":"abc123"}"#,
        )
        .unwrap();

        let state = AgentState::load(&path);
        assert_eq!(
            state.coordinator_url.as_deref(),
            Some("https://games.example.com")
        );
        assert_eq!(state.enrolment_token.as_deref(), Some("abc123"));
    }

    #[test]
    fn a_spent_enrolment_code_is_not_left_on_disk() {
        // Cleared rather than kept: it is of no further use, and a restart that
        // still saw one would look like a node with something left to enrol.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");

        let mut state = AgentState {
            enrolment_token: Some("spend-me".into()),
            coordinator_url: Some("https://games.example.com".into()),
            ..AgentState::default()
        };
        state.identity().unwrap();
        state.enrolment_token = None;
        state.save(&path).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("enrolmentToken"), "left behind in {raw}");
        assert!(raw.contains("coordinatorUrl"), "url should persist: {raw}");
    }

    #[test]
    fn a_state_file_from_before_the_casing_was_fixed_still_loads() {
        // Upgrading must not look like losing the identity: a node that
        // re-enrols is a stranger to the coordinator, and everything it was
        // known to hold is abandoned.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(
            &path,
            r#"{"secret_key":"c2VjcmV0","node_id":"nod_old","node_token":"tok_old"}"#,
        )
        .unwrap();

        let state = AgentState::load(&path);
        assert_eq!(state.node_id.as_deref(), Some("nod_old"));
        assert_eq!(state.node_token.as_deref(), Some("tok_old"));
        assert_eq!(state.secret_key.as_deref(), Some("c2VjcmV0"));
    }

    #[test]
    fn missing_state_is_a_first_run_rather_than_a_failure() {
        let state = AgentState::load(Path::new("/nonexistent/state.json"));
        assert!(state.node_id.is_none());
    }
}
