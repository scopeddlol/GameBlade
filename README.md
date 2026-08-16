# GameBlade

A self-hosted archive for portable PC games, with a Jellyfin-style library, rich
metadata from IGDB and SteamGridDB, invite-only multi-user access, and a Windows
desktop client built for downloads that actually finish.

- **Read-only by design.** Your library is mounted `:ro`. GameBlade indexes and
  serves it; it never writes to it.
- **Handles mixed layouts.** A game can be a folder of loose files or a single
  archive. Both are scanned, and both are downloadable.
- **Invite-only.** Self-registration is off by default. Accounts are created from
  invite codes an administrator generates.
- **Built for a reverse proxy.** Sub-path hosting, `X-Forwarded-*` awareness and
  proxy-aware secure cookies all work without rebuilding anything.
- **Small.** One Alpine container, SQLite, no external database or cache.

---

## Quick start

```bash
git clone https://github.com/scopeddlol/GameBlade.git
cd GameBlade
cp .env.example .env
```

Edit `.env` and set at least `LIBRARY_PATH` to the folder holding your games.
Then:

```bash
docker compose up -d
```

Open `http://<host>:8080` and create the first administrator account. That
first-run screen is only available while the database has no users.

> **If it fails to start with a database error**, the `data` folder is almost
> certainly owned by root while the container runs as uid 1000. SQLite is built
> into the image — nothing to install — it just cannot create its file:
>
> ```bash
> sudo chown -R 1000:1000 ./data
> ```
>
> Alternatively set `user: "1000:1000"` on the service to match your own
> `id -u`/`id -g`.

### What a library looks like

Anything at the top level of a library root is treated as one game — either a
directory or an archive. Nested folders are indexed as that game's files, not as
separate games.

```
/mnt/games/
├── Hollow Knight/            <- folder game
│   ├── hollow_knight.exe
│   └── data/
├── Stardew_Valley_v1.6.8/    <- folder game; version is stripped from the title
│   └── Stardew Valley.exe
└── Celeste v1.4.0.0.zip      <- archive game
```

Titles are cleaned before metadata lookup: version markers (`v1.6.8`,
`Build 12345`), bracketed tags (`[GOG]`, `(2015)`) and release-group noise
(`Repack`, `FitGirl`) are removed. Dotted acronyms such as `S.T.A.L.K.E.R.`
survive intact. Anything matched wrongly can be corrected by hand from the
game's page.

---

## Metadata providers

Both are optional — GameBlade runs fine without them, it just shows titles and
file sizes instead of artwork. Add credentials in **Admin → Metadata**, or via
environment variables.

| Provider        | What it supplies                          | Where to get credentials                                                                      |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| **IGDB**        | Summaries, release dates, genres, ratings | Create an app at [dev.twitch.tv](https://dev.twitch.tv/console/apps) — IGDB uses Twitch OAuth |
| **SteamGridDB** | Posters, hero banners, logos, icons       | Your [SteamGridDB API preferences](https://www.steamgriddb.com/profile/preferences/api)       |

IGDB enforces 4 requests/second; GameBlade rate-limits itself to stay under that,
so a first scan of a large library takes a while but never gets throttled out.
Artwork is downloaded once and cached locally, so the library keeps rendering if
a provider is unreachable — and no client IP is ever exposed to a provider.

---

## Running behind a reverse proxy

### Required in every case

Set `TRUST_PROXY=true`. Without it every request appears to come from the proxy,
which breaks per-client rate limiting and logs the wrong address.

`SECURE_COOKIES=auto` (the default) marks session cookies `Secure` when the proxy
reports `X-Forwarded-Proto: https`.

### On its own hostname

Nothing else to configure. Point the proxy at `http://gameblade:8080` and leave
`BASE_PATH` empty.

### Under a sub-path

Set `BASE_PATH=/gameblade`. The web client ships relative asset URLs and reads
its own base path from a `<base href>` tag that the server rewrites per request,
so the same image works at `/` and at any sub-path with no rebuild.

Do **not** strip the prefix at the proxy — GameBlade expects to receive the full
path.

### Pangolin

Pangolin tunnels traffic over WireGuard and terminates it in Traefik, so the
container needs no published ports at all. Remove the `ports:` block from
`docker-compose.yml` and point the Pangolin resource at `gameblade:8080` on the
shared Docker network.

Two things matter for large downloads through a tunnel:

- **Do not enable response buffering or compression** for GameBlade. Game data is
  already compressed, so buffering only adds latency and memory pressure.
  GameBlade sets `Cache-Control: no-transform` and `X-Accel-Buffering: no` on
  download responses to say so explicitly.
- **Allow long-lived responses.** A multi-gigabyte transfer can run for hours.
  GameBlade itself applies no request timeout; make sure the proxy doesn't either.

Tunnel throughput is the usual bottleneck on a large download. That is precisely
what the desktop client is for — see below.

---

## Users and invites

Registration is invite-only unless an administrator turns on self-registration
in **Admin → Metadata → Server**.

To add someone: **Admin → Invites → Create an invite**, then send them the
copied link. Invites carry a role, a use count and an optional expiry, and can be
revoked at any time.

Changing a password signs out every other session and revokes every desktop
device for that account.

---

## The desktop client

A browser download of a 60 GB folder is a single connection that has to survive
from start to finish; if it drops at 90%, it starts over. The desktop client
exists to remove that failure mode.

- Fetches a **manifest** of every file in a game with a short-lived signed token.
- Downloads with **multiple connections per file** (files ≥ 32 MB are split into
  four ranges) and several files in parallel.
- **Resumes after a disconnect, a crash or a reboot.** Progress is journalled to a
  `.gbpart` sidecar next to each file, so a transfer picks up at the exact byte
  it stopped.
- **Retries with backoff** — a flaky tunnel recovers on its own instead of failing
  the download.
- **Verifies SHA-256** when the server has a checksum for a file. Checksums are
  opt-in per game — open a game as an administrator and press **Compute
  checksums** — because hashing reads every byte and is far too expensive to do
  automatically across a multi-terabyte archive.
- Signs in with a **device token stored in the Windows Credential Manager**, never
  a password on disk. Each device is listed and revocable from **Settings**.

Installers are built by CI and attached to each tagged release. To build locally
you need the [Rust toolchain](https://rustup.rs):

```bash
pnpm --filter @gameblade/desktop build
```

Web downloads still work for everything: archive games stream with byte-range
resume support, and folder games are packaged into a ZIP on the fly.

---

## Configuration

Everything is optional except a library path. Values set in the admin UI take
precedence over environment variables, so you can seed credentials via compose
and change them later without touching the stack.

| Variable                                | Default            | Purpose                                                    |
| --------------------------------------- | ------------------ | ---------------------------------------------------------- |
| `LIBRARY_PATHS`                         | —                  | Comma-separated library roots **inside the container**     |
| `DATA_DIR`                              | `/data`            | Database and cached artwork                                |
| `PORT` / `HOST`                         | `8080` / `0.0.0.0` | Listen address                                             |
| `BASE_PATH`                             | —                  | Sub-path to host under, e.g. `/gameblade`                  |
| `TRUST_PROXY`                           | `false`            | `true`, a hop count, or a CIDR list                        |
| `SECURE_COOKIES`                        | `auto`             | `auto` follows `X-Forwarded-Proto`                         |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD`     | —                  | Creates the first admin, only while no users exist         |
| `ALLOW_SELF_REGISTRATION`               | `false`            | Invite-only when false                                     |
| `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` | —                  | Twitch application credentials                             |
| `STEAMGRIDDB_API_KEY`                   | —                  | SteamGridDB API key                                        |
| `SCAN_ON_START`                         | `true`             | Scan shortly after boot                                    |
| `SCAN_INTERVAL_MINUTES`                 | `360`              | Scheduled rescan interval; `0` disables                    |
| `LOG_LEVEL`                             | `info`             | `fatal` … `trace`                                          |
| `SESSION_SECRET`                        | generated          | Download-token signing key; set only for multiple replicas |

---

## Development

Requires Node 22 and pnpm 10.

```bash
pnpm install
pnpm --filter @gameblade/shared build

# API on :8080 and the web client on :5173 with proxying
pnpm dev
```

```bash
pnpm -r typecheck
pnpm -r test
pnpm format
```

### Layout

```
apps/server     Fastify API, scanner, metadata providers, download engine
apps/web        React 19 + Vite + Tailwind client
apps/desktop    Tauri v2 shell with a Rust download engine
packages/shared Types, zod schemas and constants used by all three
```

The database schema lives in `apps/server/src/db/schema.ts`, with plain-SQL
migrations applied at boot from `apps/server/src/db/migrations.ts`. Append a new
migration rather than editing an applied one.

---

## Security notes

- Passwords are hashed with Argon2id using OWASP's low-memory profile.
- Session tokens are opaque and stored only as SHA-256 hashes.
- State-changing requests from the browser require a CSRF header; bearer-token
  requests from the desktop carry no ambient authority and are exempt.
- Every download path is re-resolved against its library root and symlink-checked
  before any bytes are served, so a crafted path cannot escape the mount.
- The container runs as a non-root user and the library is mounted read-only.

## Licence

AGPL-3.0-only.
