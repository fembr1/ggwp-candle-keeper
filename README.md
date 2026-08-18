# penjaga-lilin

It connects to the tiket.com Socket.IO stream, joins a room, and **blindly** fires
`POST .../session/{ROOM_NAME}/hit` whenever the round countdown drops below `MAX_MS_DIFF`.
With multiple tokens, each hit uses the next account in turn (round-robin).

`npm start` runs a password-protected dashboard so you can edit tokens/room settings,
start/stop the client, and watch status, hits, and live logs. A headless CLI is still
available via `npm run client`.

## Setup

```bash
cd penjaga-lilin
npm install
cp .env.example .env      # then fill in ADMIN_PASSWORD + ACCESS_TOKEN + ROOM_NAME
```

### Dashboard

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | on Railway | generated at boot if unset | Password for the web UI. |
| `SESSION_SECRET` | | random per process | Cookie signing secret. Set this so logins survive restarts. |
| `PORT` | | `3000` | HTTP port. Railway sets this automatically. |
| `CONFIG_PATH` | | `/data/config.json` if `/data` exists, else `./config.json` | Where the UI persists settings. |

### Client configuration (`.env` or dashboard)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ACCESS_TOKEN` | to start | — | One JWT, or comma-separated JWTs for multi-user round-robin hits. |
| `ROOM_NAME` | to start | — | Game session / room id to join and hit. |
| `CAMPAIGN_ID` | | — | Also joined on the socket if set. |
| `COOKIE` | recommended | — | Full browser `Cookie` header (single-user only). |
| `ORIGIN` | | derived from `SOCKET_URL` | e.g. `https://gatotkaca.tiket.com`. |
| `SOCKET_URL` | | `wss://api.tiket.com` | Socket.IO server URL. |
| `WS_PATH` | | `/ms-gateway/tix-ggwp-ws-hub/v1/ws/` | Socket.IO path. |
| `API_BASE_URL` | | `https://www.tiket.com/.../session` | Base for the `/{ROOM_NAME}/hit` endpoint. |
| `MAX_MS_DIFF` | | `1300` | Fire the hit when the countdown is within this many ms. |
| `STOP_AT` | | — | ISO datetime hard stop; after this, hits stop. The dashboard stays up. |
| `USER_AGENT` | | Chrome-like UA | Sent on socket + hit requests. |

**Multi-user:** set `ACCESS_TOKEN=token_a,token_b,token_c`. The socket listens with the first token; each hit advances to the next user so accounts do not steal from themselves. Shared `COOKIE` is ignored for hits in multi-user mode (per-token `session_access_token` cookies are used instead).

Copy `COOKIE` from DevTools → Network → the `wss://…/tix-ggwp-ws-hub/…` request → Request Headers → `cookie`. Keep `ACCESS_TOKEN` in sync with that session (single-user).

## Run locally

```bash
cd penjaga-lilin
npm start                 # dashboard at http://localhost:3000
# npm run client          # headless, env-only (no UI)
```

If `ADMIN_PASSWORD` is unset, the server prints a generated password at boot. If
`ACCESS_TOKEN` and `ROOM_NAME` are already valid, the client auto-starts.

## Deploy on Railway

This is a long-running WebSocket process. Use Railway’s Hobby plan (~$5/mo) so it
does not sleep.

1. Create a [Railway](https://railway.app) project and connect this GitHub repo.
2. Leave the start command as `npm start` (Railway will set `PORT`).
3. In Variables, set at least:
   - `ADMIN_PASSWORD` — dashboard login
   - `SESSION_SECRET` — any long random string
   - optionally seed `ACCESS_TOKEN`, `ROOM_NAME`, `CAMPAIGN_ID`, etc.
4. Attach a volume mounted at `/data` so saved config survives redeploys.
   Without a volume, settings live in `./config.json` and are lost on each deploy.
5. Open the generated `*.up.railway.app` URL, sign in, confirm tokens/room, and
   press **Start** if the client did not auto-start.

Health check endpoint (no auth): `GET /health`.

Do not commit tokens. Keep `.env` and `config.json` gitignored; put secrets in
Railway Variables or the dashboard.

## How it works

1. Connects with the first `ACCESS_TOKEN` + browser-like `Cookie`/`Origin` headers, then joins `ROOM_NAME`.
2. On each room event, if `STOP_AT` is set and the current time is past it, the client disconnects (the dashboard process stays running).
3. Otherwise computes `endTimestamp - now`. If that is below `MAX_MS_DIFF`, it immediately sends the hit — using the next user in round-robin order when multiple tokens are configured.
