//! The seeding runtime: registering as a peer, serving, and stopping.
//!
//! Everything here is arranged around being easy to switch off. A peer is the
//! least trusted thing in the mesh and the only one that runs on somebody
//! else's machine at their expense, so the important property is not that it
//! serves well — it is that it stops immediately and completely whenever either
//! consent is withdrawn.
//!
//! Both switches are checked before it starts and again on every heartbeat, so
//! an operator turning seeding off on the server stops every peer within one
//! interval without needing to reach any of them.

use std::sync::Arc;
use std::time::Duration;

use gameblade_mesh::{NodeIdentity, NodeServer, PublicKey};
use tokio::sync::RwLock;

use super::seeding::{InstalledChunks, SeedIndex};
use crate::api::ApiClient;
use crate::error::AppResult;

/// A running seeder.
pub struct Seeder {
    index: Arc<RwLock<SeedIndex>>,
    stop: Arc<tokio::sync::Notify>,
}

impl Seeder {
    /// Start seeding, if both switches allow it.
    ///
    /// Returns `None` when the player has not opted in, when the server refuses
    /// a peer, or when nothing can be bound. None of these are errors: not
    /// seeding is the default state and the overwhelmingly common one.
    pub async fn start(
        client: ApiClient,
        coordinator: PublicKey,
        player_opted_in: bool,
        label: String,
    ) -> Option<Arc<Self>> {
        if !player_opted_in {
            return None;
        }

        let identity = NodeIdentity::generate();

        // Port 0 rather than the well-known one. A player is not going to
        // forward a port, and asking their firewall for a fixed one is exactly
        // the kind of prompt this design exists to avoid. It means a peer only
        // works where hole punching works, which is the right trade for a
        // source nobody is relying on.
        let endpoint = gameblade_mesh::MeshEndpoint::node(identity.clone(), 0).ok()?;
        let port = endpoint.local_addr().ok()?.port();

        let local = local_addresses(port);

        // The server decides whether it will have a peer at all. A refusal here
        // is final until an operator changes their mind, so it is not retried.
        let registration = client
            .register_peer(&identity.public_key_base64(), &label, &local)
            .await
            .ok()?;

        let index = Arc::new(RwLock::new(SeedIndex::new()));
        let store = Arc::new(InstalledChunks::new(Arc::clone(&index)));
        let server = Arc::new(NodeServer::new(
            registration.node_id.clone(),
            store,
            coordinator,
        ));

        let stop = Arc::new(tokio::sync::Notify::new());

        // Accept loop.
        {
            let stop = Arc::clone(&stop);
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::select! {
                        _ = stop.notified() => {
                            endpoint.close();
                            return;
                        }
                        incoming = endpoint.inner().accept() => {
                            let Some(incoming) = incoming else {
                                return;
                            };
                            let server = Arc::clone(&server);
                            tauri::async_runtime::spawn(async move {
                                if let Ok(connection) = incoming.await {
                                    server.serve(connection).await;
                                }
                            });
                        }
                    }
                }
            });
        }

        // Heartbeat loop, which is also the kill switch.
        {
            let index = Arc::clone(&index);
            let stop = Arc::clone(&stop);
            let client = client.clone();
            let node_id = registration.node_id.clone();
            let node_token = registration.node_token.clone();
            let interval = Duration::from_secs(registration.heartbeat_seconds.clamp(10, 300));

            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::select! {
                        _ = stop.notified() => return,
                        _ = tokio::time::sleep(interval) => {}
                    }

                    let games: Vec<(String, String)> = {
                        let guard = index.read().await;
                        guard
                            .game_ids()
                            .into_iter()
                            .filter_map(|id| guard.content_hash(&id).map(|hash| (id, hash)))
                            .collect()
                    };

                    // A heartbeat the server rejects means it no longer wants
                    // this peer — the setting went off, an administrator
                    // blocked it, the account signed out. Stopping is the only
                    // correct response, and stopping quickly is the point.
                    if client
                        .peer_heartbeat(&node_id, &node_token, &games)
                        .await
                        .is_err()
                    {
                        stop.notify_waiters();
                        return;
                    }
                }
            });
        }

        Some(Arc::new(Self { index, stop }))
    }

    pub fn index(&self) -> Arc<RwLock<SeedIndex>> {
        Arc::clone(&self.index)
    }

    /// Stop serving, now.
    ///
    /// Clears what is on offer before signalling, so nothing can be served in
    /// the window between the two — a connection already accepted will find an
    /// empty index rather than a live one.
    pub async fn stop(&self, client: &ApiClient) -> AppResult<()> {
        self.index.write().await.clear();
        self.stop.notify_waiters();

        // Best effort: the peer is already dead locally, and the coordinator
        // would time it out within ninety seconds anyway.
        let _ = client.withdraw_peer().await;
        Ok(())
    }
}

/// The addresses this machine can offer.
///
/// Only what can be seen locally. A peer cannot know its own public address,
/// and the coordinator adds what it observes — which is the candidate most
/// likely to be the useful one.
fn local_addresses(port: u16) -> Vec<(String, u16)> {
    // Deliberately not enumerating every interface. A LAN address is worth
    // sending because two players in one house is a real case and by far the
    // fastest path available; everything else is the coordinator's job.
    let mut addresses = Vec::new();

    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        // Connecting a UDP socket sends nothing; it just asks the routing table
        // which local address would be used to reach the internet, which is the
        // only reliable way to pick the right interface on a machine with
        // several.
        if socket.connect("192.0.2.1:9").is_ok() {
            if let Ok(local) = socket.local_addr() {
                addresses.push((local.ip().to_string(), port));
            }
        }
    }

    addresses
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_player_who_has_not_opted_in_never_registers() {
        // The check is first, before a socket is bound or the server is asked
        // anything: not seeding should cost nothing and touch nothing.
        let client = ApiClient::new("http://localhost:9", None).unwrap();
        let coordinator = NodeIdentity::generate().public_key();

        assert!(Seeder::start(client, coordinator, false, "PC".into())
            .await
            .is_none());
    }

    #[tokio::test]
    async fn a_server_that_refuses_a_peer_is_not_argued_with() {
        // Nothing answers on port 9, standing in for a server with seeding
        // switched off. The refusal is final until an operator changes it.
        let client = ApiClient::new("http://localhost:9", None).unwrap();
        let coordinator = NodeIdentity::generate().public_key();

        assert!(Seeder::start(client, coordinator, true, "PC".into())
            .await
            .is_none());
    }

    #[test]
    fn local_addresses_are_offered_with_the_bound_port() {
        let addresses = local_addresses(51_000);

        // A machine with no route out has nothing to offer, which is fine.
        for (address, port) in &addresses {
            assert_eq!(*port, 51_000);
            assert!(!address.is_empty());
        }
    }
}
