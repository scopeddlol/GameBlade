use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use tokio::sync::RwLock;

/// What the client knows about a game it has put on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledGame {
    pub game_id: String,
    pub title: String,
    pub install_path: PathBuf,
    /// Resolved at install time; the UI shows it and the launcher runs it.
    pub executable: Option<PathBuf>,
    pub size_bytes: u64,
    pub installed_at: String,
    /// Digest of the cloud save last synced, so a conflict can be detected.
    pub save_base_sha256: Option<String>,
}

/// The on-disk registry of installed games.
///
/// Kept as one JSON file rather than scanning the install directory: a scan
/// cannot tell an interrupted install from a finished one, and it would lose
/// the sync state that makes save conflicts detectable.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Registry {
    games: HashMap<String, InstalledGame>,
}

pub struct InstallManager {
    registry_path: PathBuf,
    registry: RwLock<Registry>,
}

impl InstallManager {
    pub fn load(app_data: &Path) -> Self {
        let registry_path = app_data.join("installed.json");
        let registry = std::fs::read_to_string(&registry_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Registry>(&raw).ok())
            .unwrap_or_default();

        Self {
            registry_path,
            registry: RwLock::new(registry),
        }
    }

    pub async fn list(&self) -> Vec<InstalledGame> {
        let registry = self.registry.read().await;
        let mut games: Vec<_> = registry.games.values().cloned().collect();
        // Cached rather than `sort_by_key`: the key allocates a String, and
        // `sort_by_key` would rebuild it on every comparison instead of once
        // per game.
        games.sort_by_cached_key(|game| game.title.to_lowercase());
        games
    }

    pub async fn get(&self, game_id: &str) -> Option<InstalledGame> {
        self.registry.read().await.games.get(game_id).cloned()
    }

    pub async fn record(&self, game: InstalledGame) -> AppResult<()> {
        {
            let mut registry = self.registry.write().await;
            registry.games.insert(game.game_id.clone(), game);
        }
        self.persist().await
    }

    /// Stores the digest of the save last synced for a game, which is what
    /// later lets the client tell "changed locally" from "changed remotely".
    pub async fn set_save_base(&self, game_id: &str, sha256: Option<String>) -> AppResult<()> {
        {
            let mut registry = self.registry.write().await;
            if let Some(entry) = registry.games.get_mut(game_id) {
                entry.save_base_sha256 = sha256;
            }
        }
        self.persist().await
    }

    /// Removes the files and forgets the entry. Cloud saves are left alone —
    /// uninstalling a game should never destroy the only copy of a save.
    pub async fn uninstall(&self, game_id: &str) -> AppResult<()> {
        let entry = {
            let mut registry = self.registry.write().await;
            registry.games.remove(game_id)
        };

        if let Some(entry) = entry {
            if entry.install_path.exists() {
                tokio::fs::remove_dir_all(&entry.install_path).await?;
            }
        }
        self.persist().await
    }

    /// Forgets an entry without touching the files.
    ///
    /// This is what unlinking a folder the user already had must do. Sharing
    /// `uninstall`'s code path would delete a directory GameBlade never
    /// created — the worst possible outcome of clicking the wrong menu item.
    pub async fn forget(&self, game_id: &str) -> AppResult<()> {
        {
            let mut registry = self.registry.write().await;
            registry.games.remove(game_id);
        }
        self.persist().await
    }

    /// Drops entries whose directory has been deleted outside the app, so the
    /// Library does not offer to launch something that is no longer there.
    pub async fn prune_missing(&self) -> AppResult<Vec<String>> {
        let removed: Vec<String> = {
            let mut registry = self.registry.write().await;
            let gone: Vec<String> = registry
                .games
                .iter()
                .filter(|(_, game)| !game.install_path.exists())
                .map(|(id, _)| id.clone())
                .collect();
            for id in &gone {
                registry.games.remove(id);
            }
            gone
        };

        if !removed.is_empty() {
            self.persist().await?;
        }
        Ok(removed)
    }

    async fn persist(&self) -> AppResult<()> {
        let registry = self.registry.read().await;
        let payload = serde_json::to_string_pretty(&*registry)?;
        if let Some(parent) = self.registry_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&self.registry_path, payload).await?;
        Ok(())
    }
}

/// Names that are never a game's entry point, even when they are the only .exe
/// in the folder. Launching one of these instead of the game is worse than
/// admitting we could not work it out.
const NON_GAME_EXECUTABLES: &[&str] = &[
    "unins",
    "uninstall",
    "setup",
    "install",
    "vcredist",
    "dxsetup",
    "dotnetfx",
    "directx",
    "crashreport",
    "crashhandler",
    "launcher_config",
    "config",
    "settings",
    "readme",
];

/// Picks the executable to launch from an installed folder.
///
/// The heuristic prefers, in order: an .exe whose name resembles the game's
/// title, then the largest .exe in the root, then the largest anywhere. Size is
/// a surprisingly good signal — the game binary is almost always far larger
/// than the helpers shipped beside it.
pub fn detect_executable(root: &Path, title: &str) -> Option<PathBuf> {
    let mut candidates: Vec<(PathBuf, u64, usize)> = Vec::new();

    for entry in walkdir::WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_executable = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
        if !is_executable {
            continue;
        }

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_lowercase();

        if NON_GAME_EXECUTABLES
            .iter()
            .any(|blocked| stem.contains(blocked))
        {
            continue;
        }

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        candidates.push((path.to_path_buf(), size, entry.depth()));
    }

    if candidates.is_empty() {
        return None;
    }

    let normalized_title = normalize(title);
    if let Some((path, _, _)) = candidates.iter().find(|(path, _, _)| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(|stem| normalize(stem) == normalized_title)
            .unwrap_or(false)
    }) {
        return Some(path.clone());
    }

    // Shallower wins ties: a game's launcher sits at the root far more often
    // than three folders down.
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
    candidates.first().map(|(path, _, _)| path.clone())
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

/// Extracts a downloaded .zip into `destination`.
///
/// Entry paths from an archive are attacker-controlled, so each one is rebuilt
/// from its normal components only. An entry containing `..` or an absolute
/// path would otherwise write outside the install folder — the "zip slip" bug.
pub fn extract_zip(archive: &Path, destination: &Path) -> AppResult<u64> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|err| AppError::Other(format!("Could not read the archive: {err}")))?;

    let mut written = 0u64;

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|err| AppError::Other(format!("Could not read an archive entry: {err}")))?;

        let Some(relative) = entry
            .enclosed_name()
            .map(|name| safe_join(destination, &name))
        else {
            continue;
        };
        let Some(target) = relative else { continue };

        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut out = std::fs::File::create(&target)?;
        written += std::io::copy(&mut entry, &mut out)?;
    }

    Ok(written)
}

/// Joins an archive-supplied path onto a root, rejecting anything that would
/// escape it. Returns `None` for an entry that should be skipped entirely.
fn safe_join(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let mut result = root.to_path_buf();

    for component in candidate.components() {
        match component {
            Component::Normal(part) => result.push(part),
            // Everything else — `..`, a drive prefix, a leading `/` — is either
            // meaningless inside an archive or an escape attempt.
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    if result == root {
        return None;
    }
    Some(result)
}

/// A folder on disk that looks like it might hold a game.
///
/// Produced by scanning somewhere the user points at, before anything is
/// matched against the catalog — the folder name is all the client knows at
/// this stage, and the server does the matching.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCandidate {
    pub path: PathBuf,
    /// Folder name as it appears on disk; what gets matched against titles.
    pub name: String,
    pub size_bytes: u64,
    /// Best guess at the entry point, so the user can see it before linking.
    pub executable: Option<PathBuf>,
    pub executable_count: usize,
}

/// Folder names that are never a game and only add noise to the import list.
const SKIPPED_FOLDERS: &[&str] = &[
    "$recycle.bin",
    "system volume information",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "node_modules",
    ".git",
];

/// Looks one level inside each root for folders that contain a Windows
/// executable.
///
/// Only immediate children are treated as games: a library folder holds one
/// directory per title, and recursing further would offer every `bin/` and
/// `redist/` subfolder as a separate candidate. A root that is itself a single
/// game is still handled, because a folder with executables directly inside it
/// is offered as a candidate in its own right.
pub fn scan_for_games(roots: &[PathBuf]) -> Vec<InstallCandidate> {
    let mut found: Vec<InstallCandidate> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    for root in roots {
        if !root.is_dir() {
            continue;
        }

        // The root itself counts when executables sit directly inside it.
        if let Some(candidate) = inspect_folder(root) {
            if seen.insert(candidate.path.clone()) {
                found.push(candidate);
            }
        }

        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };

        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with('.') || SKIPPED_FOLDERS.contains(&name.as_str()) {
                continue;
            }
            if let Some(candidate) = inspect_folder(&path) {
                if seen.insert(candidate.path.clone()) {
                    found.push(candidate);
                }
            }
        }
    }

    found.sort_by_cached_key(|candidate| candidate.name.to_lowercase());
    found
}

/// Describes one folder, or `None` when it holds no executable at all.
fn inspect_folder(path: &Path) -> Option<InstallCandidate> {
    let name = path.file_name()?.to_string_lossy().to_string();

    let executable_count = walkdir::WalkDir::new(path)
        .max_depth(3)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
        })
        .count();

    // No executable anywhere means it is not an installed Windows game, and
    // offering it would just make the import list something to wade through.
    if executable_count == 0 {
        return None;
    }

    Some(InstallCandidate {
        executable: detect_executable(path, &name),
        size_bytes: directory_size(path),
        name,
        path: path.to_path_buf(),
        executable_count,
    })
}

/// Total bytes occupied by an install, for the Library's storage readout.
pub fn directory_size(root: &Path) -> u64 {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_keeps_ordinary_paths() {
        let root = Path::new("/games/demo");
        let joined = safe_join(root, Path::new("bin/game.exe")).expect("should join");
        assert_eq!(joined, root.join("bin").join("game.exe"));
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = Path::new("/games/demo");
        assert!(safe_join(root, Path::new("../../etc/passwd")).is_none());
        assert!(safe_join(root, Path::new("/etc/passwd")).is_none());
    }

    #[test]
    fn safe_join_rejects_an_empty_result() {
        assert!(safe_join(Path::new("/games/demo"), Path::new("./")).is_none());
    }

    #[test]
    fn scanning_offers_folders_with_an_executable_and_skips_the_rest() {
        let root = std::env::temp_dir().join(format!("gameblade-scan-{}", std::process::id()));
        let game = root.join("Cave Story");
        let docs = root.join("Notes");
        std::fs::create_dir_all(game.join("bin")).unwrap();
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(game.join("bin").join("game.exe"), b"MZ").unwrap();
        std::fs::write(docs.join("readme.txt"), b"hello").unwrap();

        let found = scan_for_games(std::slice::from_ref(&root));

        let names: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Cave Story"), "got {names:?}");
        assert!(!names.contains(&"Notes"), "got {names:?}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scanning_offers_a_root_that_is_itself_one_game() {
        let root = std::env::temp_dir().join(format!("gameblade-scan-one-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("game.exe"), b"MZ").unwrap();

        let found = scan_for_games(std::slice::from_ref(&root));

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, root);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn normalize_ignores_punctuation_and_case() {
        assert_eq!(normalize("Cave Story+"), "cavestory");
        assert_eq!(normalize("cave_story"), "cavestory");
    }
}
