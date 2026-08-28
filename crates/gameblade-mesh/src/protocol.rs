//! What a client and a node say to each other.
//!
//! One request and one response per QUIC stream, and the stream carries exactly
//! one chunk. That is deliberately simpler than multiplexing many chunks down
//! one stream: QUIC already gives independent streams that do not head-of-line
//! block each other, so "one chunk, one stream" gets parallel transfer for free
//! and makes a failed chunk cost precisely one stream.
//!
//! Frames are length-prefixed JSON for the header and raw bytes for the body.
//! JSON because these messages are small, infrequent and worth being able to
//! read in a packet capture; raw bytes because the body is 8 MiB of game data
//! and encoding it would be absurd.

use serde::{Deserialize, Serialize};

use crate::error::{MeshError, MeshResult};

/// The largest header this will read.
///
/// A header is a few hundred bytes. The cap exists because the length prefix
/// arrives from the other end, and a peer claiming a four-gigabyte header
/// should be refused rather than allocated for.
pub const MAX_HEADER_BYTES: usize = 64 * 1024;

/// What a client asks a node for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRequest {
    /// The coordinator-signed grant authorising this transfer.
    pub grant: String,
    pub game_id: String,
    pub file_id: String,
    /// Position on the chunk grid.
    pub index: u64,
    /// The hash the client expects.
    ///
    /// Sent so the node can answer "I do not have those bytes" rather than
    /// serving a stale copy the client would only reject after transferring it.
    pub sha256: String,
}

/// What a node answers with, before the body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChunkResponse {
    /// `bytes` of body follow immediately.
    Ok { bytes: u64 },
    /// This node cannot serve this chunk. The client should try another source.
    Unavailable { reason: String },
    /// The grant was rejected. Refreshing it may help; retrying will not.
    Denied { reason: String },
    /// The grant's byte ceiling is spent.
    Exhausted,
}

/// A node's answer to "are you there and what are you".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub node_id: String,
    pub agent_version: String,
    /// Echoed back so a client can measure a round trip against its own clock.
    pub nonce: String,
}

/// Read a length-prefixed JSON frame.
pub async fn read_frame<T: for<'de> Deserialize<'de>>(
    stream: &mut quinn::RecvStream,
) -> MeshResult<T> {
    let mut length = [0u8; 4];
    stream
        .read_exact(&mut length)
        .await
        .map_err(|err| MeshError::Protocol(format!("could not read a frame length: {err}")))?;

    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_HEADER_BYTES {
        return Err(MeshError::Protocol(format!(
            "a frame claiming {length} bytes is not plausible"
        )));
    }

    let mut body = vec![0u8; length];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|err| MeshError::Protocol(format!("could not read a frame: {err}")))?;

    serde_json::from_slice(&body)
        .map_err(|err| MeshError::Protocol(format!("could not parse a frame: {err}")))
}

/// Write a length-prefixed JSON frame.
pub async fn write_frame<T: Serialize>(
    stream: &mut quinn::SendStream,
    value: &T,
) -> MeshResult<()> {
    let body = serde_json::to_vec(value)
        .map_err(|err| MeshError::Protocol(format!("could not encode a frame: {err}")))?;

    if body.len() > MAX_HEADER_BYTES {
        return Err(MeshError::Protocol(
            "that frame is too large to send".into(),
        ));
    }

    stream
        .write_all(&(body.len() as u32).to_be_bytes())
        .await
        .map_err(|err| MeshError::Protocol(format!("could not write a frame length: {err}")))?;
    stream
        .write_all(&body)
        .await
        .map_err(|err| MeshError::Protocol(format!("could not write a frame: {err}")))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunk_request_round_trips_through_json() {
        // The server-side names are camelCase; a rename that broke this would
        // fail at runtime against a real node and nowhere else.
        let request = ChunkRequest {
            grant: "v2.abc.def".into(),
            game_id: "gam_1".into(),
            file_id: "gfl_1".into(),
            index: 7,
            sha256: "a".repeat(64),
        };

        let encoded = serde_json::to_string(&request).unwrap();
        assert!(encoded.contains("gameId"));
        assert!(encoded.contains("fileId"));

        let decoded: ChunkRequest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.index, 7);
        assert_eq!(decoded.game_id, "gam_1");
    }

    #[test]
    fn every_response_shape_round_trips() {
        for response in [
            ChunkResponse::Ok { bytes: 1024 },
            ChunkResponse::Unavailable {
                reason: "not held".into(),
            },
            ChunkResponse::Denied {
                reason: "expired".into(),
            },
            ChunkResponse::Exhausted,
        ] {
            let encoded = serde_json::to_string(&response).unwrap();
            let decoded: ChunkResponse = serde_json::from_str(&encoded).unwrap();
            assert_eq!(
                std::mem::discriminant(&response),
                std::mem::discriminant(&decoded)
            );
        }
    }
}
