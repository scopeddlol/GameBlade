use std::fmt;

pub type MeshResult<T> = Result<T, MeshError>;

/// What can go wrong while a Node processes Coordinator work.
///
/// The distinction that matters to callers is [`MeshError::is_fallback`]: some
/// of these mean "this node cannot serve you, try another or go back to the
/// origin", and some mean "the bytes were wrong", which is a different problem
/// and must never be quietly retried into a corrupt file.
#[derive(Debug, thiserror::Error)]
pub enum MeshError {
    #[error("{0}")]
    Identity(String),

    /// No path to the node could be established at all.
    #[error("could not reach the node: {0}")]
    Unreachable(String),

    /// A path was established but the node is not who it claimed to be.
    #[error("the node's identity did not match: {0}")]
    WrongNode(String),

    /// The node refused the request — an expired grant, an unknown chunk.
    #[error("the node refused: {0}")]
    Refused(String),

    /// Bytes arrived and hashed wrong.
    #[error("chunk {index} did not match its hash")]
    ChunkMismatch { index: u64 },

    #[error("the transfer allowance for this node is spent")]
    GrantExhausted,

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl MeshError {
    /// Whether falling back to another source is the right response.
    ///
    /// A mismatch is deliberately not in this set. Everything else here says
    /// something about the path; a mismatch says something about the bytes, and
    /// silently trying elsewhere would turn a detected corruption into an
    /// undetected one if the next source happened to be wrong the same way.
    pub fn is_fallback(&self) -> bool {
        matches!(
            self,
            MeshError::Unreachable(_)
                | MeshError::WrongNode(_)
                | MeshError::Refused(_)
                | MeshError::GrantExhausted
                | MeshError::Protocol(_)
                | MeshError::Io(_)
        )
    }
}

/// How a source performed, for choosing between sources later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceHealth {
    Untried,
    Working,
    /// Failed in a way another attempt might survive.
    Degraded,
    /// Failed in a way that will not improve; stop asking.
    Dead,
}

impl fmt::Display for SourceHealth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            SourceHealth::Untried => "untried",
            SourceHealth::Working => "working",
            SourceHealth::Degraded => "degraded",
            SourceHealth::Dead => "dead",
        };
        f.write_str(name)
    }
}
