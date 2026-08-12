// socket-client.js — penjaga-lilin
const path = require("path");
const { io } = require("socket.io-client");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

// --- Config (from .env; fail fast on missing required values) ---
function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    console.error(
      `❌ Missing required env var: ${name}. Copy .env.example to .env and fill it in.`
    );
    process.exit(1);
  }
  return value;
}

const ACCESS_TOKEN_RAW = required("ACCESS_TOKEN");
const USERS = ACCESS_TOKEN_RAW.split(",")
  .map((t) => t.trim())
  .filter(Boolean);
if (USERS.length === 0) {
  console.error(
    "❌ ACCESS_TOKEN has no valid tokens. Use a single JWT or comma-separated list."
  );
  process.exit(1);
}
const MULTI_USER = USERS.length > 1;
// Socket listens with the first account; hits round-robin across all.
const SOCKET_ACCESS_TOKEN = USERS[0];
let nextUserIndex = 0;

// Session / round id used in .../session/{id}/hit and usually the socket room event.
const ROOM_NAME = required("ROOM_NAME");
// Campaign id from URL /game/.../campaign/{id} — optional; also joined if set.
const CAMPAIGN_ID = (process.env.CAMPAIGN_ID || "").trim();
const SOCKET_URL = process.env.SOCKET_URL || "wss://api.tiket.com";
const WS_PATH = process.env.WS_PATH || "/ms-gateway/tix-ggwp-ws-hub/v1/ws/";
const API_BASE_URL =
  process.env.API_BASE_URL ||
  "https://www.tiket.com/ms-gateway/ggwp-server/harta-karun/session";
const API_URL = `${API_BASE_URL}/${ROOM_NAME}/hit`;
const MAX_MS_DIFF = Number(process.env.MAX_MS_DIFF) || 1300;
const STOP_AT_RAW = (process.env.STOP_AT || "").trim();
let STOP_AT_MS = null;
if (STOP_AT_RAW) {
  STOP_AT_MS = Date.parse(STOP_AT_RAW);
  if (Number.isNaN(STOP_AT_MS)) {
    console.error(
      `❌ Invalid STOP_AT: "${STOP_AT_RAW}". Use an ISO datetime, e.g. 2026-08-12T18:00:00+07:00`
    );
    process.exit(1);
  }
}
const COOKIE_FROM_ENV = !!(process.env.COOKIE || "").trim();
// Full COOKIE only applies to single-user mode; multi-user hits use per-token cookies.
const COOKIE =
  !MULTI_USER && COOKIE_FROM_ENV
    ? (process.env.COOKIE || "").trim()
    : `session_access_token=${SOCKET_ACCESS_TOKEN}`;

function cookieValue(name) {
  const match = COOKIE.match(new RegExp(`(?:(?:^|;\\s*)${name}=([^;]*))`));
  return match ? decodeURIComponent(match[1]) : "";
}

const ORIGIN =
  (process.env.ORIGIN || "").trim() ||
  SOCKET_URL.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
const USER_AGENT =
  (process.env.USER_AGENT || "").trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const DEVICE_ID =
  (process.env.DEVICE_ID || "").trim() ||
  cookieValue("device_id") ||
  cookieValue("uniqueId") ||
  "5d32faf6-4cf7-48eb-bf1d-4396d02f6106";
const COUNTRY_CODE = (process.env.COUNTRY_CODE || "sg").trim();
const CURRENCY = (process.env.CURRENCY || "IDR").trim();
const LANG = (process.env.LANG || "en").trim();
const REFERER =
  (process.env.REFERER || "").trim() ||
  (CAMPAIGN_ID
    ? `${ORIGIN}/en-sg/game/berburu-tiket-murah/campaign/${CAMPAIGN_ID}`
    : ORIGIN);

function buildSocketHeaders() {
  return {
    accessToken: SOCKET_ACCESS_TOKEN,
    "X-Cookie-Session-V2": "true",
    Origin: ORIGIN,
    "User-Agent": USER_AGENT,
    "Accept-Language": LANG,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

function cookieForToken(token) {
  return `session_access_token=${token}`;
}

// Match the browser hit curl (cookie session, not Bearer).
function buildHitHeaders(token) {
  const useFullCookie = !MULTI_USER && COOKIE_FROM_ENV;
  return {
    accept: "*/*",
    "accept-language": LANG,
    "content-type": "text/plain;charset=UTF-8",
    "cf-ipcountry": COUNTRY_CODE.toUpperCase(),
    countrycode: COUNTRY_CODE,
    currency: CURRENCY,
    deviceid: DEVICE_ID,
    lang: LANG,
    origin: ORIGIN,
    referer: REFERER,
    "user-agent": USER_AGENT,
    "x-audience": "tiket.com",
    "x-cookie-session-v2": "true",
    "x-country-code": COUNTRY_CODE,
    "x-country-id": COUNTRY_CODE,
    "x-currency": CURRENCY,
    Cookie: useFullCookie ? COOKIE : cookieForToken(token),
  };
}

let socket = null;
let currentRoomId = null;

function joinRoom(roomId) {
  console.log("🏠 Joining room:", roomId);
  socket.emit("join-room", roomId, (ack) => {
    console.log(
      "✅ join-room ack:",
      typeof ack === "string" ? ack : JSON.stringify(ack)
    );
  });
}

function initializeSocket(roomId) {
  console.log("🔌 Initializing WebSocket connection...");
  console.log("🌐 Socket URL:", SOCKET_URL);
  console.log("🛤️ WS Path:", WS_PATH);
  console.log("🏠 Session/room ID:", roomId);
  if (CAMPAIGN_ID) console.log("📣 Campaign ID:", CAMPAIGN_ID);
  console.log("🧭 Origin:", ORIGIN);
  console.log(
    "🍪 Cookie mode:",
    !MULTI_USER && COOKIE_FROM_ENV
      ? "full COOKIE from .env"
      : "minimal (session_access_token only)"
  );
  if (MULTI_USER && COOKIE_FROM_ENV) {
    console.log(
      "ℹ️ Multi-user mode — ignoring shared COOKIE for hits; using per-token cookies"
    );
  }

  socket = io(SOCKET_URL, {
    extraHeaders: buildSocketHeaders(),
    transports: ["websocket"],
    withCredentials: true,
    autoConnect: false,
    path: WS_PATH,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 30000,
    forceNew: true,
  });

  socket.connect();
  currentRoomId = roomId;

  socket.on("connect", () => {
    console.log(`✅ Connected with Socket ID: ${socket.id}`);
    joinRoom(roomId);
    // Campaign page may also join the campaign room — cover both.
    if (CAMPAIGN_ID && CAMPAIGN_ID !== roomId) {
      joinRoom(CAMPAIGN_ID);
    }
  });

  socket.onAny((event, ...args) => {
    const preview = args.length ? JSON.stringify(args[0]).slice(0, 400) : "";
    console.log("📨 Event:", event, preview);
    if (event === roomId || (CAMPAIGN_ID && event === CAMPAIGN_ID)) {
      handleRoomEvent(args[0]);
    }
  });

  socket.io?.engine?.on("packet", (packet) => {
    if (packet.type === "message" && packet.data) {
      const data = String(packet.data);
      if (data === "2" || data === "3") return;
      console.log("📦 Raw packet:", data.slice(0, 400));
    }
  });

  socket.on("connect_error", (error) => {
    console.error("❌ Socket.io connection error:", error.message || error);
    if (error.message && error.message.includes("403")) {
      console.error(
        "🚫 403 Forbidden — refresh COOKIE + ACCESS_TOKEN from the browser."
      );
    }
  });

  socket.io?.on("reconnect", () => {
    console.log("🔄 Reconnected — rejoining rooms");
    joinRoom(roomId);
    if (CAMPAIGN_ID && CAMPAIGN_ID !== roomId) joinRoom(CAMPAIGN_ID);
  });

  socket.on("disconnect", (reason) => {
    console.log("💔 Disconnected. Reason:", reason);
  });

  return socket;
}

function disconnectSocket(roomId) {
  if (socket && roomId) {
    console.log(`🚪 Disconnecting from room: ${roomId}`);
    socket.emit("leave-room", roomId);
    if (CAMPAIGN_ID && CAMPAIGN_ID !== roomId) {
      socket.emit("leave-room", CAMPAIGN_ID);
    }
    socket.io?.off("reconnect");
    socket.disconnect();
    console.log("🔌 Socket disconnected and cleaned up");
  }
}

// Zero-value / unset Go time — session not started by anyone yet.
function isUnsetEndTimestamp(value) {
  if (!value || typeof value !== "string") return true;
  const normalized = value.trim().toUpperCase();
  return (
    normalized.startsWith("0001-01-01") ||
    normalized === "0001-01-01T00:00:00Z"
  );
}

let waitingForStartLogged = false;
let hardStopLogged = false;

function isPastHardStop() {
  return STOP_AT_MS !== null && Date.now() >= STOP_AT_MS;
}

function handleRoomEvent(response) {
  if (isPastHardStop()) {
    if (!hardStopLogged) {
      hardStopLogged = true;
      console.log(`🛑 Hard stop reached (STOP_AT=${STOP_AT_RAW}) — shutting down`);
      gracefulShutdown("STOP_AT");
    }
    return;
  }

  if (!response || !response.endTimestamp) {
    console.log("⚠️ Invalid response format (no endTimestamp)");
    return;
  }

  if (isUnsetEndTimestamp(response.endTimestamp)) {
    if (!waitingForStartLogged) {
      console.log(
        "⏳ endTimestamp is unset (0001-01-01…) — session not started yet; waiting for someone to start it…"
      );
      waitingForStartLogged = true;
    }
    return;
  }

  if (waitingForStartLogged) {
    console.log("▶️ Session started — countdown received");
    waitingForStartLogged = false;
  }

  const endTimestamp = new Date(response.endTimestamp).getTime();
  if (Number.isNaN(endTimestamp)) {
    console.log("⚠️ Invalid endTimestamp:", response.endTimestamp);
    return;
  }

  const timeDiff = endTimestamp - Date.now();
  console.log("⏰ Time Difference:", timeDiff, "ms");

  if (timeDiff < MAX_MS_DIFF) {
    console.log("🎯 Threshold crossed — hitting (blind)...");
    executePostRequest();
  }
}

async function executePostRequest() {
  const userIndex = nextUserIndex;
  const token = USERS[userIndex];
  nextUserIndex = (nextUserIndex + 1) % USERS.length;

  try {
    console.log(
      `🚀 Executing POST request as user ${userIndex + 1}/${USERS.length}...`,
      API_URL
    );
    // Browser sends JSON as text/plain body — keep the same content-type.
    const body = JSON.stringify({ key: uuidv4() });
    const response = await axios.post(API_URL, body, {
      headers: buildHitHeaders(token),
      timeout: 30000,
      transformRequest: [(data) => data],
    });
    console.log("✅ POST request successful! Status:", response.status);
    console.log("📄 Response:", JSON.stringify(response.data));
  } catch (error) {
    if (error.response) {
      console.error("❌ POST failed. Status:", error.response.status);
      console.error("📄 Response:", JSON.stringify(error.response.data));
    } else if (error.request) {
      console.error("📡 No response received from server");
    } else {
      console.error("🔥 Error:", error.message);
    }
  }
}

function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  disconnectSocket(currentRoomId);
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

console.log("🎯 Starting penjaga-lilin socket client...");
console.log("   - URL:", SOCKET_URL);
console.log("   - Path:", WS_PATH);
console.log("   - Session/room:", ROOM_NAME);
console.log("   - Campaign:", CAMPAIGN_ID || "(not set)");
console.log("   - Hit URL:", API_URL);
console.log("   - Users loaded:", USERS.length);
console.log(
  "   - Hit rotation:",
  MULTI_USER ? "round-robin across users" : "single user"
);
console.log(
  "   - Cookie mode:",
  !MULTI_USER && COOKIE_FROM_ENV
    ? "full COOKIE from .env"
    : "minimal (session_access_token only)"
);
console.log("   - Origin:", ORIGIN);
console.log("   - Max ms diff:", MAX_MS_DIFF);
console.log(
  "   - Hard stop:",
  STOP_AT_MS !== null ? new Date(STOP_AT_MS).toISOString() : "(not set)"
);
initializeSocket(ROOM_NAME);
