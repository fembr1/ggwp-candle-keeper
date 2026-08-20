const { EventEmitter } = require("events");
const { io } = require("socket.io-client");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { resolveRuntime, validate } = require("./config");
const {
  diagnoseOutbound,
  formatReport,
  formatHitFailure,
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

function emptySessionState(listening = true) {
  return {
    waitingForStart: false,
    stopped: false,
    listening: listening !== false,
    lastTimeDiff: null,
    hitEndTimestamp: null,
  };
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
    this.sessionState = new Map();
    this.startedAt = null;
    this.lastError = null;
    this.stopReason = null;
    this.lastOutboundDiagAt = 0;
    this.outboundDiagInFlight = false;
  }

  sessionById(id) {
    return this.runtime?.sessions?.find((s) => s.id === id) || null;
  }

  activeSessions() {
    return (this.runtime?.sessions || []).filter((s) => {
      const st = this.sessionState.get(s.id);
      return st && st.listening && !st.stopped;
    });
  }

  getStatus() {
    const rt = this.runtime;
    const sessions = (rt?.sessions || []).map((s) => {
      const st = this.sessionState.get(s.id) || emptySessionState();
      return {
        id: s.id,
        maxMsDiff: s.maxMsDiff,
        stopAt: s.stopAtRaw || "",
        stopAtMs: s.stopAtMs,
        apiUrl: s.apiUrl,
        listening: st.listening !== false,
        stopped: !!st.stopped,
        lastTimeDiff: st.lastTimeDiff,
      };
    });
    return {
      running: this.running,
      connected: this.connected,
      socketId: this.socketId,
      userCount: rt?.users?.length || 0,
      multiUser: !!rt?.multiUser,
      origin: rt?.origin || "",
      startedAt: this.startedAt,
      lastError: this.lastError,
      stopReason: this.stopReason,
      sessions,
    };
  }

  emitStatus() {
    this.emit("status", this.getStatus());
  }

  log(level, message, sessionId = null) {
    const entry = { ts: Date.now(), level, message, sessionId };
    this.emit("log", entry);
    const prefix = sessionId ? `[${sessionId}] ` : "";
    const printer =
      level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    printer(`${prefix}${message}`);
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
    this.sessionState = new Map();
    for (const session of this.runtime.sessions) {
      this.sessionState.set(session.id, emptySessionState(session.listening));
    }
    this.lastError = null;
    this.stopReason = null;
    this.running = true;
    this.startedAt = Date.now();

    const rt = this.runtime;
    this.log("info", "Starting penjaga-lilin socket client...");
    this.log("info", `   - URL: ${rt.socketUrl}`);
    this.log("info", `   - Path: ${rt.wsPath}`);
    this.log("info", `   - Users loaded: ${rt.users.length}`);
    this.log(
      "info",
      `   - Hit rotation: ${rt.multiUser ? "round-robin across users" : "single user"}`
    );
    this.log("info", `   - Origin: ${rt.origin}`);
    this.log("info", `   - Sessions: ${rt.sessions.length}`);
    for (const session of rt.sessions) {
      this.log(
        "info",
        `   - ${session.id} maxMs=${session.maxMsDiff} listening=${session.listening} stopAt=${
          session.stopAtMs != null
            ? new Date(session.stopAtMs).toISOString()
            : "(not set)"
        }`,
        session.id
      );
    }

    this.emitStatus();
    if (this.activeSessions().length > 0) {
      this.initializeSocket();
    } else {
      this.log("info", "No listening sessions — socket idle until Listen");
    }
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

  maybeDisconnectIfIdle() {
    if (this.activeSessions().length > 0) return;
    if (!this.socket) {
      this.emitStatus();
      return;
    }
    this.log("info", "No active sessions — disconnecting socket");
    this.disconnectSocket();
    this.connected = false;
    this.socketId = null;
    this.stopReason = "no active sessions";
    this.emitStatus();
  }

  syncListeningFlag(sessionId, listening) {
    const session = this.sessionById(sessionId);
    if (session) session.listening = listening;
    const row = this.rawConfig?.SESSIONS?.find(
      (s) => String(s.CAMPAIGN_SESSION_ID || "").trim() === sessionId
    );
    if (row) row.LISTENING = listening;
  }

  leaveRoom(sessionId) {
    if (!this.socket) return;
    try {
      this.socket.emit("leave-room", sessionId);
    } catch {
      // ignore
    }
  }

  pauseSession(sessionId) {
    const id = String(sessionId || "").trim();
    const session = this.sessionById(id);
    const st = this.sessionState.get(id);
    if (!session || !st) return this.getStatus();
    if (!st.listening && st.stopped) {
      this.syncListeningFlag(id, false);
      this.emitStatus();
      return this.getStatus();
    }
    const wasActive = st.listening && !st.stopped;
    st.listening = false;
    this.syncListeningFlag(id, false);
    if (wasActive) {
      this.log("info", "Stop listening — leaving room", id);
      this.leaveRoom(id);
    }
    this.emitStatus();
    this.maybeDisconnectIfIdle();
    return this.getStatus();
  }

  resumeSession(sessionId) {
    const id = String(sessionId || "").trim();
    if (!this.running) {
      throw new Error("Client is not running — Start first");
    }
    const session = this.sessionById(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    let st = this.sessionState.get(id);
    if (!st) {
      st = emptySessionState(true);
      this.sessionState.set(id, st);
    }
    st.listening = true;
    st.stopped = false;
    st.waitingForStart = false;
    st.hitEndTimestamp = null;
    this.syncListeningFlag(id, true);
    this.stopReason = null;
    this.log("info", "Start listening", id);
    this.emitStatus();
    if (!this.socket) {
      this.initializeSocket();
    } else if (this.connected) {
      this.joinRoom(session);
    }
    return this.getStatus();
  }

  dropSession(sessionId) {
    const id = String(sessionId || "").trim();
    this.pauseSession(id);
    if (this.runtime?.sessions) {
      this.runtime.sessions = this.runtime.sessions.filter((s) => s.id !== id);
    }
    this.sessionState.delete(id);
    if (this.rawConfig && Array.isArray(this.rawConfig.SESSIONS)) {
      this.rawConfig.SESSIONS = this.rawConfig.SESSIONS.filter(
        (row) => String(row.CAMPAIGN_SESSION_ID || "").trim() !== id
      );
    }
    this.emitStatus();
    this.maybeDisconnectIfIdle();
    return this.getStatus();
  }

  stopSession(session, reason) {
    const st = this.sessionState.get(session.id);
    if (!st || st.stopped) return;
    st.stopped = true;
    this.log("info", `${reason} — leaving room`, session.id);
    this.leaveRoom(session.id);
    this.emitStatus();
    this.maybeDisconnectIfIdle();
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
      Cookie: this.cookieForToken(token),
    };
  }

  joinRoom(session) {
    this.log("info", `Joining room: ${session.id}`, session.id);
    this.socket.emit("join-room", session.id, (ack) => {
      this.log(
        "info",
        `join-room ack: ${typeof ack === "string" ? ack : JSON.stringify(ack)}`,
        session.id
      );
    });
  }

  joinActiveRooms() {
    for (const session of this.activeSessions()) {
      this.joinRoom(session);
    }
  }

  initializeSocket() {
    const rt = this.runtime;

    this.log("info", "Initializing WebSocket connection...");
    this.log("info", `Socket URL: ${rt.socketUrl}`);
    this.log("info", `WS Path: ${rt.wsPath}`);
    this.log("info", `Origin: ${rt.origin}`);

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
          `Engine.io error: ${err?.message || err}${err?.code ? ` (${err.code})` : ""}`
        );
      });
      engine.on("upgradeError", (err) => {
        this.log("error", `WebSocket upgrade error: ${err?.message || err}`);
        this.reportOutboundFailure(err);
      });
    }

    socket.on("connect", () => {
      this.connected = true;
      this.socketId = socket.id;
      this.lastError = null;
      this.log("info", `Connected with Socket ID: ${socket.id}`);
      this.emitStatus();
      this.joinActiveRooms();
    });

    socket.onAny((event, ...args) => {
      const session = this.sessionById(event);
      const preview = args.length ? JSON.stringify(args[0]).slice(0, 400) : "";
      this.log("info", `Event: ${event} ${preview}`, session ? session.id : null);
      if (session) this.handleRoomEvent(session, args[0]);
    });

    socket.io?.engine?.on("packet", (packet) => {
      if (packet.type === "message" && packet.data) {
        const data = String(packet.data);
        if (data === "2" || data === "3") return;
        this.log("info", `Raw packet: ${data.slice(0, 400)}`);
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
      this.log("error", `Socket.io connection error: ${message}`);
      if (descText) this.log("error", `description: ${descText}`);
      if (error.type) this.log("error", `type: ${error.type}`);
      if (error.code) this.log("error", `code: ${error.code}`);
      this.reportOutboundFailure(error);
      this.emitStatus();
    });

    socket.io?.on("reconnect", () => {
      this.log("info", "Reconnected — rejoining active rooms");
      this.joinActiveRooms();
    });

    socket.on("disconnect", (reason) => {
      this.connected = false;
      this.socketId = null;
      this.log("info", `Disconnected. Reason: ${reason}`);
      this.emitStatus();
    });
  }

  disconnectSocket() {
    const socket = this.socket;
    if (!socket) return;
    for (const session of this.activeSessions()) {
      this.log("info", `Disconnecting from room: ${session.id}`, session.id);
      try {
        socket.emit("leave-room", session.id);
      } catch {
        // socket may already be dead
      }
    }
    socket.io?.off("reconnect");
    socket.removeAllListeners();
    socket.disconnect();
    this.socket = null;
    this.log("info", "Socket disconnected and cleaned up");
  }

  handleRoomEvent(session, response) {
    if (!this.running) return;
    const st = this.sessionState.get(session.id);
    if (!st || st.stopped || !st.listening) return;

    if (session.stopAtMs != null && Date.now() >= session.stopAtMs) {
      this.log(
        "info",
        `Hard stop reached (STOP_AT=${session.stopAtRaw})`,
        session.id
      );
      this.stopSession(session, "STOP_AT");
      return;
    }

    if (!response || !response.endTimestamp) {
      this.log("warn", "Invalid response format (no endTimestamp)", session.id);
      return;
    }

    if (isUnsetEndTimestamp(response.endTimestamp)) {
      st.hitEndTimestamp = null;
      if (!st.waitingForStart) {
        this.log(
          "info",
          "endTimestamp is unset — session not started yet; waiting…",
          session.id
        );
        st.waitingForStart = true;
      }
      return;
    }

    if (st.waitingForStart) {
      this.log("info", "Session started — countdown received", session.id);
      st.waitingForStart = false;
    }

    const endTimestamp = new Date(response.endTimestamp).getTime();
    if (Number.isNaN(endTimestamp)) {
      this.log("warn", `Invalid endTimestamp: ${response.endTimestamp}`, session.id);
      return;
    }

    const timeDiff = endTimestamp - Date.now();
    st.lastTimeDiff = timeDiff;
    this.log("info", `Time Difference: ${timeDiff} ms`, session.id);
    this.emitStatus();

    if (timeDiff < session.maxMsDiff) {
      if (st.hitEndTimestamp === endTimestamp) return;
      st.hitEndTimestamp = endTimestamp;
      this.log("info", "Threshold crossed — hitting once (blind)...", session.id);
      this.executePostRequest(session);
    }
  }

  async executePostRequest(session) {
    const rt = this.runtime;
    const st = this.sessionState.get(session.id);
    if (!rt || !this.running || !st || st.stopped || !st.listening) return;

    const userIndex = this.nextUserIndex;
    const token = rt.users[userIndex];
    this.nextUserIndex = (this.nextUserIndex + 1) % rt.users.length;

    const hit = {
      ts: Date.now(),
      sessionId: session.id,
      userIndex,
      userCount: rt.users.length,
      url: session.apiUrl,
      status: null,
      ok: false,
      response: "",
      error: null,
    };

    try {
      this.log(
        "info",
        `Executing POST as user ${userIndex + 1}/${rt.users.length}... ${session.apiUrl}`,
        session.id
      );
      const body = JSON.stringify({ key: uuidv4() });
      const response = await axios.post(session.apiUrl, body, {
        headers: this.buildHitHeaders(token),
        timeout: 30000,
        transformRequest: [(data) => data],
      });
      hit.ok = true;
      hit.status = response.status;
      hit.response = JSON.stringify(response.data);
      this.log("info", `POST successful! Status: ${response.status}`, session.id);
      this.log("info", `Response: ${hit.response}`, session.id);
    } catch (error) {
      if (error.response) {
        hit.status = error.response.status;
        const formatted = formatHitFailure({
          url: session.apiUrl,
          status: error.response.status,
          headers: error.response.headers,
          data: error.response.data,
        });
        hit.response = formatted.report;
        hit.error = formatted.cloudflare
          ? `HTTP ${error.response.status} (Cloudflare)`
          : formatted.interpretation;
        this.log("error", `POST failed. Status: ${error.response.status}`, session.id);
        this.log("error", formatted.interpretation, session.id);
        this.log("error", formatted.report, session.id);
      } else if (error.request) {
        const networkError =
          error.code || error.message || "No response received from server";
        const formatted = formatHitFailure({
          url: session.apiUrl,
          networkError,
        });
        hit.error = formatted.interpretation;
        hit.response = formatted.report;
        this.log("error", formatted.interpretation, session.id);
        this.log("error", formatted.report, session.id);
      } else {
        hit.error = error.message;
        this.log("error", `Error: ${error.message}`, session.id);
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
      cookiePresent: false,
      requestHeaderNames: Object.keys(headers),
      socketError: error,
    })
      .then((diag) => {
        this.log("error", formatReport(diag));
      })
      .catch((err) => {
        this.log("error", `Outbound diagnostic failed: ${err.message}`);
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
