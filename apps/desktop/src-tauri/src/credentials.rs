use crate::error::{AppError, AppResult};
use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "GameBlade";
const ACCOUNT: &str = "device-token";

/// What the app needs to talk to a server again after a restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub server_url: String,
    pub token: String,
    pub username: String,
    pub role: String,
    /// The account's own id, learned from the first successful session check.
    ///
    /// Kept so a restart with no server still knows *who* is signed in — the
    /// client needs it to render its own profile, and asking for it is exactly
    /// the thing that cannot be done offline. Defaulted rather than required,
    /// so a credential saved before this field existed still loads instead of
    /// silently signing somebody out.
    #[serde(default)]
    pub user_id: Option<String>,
}

/// The device token is a long-lived credential, so it goes in the OS credential
/// store (Windows Credential Manager / Keychain / Secret Service) rather than a
/// file next to the executable.
pub fn save(session: &StoredSession) -> AppResult<()> {
    let entry = Entry::new(SERVICE, ACCOUNT)?;
    let payload = serde_json::to_string(session)?;
    entry.set_password(&payload)?;
    Ok(())
}

pub fn load() -> AppResult<Option<StoredSession>> {
    let entry = Entry::new(SERVICE, ACCOUNT)?;
    match entry.get_password() {
        Ok(payload) => Ok(Some(serde_json::from_str(&payload)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(AppError::Keyring(err.to_string())),
    }
}

pub fn clear() -> AppResult<()> {
    let entry = Entry::new(SERVICE, ACCOUNT)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(AppError::Keyring(err.to_string())),
    }
}
