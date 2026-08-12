# penjaga-lilin

It connects to the tiket.com Socket.IO stream, joins a room, and **blindly** fires
`POST .../session/{ROOM_NAME}/hit` whenever the round countdown drops below `MAX_MS_DIFF`.
With multiple tokens, each hit uses the next account in turn (round-robin).

## Setup

```bash
cd penjaga-lilin
npm install
cp .env.example .env      # then fill in ACCESS_TOKEN + ROOM_NAME (+ COOKIE)
```

### Configuration (`.env`)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ACCESS_TOKEN` | ✅ | — | One JWT, or comma-separated JWTs for multi-user round-robin hits. |
| `ROOM_NAME` | ✅ | — | Game session / room id to join and hit. |
| `COOKIE` | recommended | — | Full browser `Cookie` header (single-user only). |
| `ORIGIN` | | derived from `SOCKET_URL` | e.g. `https://gatotkaca.tiket.com`. |
| `SOCKET_URL` | | `wss://api.tiket.com` | Socket.IO server URL. |
| `WS_PATH` | | `/ms-gateway/tix-ggwp-ws-hub/v1/ws/` | Socket.IO path. |
| `API_BASE_URL` | | `https://www.tiket.com/.../session` | Base for the `/{ROOM_NAME}/hit` endpoint. |
| `MAX_MS_DIFF` | | `1300` | Fire the hit when the countdown is within this many ms. |
| `USER_AGENT` | | Chrome-like UA | Sent on socket + hit requests. |

Missing `ACCESS_TOKEN` or `ROOM_NAME` exits immediately with a clear error.

**Multi-user:** set `ACCESS_TOKEN=token_a,token_b,token_c`. The socket listens with the first token; each hit advances to the next user so accounts do not steal from themselves. Shared `COOKIE` is ignored for hits in multi-user mode (per-token `session_access_token` cookies are used instead).

Copy `COOKIE` from DevTools → Network → the `wss://…/tix-ggwp-ws-hub/…` request → Request Headers → `cookie`. Keep `ACCESS_TOKEN` in sync with that session (single-user).

## Run

```bash
cd penjaga-lilin
npm start        # = node socket-client.js
```

## How it works

1. Connects with the first `ACCESS_TOKEN` + browser-like `Cookie`/`Origin` headers, then joins `ROOM_NAME`.
2. On each room event, computes `endTimestamp - now`.
3. If that is below `MAX_MS_DIFF`, it immediately sends the hit — no other checks — using the next user in round-robin order when multiple tokens are configured.
