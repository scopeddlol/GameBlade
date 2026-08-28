# GameBlade

GameBlade is a self-hosted platform for preserving free-to-play and DRM-free games. v0.6.1 ships three purpose-built Docker images plus the Windows desktop client.

**[Full documentation → `Docs.html`](Docs.html)**

## Choose a deployment

| Image                                      | Purpose                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ghcr.io/scopeddlol/gameblade-aio`         | The pre-v0.6 all-in-one experience: catalog, files, admin UI, landing page, Discord bot, and optional P2P in one container.                      |
| `ghcr.io/scopeddlol/gameblade-coordinator` | VPS control plane: admin UI, landing page, accounts, Discord bot, mesh coordination, optional relay, and bundled Caddy. It stores no game files. |
| `ghcr.io/scopeddlol/gameblade-node`        | Storage appliance: multiple libraries, multiple Coordinator connections, automatic chunk hashing, QUIC delivery, and its own management UI.      |

Use matching version tags for Coordinator, Nodes, and desktop clients. CI also publishes `latest` from `main`.

## AIO quick start

```bash
git clone https://github.com/scopeddlol/GameBlade.git
cd GameBlade
cp .env.example .env
# Set LIBRARY_PATH in .env, then:
docker compose up -d
```

Open `http://<host>:8080` and create the first administrator. Existing GameBlade deployments can move to the AIO image without changing their data directory.

## Split Coordinator + Node

### 1. Coordinator on the VPS

Copy `docker-compose.coordinator.yml`, then set:

```dotenv
CADDY_ADDRESS=games.example.com
RELAY_ENDPOINT=games.example.com:47821
```

Point the domain's A/AAAA record at the VPS and allow TCP 80/443 plus UDP 47821. Start it:

```bash
docker compose -f docker-compose.coordinator.yml up -d
```

Caddy is bundled in the Coordinator image. It obtains and renews HTTPS certificates automatically and proxies to the private GameBlade process. For HTTP-only LAN testing, use `CADDY_ADDRESS=:8080` and open port 80 (or the host port mapped to container 8080).

Create the first admin, then go to **Admin → Settings → Nodes** and generate an **Origin** enrollment token.

### 2. Node where the files live

Copy `docker-compose.node.yml`, set `LIBRARY_PATH`, and start it:

```bash
docker compose -f docker-compose.node.yml up -d
```

Open `http://<node-host>:8081`, create the Node administrator, then:

1. Add every mounted library path, such as `/library/main` or `/library/archive-2`.
2. Add a Coordinator connection, select the library, and paste its one-time enrollment token.
3. Scan one library or choose **Scan all**.

A Node may connect different libraries to different Coordinators—or the same library to several Coordinators. Every Coordinator/library pairing has isolated credentials and a separate serving identity. Add extra read-only volume mounts to the Node compose file before adding their container paths in the UI.

## Networking

- Clients try direct QUIC to Nodes first.
- UDP 47820 is the first Node agent port; additional connections use consecutive ports. The example Compose file publishes 47820–47839 for up to 20 pairings. Outbound NAT discovery usually needs no port forward, but forwarding the matching range improves direct reachability.
- The Coordinator's optional UDP 47821 relay is an encrypted fallback for NATs that cannot establish a direct path.
- A Coordinator never advertises itself as an HTTP file source. AIO always retains its local HTTP fallback.
- Client-side peer seeding remains optional and is controlled in Admin settings.

## Data and upgrades

- AIO and Coordinator use `/data/gameblade.db`; existing databases migrate in place.
- Node state lives under `/data`, including one identity per Coordinator/library connection. Back it up so Nodes do not need to enroll again.
- Game libraries should always be mounted read-only.
- Before moving an AIO install to split mode, back up `data/`. Copy it to the Coordinator; do not move or delete the original until the Node catalog and downloads are verified.

## Development

Requires Node 22, pnpm 10, Rust, and Docker for image verification.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test

cd crates/gameblade-mesh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Build all three images locally with `pnpm docker:build`, or one target directly:

```bash
docker build --target aio -t gameblade-aio:local .
docker build --target coordinator -t gameblade-coordinator:local .
docker build --target node -t gameblade-node:local .
```

## License

AGPL-3.0-only.
