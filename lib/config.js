const fs = require("fs");
const path = require("path");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const DEFAULT_DEVICE_ID = "5d32faf6-4cf7-48eb-bf1d-4396d02f6106";

const DEFAULT_SOCKET_ORIGIN = "wss://api.tiket.com";
const DEFAULT_WS_PATH = "/ms-gateway/tix-ggwp-ws-hub/v1/ws/";
const DEFAULT_MAX_MS_DIFF = 1300;

const DEFAULTS = {
  ACCESS_TOKEN: "",
  SOCKET_URL: `${DEFAULT_SOCKET_ORIGIN}${DEFAULT_WS_PATH}`,
  API_BASE_URL:
    "https://www.tiket.com/ms-gateway/ggwp-server/harta-karun/session",
  SESSIONS: [],
};

const STRING_KEYS = ["ACCESS_TOKEN", "SOCKET_URL", "API_BASE_URL"];

function parseListening(value) {
  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }
  return true;
}

function emptySession() {
  return {
    CAMPAIGN_SESSION_ID: "",
    MAX_MS_DIFF: DEFAULT_MAX_MS_DIFF,
    STOP_AT: "",
    LISTENING: true,
  };
}

function defaults() {
  return { ...DEFAULTS, SESSIONS: [emptySession()] };
}

function parseTokens(raw) {
  return String(raw || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function coalesceSocketUrl(url, extraPath) {
  const fallback = `${DEFAULT_SOCKET_ORIGIN}${DEFAULT_WS_PATH}`;
  const raw = String(url || "").trim() || fallback;
  try {
    const parsed = new URL(raw);
    if (!/^wss?:$/i.test(parsed.protocol) && !/^https?:$/i.test(parsed.protocol)) {
      return fallback;
    }
    let pathname = parsed.pathname || "/";
    if (pathname === "/") {
      const fromSplit = String(extraPath || "").trim();
      pathname = fromSplit || DEFAULT_WS_PATH;
    }
    if (!pathname.startsWith("/")) pathname = `/${pathname}`;
    if (!pathname.endsWith("/")) pathname += "/";
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return fallback;
  }
}

function splitSocketUrl(url) {
  const combined = coalesceSocketUrl(url);
  const parsed = new URL(combined);
  const origin = `${parsed.protocol}//${parsed.host}`;
  return { origin, wsPath: parsed.pathname || DEFAULT_WS_PATH };
}

function normalizeSession(raw, fallbackMax = DEFAULT_MAX_MS_DIFF) {
  const src = raw && typeof raw === "object" ? raw : {};
  let maxMs = Number(src.MAX_MS_DIFF);
  if (!Number.isFinite(maxMs) || maxMs <= 0) maxMs = fallbackMax;
  return {
    CAMPAIGN_SESSION_ID: String(
      src.CAMPAIGN_SESSION_ID || src.ROOM_NAME || ""
    ).trim(),
    MAX_MS_DIFF: maxMs,
    STOP_AT: String(src.STOP_AT || "").trim(),
    LISTENING: parseListening(src.LISTENING),
  };
}

function migrateSessions(src) {
  if (Array.isArray(src.SESSIONS) && src.SESSIONS.length > 0) {
    return src.SESSIONS.map((row) => normalizeSession(row));
  }
  const id = String(
    src.CAMPAIGN_SESSION_ID || src.ROOM_NAME || ""
  ).trim();
  const session = normalizeSession({
    CAMPAIGN_SESSION_ID: id,
    MAX_MS_DIFF: src.MAX_MS_DIFF,
    STOP_AT: src.STOP_AT,
  });
  return [session];
}

function fromEnv() {
  const d = defaults();
  const envNum = process.env.MAX_MS_DIFF;
  return {
    ACCESS_TOKEN: (process.env.ACCESS_TOKEN || "").trim(),
    SOCKET_URL: coalesceSocketUrl(
      process.env.SOCKET_URL || d.SOCKET_URL,
      process.env.WS_PATH
    ),
    API_BASE_URL: (process.env.API_BASE_URL || d.API_BASE_URL).trim(),
    CAMPAIGN_SESSION_ID: (
      process.env.CAMPAIGN_SESSION_ID ||
      process.env.ROOM_NAME ||
      ""
    ).trim(),
    MAX_MS_DIFF: envNum ? Number(envNum) : DEFAULT_MAX_MS_DIFF,
    STOP_AT: (process.env.STOP_AT || "").trim(),
  };
}

function normalize(input) {
  const d = defaults();
  const src = input && typeof input === "object" ? input : {};
  const next = { ...d };
  for (const key of STRING_KEYS) {
    if (src[key] != null) next[key] = String(src[key]).trim();
  }
  next.SOCKET_URL = coalesceSocketUrl(next.SOCKET_URL, src.WS_PATH);
  next.SESSIONS = migrateSessions(src);
  if (next.SESSIONS.length === 0) next.SESSIONS = [emptySession()];
  return {
    ACCESS_TOKEN: next.ACCESS_TOKEN,
    SOCKET_URL: next.SOCKET_URL,
    API_BASE_URL: next.API_BASE_URL,
    SESSIONS: next.SESSIONS,
  };
}

function validate(config, { requireReady = false } = {}) {
  const errors = [];
  const tokens = parseTokens(config.ACCESS_TOKEN);
  if (requireReady) {
    if (!config.ACCESS_TOKEN) {
      errors.push("ACCESS_TOKEN is required");
    } else if (tokens.length === 0) {
      errors.push(
        "ACCESS_TOKEN has no valid tokens. Use a single JWT or comma-separated list."
      );
    }
  } else if (config.ACCESS_TOKEN && tokens.length === 0) {
    errors.push(
      "ACCESS_TOKEN has no valid tokens. Use a single JWT or comma-separated list."
    );
  }

  const sessions = Array.isArray(config.SESSIONS) ? config.SESSIONS : [];
  const ids = sessions
    .map((s) => String(s.CAMPAIGN_SESSION_ID || "").trim())
    .filter(Boolean);
  if (requireReady && ids.length === 0) {
    errors.push("At least one CAMPAIGN_SESSION_ID is required");
  }
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push(`Duplicate CAMPAIGN_SESSION_ID: ${id}`);
      break;
    }
    seen.add(id);
  }
  sessions.forEach((session, index) => {
    const maxMs = Number(session.MAX_MS_DIFF);
    if (!Number.isFinite(maxMs) || maxMs <= 0) {
      errors.push(`SESSIONS[${index}].MAX_MS_DIFF must be a positive number`);
    }
    if (session.STOP_AT) {
      const ms = Date.parse(session.STOP_AT);
      if (Number.isNaN(ms)) {
        errors.push(
          `SESSIONS[${index}].STOP_AT invalid: "${session.STOP_AT}". Use an ISO datetime, e.g. 2026-08-12T18:00:00+07:00`
        );
      }
    }
  });
  return errors;
}

function isReady(config) {
  return validate(config, { requireReady: true }).length === 0;
}

function resolveRuntime(config) {
  const users = parseTokens(config.ACCESS_TOKEN);
  const multiUser = users.length > 1;
  const socketAccessToken = users[0] || "";
  const { origin: socketOrigin, wsPath } = splitSocketUrl(config.SOCKET_URL);
  const origin = socketOrigin
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:");
  const apiBase = (config.API_BASE_URL || DEFAULTS.API_BASE_URL).trim();
  const sessions = (config.SESSIONS || [])
    .map((row) => normalizeSession(row))
    .filter((row) => row.CAMPAIGN_SESSION_ID)
    .map((row) => {
      const stopAtRaw = row.STOP_AT;
      const parsed = stopAtRaw ? Date.parse(stopAtRaw) : null;
      return {
        id: row.CAMPAIGN_SESSION_ID,
        maxMsDiff: row.MAX_MS_DIFF,
        stopAtRaw,
        stopAtMs: parsed != null && !Number.isNaN(parsed) ? parsed : null,
        apiUrl: `${apiBase}/${row.CAMPAIGN_SESSION_ID}/hit`,
        listening: parseListening(row.LISTENING),
      };
    });

  return {
    users,
    multiUser,
    socketAccessToken,
    origin,
    userAgent: DEFAULT_USER_AGENT,
    deviceId: DEFAULT_DEVICE_ID,
    countryCode: "sg",
    currency: "IDR",
    lang: "en",
    referer: origin,
    socketUrl: socketOrigin,
    wsPath,
    apiBaseUrl: apiBase,
    sessions,
  };
}

function getConfigPath() {
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  if (fs.existsSync("/data")) {
    try {
      if (fs.statSync("/data").isDirectory()) {
        return path.join("/data", "config.json");
      }
    } catch {
      // fall through
    }
  }
  return path.join(__dirname, "..", "config.json");
}

function load() {
  const filePath = getConfigPath();
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return normalize({ ...fromEnv(), ...raw });
    } catch (err) {
      console.error("⚠️ Failed to read config file, using env seed:", err.message);
    }
  }
  return normalize(fromEnv());
}

function save(config) {
  const filePath = getConfigPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(normalize(config), null, 2)}\n`,
    "utf8"
  );
  return filePath;
}

function findSessionIndex(config, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id || !Array.isArray(config?.SESSIONS)) return -1;
  return config.SESSIONS.findIndex(
    (row) => String(row.CAMPAIGN_SESSION_ID || "").trim() === id
  );
}

module.exports = {
  defaults,
  emptySession,
  fromEnv,
  normalize,
  validate,
  isReady,
  resolveRuntime,
  parseTokens,
  parseListening,
  findSessionIndex,
  getConfigPath,
  load,
  save,
};
