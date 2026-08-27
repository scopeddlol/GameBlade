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

    /// The master switch for cloud saves on this machine.
    ///
    /// With it off nothing is read or written automatically; the buttons on a
    /// game's page still work, because turning off *automatic* syncing is not
    /// the same as refusing to sync at all.
    pub sync_saves: bool,

    /// Upload the save once the game closes.
    ///
    /// This is the half that makes syncing automatic, and the half that was
    /// missing: the client pulled a newer cloud save before launching and then
    /// never sent anything back, so a player who never pressed Upload had a
    /// cloud copy frozen at whenever they last thought to. Default on, because
    /// a player who has turned cloud saves on has already said what they want.
    #[serde(default = "default_true")]
    pub auto_sync_on_exit: bool,

    /// Upload every this many minutes while a game is running. 0 disables it.
    ///
    /// A crash, a power cut or a force-quit all end a session with nothing
    /// uploaded, and for a long session that is the whole evening. Off by
    /// default: it costs an upload per interval, and a game that keeps its
    /// save file open while writing can be packed mid-write.
    #[serde(default)]
    pub auto_sync_interval_minutes: u32,

    /// On sign-in, upload anything this machine is ahead on.
    ///
    /// The safety net for the case above: whatever the last session failed to
    /// send goes up the next time the app starts, rather than waiting for the
    /// game to be played again.
    #[serde(default = "default_true")]
    pub auto_sync_on_start: bool,

    /// Ask before overwriting when local and remote saves have both changed.
    /// Turning this off always prefers whichever side was captured later.
    pub prompt_on_save_conflict: bool,

    /// Report the game being played to friends. Independent of the profile-wide
    /// setting on the server, so a single machine can stay quiet.
    pub share_activity: bool,

    /// Share installed games with other players on this server.
    ///
    /// Off by default and deliberately not implied by anything else. The
    /// operator's own switch decides whether the server will accept a peer at
    /// all; this one decides whether this machine offers to be one. Both have
    /// to be on, because they are different consents: one is an operator
    /// sharing machines they run, the other is a player uploading to strangers
    /// on their own connection.
    #[serde(default)]
    pub share_downloads: bool,

    /// Minimize to the tray instead of exiting when a game launches.
    ///
    /// Aliased so a settings.json saved before this field was renamed still
    /// loads: every field here is required with no #[serde(default)], so a
    /// bare rename would make deserialization fail on the old key and
    /// silently reset every other saved preference to default, not just this
    /// one — load() falls back to Settings::default() on any parse error.
    #[serde(alias = "minimiseOnLaunch")]
    pub minimize_on_launch: bool,

    /// Parallel connections one download may use. More helps on a fast link
    /// with many small files and hurts on a slow one, so it is exposed rather
    /// than guessed.
    pub download_concurrency: usize,

    /// Verify each downloaded file against the server's SHA-256 when it has one.
    pub verify_downloads: bool,

    /// Theme the user picked for this machine, or `None` to follow whatever the
    /// server is set to. Machine-local on purpose: an operator chooses the look
    /// of their archive, and a player gets to disagree on their own PC without
    /// changing it for everyone.
    #[serde(default)]
    pub theme_preset: Option<String>,

    /// A `#rrggbb` accent overriding the theme's own. Only meaningful once
    /// `theme_preset` is set — following the server means following its accent.
    #[serde(default)]
    pub theme_accent: Option<String>,

    /// How the Library tab lays its games out: `grid`, `list` or `detailed`.
    #[serde(default = "default_library_view")]
    pub library_view: String,

    /// Show a game's logo artwork in place of its title where one exists.
    #[serde(default = "default_true")]
    pub use_logo_titles: bool,
}

fn default_library_view() -> String {
    "grid".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            install_dir: default_install_dir(),
            extra_install_dirs: Vec::new(),
            sync_saves: true,
            auto_sync_on_exit: true,
            auto_sync_interval_minutes: 0,
            auto_sync_on_start: true,
            prompt_on_save_conflict: true,
            share_activity: true,
            // Never on unless a player says so.
            share_downloads: false,
            minimize_on_launch: true,
            download_concurrency: 4,
            verify_downloads: true,
            theme_preset: None,
            theme_accent: None,
            library_view: default_library_view(),
            use_logo_titles: true,
        }
    }
}

impl Settings {
    /// Clamp anything a hand-edited file could get wrong.
    pub fn sanitised(mut self) -> Self {
        self.download_concurrency = self.download_concurrency.clamp(1, 16);

        // A one-minute interval would spend a session packing and uploading
        // the same folder over and over; an eight-hour one is not a backup.
        if self.auto_sync_interval_minutes != 0 {
            self.auto_sync_interval_minutes = self.auto_sync_interval_minutes.clamp(5, 120);
        }

        // A hand-edited file could name a layout the client has no code for,
        // which would leave the Library rendering nothing at all.
        if !matches!(self.library_view.as_str(), "grid" | "list" | "detailed") {
            self.library_view = default_library_view();
        }

        // An accent is written straight into a CSS custom property, so it is
        // checked here rather than trusted: anything but a plain hex colour is
        // dropped back to the theme's own.
        if let Some(accent) = &self.theme_accent {
            let valid = accent.len() == 7
                && accent.starts_with('#')
                && accent[1..].chars().all(|c| c.is_ascii_hexdigit());
            if !valid {
                self.theme_accent = None;
            }
        }

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
    fn sanitised_drops_a_layout_and_an_accent_the_client_cannot_render() {
        let settings = Settings {
            library_view: "carousel".to_string(),
            theme_accent: Some("red".to_string()),
            ..Settings::default()
        };

        let sanitised = settings.sanitised();

        assert_eq!(sanitised.library_view, "grid");
        assert_eq!(sanitised.theme_accent, None);
    }

    #[test]
    fn sanitised_keeps_a_real_hex_accent() {
        let settings = Settings {
            theme_accent: Some("#ff0066".to_string()),
            ..Settings::default()
        };

        assert_eq!(
            settings.sanitised().theme_accent,
            Some("#ff0066".to_string())
        );
    }

    #[test]
    fn sanitised_keeps_the_periodic_sync_interval_usable() {
        let too_often = Settings {
            auto_sync_interval_minutes: 1,
            ..Settings::default()
        };
        assert_eq!(too_often.sanitised().auto_sync_interval_minutes, 5);

        let too_rare = Settings {
            auto_sync_interval_minutes: 10_000,
            ..Settings::default()
        };
        assert_eq!(too_rare.sanitised().auto_sync_interval_minutes, 120);

        // Zero means off, and must survive as zero rather than being clamped
        // up into "every five minutes" — which would switch on a feature the
        // player deliberately left alone.
        let off = Settings {
            auto_sync_interval_minutes: 0,
            ..Settings::default()
        };
        assert_eq!(off.sanitised().auto_sync_interval_minutes, 0);
    }

    #[test]
    fn a_settings_file_saved_before_automatic_syncing_still_loads() {
        let dir = std::env::temp_dir().join(format!(
            "gameblade-autosync-test-{}-{}",
            std::process::id(),
            "a"
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            settings_path(&dir),
            r#"{"installDir":"/games","syncSaves":true,"promptOnSaveConflict":true,"shareActivity":true,"minimizeOnLaunch":true,"downloadConcurrency":4,"verifyDownloads":true}"#,
        )
        .unwrap();

        let loaded = load(&dir);

        // The new fields take their defaults rather than failing the parse and
        // resetting every other preference along with them.
        assert!(loaded.auto_sync_on_exit);
        assert!(loaded.auto_sync_on_start);
        assert_eq!(loaded.auto_sync_interval_minutes, 0);

        std::fs::remove_dir_all(&dir).ok();
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
