//! Serving chunks: the half that runs on a machine holding game files.
//!
//! A node answers exactly one question — "give me chunk N of this file, which
//! should hash to X" — and it answers it only for a client carrying a grant the
//! coordinator signed. It has no other API, no account, and no way to speak on
//! the coordinator's behalf.
//!
//! The chunk store is a trait rather than a filesystem walk, because the two
//! things that serve chunks are quite different: an operator's mirror reads
//! from a library directory, and a seeding client reads from a game it
//! installed. Both can answer "bytes for this hash", and that is all this needs.

use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::error::{MeshError, MeshResult};
use crate::grant::{verify_grant, GrantLedger};
use crate::identity::PublicKey;
use crate::protocol::{read_frame, write_frame, ChunkRequest, ChunkResponse};

/// Where a node gets bytes from.
#[async_trait::async_trait]
pub trait ChunkStore: Send + Sync + 'static {
    /// The bytes of one chunk, or `None` if this node does not hold it.
    ///
    /// Implementations are asked for a specific chunk of a specific file and
    /// may check the hash themselves; the serving loop verifies regardless,
    /// because a node serving bytes that do not match what it advertised is a
    /// bug worth catching on the node rather than at every client.
    async fn read_chunk(&self, game_id: &str, file_id: &str, index: u64) -> Option<Vec<u8>>;
}

/// Everything the serving loop needs.
pub struct NodeServer<S: ChunkStore> {
    store: Arc<S>,
    coordinator: PublicKey,
    ledger: Arc<Mutex<GrantLedger>>,
    node_id: String,
}

impl<S: ChunkStore> NodeServer<S> {
    pub fn new(node_id: String, store: Arc<S>, coordinator: PublicKey) -> Self {
        Self {
            store,
            coordinator,
            ledger: Arc::new(Mutex::new(GrantLedger::new())),
            node_id,
        }
    }

    pub fn ledger(&self) -> Arc<Mutex<GrantLedger>> {
        Arc::clone(&self.ledger)
    }

    /// Handle one client connection until it goes away.
    pub async fn serve(&self, connection: quinn::Connection) {
        loop {
            let stream = match connection.accept_bi().await {
                Ok(stream) => stream,
                // The client finished, or the connection dropped. Neither is
                // worth logging as a failure: this is how downloads end.
                Err(_) => return,
            };

            let (mut send, mut recv) = stream;

            // Each stream is answered independently so one slow disk read does
            // not hold up the fifteen other chunks in flight.
            let store = Arc::clone(&self.store);
            let ledger = Arc::clone(&self.ledger);
            let coordinator = self.coordinator;
            let node_id = self.node_id.clone();

            tokio::spawn(async move {
                let response = handle_request(
                    &store,
                    &ledger,
                    &coordinator,
                    &node_id,
                    &mut recv,
                    &mut send,
                )
                .await;

                if let Err(err) = response {
                    tracing::debug!(error = %err, "a chunk request failed");
                }
            });
        }
    }
}

/// Read one request, decide, and answer.
async fn handle_request<S: ChunkStore>(
    store: &Arc<S>,
    ledger: &Arc<Mutex<GrantLedger>>,
    coordinator: &PublicKey,
    node_id: &str,
    recv: &mut quinn::RecvStream,
    send: &mut quinn::SendStream,
) -> MeshResult<()> {
    let request: ChunkRequest = read_frame(recv).await?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let claims = match verify_grant(&request.grant, coordinator, now) {
        Ok(claims) => claims,
        Err(err) => {
            write_frame(
                send,
                &ChunkResponse::Denied {
                    reason: err.to_string(),
                },
            )
            .await?;
            let _ = send.finish();
            return Ok(());
        }
    };

    // A grant naming a different node is not for us. Without this check a grant
    // issued for any node would work at every node, and blocking one node would
    // stop meaning anything.
    if claims.node_id != node_id {
        write_frame(
            send,
            &ChunkResponse::Denied {
                reason: "that grant is for a different node".into(),
            },
        )
        .await?;
        let _ = send.finish();
        return Ok(());
    }

    // Likewise for the game: a grant for one game must not open the whole
    // library.
    if claims.game_id != request.game_id {
        write_frame(
            send,
            &ChunkResponse::Denied {
                reason: "that grant is for a different game".into(),
            },
        )
        .await?;
        let _ = send.finish();
        return Ok(());
    }

    let Some(bytes) = store
        .read_chunk(&request.game_id, &request.file_id, request.index)
        .await
    else {
        write_frame(
            send,
            &ChunkResponse::Unavailable {
                reason: "this node does not hold that chunk".into(),
            },
        )
        .await?;
        let _ = send.finish();
        return Ok(());
    };

    // Checked here as well as at the client. A node that has drifted from what
    // it advertised should find that out itself rather than making every client
    // discover it one wasted 8 MiB transfer at a time.
    let actual = hex::encode(Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&request.sha256) {
        write_frame(
            send,
            &ChunkResponse::Unavailable {
                reason: "this node's copy of that chunk does not match".into(),
            },
        )
        .await?;
        let _ = send.finish();
        return Ok(());
    }

    // Reserved before sending, not counted after: a client opening sixteen
    // streams at once would otherwise have every one of them check a ceiling
    // none of them had spent yet.
    let length = bytes.len() as u64;
    {
        let mut guard = ledger.lock().await;
        if guard.reserve(&claims, length).is_err() {
            drop(guard);
            write_frame(send, &ChunkResponse::Exhausted).await?;
            let _ = send.finish();
            return Ok(());
        }
    }

    write_frame(send, &ChunkResponse::Ok { bytes: length }).await?;

    if let Err(err) = send.write_all(&bytes).await {
        // The bytes never left, so the allowance they reserved goes back.
        ledger.lock().await.release(&claims.nonce, length);
        return Err(MeshError::Protocol(format!(
            "could not send a chunk: {err}"
        )));
    }

    let _ = send.finish();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grant::GrantClaims;
    use crate::identity::NodeIdentity;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

    struct FixedStore {
        bytes: Vec<u8>,
    }

    #[async_trait::async_trait]
    impl ChunkStore for FixedStore {
        async fn read_chunk(&self, _game: &str, _file: &str, index: u64) -> Option<Vec<u8>> {
            (index == 0).then(|| self.bytes.clone())
        }
    }

    fn issue(signer: &NodeIdentity, claims: &GrantClaims) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signature = URL_SAFE_NO_PAD.encode(signer.sign(payload.as_bytes()));
        format!("v2.{payload}.{signature}")
    }

    fn claims(node_id: &str, game_id: &str) -> GrantClaims {
        GrantClaims {
            user_id: "usr_1".into(),
            game_id: game_id.into(),
            node_id: node_id.into(),
            max_bytes: 10_000,
            expires_at: i64::MAX,
            nonce: "n1".into(),
        }
    }

    #[tokio::test]
    async fn a_store_answers_only_for_chunks_it_holds() {
        let store = FixedStore {
            bytes: vec![1, 2, 3],
        };

        assert_eq!(store.read_chunk("g", "f", 0).await, Some(vec![1, 2, 3]));
        assert!(store.read_chunk("g", "f", 1).await.is_none());
    }

    #[test]
    fn a_grant_for_another_node_is_not_accepted_here() {
        // Without this, a grant issued for any node would work at every node,
        // and blocking one node would stop meaning anything.
        let coordinator = NodeIdentity::generate();
        let grant = issue(&coordinator, &claims("nod_other", "gam_1"));

        let verified = verify_grant(&grant, &coordinator.public_key(), 0).unwrap();
        assert_ne!(verified.node_id, "nod_mine");
    }

    #[test]
    fn a_grant_for_another_game_does_not_open_the_library() {
        let coordinator = NodeIdentity::generate();
        let grant = issue(&coordinator, &claims("nod_1", "gam_1"));

        let verified = verify_grant(&grant, &coordinator.public_key(), 0).unwrap();
        assert_ne!(verified.game_id, "gam_2");
    }
}
