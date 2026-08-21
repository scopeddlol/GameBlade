use crate::error::{AppError, AppResult};
use globset::{Glob, GlobMatcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

/// A game's save location, as authored by an administrator on the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRule {
    pub path_template: String,
    pub include: Option<String>,
    pub exclude: Option<String>,
}

/// What the client found on disk for a rule, ready to compare against the cloud.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSave {
    pub root: PathBuf,
    pub file_count: usize,
    pub size_bytes: u64,
    /// Digest over the file list and contents; stable across equal snapshots.
    pub sha256: String,
    /// Newest mtime in the set, which orders local against remote.
    pub captured_at: String,
}

/// Expands `{appdata}`-style placeholders into real paths.
///
/// Rules are authored once by an administrator and applied on every machine, so
/// the template is the only portable way to say "wherever this user's AppData
/// happens to be". An unknown placeholder is left as-is rather than silently
/// resolving to an empty string, which would turn `{oops}\Saves` into a path
/// pointing at the drive root.
///
/// Separators are normalised to the host's, not to backslashes: admins write
/// Windows-style templates, but the tests — and any future non-Windows build —
/// have to be able to resolve one too.
pub fn resolve_template(template: &str, install_dir: &Path) -> PathBuf {
    let separator = std::path::MAIN_SEPARATOR;
    let mut resolved: String = template
        .chars()
        .map(|c| if c == '/' || c == '\\' { separator } else { c })
        .collect();

    let replacements: [(&str, Option<PathBuf>); 9] = [
        ("{userprofile}", dirs::home_dir()),
        ("{appdata}", dirs::config_dir()),
        ("{localappdata}", dirs::cache_dir()),
        ("{documents}", dirs::document_dir()),
        (
            "{savedgames}",
            dirs::home_dir().map(|home| home.join("Saved Games")),
        ),
        ("{public}", std::env::var("PUBLIC").ok().map(PathBuf::from)),
        ("{install}", Some(install_dir.to_path_buf())),
        // Both appear in upstream save-path data often enough to matter: 149
        // games save under ProgramData and a handful under the Windows folder.
        (
            "{programdata}",
            std::env::var("ProgramData").ok().map(PathBuf::from),
        ),
        ("{windir}", std::env::var("windir").ok().map(PathBuf::from)),
    ];

    for (token, value) in replacements {
        if let Some(path) = value {
            resolved = resolved.replace(token, &path.to_string_lossy());
        }
    }

    PathBuf::from(resolved)
}

fn matcher(pattern: &Option<String>) -> Option<GlobMatcher> {
    pattern
        .as_ref()
        .filter(|p| !p.trim().is_empty())
        .and_then(|p| Glob::new(p).ok())
        .map(|glob| glob.compile_matcher())
}

/// Walks a save folder and produces a content digest for it.
///
/// The digest covers each file's relative path and bytes, in sorted order, so
/// the same save produces the same digest on two machines regardless of how the
/// filesystem happens to enumerate it. That determinism is what makes
/// "unchanged since last sync" a reliable comparison rather than a guess.
pub fn inspect(rule: &SaveRule, install_dir: &Path) -> AppResult<Option<LocalSave>> {
    let root = resolve_template(&rule.path_template, install_dir);
    if !root.exists() {
        return Ok(None);
    }

    let include = matcher(&rule.include);
    let exclude = matcher(&rule.exclude);

    let mut files: Vec<(String, PathBuf, u64, std::time::SystemTime)> = Vec::new();

    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(&root) else {
            continue;
        };
        let relative_str = relative.to_string_lossy().replace('\\', "/");

        if let Some(include) = &include {
            if !include.is_match(&relative_str) {
                continue;
            }
        }
        if let Some(exclude) = &exclude {
            if exclude.is_match(&relative_str) {
                continue;
            }
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
        files.push((
            relative_str,
            entry.path().to_path_buf(),
            metadata.len(),
            modified,
        ));
    }

    if files.is_empty() {
        return Ok(None);
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    let mut size_bytes = 0u64;
    let mut newest = std::time::UNIX_EPOCH;

    for (relative, path, size, modified) in &files {
        hasher.update(relative.as_bytes());
        hasher.update(b"\0");
        let mut file = std::fs::File::open(path)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        size_bytes += size;
        if *modified > newest {
            newest = *modified;
        }
    }

    Ok(Some(LocalSave {
        root,
        file_count: files.len(),
        size_bytes,
        sha256: hex::encode(hasher.finalize()),
        captured_at: to_iso(newest),
    }))
}

/// Packs a save folder into a zip ready to upload.
pub fn pack(rule: &SaveRule, install_dir: &Path, target: &Path) -> AppResult<LocalSave> {
    let Some(local) = inspect(rule, install_dir)? else {
        return Err(AppError::Other(
            "There is no save data on this machine yet".to_string(),
        ));
    };

    let include = matcher(&rule.include);
    let exclude = matcher(&rule.exclude);

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(target)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for entry in walkdir::WalkDir::new(&local.root)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(&local.root) else {
            continue;
        };
        let relative_str = relative.to_string_lossy().replace('\\', "/");

        if let Some(include) = &include {
            if !include.is_match(&relative_str) {
                continue;
            }
        }
        if let Some(exclude) = &exclude {
            if exclude.is_match(&relative_str) {
                continue;
            }
        }
        entries.push((relative_str, entry.path().to_path_buf()));
    }

    // Sorted so two runs over identical data produce byte-identical archives.
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    for (relative, path) in entries {
        zip.start_file(relative, options)
            .map_err(|err| AppError::Other(format!("Could not add a file to the save: {err}")))?;
        let mut source = std::fs::File::open(&path)?;
        let mut buffer = Vec::new();
        source.read_to_end(&mut buffer)?;
        zip.write_all(&buffer)?;
    }

    zip.finish()
        .map_err(|err| AppError::Other(format!("Could not finish the save archive: {err}")))?;

    Ok(local)
}

/// Restores a downloaded save archive over the game's save folder.
///
/// The existing folder is moved aside first rather than deleted. Pulling a save
/// is the one operation here that can destroy hours of play, so the previous
/// state stays recoverable on disk even if the archive turns out to be wrong.
pub fn restore(rule: &SaveRule, install_dir: &Path, archive: &Path) -> AppResult<PathBuf> {
    let root = resolve_template(&rule.path_template, install_dir);

    if root.exists() {
        let backup = root.with_file_name(format!(
            "{}.gameblade-backup",
            root.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "saves".to_string())
        ));
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::rename(&root, &backup)?;
    }

    std::fs::create_dir_all(&root)?;

    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|err| AppError::Other(format!("Could not read the save archive: {err}")))?;

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|err| AppError::Other(format!("Could not read a save entry: {err}")))?;

        // Same containment rule as game archives: an entry may only ever land
        // inside the save folder.
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let Some(target) = safe_join(&root, &name) else {
            continue;
        };

        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut out)?;
    }

    Ok(root)
}

fn safe_join(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let mut result = root.to_path_buf();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => result.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (result != root).then_some(result)
}

fn to_iso(time: std::time::SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Utc> = time.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_template_expands_install() {
        let install = Path::new("C:\\Games\\Demo");
        let resolved = resolve_template("{install}\\Saves", install);
        assert!(resolved.to_string_lossy().ends_with("Saves"));
        assert!(resolved.to_string_lossy().contains("Demo"));
    }

    #[test]
    fn resolve_template_leaves_unknown_placeholders_alone() {
        let resolved = resolve_template("{nonsense}\\Saves", Path::new("."));
        assert!(resolved.to_string_lossy().contains("{nonsense}"));
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = Path::new("/saves");
        assert!(safe_join(root, Path::new("../secrets")).is_none());
        assert!(safe_join(root, Path::new("slot1/save.dat")).is_some());
    }

    #[test]
    fn inspect_reports_nothing_for_a_missing_folder() {
        let rule = SaveRule {
            path_template: "/definitely/not/here".to_string(),
            include: None,
            exclude: None,
        };
        assert!(inspect(&rule, Path::new("."))
            .expect("should not error")
            .is_none());
    }

    #[test]
    fn inspect_digests_contents_deterministically() {
        let dir = std::env::temp_dir().join(format!("gb-save-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("slot1")).expect("create");
        std::fs::write(dir.join("slot1").join("a.sav"), b"hello").expect("write");
        std::fs::write(dir.join("b.log"), b"noise").expect("write");

        let all = SaveRule {
            path_template: dir.to_string_lossy().to_string(),
            include: None,
            exclude: None,
        };
        let first = inspect(&all, Path::new(".")).expect("ok").expect("some");
        let second = inspect(&all, Path::new(".")).expect("ok").expect("some");
        assert_eq!(first.sha256, second.sha256);
        assert_eq!(first.file_count, 2);

        // Excluding a file must change the digest, not just the count.
        let filtered = SaveRule {
            path_template: dir.to_string_lossy().to_string(),
            include: None,
            exclude: Some("*.log".to_string()),
        };
        let third = inspect(&filtered, Path::new("."))
            .expect("ok")
            .expect("some");
        assert_eq!(third.file_count, 1);
        assert_ne!(third.sha256, first.sha256);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
