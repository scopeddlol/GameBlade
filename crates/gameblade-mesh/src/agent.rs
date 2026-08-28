//! The node agent: enrol, serve, heartbeat, punch, report.
//!
//! This is what runs on the machine holding the games. It talks to the
//! coordinator over ordinary HTTPS — through the same reverse proxy everything
//! else uses — and serves game data over QUIC directly to clients, which is the
//! entire point: the coordination is small enough to go through the tunnel, and
//! the bytes are not.
//!
//! It has four loops and each one exists for a reason the others cannot cover.
//!
//! * **Accept** — clients connecting, one chunk per stream.
//! * **Heartbeat** — staying listed, and saying what this node currently holds.
//! * **Rendezvous** — a held-open request that the coordinator answers the
//!   instant a client asks for this node. That immediacy is the whole design:
//!   hole punching only works if both ends send at once, and a node polling on
//!   a timer would always be too late.
//! * **Report** — what was actually served, so an account's transfer allowance
//!   still means something when the bytes never crossed the server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::RwLock;

use crate::error::{MeshError, MeshResult};
use crate::identity::{coordinator_key_from_spki, NodeIdentity};
use crate::node::{ChunkStore, NodeServer};
use crate::transport::MeshEndpoint;
use crate::MESH_CHUNK_BYTES;

/// Where the agent keeps what it must not regenerate.
///
/// The identity in particular: a node is known to the coordinator by its public
/// key, so losing it means enrolling again as a stranger and abandoning
/// everything the old registration knew about what this machine holds.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct AgentState {
    /// Base64url of the 32 secret bytes.
    pub secret_key: Option<String>,
    pub node_id: Option<String>,
    pub node_token: Option<String>,
    pub coordinator_key: Option<String>,
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

/// A punch instruction from the coordinator.
#[derive(Debug, Clone, Deserialize)]
pub struct PunchRequest {
    pub address: String,
    pub port: u16,
    /// Present when the client gave up on a direct path and wants the relay.
    ///
    /// Arrives on the same channel as a punch because it answers the same
    /// question — someone is trying to reach you, here is how — and the node's
    /// response is simply different: dial the relay instead of punching.
    #[serde(default)]
    pub relay: Option<RelayInstruction>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelayInstruction {
    pub address: String,
    pub port: u16,
    /// This node's half of the pairing.
    pub ticket: String,
}

#[derive(Debug, Deserialize)]
pub struct RendezvousReply {
    #[serde(default)]
    pub punches: Vec<PunchRequest>,
}

/// Turn a coordinator-supplied address into something dialable.
///
/// IPv6 has to be bracketed before it parses, and getting this wrong silently
/// discards every IPv6 candidate — the ones most likely to work, since two
/// hosts with IPv6 need no traversal at all.
pub fn socket_address(address: &str, port: u16) -> Option<std::net::SocketAddr> {
    let literal = if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    };
    literal.parse().ok()
}

/// Everything the agent needs to run.
pub struct AgentConfig {
    pub server_url: String,
    pub library_root: PathBuf,
    pub port: u16,
    pub state_path: PathBuf,
    pub enrolment_token: Option<String>,
    pub stun_servers: Vec<String>,
}

pub struct Agent {
    pub identity: NodeIdentity,
    pub node_id: String,
    pub node_token: String,
    pub coordinator_key: crate::identity::PublicKey,
    pub endpoint: MeshEndpoint,
    pub index: Arc<RwLock<LibraryIndex>>,
    pub server: Arc<NodeServer<LibraryChunks>>,
    /// How often to heartbeat, as the coordinator asked.
    ///
    /// Taken from the registration reply rather than fixed here, so the
    /// interval can be changed centrally without redeploying every agent.
    pub heartbeat: Duration,
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

    /// The coordinator key, decoded.
    pub fn coordinator(&self) -> Option<crate::identity::PublicKey> {
        self.coordinator_key
            .as_deref()
            .and_then(|key| coordinator_key_from_spki(key).ok())
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
    fn missing_state_is_a_first_run_rather_than_a_failure() {
        let state = AgentState::load(Path::new("/nonexistent/state.json"));
        assert!(state.node_id.is_none());
    }

    #[test]
    fn ipv6_punch_targets_are_bracketed_before_parsing() {
        assert!(socket_address("2001:db8::1", 47820).is_some());
        assert!(socket_address("203.0.113.9", 47820).unwrap().is_ipv4());
        assert!(socket_address("nonsense", 47820).is_none());
    }
}
