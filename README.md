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
**Admin → Players → Invites**.

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
file sizes instead of artwork. Add credentials in **Admin → Settings**, or via
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

To add someone: **Admin → Players → Invites → Create an invite**, then send them the
copied link. Invites carry a role, a use count and an optional expiry, and can be
revoked at any time. After registering they download the Windows client and sign
in there — the web surface has nothing else for them.

Changing a password signs out every other session and revokes every desktop
device for that account.

---

## The admin panel

Everything an operator needs, at `/admin` — and it works on a phone: below the
large breakpoint the sidebar becomes a drawer, and tables and charts stay inside
the viewport rather than forcing the page sideways.

Six sections, each with its own sub-tabs. Pointing at one starts fetching what
it needs before the click lands, and a page waiting on data draws its own shape
rather than a spinner. The flat URLs the sections used to live at still work and
redirect to where each page moved.

- **Overview** — catalog health, connected clients, scan progress, and a
  broadcast announcement box that pushes a notification to every account.
- **Catalog** — the archive itself.
  - **Games** — a worklist of every game, filterable by match status and by
    what an entry is still missing: no launch executable, no cloud-save rule,
    no artwork, no achievements, no metadata. Each filter carries a server-wide
    count, and every row shows the same four things as `EXE / SAVE / ART / ACH`
    markers, so a scan down the list says where the holes are without opening
    anything. Opening one gives a full metadata editor: fields, artwork slots,
    screenshots, Steam achievement import, and the launch and save rules the
    desktop client needs to actually run and back up that game.
  - **Achievements** — the same job for the whole catalog rather than one game
    at a time. Pick as many games as you like and it works through them,
    finding each on Steam, importing its published achievement list and writing
    the unlock rules, reporting what happened to every one. Games Steam cannot
    help with take a pasted list instead. See [Achievements](#achievements).
  - **Featured** — curates the carousel on the client's Home tab, in order,
    with a per-slot image override.
  - **Save paths** — where each game keeps its saves, matched against a public
    database rather than found by playing every title. See
    [Cloud saves](#cloud-saves).
  - **Libraries** — the folders on disk that are scanned, and the scan itself.
- **Players** — the people in it.
  - **Accounts** — who is here, and their roles.
  - **Invites** — codes, their uses and their expiry.
  - **Game requests** — the queue of games players have asked for, ranked by
    how many of them asked. See [Game requests](#game-requests).
  - **Bug reports** — the triage queue. See [Reporting a bug](#reporting-a-bug).
- **Insights** — numbers and warnings.
  - **Analytics** — who downloaded what, the most-played titles, bandwidth per
    day and per month, allowance usage, and a recent-downloads log. Everything
    is derived from the download and play records already being written, so
    there is no separate counter to drift out of agreement with them.
  - **Health** — what needs attention, and the backup schedule.
- **Appearance** — what everyone else sees.
  - **Theme** — the colour preset and accent, applied to the panel around you
    as you pick, and put back if you leave without saving.
  - **Landing page** — the public page as an ordered list of sections, with a
    live preview. See [Editing the landing page](#editing-the-landing-page).
  - **Desktop client** — your own links (a Discord invite, a wiki, a support
    page) rendered in the client's sidebar, on its Home tab, or in the menu
    that opens when a player right-clicks a game. Links only: the client hands
    the URL to the player's browser, and only `http(s)` is accepted — pushing
    anything executable to every player's machine would be a different trust
    model entirely.
- **Settings** — server configuration.
  - **Server** — the name and tagline, provider credentials, the Windows client
    installer, and the bandwidth limits.
  - **API keys** — scoped credentials for the external API. See
    [docs/API.md](docs/API.md).

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

### Games players already have

A player with a drive full of games should not have to download a second copy
of any of them. **Library → Import** points the client at a folder, finds every
subfolder holding a Windows executable, and matches those folder names against
the catalog — through the same title parser the library scanner uses, so a
`Hollow.Knight.v1.5.78.11.GOG-FitGirl` folder still resolves. Each row is
confirmed by hand before anything is linked, because a wrong match would attach
the wrong cloud saves to the wrong game.

Linking copies and moves nothing; the files stay where they are. Unlinking is
therefore a separate action from uninstalling, and only the latter deletes.

### Right-click menus

Right-clicking a game anywhere in the client — Home, Library or Store — opens a
menu with everything that applies to it: play or install, add to library,
favourite, open the install folder, unlink, uninstall, plus any custom buttons
placed there. Text fields keep the native menu, so copy and paste still work.

### Game requests

Players ask for what is not there, and the archive keeps a queue of it.

The client's **Requests** tab is where players ask and vote: a tally of what is
open, on the way and already added, a composer, filters by state, and the queue
ranked by votes. Two people asking for the same game strengthen one row rather
than producing two the operator has to reconcile — titles are matched on a
normalised key, so `Half-Life 2: Episode One` and `half life 2 episode one`
collide, while `Halo` and `Halo Wars` stay apart. The asker's vote is counted
automatically, and anyone else can back a row or take their backing away.

Above the queue sits **Trending right now**: what is actually being played
elsewhere, from IGDB's popularity data ranked by Steam's 24-hour peak player
count. Each card is checked against this archive first, so its button reads _In
the archive_, _Backed_, _Back it_ or _Request_ — one click, no typing. It needs
IGDB credentials; without them the strip simply does not appear, and the rest of
the page works as normal. The list is cached for an hour, since it is the same
for every player and IGDB's rate limit is shared with scanning and matching.

**Admin → Players → Game requests** is the other side of it: the queue ranked by votes, with
four states — pending, coming soon, added, denied — a note players will see, and
a field linking a fulfilled request to the catalog entry that satisfied it. Who
asked is shown here and nowhere else; a wish list should not become a public
record of who wants what.

The client's Home tab draws the result: **Coming soon** for what has been
promised, **Most requested** for what is still wanted, and **Recently granted**
for requests that made it in — with an **Open** button straight to the game. A
denied title reopens as pending if somebody else asks for it, because the
second asker never saw that decision.

### Groups

A player's own shelves, private to their account. Right-click any game and
choose **Add to group…** to file it — or make a group in the same dialog and
file it there in one step. The Library tab then shows a chip per group beside
the search box.

Groups are per-account rather than server-wide: an operator already has genres
and the featured rail to shape the catalog, and a shared group would need its
own permissions model to answer "who may rename this". Nothing is copied or
moved, and deleting a group leaves every game in it alone.

### News and announcements

The broadcast box on **Admin → Overview**, or the composer on the client's **News** tab, sends a
notification to every account _and_ publishes the same text as a post. The
notification is read once and gone; the News tab is where it stays, and where
people reply to it. Underneath it is an ordinary post, so comments, reactions,
editing and deletion are the machinery the social feed already had.

Two announcements are deliberately not published: one aimed at named accounts,
which is a message rather than a notice, and one an operator marks as transient
("back up in five minutes"). Players cannot author one — the post route derives
its kind from what was attached, so asking for `kind: announcement` in a request
body is ignored rather than trusted.

### Keeping the client up to date

Upload a new installer under **Admin → Settings** and bump the client version
beside it. Clients older than that version show a banner offering to update, and
hand off to the installer when the user accepts — nothing is replaced behind
their back. Declining is remembered per version, so saying no to 0.5.0 stays no
while 0.5.1 asks again. Nothing is offered unless an installer has actually been
uploaded, so a version typed in with no build behind it produces no prompt.

### Library layouts

The Library tab has three layouts, switched from the toolbar rather than from
Settings, because which one is right changes with what you are doing:

| Layout       | For                                                                          |
| ------------ | ---------------------------------------------------------------------------- |
| **Grid**     | Browsing by artwork                                                          |
| **List**     | Finding a title you already know — four or five times as many rows on screen |
| **Detailed** | Deciding what to play: cover, blurb, genres and every stat spelled out       |

The choice lives in the client's settings file, so it survives a restart.

Game pages show a title's logo artwork in place of its name wherever the archive
has one; **Settings → Appearance** turns that off for anyone who would rather
read the title.

### Theming

Ten presets — eight dark (Midnight, Slate, Carbon, Nebula, Aurora, Ember, Moss,
Oceanic) and two genuine light ones (Daylight, Parchment) — plus an optional
accent colour that replaces the preset's own. Only the mid step is picked; the
lighter and darker steps are derived from it, so hover, focus and gradient
states keep working without asking anyone to choose four related colours by
hand.

A theme is a complete surface ramp rather than one hue: brightening only the
accent on a near-black chrome produces something that reads as broken. The
tokens are resolved server-side and applied by both the web app and the desktop
client, so a server's look is one setting rather than two that drift.

**Players can disagree.** The client's **Settings → Appearance** offers the same
ten themes and the same accent picker, stored in that machine's settings file.
Picking one overrides the server's for that PC only; **Follow the server** hands
it back. An operator chooses the look of their archive, and nobody has their
desktop restyled the next time that choice changes.

### Editing the landing page

**Admin → Appearance → Landing page** turns the landing page into an ordered
list of sections. Add, reorder, hide and edit them with the real page rendering
beside the form; the preview is the same component the public page uses, not a
mock-up of it.

| Section        |                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Hero           | The headline, with an eyebrow line, a background image and its dimming, alignment, and four heights up to full-screen. |
| Feature grid   | Short "what you get" cards, two to four across, as cards or plain.                                                     |
| How it works   | A numbered sequence — get an invite, install, play.                                                                    |
| Stats          | A strip of numbers, optionally including the live game count.                                                          |
| Screenshots    | A grid, two to four across, in widescreen, ultrawide, square or poster shape.                                          |
| Video          | One embedded YouTube video.                                                                                            |
| Quote          | A pull quote, larger than body text and attributed.                                                                    |
| FAQ            | Questions and answers, each one expandable.                                                                            |
| Text           | Prose, left or centred, at body or display size.                                                                       |
| Spacer         | Space between two sections, with or without a rule.                                                                    |
| Call to action | A closing prompt with the same buttons as the hero, as a panel or full width.                                          |

Every section also has its own padding, background (none, a muted band, or an
accent wash) and content width. Alternating those is most of what makes a page
read as designed rather than as a stack of boxes, and all three come from theme
tokens — so a light theme gets a light band rather than a dark stripe.

Blocks rather than free-form positioning is deliberate: an operator says what
the page contains and in what order, while each section's layout stays something
that was designed once and works at every width, phones included. Operator copy
is rendered as text and never as HTML, only YouTube can be framed, and a stored
page that cannot be parsed falls back to the built-in one rather than taking the
front door down. **Reset** restores the shipped page at any point.

### Discord

Entirely optional — with none of it configured, GameBlade behaves exactly as it
did before. **Admin → Settings → Discord** has two independent halves.

**Sign in with Discord** needs a Discord application's client ID and secret.
Players can then link from their account page and use it to sign in. Linking
never creates an account: this server is invite-only, so an unlinked Discord is
told to sign in normally once and link. The redirect URI registered on the
application must exactly match `<your server>/api/auth/discord/callback`.

With a guild ID set, linking also checks membership of your Discord, and the
bot adds them to it using the `guilds.join` scope they granted — being told to
go and join is a step people do not take. If that fails, they get your invite
link instead. **Require players to be in the server** refuses the link outright
when neither works.

A linked player's handle is **private by default**. The toggle to show it lives
on their account page, and re-linking — which happens on every Discord sign-in
— does not turn it back on.

**The bot** needs a token, a channel and this server's public address. The
address is for cover art: Discord fetches images itself, so a relative path
would resolve against discord.com. Paste the bare token from the Bot tab; a
token pasted as `Bot <token>` is accepted too. **Test** walks every step
between that token and a message arriving — the token itself, whether the bot
was ever invited to your server, whether it can see the channel you named, and
whether it may post there — and reports each separately, because those are the
things that actually go wrong and they all look identical from outside. A
passing run leaves a test message in the channel. It can post whatever you
type, announce newly added games every fifteen minutes, and announce requests
as they are granted. Turning
announcements on starts from that moment rather than posting everything already
in the catalog, and only games whose metadata matched are announced — an
unmatched entry is a folder name with no cover and no blurb.

One limitation worth knowing: **Discord publishes no friends list to
third-party applications.** There is no scope for it and no endpoint. "Friends
from Discord" therefore means other players here who are in the same server as
you, which is the closest the platform allows — and since linking pushes
everyone into that one server, very nearly the same set.

### Reporting a bug

**Report a problem** sits in the client's sidebar, reachable from wherever
something went wrong rather than on a page somebody has to go and find. The
report carries the client version, the platform, the game if one was running,
and the last few errors the app logged — none of which a reporter should have to
know, and all of which an operator would otherwise have to go back and ask for.

**Admin → Players → Bug reports** is the queue: filter by state, read what the app logged
just before, and answer. Whatever you set, and anything you write back, reaches
the reporter as a notification, and they can see where each of their reports got
to under Settings.

That last part is the point rather than a nicety. Somebody who reports a problem
and never learns whether it was read, fixed, or was never a bug has no reason to
report the next one, and an archive tested by the people using it depends on
them doing so. Unanswered reports show up on the health page for the same
reason.

### Health and backups

**Admin → Insights → Health** answers "is anything wrong", which analytics does not: disks
running out, games that have gone from disk, entries with no launch or save
rule, files whose contents no longer match their recorded checksum, accounts
that have hit their limit, and when the library was last scanned. Every finding
links to where it is fixed. It is all derived from rows already being written,
so there is nothing to keep in step by hand.

**Verify** on a game re-hashes the files that were hashed once already and
records whether each still matches. For an archive a file whose contents have
changed is almost always corruption rather than an edit, and nothing else here
would ever notice.

Backups live on the same page. An archive holds the database, every player's
cloud saves, uploaded media and the published installer — the things that exist
nowhere else. The game library is deliberately left out: it is enormous, you
already have it, and a scan rebuilds the catalog from it. Cached artwork is out
too by default, being both the largest part and the one part that can be
fetched again.

The database is copied through SQLite's own backup API rather than by copying
the file. Under WAL the file on disk is not a complete database on its own, and
copying it during a scan produces an archive that restores to a corrupt state.

Written every `backupEveryHours` hours keeping `backupKeep` of them, or on
demand. To restore: stop the server, unzip the archive over an empty `DATA_DIR`,
start it again.

### Achievements that unlock themselves

Achievement definitions have always been importable; a rule is what says when
one is earned. It names a file the game itself writes and what to find in it —
a JSON path, an INI key, or a regular expression over text — tested for
presence, truthiness, equality, or a threshold.

The client reads those files when a session ends and reports only the resulting
keys; the files never leave the machine. A reported key with no rule behind it
is ignored, so reporting is not a way of simply asking for an achievement, and
unlocking is idempotent, so re-reading the same save changes nothing.

Rules are written in **Admin → Catalog → Games**, on a game, beside its launch and save
rules.

### Bandwidth

Two limits, both off by default (`0` means no limit), under **Admin → Settings**:

- A **download speed cap** in KB/s, applied per stream. A client opening several
  connections gets that much on each, which is the honest way to describe it.
- A **monthly allowance** per account, in MB, resetting on the 1st. Override it
  for one account on the Users page — an explicit override binds even for an
  administrator, while the server-wide default deliberately does not apply to
  them, so a default can never lock the operator out of their own downloads.

An account over its allowance is refused with `429` before any bytes are sent,
and a single transfer that would cross the line is cut off mid-stream — usage is
only recorded when a stream closes, so a start-only check would let one
oversized download sail straight past.

### The external API

A versioned, key-authenticated API at `/api/v1` for driving the server from
elsewhere — provisioning accounts from a billing system, handing out invites,
reading stats. Keys carry explicit scopes, and `users:admin` is separate from
`users:write` so a provisioning key cannot mint itself an administrator.

Full reference, including a worked provisioning example: **[docs/API.md](docs/API.md)**.

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

### Where the save paths come from

Finding where a game saves by hand means installing it, playing it, making a
save and going looking — for every title. **Admin → Catalog → Save paths**
matches the catalog against
[Ludusavi's manifest](https://github.com/mtkennerly/ludusavi-manifest), a
machine-readable digest of PCGamingWiki's save-path data covering some eleven
thousand games, and proposes the rules instead.

Nothing is written without a tick, and the manifest's own title is shown beside
the archive's on every row, because a title match is occasionally confident and
wrong — and these paths are where the client will later read and write a
player's saves. Titles that already have a rule are hidden by default; the
toggle above the list brings them back for review.

The index refreshes itself daily. It is decided from the index's own age rather
than run on a timer, so a server restarted every evening still refreshes once a
day and one left up for months does not drift. **Refresh index** forces it.

---

## Achievements

Games here have no achievement runtime of their own, so definitions are imported
and unlocks are reported by the client.

Import a set from **Admin → Catalog → Games → (a game) → Achievements** with a Steam
app id. This reads Steam's _published_ achievement schema — no player data is
requested and no Steam account is linked — which is what makes it usable for a
DRM-free copy of a game that also ships there. Global unlock rates come along
with it and set each achievement's point value.

### In bulk

One game at a time is right for a correction and hopeless as a way to cover a
catalog of several hundred, so **Admin → Catalog → Achievements** does the same
job across as many games as you select.

It starts on the games that have none. Tick the ones you want — or all of them —
and it works through the list, finding each on Steam, importing its published
list and writing the unlock rules, a few games at a time so you can watch it go
and stop it. Every game gets a line saying what happened, and the ones that
could not be done automatically sort to the top: a title Steam places
ambiguously, one it has never heard of, and one whose store entry has no
achievements are all ordinary across a real catalog, and each is a note rather
than a failed run. Games that already have achievements are left alone unless
you say otherwise, so running it again only picks up what is new.

For the games Steam cannot help with — a fan translation, an itch-only release,
a version whose store entry predates its achievements — the same page takes a
pasted list. One per line: the name, then optionally a description, a point
value and a key, separated by tabs, commas or pipes, so a column copied out of
a spreadsheet or a wiki table works as it is. A missing key is derived from the
name and stays stable, so a corrected list can simply be pasted again.

Because the client is the only thing that can observe progress, unlocks are
self-reported and therefore not cheat-proof. The server keeps them idempotent
and well-formed; it does not adjudicate them.

---

## The desktop client

The client is where players spend all their time. Five tabs down the left:

| Tab          | What is there                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Home**     | Your own totals, an auto-advancing featured carousel, jump back in, friends playing, what is coming soon and most requested, activity, recent unlocks |
| **Library**  | Games you own, as posters or as a dense list — install, launch, playtime, achievements, save sync and your own groups                                 |
| **Store**    | The whole archive, filterable, one click to add to your library, and a request box for what is not in it                                              |
| **Social**   | Feed with screenshots and clips, comments, reactions, friends and requests                                                                            |
| **Settings** | Profile, appearance, install location, save sync, presence, devices                                                                                   |

Adding a game to your library applies immediately and only to the card you
clicked, so a run down the store adding a dozen titles is a dozen clicks rather
than a dozen round trips waited out one at a time.

Installing, launching and playtime tracking are handled in Rust: the client
extracts the archive, resolves the executable, watches the game process and
banks playtime as it goes, so a crash mid-session still keeps most of it.

Presence, friend activity and notifications arrive over a WebSocket that
reconnects with backoff. Everything it carries is also readable over REST, so a
dropped socket costs freshness, never correctness.

### Downloads

Pressing **Install** asks where the game should go rather than silently using a
default. Every configured drive is listed with what is free, what would be left
after, and a plain refusal when the game will not fit — a download that dies at
90% for want of disk is the worst way to find that out. Add more locations under
**Settings → Storage**.

**Settings → Downloads** has an optional artwork cache. With it on, a cover
already on disk is handed straight to the webview and the server is not asked at
all; a miss returns the remote URL immediately and fills the cache behind it, so
a cache miss is never slower than having no cache. It is capped at 512 MB,
evicts oldest-first, and the card shows what it is using with a button to empty
it.

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

**Cancelling asks what to do with the bytes already on disk.** Stopping a
250 GB install 100 GB in leaves 100 GB somewhere, and both answers are
legitimate — a transfer stopped to be resumed later wants its files, one being
abandoned wants the space back. Keeping them is the default; removing them
deletes exactly the paths that download wrote and nothing else in the folder.
Dismissing a paused or failed transfer asks the same question.

Installers are built with `scripts/build-windows.ps1` — see
[Building a Windows release by hand](#building-a-windows-release-by-hand). CI
no longer builds them automatically: a job queued for a Windows runner that is
not online does not fail, it sits pending until it times out hours later.
Once you have published an installer, set **Admin → Settings → Windows client
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

### Building a Windows release by hand

The Windows client is built on a real machine rather than by CI. Both Actions
workflows still know how — the jobs are there and work — but neither starts on
its own, because a job queued for a self-hosted runner that is offline sits
pending until it times out hours later rather than failing.

`scripts/build-windows.ps1` does the same job on any Windows machine with
Node 22, pnpm and the Rust toolchain:

```powershell
.\scripts\build-windows.ps1
```

It asks for the version, stamps it across every manifest that carries one — the
five `package.json` files, `tauri.conf.json`, the Rust crate and its lockfile,
which are read by different things and must agree — then typechecks, tests, builds, and copies
the `.exe` and `.msi` into `dist/windows/<version>/`.

`scripts/build-windows.cmd` is a double-clickable wrapper for it, which also
avoids the execution-policy prompt. It always waits for a keypress before
closing, so a failure cannot vanish with the window; set `GAMEBLADE_NOPAUSE=1`
to skip that when scripting it.

Every run is transcribed to `build-windows.log` at the repo root, so a message
that scrolled past — or a window that closed anyway — is still readable
afterwards.

| Flag             |                                                             |
| ---------------- | ----------------------------------------------------------- |
| `-Version 0.5.0` | Skip the prompt.                                            |
| `-KeepVersion`   | Build at the current version, changing no files.            |
| `-Fast`          | Drop link-time optimisation. Much quicker; not for release. |
| `-SkipChecks`    | Skip typecheck and tests.                                   |

Only the client is built — the server ships as a container image built on
Linux. Commit the version bump and tag it once the installer is in hand; the
tag publishes the release and the image, and you attach the `.exe` to it.

**If the window opens and closes doing nothing**, it is almost always a missing
prerequisite. Open PowerShell in the repo and run the script directly to see
the message:

```powershell
.\scripts\build-windows.ps1
```

It names every missing tool at once rather than one per run. The usual culprit
is that a tool _is_ installed but the terminal predates the install — a running
process keeps the PATH it started with, so open a new one. Check with:

```powershell
node --version; pnpm --version; cargo --version
```

To have Actions build the client again once a Windows runner is back, run the
**Publish** workflow manually and tick **Build the Windows installers** — or,
to restore the old automatic behaviour, drop the `if:` guard on the `desktop`
job in each workflow. The comment above each one says what it used to be.

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
