const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  ACCESS_TOKEN: "",
  ROOM_NAME: "",
  CAMPAIGN_ID: "",
  SOCKET_URL: "wss://api.tiket.com",
  WS_PATH: "/ms-gateway/tix-ggwp-ws-hub/v1/ws/",
  API_BASE_URL:
    "https://www.tiket.com/ms-gateway/ggwp-server/harta-karun/session",
  MAX_MS_DIFF: 1300,
  STOP_AT: "",
  COOKIE: "",
  ORIGIN: "",
  USER_AGENT: "",
  DEVICE_ID: "",
  COUNTRY_CODE: "sg",
  CURRENCY: "IDR",
  LANG: "en",
  REFERER: "",
};

const STRING_KEYS = [
  "ACCESS_TOKEN",
  "ROOM_NAME",
  "CAMPAIGN_ID",
  "SOCKET_URL",
  "WS_PATH",
  "API_BASE_URL",
  "STOP_AT",
  "COOKIE",
  "ORIGIN",
  "USER_AGENT",
  "DEVICE_ID",
  "COUNTRY_CODE",
  "CURRENCY",
  "LANG",
  "REFERER",
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

function cookieValue(cookie, name) {
  const match = String(cookie || "").match(
    new RegExp(`(?:(?:^|;\\s*)${name}=([^;]*))`)
  );
  return match ? decodeURIComponent(match[1]) : "";
}

function fromEnv() {
  const d = defaults();
  const envNum = process.env.MAX_MS_DIFF;
  return {
    ACCESS_TOKEN: (process.env.ACCESS_TOKEN || "").trim(),
    ROOM_NAME: (process.env.ROOM_NAME || "").trim(),
    CAMPAIGN_ID: (process.env.CAMPAIGN_ID || "").trim(),
    SOCKET_URL: (process.env.SOCKET_URL || d.SOCKET_URL).trim(),
    WS_PATH: (process.env.WS_PATH || d.WS_PATH).trim(),
    API_BASE_URL: (process.env.API_BASE_URL || d.API_BASE_URL).trim(),
    MAX_MS_DIFF: envNum ? Number(envNum) : d.MAX_MS_DIFF,
    STOP_AT: (process.env.STOP_AT || "").trim(),
    COOKIE: (process.env.COOKIE || "").trim(),
    ORIGIN: (process.env.ORIGIN || "").trim(),
    USER_AGENT: (process.env.USER_AGENT || "").trim(),
    DEVICE_ID: (process.env.DEVICE_ID || "").trim(),
    COUNTRY_CODE: (process.env.COUNTRY_CODE || d.COUNTRY_CODE).trim(),
    CURRENCY: (process.env.CURRENCY || d.CURRENCY).trim(),
    LANG: (process.env.LANG || d.LANG).trim(),
    REFERER: (process.env.REFERER || "").trim(),
  };
}

function normalize(input) {
  const d = defaults();
  const src = input && typeof input === "object" ? input : {};
  const next = { ...d };
  for (const key of STRING_KEYS) {
    if (src[key] != null) next[key] = String(src[key]).trim();
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
    if (!config.ROOM_NAME) {
      errors.push("ROOM_NAME is required");
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
  const cookieFromConfig = !!(config.COOKIE || "").trim();
  const cookie =
    !multiUser && cookieFromConfig
      ? config.COOKIE.trim()
      : `session_access_token=${socketAccessToken}`;
  const origin =
    (config.ORIGIN || "").trim() ||
    config.SOCKET_URL.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  const userAgent =
    (config.USER_AGENT || "").trim() ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
  const deviceId =
    (config.DEVICE_ID || "").trim() ||
    cookieValue(cookie, "device_id") ||
    cookieValue(cookie, "uniqueId") ||
    "5d32faf6-4cf7-48eb-bf1d-4396d02f6106";
  const stopAtRaw = (config.STOP_AT || "").trim();
  const stopAtMs = stopAtRaw ? Date.parse(stopAtRaw) : null;
  const campaignId = (config.CAMPAIGN_ID || "").trim();
  const referer =
    (config.REFERER || "").trim() ||
    (campaignId
      ? `${origin}/en-sg/game/berburu-tiket-murah/campaign/${campaignId}`
      : origin);

  return {
    users,
    multiUser,
    socketAccessToken,
    cookieFromConfig,
    cookie,
    origin,
    userAgent,
    deviceId,
    countryCode: (config.COUNTRY_CODE || "sg").trim(),
    currency: (config.CURRENCY || "IDR").trim(),
    lang: (config.LANG || "en").trim(),
    referer,
    campaignId,
    roomName: (config.ROOM_NAME || "").trim(),
    socketUrl: (config.SOCKET_URL || DEFAULTS.SOCKET_URL).trim(),
    wsPath: (config.WS_PATH || DEFAULTS.WS_PATH).trim(),
    apiBaseUrl: (config.API_BASE_URL || DEFAULTS.API_BASE_URL).trim(),
    apiUrl: `${(config.API_BASE_URL || DEFAULTS.API_BASE_URL).trim()}/${(config.ROOM_NAME || "").trim()}/hit`,
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
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
