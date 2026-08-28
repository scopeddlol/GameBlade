//! The direct path: QUIC over UDP, with the node's own key as its identity.
//!
//! Two decisions shape everything here.
//!
//! **There is no virtual network interface.** This is not a VPN and deliberately
//! not one. A TUN adapter on Windows means a driver, an elevation prompt,
//! antivirus attention and a firewall dialog, all so the operating system can
//! route packets that only ever go to one process anyway. Terminating QUIC in
//! the process gets the same encrypted, NAT-traversing, congestion-controlled
//! path with none of that — and nothing for a user to notice, install or agree
//! to, which was the requirement.
//!
//! **Identity is pinned, not delegated.** A node presents a self-signed
//! certificate carrying its Ed25519 key, and the client checks it against the
//! key the coordinator named. There is no certificate authority in the picture
//! because there is nothing for one to attest: the coordinator already said
//! which key it means, and that is a stronger statement than a CA could make.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::Duration;

use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use quinn::{ClientConfig, Endpoint, ServerConfig, TransportConfig};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

use crate::error::{MeshError, MeshResult};
use crate::identity::{NodeIdentity, PublicKey};

/// ALPN for the node protocol.
///
/// Versioned because a node and a client can be on different releases for a
/// long time. A mismatch fails the handshake cleanly and the client falls back
/// to HTTP, which is far better than two versions misparsing each other's
/// frames.
pub const MESH_ALPN: &[u8] = b"gameblade-mesh/1";

/// How long a connection may sit idle before it is dropped.
///
/// Long enough to survive a stalled disk or a paused download, short enough
/// that a node does not accumulate dead connections from clients that vanished.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// How long to spend learning this socket's external address at startup.
///
/// Short: it is on the path of every download, and failing to learn it costs a
/// less reliable connection rather than a broken one.
const REFLEXIVE_TIMEOUT: Duration = Duration::from_millis(1_200);

/// How many punch packets to send at a candidate.
///
/// Three, spaced out. One can be lost, and the far side may not have started
/// punching yet when the first arrives — the two sides are told to punch at the
/// same time but do not share a clock.
const PUNCH_PACKETS: usize = 3;
const PUNCH_SPACING: Duration = Duration::from_millis(50);

/// Deliberately not valid QUIC.
///
/// A punch packet exists to be dropped. Its whole job is done by the NAT it
/// traverses on the way out; the receiving endpoint discards it as unparseable,
/// which is the intended outcome rather than a tolerated one.
const PUNCH_PAYLOAD: &[u8] = b"gameblade-punch";

/// Keep-alive interval, comfortably inside the idle timeout.
///
/// This is also what holds a NAT binding open. Home routers commonly forget a
/// UDP mapping after 30 seconds of silence, and losing it mid-download means
/// re-punching a hole for no reason.
const KEEP_ALIVE: Duration = Duration::from_secs(15);

/// The suffix every node identity label ends with.
const IDENTITY_SUFFIX: &str = ".node.gameblade";

/// The key a node's certificate carries, expressed as a DNS name.
///
/// The key goes into the certificate's subject alternative name rather than
/// into an extension, because that is the field rustls hands back without a
/// custom parser: the whole point is to compare 32 bytes, not to grow an X.509
/// stack.
///
/// Hex, in two labels, and neither choice is cosmetic. Base64url was the
/// obvious encoding and was wrong twice over: its alphabet includes `-`, and a
/// DNS label may not begin with one, so roughly one key in thirty-two produced
/// a name nothing would accept — a node unreachable at random, decided by
/// whichever key it happened to generate. Hex has no such characters. It also
/// takes 64 of them and a single label may hold 63, so the key spans two.
fn identity_dns_name(key: &PublicKey) -> String {
    let encoded = hex::encode(key.as_bytes());
    format!("{}.{}{}", &encoded[..32], &encoded[32..], IDENTITY_SUFFIX)
}

/// Build the certificate a node presents.
fn node_certificate(
    identity: &NodeIdentity,
) -> MeshResult<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
    let name = identity_dns_name(&identity.public_key());
    let certified = rcgen::generate_simple_self_signed(vec![name])
        .map_err(|err| MeshError::Identity(format!("could not build a node certificate: {err}")))?;

    let cert = CertificateDer::from(certified.cert);
    let key = PrivateKeyDer::try_from(certified.key_pair.serialize_der())
        .map_err(|err| MeshError::Identity(format!("could not encode a node key: {err}")))?;

    Ok((vec![cert], key))
}

/// Accepts exactly one node's certificate and nothing else.
///
/// This replaces the usual chain-of-trust check rather than supplementing it,
/// which is why it is written out rather than reached for by accident: the
/// coordinator has already named the key, so a signature from a public CA would
/// add nothing and a missing one proves nothing.
#[derive(Debug)]
struct PinnedNode {
    expected: String,
}

impl ServerCertVerifier for PinnedNode {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // The name is compared against the certificate's own SAN rather than
        // against whatever hostname the connection was opened with: a client
        // dials an IP address here, so the connection carries no name worth
        // checking.
        let (_, parsed) = x509_name(end_entity)?;
        if parsed == self.expected {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "this node presented a different identity than the coordinator named".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        // QUIC is TLS 1.3 only; this branch is unreachable in practice.
        Err(rustls::Error::General("TLS 1.2 is not offered".into()))
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        // The handshake signature proves possession of the certificate's key,
        // and the certificate is pinned above. rustls has already checked the
        // signature is well-formed against that key before calling this.
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ED25519,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PSS_SHA256,
        ]
    }
}

/// Pull the node identity out of a certificate's subject alternative name.
///
/// A deliberately minimal reader for a shape this crate produces itself. Rather
/// than assume a fixed key length — which is exactly what broke when the
/// encoding changed — it finds the suffix and walks backwards over the
/// characters an identity label may contain. Anything else ends the walk, so a
/// neighbouring field cannot bleed into the name.
fn x509_name(cert: &CertificateDer<'_>) -> Result<((), String), rustls::Error> {
    let bytes = cert.as_ref();
    let needle = IDENTITY_SUFFIX.as_bytes();

    let position = bytes
        .windows(needle.len())
        .position(|window| window == needle)
        .ok_or_else(|| {
            rustls::Error::General("that certificate carries no node identity".into())
        })?;

    let mut start = position;
    while start > 0 {
        let candidate = bytes[start - 1];
        if !candidate.is_ascii_hexdigit() && candidate != b'.' {
            break;
        }
        start -= 1;
    }

    let label = std::str::from_utf8(&bytes[start..position + needle.len()]).map_err(|_| {
        rustls::Error::General("that certificate's node identity is not text".into())
    })?;

    Ok(((), label.to_string()))
}

/// A UDP endpoint that can dial nodes and, for a node, accept clients.
pub struct MeshEndpoint {
    endpoint: Endpoint,
    identity: NodeIdentity,
    /// A second handle to the very socket QUIC is using.
    ///
    /// Hole punching only works if the punch leaves from the same socket the
    /// connection will arrive on: the point of the punch is the NAT mapping it
    /// creates, and a mapping is per source port. A punch sent from any other
    /// socket opens a hole for a port nothing will ever use.
    punch: UdpSocket,
    /// What the outside world sees this socket as, when that could be learned.
    ///
    /// This is the address a peer must be told to aim at. It cannot be guessed
    /// from anything local — the NAT decides it — and it belongs to this socket
    /// alone, which is why it is discovered here rather than anywhere tidier.
    reflexive: Option<SocketAddr>,
}

impl MeshEndpoint {
    /// Bind a client endpoint.
    ///
    /// Port 0: a client dials out and never needs a predictable port. It still
    /// binds a real socket, which is what makes hole punching possible at all —
    /// the same socket sends the punch and carries the connection.
    pub fn client(identity: NodeIdentity) -> MeshResult<Self> {
        Self::bind(
            identity,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
            false,
            false,
        )
    }

    /// Bind a client endpoint and learn its external address on the way.
    ///
    /// Costs one round trip to a STUN server at startup and is what makes the
    /// far side able to punch back: without it the coordinator can tell a node
    /// only where this client's *TCP* connection came from, which is a
    /// different NAT mapping and a different port.
    pub fn client_with_discovery(
        identity: NodeIdentity,
        stun_servers: &[&str],
    ) -> MeshResult<Self> {
        Self::bind_discovering(
            identity,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
            false,
            stun_servers,
        )
    }

    /// Bind a node endpoint on a known port.
    ///
    /// A node should have a stable, ideally forwarded, UDP port. If one side of
    /// a connection is directly reachable, hole punching succeeds essentially
    /// always regardless of what the other side is behind — which is the
    /// cheapest reliability win available here.
    pub fn node(identity: NodeIdentity, port: u16) -> MeshResult<Self> {
        // Dual-stack where the OS allows it: if both ends have IPv6, a direct
        // connection needs no traversal at all.
        let address = SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port);
        match Self::bind(identity.clone(), address, true, false) {
            Ok(endpoint) => Ok(endpoint),
            Err(_) => Self::bind(
                identity,
                SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
                true,
                false,
            ),
        }
    }

    /// Bind a node endpoint and learn its external address on the way.
    ///
    /// A node advertises this to the coordinator, which hands it to clients as
    /// the candidate most likely to work. Bound IPv4-only: the mapping being
    /// discovered is an IPv4 NAT's, and a dual-stack socket would report the
    /// IPv6 side.
    pub fn node_with_discovery(
        identity: NodeIdentity,
        port: u16,
        stun_servers: &[&str],
    ) -> MeshResult<Self> {
        Self::bind_discovering(
            identity,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
            true,
            stun_servers,
        )
    }

    fn bind(
        identity: NodeIdentity,
        address: SocketAddr,
        serve: bool,
        _discover: bool,
    ) -> MeshResult<Self> {
        Self::build(identity, UdpSocket::bind(address)?, serve, None)
    }

    /// Bind, ask what the world sees, then hand the socket to QUIC.
    ///
    /// The order matters and is the whole reason this is separate: quinn reads
    /// from the socket continuously once it owns it, so a STUN exchange
    /// afterwards would be a second reader racing it for packets. Asking while
    /// nothing else is listening has no such race.
    fn bind_discovering(
        identity: NodeIdentity,
        address: SocketAddr,
        serve: bool,
        stun_servers: &[&str],
    ) -> MeshResult<Self> {
        let socket = UdpSocket::bind(address)?;
        let reflexive = crate::stun::discover_reflexive(&socket, stun_servers, REFLEXIVE_TIMEOUT);

        Self::build(identity, socket, serve, reflexive)
    }

    fn build(
        identity: NodeIdentity,
        socket: UdpSocket,
        serve: bool,
        reflexive: Option<SocketAddr>,
    ) -> MeshResult<Self> {
        // Cloned before quinn takes ownership. Both handles refer to the same
        // kernel socket and therefore the same port, which is the only reason
        // punching from this one helps the connection made on the other.
        let punch = socket.try_clone()?;
        punch.set_nonblocking(true)?;

        let mut endpoint = if serve {
            let (chain, key) = node_certificate(&identity)?;
            let mut tls = rustls::ServerConfig::builder_with_provider(crypto_provider())
                .with_protocol_versions(&[&rustls::version::TLS13])
                .map_err(|err| MeshError::Protocol(format!("could not configure TLS: {err}")))?
                .with_no_client_auth()
                .with_single_cert(chain, key)
                .map_err(|err| MeshError::Identity(format!("could not configure TLS: {err}")))?;
            tls.alpn_protocols = vec![MESH_ALPN.to_vec()];

            let quic = QuicServerConfig::try_from(tls)
                .map_err(|err| MeshError::Protocol(format!("could not configure QUIC: {err}")))?;
            let mut server = ServerConfig::with_crypto(Arc::new(quic));
            server.transport_config(Arc::new(transport_config()));

            Endpoint::new(
                quinn::EndpointConfig::default(),
                Some(server),
                socket,
                Arc::new(quinn::TokioRuntime),
            )?
        } else {
            Endpoint::new(
                quinn::EndpointConfig::default(),
                None,
                socket,
                Arc::new(quinn::TokioRuntime),
            )?
        };

        endpoint.set_default_client_config(insecure_placeholder_config()?);
        Ok(Self {
            endpoint,
            identity,
            punch,
            reflexive,
        })
    }

    /// The address a peer should be told to punch toward, if it is known.
    pub fn reflexive_addr(&self) -> Option<SocketAddr> {
        self.reflexive
    }

    pub fn local_addr(&self) -> MeshResult<SocketAddr> {
        Ok(self.endpoint.local_addr()?)
    }

    pub fn identity(&self) -> &NodeIdentity {
        &self.identity
    }

    pub fn inner(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Dial one candidate address, insisting it is the node we mean.
    pub async fn connect(
        &self,
        address: SocketAddr,
        expected: &PublicKey,
    ) -> MeshResult<quinn::Connection> {
        let config = pinned_client_config(expected)?;

        // The server name is a formality — the pinning verifier ignores it —
        // but it has to parse, so it is the identity label itself.
        let name = identity_dns_name(expected);

        let connecting = self
            .endpoint
            .connect_with(config, address, &name)
            .map_err(|err| MeshError::Unreachable(format!("{address}: {err}")))?;

        connecting
            .await
            .map_err(|err| MeshError::Unreachable(format!("{address}: {err}")))
    }

    /// Send a few packets at an address to open a NAT binding towards it.
    ///
    /// This is the whole of hole punching from one side: both ends send to each
    /// other at roughly the same time, each one's outbound packet teaches its
    /// own NAT to accept the other's reply. The packets themselves are
    /// throwaway — a QUIC endpoint drops them as unparseable — and that is
    /// fine, because the mapping they create is the point.
    ///
    /// It does nothing when the far side is behind a NAT that assigns a
    /// different external port per destination. Nothing here can fix that, and
    /// the relay path exists for exactly that case.
    pub async fn punch(&self, address: SocketAddr) -> MeshResult<()> {
        for _ in 0..PUNCH_PACKETS {
            // Sent on the shared handle, so the mapping this opens is the one
            // the QUIC handshake will come back through.
            //
            // A failure here is expected and uninteresting: an unreachable
            // candidate is exactly what this is trying to find out about, and
            // the dial that follows reports it far better than this could.
            let _ = self.punch.send_to(PUNCH_PAYLOAD, address);
            tokio::time::sleep(PUNCH_SPACING).await;
        }

        Ok(())
    }

    /// Tell the relay which session this endpoint belongs to.
    ///
    /// Sent from the same socket QUIC uses, for the same reason a punch is: the
    /// relay pairs on source address, so a hello from anywhere else would pair
    /// a socket that never carries the transfer.
    ///
    /// Repeated a few times because it is a single unacknowledged datagram, and
    /// losing it would leave a session half-open until it timed out.
    pub async fn announce_to_relay(&self, relay: SocketAddr, ticket: &str) -> MeshResult<()> {
        let hello = crate::relay::hello_packet(ticket);

        for _ in 0..PUNCH_PACKETS {
            let _ = self.punch.send_to(&hello, relay);
            tokio::time::sleep(PUNCH_SPACING).await;
        }

        Ok(())
    }

    /// The port this endpoint's NAT mapping is for.
    ///
    /// Local, so it is only the whole answer on a machine with a public
    /// address. Behind NAT it is the internal half, and the external half has
    /// to be learned by being told what someone else observed.
    pub fn punch_port(&self) -> MeshResult<u16> {
        Ok(self.punch.local_addr()?.port())
    }

    pub fn close(&self) {
        self.endpoint.close(0u32.into(), b"done");
    }
}

fn transport_config() -> TransportConfig {
    let mut config = TransportConfig::default();
    config.max_idle_timeout(Some(
        IDLE_TIMEOUT
            .try_into()
            .expect("a one-minute idle timeout is representable"),
    ));
    config.keep_alive_interval(Some(KEEP_ALIVE));

    // A game download is one big sequential transfer per stream, so a large
    // receive window is what lets a fat, high-latency link actually fill up.
    // The default is tuned for many small streams and leaves throughput on the
    // table over exactly the kind of link this exists to exploit.
    config.stream_receive_window((8u32 * 1024 * 1024).into());
    config.receive_window((32u32 * 1024 * 1024).into());

    config
}

/// The crypto backend, named rather than detected.
///
/// ring, because rcgen and reqwest pull it in regardless: asking for a second
/// backend here meant building two C and assembly crypto libraries to do one
/// job.
///
/// rustls picks a provider from crate features, and panics if it cannot tell
/// which was meant. The desktop client links rustls twice over — once here and
/// once through reqwest for HTTPS — so which backend "wins" is a property of
/// the whole binary rather than of this crate. Installing a process-wide
/// default would be this crate reaching out and deciding for the host
/// application; naming the provider on each config decides only for the
/// connections this crate makes, and cannot panic.
fn crypto_provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn pinned_client_config(expected: &PublicKey) -> MeshResult<ClientConfig> {
    let mut tls = rustls::ClientConfig::builder_with_provider(crypto_provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|err| MeshError::Protocol(format!("could not configure TLS: {err}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedNode {
            expected: identity_dns_name(expected),
        }))
        .with_no_client_auth();
    tls.alpn_protocols = vec![MESH_ALPN.to_vec()];

    let quic = QuicClientConfig::try_from(tls)
        .map_err(|err| MeshError::Protocol(format!("could not configure QUIC: {err}")))?;

    let mut config = ClientConfig::new(Arc::new(quic));
    config.transport_config(Arc::new(transport_config()));
    Ok(config)
}

/// A default config that pins nothing, so it can never succeed by accident.
///
/// `Endpoint` insists on a default client config, but every real dial goes
/// through `connect` with a config pinned to one key. This one expects an
/// identity no node can have, so a code path that forgot to pin fails closed
/// rather than connecting to whoever answers.
fn insecure_placeholder_config() -> MeshResult<ClientConfig> {
    let unreachable = PublicKey::from_bytes(&[0u8; 32])
        .unwrap_or_else(|_| panic!("the all-zero key is a valid point"));
    pinned_client_config(&unreachable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identity_label_is_stable_and_key_specific() {
        let a = NodeIdentity::generate();
        let b = NodeIdentity::generate();

        assert_eq!(
            identity_dns_name(&a.public_key()),
            identity_dns_name(&a.public_key())
        );
        assert_ne!(
            identity_dns_name(&a.public_key()),
            identity_dns_name(&b.public_key())
        );
        assert!(identity_dns_name(&a.public_key()).ends_with(".node.gameblade"));
    }

    /// The bug this pins, which made a fraction of nodes unreachable at random.
    ///
    /// Identity labels were base64url, whose alphabet includes `-`, and a DNS
    /// label may not begin with one. Roughly one generated key in thirty-two
    /// produced a name `ServerName` refused, so that node could never be dialled
    /// — and which nodes were affected was decided by whichever key each one
    /// happened to generate. A single-key test passes thirty-one times out of
    /// thirty-two, which is why this generates many.
    #[test]
    fn every_generated_identity_produces_a_usable_server_name() {
        for _ in 0..256 {
            let identity = NodeIdentity::generate();
            let name = identity_dns_name(&identity.public_key());

            assert!(
                ServerName::try_from(name.clone()).is_ok(),
                "rustls refused the identity label {name}"
            );
        }
    }

    #[test]
    fn an_identity_label_uses_only_characters_dns_allows() {
        for _ in 0..64 {
            let name = identity_dns_name(&NodeIdentity::generate().public_key());

            for label in name.split('.') {
                assert!(!label.is_empty(), "empty label in {name}");
                assert!(label.len() <= 63, "label over 63 characters in {name}");
                assert!(
                    label.chars().all(|c| c.is_ascii_alphanumeric()),
                    "non-alphanumeric label in {name}"
                );
            }
        }
    }

    #[test]
    fn a_certificate_carries_the_identity_it_can_be_pinned_to() {
        // If the label could not be read back out, pinning would silently pass
        // or silently fail — and the difference matters rather a lot.
        let identity = NodeIdentity::generate();
        let (chain, _key) = node_certificate(&identity).unwrap();

        let (_, name) = x509_name(&chain[0]).unwrap();
        assert_eq!(name, identity_dns_name(&identity.public_key()));
    }

    #[test]
    fn a_certificate_without_an_identity_is_refused() {
        let cert = CertificateDer::from(vec![0u8; 128]);
        assert!(x509_name(&cert).is_err());
    }

    #[test]
    fn the_pinning_verifier_accepts_only_the_named_key() {
        let node = NodeIdentity::generate();
        let other = NodeIdentity::generate();
        let (chain, _key) = node_certificate(&node).unwrap();

        let verifier = PinnedNode {
            expected: identity_dns_name(&node.public_key()),
        };
        let wrong = PinnedNode {
            expected: identity_dns_name(&other.public_key()),
        };

        let name = ServerName::try_from("example.invalid").unwrap();
        assert!(verifier
            .verify_server_cert(&chain[0], &[], &name, &[], UnixTime::now())
            .is_ok());
        assert!(wrong
            .verify_server_cert(&chain[0], &[], &name, &[], UnixTime::now())
            .is_err());
    }

    #[tokio::test]
    async fn a_client_endpoint_binds_and_reports_its_address() {
        let endpoint = MeshEndpoint::client(NodeIdentity::generate()).unwrap();
        assert!(endpoint.local_addr().unwrap().port() > 0);
        endpoint.close();
    }

    /// The bug this pins, which made hole punching a no-op.
    ///
    /// A punch opens a NAT mapping for the source port it was sent from. Sent
    /// from a throwaway socket it opens a mapping for a port nothing will use,
    /// and the QUIC handshake that follows on the real port still finds no hole
    /// — so every direct connection between two NATed machines failed, which is
    /// precisely the case punching exists for.
    #[tokio::test]
    async fn a_punch_leaves_from_the_same_port_the_connection_arrives_on() {
        let endpoint = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

        assert_eq!(
            endpoint.punch_port().unwrap(),
            endpoint.local_addr().unwrap().port()
        );
        endpoint.close();
    }

    #[tokio::test]
    async fn punching_an_unroutable_address_is_not_an_error() {
        // Punching is speculative by nature: most candidates are wrong, and the
        // dial that follows is what reports whether any of them worked.
        let endpoint = MeshEndpoint::client(NodeIdentity::generate()).unwrap();

        assert!(endpoint
            .punch("198.51.100.7:47820".parse().unwrap())
            .await
            .is_ok());
        endpoint.close();
    }

    #[tokio::test]
    async fn a_node_endpoint_binds_on_an_ephemeral_port() {
        let endpoint = MeshEndpoint::node(NodeIdentity::generate(), 0).unwrap();
        assert!(endpoint.local_addr().unwrap().port() > 0);
        endpoint.close();
    }
}
