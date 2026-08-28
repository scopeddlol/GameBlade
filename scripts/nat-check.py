#!/usr/bin/env python3
"""Will a client be able to reach this machine directly?

The same check as `cargo run --bin mesh-doctor`, with no toolchain to install:
standard library only, Python 3.8 or newer. Run it on the machine that would
hold the game files.

    python3 scripts/nat-check.py

It sends a handful of UDP packets to public STUN servers and reads back the
address each one saw. Nothing about the archive is disclosed — a STUN binding
request carries no payload, and the reply is this machine's own address, which
every host it contacts already sees.

Two questions decide whether the mesh is worth deploying here.

* Is there routable IPv6? Then there is no NAT to traverse at all, and clients
  that also have IPv6 connect directly with nothing to punch through.

* Does this NAT hand out one external port per socket, or a different one per
  destination? The first can be punched through, the second cannot. This is
  what actually decides it — not how many layers of NAT are in the way. Double
  NAT is routinely punchable and single NAT routinely is not, so the mapping
  behaviour is measured directly rather than inferred.
"""

import os
import random
import socket
import struct
import sys

MAGIC_COOKIE = 0x2112A442
BINDING_REQUEST = 0x0001
BINDING_SUCCESS = 0x0101
ATTR_MAPPED_ADDRESS = 0x0001
ATTR_XOR_MAPPED_ADDRESS = 0x0020

# Two different operators on purpose: the whole test is whether the answers
# agree, and two addresses run by one operator can share a path and agree for
# the wrong reason.
STUN_SERVERS = [
    ("stun.l.google.com", 19302),
    ("stun.cloudflare.com", 3478),
    ("stun.nextcloud.com", 443),
]

TIMEOUT_SECONDS = 3


def binding_request(transaction_id):
    """A STUN binding request: a 20-byte header and nothing else."""
    return struct.pack(">HHI", BINDING_REQUEST, 0, MAGIC_COOKIE) + transaction_id


def parse_response(packet, transaction_id):
    """Pull the reflexive address out of a binding response.

    Every length is checked against what actually arrived before it is used to
    slice anything: this parses data from an arbitrary host on the internet.
    """
    if len(packet) < 20:
        return None

    kind, length, cookie = struct.unpack(">HHI", packet[:8])
    if kind != BINDING_SUCCESS or cookie != MAGIC_COOKIE:
        return None
    if packet[8:20] != transaction_id:
        return None

    body = packet[20 : 20 + length]
    cursor = 0
    plain = None

    while cursor + 4 <= len(body):
        attr, attr_length = struct.unpack(">HH", body[cursor : cursor + 4])
        start = cursor + 4
        value = body[start : start + attr_length]
        if len(value) < attr_length:
            return None

        if attr == ATTR_XOR_MAPPED_ADDRESS:
            return decode_address(value, transaction_id, xored=True)
        if attr == ATTR_MAPPED_ADDRESS and plain is None:
            plain = decode_address(value, transaction_id, xored=False)

        # Attribute values are padded to a four-byte boundary, and the padding
        # is not counted in the declared length.
        cursor = start + (attr_length + 3) // 4 * 4

    return plain


def decode_address(value, transaction_id, xored):
    if len(value) < 8:
        return None

    family = value[1]
    port = struct.unpack(">H", value[2:4])[0]
    if xored:
        port ^= MAGIC_COOKIE >> 16

    if family == 0x01:
        raw = value[4:8]
        if xored:
            key = struct.pack(">I", MAGIC_COOKIE)
            raw = bytes(a ^ b for a, b in zip(raw, key))
        return (socket.inet_ntop(socket.AF_INET, raw), port)

    if family == 0x02:
        raw = value[4:20]
        if len(raw) < 16:
            return None
        if xored:
            key = struct.pack(">I", MAGIC_COOKIE) + transaction_id
            raw = bytes(a ^ b for a, b in zip(raw, key))
        return (socket.inet_ntop(socket.AF_INET6, raw), port)

    return None


def ask(sock, host, port):
    """Ask one server what address it sees, on an existing socket.

    The socket is shared across servers on purpose. A fresh socket per server
    would get a fresh NAT mapping each time, and every NAT on earth would then
    look symmetric.
    """
    transaction_id = bytes(random.getrandbits(8) for _ in range(12))

    try:
        resolved = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_DGRAM)[0][4]
        sock.sendto(binding_request(transaction_id), resolved)
    except OSError:
        return None

    # Reads until this server's reply arrives or time runs out. Other packets on
    # this socket are ignored rather than treated as failures.
    sock.settimeout(TIMEOUT_SECONDS)
    while True:
        try:
            packet, _ = sock.recvfrom(2048)
        except (socket.timeout, OSError):
            return None

        found = parse_response(packet, transaction_id)
        if found is not None:
            return found


def ipv6_address():
    """Whether outbound IPv6 works, and the address it would come from.

    Connecting a UDP socket sends nothing — it only asks the routing table which
    local address would be used — so this costs no packets and reaches nobody.
    """
    try:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        sock.connect(("2001:4860:4860::8888", 53))
        address = sock.getsockname()[0]
        sock.close()
    except OSError:
        return None

    # Link-local (fe80::/10) and unique-local (fc00::/7) are not reachable from
    # the internet, so they do not count as an answer.
    lowered = address.lower()
    if lowered.startswith("fe8") or lowered.startswith("fe9") or lowered.startswith("fea") \
            or lowered.startswith("feb") or lowered.startswith("fc") or lowered.startswith("fd"):
        return None
    if lowered in ("::1", "::"):
        return None
    return address


def main():
    print("Checking what this machine looks like from the outside…\n")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 0))
    local_port = sock.getsockname()[1]

    seen = []
    for host, port in STUN_SERVERS:
        observed = ask(sock, host, port)
        if observed is not None:
            seen.append((host, observed))
            print("  {} sees this machine at {}:{}".format(host, observed[0], observed[1]))
        else:
            print("  {} did not answer".format(host))
    sock.close()

    six = ipv6_address()
    print()
    if six:
        print(
            "IPv6: yes — this machine has the routable address {}.\n"
            "  This is the best possible answer: clients that also have IPv6 connect\n"
            "  with no NAT to traverse. Check that the router permits inbound IPv6 to\n"
            "  this host — that is a firewall rule, not a port forward, and is usually\n"
            "  configurable even where forwarding is not.".format(six)
        )
    else:
        print("IPv6: no outbound IPv6 route. Every connection has to cross IPv4 NAT.")

    print()
    ports = {observed[1] for _, observed in seen}

    if len(seen) < 2:
        print(
            "NAT: could not tell — fewer than two servers answered. Re-run; if it keeps\n"
            "  failing, outbound UDP is probably blocked here, which rules out direct\n"
            "  transfer on its own."
        )
        punchable = False
    elif ports == {local_port}:
        print("NAT: none. The local port is the public port; nothing needs punching.")
        punchable = True
    elif len(ports) == 1:
        print(
            "NAT: endpoint-independent — the same external port to everyone.\n"
            "  This is punchable. A direct path should establish for most clients\n"
            "  without forwarding anything. Double NAT does not change this: what\n"
            "  matters is the mapping behaviour, and this one is the good kind."
        )
        punchable = True
    else:
        print(
            "NAT: endpoint-dependent (symmetric) — a different external port per\n"
            "  destination. This cannot be punched through. The address a peer is told\n"
            "  to aim at is stale before it aims, and no amount of coordination fixes\n"
            "  that. Bytes would have to be relayed through the VPS."
        )
        punchable = False

    print()
    if six or punchable:
        print("Verdict: worth deploying. A direct path should establish for most clients.")
        return 0

    print(
        "Verdict: do not expect the mesh to help from this machine. Bytes would be\n"
        "  relayed through the VPS, which is the bottleneck it exists to avoid."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
