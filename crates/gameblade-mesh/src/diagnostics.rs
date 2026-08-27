//! Answering "will a direct connection actually work from this machine".
//!
//! Every other part of the mesh is written to degrade gracefully when the
//! answer is no. This is the part that finds out, because the difference
//! decides whether the whole design pays off or quietly falls back to the
//! tunnel it was built to avoid — and that is not something to discover from a
//! throughput graph three weeks after deploying it.
//!
//! Two questions, in order of how much they matter.
//!
//! **Is there IPv6?** If both ends have a routable IPv6 address there is no NAT
//! to traverse and nothing to punch. This is the cleanest possible outcome and
//! it is common even on connections whose IPv4 is carrier-grade NAT, because
//! that is often exactly why the carrier deployed IPv6.
//!
//! **Does this NAT hand out one external port per socket, or one per
//! destination?** Asked by sending from a single socket to two different
//! servers and comparing what each says it saw. The same external port from
//! both means the mapping is endpoint-independent and a hole punched by one
//! peer is a hole any peer can use. A different port per destination — a
//! symmetric NAT — means the address a peer is told to aim at is already stale
//! by the time it aims, and punching cannot work no matter how it is arranged.
//!
//! The number of NAT layers is deliberately not measured. Double NAT is
//! routinely punchable and single NAT routinely is not; what decides it is the
//! mapping behaviour of the outermost device, which is what this measures
//! directly rather than inferring.

use std::net::SocketAddr;
use std::time::Duration;

use crate::error::{MeshError, MeshResult};

/// What the mapping behaviour turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatMapping {
    /// No NAT worth speaking of: the socket's local address is what the world
    /// sees. Nothing needs punching.
    None,
    /// One external port per socket, whoever it talks to. Punchable.
    EndpointIndependent,
    /// A different external port per destination. Not punchable.
    EndpointDependent,
    /// Not enough servers answered to tell.
    Unknown,
}

impl NatMapping {
    /// Whether a direct path can be established to a peer behind this.
    pub fn is_punchable(&self) -> bool {
        matches!(self, NatMapping::None | NatMapping::EndpointIndependent)
    }
}

/// One probe's result.
#[derive(Debug, Clone)]
pub struct Reflexive {
    pub server: String,
    pub observed: SocketAddr,
}

/// Everything learned about this machine's position on the network.
#[derive(Debug, Clone)]
pub struct NetworkReport {
    /// The port the probing socket was bound to locally.
    pub local_port: u16,
    /// A routable IPv6 address, if outbound IPv6 works at all.
    pub ipv6: Option<SocketAddr>,
    pub reflexive: Vec<Reflexive>,
    pub mapping: NatMapping,
}

impl NetworkReport {
    /// Whether this machine can serve as a mesh node without a forwarded port.
    ///
    /// IPv6 counts on its own: with a routable address there is no NAT in the
    /// way, though a router firewall may still need to permit inbound — which
    /// is a rule rather than a port forward, and is usually allowed even where
    /// forwarding is not.
    pub fn direct_path_likely(&self) -> bool {
        self.ipv6.is_some() || self.mapping.is_punchable()
    }
}

/// Decide the mapping behaviour from what the servers reported.
///
/// Pure, so the judgement is testable without a network. The rule is only
/// about the *port*: a machine with several uplinks can legitimately show
/// different external addresses, and that alone does not make it unpunchable —
/// a port that changes per destination does.
pub fn classify(local_port: u16, reflexive: &[Reflexive]) -> NatMapping {
    if reflexive.len() < 2 {
        return NatMapping::Unknown;
    }

    let first = reflexive[0].observed;

    // The world sees exactly what was bound: there is no NAT in the path.
    let untranslated = reflexive
        .iter()
        .all(|entry| entry.observed.port() == local_port);
    if untranslated {
        return NatMapping::None;
    }

    let stable = reflexive
        .iter()
        .all(|entry| entry.observed.port() == first.port());

    if stable {
        NatMapping::EndpointIndependent
    } else {
        NatMapping::EndpointDependent
    }
}

/// Plain-language verdict, for an operator deciding whether to deploy any of
/// this.
pub fn explain(report: &NetworkReport) -> String {
    let mut lines = Vec::new();

    match &report.ipv6 {
        Some(address) => lines.push(format!(
            "IPv6: yes — this machine is reachable at {address} with no NAT in the way.\n  \
             This is the best possible answer. Clients that also have IPv6 connect\n  \
             directly with nothing to traverse. Check that the router permits inbound\n  \
             IPv6 to this host; that is a firewall rule, not a port forward, and is\n  \
             usually configurable even where forwarding is not."
        )),
        None => lines.push(
            "IPv6: no outbound IPv6 route. Every connection has to cross IPv4 NAT.".to_string(),
        ),
    }

    for entry in &report.reflexive {
        lines.push(format!(
            "  {} sees this machine at {}",
            entry.server, entry.observed
        ));
    }

    let verdict = match report.mapping {
        NatMapping::None => {
            "NAT: none. The local port is the public port; nodes here need no traversal."
        }
        NatMapping::EndpointIndependent => {
            "NAT: endpoint-independent — the same external port to everyone.\n  \
             This is punchable. With rendezvous in place a direct path should\n  \
             establish for most clients, without forwarding anything. Note that\n  \
             double NAT does not change this: what matters is the mapping\n  \
             behaviour, and this connection's is the good kind."
        }
        NatMapping::EndpointDependent => {
            "NAT: endpoint-dependent (symmetric) — a different external port per\n  \
             destination. This cannot be punched through. The address a peer is\n  \
             told to aim at is stale before it aims, and no amount of rendezvous\n  \
             fixes that. Direct transfer is not achievable from this machine;\n  \
             traffic would have to be relayed, which puts it back on the VPS."
        }
        NatMapping::Unknown => {
            "NAT: could not tell — too few servers answered. Re-run; if it keeps\n  \
             failing, outbound UDP may be blocked, which rules out direct\n  \
             transfer on its own."
        }
    };
    lines.push(verdict.to_string());

    if report.direct_path_likely() {
        lines.push(
            "\nVerdict: worth deploying. A direct path should establish for most clients."
                .to_string(),
        );
    } else {
        lines.push(
            "\nVerdict: do not expect the mesh to help from this machine. Bytes would\n  \
             be relayed through the VPS, which is the bottleneck it exists to avoid."
                .to_string(),
        );
    }

    lines.join("\n")
}

/// How long to wait for any one server to answer.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Public STUN servers, used only to observe this machine's own address.
///
/// Two different operators on purpose: the whole test is whether the answers
/// agree, and two addresses at one operator can share a NAT-facing path and
/// agree for the wrong reason. Nothing about the archive is disclosed — a
/// binding request carries no payload, and the reply is this machine's own
/// address, which every host it contacts already sees.
pub const DEFAULT_STUN_SERVERS: &[&str] = &[
    "stun.l.google.com:19302",
    "stun.cloudflare.com:3478",
    "stun.nextcloud.com:443",
];

/* ------------------------------------------------------------------ probing */

/// Ask one STUN server what address it sees, from an existing socket.
///
/// The socket is passed in rather than created because the whole point is to
/// ask several servers *from the same socket*: a fresh socket per server would
/// get a fresh NAT mapping each time and every NAT would look symmetric.
async fn ask(socket: &tokio::net::UdpSocket, server: &str) -> MeshResult<SocketAddr> {
    use rand::RngCore;

    let mut transaction_id = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut transaction_id);
    let request = crate::stun::binding_request(transaction_id);

    let resolved = tokio::net::lookup_host(server)
        .await
        .map_err(|err| MeshError::Unreachable(format!("{server}: {err}")))?
        .next()
        .ok_or_else(|| MeshError::Unreachable(format!("{server}: no address")))?;

    socket
        .send_to(&request.bytes, resolved)
        .await
        .map_err(|err| MeshError::Unreachable(format!("{server}: {err}")))?;

    // Reads until this server's own reply arrives or time runs out. Other
    // packets on this socket are ignored rather than treated as failures: it is
    // a shared socket and stray traffic is expected.
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    let mut buffer = [0u8; 1024];

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(MeshError::Unreachable(format!(
                "{server}: no reply in time"
            )));
        }

        let read = tokio::time::timeout(remaining, socket.recv_from(&mut buffer)).await;
        let Ok(Ok((length, _from))) = read else {
            return Err(MeshError::Unreachable(format!(
                "{server}: no reply in time"
            )));
        };

        if let Ok(address) =
            crate::stun::parse_binding_response(&buffer[..length], &request.transaction_id)
        {
            return Ok(address);
        }
    }
}

/// Whether outbound IPv6 works, and the address it would come from.
///
/// Connecting a UDP socket sends nothing — it only asks the routing table which
/// local address would be used — so this costs no packets and reaches nobody.
/// A link-local or unique-local answer does not count: it is not somewhere a
/// client on the internet can reach.
fn ipv6_address(port: u16) -> Option<SocketAddr> {
    let socket = std::net::UdpSocket::bind("[::]:0").ok()?;
    // A documentation address. Nothing is sent to it.
    socket.connect("[2001:4860:4860::8888]:53").ok()?;

    let local = socket.local_addr().ok()?;
    match local.ip() {
        std::net::IpAddr::V6(address)
            if !address.is_loopback()
                && !address.is_unspecified()
                // fe80::/10 link-local and fc00::/7 unique-local are not
                // reachable from the internet.
                && (address.segments()[0] & 0xffc0) != 0xfe80
                && (address.segments()[0] & 0xfe00) != 0xfc00 =>
        {
            Some(SocketAddr::new(std::net::IpAddr::V6(address), port))
        }
        _ => None,
    }
}

/// Run the whole diagnostic.
pub async fn probe(servers: &[&str]) -> MeshResult<NetworkReport> {
    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(MeshError::Io)?;
    let local_port = socket.local_addr().map_err(MeshError::Io)?.port();

    let mut reflexive = Vec::new();
    for server in servers {
        match ask(&socket, server).await {
            Ok(observed) => reflexive.push(Reflexive {
                server: (*server).to_string(),
                observed,
            }),
            // One unreachable server is ordinary; the classification simply
            // needs two that answered.
            Err(_) => continue,
        }
    }

    let mapping = classify(local_port, &reflexive);

    Ok(NetworkReport {
        local_port,
        ipv6: ipv6_address(crate::MESH_DEFAULT_PORT),
        reflexive,
        mapping,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(server: &str, address: &str) -> Reflexive {
        Reflexive {
            server: server.to_string(),
            observed: address.parse().unwrap(),
        }
    }

    #[test]
    fn one_answer_is_not_enough_to_conclude_anything() {
        // The entire test is whether two answers agree.
        let mapping = classify(50_000, &[seen("a", "203.0.113.1:40000")]);
        assert_eq!(mapping, NatMapping::Unknown);
    }

    #[test]
    fn the_same_external_port_everywhere_is_punchable() {
        let mapping = classify(
            50_000,
            &[
                seen("a", "203.0.113.1:40000"),
                seen("b", "203.0.113.1:40000"),
            ],
        );

        assert_eq!(mapping, NatMapping::EndpointIndependent);
        assert!(mapping.is_punchable());
    }

    #[test]
    fn a_different_port_per_destination_is_not_punchable() {
        // The symmetric case. The address a peer is told to aim at is already
        // stale by the time it aims.
        let mapping = classify(
            50_000,
            &[
                seen("a", "203.0.113.1:40000"),
                seen("b", "203.0.113.1:40001"),
            ],
        );

        assert_eq!(mapping, NatMapping::EndpointDependent);
        assert!(!mapping.is_punchable());
    }

    #[test]
    fn an_untranslated_port_means_there_is_no_nat() {
        let mapping = classify(
            50_000,
            &[
                seen("a", "203.0.113.1:50000"),
                seen("b", "203.0.113.1:50000"),
            ],
        );

        assert_eq!(mapping, NatMapping::None);
        assert!(mapping.is_punchable());
    }

    #[test]
    fn a_changing_address_with_a_stable_port_is_still_punchable() {
        // A machine with more than one uplink can legitimately be seen at
        // different addresses. That is not what breaks punching; a port that
        // changes per destination is.
        let mapping = classify(
            50_000,
            &[
                seen("a", "203.0.113.1:40000"),
                seen("b", "198.51.100.7:40000"),
            ],
        );

        assert_eq!(mapping, NatMapping::EndpointIndependent);
    }

    #[test]
    fn three_answers_where_only_the_last_disagrees_are_still_symmetric() {
        // Two servers agreeing is not proof; a NAT can assign the same port
        // twice by luck. Any disagreement settles it.
        let mapping = classify(
            50_000,
            &[
                seen("a", "203.0.113.1:40000"),
                seen("b", "203.0.113.1:40000"),
                seen("c", "203.0.113.1:40007"),
            ],
        );

        assert_eq!(mapping, NatMapping::EndpointDependent);
    }

    #[test]
    fn ipv6_alone_makes_a_direct_path_likely_whatever_the_nat_says() {
        // There is no NAT on the v6 path, so the v4 verdict does not govern.
        let report = NetworkReport {
            local_port: 50_000,
            ipv6: Some("[2001:db8::1]:47820".parse().unwrap()),
            reflexive: vec![
                seen("a", "203.0.113.1:40000"),
                seen("b", "203.0.113.1:40001"),
            ],
            mapping: NatMapping::EndpointDependent,
        };

        assert!(report.direct_path_likely());
        assert!(explain(&report).contains("IPv6: yes"));
    }

    #[test]
    fn symmetric_nat_without_ipv6_is_reported_as_not_worth_deploying() {
        // The honest answer, and the one worth saying plainly: relayed bytes go
        // back through the bottleneck this was built to avoid.
        let report = NetworkReport {
            local_port: 50_000,
            ipv6: None,
            reflexive: vec![
                seen("a", "203.0.113.1:40000"),
                seen("b", "203.0.113.1:40001"),
            ],
            mapping: NatMapping::EndpointDependent,
        };

        assert!(!report.direct_path_likely());
        let text = explain(&report);
        assert!(text.contains("do not expect the mesh to help"));
        assert!(text.contains("symmetric"));
    }

    #[test]
    fn the_explanation_names_double_nat_where_it_is_not_the_problem() {
        // Somebody reading this will have been told double NAT is fatal. It is
        // not, and the report should say so where the measurement disagrees.
        let report = NetworkReport {
            local_port: 50_000,
            ipv6: None,
            reflexive: vec![
                seen("a", "203.0.113.1:40000"),
                seen("b", "203.0.113.1:40000"),
            ],
            mapping: NatMapping::EndpointIndependent,
        };

        assert!(report.direct_path_likely());
        assert!(explain(&report).contains("double NAT does not change this"));
    }
}
