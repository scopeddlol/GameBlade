//! Fetching chunks from a node.
//!
//! The connection attempt is a race, not a sequence. A node advertises several
//! candidate addresses — a LAN address, whatever the coordinator observed, a
//! configured one — and none of them can be trusted in advance: a node behind
//! NAT cannot see its own public address, and the address the coordinator saw a
//! TCP request arrive from is useless if the NAT is not endpoint-independent.
//! Trying them one at a time means waiting out every dead candidate before
//! reaching a live one, so they are all tried at once and the first to answer
//! wins.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::error::{MeshError, MeshResult};
use crate::identity::PublicKey;
use crate::protocol::{read_frame, write_frame, ChunkRequest, ChunkResponse};
use crate::transport::MeshEndpoint;

/// How long to wait for any candidate address to produce a connection.
///
/// Short on purpose. This is racing against the HTTP path that already works;
/// a direct connection that takes eight seconds to establish has already lost
/// to the tunnel it was supposed to beat.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

/// How long to let the node's announcement reach the relay before handshaking.
///
/// The coordinator tells both ends at once, so this only has to cover the
/// node's own round trip. The relay drops traffic for a session it has only
/// half of, so starting early costs a retransmit rather than a failure.
const RELAY_PAIRING_LEAD: Duration = Duration::from_millis(400);

/// A node the client can talk to.
#[derive(Debug, Clone)]
pub struct NodeCandidate {
    pub node_id: String,
    pub label: String,
    pub public_key: PublicKey,
    pub addresses: Vec<SocketAddr>,
    /// The coordinator-signed permission for this node.
    pub grant: String,
}

/// A live connection to one node, and what it has cost so far.
pub struct NodeSession {
    pub node_id: String,
    pub label: String,
    pub address: SocketAddr,
    /// Time to establish, which is the first real signal of how good this
    /// source is. Measured rather than guessed from geography.
    pub handshake_ms: u64,
    connection: quinn::Connection,
    grant: String,
}

impl NodeSession {
    pub fn connection(&self) -> &quinn::Connection {
        &self.connection
    }

    /// Fetch one chunk, verifying it before returning a single byte.
    ///
    /// Verification happens here rather than being left to the caller because
    /// this is the boundary where untrusted bytes become trusted ones. A caller
    /// that forgot would be writing a stranger's data into a game install, and
    /// the whole design rests on that not being possible.
    pub async fn fetch_chunk(
        &self,
        game_id: &str,
        file_id: &str,
        index: u64,
        expected_sha256: &str,
        expected_len: u64,
    ) -> MeshResult<Vec<u8>> {
        let (mut send, mut recv) = self
            .connection
            .open_bi()
            .await
            .map_err(|err| MeshError::Unreachable(format!("could not open a stream: {err}")))?;

        let request = ChunkRequest {
            grant: self.grant.clone(),
            game_id: game_id.to_string(),
            file_id: file_id.to_string(),
            index,
            sha256: expected_sha256.to_string(),
        };

        write_frame(&mut send, &request).await?;
        send.finish()
            .map_err(|err| MeshError::Protocol(format!("could not finish a request: {err}")))?;

        match read_frame::<ChunkResponse>(&mut recv).await? {
            ChunkResponse::Ok { bytes } => {
                if bytes != expected_len {
                    return Err(MeshError::Protocol(format!(
                        "the node offered {bytes} bytes where the manifest says {expected_len}"
                    )));
                }

                // Bounded by what the manifest says this chunk is, so a node
                // cannot make a client allocate on its say-so.
                let body = recv
                    .read_to_end(expected_len as usize)
                    .await
                    .map_err(|err| MeshError::Protocol(format!("truncated chunk: {err}")))?;

                if body.len() as u64 != expected_len {
                    return Err(MeshError::Protocol(format!(
                        "the node sent {} bytes of a {expected_len}-byte chunk",
                        body.len()
                    )));
                }

                let actual = hex::encode(Sha256::digest(&body));
                if !actual.eq_ignore_ascii_case(expected_sha256) {
                    // Not a fallback error: the bytes were wrong, and quietly
                    // asking somewhere else would turn a caught corruption into
                    // an uncaught one.
                    return Err(MeshError::ChunkMismatch { index });
                }

                Ok(body)
            }
            ChunkResponse::Unavailable { reason } => Err(MeshError::Refused(reason)),
            ChunkResponse::Denied { reason } => Err(MeshError::Refused(reason)),
            ChunkResponse::Exhausted => Err(MeshError::GrantExhausted),
        }
    }

    pub fn close(&self) {
        self.connection.close(0u32.into(), b"done");
    }
}

/// Connect to a node, racing every address it advertised.
///
/// Each candidate gets a hole punch before the dial. Punching costs three
/// throwaway packets and takes 150 ms, and it is the difference between working
/// and not working for two machines that are both behind NAT — which, for a
/// home archive and a player at home, is the normal case rather than the
/// exception.
pub async fn connect_to_node(
    endpoint: &MeshEndpoint,
    candidate: &NodeCandidate,
) -> MeshResult<NodeSession> {
    if candidate.addresses.is_empty() {
        return Err(MeshError::Unreachable(
            "the coordinator gave no addresses for this node".into(),
        ));
    }

    let started = Instant::now();
    let mut attempts = Vec::new();

    for address in &candidate.addresses {
        let address = *address;
        let key = candidate.public_key;

        attempts.push(async move {
            // Ignored deliberately: a punch that fails tells us nothing the
            // dial will not tell us more definitively.
            let _ = endpoint.punch(address).await;
            endpoint
                .connect(address, &key)
                .await
                .map(|conn| (address, conn))
        });
    }

    let raced = futures_race(attempts);

    let (address, connection) = match tokio::time::timeout(CONNECT_TIMEOUT, raced).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => return Err(err),
        Err(_) => {
            return Err(MeshError::Unreachable(format!(
                "no address for {} answered within {}s",
                candidate.label,
                CONNECT_TIMEOUT.as_secs()
            )))
        }
    };

    Ok(NodeSession {
        node_id: candidate.node_id.clone(),
        label: candidate.label.clone(),
        address,
        handshake_ms: started.elapsed().as_millis() as u64,
        connection,
        grant: candidate.grant.clone(),
    })
}

/// Reach a node through the relay, having failed to reach it directly.
///
/// The only difference from a direct connection is where the packets go: the
/// client announces itself to the relay, then speaks QUIC to the relay's
/// address, and the relay forwards to the node. Everything else is identical —
/// the same certificate pinning against the same key, the same grant, the same
/// per-chunk verification — because the QUIC session runs end to end and the
/// relay is only carrying it.
pub async fn connect_through_relay(
    endpoint: &MeshEndpoint,
    relay: SocketAddr,
    ticket: &str,
    candidate: &NodeCandidate,
) -> MeshResult<NodeSession> {
    let started = Instant::now();

    // Announce first: the relay has to know which session this socket belongs
    // to before it will forward anything from it.
    endpoint.announce_to_relay(relay, ticket).await?;

    // A beat for the node's own announcement to land, so the relay has both
    // ends before the handshake starts. Without both it drops what arrives.
    tokio::time::sleep(RELAY_PAIRING_LEAD).await;

    let connection = tokio::time::timeout(
        CONNECT_TIMEOUT,
        endpoint.connect(relay, &candidate.public_key),
    )
    .await
    .map_err(|_| MeshError::Unreachable("the relay did not complete a handshake".into()))??;

    Ok(NodeSession {
        node_id: candidate.node_id.clone(),
        label: format!("{} (relayed)", candidate.label),
        address: relay,
        handshake_ms: started.elapsed().as_millis() as u64,
        connection,
        grant: candidate.grant.clone(),
    })
}

/// First success wins; the last failure is reported if none succeed.
///
/// Written out rather than pulled from a combinator library because the
/// behaviour that matters is specific: a failing candidate must not cancel the
/// others, and the error that surfaces should be a real one rather than
/// whichever future happened to finish first.
async fn futures_race<T, F>(futures: Vec<F>) -> MeshResult<T>
where
    F: std::future::Future<Output = MeshResult<T>>,
{
    use std::pin::Pin;

    let mut pending: Vec<Pin<Box<F>>> = futures.into_iter().map(Box::pin).collect();
    let mut last_error = None;

    while !pending.is_empty() {
        let (result, index) = poll_any(&mut pending).await;

        match result {
            Ok(value) => return Ok(value),
            Err(err) => {
                last_error = Some(err);
                pending.remove(index);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| MeshError::Unreachable("no addresses to try".into())))
}

/// Wait for whichever pending future finishes first, and say which it was.
async fn poll_any<T, F>(pending: &mut [std::pin::Pin<Box<F>>]) -> (MeshResult<T>, usize)
where
    F: std::future::Future<Output = MeshResult<T>>,
{
    std::future::poll_fn(|cx| {
        for (index, future) in pending.iter_mut().enumerate() {
            if let std::task::Poll::Ready(result) = future.as_mut().poll(cx) {
                return std::task::Poll::Ready((result, index));
            }
        }
        std::task::Poll::Pending
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::NodeIdentity;

    fn candidate(addresses: Vec<SocketAddr>) -> NodeCandidate {
        NodeCandidate {
            node_id: "nod_1".into(),
            label: "Home archive".into(),
            public_key: NodeIdentity::generate().public_key(),
            addresses,
            grant: "v2.a.b".into(),
        }
    }

    #[tokio::test]
    async fn a_node_with_no_addresses_fails_immediately() {
        // Rather than sitting in the connect timeout: there is nothing to wait
        // for, and the caller has another source to try.
        let endpoint = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

        let result = connect_to_node(&endpoint, &candidate(vec![])).await;
        assert!(matches!(result, Err(MeshError::Unreachable(_))));
        endpoint.close();
    }

    #[tokio::test]
    async fn an_unreachable_node_gives_up_rather_than_hanging() {
        // 198.51.100.0/24 is reserved for documentation and routes nowhere.
        let endpoint = MeshEndpoint::client(NodeIdentity::generate()).unwrap();
        let dead: SocketAddr = "198.51.100.7:47820".parse().unwrap();

        let started = Instant::now();
        let result = connect_to_node(&endpoint, &candidate(vec![dead])).await;

        assert!(result.is_err());
        assert!(started.elapsed() < CONNECT_TIMEOUT + Duration::from_secs(2));
        endpoint.close();
    }

    /// No two async blocks share a type, so a heterogeneous race needs boxing.
    type Attempt<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = MeshResult<u8>> + 'a>>;

    #[tokio::test]
    async fn a_race_returns_the_first_success() {
        let attempts: Vec<Attempt> = vec![
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(80)).await;
                Ok(2u8)
            }),
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(5)).await;
                Ok(1u8)
            }),
        ];

        assert_eq!(futures_race(attempts).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn a_race_survives_a_candidate_failing_early() {
        // A dead LAN address must not take the whole attempt down with it —
        // that address failing is the ordinary case, not an error.
        let attempts: Vec<Attempt> = vec![
            Box::pin(async { Err(MeshError::Unreachable("no route".into())) }),
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok(9u8)
            }),
        ];

        assert_eq!(futures_race(attempts).await.unwrap(), 9);
    }

    #[tokio::test]
    async fn a_race_where_everything_fails_reports_a_real_error() {
        let attempts: Vec<Attempt> = vec![
            Box::pin(async { Err(MeshError::Unreachable("first".into())) }),
            Box::pin(async { Err(MeshError::Refused("second".into())) }),
        ];

        assert!(futures_race(attempts).await.is_err());
    }
}
