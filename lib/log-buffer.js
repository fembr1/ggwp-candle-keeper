const { EventEmitter } = require("events");

const JWT_RE = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
const COOKIE_TOKEN_RE = /session_access_token=[^;\s]+/gi;
const CONNECTION_SCOPE = "connection";

function maskSecrets(value) {
  return String(value ?? "")
    .replace(JWT_RE, "eyJ…[token]")
    .replace(COOKIE_TOKEN_RE, "session_access_token=…");
}

function emptyRing() {
  return { logs: [], hits: [] };
}

class LogBuffer extends EventEmitter {
  constructor({ logLimit = 500, hitLimit = 100 } = {}) {
    super();
    this.logLimit = logLimit;
    this.hitLimit = hitLimit;
    this.connection = emptyRing();
    this.bySession = {};
  }

  ensureSession(sessionId) {
    if (!sessionId) return this.connection;
    if (!this.bySession[sessionId]) this.bySession[sessionId] = emptyRing();
    return this.bySession[sessionId];
  }

  addLog(entry) {
    const sessionId = entry.sessionId || null;
    const item = {
      ts: entry.ts || Date.now(),
      level: entry.level || "info",
      message: maskSecrets(entry.message || ""),
      sessionId,
      scope: sessionId ? "session" : CONNECTION_SCOPE,
    };
    const ring = sessionId ? this.ensureSession(sessionId) : this.connection;
    ring.logs.push(item);
    if (ring.logs.length > this.logLimit) ring.logs.shift();
    this.emit("log", item);
    return item;
  }

  addHit(entry) {
    const sessionId = entry.sessionId || "";
    const item = {
      ts: entry.ts || Date.now(),
      sessionId,
      userIndex: entry.userIndex,
      userCount: entry.userCount,
      url: maskSecrets(entry.url || ""),
      status: entry.status ?? null,
      ok: !!entry.ok,
      response: maskSecrets(entry.response || "").slice(0, 500),
      error: entry.error ? maskSecrets(entry.error) : null,
    };
    const ring = this.ensureSession(sessionId);
    ring.hits.push(item);
    if (ring.hits.length > this.hitLimit) ring.hits.shift();
    this.emit("hit", item);
    return item;
  }

  snapshot() {
    const bySession = {};
    for (const [id, ring] of Object.entries(this.bySession)) {
      bySession[id] = { logs: [...ring.logs], hits: [...ring.hits] };
    }
    return {
      connectionLogs: [...this.connection.logs],
      bySession,
    };
  }
}

module.exports = { LogBuffer, maskSecrets, CONNECTION_SCOPE };
