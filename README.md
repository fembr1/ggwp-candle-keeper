# penjaga-lilin

It connects to the tiket.com Socket.IO stream, joins a room, and **blindly** fires
`POST .../session/{ROOM_NAME}/hit` whenever the round countdown drops below `MAX_MS_DIFF`

## Setup

```bash
cd penjaga-lilin
npm install
cp .env.example .env      # then fill in ACCESS_TOKEN + ROOM_NAME (+ COOKIE)
```

### Configuration (`.env`)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ACCESS_TOKEN` | ✅ | — | tiket.com bearer JWT (often the same as `session_access_token`). |
| `ROOM_NAME` | ✅ | — | Game session / room id to join and hit. |
| `COOKIE` | recommended | — | Full browser `Cookie` header from the WS request. |
| `ORIGIN` | | derived from `SOCKET_URL` | e.g. `https://gatotkaca.tiket.com`. |
| `SOCKET_URL` | | `wss://api.tiket.com` | Socket.IO server URL. |
| `WS_PATH` | | `/ms-gateway/tix-ggwp-ws-hub/v1/ws/` | Socket.IO path. |
| `API_BASE_URL` | | `https://www.tiket.com/.../session` | Base for the `/{ROOM_NAME}/hit` endpoint. |
| `MAX_MS_DIFF` | | `1300` | Fire the hit when the countdown is within this many ms. |
| `USER_AGENT` | | Chrome-like UA | Sent on socket + hit requests. |

Missing `ACCESS_TOKEN` or `ROOM_NAME` exits immediately with a clear error.

Copy `COOKIE` from DevTools → Network → the `wss://…/tix-ggwp-ws-hub/…` request → Request Headers → `cookie`. Keep `ACCESS_TOKEN` in sync with that session.

## Run

```bash
cd penjaga-lilin
npm start        # = node socket-client.js
```

## How it works

1. Connects with `accessToken` + browser-like `Cookie`/`Origin` headers, then joins `ROOM_NAME`.
2. On each room event, computes `endTimestamp - now`.
3. If that is below `MAX_MS_DIFF`, it immediately sends the hit — no other checks.
