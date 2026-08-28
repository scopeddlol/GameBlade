//! A real client fetching real bytes from a real node over QUIC.
//!
//! The unit tests cover each piece in isolation, which is exactly where a
//! transport bug hides: certificate pinning, ALPN, frame encoding and grant
//! checking are individually correct in a great many combinations that do not
//! actually talk to each other. This starts both halves on localhost and moves
//! bytes between them.

use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use gameblade_mesh::{
    client::{connect_to_node, NodeCandidate},
    grant::GrantClaims,
    identity::NodeIdentity,
    node::{ChunkStore, NodeServer},
    transport::MeshEndpoint,
    MeshError,
};
use sha2::{Digest, Sha256};

/// A node holding one known chunk.
struct TestStore {
    bytes: Vec<u8>,
}

#[async_trait::async_trait]
impl ChunkStore for TestStore {
    async fn read_chunk(&self, _game: &str, _file: &str, index: u64) -> Option<Vec<u8>> {
        (index == 0).then(|| self.bytes.clone())
    }
}

/// Sign a grant exactly the way the coordinator does.
fn issue(coordinator: &NodeIdentity, claims: &GrantClaims) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
    let signature = URL_SAFE_NO_PAD.encode(coordinator.sign(payload.as_bytes()));
    format!("v2.{payload}.{signature}")
}

fn claims(node_id: &str, max_bytes: u64) -> GrantClaims {
    GrantClaims {
        user_id: "usr_1".into(),
        game_id: "gam_1".into(),
        node_id: node_id.into(),
        max_bytes,
        expires_at: i64::MAX,
        nonce: "nonce-1".into(),
    }
}

/// Start a node serving `bytes`, and return everything needed to reach it.
async fn start_node(
    coordinator: &NodeIdentity,
    node_id: &str,
    bytes: Vec<u8>,
) -> (NodeIdentity, u16) {
    let identity = NodeIdentity::generate();
    let endpoint = MeshEndpoint::node(identity.clone(), 0).unwrap();
    let port = endpoint.local_addr().unwrap().port();

    let server = Arc::new(NodeServer::new(
        node_id.to_string(),
        Arc::new(TestStore { bytes }),
        coordinator.public_key(),
    ));

    tokio::spawn(async move {
        while let Some(incoming) = endpoint.inner().accept().await {
            let server = Arc::clone(&server);
            tokio::spawn(async move {
                if let Ok(connection) = incoming.await {
                    server.serve(connection).await;
                }
            });
        }
    });

    (identity, port)
}

fn candidate(node: &NodeIdentity, port: u16, grant: String) -> NodeCandidate {
    NodeCandidate {
        node_id: "nod_1".into(),
        label: "Home archive".into(),
        public_key: node.public_key(),
        addresses: vec![format!("127.0.0.1:{port}").parse().unwrap()],
        grant,
    }
}

#[tokio::test]
async fn a_client_fetches_a_verified_chunk_from_a_node() {
    let coordinator = NodeIdentity::generate();
    let payload: Vec<u8> = (0..64_000u32).map(|i| (i % 251) as u8).collect();
    let digest = hex::encode(Sha256::digest(&payload));

    let (node, port) = start_node(&coordinator, "nod_1", payload.clone()).await;
    let client = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

    let grant = issue(&coordinator, &claims("nod_1", 10_000_000));
    let session = connect_to_node(&client, &candidate(&node, port, grant))
        .await
        .expect("the client should reach the node");

    let fetched = session
        .fetch_chunk("gam_1", "gfl_1", 0, &digest, payload.len() as u64)
        .await
        .expect("the chunk should arrive and verify");

    assert_eq!(fetched, payload);
    session.close();
    client.close();
}

#[tokio::test]
async fn a_client_refuses_a_node_presenting_a_different_identity() {
    // The coordinator names a key; reaching a machine that holds a different
    // one means something is wrong, and continuing would mean taking game data
    // from whoever happened to answer.
    let coordinator = NodeIdentity::generate();
    let (_node, port) = start_node(&coordinator, "nod_1", vec![1, 2, 3]).await;

    let impostor = NodeIdentity::generate();
    let client = MeshEndpoint::client(NodeIdentity::generate()).unwrap();
    let grant = issue(&coordinator, &claims("nod_1", 1_000));

    let result = connect_to_node(&client, &candidate(&impostor, port, grant)).await;

    assert!(result.is_err(), "a mismatched identity must not connect");
    client.close();
}

#[tokio::test]
async fn a_node_refuses_a_grant_it_was_not_named_in() {
    // Otherwise a grant issued for any node would work at every node, and
    // blocking one node would stop meaning anything.
    let coordinator = NodeIdentity::generate();
    let payload = vec![7u8; 1_024];
    let digest = hex::encode(Sha256::digest(&payload));

    let (node, port) = start_node(&coordinator, "nod_1", payload.clone()).await;
    let client = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

    let elsewhere = issue(&coordinator, &claims("nod_somewhere_else", 10_000));
    let session = connect_to_node(&client, &candidate(&node, port, elsewhere))
        .await
        .unwrap();

    let result = session
        .fetch_chunk("gam_1", "gfl_1", 0, &digest, payload.len() as u64)
        .await;

    assert!(matches!(result, Err(MeshError::Refused(_))));
    client.close();
}

#[tokio::test]
async fn a_node_refuses_a_grant_signed_by_someone_else() {
    // The property the whole design rests on: a node can check authority
    // without being able to write any.
    let coordinator = NodeIdentity::generate();
    let impostor = NodeIdentity::generate();
    let payload = vec![3u8; 512];
    let digest = hex::encode(Sha256::digest(&payload));

    let (node, port) = start_node(&coordinator, "nod_1", payload.clone()).await;
    let client = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

    let forged = issue(&impostor, &claims("nod_1", 10_000));
    let session = connect_to_node(&client, &candidate(&node, port, forged))
        .await
        .unwrap();

    let result = session
        .fetch_chunk("gam_1", "gfl_1", 0, &digest, payload.len() as u64)
        .await;

    assert!(matches!(result, Err(MeshError::Refused(_))));
    client.close();
}

#[tokio::test]
async fn a_node_stops_serving_once_the_grant_ceiling_is_spent() {
    let coordinator = NodeIdentity::generate();
    let payload = vec![9u8; 1_000];
    let digest = hex::encode(Sha256::digest(&payload));

    let (node, port) = start_node(&coordinator, "nod_1", payload.clone()).await;
    let client = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

    // Room for two chunks and not a byte more.
    let grant = issue(&coordinator, &claims("nod_1", 2_000));
    let session = connect_to_node(&client, &candidate(&node, port, grant))
        .await
        .unwrap();

    for _ in 0..2 {
        session
            .fetch_chunk("gam_1", "gfl_1", 0, &digest, 1_000)
            .await
            .expect("the allowance covers this");
    }

    let over = session
        .fetch_chunk("gam_1", "gfl_1", 0, &digest, 1_000)
        .await;
    assert!(matches!(over, Err(MeshError::GrantExhausted)));
    client.close();
}

#[tokio::test]
async fn a_client_rejects_a_chunk_that_does_not_match_its_hash() {
    // The property that makes an untrusted node safe to talk to. The node here
    // serves bytes that are simply not what was asked for.
    let coordinator = NodeIdentity::generate();
    let served = vec![1u8; 2_048];
    let expected_but_absent = hex::encode(Sha256::digest(vec![2u8; 2_048]));

    let (node, port) = start_node(&coordinator, "nod_1", served).await;
    let client = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

    let grant = issue(&coordinator, &claims("nod_1", 100_000));
    let session = connect_to_node(&client, &candidate(&node, port, grant))
        .await
        .unwrap();

    let result = session
        .fetch_chunk("gam_1", "gfl_1", 0, &expected_but_absent, 2_048)
        .await;

    // The node notices first and declines to send, which is the cheaper of the
    // two places to catch it — but either way the client never accepts them.
    assert!(result.is_err());
    match result {
        Err(MeshError::Refused(_)) | Err(MeshError::ChunkMismatch { .. }) => {}
        other => panic!("expected a refusal or a mismatch, got {other:?}"),
    }
    client.close();
}

#[tokio::test]
async fn a_node_says_so_rather_than_stalling_when_it_lacks_a_chunk() {
    let coordinator = NodeIdentity::generate();
    let (node, port) = start_node(&coordinator, "nod_1", vec![5u8; 100]).await;
    let client = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

    let grant = issue(&coordinator, &claims("nod_1", 100_000));
    let session = connect_to_node(&client, &candidate(&node, port, grant))
        .await
        .unwrap();

    // Index 4 is not held by this store.
    let result = session
        .fetch_chunk("gam_1", "gfl_1", 4, &"a".repeat(64), 100)
        .await;

    assert!(matches!(result, Err(MeshError::Refused(_))));
    // And it is a fallback error, so the caller knows to try another source.
    assert!(result.unwrap_err().is_fallback());
    client.close();
}

#[tokio::test]
async fn many_chunks_transfer_concurrently_over_one_connection() {
    // One chunk per stream is the whole reason for using QUIC here: sixteen
    // in-flight chunks must not queue behind each other.
    let coordinator = NodeIdentity::generate();
    let payload = vec![42u8; 32_000];
    let digest = hex::encode(Sha256::digest(&payload));

    let (node, port) = start_node(&coordinator, "nod_1", payload.clone()).await;
    let client = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

    let grant = issue(&coordinator, &claims("nod_1", 10_000_000));
    let session = Arc::new(
        connect_to_node(&client, &candidate(&node, port, grant))
            .await
            .unwrap(),
    );

    let mut tasks = Vec::new();
    for _ in 0..16 {
        let session = Arc::clone(&session);
        let digest = digest.clone();
        tasks.push(tokio::spawn(async move {
            session
                .fetch_chunk("gam_1", "gfl_1", 0, &digest, 32_000)
                .await
        }));
    }

    for task in tasks {
        assert!(task.await.unwrap().is_ok());
    }
    client.close();
}
