//! The GameBlade relay.
//!
//! Runs beside the coordinator on a host with a public address, and exists for
//! the clients whose NAT defeats hole punching. Both ends dial outward to it —
//! which always works — and it pastes them together.
//!
//! It moves bytes and nothing else. The QUIC session runs end to end between
//! client and node, so what passes through is ciphertext: it never terminates
//! TLS, never sees a game file, and holds nothing but a table of which two
//! sockets belong together.
//!
//!     GAMEBLADE_COORDINATOR_KEY   base64url SPKI, from Admin → Nodes (required)
//!     GAMEBLADE_RELAY_PORT        47821  (default)
//!     GAMEBLADE_RELAY_MAX         256    (concurrent sessions)
//!
//! It needs the coordinator's public key and nothing else — no database, no
//! credentials, no API. Tickets are verified locally, which is what lets it be
//! this small.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gameblade_mesh::identity::coordinator_key_from_spki;
use gameblade_mesh::relay::{Action, Relay, MAX_DATAGRAM};
use gameblade_mesh::MESH_RELAY_DEFAULT_PORT;
use tokio::net::UdpSocket;

fn required(name: &str) -> String {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            eprintln!("{name} must be set. See the comment at the top of this binary.");
            std::process::exit(2);
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tokio::main]
async fn main() {
    let key = required("GAMEBLADE_COORDINATOR_KEY");
    let coordinator = match coordinator_key_from_spki(&key) {
        Ok(key) => key,
        Err(err) => {
            eprintln!("GAMEBLADE_COORDINATOR_KEY is not usable: {err}");
            std::process::exit(2);
        }
    };

    let port: u16 = std::env::var("GAMEBLADE_RELAY_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(MESH_RELAY_DEFAULT_PORT);

    let max_sessions: usize = std::env::var("GAMEBLADE_RELAY_MAX")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(256);

    let socket = match UdpSocket::bind(("0.0.0.0", port)).await {
        Ok(socket) => socket,
        Err(err) => {
            eprintln!("could not bind UDP {port}: {err}");
            std::process::exit(1);
        }
    };

    println!("GameBlade relay");
    println!("  listening: 0.0.0.0:{port}/udp");
    println!("  sessions:  up to {max_sessions}");

    let mut relay = Relay::new(coordinator, max_sessions);
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    let mut sweep = tokio::time::interval(Duration::from_secs(15));

    loop {
        tokio::select! {
            // Biased so packets are never starved by housekeeping under load.
            biased;

            received = socket.recv_from(&mut buffer) => {
                let Ok((length, from)) = received else { continue };
                let packet = &buffer[..length];

                match relay.handle(from, packet, now_unix()) {
                    Action::Forward(peer) => {
                        // A send that fails is one datagram lost, and QUIC will
                        // retransmit; tearing the session down over it would be
                        // a far worse response than dropping a packet.
                        let _ = socket.send_to(packet, peer).await;
                    }
                    Action::Paired => {
                        println!("paired a session ({} open)", relay.session_count());
                    }
                    Action::Registered => {}
                    // Deliberately silent. Unsolicited packets arrive on any
                    // public UDP port continuously, and logging each one would
                    // turn background noise into a disk-filling problem.
                    Action::Drop(_) => {}
                }
            }

            _ = sweep.tick() => {
                let dropped = relay.sweep();
                if dropped > 0 {
                    println!("closed {dropped} idle session(s) ({} open)", relay.session_count());
                }
            }
        }
    }
}
