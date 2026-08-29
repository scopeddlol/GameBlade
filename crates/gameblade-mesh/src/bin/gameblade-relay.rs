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
//!     GAMEBLADE_SERVER            https://games.example.com  (or the key below)
//!     GAMEBLADE_COORDINATOR_KEY   base64url SPKI             (or the URL above)
//!     GAMEBLADE_RELAY_PORT        47821  (default)
//!     GAMEBLADE_RELAY_MAX         256    (concurrent sessions)
//!
//! Give it the coordinator's address and it fetches the key itself, waiting
//! for the coordinator if it is not up yet — the two are usually started
//! together and whichever comes second should not have to be restarted.
//! Pasting the key in directly still works for a relay run somewhere that
//! cannot reach the coordinator over HTTP.
//!
//! It needs that public key and nothing else — no database, no credentials, no
//! API. Tickets are verified locally, which is what lets it be this small.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gameblade_mesh::identity::coordinator_key_from_spki;
use gameblade_mesh::relay::{Action, Relay, MAX_DATAGRAM};
use gameblade_mesh::MESH_RELAY_DEFAULT_PORT;
use tokio::net::UdpSocket;

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// How long to wait between attempts at a coordinator that is not up yet.
const KEY_RETRY: Duration = Duration::from_secs(5);

/// Ask the coordinator for its public key, waiting until it answers.
///
/// A relay and the coordinator it belongs to are started together, so the
/// relay routinely comes up first. Exiting for want of an answer would put it
/// in a restart loop until the other container finished booting, and the logs
/// would blame the relay.
async fn fetch_coordinator_key(server_url: &str) -> String {
    #[derive(serde::Deserialize)]
    struct Published {
        #[serde(rename = "publicKey")]
        public_key: String,
    }

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("an HTTP client with only a timeout set always builds");

    loop {
        let response = http
            .get(format!("{server_url}/api/mesh/coordinator-key"))
            .send()
            .await;

        match response {
            Ok(response) if response.status().is_success() => {
                match response.json::<Published>().await {
                    Ok(body) if !body.public_key.trim().is_empty() => return body.public_key,
                    Ok(_) => eprintln!("the coordinator published an empty key; retrying"),
                    Err(err) => eprintln!("could not read the coordinator's key: {err}"),
                }
            }
            Ok(response) => eprintln!(
                "the coordinator answered {} for its key; retrying",
                response.status()
            ),
            Err(err) => eprintln!("waiting for the coordinator: {err}"),
        }

        tokio::time::sleep(KEY_RETRY).await;
    }
}

#[tokio::main]
async fn main() {
    // The address is the easy way and the key is the escape hatch, so an
    // operator supplies one or the other rather than looking a value up by
    // hand for a component that should just be running.
    println!("GameBlade relay");

    let key = match std::env::var("GAMEBLADE_COORDINATOR_KEY") {
        Ok(value) if !value.trim().is_empty() => {
            println!("  key:         from the environment");
            value
        }
        _ => {
            let server_url = match std::env::var("GAMEBLADE_SERVER") {
                Ok(value) if !value.trim().is_empty() => {
                    value.trim().trim_end_matches('/').to_string()
                }
                _ => {
                    eprintln!(
                        "Set GAMEBLADE_SERVER to the coordinator's address, or \
                         GAMEBLADE_COORDINATOR_KEY to its public key."
                    );
                    std::process::exit(2);
                }
            };
            println!("  coordinator: {server_url}");
            let fetched = fetch_coordinator_key(&server_url).await;
            println!("  key:         taken from the coordinator");
            fetched
        }
    };

    let coordinator = match coordinator_key_from_spki(&key) {
        Ok(key) => key,
        Err(err) => {
            eprintln!("the coordinator's public key is not usable: {err}");
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

    println!("  listening:   0.0.0.0:{port}/udp");
    println!("  sessions:    up to {max_sessions}");

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
