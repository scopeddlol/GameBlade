# GameBlade

A self-hosted platform for preserving free-to-play and DRM-free games: a Docker
server that holds the archive, and a Windows desktop client that makes playing
from it feel like a modern game launcher.

**📖 [Full documentation → `Docs.html`](Docs.html)** — open it in a browser. One
file, no build step, and everything below is covered there in depth.

---

## What it is

- **Server, not a web app.** The server hosts the files, a public landing page
  and an admin panel. Everything a player does — browsing, installing, playing,
  achievements, friends, messages — happens in the desktop client.
- **Cloud saves.** Save files sync automatically, with version history and an
  explicit conflict prompt when two machines disagree.
- **Achievements.** Sets are imported from public sources and tracked per
  account, so a DRM-free copy still earns something.
- **Friends, activity and messages.** Live presence, a shared feed, screenshots
  and clips, and direct messages and group chats.
- **Read-only by design.** Your library is mounted `:ro`. GameBlade indexes and
  serves it; it never writes to it.
- **Invite-only.** Self-registration is off by default. Accounts come from
  invite codes an administrator generates.
- **Small.** One Alpine container, SQLite, no external database or cache.
- **One machine, or several.** `gameblade` is everything in one container. A
  `gameblade-coordinator` holds the database and the panel; `gameblade-node`s
  hold the games and serve them straight to clients, and set themselves up from
  a page they serve. One build, an image per role.

| Piece                        | Who uses it   | What it does                                                           |
| ---------------------------- | ------------- | ---------------------------------------------------------------------- |
| **Server** (Docker)          | You           | Reads the library from disk, serves the API, stores saves and profiles |
| **Landing page** (`/`)       | Everyone      | Explains the archive and links the Windows client download             |
| **Admin panel** (`/admin`)   | Administrator | Invites, users, catalog, metadata, featured games, settings            |
| **Desktop client** (Windows) | Players       | The whole player experience                                            |
| **Node** (`ROLE=node`)       | You           | Holds the game files, scans them, and serves bytes straight to clients |
| **Relay** (optional)         | Nobody        | Joins a client and a node that cannot reach each other                 |

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
and invite people from **Admin → Players → Invites**.

> **If it fails to start with a database error**, the `data` folder is almost
> certainly owned by root while the container runs as uid 1000:
> `sudo chown -R 1000:1000 ./data`

Anything at the top level of a library root is one game — a directory or an
archive. Nested folders are that game's files, not separate games.

---

## Where to get it

| Artifact               | Where                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| **One machine**        | `ghcr.io/scopeddlol/gameblade`                                                              |
| **Coordinator + node** | `ghcr.io/scopeddlol/gameblade-coordinator`, `-node`, and `-relay`                           |
| **Windows client**     | The `.exe` on the [latest release](https://github.com/scopeddlol/GameBlade/releases/latest) |

Each image is the role it is named for — there is no `ROLE` to set.

---

## Development

Requires Node 22 and pnpm 10. Not Node 24 — `better-sqlite3` 11 aborts on it,
so `engines` refuses it rather than letting you meet it as an unexplained crash.

```bash
pnpm install
pnpm --filter @gameblade/shared build

pnpm dev          # API on :8080, web on :5173
pnpm dev:desktop  # needs the Rust toolchain

pnpm -r typecheck && pnpm -r test && pnpm format
cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

```
apps/server     Fastify API, scanner, metadata, social, saves, achievements, messaging
apps/web        Public landing page and the admin panel (React 19 + Tailwind)
apps/desktop    Tauri v2 client: the tabbed UI plus Rust install/launch/sync
packages/shared Types, zod schemas and constants used by all three
```

Releases come from CI: stamp the version, tag it, and the Publish workflow
builds the four images and the Windows installers and publishes them together —
see **[Cutting a release](Docs.html#releases)**.

---

## Documentation

| Where                          | What                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **[`Docs.html`](Docs.html)**   | The manual: configuration, the admin panel, scanning, saves, achievements, Discord, the desktop client, messages, security |
| [`docs/API.md`](docs/API.md)   | The `/api/v1` external API reference                                                                                       |
| [`changelog.md`](changelog.md) | What changed, and why                                                                                                      |

`Docs.html` is one self-contained file with no build step: open it in a browser
to read it, open it in an editor to change it. Its contents list builds itself
from the headings, so adding a section is writing a `<section>` and nothing else.

---

## License

AGPL-3.0-only.
