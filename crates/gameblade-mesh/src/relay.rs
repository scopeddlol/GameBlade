//! Pairing two ends of a transfer that could not reach each other directly.
//!
//! Hole punching needs both NATs to cooperate and some do not. When that
//! happens there is exactly one thing both ends can still do: dial outward to
//! something with a public address. This is that something.
//!
//! It is deliberately the least clever component in the system. It never
//! terminates TLS, never parses a chunk request, never learns which game is
//! moving through it, and holds no state beyond "these two sockets belong
//! together". The QUIC session runs end to end between the client and the node,
//! so what passes through here is ciphertext the relay could not read if it
//! wanted to — and every guarantee made elsewhere survives untouched: the
//! client still pins the node's identity, the node still checks the grant, the
//! client still verifies every chunk against its hash.
//!
//! That is not modesty for its own sake. A relay that understood the protocol
//! would be a second implementation of it to keep in agreement, and a relay that
//! could read the traffic would be a new place for an archive to leak from.
//!
//! # Pairing
//!
//! The coordinator issues two tickets sharing a session id — one to the client,
//! one to the node — and both send theirs to the relay before any QUIC. The
//! first packet from an unrecognised address is read as a hello; everything
//! from a recognised one is forwarded to its partner. That rule is what keeps
//! the two kinds of packet apart without having to guess at their contents.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

use crate::error::{MeshError, MeshResult};
use crate::identity::PublicKey;

/// Prefixes the hello so a malformed one cannot be mistaken for traffic.
pub const HELLO_MAGIC: &[u8] = b"GBRELAY1";

/// How long a paired session survives with no traffic.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// How long a half-open session waits for its other end.
///
/// Short. The coordinator wakes both sides at the same moment, so an end that
/// has not arrived within this has not been delayed — it is not coming.
pub const PAIRING_TIMEOUT: Duration = Duration::from_secs(20);

/// The largest datagram this will forward.
///
/// QUIC keeps to path MTU, so anything approaching this is not QUIC. Bounded
/// because the buffer is allocated per relay, not per packet.
pub const MAX_DATAGRAM: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Client,
    Node,
}

impl Side {
    fn other(self) -> Self {
        match self {
            Side::Client => Side::Node,
            Side::Node => Side::Client,
        }
    }
}

/// What the coordinator signed to admit one end of one transfer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayTicket {
    pub session_id: String,
    pub node_id: String,
    pub user_id: String,
    pub side: Side,
    /// Unix seconds.
    pub expires_at: i64,
}

/// Verify a ticket against the coordinator's public key.
///
/// The same wire format as grants and download tokens, and verified the same
/// way: signature first, then the payload. A relay holds only the public half,
/// so it can tell that the coordinator admitted someone and can admit nobody
/// itself.
pub fn verify_ticket(
    encoded: &str,
    coordinator: &PublicKey,
    now_unix: i64,
) -> MeshResult<RelayTicket> {
    let rest = encoded
        .strip_prefix("v2.")
        .ok_or_else(|| MeshError::Refused("that relay ticket is not in a known format".into()))?;

    let (payload, signature) = rest
        .split_once('.')
        .ok_or_else(|| MeshError::Refused("that relay ticket is malformed".into()))?;

    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| MeshError::Refused("that relay ticket's signature is malformed".into()))?;

    // Signature before payload, always: parsing first would mean acting on
    // fields chosen by whoever sent the packet.
    if !coordinator.verify(payload.as_bytes(), &signature) {
        return Err(MeshError::Refused(
            "that relay ticket was not signed by the coordinator".into(),
        ));
    }

    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| MeshError::Refused("that relay ticket's payload is malformed".into()))?;

    let ticket: RelayTicket = serde_json::from_slice(&decoded)
        .map_err(|_| MeshError::Refused("that relay ticket's payload is not readable".into()))?;

    if ticket.expires_at <= now_unix {
        return Err(MeshError::Refused("that relay ticket has expired".into()));
    }

    Ok(ticket)
}

/// Read a hello packet: the magic, then the ticket.
pub fn parse_hello(packet: &[u8]) -> MeshResult<&str> {
    let body = packet
        .strip_prefix(HELLO_MAGIC)
        .ok_or_else(|| MeshError::Protocol("not a relay hello".into()))?;

    std::str::from_utf8(body)
        .map(str::trim)
        .map_err(|_| MeshError::Protocol("a relay hello was not text".into()))
}

/// Build a hello packet for a ticket.
pub fn hello_packet(ticket: &str) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HELLO_MAGIC.len() + ticket.len());
    packet.extend_from_slice(HELLO_MAGIC);
    packet.extend_from_slice(ticket.as_bytes());
    packet
}

/// One transfer's two ends, however many of them have shown up.
#[derive(Debug)]
struct Session {
    client: Option<SocketAddr>,
    node: Option<SocketAddr>,
    created: Instant,
    last_seen: Instant,
    bytes: u64,
}

impl Session {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            client: None,
            node: None,
            created: now,
            last_seen: now,
            bytes: 0,
        }
    }

    fn peer(&self, side: Side) -> Option<SocketAddr> {
        match side.other() {
            Side::Client => self.client,
            Side::Node => self.node,
        }
    }

    fn set(&mut self, side: Side, address: SocketAddr) {
        match side {
            Side::Client => self.client = Some(address),
            Side::Node => self.node = Some(address),
        }
    }

    fn paired(&self) -> bool {
        self.client.is_some() && self.node.is_some()
    }

    fn expired(&self, now: Instant) -> bool {
        if self.paired() {
            now.duration_since(self.last_seen) > IDLE_TIMEOUT
        } else {
            // Never paired: its other end is not coming.
            now.duration_since(self.created) > PAIRING_TIMEOUT
        }
    }
}

/// What the relay decided to do with a packet.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Send these bytes to this address.
    Forward(SocketAddr),
    /// A hello was accepted; nothing to send yet.
    Registered,
    /// A hello was accepted and the far side is already waiting.
    Paired,
    /// Drop it, for the stated reason.
    Drop(&'static str),
}

/// The pairing table, and the rules for what to do with an arriving packet.
///
/// Pure: it takes a packet and an address and returns a decision. The socket
/// work lives in the binary, so every rule here is testable without a network.
pub struct Relay {
    coordinator: PublicKey,
    sessions: HashMap<String, Session>,
    /// Where a known address belongs, so forwarding is a lookup rather than a
    /// scan of every session on every packet.
    known: HashMap<SocketAddr, (String, Side)>,
    max_sessions: usize,
}

impl Relay {
    pub fn new(coordinator: PublicKey, max_sessions: usize) -> Self {
        Self {
            coordinator,
            sessions: HashMap::new(),
            known: HashMap::new(),
            max_sessions,
        }
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// Decide what to do with a datagram.
    ///
    /// A packet from a known address is traffic and is forwarded without being
    /// looked at. A packet from an unknown one must be a hello — which is what
    /// keeps the two apart without inspecting contents that are, by design,
    /// encrypted.
    pub fn handle(&mut self, from: SocketAddr, packet: &[u8], now_unix: i64) -> Action {
        if let Some((session_id, side)) = self.known.get(&from).cloned() {
            let Some(session) = self.sessions.get_mut(&session_id) else {
                // The session expired underneath this address.
                self.known.remove(&from);
                return Action::Drop("session gone");
            };

            session.last_seen = Instant::now();
            session.bytes = session.bytes.saturating_add(packet.len() as u64);

            return match session.peer(side) {
                Some(peer) => Action::Forward(peer),
                // Half-open: the other end has not arrived. Dropping is right —
                // there is nowhere to put it, and QUIC will retransmit.
                None => Action::Drop("no peer yet"),
            };
        }

        let Ok(encoded) = parse_hello(packet) else {
            return Action::Drop("unknown sender, and not a hello");
        };

        let ticket = match verify_ticket(encoded, &self.coordinator, now_unix) {
            Ok(ticket) => ticket,
            Err(_) => return Action::Drop("bad ticket"),
        };

        // Bounded before inserting, so a flood of valid tickets cannot grow the
        // table without limit.
        if !self.sessions.contains_key(&ticket.session_id)
            && self.sessions.len() >= self.max_sessions
        {
            return Action::Drop("relay is full");
        }

        let session = self
            .sessions
            .entry(ticket.session_id.clone())
            .or_insert_with(Session::new);

        // A side re-sending its hello — a lost first packet, a client that
        // restarted — replaces the address rather than being refused, so a
        // retry recovers instead of stranding the session half-open.
        session.set(ticket.side, from);
        session.last_seen = Instant::now();
        self.known
            .insert(from, (ticket.session_id.clone(), ticket.side));

        if self.sessions[&ticket.session_id].paired() {
            Action::Paired
        } else {
            Action::Registered
        }
    }

    /// Drop sessions that timed out. Returns how many went.
    pub fn sweep(&mut self) -> usize {
        let now = Instant::now();
        let dead: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| session.expired(now))
            .map(|(id, _)| id.clone())
            .collect();

        for id in &dead {
            self.sessions.remove(id);
        }
        // Addresses belonging to a session that is gone go with it, or the
        // table grows for the life of the process.
        self.known.retain(|_, (id, _)| !dead.contains(id));

        dead.len()
    }

    /// Bytes carried for one session, for logging what the relay actually cost.
    pub fn bytes_for(&self, session_id: &str) -> u64 {
        self.sessions.get(session_id).map_or(0, |s| s.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::NodeIdentity;

    fn issue(signer: &NodeIdentity, ticket: &RelayTicket) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(ticket).unwrap());
        let signature = URL_SAFE_NO_PAD.encode(signer.sign(payload.as_bytes()));
        format!("v2.{payload}.{signature}")
    }

    fn ticket(side: Side) -> RelayTicket {
        RelayTicket {
            session_id: "sess_1".into(),
            node_id: "nod_1".into(),
            user_id: "usr_1".into(),
            side,
            expires_at: 10_000,
        }
    }

    fn client_addr() -> SocketAddr {
        "203.0.113.5:40000".parse().unwrap()
    }
    fn node_addr() -> SocketAddr {
        "198.51.100.9:47820".parse().unwrap()
    }

    #[test]
    fn a_ticket_signed_by_the_coordinator_verifies() {
        let coordinator = NodeIdentity::generate();
        let encoded = issue(&coordinator, &ticket(Side::Client));

        let parsed = verify_ticket(&encoded, &coordinator.public_key(), 1_000).unwrap();
        assert_eq!(parsed.session_id, "sess_1");
        assert_eq!(parsed.side, Side::Client);
    }

    #[test]
    fn a_ticket_signed_by_anyone_else_does_not() {
        // A relay holds only the public half, so it can tell that the
        // coordinator admitted someone and can admit nobody itself.
        let coordinator = NodeIdentity::generate();
        let impostor = NodeIdentity::generate();
        let encoded = issue(&impostor, &ticket(Side::Client));

        assert!(verify_ticket(&encoded, &coordinator.public_key(), 1_000).is_err());
    }

    #[test]
    fn an_expired_ticket_is_refused() {
        let coordinator = NodeIdentity::generate();
        let encoded = issue(&coordinator, &ticket(Side::Client));

        assert!(verify_ticket(&encoded, &coordinator.public_key(), 10_001).is_err());
    }

    #[test]
    fn a_hello_round_trips() {
        let packet = hello_packet("v2.abc.def");
        assert_eq!(parse_hello(&packet).unwrap(), "v2.abc.def");
    }

    #[test]
    fn a_quic_looking_packet_is_not_read_as_a_hello() {
        // The rule that keeps the two kinds apart: only the magic makes a hello.
        assert!(parse_hello(&[0xc0, 0x00, 0x00, 0x00, 0x01]).is_err());
    }

    #[test]
    fn two_ends_pair_and_then_forward_to_each_other() {
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 100);

        let client_hello = hello_packet(&issue(&coordinator, &ticket(Side::Client)));
        let node_hello = hello_packet(&issue(&coordinator, &ticket(Side::Node)));

        assert_eq!(
            relay.handle(client_addr(), &client_hello, 1_000),
            Action::Registered
        );
        assert_eq!(
            relay.handle(node_addr(), &node_hello, 1_000),
            Action::Paired
        );

        // Now traffic goes each way without being inspected.
        assert_eq!(
            relay.handle(client_addr(), &[0xc0; 64], 1_000),
            Action::Forward(node_addr())
        );
        assert_eq!(
            relay.handle(node_addr(), &[0xc0; 64], 1_000),
            Action::Forward(client_addr())
        );
    }

    #[test]
    fn traffic_before_the_other_end_arrives_is_dropped() {
        // There is nowhere to put it, and QUIC retransmits.
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 100);

        let hello = hello_packet(&issue(&coordinator, &ticket(Side::Client)));
        relay.handle(client_addr(), &hello, 1_000);

        assert_eq!(
            relay.handle(client_addr(), &[0xc0; 32], 1_000),
            Action::Drop("no peer yet")
        );
    }

    #[test]
    fn a_stranger_with_no_ticket_is_dropped() {
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 100);

        assert_eq!(
            relay.handle(client_addr(), &[0xc0; 64], 1_000),
            Action::Drop("unknown sender, and not a hello")
        );
        assert_eq!(relay.session_count(), 0);
    }

    #[test]
    fn a_forged_ticket_opens_nothing() {
        let coordinator = NodeIdentity::generate();
        let impostor = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 100);

        let forged = hello_packet(&issue(&impostor, &ticket(Side::Client)));

        assert_eq!(
            relay.handle(client_addr(), &forged, 1_000),
            Action::Drop("bad ticket")
        );
        assert_eq!(relay.session_count(), 0);
    }

    #[test]
    fn a_resent_hello_updates_the_address_rather_than_being_refused() {
        // A lost first packet, or a client that restarted. Refusing would strand
        // the session half-open for no reason.
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 100);

        let client_hello = hello_packet(&issue(&coordinator, &ticket(Side::Client)));
        let node_hello = hello_packet(&issue(&coordinator, &ticket(Side::Node)));

        relay.handle(client_addr(), &client_hello, 1_000);
        relay.handle(node_addr(), &node_hello, 1_000);

        let moved: SocketAddr = "203.0.113.5:41111".parse().unwrap();
        assert_eq!(relay.handle(moved, &client_hello, 1_000), Action::Paired);

        assert_eq!(
            relay.handle(node_addr(), &[0xc0; 16], 1_000),
            Action::Forward(moved)
        );
    }

    #[test]
    fn the_session_table_is_bounded() {
        // Otherwise a flood of valid tickets grows it without limit.
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 2);

        for index in 0..4 {
            let mut spec = ticket(Side::Client);
            spec.session_id = format!("sess_{index}");
            let hello = hello_packet(&issue(&coordinator, &spec));
            let from: SocketAddr = format!("203.0.113.5:{}", 40_000 + index).parse().unwrap();
            relay.handle(from, &hello, 1_000);
        }

        assert_eq!(relay.session_count(), 2);
    }

    #[test]
    fn a_full_relay_still_serves_the_sessions_it_has() {
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 1);

        let client_hello = hello_packet(&issue(&coordinator, &ticket(Side::Client)));
        let node_hello = hello_packet(&issue(&coordinator, &ticket(Side::Node)));
        relay.handle(client_addr(), &client_hello, 1_000);
        // The node joining an existing session is not a new session.
        assert_eq!(
            relay.handle(node_addr(), &node_hello, 1_000),
            Action::Paired
        );
    }

    #[test]
    fn sweeping_forgets_the_addresses_of_dead_sessions_too() {
        // Otherwise the address table grows for the life of the process even as
        // sessions come and go.
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 100);

        let hello = hello_packet(&issue(&coordinator, &ticket(Side::Client)));
        relay.handle(client_addr(), &hello, 1_000);
        assert_eq!(relay.session_count(), 1);

        // Reach past the pairing timeout without waiting it out.
        if let Some(session) = relay.sessions.get_mut("sess_1") {
            session.created = Instant::now() - PAIRING_TIMEOUT - Duration::from_secs(1);
        }

        assert_eq!(relay.sweep(), 1);
        assert_eq!(relay.session_count(), 0);
        assert!(relay.known.is_empty());
    }

    #[test]
    fn a_paired_session_survives_the_pairing_timeout() {
        // Pairing is only short because an absent end is not coming; a working
        // transfer must not be cut off by the same clock.
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 100);

        relay.handle(
            client_addr(),
            &hello_packet(&issue(&coordinator, &ticket(Side::Client))),
            1_000,
        );
        relay.handle(
            node_addr(),
            &hello_packet(&issue(&coordinator, &ticket(Side::Node))),
            1_000,
        );

        if let Some(session) = relay.sessions.get_mut("sess_1") {
            session.created = Instant::now() - PAIRING_TIMEOUT - Duration::from_secs(1);
        }

        assert_eq!(relay.sweep(), 0);
        assert_eq!(relay.session_count(), 1);
    }

    #[test]
    fn bytes_are_counted_so_the_relay_can_say_what_it_cost() {
        let coordinator = NodeIdentity::generate();
        let mut relay = Relay::new(coordinator.public_key(), 100);

        relay.handle(
            client_addr(),
            &hello_packet(&issue(&coordinator, &ticket(Side::Client))),
            1_000,
        );
        relay.handle(
            node_addr(),
            &hello_packet(&issue(&coordinator, &ticket(Side::Node))),
            1_000,
        );

        relay.handle(client_addr(), &[0u8; 100], 1_000);
        relay.handle(node_addr(), &[0u8; 250], 1_000);

        assert_eq!(relay.bytes_for("sess_1"), 350);
    }
}
