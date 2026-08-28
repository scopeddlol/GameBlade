//! A real relay, two real sockets, real datagrams.
//!
//! The unit tests cover the pairing rules as pure decisions. This runs the loop
//! the binary runs and checks that bytes handed to one socket come out of the
//! other — the part where a correct decision table and a wrong `send_to` still
//! add up to nothing moving.

use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use gameblade_mesh::identity::NodeIdentity;
use gameblade_mesh::relay::{hello_packet, Action, Relay, RelayTicket, Side, MAX_DATAGRAM};
use tokio::net::UdpSocket;
use tokio::sync::Mutex;

fn issue(signer: &NodeIdentity, ticket: &RelayTicket) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(ticket).unwrap());
    let signature = URL_SAFE_NO_PAD.encode(signer.sign(payload.as_bytes()));
    format!("v2.{payload}.{signature}")
}

fn ticket(session: &str, side: Side) -> RelayTicket {
    RelayTicket {
        session_id: session.to_string(),
        node_id: "nod_1".into(),
        user_id: "usr_1".into(),
        side,
        // Far enough out that a slow test machine cannot expire it.
        expires_at: i64::MAX,
    }
}

/// Start a relay on an ephemeral port, running the binary's own loop.
async fn start_relay(coordinator: &NodeIdentity, max_sessions: usize) -> u16 {
    let socket = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let port = socket.local_addr().unwrap().port();

    let relay = Arc::new(Mutex::new(Relay::new(
        coordinator.public_key(),
        max_sessions,
    )));

    tokio::spawn(async move {
        let mut buffer = vec![0u8; MAX_DATAGRAM];
        loop {
            let Ok((length, from)) = socket.recv_from(&mut buffer).await else {
                continue;
            };
            let packet = &buffer[..length];

            let action = relay.lock().await.handle(from, packet, 0);
            if let Action::Forward(peer) = action {
                let _ = socket.send_to(packet, peer).await;
            }
        }
    });

    port
}

/// Receive with a bound, so a failure is a failed assertion rather than a hang.
async fn recv(socket: &UdpSocket) -> Option<Vec<u8>> {
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    match tokio::time::timeout(Duration::from_secs(2), socket.recv_from(&mut buffer)).await {
        Ok(Ok((length, _))) => Some(buffer[..length].to_vec()),
        _ => None,
    }
}

#[tokio::test]
async fn bytes_handed_to_one_end_come_out_of_the_other() {
    let coordinator = NodeIdentity::generate();
    let port = start_relay(&coordinator, 64).await;
    let relay_addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let client = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let node = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();

    client
        .send_to(
            &hello_packet(&issue(&coordinator, &ticket("s1", Side::Client))),
            relay_addr,
        )
        .await
        .unwrap();
    node.send_to(
        &hello_packet(&issue(&coordinator, &ticket("s1", Side::Node))),
        relay_addr,
    )
    .await
    .unwrap();

    // Give the relay a moment to pair before sending traffic.
    tokio::time::sleep(Duration::from_millis(100)).await;

    client
        .send_to(b"a chunk of a game", relay_addr)
        .await
        .unwrap();
    assert_eq!(
        recv(&node).await.as_deref(),
        Some(&b"a chunk of a game"[..])
    );

    node.send_to(b"and the reply", relay_addr).await.unwrap();
    assert_eq!(recv(&client).await.as_deref(), Some(&b"and the reply"[..]));
}

#[tokio::test]
async fn the_relay_forwards_without_altering_anything() {
    // It carries an encrypted QUIC session, so a relay that rewrote even one
    // byte would break every transfer through it in a way that looked like
    // corruption somewhere else entirely.
    let coordinator = NodeIdentity::generate();
    let port = start_relay(&coordinator, 64).await;
    let relay_addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let client = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let node = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();

    client
        .send_to(
            &hello_packet(&issue(&coordinator, &ticket("s2", Side::Client))),
            relay_addr,
        )
        .await
        .unwrap();
    node.send_to(
        &hello_packet(&issue(&coordinator, &ticket("s2", Side::Node))),
        relay_addr,
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Bytes that look like QUIC, including a zero and a high bit set.
    let payload: Vec<u8> = (0..=255u8).collect();
    client.send_to(&payload, relay_addr).await.unwrap();

    assert_eq!(recv(&node).await, Some(payload));
}

#[tokio::test]
async fn a_sender_without_a_valid_ticket_gets_nothing_through() {
    let coordinator = NodeIdentity::generate();
    let impostor = NodeIdentity::generate();
    let port = start_relay(&coordinator, 64).await;
    let relay_addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let client = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let node = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();

    // A properly paired session for the node to be listening on.
    node.send_to(
        &hello_packet(&issue(&coordinator, &ticket("s3", Side::Node))),
        relay_addr,
    )
    .await
    .unwrap();

    // The client's ticket is signed by somebody else.
    client
        .send_to(
            &hello_packet(&issue(&impostor, &ticket("s3", Side::Client))),
            relay_addr,
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    client.send_to(b"let me in", relay_addr).await.unwrap();

    assert!(
        recv(&node).await.is_none(),
        "a forged ticket must not reach the far side"
    );
}

#[tokio::test]
async fn raw_traffic_from_a_stranger_reaches_nobody() {
    // The public internet sends unsolicited packets at any open UDP port. None
    // of it should be forwarded anywhere.
    let coordinator = NodeIdentity::generate();
    let port = start_relay(&coordinator, 64).await;
    let relay_addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let node = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let stranger = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();

    node.send_to(
        &hello_packet(&issue(&coordinator, &ticket("s4", Side::Node))),
        relay_addr,
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    stranger.send_to(&[0xc0; 64], relay_addr).await.unwrap();

    assert!(recv(&node).await.is_none());
}

#[tokio::test]
async fn two_sessions_do_not_cross_over() {
    // The failure that would be worst and quietest: one download's bytes
    // arriving in another's stream.
    let coordinator = NodeIdentity::generate();
    let port = start_relay(&coordinator, 64).await;
    let relay_addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let client_a = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let node_a = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let client_b = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let node_b = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();

    for (socket, session, side) in [
        (&client_a, "sa", Side::Client),
        (&node_a, "sa", Side::Node),
        (&client_b, "sb", Side::Client),
        (&node_b, "sb", Side::Node),
    ] {
        socket
            .send_to(
                &hello_packet(&issue(&coordinator, &ticket(session, side))),
                relay_addr,
            )
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(150)).await;

    client_a.send_to(b"for A", relay_addr).await.unwrap();
    client_b.send_to(b"for B", relay_addr).await.unwrap();

    assert_eq!(recv(&node_a).await.as_deref(), Some(&b"for A"[..]));
    assert_eq!(recv(&node_b).await.as_deref(), Some(&b"for B"[..]));
}

#[tokio::test]
async fn a_large_transfer_moves_every_datagram_in_order() {
    // One chunk is thousands of datagrams. Dropping or reordering them here
    // would look like a flaky link rather than a relay bug.
    let coordinator = NodeIdentity::generate();
    let port = start_relay(&coordinator, 64).await;
    let relay_addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();

    let client = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let node = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();

    client
        .send_to(
            &hello_packet(&issue(&coordinator, &ticket("s5", Side::Client))),
            relay_addr,
        )
        .await
        .unwrap();
    node.send_to(
        &hello_packet(&issue(&coordinator, &ticket("s5", Side::Node))),
        relay_addr,
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Sent one at a time and read back between sends: loopback UDP has a finite
    // buffer, and this is testing the relay rather than the kernel's queue.
    for index in 0u16..200 {
        client
            .send_to(&index.to_be_bytes(), relay_addr)
            .await
            .unwrap();

        let received = recv(&node).await.expect("every datagram should arrive");
        assert_eq!(received, index.to_be_bytes().to_vec());
    }
}
