const { EventEmitter } = require("events");
const { io } = require("socket.io-client");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { resolveRuntime, validate } = require("./config");
const {
  diagnoseOutbound,
  formatReport,
  pickHeaders,
} = require("./outbound-debug");

const OUTBOUND_DIAG_COOLDOWN_MS = 20000;

function isUnsetEndTimestamp(value) {
  if (!value || typeof value !== "string") return true;
  const normalized = value.trim().toUpperCase();
  return (
    normalized.startsWith("0001-01-01") ||
    normalized === "0001-01-01T00:00:00Z"
  );
}

class SocketClient extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.connected = false;
    this.socketId = null;
    this.socket = null;
    this.runtime = null;
    this.rawConfig = null;
    this.nextUserIndex = 0;
    this.waitingForStartLogged = false;
    this.hardStopLogged = false;
    this.startedAt = null;
    this.lastError = null;
    this.stopReason = null;
    this.lastOutboundDiagAt = 0;
    this.outboundDiagInFlight = false;
  }

  getStatus() {
    const rt = this.runtime;
    return {
      running: this.running,
      connected: this.connected,
      socketId: this.socketId,
      roomName: rt?.roomName || this.rawConfig?.ROOM_NAME || "",
      campaignId: rt?.campaignId || this.rawConfig?.CAMPAIGN_ID || "",
      userCount: rt?.users?.length || 0,
      multiUser: !!rt?.multiUser,
      cookieMode:
        rt && !rt.multiUser && rt.cookieFromConfig
          ? "full COOKIE"
          : "minimal (session_access_token only)",
      maxMsDiff: rt?.maxMsDiff ?? this.rawConfig?.MAX_MS_DIFF ?? null,
      stopAt: rt?.stopAtRaw || "",
      stopAtMs: rt?.stopAtMs ?? null,
      origin: rt?.origin || "",
      hitUrl: rt?.apiUrl || "",
      startedAt: this.startedAt,
      lastError: this.lastError,
      stopReason: this.stopReason,
    };
  }

  emitStatus() {
    this.emit("status", this.getStatus());
  }

  log(level, message) {
    const entry = { ts: Date.now(), level, message };
    this.emit("log", entry);
    const printer =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    printer(message);
  }

  start(rawConfig) {
    if (this.running) {
      throw new Error("Client is already running");
    }
    const errors = validate(rawConfig, { requireReady: true });
    if (errors.length) {
      const err = new Error(errors.join("; "));
      this.lastError = err.message;
      throw err;
    }

    this.rawConfig = rawConfig;
    this.runtime = resolveRuntime(rawConfig);
    this.nextUserIndex = 0;
    this.waitingForStartLogged = false;
    this.hardStopLogged = false;
    this.lastError = null;
    this.stopReason = null;
    this.running = true;
    this.startedAt = Date.now();

    const rt = this.runtime;
    this.log("info", "🎯 Starting penjaga-lilin socket client...");
    this.log("info", `   - URL: ${rt.socketUrl}`);
    this.log("info", `   - Path: ${rt.wsPath}`);
    this.log("info", `   - Session/room: ${rt.roomName}`);
    this.log("info", `   - Campaign: ${rt.campaignId || "(not set)"}`);
    this.log("info", `   - Hit URL: ${rt.apiUrl}`);
    this.log("info", `   - Users loaded: ${rt.users.length}`);
    this.log(
      "info",
      `   - Hit rotation: ${rt.multiUser ? "round-robin across users" : "single user"}`
    );
    this.log(
      "info",
      `   - Cookie mode: ${
        !rt.multiUser && rt.cookieFromConfig
          ? "full COOKIE"
          : "minimal (session_access_token only)"
      }`
    );
    this.log("info", `   - Origin: ${rt.origin}`);
    this.log("info", `   - Max ms diff: ${rt.maxMsDiff}`);
    this.log(
      "info",
      `   - Hard stop: ${
        rt.stopAtMs != null ? new Date(rt.stopAtMs).toISOString() : "(not set)"
      }`
    );

    this.emitStatus();
    this.initializeSocket();
    return this.getStatus();
  }

  stop(reason = "stop") {
    if (!this.running && !this.socket) return this.getStatus();
    this.stopReason = reason;
    this.log("info", `${reason} received, shutting down...`);
    this.disconnectSocket();
    this.running = false;
    this.connected = false;
    this.socketId = null;
    this.emitStatus();
    return this.getStatus();
  }

  restart(rawConfig) {
    const next = rawConfig || this.rawConfig;
    if (this.running || this.socket) this.stop("restart");
    return this.start(next);
  }

  buildSocketHeaders() {
    const rt = this.runtime;
    return {
      accessToken: rt.socketAccessToken,
      "X-Cookie-Session-V2": "true",
      Origin: rt.origin,
      "User-Agent": rt.userAgent,
      "Accept-Language": rt.lang,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    };
  }

  cookieForToken(token) {
    return `session_access_token=${token}`;
  }

  buildHitHeaders(token) {
    const rt = this.runtime;
    const useFullCookie = !rt.multiUser && rt.cookieFromConfig;
    return {
      accept: "*/*",
      "accept-language": rt.lang,
      "content-type": "text/plain;charset=UTF-8",
      "cf-ipcountry": rt.countryCode.toUpperCase(),
      countrycode: rt.countryCode,
      currency: rt.currency,
      deviceid: rt.deviceId,
      lang: rt.lang,
      origin: rt.origin,
      referer: rt.referer,
      "user-agent": rt.userAgent,
      "x-audience": "tiket.com",
      "x-cookie-session-v2": "true",
      "x-country-code": rt.countryCode,
      "x-country-id": rt.countryCode,
      "x-currency": rt.currency,
      Cookie: useFullCookie ? rt.cookie : this.cookieForToken(token),
    };
  }

  joinRoom(roomId) {
    this.log("info", `🏠 Joining room: ${roomId}`);
    this.socket.emit("join-room", roomId, (ack) => {
      this.log(
        "info",
        `✅ join-room ack: ${typeof ack === "string" ? ack : JSON.stringify(ack)}`
      );
    });
  }

  initializeSocket() {
    const rt = this.runtime;
    const roomId = rt.roomName;

    this.log("info", "🔌 Initializing WebSocket connection...");
    this.log("info", `🌐 Socket URL: ${rt.socketUrl}`);
    this.log("info", `🛤️ WS Path: ${rt.wsPath}`);
    this.log("info", `🏠 Session/room ID: ${roomId}`);
    if (rt.campaignId) this.log("info", `📣 Campaign ID: ${rt.campaignId}`);
    this.log("info", `🧭 Origin: ${rt.origin}`);
    this.log(
      "info",
      `🍪 Cookie mode: ${
        !rt.multiUser && rt.cookieFromConfig
          ? "full COOKIE"
          : "minimal (session_access_token only)"
      }`
    );
    if (rt.multiUser && rt.cookieFromConfig) {
      this.log(
        "info",
        "ℹ️ Multi-user mode — ignoring shared COOKIE for hits; using per-token cookies"
      );
    }

    const socket = io(rt.socketUrl, {
      extraHeaders: this.buildSocketHeaders(),
      transports: ["websocket"],
      withCredentials: true,
      autoConnect: false,
      path: rt.wsPath,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 30000,
      forceNew: true,
    });

    this.socket = socket;
    socket.connect();

    const engine = socket.io?.engine;
    if (engine) {
      engine.on("error", (err) => {
        this.log(
          "error",
          `❌ Engine.io error: ${err?.message || err}${err?.code ? ` (${err.code})` : ""}`
        );
      });
      engine.on("upgradeError", (err) => {
        this.log("error", `❌ WebSocket upgrade error: ${err?.message || err}`);
        this.reportOutboundFailure(err);
      });
    }

    socket.on("connect", () => {
      this.connected = true;
      this.socketId = socket.id;
      this.lastError = null;
      this.log("info", `✅ Connected with Socket ID: ${socket.id}`);
      this.emitStatus();
      this.joinRoom(roomId);
      if (rt.campaignId && rt.campaignId !== roomId) {
        this.joinRoom(rt.campaignId);
      }
    });

    socket.onAny((event, ...args) => {
      const preview = args.length ? JSON.stringify(args[0]).slice(0, 400) : "";
      this.log("info", `📨 Event: ${event} ${preview}`);
      if (event === roomId || (rt.campaignId && event === rt.campaignId)) {
        this.handleRoomEvent(args[0]);
      }
    });

    socket.io?.engine?.on("packet", (packet) => {
      if (packet.type === "message" && packet.data) {
        const data = String(packet.data);
        if (data === "2" || data === "3") return;
        this.log("info", `📦 Raw packet: ${data.slice(0, 400)}`);
      }
    });

    socket.on("connect_error", (error) => {
      const message = error.message || String(error);
      const desc = error.description;
      const descText =
        desc && typeof desc === "object"
          ? desc.message || desc.statusMessage || String(desc)
          : desc
            ? String(desc)
            : "";
      this.lastError = descText ? `${message} (${descText})` : message;
      this.connected = false;
      this.log("error", `❌ Socket.io connection error: ${message}`);
      if (descText) this.log("error", `   description: ${descText}`);
      if (error.type) this.log("error", `   type: ${error.type}`);
      if (error.code) this.log("error", `   code: ${error.code}`);
      this.reportOutboundFailure(error);
      this.emitStatus();
    });

    socket.io?.on("reconnect", () => {
      this.log("info", "🔄 Reconnected — rejoining rooms");
      this.joinRoom(roomId);
      if (rt.campaignId && rt.campaignId !== roomId) this.joinRoom(rt.campaignId);
    });

    socket.on("disconnect", (reason) => {
      this.connected = false;
      this.socketId = null;
      this.log("info", `💔 Disconnected. Reason: ${reason}`);
      this.emitStatus();
    });
  }

  disconnectSocket() {
    const socket = this.socket;
    const rt = this.runtime;
    if (!socket) return;
    if (rt?.roomName) {
      this.log("info", `🚪 Disconnecting from room: ${rt.roomName}`);
      try {
        socket.emit("leave-room", rt.roomName);
        if (rt.campaignId && rt.campaignId !== rt.roomName) {
          socket.emit("leave-room", rt.campaignId);
        }
      } catch {
        // socket may already be dead
      }
    }
    socket.io?.off("reconnect");
    socket.removeAllListeners();
    socket.disconnect();
    this.socket = null;
    this.log("info", "🔌 Socket disconnected and cleaned up");
  }

  isPastHardStop() {
    const ms = this.runtime?.stopAtMs;
    return ms != null && Date.now() >= ms;
  }

  handleRoomEvent(response) {
    if (!this.running) return;

    if (this.isPastHardStop()) {
      if (!this.hardStopLogged) {
        this.hardStopLogged = true;
        this.log(
          "info",
          `🛑 Hard stop reached (STOP_AT=${this.runtime.stopAtRaw}) — stopping client`
        );
        this.stop("STOP_AT");
      }
      return;
    }

    if (!response || !response.endTimestamp) {
      this.log("warn", "⚠️ Invalid response format (no endTimestamp)");
      return;
    }

    if (isUnsetEndTimestamp(response.endTimestamp)) {
      if (!this.waitingForStartLogged) {
        this.log(
          "info",
          "⏳ endTimestamp is unset (0001-01-01…) — session not started yet; waiting for someone to start it…"
        );
        this.waitingForStartLogged = true;
      }
      return;
    }

    if (this.waitingForStartLogged) {
      this.log("info", "▶️ Session started — countdown received");
      this.waitingForStartLogged = false;
    }

    const endTimestamp = new Date(response.endTimestamp).getTime();
    if (Number.isNaN(endTimestamp)) {
      this.log("warn", `⚠️ Invalid endTimestamp: ${response.endTimestamp}`);
      return;
    }

    const timeDiff = endTimestamp - Date.now();
    this.log("info", `⏰ Time Difference: ${timeDiff} ms`);

    if (timeDiff < this.runtime.maxMsDiff) {
      this.log("info", "🎯 Threshold crossed — hitting (blind)...");
      this.executePostRequest();
    }
  }

  async executePostRequest() {
    const rt = this.runtime;
    if (!rt || !this.running) return;

    const userIndex = this.nextUserIndex;
    const token = rt.users[userIndex];
    this.nextUserIndex = (this.nextUserIndex + 1) % rt.users.length;

    const hit = {
      ts: Date.now(),
      userIndex,
      userCount: rt.users.length,
      url: rt.apiUrl,
      status: null,
      ok: false,
      response: "",
      error: null,
    };

    try {
      this.log(
        "info",
        `🚀 Executing POST request as user ${userIndex + 1}/${rt.users.length}... ${rt.apiUrl}`
      );
      const body = JSON.stringify({ key: uuidv4() });
      const response = await axios.post(rt.apiUrl, body, {
        headers: this.buildHitHeaders(token),
        timeout: 30000,
        transformRequest: [(data) => data],
      });
      hit.ok = true;
      hit.status = response.status;
      hit.response = JSON.stringify(response.data);
      this.log("info", `✅ POST request successful! Status: ${response.status}`);
      this.log("info", `📄 Response: ${hit.response}`);
    } catch (error) {
      if (error.response) {
        hit.status = error.response.status;
        hit.response = JSON.stringify(error.response.data);
        hit.error = `HTTP ${error.response.status}`;
        this.log("error", `❌ POST failed. Status: ${error.response.status}`);
        this.log(
          "error",
          `   headers: ${JSON.stringify(pickHeaders(error.response.headers))}`
        );
        this.log("error", `📄 Response: ${String(hit.response).slice(0, 500)}`);
      } else if (error.request) {
        hit.error = "No response received from server";
        this.log("error", "📡 No response received from server");
      } else {
        hit.error = error.message;
        this.log("error", `🔥 Error: ${error.message}`);
      }
    }

    this.emit("hit", hit);
  }

  reportOutboundFailure(error) {
    const now = Date.now();
    if (this.outboundDiagInFlight) return;
    if (now - this.lastOutboundDiagAt < OUTBOUND_DIAG_COOLDOWN_MS) return;
    this.lastOutboundDiagAt = now;
    this.outboundDiagInFlight = true;

    const rt = this.runtime;
    const headers = this.buildSocketHeaders();
    diagnoseOutbound({
      socketUrl: rt.socketUrl,
      wsPath: rt.wsPath,
      origin: rt.origin,
      userAgent: rt.userAgent,
      acceptLanguage: rt.lang,
      cookiePresent: !!(rt.cookieFromConfig && rt.cookie),
      requestHeaderNames: Object.keys(headers),
      socketError: error,
    })
      .then((diag) => {
        this.log("error", formatReport(diag));
      })
      .catch((err) => {
        this.log("error", `❌ Outbound diagnostic failed: ${err.message}`);
      })
      .finally(() => {
        this.outboundDiagInFlight = false;
      });
  }
}

function createClient() {
  return new SocketClient();
}

module.exports = { SocketClient, createClient };
