//! Just enough STUN to ask "what address do you see me at".
//!
//! Written out rather than taken as a dependency because only one question is
//! ever asked here — a binding request, and the reflexive address that comes
//! back — and that is a hundred lines against a crate that implements the whole
//! of RFC 5389 including the parts this must never do.
//!
//! It exists for one reason: a machine behind NAT cannot see its own public
//! address, and hole punching needs it. Asking two different servers from the
//! *same socket* also answers a second and more important question — whether
//! this NAT gives out one external port per socket, or a different one per
//! destination. The first can be punched through; the second cannot.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use crate::error::{MeshError, MeshResult};

/// RFC 5389's magic cookie, which is what distinguishes STUN from noise.
const MAGIC_COOKIE: u32 = 0x2112_A442;

const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;

const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

const HEADER_BYTES: usize = 20;

/// A binding request, and the transaction id to match its reply against.
pub struct BindingRequest {
    pub bytes: [u8; HEADER_BYTES],
    pub transaction_id: [u8; 12],
}

/// Build a binding request with the given transaction id.
///
/// The id is passed in rather than generated so the caller controls randomness
/// and so the encoding is testable against a fixed vector.
pub fn binding_request(transaction_id: [u8; 12]) -> BindingRequest {
    let mut bytes = [0u8; HEADER_BYTES];

    bytes[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    // No attributes, so no length.
    bytes[2..4].copy_from_slice(&0u16.to_be_bytes());
    bytes[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    bytes[8..20].copy_from_slice(&transaction_id);

    BindingRequest {
        bytes,
        transaction_id,
    }
}

/// Read the reflexive address out of a binding response.
///
/// Everything unexpected is an error rather than a guess. This parses data from
/// an arbitrary host on the internet, so every length is checked against what
/// actually arrived before it is used to slice anything.
pub fn parse_binding_response(packet: &[u8], transaction_id: &[u8; 12]) -> MeshResult<SocketAddr> {
    if packet.len() < HEADER_BYTES {
        return Err(MeshError::Protocol("a STUN reply was too short".into()));
    }

    let kind = u16::from_be_bytes([packet[0], packet[1]]);
    if kind != BINDING_SUCCESS {
        return Err(MeshError::Protocol(format!(
            "a STUN reply of type {kind:#06x} is not a binding success"
        )));
    }

    let cookie = u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]);
    if cookie != MAGIC_COOKIE {
        return Err(MeshError::Protocol(
            "a STUN reply had the wrong cookie".into(),
        ));
    }

    // A reply carrying somebody else's transaction id is somebody else's reply,
    // and on a socket that is also being punched from, unrelated packets are
    // expected rather than surprising.
    if &packet[8..20] != transaction_id.as_slice() {
        return Err(MeshError::Protocol(
            "a STUN reply was for a different request".into(),
        ));
    }

    let declared = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    let body = packet
        .get(HEADER_BYTES..HEADER_BYTES + declared)
        .ok_or_else(|| MeshError::Protocol("a STUN reply claimed more body than it sent".into()))?;

    let mut cursor = 0usize;
    // Kept as a fallback: XOR-MAPPED-ADDRESS is preferred because middleboxes
    // are known to rewrite the plain one, but an old server may send only that.
    let mut plain: Option<SocketAddr> = None;

    while cursor + 4 <= body.len() {
        let attr = u16::from_be_bytes([body[cursor], body[cursor + 1]]);
        let length = u16::from_be_bytes([body[cursor + 2], body[cursor + 3]]) as usize;
        let start = cursor + 4;

        let value = body
            .get(start..start + length)
            .ok_or_else(|| MeshError::Protocol("a STUN attribute overran the reply".into()))?;

        match attr {
            ATTR_XOR_MAPPED_ADDRESS => return decode_address(value, transaction_id, true),
            ATTR_MAPPED_ADDRESS if plain.is_none() => {
                plain = decode_address(value, transaction_id, false).ok();
            }
            _ => {}
        }

        // Attribute values are padded to a four-byte boundary, and the padding
        // is not counted in the declared length.
        cursor = start + length.div_ceil(4) * 4;
    }

    plain.ok_or_else(|| MeshError::Protocol("a STUN reply carried no address".into()))
}

/// Decode a MAPPED-ADDRESS or XOR-MAPPED-ADDRESS value.
fn decode_address(value: &[u8], transaction_id: &[u8; 12], xored: bool) -> MeshResult<SocketAddr> {
    if value.len() < 4 {
        return Err(MeshError::Protocol("a STUN address was too short".into()));
    }

    let family = value[1];
    let raw_port = u16::from_be_bytes([value[2], value[3]]);
    // The port is XOR'd with the top half of the cookie.
    let port = if xored {
        raw_port ^ (MAGIC_COOKIE >> 16) as u16
    } else {
        raw_port
    };

    match family {
        0x01 => {
            let octets: [u8; 4] = value
                .get(4..8)
                .ok_or_else(|| MeshError::Protocol("a STUN IPv4 address was truncated".into()))?
                .try_into()
                .expect("a four-byte slice is a four-byte array");

            let raw = u32::from_be_bytes(octets);
            let address = if xored { raw ^ MAGIC_COOKIE } else { raw };
            Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(address)), port))
        }
        0x02 => {
            let octets: [u8; 16] = value
                .get(4..20)
                .ok_or_else(|| MeshError::Protocol("a STUN IPv6 address was truncated".into()))?
                .try_into()
                .expect("a sixteen-byte slice is a sixteen-byte array");

            // IPv6 is XOR'd with the cookie followed by the transaction id.
            let mut key = [0u8; 16];
            key[0..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
            key[4..16].copy_from_slice(transaction_id);

            let mut address = octets;
            if xored {
                for (byte, mask) in address.iter_mut().zip(key.iter()) {
                    *byte ^= mask;
                }
            }

            Ok(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(address)), port))
        }
        other => Err(MeshError::Protocol(format!(
            "a STUN address used unknown family {other:#04x}"
        ))),
    }
}

/// Learn this socket's own external address, synchronously.
///
/// Takes a plain `std::net::UdpSocket` and is meant to be called *before* the
/// socket is handed to QUIC. That ordering is not incidental: once quinn owns
/// the socket it is reading from it continuously, and a second reader would
/// race it for packets — occasionally consuming a QUIC datagram and dropping it
/// on the floor. Asking first, then handing the socket over, has no such race.
///
/// The answer is only meaningful for *this* socket. A different socket gets a
/// different NAT mapping, which is the entire reason the address has to be
/// discovered here rather than anywhere more convenient.
pub fn discover_reflexive(
    socket: &std::net::UdpSocket,
    servers: &[&str],
    timeout: std::time::Duration,
) -> Option<SocketAddr> {
    use rand::RngCore;

    let previous = socket.read_timeout().ok().flatten();
    socket.set_read_timeout(Some(timeout)).ok()?;

    let mut found = None;

    for server in servers {
        let mut transaction_id = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut transaction_id);
        let request = binding_request(transaction_id);

        let Ok(mut resolved) = std::net::ToSocketAddrs::to_socket_addrs(server) else {
            continue;
        };
        // IPv4 only: the mapping being discovered is the IPv4 NAT's.
        let Some(target) = resolved.find(|address| address.is_ipv4()) else {
            continue;
        };

        if socket.send_to(&request.bytes, target).is_err() {
            continue;
        }

        let mut buffer = [0u8; 1024];
        // One read attempt per server rather than a loop: this socket has no
        // other traffic yet — QUIC does not own it — so the next packet is
        // either the answer or nothing.
        if let Ok((length, _)) = socket.recv_from(&mut buffer) {
            if let Ok(address) = parse_binding_response(&buffer[..length], &request.transaction_id)
            {
                found = Some(address);
                break;
            }
        }
    }

    // Put the socket back as it was; quinn sets its own expectations.
    let _ = socket.set_read_timeout(previous);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const TXID: [u8; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    /// Build a binding success carrying one XOR-MAPPED-ADDRESS for IPv4.
    fn xor_response(address: Ipv4Addr, port: u16, transaction_id: [u8; 12]) -> Vec<u8> {
        let mut packet = Vec::new();
        packet.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        packet.extend_from_slice(&12u16.to_be_bytes());
        packet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        packet.extend_from_slice(&transaction_id);

        packet.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        packet.extend_from_slice(&8u16.to_be_bytes());
        packet.push(0);
        packet.push(0x01);
        packet.extend_from_slice(&(port ^ (MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        packet.extend_from_slice(&(u32::from(address) ^ MAGIC_COOKIE).to_be_bytes());
        packet
    }

    #[test]
    fn a_binding_request_has_the_shape_a_stun_server_expects() {
        let request = binding_request(TXID);

        assert_eq!(&request.bytes[0..2], &[0x00, 0x01]);
        assert_eq!(&request.bytes[2..4], &[0x00, 0x00]);
        assert_eq!(&request.bytes[4..8], &[0x21, 0x12, 0xA4, 0x42]);
        assert_eq!(&request.bytes[8..20], &TXID);
    }

    #[test]
    fn a_reflexive_address_is_recovered_from_an_xor_mapped_reply() {
        let packet = xor_response(Ipv4Addr::new(203, 0, 113, 9), 51_234, TXID);

        let address = parse_binding_response(&packet, &TXID).unwrap();
        assert_eq!(address, "203.0.113.9:51234".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn a_plain_mapped_address_is_accepted_when_that_is_all_there_is() {
        // Old servers send only MAPPED-ADDRESS. It is preferred less because
        // middleboxes rewrite it, but it beats having no answer.
        let mut packet = Vec::new();
        packet.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        packet.extend_from_slice(&12u16.to_be_bytes());
        packet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        packet.extend_from_slice(&TXID);
        packet.extend_from_slice(&ATTR_MAPPED_ADDRESS.to_be_bytes());
        packet.extend_from_slice(&8u16.to_be_bytes());
        packet.push(0);
        packet.push(0x01);
        packet.extend_from_slice(&4_444u16.to_be_bytes());
        packet.extend_from_slice(&u32::from(Ipv4Addr::new(198, 51, 100, 2)).to_be_bytes());

        let address = parse_binding_response(&packet, &TXID).unwrap();
        assert_eq!(address, "198.51.100.2:4444".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn the_xor_form_wins_when_both_are_present() {
        let mut packet = Vec::new();
        packet.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        packet.extend_from_slice(&24u16.to_be_bytes());
        packet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        packet.extend_from_slice(&TXID);

        // A deliberately wrong plain address first, to prove it is not used.
        packet.extend_from_slice(&ATTR_MAPPED_ADDRESS.to_be_bytes());
        packet.extend_from_slice(&8u16.to_be_bytes());
        packet.push(0);
        packet.push(0x01);
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&u32::from(Ipv4Addr::new(10, 0, 0, 1)).to_be_bytes());

        packet.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        packet.extend_from_slice(&8u16.to_be_bytes());
        packet.push(0);
        packet.push(0x01);
        packet.extend_from_slice(&(9_000u16 ^ (MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        packet.extend_from_slice(
            &(u32::from(Ipv4Addr::new(203, 0, 113, 5)) ^ MAGIC_COOKIE).to_be_bytes(),
        );

        let address = parse_binding_response(&packet, &TXID).unwrap();
        assert_eq!(address, "203.0.113.5:9000".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn a_reply_for_another_transaction_is_refused() {
        // The socket this arrives on is also being punched from, so unrelated
        // packets are routine rather than suspicious — but they are not answers.
        let packet = xor_response(Ipv4Addr::new(203, 0, 113, 9), 1_234, [9u8; 12]);

        assert!(parse_binding_response(&packet, &TXID).is_err());
    }

    #[test]
    fn a_reply_with_the_wrong_cookie_is_refused() {
        let mut packet = xor_response(Ipv4Addr::new(203, 0, 113, 9), 1_234, TXID);
        packet[4] = 0xFF;

        assert!(parse_binding_response(&packet, &TXID).is_err());
    }

    #[test]
    fn a_truncated_or_lying_packet_is_refused_rather_than_panicking() {
        // These come from an arbitrary host on the internet.
        let good = xor_response(Ipv4Addr::new(203, 0, 113, 9), 1_234, TXID);

        for length in 0..good.len() {
            let _ = parse_binding_response(&good[..length], &TXID);
        }

        // A header claiming far more body than was sent.
        let mut lying = good.clone();
        lying[2..4].copy_from_slice(&9_999u16.to_be_bytes());
        assert!(parse_binding_response(&lying, &TXID).is_err());

        // An attribute claiming to overrun the body.
        let mut overrun = good.clone();
        overrun[22..24].copy_from_slice(&9_999u16.to_be_bytes());
        assert!(parse_binding_response(&overrun, &TXID).is_err());
    }

    #[test]
    fn an_unknown_address_family_is_refused() {
        let mut packet = xor_response(Ipv4Addr::new(203, 0, 113, 9), 1_234, TXID);
        packet[21] = 0x09;

        assert!(parse_binding_response(&packet, &TXID).is_err());
    }

    /// RFC 5769 §2.2's sample IPv4 response, byte for byte.
    ///
    /// Synthetic packets built by this file's own helpers only prove the
    /// decoder agrees with the encoder beside it — if both share a
    /// misunderstanding of the XOR, both are wrong together. These are the
    /// bytes the specification publishes, and the address they must decode to
    /// is the one it documents.
    ///
    /// Truncated after XOR-MAPPED-ADDRESS, with the length adjusted to match:
    /// the real vector continues with MESSAGE-INTEGRITY and FINGERPRINT, which
    /// this parser never reaches and does not reproduce.
    #[test]
    fn the_rfc_5769_sample_response_decodes_to_the_documented_address() {
        #[rustfmt::skip]
        let packet: Vec<u8> = vec![
            // Header: binding success, 28 bytes of body, cookie, transaction id.
            0x01, 0x01, 0x00, 0x1c,
            0x21, 0x12, 0xa4, 0x42,
            0xb7, 0xe7, 0xa7, 0x01,
            0xbc, 0x34, 0xd6, 0x86,
            0xfa, 0x87, 0xdf, 0xae,
            // SOFTWARE: "test vector", eleven bytes padded to twelve.
            0x80, 0x22, 0x00, 0x0b,
            0x74, 0x65, 0x73, 0x74,
            0x20, 0x76, 0x65, 0x63,
            0x74, 0x6f, 0x72, 0x20,
            // XOR-MAPPED-ADDRESS.
            0x00, 0x20, 0x00, 0x08,
            0x00, 0x01, 0xa1, 0x47,
            0xe1, 0x12, 0xa6, 0x43,
        ];

        let transaction_id: [u8; 12] = [
            0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
        ];

        let address = parse_binding_response(&packet, &transaction_id).unwrap();
        assert_eq!(address, "192.0.2.1:32853".parse::<SocketAddr>().unwrap());
    }

    /// The IPv6 key is the cookie followed by the transaction id, not the
    /// cookie repeated — a mistake that decodes the first four bytes correctly
    /// and turns the remaining twelve into noise.
    ///
    /// The plaintext here is RFC 5769 §2.3's documented address; the ciphertext
    /// is derived from it, so this pins the key construction rather than the
    /// literal bytes.
    #[test]
    fn an_ipv6_address_is_unmasked_with_the_cookie_and_transaction_id() {
        let transaction_id: [u8; 12] = [
            0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
        ];
        let expected: Ipv6Addr = "2001:db8:1234:5678:11:2233:4455:6677".parse().unwrap();

        let mut key = [0u8; 16];
        key[0..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
        key[4..16].copy_from_slice(&transaction_id);

        let mut masked = expected.octets();
        for (byte, mask) in masked.iter_mut().zip(key.iter()) {
            *byte ^= mask;
        }

        let mut packet = Vec::new();
        packet.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        packet.extend_from_slice(&24u16.to_be_bytes());
        packet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        packet.extend_from_slice(&transaction_id);
        packet.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        packet.extend_from_slice(&20u16.to_be_bytes());
        packet.push(0);
        packet.push(0x02);
        packet.extend_from_slice(&(32_853u16 ^ (MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        packet.extend_from_slice(&masked);

        let address = parse_binding_response(&packet, &transaction_id).unwrap();
        assert_eq!(address, SocketAddr::new(IpAddr::V6(expected), 32_853));
    }

    #[test]
    fn attribute_padding_does_not_desynchronise_the_walk() {
        // A three-byte attribute is padded to four. Getting this wrong makes
        // every attribute after the first unreadable, which on a real server's
        // reply means missing the address entirely.
        let mut packet = Vec::new();
        packet.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        packet.extend_from_slice(&20u16.to_be_bytes());
        packet.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        packet.extend_from_slice(&TXID);

        // SOFTWARE-ish: three bytes of value, one byte of padding.
        packet.extend_from_slice(&0x8022u16.to_be_bytes());
        packet.extend_from_slice(&3u16.to_be_bytes());
        packet.extend_from_slice(&[b'a', b'b', b'c', 0]);

        packet.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        packet.extend_from_slice(&8u16.to_be_bytes());
        packet.push(0);
        packet.push(0x01);
        packet.extend_from_slice(&(7_777u16 ^ (MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        packet.extend_from_slice(
            &(u32::from(Ipv4Addr::new(192, 0, 2, 4)) ^ MAGIC_COOKIE).to_be_bytes(),
        );

        let address = parse_binding_response(&packet, &TXID).unwrap();
        assert_eq!(address, "192.0.2.4:7777".parse::<SocketAddr>().unwrap());
    }
}
