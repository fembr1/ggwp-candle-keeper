# penjaga-lilin

It connects to the tiket.com Socket.IO stream, joins one or more rooms on **one
socket**, and **blindly** fires `POST .../session/{CAMPAIGN_SESSION_ID}/hit`
whenever that session's countdown drops below its `MAX_MS_DIFF`.
With multiple tokens, each hit uses the next account in turn (round-robin) across
all sessions.

`npm start` runs a password-protected dashboard so you can edit tokens, add
sessions, start/stop the client, and watch per-session status, hits, and live logs.
A headless CLI is still available via `npm run client`.

## Setup

```bash
cd penjaga-lilin
npm install
cp .env.example .env      # then fill in ADMIN_PASSWORD + ACCESS_TOKEN + CAMPAIGN_SESSION_ID
```

### Dashboard

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | on Railway | generated at boot if unset | Password for the web UI. |
| `SESSION_SECRET` | | random per process | Cookie signing secret. Set this so logins survive restarts. |
| `PORT` | | `3000` | HTTP port. Railway sets this automatically. |
| `CONFIG_PATH` | | `/data/config.json` if `/data` exists, else `./config.json` | Where the UI persists settings. |

### Client configuration (`.env` or dashboard)

Shared (one socket, one token list):

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ACCESS_TOKEN` | to start | — | One JWT, or comma-separated JWTs for multi-user round-robin hits. |
| `SOCKET_URL` | | `wss://api.tiket.com/ms-gateway/tix-ggwp-ws-hub/v1/ws/` | Socket.IO URL including the Engine.IO path. |
| `API_BASE_URL` | | `https://www.tiket.com/.../session` | Base for the `/{CAMPAIGN_SESSION_ID}/hit` endpoint. |

Per session (dashboard **Sessions** list, stored as `SESSIONS` in `config.json`):

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `CAMPAIGN_SESSION_ID` | at least one to start | — | Game session / room id to join and hit. |
| `MAX_MS_DIFF` | | `1300` | Fire that session's hit when its countdown is within this many ms. |
| `STOP_AT` | | — | ISO datetime; after this, that session leaves its room. Other sessions keep running. |

Env vars `CAMPAIGN_SESSION_ID`, `MAX_MS_DIFF`, and `STOP_AT` still seed **one**
session so a fresh Railway volume or `.env` can auto-start. Add more sessions in
the dashboard; Save writes the `SESSIONS` array to `config.json`. Existing
flat `config.json` files are migrated into a one-item `SESSIONS` array on load.

**Multi-user:** set `ACCESS_TOKEN=token_a,token_b,token_c`. The socket listens with the first token; each hit (across every session) advances to the next user so accounts do not steal from themselves. Hits send `Cookie: session_access_token=<that user's JWT>`.

## Run locally

```bash
cd penjaga-lilin
npm start                 # dashboard at http://localhost:3000
# npm run client          # headless, env-only (no UI)
```

If `ADMIN_PASSWORD` is unset, the server prints a generated password at boot. If
`ACCESS_TOKEN` and at least one `CAMPAIGN_SESSION_ID` are already valid, the client auto-starts.

## Deploy on Railway

This is a long-running WebSocket process. Use Railway’s Hobby plan (~$5/mo) so it
does not sleep.

1. Create a [Railway](https://railway.app) project and connect this GitHub repo.
2. Leave the start command as `npm start` (Railway will set `PORT`).
3. In Variables, set at least:
   - `ADMIN_PASSWORD` — dashboard login
   - `SESSION_SECRET` — any long random string
   - optionally seed `ACCESS_TOKEN`, `CAMPAIGN_SESSION_ID`, etc.
4. Attach a volume mounted at `/data` so saved config survives redeploys.
   Without a volume, settings live in `./config.json` and are lost on each deploy.
5. Open the generated `*.up.railway.app` URL, sign in, add sessions if needed, and
   press **Start** if the client did not auto-start.

Health check endpoint (no auth): `GET /health`.

On WebSocket connect failure the process prints a copy-paste block
`===== OUTBOUND FAILURE (copy this block for DevOps) =====` with DNS, Cloudflare
headers (`cf-ray`, `cf-mitigated`), an HTTP probe of the same Engine.IO path, and
Railway replica metadata. Tokens and cookies are not included. The dump is
throttled to once every 20 seconds.

Do not commit tokens. Keep `.env` and `config.json` gitignored; put secrets in
Railway Variables or the dashboard.

## How it works

1. Connects with the first `ACCESS_TOKEN` and `join-room`s every active session id. Origin is derived from `SOCKET_URL`; hits use `Cookie: session_access_token=<token>`.
2. Room events are named with the session id. Each session uses its own `MAX_MS_DIFF` and hit URL.
3. If a session's `STOP_AT` is set and the current time is past it, that session leaves its room. Other sessions keep running. If every session has stopped, the socket disconnects; the dashboard process stays up.
4. When a session's `endTimestamp - now` is below its `MAX_MS_DIFF`, it immediately sends that session's hit — using the next user in the global round-robin when multiple tokens are configured.
