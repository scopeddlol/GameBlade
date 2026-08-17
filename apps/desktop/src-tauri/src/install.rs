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
    fn normalize_ignores_punctuation_and_case() {
        assert_eq!(normalize("Cave Story+"), "cavestory");
        assert_eq!(normalize("cave_story"), "cavestory");
    }
}
