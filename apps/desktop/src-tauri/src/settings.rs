use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Machine-local preferences. Nothing here is secret — the device token lives in
/// the OS credential store — so a plain JSON file next to the app data is both
/// sufficient and easy for a user to inspect or reset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Where games are installed by default. Defaults to `<documents>/GameBlade/Games`.
    pub install_dir: PathBuf,

    /// Additional locations a game may be installed to instead, offered
    /// alongside `install_dir` in the in-app storage picker. Absent from a
    /// settings file saved before multi-location support existed, hence the
    /// default rather than aliasing — there is nothing to alias from.
    #[serde(default)]
    pub extra_install_dirs: Vec<PathBuf>,

    /// Pull the cloud save before launching and push it after quitting.
    pub sync_saves: bool,

    /// Ask before overwriting when local and remote saves have both changed.
    /// Turning this off always prefers whichever side was captured later.
    pub prompt_on_save_conflict: bool,

    /// Report the game being played to friends. Independent of the profile-wide
    /// setting on the server, so a single machine can stay quiet.
    pub share_activity: bool,

    /// Minimize to the tray instead of exiting when a game launches.
    ///
    /// Aliased so a settings.json saved before this field was renamed still
    /// loads: every field here is required with no #[serde(default)], so a
    /// bare rename would make deserialization fail on the old key and
    /// silently reset every other saved preference to default, not just this
    /// one — load() falls back to Settings::default() on any parse error.
    #[serde(alias = "minimiseOnLaunch")]
    pub minimize_on_launch: bool,

    /// Simultaneous file transfers. More helps on a fast link with many small
    /// files and hurts on a slow one, so it is exposed rather than guessed.
    pub download_concurrency: usize,

    /// Verify each downloaded file against the server's SHA-256 when it has one.
    pub verify_downloads: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            install_dir: default_install_dir(),
            extra_install_dirs: Vec::new(),
            sync_saves: true,
            prompt_on_save_conflict: true,
            share_activity: true,
            minimize_on_launch: true,
            download_concurrency: 4,
            verify_downloads: true,
        }
    }
}

impl Settings {
    /// Clamp anything a hand-edited file could get wrong.
    pub fn sanitised(mut self) -> Self {
        self.download_concurrency = self.download_concurrency.clamp(1, 16);
        if self.install_dir.as_os_str().is_empty() {
            self.install_dir = default_install_dir();
        }
        // The default location is always offered on its own, and each extra
        // one only once — otherwise it would appear twice in the picker.
        let mut seen = std::collections::HashSet::new();
        self.extra_install_dirs.retain(|dir| {
            !dir.as_os_str().is_empty() && *dir != self.install_dir && seen.insert(dir.clone())
        });
        self
    }

    /// Every configured storage location, default first.
    pub fn all_install_dirs(&self) -> Vec<PathBuf> {
        let mut all = vec![self.install_dir.clone()];
        all.extend(self.extra_install_dirs.iter().cloned());
        all
    }
}

fn default_install_dir() -> PathBuf {
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("GameBlade")
        .join("Games")
}

fn settings_path(app_data: &std::path::Path) -> PathBuf {
    app_data.join("settings.json")
}

/// Reads settings, falling back to defaults for a missing or corrupt file. A
/// bad file must never stop the app from starting — the user would have no way
/// to fix it from inside the app if it did.
pub fn load(app_data: &std::path::Path) -> Settings {
    let path = settings_path(app_data);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    serde_json::from_str::<Settings>(&raw)
        .map(Settings::sanitised)
        .unwrap_or_default()
}

pub fn save(app_data: &std::path::Path, settings: &Settings) -> AppResult<()> {
    std::fs::create_dir_all(app_data)?;
    let payload = serde_json::to_string_pretty(settings)?;
    std::fs::write(settings_path(app_data), payload)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitised_drops_the_default_dir_and_duplicates_from_the_extra_list() {
        let settings = Settings {
            install_dir: PathBuf::from("/games/default"),
            extra_install_dirs: vec![
                PathBuf::from("/games/default"),
                PathBuf::from("/games/second"),
                PathBuf::from("/games/second"),
                PathBuf::from(""),
            ],
            ..Settings::default()
        };

        let sanitised = settings.sanitised();

        assert_eq!(
            sanitised.extra_install_dirs,
            vec![PathBuf::from("/games/second")]
        );
    }

    #[test]
    fn all_install_dirs_lists_the_default_first() {
        let settings = Settings {
            install_dir: PathBuf::from("/games/default"),
            extra_install_dirs: vec![PathBuf::from("/games/second")],
            ..Settings::default()
        };

        assert_eq!(
            settings.all_install_dirs(),
            vec![
                PathBuf::from("/games/default"),
                PathBuf::from("/games/second")
            ],
        );
    }

    #[test]
    fn a_settings_file_saved_before_multi_location_support_still_loads() {
        let dir =
            std::env::temp_dir().join(format!("gameblade-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            settings_path(&dir),
            r#"{"installDir":"/games","syncSaves":true,"promptOnSaveConflict":true,"shareActivity":true,"minimizeOnLaunch":true,"downloadConcurrency":4,"verifyDownloads":true}"#,
        )
        .unwrap();

        let loaded = load(&dir);

        assert_eq!(loaded.install_dir, PathBuf::from("/games"));
        assert!(loaded.extra_install_dirs.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
