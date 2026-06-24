# @seam/cloud

Backend sync layer for Seam — user accounts, media, and projects stored
server-side so they can sync across devices. Seam stays **local-first**; the
cloud is an opt-in layer on top of the existing storage. Integration is
**web-editor-only** for now.

## Stack

- **Hono** (`@hono/node-server`) — HTTP server + static client host
- **Better Auth** — email/password sessions; a `role` column (`ADMIN` | `USER`)
  on the user table
- **better-sqlite3** — single SQLite DB for auth + app tables
- **Vite + React** — the post-login browse UI (`web/`)

Media bytes and project documents live on disk under `DATA_DIR`; only metadata
lives in the database. On upload the server extracts the same sidecar metadata
the web editor does — thumbnail, dimensions, duration, capture date — headlessly
via mediabunny + `@napi-rs/canvas` (the `@seam/renderer` stack), so the database
is populated without the client having to send it.

## Configuration

Copy `.env.example` → `.env`:

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `ADMIN_USER` | ✅ | — | Bootstrap admin email. **Startup fails if unset.** |
| `ADMIN_PASS` | ✅ | — | Bootstrap admin password (min 8 chars). |
| `PORT` | | `8787` | |
| `DATA_DIR` | | `./data` | SQLite DB + on-disk media/projects. |
| `BETTER_AUTH_SECRET` | | dev fallback | Set a long random value in production. |
| `BETTER_AUTH_URL` | | `http://localhost:$PORT` | Set when behind a proxy. |

On first start with no admin present, an `ADMIN` user is created from
`ADMIN_USER`/`ADMIN_PASS`. Subsequent starts leave it alone.

## Develop

```sh
pnpm --filter @seam/cloud dev          # API server (tsx watch, :8787)
pnpm --filter @seam/cloud dev:client   # Vite client (:5173, proxies /api → :8787)
```

Open http://localhost:5173 in dev.

## Build & run

```sh
pnpm --filter @seam/cloud build        # tsc (server) + vite build (client → web/dist)
pnpm --filter @seam/cloud start        # node dist/index.js; serves API + built client
```

In production a single process serves both the API and the built client at
`PORT`.

## On-disk layout (`DATA_DIR`)

```
seam-cloud.db                      SQLite (auth + media + project tables)
media/<userId>/<mediaId>           raw media bytes
thumbnails/<userId>/<mediaId>.jpg  cached thumbnails
projects/<userId>/<projectId>.seam project documents
```

## API

All `/api/media` and `/api/projects` routes require a Better Auth session and
are scoped to the calling user. Auth lives at `/api/auth/*`.

### Media

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/media?page=&pageSize=&sort=date\|added\|used` | Paginated, sorted list |
| `POST` | `/api/media` | Multipart upload: `file` (+ optional `meta` JSON). The server extracts thumbnail/dimensions/duration/capture-date itself. |
| `GET` | `/api/media/:id` | Metadata record |
| `GET` | `/api/media/:id/file` | Stream raw bytes |
| `GET` | `/api/media/:id/thumb` | Stream thumbnail |
| `PATCH` | `/api/media/:id` | Update sidecar metadata |
| `DELETE` | `/api/media/:id` | Remove row + files |

Sort keys mirror the web editor's media browser (`date` = capture date,
`added` = import time, `used` = last used).

**Duplicate detection (per user).** Each upload is fingerprinted with a
SHA-256 over `(size ∥ first 64KB ∥ last 64KB)` — the same hash the editor
computes client-side. Filename and content hash are each unique per user:

- **same filename + same hash** → accept idempotently (`200`, returns the
  existing record; no new row)
- **same filename, different content** → `409 { reason: "filename-exists" }`
- **same content, different filename** → `409 { reason: "content-exists" }`

Conflicts carry the existing record so the editor can drive a manual/
semi-automated reconciliation. The server never tries to guess.

### Projects

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/projects?page=&pageSize=&sort=modified\|created\|name` | List |
| `POST` | `/api/projects` | Create: multipart `file` (+`name`) or raw body + `?name=` |
| `GET` | `/api/projects/:id` | Metadata record |
| `GET` | `/api/projects/:id/file` | Stream the `.seam` document |
| `PUT` | `/api/projects/:id` | Replace content (the sync write) |
| `PATCH` | `/api/projects/:id` | Rename / update metadata |
| `DELETE` | `/api/projects/:id` | Remove row + file |

## Web editor integration

The web editor talks to the cloud cross-origin, so auth is a **bearer token**
(better-auth's `bearer()` plugin), not a cookie:

- Sign-in returns the session token (response body + `set-auth-token` header).
- API calls send `Authorization: Bearer <token>`.
- Media stream/thumbnail URLs carry the token as `?token=…` so mediabunny's
  `UrlSource` and `<img>` can fetch a plain URL. The media routes accept the
  token from the query (synthesized into a bearer check).
- `/api/media/:id/file` honors `Range` (206) for on-demand streaming.
- CORS is open by default (`CORS_ORIGIN`); safe because auth is a header/token,
  not an ambient cookie.

Configure the editor with `VITE_SEAM_CLOUD_URL=<this server's base URL>` at
build time. The editor then shows a Login control, lists cloud assets alongside
local ones, streams cloud-only sources on demand, and offers per-file +
sync-all upload / per-file download (all dedup-checked by filename + content
hash).

## Not done yet

Project (.seam) sync — projects mutate, so they'll sync differently from media.
