# GameBlade Changelog

## Project Briefing

GameBlade is a self-hosted platform for preserving free-to-play and DRM-free games. It consists of:

- **Server**: A Docker server that holds the game archive, serves the API, stores saves and profiles
- **Desktop Client**: A Windows desktop application built with Tauri + React that provides the player experience

### Technology Stack

- **Frontend**: React 19, Vite, TypeScript
- **Desktop Framework**: Tauri 2 (Rust-based)
- **Package Manager**: pnpm with workspace configuration
- **Build Targets**: MSI and NSIS installers for Windows

### Project Structure

```
apps/
  desktop/          # Tauri desktop client
  server/           # Backend server
  web/              # Web interface
packages/
  shared/           # Shared packages
```

---

## Build Session - August 23, 2026

### Task: Build Installer for Desktop App

**Objective**: Build the Windows installer for the GameBlade desktop application.

### Actions Taken

1. **Analyzed Project Structure**
   - Identified desktop app location: `apps/desktop/`
   - Confirmed Tauri 2 configuration in `src-tauri/tauri.conf.json`
   - Verified build targets: MSI and NSIS installers
   - Current version: 0.4.4

2. **Executed Build Command**
   - Command: `pnpm build` (from `apps/desktop/` directory)
   - Build process:
     - Compiled TypeScript frontend
     - Built Rust backend with Tauri
     - Generated Windows installer bundles
   - Build duration: ~5 minutes 35 seconds

3. **Build Artifacts Generated**
   - **MSI Installer**: `GameBlade_0.4.4_x64_en-US.msi` (3.7 MB)
     - Location: `apps/desktop/src-tauri/target/release/bundle/msi/`
     - Format: Windows Installer package
   - **NSIS Installer**: `GameBlade_0.4.4_x64-setup.exe` (2.7 MB)
     - Location: `apps/desktop/src-tauri/target/release/bundle/nsis/`
     - Format: Nullsoft Scriptable Install System
   - **Executable**: `gameblade-desktop.exe`
     - Location: `apps/desktop/src-tauri/target/release/`

### Build Configuration Details

**Tauri Configuration** (`src-tauri/tauri.conf.json`):

- Product Name: GameBlade
- Version: 0.4.4
- Identifier: io.gameblade.desktop
- Build targets: msi, nsis
- NSIS install mode: currentUser

**Rust Profile** (release):

- Optimization level: s (size)
- LTO: enabled
- Codegen units: 1
- Panic mode: abort
- Symbols: stripped

### Installation Notes

- Both installers are for x64 architecture
- NSIS installer is recommended for most users (smaller, more user-friendly)
- MSI installer is suitable for enterprise deployment tools
- Install mode: per-user (currentUser) - does not require admin privileges

---

## Version 0.5.3a - August 26, 2026

Fixes for what the first 0.5.3 build got wrong, found by actually running it.

### Not a single image loaded

0.5.3 routed every image in the client through a custom URI scheme so artwork
could be cached on disk and survive the server going away. It did not work in a
packaged build, and because _every_ image went through it, every image in the
app was broken — covers, avatars, screenshots, all of it.

Reverted to the direct URL with the device token in the query string, which is
what 0.5.2 did and what works. The response cache stays, so pages already
visited still render offline; artwork now falls back to the initials
placeholder rather than a broken-image icon, which makes an offline library a
grid of titles instead of posters. That is a worse offline library than the one
attempted and an enormously better app than the one that shipped.

An optimisation that takes the whole UI down when it fails is not worth having.

### Everything read as disconnected

The client learns that the socket is up from an event, and an event fires once.
Registering the listener is itself a round trip through the IPC bridge, so a
socket that connects quickly — the normal case — opened before anything was
listening. The frame was then gone for good and the app showed the crossed-out
indicator for the entire time it was connected.

The Rust side now records whether a socket is open, and the UI asks on mount
instead of waiting for a frame that has already been and gone.

### Encryption removed from messages

At the operator's request, and it was the right call. The cost was out of all
proportion to what this is: an archive whose operator already holds every save
file, every screenshot and every password hash. Wrapping message bodies
protected nothing that was not already readable, and it added a failure mode
that was very real — a device with no key wrap for a conversation could not read
a word of it, which is exactly what happened.

Messages are now text the server stores like any other row. Access control is
the whole security model, and it is the half that was always doing the work:
friends only, membership checked on every read and write, attachments that must
belong to whoever is attaching them.

Gone with it: the X25519 identity, the key tables, the wrap and backfill dance,
the fingerprint comparison, the `sealed` media kind, and six Rust dependencies.
Existing message bodies are dropped by the migration — they are ciphertext under
keys it deletes, so there is nothing to convert them into.

### The Messages layout

It flowed down the page, which put the composer wherever the last message left
it and stranded a new conversation's two lines under a header. It now fills the
window: the list and the thread each scroll inside themselves, the composer is
pinned to the bottom edge, and messages sit at the bottom of the space so three
of them look like a conversation rather than three lines of debris.

### Seven CSS rules that were doing nothing

`var(--accent)` was never a token in this stylesheet — the theme's accent is
`--blade-500`. Seven rules added in 0.5.3 referenced it and silently did
nothing: your own message bubbles had no tint, focus outlines were invisible,
the picked state in the conversation picker did not show, and the media viewer's
active thumbnail was unmarked.

---

## Version 0.6.3 - August 29, 2026

0.6.2 made a coordinator and its nodes assemble. This is the release where
pairing one is the only step there is, and where the mesh it exists for
actually switches itself on.

### The hashes were being thrown away

A node reports its catalog within minutes of starting and then spends hours
hashing. Ingest decided whether a game had changed by comparing its size, its
file count and its modification time — none of which hashing touches. So every
game came back "unchanged", the hashes were dropped, and the report that
carried them was counted as a success.

The result was a coordinator with a complete catalog and not one servable game,
on any deployment that had not been a standalone server first. The node was
online, heartbeating, reporting every five minutes and holding a fully hashed
library, and the panel showed nothing wrong. It is the single reason the mesh
appeared not to work.

Ingest now also compares how much of a game is hashed, so work that happened
since the last report is work that lands. The steady state is unaffected: a
node reporting the same hashed library every five minutes still writes nothing.

### A node makes its own library

Enrolling one used to leave it idle. A node's catalog has to land in a library,
a coordinator holds no files, so an operator had to create a library, give it a
path that does not exist on that machine, and come back to assign it — three
steps of ceremony around a decision with exactly one sensible answer, during
which the node reported into nothing and said so only in a log.

It gets one when it registers, named after it. Reports are refused until a node
has a library, and now every node has one from the moment it exists.

The exception is a node taking over a library that already exists — replacing
hardware, or splitting a standalone server apart — and that is chosen on the
enrolment code rather than afterwards. Doing it afterwards is a race the
operator loses: the node reports into its fresh library first and the catalog
every achievement, save rule and playtime record hangs off is orphaned.

All of a node's own library roots report into that one library. A node with
more than one root prefixes each game's path with the root it came from, so two
roots that both hold `Hollow Knight` stay two games. A node with one root — the
node image's configuration, and almost every node — reports paths unchanged,
because changing the path of a game already reported makes it a stranger.

### A node asks before it reads

The first thing it does after pairing is ask the coordinator which of the games
it holds are already hashed, and take those hashes rather than recomputing
them. Hashes describe file contents, so a copy that matches is described by them
exactly — and on a coordinator split off a standalone server, or one that
already has another node holding the same games, that is the whole library and
the hours disappear.

Matched on relative path, checked file by file on size, adopted all-or-nothing
per game. Anything that does not line up is hashed locally as before, because
adopting hashes for bytes a machine does not have means advertising a game and
then failing every chunk of it.

### The relay stopped being optional

On one machine, a client that cannot reach a node downloads from the server and
nobody notices. A coordinator holds no game files, so there is no such
fallback: without a relay, a player behind a symmetric or carrier-grade NAT
cannot download anything at all, and it reads as a broken archive rather than
as the network they are behind.

It is a service in `docker-compose.coordinator.yml` now, not a commented-out
block. What kept it optional was the setup: its one required value was the
coordinator's public key, published to nodes at enrolment and nowhere else, so
standing one up meant reading a field out of a JSON file on a different machine.
The coordinator publishes that key at `/api/mesh/coordinator-key` — safe
unauthenticated, being the public half everything already receives — and the
relay fetches it, waiting for a coordinator that has not booted yet rather than
dying because it came up first.

`RELAY_ENDPOINT` is the one value that cannot be derived, because only you know
your public hostname. Leaving it empty does not stop the coordinator — most
players' connections punch through and for them it changes nothing — but it
does mean the relay runs with nobody ever being sent to it. So it is a warning
in the log at boot and a finding on **Admin → Insights → Health**, rather than
something a player who cannot install anything finds out for you.

---

## Version 0.6.2 - August 29, 2026

The release where a coordinator and its nodes stop being a thing you assemble
and start being a thing you deploy.

### An image per role

`ghcr.io/scopeddlol/gameblade-coordinator`, `-node` and `-relay`, alongside the
standalone `gameblade` that has always been there. Each sets its own role, so
there is no `ROLE` in a compose file: pulling the coordinator image has already
said what that container is, and saying it a second time is a thing to get
wrong — a coordinator accidentally left as a standalone scans libraries it
cannot read and flags the catalog its nodes just reported, and looks fine doing
it.

One build, one Dockerfile, four targets. They are the same filesystem with
different metadata on top, so a coordinator and its nodes cannot drift into
disagreeing about the catalog they exchange, and pulling two onto one host
pulls the layers once. `ROLE` still overrides for anyone already setting it.

A node is now one container rather than two. The scanner and the mesh agent are
an implementation detail — one is Node, the other is Rust — and not something
an operator should be keeping in step across two services that each had to be
told the same library path and the same state path. They run under a shared
entrypoint that takes the container down if either dies, so the restart policy
brings back a working pair instead of leaving half a node running.

### A node sets itself up

Bring one up with nothing configured, open its page, and give it the
coordinator's address and an enrolment code. Both processes pick the answers up
without a restart, and the form disappears once the node has enrolled.

The alternative was editing a compose file on the machine with the games on it
and restarting the container, for two values entered once. It is bounded like
the coordinator's own first-run administrator screen, which is the same shape of
problem: it exists only while the node is not enrolled, it grants nothing by
itself — the code is checked by the coordinator — and the page it lives on is
bound to localhost by default.

`COORDINATOR_URL` and `ENROLMENT_TOKEN` still work and still win.

### It stays connected

A rejected credential was permanent. The heartbeat logged "refused" every thirty
seconds for ever, the coordinator marked the node stale and stopped handing it
to clients, and the process sat there healthy serving nothing until somebody
noticed and restarted it. A node deleted and re-enrolled, a token rotated by a
registration elsewhere, an operator who blocked it and changed their mind — all
of them ended there.

Both halves recover by themselves now. The agent registers again with the key
that has always been its identity, which is what a restart would have done
without the restart, and the server beside it rereads the credential the agent
just wrote. The catalog reporter also paces itself: every ten seconds while a
node is not yet reporting, every five minutes once it is, and chained rather
than on a fixed interval so a slow report cannot start the next one on top of
itself.

### Performance

The mesh crate builds with fat LTO and a single codegen unit. It is the reason
the transfer path is in Rust at all — it hashes every chunk on the way out and
again on the way in — and the default release profile leaves the optimiser
unable to see across codegen units or across into quinn, rustls and sha2, which
is where that work actually happens. It costs build time, once, on a machine
that is not yours.

Two things found while assembling a real pair, both of which would have hurt at
two nodes: `/api/mesh/catalog` returned the whole database, so each node fetched
the file layout of every other node's games on every heartbeat and stat-ed them
against its own disk; and the agent rebuilt index entries whose fingerprint had
not changed. Scoped and cached respectively, a steady-state refresh is now one
request rather than one per game.

### Releases come from CI

The PowerShell build scripts are gone. There is no longer a step that depends on
somebody having a Windows machine, the right toolchain, and the discipline to
run the same command every time — which is the arrangement that lets a release
ship with one manifest still on the previous version.

Stamp the version, tag it, and Publish does the rest: it refuses a tag whose ten
manifests do not all agree, builds and pushes the four images, builds the
Windows installers, and publishes the release with both attached. CI also builds
every role image and boots each one, checking that `/api/health` names the role
the image is for, that a node comes up with nothing configured and serves its
setup page with both processes alive, and that the relay refuses to start
without its key and says which one.

### One empty folder stopped a node's whole catalog

Found by writing the end-to-end test rather than by deploying: an empty
directory in a library scans as a game with no files, and its fingerprint is
the newest of no modification times — the empty string. A catalog report is all
or nothing, so the coordinator refused the entire thing as malformed.

The node enrolled, heartbeated, and reported every five minutes, and none of
its catalog ever arrived. Nothing was on fire and nothing said so anywhere but
a log. Games predating the column were null and did the same.

The report now falls back to a timestamp the node already holds, so the game is
described accurately rather than dropping the four thousand beside it.

### Assembling one turned out to be four faults deep

Before any of the above could matter, four things had to stop being true. Each
stopped the deployment dead and none of them said anything, which is how a
release went out over the top of them. None touches a standalone server, which
is exactly how they survived.

### A node could not enrol

The two processes on a node share one state file: the mesh agent generates the
keypair and registers, and the server beside it picks that registration up and
reports the catalog against it. That is what makes them one node rather than
two.

They spelled the file differently. The agent wrote `secret_key`; the server
looked for `secretKey`. So the agent enrolled and served quite happily while
the server sat waiting for a key it could not see, logging "waiting for the
mesh agent to generate this node's key" every five minutes, for ever. The
catalog was never reported, which on a coordinator means the games do not
exist.

The agent now writes the casing the server reads, and reads either, so a state
file from 0.6.1 keeps its identity instead of enrolling as a stranger. Pinned
with a test that asserts the bytes on disk rather than a round trip through the
struct — a round trip agrees with whatever casing both ends of the round trip
happen to use, which is precisely the thing that was wrong.

### A node could not hash the games it holds

Nothing is servable over the mesh until every one of a game's files has
per-chunk hashes: a client will not accept a piece it cannot verify. Computing
them is an API call, and a node has no API — deliberately, since it owns no
accounts, settings or catalog of record.

So on a coordinator/node split there was no machine that could do it. The
coordinator has the API and no files; the node has the files and no API. Every
game stayed ineligible for ever, the mesh switch did nothing, and because a
coordinator has no copy to fall back on, that is not a slow download but no
download.

A node now hashes what it scanned by itself, half a minute after boot and every
ten minutes after. It waits for the scanner rather than competing with it for
the disk, skips what is already hashed from the chunk table rather than by
re-reading it, and stops between games, so a restart resumes instead of
starting a multi-terabyte archive again. `AUTO_CHUNK_HASH=false` turns it off
for an operator who would rather spend the disk deliberately.

Still not the default anywhere else. A standalone server can always serve the
file itself, so hashing stays the explicit per-game decision it has been.

### A coordinator would not accept a library

Creating a library checks that the path is a readable directory inside the
container. That is the right check on a machine that reads its own files — a
library nobody can read is a scan that finds nothing for a week and says so
nowhere — and impossible on a coordinator, whose games are on somebody else's
disk and which mounts no library at all.

A node's catalog is filed into an assigned library and reports are refused
until it has one. So a coordinator could not be given a working node, and the
topology could not be assembled from a clean install by any route that did not
involve mounting empty directories to lie to the check.

The check now applies where it means something.

### And then a coordinator scanned that library and deleted the catalog

Scanning was gated on `SCAN_ON_START` and `SCAN_INTERVAL_MINUTES`, not on the
role. A coordinator therefore scanned the libraries describing what its nodes
hold. A path that does not exist fails the walk and is skipped; one that exists
and is empty succeeds and reports zero games — so the empty directories from
the previous fault read as a library whose games had all been deleted, and the
scan flagged the entire catalog its nodes had just reported.

The role decides now, and says so in the log at boot. Both settings are ignored
on a coordinator, so they can be left, removed, or set wrongly.

### A node was told about every other node's games

`/api/mesh/catalog` returned everything in the database. A node fetched the
file layout of every game on it, on every heartbeat, and stat-ed every file of
each against its own disk — including every game belonging to every other node,
which it will never hold. Two nodes with real libraries meant thousands of
requests and filesystem checks a minute to learn nothing.

Scoped to the node's assigned library, and to games that are not flagged
missing. A node with no library is a mirror and still syncs against everything,
which is what a mirror is for.

The agent also stopped rebuilding what it already knew: an entry whose
fingerprint the coordinator is still announcing is carried across rather than
re-fetched and re-checked, so a steady-state refresh is one request instead of
one per game.

### Documentation

`Docs.html` gains **a coordinator and two nodes, in production** — the build in
order, with Caddy in front of the coordinator, the nodes on a LAN, and their
status pages reachable both over the LAN and through a tunnel.

The rest of it was audited against the code rather than against the last
version of itself, which turned up: sixteen of twenty-six environment variables
documented and none of the ones that make a role a role; two hashing controls
described as buttons in an admin panel that has never had them; the mesh
switches on a tab that does not exist; the relay's key said to be somewhere it
is not shown; backups described with two config keys that are three settings on
a page; and a "New in 0.6.1" badge, hard-coded, on eleven blocks describing
0.5.3.

---

## Version 0.6.1 - August 28, 2026

0.6.0 moved GameBlade off one machine. This is the release that checks the
result actually works, on the platforms it has to work on.

### Sharing a download never worked on Windows

The client that seeds pieces of games to other players bound its listening
socket to `[::]` and relied on the operating system to accept IPv4 on it too.
Linux does. Windows does not — `IPV6_V6ONLY` defaults on there — so on the only
platform the client ships for, a seeding player's socket could not receive an
IPv4 packet, which is nearly all of them.

Nothing reported it because there was nothing to report: a peer that cannot be
reached is indistinguishable from a peer that has nothing anybody wants. The
whole feature was off, silently, for everyone who turned it on.

The socket now clears the option before binding, and falls back to IPv4 if that
fails rather than returning one half the internet cannot reach.

The tests that would have caught this existed and passed — on Linux, which is
the only place CI ran them. Seven of the eight end-to-end transport tests fail
on Windows without this fix. That job now runs on both.

### A node can be looked at

A node ran the coordinator's entire web application: its own empty database, its
own admin panel over a catalog it does not own, and its own first-run "create
the first administrator" screen, on a port an operator might reasonably expose.
None of it meant anything, and one part of it was a liability.

It now serves a page about itself instead — what it scanned, how many files have
the per-chunk hashes that let them be served, whether it enrolled, and when it
last reported to the coordinator, with the reason if that failed. It answers the
question people actually stand in front of a node to ask, which until now had to
be answered by reading container logs.

The API and the panel are not mounted at all in the `node` role, rather than
mounted and ignored. `docker-compose.node.yml` publishes the page on localhost.

`/api/health` also names the role now. Three containers answered it identically,
which is unhelpful when the thing you are trying to establish is which one you
just reached.

### Reporting a catalog is one transaction

Ingest wrote each game as it decided about it: three or four statements per
entry, thousands of entries per report, all of them prepared and held for the
length of a synchronous loop. A report that failed halfway left the catalog
halfway written.

It now sorts the work out in memory and writes it in batches inside a single
transaction. Five hundred games went from thousands of prepared statements to
twelve. The whole report lands or none of it does.

### The client's own tests did not run on Windows

Two of them failed there, and only there, which for a Windows-only client means
they were failing everywhere that counts. One built a temporary directory name
out of a debug-printed timestamp, which contains colons and therefore cannot be
a Windows path, so the test died creating its own fixture. The other asserted a
forward slash in a path list that is built from `PathBuf` and so came back
back-slashed.

The path list is now normalised to forward slashes before it is persisted. It is
read back to clean up after a cancelled download and Windows joins either form
happily, so this only means the queue file no longer records which platform
wrote it.

### Node 24 is refused rather than discovered

`engines` claimed Node 22 or newer. On Node 24, `better-sqlite3` 11 aborts the
process outright — `Assertion failed: (env) != nullptr` — once enough SQLite
work goes through it in one burst, which ingesting a real catalog does. The
image and CI both run Node 22 and were never affected; a developer on current
Node hit it as a crash with no explanation.

The range is now `>=22 <24`, which is the truth. Lifting it means upgrading the
driver.

---

## Version 0.6.0 - August 28, 2026

The release GameBlade stops being one machine. A coordinator holds the database
and the panel, nodes hold the game files, and clients fetch bytes straight from
a node instead of dragging every download through the proxy in between.

Nothing here switches itself on. `standalone` is still the default role, so an
existing install that upgrades behaves exactly as it did.

### Downloads no longer have to cross the proxy

Every byte used to travel through whatever sits on the public internet, because
that was the only thing clients could reach. A client now talks directly to the
machine holding the files.

- **Files are addressed by content.** Each is cut on a fixed 8 MiB grid — the
  same grid the downloader already cut transfers on — and every piece carries
  its own SHA-256. A whole-file hash only reports a bad download once every byte
  has arrived, which is no basis for deciding whether to keep a piece that came
  from somewhere new. Pieces are now checked as they stream, so a bad one costs
  one chunk rather than the whole game.
- **The transport is QUIC, and deliberately not a VPN.** A VPN would mean a
  virtual network adapter, which on Windows means a driver, an elevation prompt,
  antivirus attention and a firewall dialog — all so the operating system can
  route packets that only ever reach one process. Terminating QUIC inside the
  app gets the same encrypted, NAT-traversing, congestion-controlled path with
  nothing for anyone to install, approve or notice.
- **A node is its key, not its address.** It presents a self-signed certificate
  carrying its Ed25519 key and the client pins it against what the coordinator
  named, so "did I reach the right machine" is answered locally. Addresses
  change every time a home connection renews its lease; identities must not.
- **Several sources at once, ranked by what they deliver.** The download queue
  already handed each idle connection the next unfinished chunk, so this adds
  one decision to it rather than a second download path. Sources are scored on
  measured throughput, not assumption; a node that fails three times in a row is
  set aside, and one serving bytes that do not match their hash is dropped at
  once.

### Three roles, one image

- **`standalone`** — everything in one process, reading games off local disk.
  The default, and unchanged.
- **`coordinator`** — database, admin panel, landing page and API, with no game
  files. Small enough for a modest VPS, because coordination is kilobytes.
- **`node`** — the game files. Scans them and reports what it found upward.

One image rather than one per role, because a coordinator and its nodes have to
agree about the catalog they exchange and separate artifacts are how they
quietly stop agreeing.

### Moving a coordinator is a copy, not a migration

The database is not converted or restructured. A node's catalog is matched into
a library by relative path, exactly as the local scanner matches it, so **an
existing game keeps its id** — and with it every achievement, save rule, artwork
match, favourite, collection entry and playtime record. Only file-derived fields
are ever written; a scan has no opinion about a title somebody corrected or the
artwork they chose, so it writes neither.

Which library a node reports into is an explicit administrative assignment, and
reports are refused until it is made. Pointing a node at the wrong library would
re-add an entire catalog as strangers and orphan the metadata on the originals,
which is the worst thing this code could do, so it will not do it quietly.

### The relay

A coordinator holds no game files, so there is no plain HTTP download to fall
back on when a client cannot reach a node directly. The relay is that fallback:
both ends dial out to it, and it pastes the two connections together.

It is the least clever component here on purpose. It never terminates TLS, never
parses a chunk request, never learns which game is moving through it, and holds
nothing but a table of which two sockets belong together. The QUIC session runs
end to end, so what passes through is ciphertext it could not read if it wanted
to — and every guarantee made elsewhere survives untouched.

Only reached after a direct attempt fails, counted against the same allowance as
any other bytes, and capped so the exception path cannot quietly become the main
road.

### Sharing, if you choose it

Players can serve pieces of games they have installed to other players. Gated
twice and off at both: an operator turns it on for the server, each player turns
it on for themselves, and neither implies the other. Every piece is re-checked
against the manifest before it is sent, so an edited or modded install simply
stops being a source.

### Finding out first

`mesh-doctor`, and a dependency-free `scripts/nat-check.py` that needs no
toolchain, answer the question the whole design depends on before anything is
deployed: can a client actually reach this machine directly? It measures the
NAT's mapping behaviour rather than guessing from how many layers there are —
double NAT is routinely punchable and single NAT routinely is not.

### Fixed on the way

- **Hole punching was a no-op.** Punches left from a throwaway socket while QUIC
  used another. NAT mappings are per source port, so between two machines behind
  NAT — the entire case punching exists for — the direct path could never
  establish.
- **About one node in thirty-two was undialable at random.** Identity labels
  were base64url, whose alphabet includes `-`, and a DNS label may not begin
  with one.
- **A node credential was derivable from its public key**, which is handed to
  every client that resolves a game.
- **IPv6 candidates were silently discarded** — unbracketed addresses do not
  parse. Those are the ones most likely to work.
- **rustls panicked on provider detection**, since the desktop binary links it
  twice. It would have fired the first time a player touched the mesh.
- **The image build compiled two crypto libraries to do one job**, which is most
  of why it filled a build host's disk.

---

## Version 0.5.3 - August 26, 2026

The release the scanner gets fixed, the client stops needing the server to be
alive, and messages arrive.

### The library scanner

Three separate faults, all of which looked like the same symptom: a scan that
started at boot and never finished.

- **The progress readout carried counters between phases.** A run part-way
  through its second library reported the _first_ library's finished tally —
  "25 / 25" — for as long as the second one took to read, which is
  indistinguishable from a scan that has completed and hung. Counters are
  cleared when the phase or the library changes, and the reading walk now
  publishes what it has found so far.
- **The reading walk never yielded.** On a large share on a spinning disk that
  is minutes during which the server answers nothing — including the progress
  endpoint the operator is refreshing to find out what is happening. It hands
  the loop back every two hundred entries now, and the whole walk carries a
  thirty-minute deadline so a share that stops answering ends the library
  rather than the run.
- **Enrichment could genuinely take an hour on one game.** A matched title
  downloads its cover and then every screenshot IGDB publishes — dozens, each
  with a minute-long deadline and a retry behind it — and none of it was
  interruptible, because the abort signal stopped at the provider call and
  never reached the image cache. Screenshots are capped at twelve, the signal
  is threaded all the way down, and a title that has not finished in ninety
  seconds is abandoned with a line saying so.

Around that: a **Stop** control, since Skip is no help when the problem is the
run itself and restarting the container was the only other way out; a
**heartbeat**, so the panel says "no progress for four minutes" rather than
leaving somebody watching a spinner; and **batched enrichment** that keeps
going until nothing is left, where one fixed limit of 500 quietly abandoned
everything past it.

`withRetry` also treated a caller's own abort as retryable, so pressing Skip
cost three rounds of backoff before anything visibly happened.

### The database

The pragmas assumed a small database or a fast disk, and this is neither. A
64 MiB page cache, a memory map, 8 KiB pages on a new file, and a
write-ahead log that checkpoints a quarter as often. Statistics and a
checkpoint now run hourly — SQLite only gathers them when asked, so a catalog
that grew from fifty games to five thousand was still being planned as if it
were small.

Ten indexes for queries that had none. Every shelf and library page filters on
"not missing" and then sorts, which a single-column index on `missing_at` only
half satisfies; leading each composite with it removes the sort. Also the
enrichment queue's exact filter, playtime grouped by game, and unlock counts by
achievement — all of which were table scans.

**Insights → Health** gains what the file costs, what a rebuild would reclaim,
and buttons for both jobs.

### Messages

Direct messages and group chats, end-to-end encrypted. The server routes them
and cannot read them: every body and every attachment reaches it already
sealed, and it holds no key that opens one — because it is never asked to make
one. A conversation key is generated and wrapped on a client, since the moment
the server could seal it, it could read it.

Each device has a long-lived X25519 identity kept in the OS credential store,
which never leaves that machine and never crosses into the web view. The
conversation key is wrapped per device with ECDH and HKDF-SHA256; bodies and
attachments are XChaCha20-Poly1305 with a fresh nonce each time. The plaintext
is a JSON envelope rather than bare text, so an attachment's name and type are
encrypted too — the server can say a file was sent, not that it was a
screenshot whose filename gives away which game.

The limits are on the screen rather than only in a design document: the server
distributes the public keys, so fingerprints exist for two people to compare by
voice; there is no ratchet, so no forward secrecy; and who talks to whom is
visible whatever the content says. Groups up to 32, friends-only, withdrawal
that clears the ciphertext rather than hiding the row.

### The client works offline

Any outage used to take the whole client with it: the sign-in check failed, the
app fell back to the login screen, and the login screen could not reach the
server either. A library of installed games sitting on the local disk was
unreachable because a _catalog_ was.

An unreachable server and a revoked device are no longer the same answer. The
client caches the last response to each read and every piece of artwork, so
pages already visited still render and covers come off local disk — which also
makes every launch after the first much faster. The library falls back to the
install records themselves, so changing the sort does not empty the page. A
banner says what still works rather than only that something is wrong.

### Cloud saves, finished

The setting has said "pull before launching and push after quitting" since the
client was written, and only the pull was ever implemented — so a player who
turned it on had a cloud copy frozen at whenever they last pressed Upload, and
a fresh install would then restore that over their real progress.

Uploading now happens at the three moments a save is actually lost: when the
game closes, optionally every few minutes during a long session, and on
sign-in for whatever the previous session never managed to send.

### Achievements that cannot sync

A game with unlock rules and no save rule is not a game whose save location is
unknown. An unlock rule reads a file the game wrote into its own save folder,
so the location has already been written down — in a column that syncs nothing.
**Save paths** now derives them, folding rules that share a folder into one
proposal and offering genuinely separate layouts as a choice. Health calls it
out separately, because those players lose their unlocks along with their
saves, and an unlock cannot be copied back by hand.

### Discord

**Tagging people, roles and channels.** Three pickers insert a real mention at
the cursor — typing a snowflake by hand works and nobody does it. And the thing
that surprises everyone: Discord never notifies for a mention inside an embed,
so the composer offers to repeat the tags on a line above it and explains why.

Every outgoing message now carries an explicit permission list naming exactly
the ids the text contains, so a game summary containing the word `@everyone`
cannot ping a server. `@everyone` itself is opt-in with its own tick.

### Stopping a game

The Play button became a greyed-out "Running", which is true and no help at all
to somebody whose game has hung behind a fullscreen window. Stop is on the
game's page, the right-click menu and the title bar; the process is asked to
close first so it can save, and killed if it will not answer.

### Media and profiles

Screenshots opened into the 440-pixel dialog used for confirmation prompts.
There is now a full-viewport viewer with arrow keys, a filmstrip and a
fit/full-size toggle; trailers play inline; clips play where they sit.

Profiles gain pronouns (free text, because no fixed list is complete), a status
line, banner framing, up to five labelled links, and one pinned game — as
distinct from "most played", which is what the section calling itself
_Favorite games_ actually was.

**Show Discord on Profile** changed the friends rail and nothing else,
including the profile page it is named after. Every path that builds a profile
now resolves the handle the same way.

### Requests

Covers rendered at whatever size the provider sent, because the aspect ratio
was on the image, whose height resolved against nothing while it was loading.
Clicking a card did nothing, although everything the provider sent was already
on the client. And the delay before the tab appeared was the shelves: hovering
prefetched the digest and nothing else, so the slowest query did not start
until the tab was already open. All three are fixed.

### Documentation

The README was 938 lines. It is now 120, covering what it takes to get a server
running, and the manual moved to **`Docs.html`** at the repository root — one
self-contained file with no build step, whose contents list builds itself from
the headings so adding a section is writing a `<section>` and nothing else.

---

## Build Session - August 25, 2026 (Discord bot)

## Version 0.5.2 - August 25, 2026

The Discord integration gains a live bot. Everything before this was REST: the
server could post, which a webhook could also do. A bot that is _online_, that
answers a slash command and that reacts to a button all need a gateway
connection, and that is what this adds.

Written against Node's own `WebSocket` rather than pulling in discord.js — the
library is excellent and roughly two hundred times the size of what is needed
here, which is identify, heartbeat, resume, one presence frame and one dispatch
event. No new dependency.

### The bot

- **Start and stop it** from the panel. Starting opens the gateway connection,
  which is what puts it in the member list. The switch is persisted, so the bot
  comes back by itself after a restart, and the connection resumes on its own
  when Discord drops it.
- It asks for **no intents at all**, so nothing has to be enabled in the
  developer portal and the bot cannot read anybody's messages even in
  principle. Interactions arrive regardless.
- A wrong token, or a refused intent, **stops the bot and says which** rather
  than reconnecting for ever against an error only the operator can fix.
- A connection whose heartbeats stop being acknowledged is torn down and
  rebuilt. Without that check a bot reads as online in the panel and offline in
  the server, which is the most confusing state this can be in.
- **Status and activity** are configurable: the coloured dot (online, idle, do
  not disturb, invisible) and the line under the name (Playing, Streaming,
  Listening to, Watching, Custom, Competing in). A change is pushed over the
  open socket rather than reconnecting for a cosmetic edit. A custom status
  puts its text in `state`, which is where Discord reads it from.

### Posting

- **Pick the channel** a post goes to. The channel and role boxes are real
  pickers once the bot can see the server, and fall back to pasting an ID when
  it cannot.
- **Attach an image.** It is uploaded here first and sent on as a genuine
  Discord attachment rather than as a link — the media route needs
  authentication, so a link would hand Discord a 401, and opening the media
  store to the internet to avoid that is not a trade worth making.
- A post may now be a picture with no caption.

### Tickets

- A **Ticket Tool-style system**: a panel with a button in a support channel,
  a modal asking what the problem is, and a private channel per ticket that
  only the opener, the staff role and the bot can see.
- Closing asks once, deletes the channel and keeps the record in the panel. A
  Discord that accumulates two hundred dead `#ticket-0042` channels is worse
  than no ticket system, which is why the record lives in the database rather
  than in the channel.
- One open ticket per person, so a bored click cannot open forty channels.
- Switching tickets off makes the button refuse politely: a panel is a message
  and outlives the setting that produced it, so it cannot be unposted.

### `/profile`

- A slash command that answers with the caller's GameBlade profile — avatar,
  games, hours, achievements, friends, join date and what they are playing.
  Registered against the operator's guild rather than globally, so it appears
  the moment the bot connects instead of up to an hour later.
- Someone who has not linked their account is told how to, rather than getting
  an error.

### Notes

- No desktop client changes; none of this touches it. Its version moves with
  the workspace so the repository has one number, but no installer is built
  for this release.
- One migration, `0015_discord_tickets`.

---

## Build Session - August 25, 2026

## Version 0.5.1 - August 25, 2026

### Discord

- Send people to Discord's consent screen rather than to the REST API. The
  authorize URL was built from the API base, so every attempt to link or sign
  in landed on `/api/v10/oauth2/authorize` — a path that answers no GET. No
  consent screen meant no code, no link, and nothing for the bot to act on.
- Allow `cdn.discordapp.com` in the content security policy, so a linked
  player's avatar renders instead of being blocked.
- Accept a bot token pasted as `Bot <token>`, and trim whitespace around every
  Discord credential.
- Identify the application to Discord on every request. A request with no
  User-Agent is answered with a Cloudflare block page, which arrives as a 403
  full of HTML and reads exactly like a rejected token.
- Retry once when Discord rate-limits, honouring its own `Retry-After`.
- Render Discord's own failures as the result page rather than as a JSON error
  body, and report a status code in the operator's terms.
- **Test** now walks every step between a stored token and a message arriving —
  the token, whether the bot was invited, whether it can see the channel,
  whether it may post — and reports each separately.
- Log a failure to add someone to the server instead of swallowing it.

### Achievements

- **New: Admin → Catalog → Achievements.** Bulk-import from Steam across as
  many games as you select, a few at a time, with live progress, a stop button
  and a per-game report; unlock rules are written alongside. Plus a paste box
  for the games Steam cannot help with, taking tab-, comma- or pipe-separated
  lines.
- Moved unlock-rule generation onto the achievement service, so the bulk
  importer and the per-game button write rules through the same path.

### Admin panel

- The Catalog worklist and its gap counts now refresh the moment an edit lands.
  Filtering by "No launch exec", fixing one and watching it sit there wearing
  the pill for the thing it no longer lacked was the single most annoying thing
  about triaging a catalog.
- One page shell for every admin screen. Widths ran from `2xl` to `5xl`, half
  the pages centred and half not, so moving between two sub-tabs of one section
  shifted the column and slid the page sideways.
- Say where the tagline actually appears, and what overrides it.

### Desktop client

- Settings is a real tab strip. One section on screen, the tab that opened it
  stays lit, the card glows briefly to confirm the click, and arrow keys move
  along the strip. It was a scroll-spy jump list over a two-column page, so the
  highlight tracked an order nobody could see and nine entries sat two pixels
  apart.
- Every suggestion card on the Requests tab is one size. The shelves pinned
  theirs to 168px while the search grid let its tracks stretch, and the blurb's
  two-line clamp was written against a class the markup never used, so a wordy
  summary grew its card without limit.
- **Simultaneous transfers** and **Verify downloads** now do something. Both had
  been saved to settings.json since the page was written and never read: every
  download ran four files at a time and always hashed.
- **Sync saves automatically**, **Ask before overwriting**, **Minimize when a
  game starts** and **Share what I'm playing** likewise. The last one is held
  for the session's lifetime server-side, because the heartbeat re-asserts
  what is being played every time it fires.
- Removed the Library layout control from Settings. The Library tab's own
  switcher sets it, above the grid it changes, and offers all three layouts
  where this copy knew two — so using it silently discarded a "detailed"
  choice.

---

## Build Session - August 24, 2026

## Version 0.5.0 - August 24, 2026

- Added automatic Steam AppID discovery and achievement import from each game's admin page.
- Added a Catalog/Games filter for records whose source game files are missing.
- Improved save-manifest matching for unambiguous edition-title variants.
- Made folder-game downloads use a shared 16-connection stream across concurrent files.
- Validate and start the Discord REST bot integration at server startup and when its token changes.

### Task: Pull Latest from GitHub and Build v0.4.5

**Objective**: Pull the latest changes from the official GitHub repository and build the Windows installer for version 0.4.5.

### Actions Taken

1. **Pulled Latest Changes from GitHub**
   - Repository: https://github.com/scopeddlol/gameblade
   - Tag: v0.4.5
   - Cloned to temporary directory and copied to main workspace
   - Updated all project files to latest version

2. **Version Updates**
   - Updated `apps/desktop/package.json`: version 0.4.4 → 0.4.5
   - Updated `apps/desktop/src-tauri/tauri.conf.json`: version 0.4.4 → 0.4.5
   - Updated `packages/shared/package.json`: version 0.4.4 → 0.4.5

3. **Dependency Installation**
   - Ran `pnpm install` from root directory
   - Lockfile was up to date
   - Built shared package: `packages/shared` with TypeScript compilation

4. **Executed Build Command**
   - Command: `pnpm build` (from `apps/desktop/` directory)
   - Build process:
     - Compiled TypeScript frontend with Vite
     - Built Rust backend with Tauri 2
     - Generated Windows installer bundles
   - Build duration: ~5 minutes 5 seconds

5. **Build Artifacts Generated**
   - **MSI Installer**: `GameBlade_0.4.5_x64_en-US.msi` (3.7 MB)
     - Location: `apps/desktop/src-tauri/target/release/bundle/msi/`
     - Format: Windows Installer package
   - **NSIS Installer**: `GameBlade_0.4.5_x64-setup.exe` (2.7 MB)
     - Location: `apps/desktop/src-tauri/target/release/bundle/nsis/`
     - Format: Nullsoft Scriptable Install System
   - **Executable**: `gameblade-desktop.exe`
     - Location: `apps/desktop/src-tauri/target/release/`

---

## Version 0.4.6 - August 24, 2026

### Summary

Version 0.4.5 had critical build and runtime issues. Version 0.4.6 is a complete fix release that addresses all identified problems.

### Issues Fixed in v0.4.5

1. **Desktop App TypeScript Compilation Errors**
   - The shared package types were updated in v0.4.5 to include new properties (`discordUsername`, `popularHere`, `acclaimed`, `surprise`)
   - The desktop app failed to compile because it wasn't picking up the updated type definitions
   - Files affected: `ProfileDrawer.tsx`, `HomeTab.tsx`

2. **Web Panel Domain Inaccessibility**
   - Server logs showed the application was running correctly
   - However, navigating to the domain returned nothing
   - Root cause: The web app (`apps/web`) was not built, so the server had no static files to serve

3. **Windows Dev Server EBUSY Error**
   - Vite dev server crashed with `EBUSY` error when watching Rust build directories
   - Fixed by adding watch exclusions for `target/` and `dist/` directories in vite.config.ts

### Actions Taken for v0.4.6

1. **Rebuilt All Packages**
   - Rebuilt shared package to ensure updated types are available
   - Built web application to fix server domain accessibility
   - Desktop app now compiles successfully with new type definitions

2. **Added Installer Customizations**
   - Added `tauri-plugin-updater` for automatic updates
   - Configured updater to check GitHub releases for updates
   - Created `LICENSE.txt` with GameBlade EULA
   - Updated `tauri.conf.json` with updater plugin configuration

3. **Fixed Dev Server**
   - Added watch exclusions to vite.config.ts to prevent EBUSY errors
   - Dev server now runs without crashing on Windows

### Build Artifacts (v0.4.6)

- **MSI Installer**: `GameBlade_0.4.6_x64_en-US.msi` (3.7 MB)
- **NSIS Installer**: `GameBlade_0.4.6_x64-setup.exe` (2.7 MB)
- **Web App**: Built successfully in `apps/web/dist/`
- **Shared Package**: Type definitions updated and compiled

### Technical Details

**Auto-Update Configuration**:

- Plugin: `tauri-plugin-updater` v2.10.1
- Update endpoint: GitHub releases
- Signature verification: Enabled with public key
- Dialog: Built-in Tauri update UI

**Dependencies Added**:

- `@tauri-apps/plugin-updater` (npm)
- `tauri-plugin-updater` (Cargo)

**Files Modified**:

- `apps/desktop/package.json` - version 0.4.5 → 0.4.6
- `apps/desktop/src-tauri/tauri.conf.json` - version 0.4.5 → 0.4.6
- `apps/desktop/src-tauri/Cargo.toml` - version 0.4.5 → 0.4.6
- `packages/shared/package.json` - version 0.4.5 → 0.4.6
- `apps/web/package.json` - version 0.4.5 → 0.4.6
- `apps/desktop/vite.config.ts` - added watch exclusions
- `apps/desktop/LICENSE.txt` - created EULA
- `apps/desktop/src-tauri/src/lib.rs` - added updater plugin

### Notes

- v0.4.5 is deprecated and should not be used
- v0.4.6 is the stable release with all fixes applied
- The auto-update mechanism will check GitHub releases for new versions
- Users will see an in-app dialog when updates are available
- Public key is a placeholder and should be replaced with a real key for production

---

## Build Session - August 24, 2026 (Bug Fixes)

### Task: Fix v0.4.5 Build and Runtime Issues

**Objective**: Fix critical issues preventing v0.4.5 from working correctly.

### Issues Identified

1. **Desktop App TypeScript Compilation Errors**
   - The shared package types were updated in v0.4.5 to include new properties (`discordUsername`, `popularHere`, `acclaimed`, `surprise`)
   - The desktop app failed to compile because it wasn't picking up the updated type definitions
   - Files affected: `ProfileDrawer.tsx`, `HomeTab.tsx`

2. **Web Panel Domain Inaccessibility**
   - Server logs showed the application was running correctly
   - However, navigating to the domain returned nothing
   - Root cause: The web app (`apps/web`) was not built, so the server had no static files to serve
   - The server's `webRoot` configuration checks for built web client files

### Actions Taken

1. **Rebuilt Shared Package**
   - Command: `pnpm build` in `packages/shared/`
   - Ensured TypeScript type definitions were up to date
   - Result: Types now include all v0.4.5 properties

2. **Built Web Application**
   - Command: `pnpm build` in `apps/web/`
   - Generated static files in `apps/web/dist/`
   - Result: Server can now serve the web panel at the domain

3. **Rebuilt Desktop Application**
   - Command: `pnpm build` in `apps/desktop/`
   - TypeScript compilation succeeded with updated types
   - Generated new installers with fixes applied
   - Build duration: ~3 minutes 52 seconds

4. **Created Pull Request**
   - Branch: `fix-build-issues-v0.4.5`
   - Repository: https://github.com/scopeddlol/GameBlade
   - Commit: Added changelog documenting fixes
   - Status: Pushed to remote, ready for review

### Build Artifacts Generated (After Fixes)

- **MSI Installer**: `GameBlade_0.4.5_x64_en-US.msi` (3.7 MB)
- **NSIS Installer**: `GameBlade_0.4.5_x64-setup.exe` (2.7 MB)
- **Web App**: Built successfully in `apps/web/dist/`
- **Shared Package**: Type definitions updated and compiled

---

## Build Session - August 24, 2026 (Installer Customizations)

### Task: Add Auto-Update, Branding, and License to Installer

**Objective**: Enhance the GameBlade installer with auto-update capability, custom branding, and license agreement.

### Actions Taken

1. **Added Auto-Update Mechanism**
   - Added `@tauri-apps/plugin-updater` to desktop app dependencies
   - Added `tauri-plugin-updater` to Rust dependencies in `Cargo.toml`
   - Configured updater in `tauri.conf.json` under `plugins.updater`
   - Endpoint: GitHub releases for update manifests
   - Enabled built-in update dialog for user notifications
   - Added updater plugin initialization in `lib.rs`

2. **Added License Agreement**
   - Created `LICENSE.txt` with GameBlade EULA
   - Covers license grant, permitted use, restrictions, disclaimer, privacy, and updates
   - License file placed in `apps/desktop/` directory

3. **Installer Configuration**
   - Updated NSIS configuration in `tauri.conf.json`
   - Configured updater plugin separately from bundle configuration
   - Maintained existing NSIS install mode: currentUser
   - Build time: 5m 24s (includes new dependencies compilation)

### Technical Details

**Auto-Update Configuration**:

- Plugin: `tauri-plugin-updater` v2.10.1
- Update endpoint: GitHub releases
- Signature verification: Enabled with public key
- Dialog: Built-in Tauri update UI

**License Agreement**:

- File: `apps/desktop/LICENSE.txt`
- Content: Custom EULA for GameBlade
- Note: NSIS license configuration requires custom template for full integration

**Dependencies Added**:

- `@tauri-apps/plugin-updater` (npm)
- `tauri-plugin-updater` (Cargo)

### Build Artifacts Generated

- **MSI Installer**: `GameBlade_0.4.5_x64_en-US.msi` (3.7 MB)
- **NSIS Installer**: `GameBlade_0.4.5_x64-setup.exe` (2.7 MB)
- **Build Duration**: 5m 24s

### Notes

- The auto-update mechanism will check GitHub releases for new versions
- Users will see an in-app dialog when updates are available
- License agreement is prepared but requires custom NSIS template for full integration
- Public key is a placeholder and should be replaced with a real key for production

### Build Configuration Details

**Tauri Configuration** (`src-tauri/tauri.conf.json`):

- Product Name: GameBlade
- Version: 0.4.5
- Identifier: io.gameblade.desktop
- Build targets: msi, nsis
- NSIS install mode: currentUser

**Rust Profile** (release):

- Optimization level: s (size)
- LTO: enabled
- Codegen units: 1
- Panic mode: abort
- Symbols: stripped

### Installation Notes

- Both installers are for x64 architecture
- NSIS installer is recommended for most users (smaller, more user-friendly)
- MSI installer is suitable for enterprise deployment tools
- Install mode: per-user (currentUser) - does not require admin privileges

---

## Planned Steps Ahead

### Immediate Next Steps

1. **Test Installers**
   - Verify NSIS installer installs correctly on a clean Windows machine
   - Verify MSI installer installs correctly
   - Test application launch and basic functionality

2. **Distribution Preparation**
   - Upload installers to server via Admin → Settings
   - Update CLIENT_DOWNLOAD_URL if hosting externally
   - Bump client version in settings if this is a new release

### Future Enhancements

1. **Build Automation**
   - Set up CI/CD pipeline for automated builds
   - Configure GitHub Actions for release automation
   - Add code signing for installers

2. **Additional Platforms**
   - Consider macOS build (dmg/pkg)
   - Consider Linux build (AppImage/deb/rpm)

3. **Installer Customization**
   - Add custom branding to NSIS installer
   - Configure auto-update mechanism
   - Add license agreement screen

### Maintenance Tasks

- Regular dependency updates (pnpm update, cargo update)
- Monitor Tauri framework updates
- Test installer compatibility with new Windows versions
- Maintain changelog for each release

---

## Version History

### v0.4.5 (Current)

- Built installers: MSI and NSIS
- Platform: Windows x64
- Build date: August 24, 2026
- Tauri version: 2.x
- React version: 19.0.0
- Source: Pulled from GitHub tag v0.4.5

### v0.4.4

- Built installers: MSI and NSIS
- Platform: Windows x64
- Build date: August 23, 2026
- Tauri version: 2.x
- React version: 19.0.0

---

## Build Commands Reference

### Development

```bash
cd apps/desktop
pnpm dev              # Start development server
pnpm build:frontend   # Build frontend only
pnpm typecheck        # Type check TypeScript
```

### Production Build

```bash
cd apps/desktop
pnpm build            # Build complete app with installers
```

### Tauri Commands

```bash
pnpm tauri build      # Build with Tauri CLI
pnpm tauri dev        # Development mode with Tauri
```

---

## Troubleshooting

### Build Issues

- **Rust toolchain missing**: Install Rust via rustup
- **Node modules missing**: Run `pnpm install` from root
- **Frontend build fails**: Check TypeScript errors in `apps/desktop/src/`

### Installer Issues

- **Antivirus blocking**: Add exception for installer
- **Permissions**: NSIS installer uses currentUser mode (no admin required)
- **Path issues**: Ensure install path does not contain special characters

### Runtime Issues

- **Server connection**: Verify server URL in client settings
- **WebView2 missing**: Install Microsoft Edge WebView2 runtime
- **Firewall**: Allow client to access server ports

---

## Contact & Support

- **Repository**: https://github.com/scopeddlol/GameBlade
- **Documentation**: See README.md and docs/ folder
- **Bug Reports**: Use the in-app "Report a problem" feature
