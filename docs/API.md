# GameBlade API

A small, versioned HTTP API for driving a GameBlade server from somewhere else —
provisioning accounts from a billing system or a Discord bot, handing out invite
codes, reading statistics.

It is deliberately separate from the routes the web and desktop clients use.
Those two ship alongside the server and can change together; anything here is
someone else's integration and has to keep working.

- **Base URL** — `https://<your-server>/api/v1`
- **Authentication** — an API key, and only an API key
- **Format** — JSON in, JSON out

---

## Getting a key

**Admin → API keys → Create a key.** Keys can only be created by an
administrator signed in to the admin panel.

The plaintext key is shown **exactly once**, in the response that creates it.
Only a SHA-256 digest is stored, so a lost key cannot be recovered — delete it
and make another.

Every key starts with `gbk_`, which makes one recognisable if it turns up
somewhere it should not (a log, a commit, a paste).

### Permissions

A key carries an explicit set of scopes. A request to an endpoint the key lacks
the scope for is refused with `403` and a message naming what is missing.

| Scope           | Grants                                                        |
| --------------- | ------------------------------------------------------------- |
| `users:read`    | List and read accounts                                        |
| `users:write`   | Create, update and deactivate **non-admin** accounts          |
| `users:admin`   | Create, promote, demote, disable or delete **administrators** |
| `invites:write` | Generate invite codes                                         |
| `games:read`    | List the catalog                                              |
| `stats:read`    | Read server and usage statistics                              |

`users:admin` is separate from `users:write` on purpose. A provisioning
integration needs to create accounts, and almost none of them ever need to mint
an administrator — so a leaked provisioning key cannot be turned into an admin
login. Grant it only when something genuinely manages administrators.

Two guards apply regardless of scope:

- The last active administrator cannot be demoted, disabled or deleted.
- Disabling or changing an account's role or password ends its sessions
  immediately, so revoking access over the API takes effect at once rather than
  whenever the existing session happens to expire.

---

## Authenticating

Send the key as a bearer token:

```
Authorization: Bearer gbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

A session cookie is **not** accepted on `/api/v1`, even an administrator's. That
is what stops a logged-in admin's browser being induced into making these calls
by another site.

Start with `whoami` — it confirms the key works and reports what it may do,
which turns a permissions problem into an obvious answer rather than a mystery
`403` three endpoints later.

```bash
curl -H "Authorization: Bearer $GAMEBLADE_KEY" \
  https://your-server/api/v1/whoami
```

```json
{ "name": "Provisioning service", "scopes": ["users:read", "users:write"] }
```

---

## Errors

Every failure has the same shape:

```json
{ "error": { "code": "forbidden", "message": "This key is missing the users:write permission" } }
```

| Status | Meaning                                                                   |
| ------ | ------------------------------------------------------------------------- |
| `400`  | The body or query failed validation; `details` lists the offending fields |
| `401`  | No key, or the key is unknown, revoked or expired                         |
| `403`  | Valid key, but it lacks the scope for this endpoint                       |
| `404`  | No such user or game                                                      |
| `409`  | The request conflicts with server state (duplicate username, last admin)  |
| `429`  | Rate limited                                                              |

---

## Endpoints

### `GET /v1/whoami`

No scope required beyond a valid key. Returns the key's `name` and `scopes`.

---

### `GET /v1/users`

**Scope:** `users:read`

| Query      | Default | Notes                                |
| ---------- | ------- | ------------------------------------ |
| `query`    | —       | Substring match on username or email |
| `role`     | —       | `admin` or `user`                    |
| `isActive` | —       | `true` or `false`                    |
| `offset`   | `0`     |                                      |
| `limit`    | `50`    | Max 200                              |

```json
{
  "items": [
    {
      "id": "usr_9Xk2…",
      "username": "ada",
      "email": "ada@example.com",
      "role": "user",
      "isActive": true,
      "createdAt": "2026-08-19T10:04:11.000Z",
      "lastLoginAt": "2026-08-19T18:22:03.000Z"
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50
}
```

Password material is never included.

---

### `GET /v1/users/:id`

**Scope:** `users:read`. Returns one user in the shape above.

---

### `POST /v1/users`

**Scope:** `users:write` — plus `users:admin` when `role` is `admin`.

```json
{
  "username": "ada",
  "email": "ada@example.com",
  "role": "user"
}
```

| Field      | Required | Notes                                                       |
| ---------- | -------- | ----------------------------------------------------------- |
| `username` | yes      | 3–32 chars; letters, numbers, `.`, `_`, `-`                 |
| `password` | no       | At least 10 chars. **Omit it and the server generates one** |
| `email`    | no       |                                                             |
| `role`     | no       | `user` (default) or `admin`                                 |

Omitting `password` is the point of this endpoint for bulk provisioning: the
response carries a `generatedPassword` field, once, so the calling system never
has to invent or transmit one of its own.

```json
{
  "id": "usr_9Xk2…",
  "username": "ada",
  "role": "user",
  "isActive": true,
  "generatedPassword": "y8Qm2f…"
}
```

Returns `409` if the username is taken.

---

### `PATCH /v1/users/:id`

**Scope:** `users:write` — plus `users:admin` to promote, demote, disable or
otherwise touch an administrator.

Every field optional: `email`, `role`, `isActive`, `password`.

Changing `role`, `isActive` or `password` ends that account's sessions.

---

### `DELETE /v1/users/:id`

**Scope:** `users:write` — plus `users:admin` to delete an administrator.

Removes the account and everything keyed to it (playtime, achievements,
library). Refused with `409` for the last active administrator.

---

### `POST /v1/invites`

**Scope:** `invites:write` — plus `users:admin` for an administrator invite.

```json
{ "role": "user", "maxUses": 1, "expiresInDays": 14, "note": "beta wave 2" }
```

```json
{
  "id": "inv_4Kd…",
  "code": "K7QM3XPD9RTV",
  "role": "user",
  "maxUses": 1,
  "expiresAt": "2026-09-02T00:00:00.000Z"
}
```

Hand the `code` to whoever is registering; they enter it on the sign-up page.

---

### `GET /v1/games`

**Scope:** `games:read`

Accepts the catalog's usual filters — `search`, `genre`, `platform`,
`developer`, `sort`, `order`, `offset`, `limit`. Returns catalog fields only; the
per-user flags the clients see (owned, favourited, played) mean nothing for a
key and are omitted.

---

### `GET /v1/stats`

**Scope:** `stats:read`

```json
{
  "games": { "total": 412, "totalBytes": 8899123456789, "missing": 3 },
  "users": { "total": 27, "active": 25, "admins": 2, "online": 4 }
}
```

---

## Worked example: provisioning from another system

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="https://your-server/api/v1"
AUTH="Authorization: Bearer $GAMEBLADE_KEY"

# 1. Confirm the key and its permissions before doing anything.
curl -fsS -H "$AUTH" "$BASE/whoami"

# 2. Create the account, letting the server pick the password.
created=$(curl -fsS -X POST "$BASE/users" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"username":"ada","email":"ada@example.com"}')

echo "$created" | jq -r '.generatedPassword'   # deliver this to the user once

# 3. Later: revoke access when their subscription lapses.
id=$(echo "$created" | jq -r '.id')
curl -fsS -X PATCH "$BASE/users/$id" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"isActive":false}'
```

The key for this only needs `users:read` and `users:write`.

---

## Operational notes

- **Rate limiting** applies as it does to the rest of the API — 300 requests per
  minute per IP by default, tunable with `RATE_LIMIT_MAX`.
- **`lastUsedAt`** is recorded at most once a minute per key. Writing it on
  every call would turn every read into a database write, and on SQLite that
  means taking the write lock on a read-only request.
- **Revoking** keeps the row so the record of what existed survives; deleting
  removes it entirely. Either stops the key working immediately.
- **Rotation**: create the new key, move the integration across, then revoke the
  old one. Keys are independent, so there is no window where neither works.
