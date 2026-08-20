const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const {
  load,
  save,
  normalize,
  validate,
  isReady,
  getConfigPath,
  emptySession,
  findSessionIndex,
} = require("./lib/config");
const { createClient } = require("./lib/client");
const { LogBuffer } = require("./lib/log-buffer");

const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT;

let adminPassword = (process.env.ADMIN_PASSWORD || "").trim();
if (!adminPassword) {
  adminPassword = crypto.randomBytes(8).toString("hex");
  console.log(`ADMIN_PASSWORD not set — generated for this process: ${adminPassword}`);
}

let config = load();
const client = createClient();
const buffer = new LogBuffer();

client.on("log", (entry) => buffer.addLog(entry));
client.on("hit", (entry) => buffer.addHit(entry));
client.on("status", (status) => buffer.emit("status", status));

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    name: "pl.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, running: client.running, connected: client.connected });
});

app.post("/api/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (!password || password !== adminPassword) {
    return res.status(401).json({ error: "Invalid password" });
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.get("/api/status", requireAuth, (_req, res) => {
  res.json({
    ...client.getStatus(),
    configPath: getConfigPath(),
    configReady: isReady(config),
  });
});

app.get("/api/config", requireAuth, (_req, res) => {
  res.json(config);
});

app.put("/api/config", requireAuth, (req, res) => {
  const next = normalize(req.body);
  const errors = validate(next);
  if (errors.length) {
    return res.status(400).json({ error: errors.join("; "), errors });
  }
  config = next;
  let savedTo = null;
  try {
    savedTo = save(config);
  } catch (err) {
    return res.status(500).json({ error: `Failed to save config: ${err.message}` });
  }

  let status = client.getStatus();
  if (client.running) {
    try {
      status = client.restart(config);
    } catch (err) {
      return res.status(400).json({
        error: err.message,
        savedTo,
        config,
        status: client.getStatus(),
      });
    }
  }

  res.json({ ok: true, savedTo, config, status });
});

function startClient() {
  const errors = validate(config, { requireReady: true });
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.statusCode = 400;
    throw err;
  }
  if (client.running) return client.getStatus();
  return client.start(config);
}

app.post("/api/client/start", requireAuth, (_req, res) => {
  try {
    const status = startClient();
    res.json({ ok: true, status });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.post("/api/client/stop", requireAuth, (_req, res) => {
  const status = client.stop("dashboard");
  res.json({ ok: true, status });
});

app.post("/api/client/restart", requireAuth, (_req, res) => {
  try {
    const errors = validate(config, { requireReady: true });
    if (errors.length) {
      return res.status(400).json({ error: errors.join("; ") });
    }
    const status = client.restart(config);
    res.json({ ok: true, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function sessionActionPayload() {
  return {
    ok: true,
    config,
    status: {
      ...client.getStatus(),
      configPath: getConfigPath(),
      configReady: isReady(config),
    },
  };
}

function persistOrFail(res) {
  try {
    save(config);
    return true;
  } catch (err) {
    res.status(500).json({ error: `Failed to save config: ${err.message}` });
    return false;
  }
}

app.post("/api/sessions/:id/listen", requireAuth, (req, res) => {
  const id = String(req.params.id || "").trim();
  const index = findSessionIndex(config, id);
  if (index < 0) {
    return res.status(404).json({ error: `Unknown session: ${id}` });
  }
  config.SESSIONS[index].LISTENING = true;
  if (!persistOrFail(res)) return;
  try {
    if (client.running) client.resumeSession(id);
  } catch (err) {
    return res.status(400).json({
      error: err.message,
      config,
      status: client.getStatus(),
    });
  }
  res.json(sessionActionPayload());
});

app.post("/api/sessions/:id/unlisten", requireAuth, (req, res) => {
  const id = String(req.params.id || "").trim();
  const index = findSessionIndex(config, id);
  if (index < 0) {
    return res.status(404).json({ error: `Unknown session: ${id}` });
  }
  config.SESSIONS[index].LISTENING = false;
  if (!persistOrFail(res)) return;
  if (client.running) client.pauseSession(id);
  res.json(sessionActionPayload());
});

app.delete("/api/sessions/:id", requireAuth, (req, res) => {
  const id = String(req.params.id || "").trim();
  config.SESSIONS = (config.SESSIONS || []).filter(
    (row) => String(row.CAMPAIGN_SESSION_ID || "").trim() !== id
  );
  if (config.SESSIONS.length === 0) config.SESSIONS = [emptySession()];
  if (!persistOrFail(res)) return;
  if (client.running || client.runtime) client.dropSession(id);
  res.json(sessionActionPayload());
});

app.get("/api/hits", requireAuth, (_req, res) => {
  const snap = buffer.snapshot();
  res.json({ connectionLogs: snap.connectionLogs, bySession: snap.bySession });
});

app.get("/api/logs", requireAuth, (_req, res) => {
  const snap = buffer.snapshot();
  res.json({ connectionLogs: snap.connectionLogs, bySession: snap.bySession });
});

app.get("/api/logs/stream", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (type, payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const snap = buffer.snapshot();
  send("snapshot", {
    connectionLogs: snap.connectionLogs,
    bySession: snap.bySession,
    status: {
      ...client.getStatus(),
      configPath: getConfigPath(),
      configReady: isReady(config),
    },
  });

  const onLog = (entry) => send("log", entry);
  const onHit = (entry) => send("hit", entry);
  const onStatus = (status) =>
    send("status", {
      ...status,
      configPath: getConfigPath(),
      configReady: isReady(config),
    });

  buffer.on("log", onLog);
  buffer.on("hit", onHit);
  buffer.on("status", onStatus);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    buffer.off("log", onLog);
    buffer.off("hit", onHit);
    buffer.off("status", onStatus);
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  client.stop(signal);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🕯️ penjaga-lilin dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`   Config file: ${getConfigPath()}`);
  if (isReady(config)) {
    try {
      console.log("⚡ Auto-starting client from saved/env config");
      client.start(config);
    } catch (err) {
      console.error(`❌ Auto-start failed: ${err.message}`);
    }
  } else {
    console.log("⏸️ Config not ready — open the dashboard to set tokens and start");
  }
});
