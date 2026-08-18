# GameBlade

A self-hosted platform for preserving free-to-play and DRM-free games: a Docker
server that holds the archive, and a Windows desktop client that makes playing
from it feel like a modern game launcher.

- **Server, not a web app.** The server hosts the files, a public landing page
  and an admin panel. Everything a player does — browsing, installing, playing,
  achievements, friends — happens in the desktop client.
- **Cloud saves.** Save files sync after every session, with version history and
  an explicit conflict prompt when two machines disagree.
- **Achievements.** Sets are imported from public sources and tracked per
  account, so a DRM-free copy still earns something.
- **Friends and activity.** Live presence, a shared feed, screenshots and clips.
- **Read-only by design.** Your library is mounted `:ro`. GameBlade indexes and
  serves it; it never writes to it.
- **Invite-only.** Self-registration is off by default. Accounts come from invite
  codes an administrator generates.
- **Small.** One Alpine container, SQLite, no external database or cache.

---

## How the pieces fit

| Piece                        | Who uses it   | What it does                                                            |
| ---------------------------- | ------------- | ----------------------------------------------------------------------- |
| **Server** (Docker)          | You           | Reads the library from disk, serves the API, stores saves and profiles  |
| **Landing page** (`/`)       | Everyone      | Explains the archive and links the Windows client download              |
| **Admin panel** (`/admin`)   | Administrator | Invites, users, catalog, metadata editor, featured games, settings      |
| **Desktop client** (Windows) | Players       | Home, Library, Store, Social and Settings — the whole player experience |

There is deliberately no web library browser — that lives entirely in the
desktop client. A player who signs in on the web lands on an account page
(username, email, password, signed-in devices) instead.

---

## Where to get it

Both halves are published together by CI — an image without a matching client
leaves you nothing to connect with.

| Artifact           | Where                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **Server image**   | `ghcr.io/scopeddlol/gameblade` — `latest`, plus a tag per release                           |
| **Windows client** | The `.exe` on the [latest release](https://github.com/scopeddlol/GameBlade/releases/latest) |

The image is built for `linux/amd64` and `linux/arm64`. The release also carries
an `.msi` for deployment tooling; the `.exe` is what most people want.

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

Once the library has scanned, upload a client build from **Admin → Settings**
(or point `CLIENT_DOWNLOAD_URL` at one hosted elsewhere) and invite people from
**Admin → Invites**.

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
| **SteamGridDB** | Posters, capsules, hero art, logos, icons | Your [SteamGridDB API preferences](https://www.steamgriddb.com/profile/preferences/api)       |

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
in **Admin → Settings**.

To add someone: **Admin → Invites → Create an invite**, then send them the
copied link. Invites carry a role, a use count and an optional expiry, and can be
revoked at any time. After registering they download the Windows client and sign
in there — the web surface has nothing else for them.

Changing a password signs out every other session and revokes every desktop
device for that account.

---

## The admin panel

Everything an operator needs, at `/admin`:

- **Overview** — catalog health, connected clients, scan progress, and a
  broadcast announcement box that pushes a notification to every account.
- **Catalog** — a worklist of every game, filterable by match status and by
  what an entry is still missing: no launch executable, no cloud-save rule, no
  artwork, no achievements, no metadata. Each filter carries a server-wide
  count, and every row shows the same four things as `EXE / SAVE / ART / ACH`
  markers, so a scan down the list says where the holes are without opening
  anything. Opening one gives a full metadata editor: fields, artwork slots,
  screenshots, Steam achievement import, and the launch and save rules the
  desktop client needs to actually run and back up that game.
- **Featured** — curates the carousel on the client's Home tab, in order, with
  a per-slot image override.
- **Libraries**, **Users**, **Invites**, **Settings** — as before, plus the
  landing-page copy and the Windows client installer.

### Picking artwork

Every image slot — cover, banner, hero, logo/text, icon, and each screenshot —
has a **Browse gallery** button that opens a picker over everything IGDB and
SteamGridDB publish for that title. Search by whatever the providers call the
game rather than what the folder is called, and narrow by SteamGridDB style
(a white or black text wordmark, a capsule with no logo baked in, and so on).
The screenshot picker stays open so a set can be assembled in one pass.

Previews are streamed through the server rather than loaded from the provider
CDNs, so a browser never talks to IGDB or SteamGridDB directly. Only the image
actually chosen is downloaded and cached.

### Publishing the Windows client

**Admin → Settings** takes the installer itself: pick a `.exe` (or `.msi`,
`.msix`, `.appinstaller`, `.zip`) up to 1 GB and it is stored on the server and
served from the landing page's download button, with its size shown alongside
the version. One build is kept at a time — uploading again replaces it.

`CLIENT_DOWNLOAD_URL` and the URL field beside the upload still work and are
used whenever no installer has been uploaded, so an existing deployment keeps
pointing wherever it already did.

### Launch and save rules

These are what turn an archived folder into something playable:

- A **launch rule** names the executable relative to the install folder. Leave it
  blank and the client picks the largest `.exe` that is not obviously an
  installer or uninstaller.
- A **save rule** says where the game keeps its saves, using placeholders that
  resolve on each machine: `{userprofile}`, `{appdata}`, `{localappdata}`,
  `{documents}`, `{savedgames}`, `{public}` and `{install}`. Optional include and
  exclude globs narrow it further.

---

## Cloud saves

The client hashes the save folder, zips it, and uploads it as an immutable
version. Ten versions are kept per slot, so a bad sync is always recoverable.

Conflicts are detected rather than guessed at. The client remembers the digest it
last synced; when the cloud has moved on from that digest _and_ the local copy
has changed too, both sides hold edits and the client asks instead of picking a
winner. Launching a game pulls a newer cloud save first, but deliberately does
**not** resolve a conflict — starting a game is the wrong moment to make someone
choose which save to destroy.

Restoring moves the existing save folder aside rather than deleting it, so the
previous state stays on disk even if the archive turns out to be wrong.

---

## Achievements

Games here have no achievement runtime of their own, so definitions are imported
and unlocks are reported by the client.

Import a set from **Admin → Catalog → (a game) → Achievements** with a Steam
app id. This reads Steam's _published_ achievement schema — no player data is
requested and no Steam account is linked — which is what makes it usable for a
DRM-free copy of a game that also ships there. Global unlock rates come along
with it and set each achievement's point value.

Because the client is the only thing that can observe progress, unlocks are
self-reported and therefore not cheat-proof. The server keeps them idempotent
and well-formed; it does not adjudicate them.

---

## The desktop client

The client is where players spend all their time. Five tabs down the left:

| Tab          | What is there                                                                        |
| ------------ | ------------------------------------------------------------------------------------ |
| **Home**     | Featured carousel, jump back in, friends playing right now, activity, recent unlocks |
| **Library**  | Games you own — install, launch, playtime, achievements and save sync                |
| **Store**    | The whole archive, filterable, one click to add to your library                      |
| **Social**   | Feed with screenshots and clips, comments, reactions, friends and requests           |
| **Settings** | Profile, install location, save sync, presence, devices                              |

Installing, launching and playtime tracking are handled in Rust: the client
extracts the archive, resolves the executable, watches the game process and
banks playtime as it goes, so a crash mid-session still keeps most of it.

Presence, friend activity and notifications arrive over a WebSocket that
reconnects with backoff. Everything it carries is also readable over REST, so a
dropped socket costs freshness, never correctness.

### Downloads

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

Installers are built by CI on every push to `main` and attached to each tagged
release. Once you have published one, set **Admin → Settings → Windows client
download URL** so the landing page links it.

To build locally you need the [Rust toolchain](https://rustup.rs):

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
| `DATA_DIR`                              | `/data`            | Database, artwork, uploads, cloud saves, client installer  |
| `PORT` / `HOST`                         | `8080` / `0.0.0.0` | Listen address                                             |
| `BASE_PATH`                             | —                  | Sub-path to host under, e.g. `/gameblade`                  |
| `TRUST_PROXY`                           | `false`            | `true`, a hop count, or a CIDR list                        |
| `SECURE_COOKIES`                        | `auto`             | `auto` follows `X-Forwarded-Proto`                         |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD`     | —                  | Creates the first admin, only while no users exist         |
| `ALLOW_SELF_REGISTRATION`               | `false`            | Invite-only when false                                     |
| `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` | —                  | Twitch application credentials                             |
| `STEAMGRIDDB_API_KEY`                   | —                  | SteamGridDB API key                                        |
| `STEAM_API_KEY`                         | —                  | Reads published achievement schemas; no player data        |
| `CLIENT_DOWNLOAD_URL`                   | —                  | Download-button fallback when no installer is uploaded     |
| `MEDIA_QUOTA_MB`                        | `20480`            | Per-account ceiling for avatars, screenshots and clips     |
| `SAVE_QUOTA_MB`                         | `10240`            | Per-account ceiling for cloud saves                        |
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

# API on :8080, landing page and admin panel on :5173 with proxying
pnpm dev

# The desktop client (needs the Rust toolchain and, on Linux, GTK/WebKit dev packages)
pnpm dev:desktop
```

```bash
pnpm -r typecheck
pnpm -r test
pnpm format

# Rust side of the desktop client
cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

### Layout

```
apps/server     Fastify API, scanner, metadata, social, saves, achievements
apps/web        Public landing page and the admin panel (React 19 + Tailwind)
apps/desktop    Tauri v2 client: five-tab UI plus Rust install/launch/sync
packages/shared Types, zod schemas and constants used by all three
```

Server services live in `apps/server/src/services` and are wired in dependency
order in `context.ts`. On the Rust side, `install.rs`, `launcher.rs`, `saves.rs`
and `realtime.rs` hold everything the browser cannot do.

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
- Archive entries are attacker-controlled, so both the game installer and the
  save restorer rebuild every path from its normal components and reject
  anything containing `..` or a root — the zip-slip escape.
- Uploaded saves are verified against the digest the client declared before the
  version is accepted, so a truncated transfer never becomes the copy others pull.
- Profile visibility is applied when a summary is built, per viewer, so a
  friends-only profile never leaks its current game to a stranger.

## License

AGPL-3.0-only.
