const fs = require("fs");
const path = require("path");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const DEFAULT_DEVICE_ID = "5d32faf6-4cf7-48eb-bf1d-4396d02f6106";

const DEFAULTS = {
  ACCESS_TOKEN: "",
  CAMPAIGN_SESSION_ID: "",
  SOCKET_URL: "wss://api.tiket.com",
  WS_PATH: "/ms-gateway/tix-ggwp-ws-hub/v1/ws/",
  API_BASE_URL:
    "https://www.tiket.com/ms-gateway/ggwp-server/harta-karun/session",
  MAX_MS_DIFF: 1300,
  STOP_AT: "",
};

const STRING_KEYS = [
  "ACCESS_TOKEN",
  "CAMPAIGN_SESSION_ID",
  "SOCKET_URL",
  "WS_PATH",
  "API_BASE_URL",
  "STOP_AT",
];

function defaults() {
  return { ...DEFAULTS };
}

function parseTokens(raw) {
  return String(raw || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function fromEnv() {
  const d = defaults();
  const envNum = process.env.MAX_MS_DIFF;
  return {
    ACCESS_TOKEN: (process.env.ACCESS_TOKEN || "").trim(),
    CAMPAIGN_SESSION_ID: (
      process.env.CAMPAIGN_SESSION_ID ||
      process.env.ROOM_NAME ||
      ""
    ).trim(),
    SOCKET_URL: (process.env.SOCKET_URL || d.SOCKET_URL).trim(),
    WS_PATH: (process.env.WS_PATH || d.WS_PATH).trim(),
    API_BASE_URL: (process.env.API_BASE_URL || d.API_BASE_URL).trim(),
    MAX_MS_DIFF: envNum ? Number(envNum) : d.MAX_MS_DIFF,
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
  if (!next.CAMPAIGN_SESSION_ID && src.ROOM_NAME) {
    next.CAMPAIGN_SESSION_ID = String(src.ROOM_NAME).trim();
  }
  if (src.MAX_MS_DIFF != null && src.MAX_MS_DIFF !== "") {
    next.MAX_MS_DIFF = Number(src.MAX_MS_DIFF);
  }
  if (!Number.isFinite(next.MAX_MS_DIFF)) next.MAX_MS_DIFF = d.MAX_MS_DIFF;
  return next;
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
    if (!config.CAMPAIGN_SESSION_ID) {
      errors.push("CAMPAIGN_SESSION_ID is required");
    }
  } else if (config.ACCESS_TOKEN && tokens.length === 0) {
    errors.push(
      "ACCESS_TOKEN has no valid tokens. Use a single JWT or comma-separated list."
    );
  }
  if (config.STOP_AT) {
    const ms = Date.parse(config.STOP_AT);
    if (Number.isNaN(ms)) {
      errors.push(
        `Invalid STOP_AT: "${config.STOP_AT}". Use an ISO datetime, e.g. 2026-08-12T18:00:00+07:00`
      );
    }
  }
  if (!Number.isFinite(config.MAX_MS_DIFF) || config.MAX_MS_DIFF <= 0) {
    errors.push("MAX_MS_DIFF must be a positive number");
  }
  return errors;
}

function isReady(config) {
  return validate(config, { requireReady: true }).length === 0;
}

function resolveRuntime(config) {
  const users = parseTokens(config.ACCESS_TOKEN);
  const multiUser = users.length > 1;
  const socketAccessToken = users[0] || "";
  const origin = config.SOCKET_URL.replace(/^wss:/i, "https:").replace(
    /^ws:/i,
    "http:"
  );
  const stopAtRaw = (config.STOP_AT || "").trim();
  const stopAtMs = stopAtRaw ? Date.parse(stopAtRaw) : null;

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
    roomName: (config.CAMPAIGN_SESSION_ID || "").trim(),
    socketUrl: (config.SOCKET_URL || DEFAULTS.SOCKET_URL).trim(),
    wsPath: (config.WS_PATH || DEFAULTS.WS_PATH).trim(),
    apiBaseUrl: (config.API_BASE_URL || DEFAULTS.API_BASE_URL).trim(),
    apiUrl: `${(config.API_BASE_URL || DEFAULTS.API_BASE_URL).trim()}/${(config.CAMPAIGN_SESSION_ID || "").trim()}/hit`,
    maxMsDiff: Number(config.MAX_MS_DIFF) || DEFAULTS.MAX_MS_DIFF,
    stopAtRaw,
    stopAtMs: Number.isNaN(stopAtMs) ? null : stopAtMs,
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

module.exports = {
  defaults,
  fromEnv,
  normalize,
  validate,
  isReady,
  resolveRuntime,
  parseTokens,
  getConfigPath,
  load,
  save,
};
