use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
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

/// Unpacks a downloaded package into `destination`, whatever format it is in.
///
/// The format is decided by the file's extension rather than by sniffing its
/// first bytes, because that is the same decision the server made when it
/// offered the game: the catalog, the store's "ready" badge and the download
/// manifest all key off the extension, and a client that disagreed with them
/// about what a file is would refuse installs the store had promised.
pub fn extract_package(archive: &Path, destination: &Path) -> AppResult<u64> {
    match package_format(archive) {
        Some(PackageFormat::Zip) => extract_zip(archive, destination),
        Some(PackageFormat::SevenZ) => extract_sevenz(archive, destination),
        None => Err(AppError::Other(format!(
            "GameBlade can only install {PACKAGE_EXTENSION_LIST} packages",
        ))),
    }
}

/// A package format the client can unpack on its own.
///
/// Mirrors `PACKAGE_FORMATS` in `@gameblade/shared`: the server decides what it
/// will offer from that list, and this side has to unpack exactly the same set.
/// They are two spellings of one contract, so a format added to one without the
/// other is the bug this comment exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageFormat {
    Zip,
    SevenZ,
}

impl PackageFormat {
    /// Every format, in the order they are listed to people.
    pub const ALL: &'static [PackageFormat] = &[PackageFormat::Zip, PackageFormat::SevenZ];

    /// The lowercase file extension, without its dot.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Zip => "zip",
            Self::SevenZ => "7z",
        }
    }
}

/// The supported extensions as a phrase, so every message reads `.zip or .7z`.
pub const PACKAGE_EXTENSION_LIST: &str = ".zip or .7z";

/// Which format a path names, by extension, or `None` for anything else.
pub fn package_format(path: &Path) -> Option<PackageFormat> {
    let extension = path.extension().and_then(|value| value.to_str())?;
    PackageFormat::ALL
        .iter()
        .copied()
        .find(|format| extension.eq_ignore_ascii_case(format.extension()))
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

    #[derive(Debug)]
    struct Entry {
        index: usize,
        target: PathBuf,
        size: u64,
    }

    let mut files = Vec::new();
    let mut targets = HashSet::new();

    for index in 0..zip.len() {
        let entry = zip
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

        // ZIP symlinks are platform-dependent and can point outside the
        // destination after extraction. Portable games do not need them on
        // Windows, so they are ignored rather than materialised as links or
        // misleading regular files.
        if entry.is_symlink() {
            continue;
        }

        if !targets.insert(target.clone()) {
            return Err(AppError::Other(format!(
                "The archive contains the same output path more than once: {}",
                target.display()
            )));
        }

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }

        files.push(Entry {
            index,
            target,
            size: entry.size(),
        });
    }

    // Largest first balances workers when an archive contains a few big packs
    // beside thousands of tiny assets. Each worker opens its own ZipArchive,
    // which gives every decompressor an independent seek/read state and lets
    // deflate, bzip2 and zstd actually use several CPU cores.
    files.sort_by_key(|entry| Reverse(entry.size));
    drop(zip);

    let workers = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
        .clamp(1, 8)
        .min(files.len().max(1));

    let written = std::thread::scope(|scope| -> AppResult<u64> {
        let mut handles = Vec::with_capacity(workers);
        for worker in 0..workers {
            let tasks = &files;
            handles.push(scope.spawn(move || -> Result<u64, String> {
                let file = std::fs::File::open(archive)
                    .map_err(|err| format!("Could not reopen the archive: {err}"))?;
                let mut zip = zip::ZipArchive::new(file)
                    .map_err(|err| format!("Could not read the archive: {err}"))?;
                let mut buffer = vec![0u8; 1024 * 1024];
                let mut written = 0u64;

                for task in tasks.iter().skip(worker).step_by(workers) {
                    let mut entry = zip
                        .by_index(task.index)
                        .map_err(|err| format!("Could not read an archive entry: {err}"))?;
                    let output = std::fs::File::create(&task.target).map_err(|err| {
                        format!("Could not create {}: {err}", task.target.display())
                    })?;
                    let mut output = std::io::BufWriter::with_capacity(1024 * 1024, output);

                    loop {
                        let count = entry.read(&mut buffer).map_err(|err| {
                            format!("Could not unpack {}: {err}", task.target.display())
                        })?;
                        if count == 0 {
                            break;
                        }
                        output.write_all(&buffer[..count]).map_err(|err| {
                            format!("Could not write {}: {err}", task.target.display())
                        })?;
                        written += count as u64;
                    }
                    output.flush().map_err(|err| {
                        format!("Could not finish {}: {err}", task.target.display())
                    })?;
                }

                Ok(written)
            }));
        }

        let mut written = 0u64;
        for handle in handles {
            let result = handle.join().map_err(|_| {
                AppError::Other("A ZIP extraction worker stopped unexpectedly".to_string())
            })?;
            written += result.map_err(AppError::Other)?;
        }
        Ok(written)
    })?;

    Ok(written)
}

/// Extracts a downloaded .7z into `destination`.
///
/// The path rules are `extract_zip`'s, for the same reason: entry names come
/// from whoever built the archive, so each one is rebuilt from its normal
/// components and anything that would land outside `destination` is dropped.
///
/// What is deliberately *not* shared is the parallelism. A ZIP entry can be
/// decompressed on its own, so that function fans out across workers; 7z packs
/// files into solid blocks where each entry's bytes depend on everything
/// decoded before it in the same block, and extracting entries independently
/// would re-decode the block from the start once per file. A single pass in
/// the archive's own order decodes every block exactly once, which is both
/// correct and, on a solid archive, far quicker than the "parallel" version
/// would be. LZMA2 blocks written with multi-threading still decode on several
/// cores inside this pass.
pub fn extract_sevenz(archive: &Path, destination: &Path) -> AppResult<u64> {
    let mut reader = sevenz_rust2::ArchiveReader::open(archive, sevenz_rust2::Password::empty())
        .map_err(sevenz_error)?;

    let mut targets = HashSet::new();
    let mut written = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];

    reader
        .for_each_entries(|entry, stream| {
            let Some(target) = safe_join(destination, &sevenz_entry_path(entry.name())) else {
                return Ok(true);
            };

            if entry.is_directory() {
                std::fs::create_dir_all(&target).map_err(sevenz_io)?;
                return Ok(true);
            }

            // 7z keeps a symlink as a regular entry whose Unix mode says
            // otherwise, and its target is written as the file's contents. A
            // portable Windows game has no use for one, and materialising it
            // would either follow a link out of the install folder or leave a
            // text file pretending to be a game binary.
            if is_sevenz_symlink(entry) {
                return Ok(true);
            }

            if !targets.insert(target.clone()) {
                return Err(sevenz_rust2::Error::Other(
                    format!(
                        "The archive contains the same output path more than once: {}",
                        target.display()
                    )
                    .into(),
                ));
            }

            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(sevenz_io)?;
            }

            let file = std::fs::File::create(&target).map_err(sevenz_io)?;
            let mut output = std::io::BufWriter::with_capacity(1024 * 1024, file);

            loop {
                let count = stream.read(&mut buffer).map_err(sevenz_io)?;
                if count == 0 {
                    break;
                }
                output.write_all(&buffer[..count]).map_err(sevenz_io)?;
                written += count as u64;
            }
            output.flush().map_err(sevenz_io)?;

            Ok(true)
        })
        .map_err(sevenz_error)?;

    Ok(written)
}

/// An entry name as a path, with 7z's Windows-style separators normalised.
///
/// Archives built on Windows store `data\assets.pak`, which on Windows is
/// already a path and on any other platform is one *file* with a backslash in
/// its name. Splitting both separators here means `safe_join` sees the same
/// components either way — and, more to the point, that `..\..\evil` is
/// rejected rather than becoming a legal single component.
fn sevenz_entry_path(name: &str) -> PathBuf {
    name.split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect()
}

/// Whether a 7z entry describes a symbolic link rather than a file.
///
/// 7-Zip records a Unix mode in the top half of the Windows attributes word
/// and sets `0x8000` to say it did. Anything else — including an archive built
/// on Windows, which never sets that bit — is a real file.
fn is_sevenz_symlink(entry: &sevenz_rust2::ArchiveEntry) -> bool {
    const UNIX_EXTENSION: u32 = 0x8000;
    const S_IFMT: u32 = 0xF000;
    const S_IFLNK: u32 = 0xA000;

    let attributes = entry.windows_attributes();
    attributes & UNIX_EXTENSION != 0 && (attributes >> 16) & S_IFMT == S_IFLNK
}

/// Wraps a filesystem error so it can travel back out through the extractor.
fn sevenz_io(error: std::io::Error) -> sevenz_rust2::Error {
    sevenz_rust2::Error::Io(error, "writing the install".into())
}

/// Turns a 7z failure into something a player can act on.
///
/// The password cases are the ones worth naming. GameBlade has nowhere to ask
/// for a password and no way to store one, so an encrypted package is not a
/// transient failure to retry — it is an archive the operator has to republish
/// unencrypted, and saying so beats "Could not read the archive: Io error".
///
/// Encryption reaches here by two routes. `PasswordRequired` is the archive
/// saying so; `UnsupportedCompressionMethod("AES…")` is what the decoder
/// reports instead, because the client is built without the AES decoder — a
/// password it can never obtain would be the only thing that decoder could
/// use. Both mean the same thing to the person waiting for the game.
fn sevenz_error(error: sevenz_rust2::Error) -> AppError {
    let encrypted = match &error {
        sevenz_rust2::Error::PasswordRequired | sevenz_rust2::Error::MaybeBadPassword(_) => true,
        sevenz_rust2::Error::UnsupportedCompressionMethod(method) => {
            method.to_ascii_uppercase().contains("AES")
        }
        _ => false,
    };

    if encrypted {
        return AppError::Other(
            "This 7z package is password-protected, which GameBlade cannot open. Ask the \
             operator to republish it without encryption."
                .to_string(),
        );
    }

    AppError::Other(format!("Could not unpack the 7z archive: {error}"))
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
    fn zip_packages_unpack_every_entry() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("game.zip");
        let destination = temp.path().join("installed");

        let file = std::fs::File::create(&archive).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in [
            ("Game.exe", b"MZ game binary".as_slice()),
            ("data/first.bin", b"first asset".as_slice()),
            ("data/second.bin", b"second asset".as_slice()),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();

        let written = extract_zip(&archive, &destination).unwrap();

        assert_eq!(written, 14 + 11 + 12);
        assert_eq!(
            std::fs::read(destination.join("Game.exe")).unwrap(),
            b"MZ game binary"
        );
        assert_eq!(
            std::fs::read(destination.join("data/second.bin")).unwrap(),
            b"second asset"
        );
    }

    /// A real archive written by 7-Zip, because the only question worth asking
    /// is whether the client agrees with 7-Zip about what is inside one.
    ///
    /// It is committed rather than built here on purpose: the client links the
    /// 7z *decoder* only — it never writes one — so a test that created its own
    /// fixture would have to pull an encoder into every shipped binary to prove
    /// something about decoding.
    ///
    /// Contents: `Game.exe`, `data/first.bin`, `data/second.bin`, an empty
    /// `data/nested/placeholder.dat`, an empty directory, and a name outside
    /// ASCII.
    const SEVENZ_FIXTURE: &[u8] = include_bytes!("fixtures/game.7z");

    fn sevenz_fixture(directory: &Path) -> PathBuf {
        let archive = directory.join("game.7z");
        std::fs::write(&archive, SEVENZ_FIXTURE).unwrap();
        archive
    }

    #[test]
    fn sevenz_packages_unpack_every_entry() {
        let temp = tempfile::tempdir().unwrap();
        let archive = sevenz_fixture(temp.path());
        let destination = temp.path().join("installed");

        let written = extract_sevenz(&archive, &destination).unwrap();

        assert_eq!(written, 14 + 11 + 12 + 11);
        assert_eq!(
            std::fs::read(destination.join("Game.exe")).unwrap(),
            b"MZ game binary"
        );
        assert_eq!(
            std::fs::read(destination.join("data").join("second.bin")).unwrap(),
            b"second asset"
        );
        assert_eq!(
            std::fs::read(destination.join("Ünïcode Läuncher.exe")).unwrap(),
            b"MZ launcher"
        );
    }

    #[test]
    fn sevenz_packages_keep_their_empty_files_and_folders() {
        let temp = tempfile::tempdir().unwrap();
        let archive = sevenz_fixture(temp.path());
        let destination = temp.path().join("installed");

        extract_sevenz(&archive, &destination).unwrap();

        // A game that ships an empty marker file or a folder it writes saves
        // into needs both to survive the install.
        let placeholder = destination
            .join("data")
            .join("nested")
            .join("placeholder.dat");
        assert!(placeholder.is_file(), "the empty file should be created");
        assert_eq!(std::fs::metadata(&placeholder).unwrap().len(), 0);
        assert!(destination.join("empty folder").is_dir());
    }

    /// The same tree again, packed with `7z a -p`, so its file data is AES.
    const SEVENZ_ENCRYPTED_FIXTURE: &[u8] = include_bytes!("fixtures/encrypted.7z");

    #[test]
    fn an_encrypted_package_says_so_instead_of_failing_obscurely() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("game.7z");
        std::fs::write(&archive, SEVENZ_ENCRYPTED_FIXTURE).unwrap();

        let error = extract_sevenz(&archive, &temp.path().join("installed")).unwrap_err();

        // Nothing in the client can ask a player for a password, so this is a
        // property of the archive and not something to retry. The message has
        // to be the one that gets the operator to republish it.
        assert!(
            error.to_string().contains("password-protected"),
            "got {error}"
        );
    }

    #[test]
    fn packages_are_unpacked_by_extension() {
        let temp = tempfile::tempdir().unwrap();
        let archive = sevenz_fixture(temp.path());
        let destination = temp.path().join("installed");

        // The same call the installer makes, routed by the file's own name.
        extract_package(&archive, &destination).unwrap();

        assert!(destination.join("Game.exe").is_file());
    }

    #[test]
    fn a_format_the_client_cannot_unpack_is_refused_by_name() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("game.rar");
        std::fs::write(&archive, b"not an archive we can read").unwrap();

        let error = extract_package(&archive, &temp.path().join("installed")).unwrap_err();

        assert!(error.to_string().contains(".zip or .7z"), "got {error}");
    }

    #[test]
    fn package_format_is_decided_by_extension_alone() {
        assert_eq!(
            package_format(Path::new("Cave Story.zip")),
            Some(PackageFormat::Zip)
        );
        assert_eq!(
            package_format(Path::new("Cave Story.7Z")),
            Some(PackageFormat::SevenZ)
        );
        assert_eq!(package_format(Path::new("Cave Story.rar")), None);
        assert_eq!(package_format(Path::new("Cave Story")), None);
    }

    #[test]
    fn sevenz_entry_paths_split_on_either_separator() {
        // An archive built on Windows stores `data\first.bin`; one built
        // anywhere else stores `data/first.bin` for the identical layout.
        assert_eq!(
            sevenz_entry_path("data\\nested\\first.bin"),
            Path::new("data").join("nested").join("first.bin")
        );
        assert_eq!(
            sevenz_entry_path("data/nested/first.bin"),
            Path::new("data").join("nested").join("first.bin")
        );
    }

    #[test]
    fn sevenz_entry_paths_cannot_escape_the_install_folder() {
        let root = Path::new("/games/demo");

        // The point of splitting backslashes: left whole, `..\..\evil` would
        // be one legal file name and would land inside the install folder
        // rather than being rejected.
        assert!(safe_join(root, &sevenz_entry_path("..\\..\\evil.txt")).is_none());
        assert!(safe_join(root, &sevenz_entry_path("../../evil.txt")).is_none());
    }

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
