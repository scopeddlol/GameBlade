use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not signed in")]
    NotSignedIn,

    #[error("{0}")]
    Server(String),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    /// The server could not be reached and there was nothing cached to answer
    /// with. Distinct from `Network` so the UI can say "you are offline" rather
    /// than showing somebody a TLS handshake failure.
    #[error("GameBlade cannot reach the server right now.")]
    Offline(String),

    /// Something that needs the server, attempted without one.
    #[error("{0} needs a connection to the server.")]
    RequiresConnection(String),

    #[error("File error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Could not read the saved sign-in: {0}")]
    Keyring(String),

    #[error("{0}")]
    Other(String),
}

impl From<keyring::Error> for AppError {
    fn from(value: keyring::Error) -> Self {
        AppError::Keyring(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Other(format!("Malformed response: {value}"))
    }
}

/// Tauri commands must return something serialisable, so errors cross the
/// boundary as their display string.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
