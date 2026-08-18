const { EventEmitter } = require("events");

const JWT_RE = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
const COOKIE_TOKEN_RE = /session_access_token=[^;\s]+/gi;

function maskSecrets(value) {
  return String(value ?? "")
    .replace(JWT_RE, "eyJ…[token]")
    .replace(COOKIE_TOKEN_RE, "session_access_token=…");
}

class LogBuffer extends EventEmitter {
  constructor({ logLimit = 500, hitLimit = 100 } = {}) {
    super();
    this.logLimit = logLimit;
    this.hitLimit = hitLimit;
    this.logs = [];
    this.hits = [];
  }

  addLog(entry) {
    const item = {
      ts: entry.ts || Date.now(),
      level: entry.level || "info",
      message: maskSecrets(entry.message || ""),
    };
    this.logs.push(item);
    if (this.logs.length > this.logLimit) this.logs.shift();
    this.emit("log", item);
    return item;
  }

  addHit(entry) {
    const item = {
      ts: entry.ts || Date.now(),
      userIndex: entry.userIndex,
      userCount: entry.userCount,
      url: maskSecrets(entry.url || ""),
      status: entry.status ?? null,
      ok: !!entry.ok,
      response: maskSecrets(entry.response || "").slice(0, 500),
      error: entry.error ? maskSecrets(entry.error) : null,
    };
    this.hits.push(item);
    if (this.hits.length > this.hitLimit) this.hits.shift();
    this.emit("hit", item);
    return item;
  }

  snapshot() {
    return { logs: [...this.logs], hits: [...this.hits] };
  }
}

module.exports = { LogBuffer, maskSecrets };
