const SHARED_KEYS = ["ACCESS_TOKEN", "SOCKET_URL", "API_BASE_URL"];
const DEFAULT_MAX_MS_DIFF = 1300;
const LOG_LIMIT = 500;
const HIT_LIMIT = 100;

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginPassword = document.getElementById("login-password");
const loginError = document.getElementById("login-error");
const actionError = document.getElementById("action-error");
const saveStatus = document.getElementById("save-status");
const connLogView = document.getElementById("conn-log-view");
const connBadge = document.getElementById("conn-badge");
const sessionsList = document.getElementById("sessions-list");

let connectionLogs = [];
let bySession = {};
let formSessions = [];
let status = null;
let eventSource = null;
let countdownTimer = null;

function emptySession() {
  return {
    CAMPAIGN_SESSION_ID: "",
    MAX_MS_DIFF: DEFAULT_MAX_MS_DIFF,
    STOP_AT: "",
    LISTENING: true,
  };
}

function ringFor(sessionId) {
  const id = String(sessionId || "");
  if (!id) return { logs: [], hits: [] };
  if (!bySession[id]) bySession[id] = { logs: [], hits: [] };
  return bySession[id];
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login" && path !== "/api/me") {
    showLogin();
    throw new Error(data.error || "Unauthorized");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showLogin() {
  closeStream();
  loginView.classList.remove("hidden");
  appView.classList.add("hidden");
}

function showApp() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
}

function setActionError(message) {
  if (!message) {
    actionError.hidden = true;
    actionError.textContent = "";
    return;
  }
  actionError.hidden = false;
  actionError.textContent = message;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}

function fmtCountdown(stopAtMs) {
  if (!stopAtMs) return "—";
  const diff = stopAtMs - Date.now();
  if (diff <= 0) return "reached";
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function setBadge(current) {
  connBadge.className = "badge";
  if (current?.connected) {
    connBadge.classList.add("badge-ok");
    connBadge.textContent = "Connected";
  } else if (current?.running) {
    connBadge.classList.add("badge-run");
    connBadge.textContent = "Connecting";
  } else if (current?.lastError) {
    connBadge.classList.add("badge-err");
    connBadge.textContent = "Error";
  } else {
    connBadge.classList.add("badge-idle");
    connBadge.textContent = "Idle";
  }
}

function runtimeFor(sessionId) {
  const id = String(sessionId || "");
  if (!id || !status?.sessions) return null;
  return status.sessions.find((s) => s.id === id) || null;
}

function sessionStateLabel(rt) {
  if (!status?.running) return "idle";
  if (!rt) return "not joined";
  if (rt.stopped) return "hard-stopped";
  if (rt.listening === false) return "paused";
  return "live";
}

function isSessionLive(rt) {
  return !!(status?.running && rt && rt.listening !== false && !rt.stopped);
}

function updateListenButtons(card, id, rt) {
  const listenBtn = card.querySelector("[data-action='listen']");
  const stopBtn = card.querySelector("[data-action='unlisten']");
  const hasId = !!id;
  const running = !!status?.running;
  const live = isSessionLive(rt);
  if (listenBtn) listenBtn.disabled = !hasId || !running || live;
  if (stopBtn) stopBtn.disabled = !hasId || !running || !live;
}

function renderStatus(next) {
  status = next;
  setBadge(next);
  const reason = next.stopReason && !next.running ? ` · ${next.stopReason}` : "";
  document.getElementById("st-running").textContent = next.running
    ? next.connected
      ? "Running · connected"
      : "Running · disconnected"
    : `Stopped${reason}`;
  document.getElementById("st-socket").textContent = next.socketId || "—";
  document.getElementById("st-error").textContent = next.lastError || "—";
  document.getElementById("st-users").textContent = next.userCount
    ? `${next.userCount}${next.multiUser ? " · round-robin" : ""}`
    : "—";
  updateSessionRuntimes();
}

function updateSessionRuntimes() {
  for (const card of sessionsList.querySelectorAll(".session-card")) {
    const id = (formSessions[Number(card.dataset.index)]?.CAMPAIGN_SESSION_ID || "").trim();
    const rt = runtimeFor(id);
    const stateEl = card.querySelector("[data-role='state']");
    const stopEl = card.querySelector("[data-role='stop']");
    const countdownEl = card.querySelector("[data-role='countdown']");
    const diffEl = card.querySelector("[data-role='last-diff']");
    if (stateEl) stateEl.textContent = sessionStateLabel(rt);
    if (stopEl) {
      stopEl.textContent = rt?.stopAt
        ? fmtTime(rt.stopAtMs || Date.parse(rt.stopAt))
        : "(not set)";
    }
    if (countdownEl) countdownEl.textContent = fmtCountdown(rt?.stopAtMs);
    if (diffEl) {
      diffEl.textContent = rt?.lastTimeDiff != null ? `${rt.lastTimeDiff} ms` : "—";
    }
    updateListenButtons(card, id, rt);
  }
}

function updateCountdown() {
  updateSessionRuntimes();
}

function logHtml(lines) {
  return lines
    .map((line) => {
      const cls =
        line.level === "error"
          ? "log-error"
          : line.level === "warn"
            ? "log-warn"
            : "";
      return `<span class="${cls}">${escapeHtml(
        `[${new Date(line.ts).toLocaleTimeString()}] ${line.message}`
      )}</span>`;
    })
    .join("\n");
}

function renderConnectionLogs() {
  connLogView.innerHTML = logHtml(connectionLogs);
  connLogView.scrollTop = connLogView.scrollHeight;
}

function renderSessionLogs(sessionId) {
  const id = String(sessionId || "");
  if (!id) return;
  const el = sessionsList.querySelector(`.log-view[data-session-id="${cssEscape(id)}"]`);
  if (!el) return;
  el.innerHTML = logHtml(ringFor(id).logs);
  el.scrollTop = el.scrollHeight;
}

function renderSessionHits(sessionId) {
  const id = String(sessionId || "");
  const body = sessionsList.querySelector(`tbody[data-session-id="${cssEscape(id)}"]`);
  if (!body) return;
  const hits = id ? ringFor(id).hits : [];
  if (!hits.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">No hits yet</td></tr>`;
    return;
  }
  const rows = [...hits].reverse().slice(0, 50);
  body.innerHTML = rows
    .map((hit) => {
      const result = hit.ok
        ? hit.response || "ok"
        : hit.error || hit.response || "failed";
      return `<tr>
        <td>${fmtTime(hit.ts)}</td>
        <td>${hit.userIndex + 1}/${hit.userCount}</td>
        <td>${hit.status ?? "—"}</td>
        <td>${escapeHtml(result)}</td>
      </tr>`;
    })
    .join("");
}

function renderAllSessionPanes() {
  for (const session of formSessions) {
    const id = String(session.CAMPAIGN_SESSION_ID || "").trim();
    if (!id) continue;
    renderSessionLogs(id);
    renderSessionHits(id);
  }
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sessionCardHtml(session, index) {
  const id = String(session.CAMPAIGN_SESSION_ID || "").trim();
  const rt = runtimeFor(id);
  const attrId = escapeHtml(id);
  return `<article class="card session-card" data-index="${index}">
    <div class="session-card-head">
      <h2>Session ${index + 1}</h2>
      <div class="btn-row">
        <button type="button" class="small" data-action="listen" ${
          !id || !status?.running || isSessionLive(rt) ? "disabled" : ""
        }>Listen</button>
        <button type="button" class="ghost small" data-action="unlisten" ${
          !id || !status?.running || !isSessionLive(rt) ? "disabled" : ""
        }>Stop</button>
        <button type="button" class="ghost small" data-action="remove">Remove</button>
      </div>
    </div>
    <div class="form-grid">
      <label class="wide">
        CAMPAIGN_SESSION_ID
        <input data-field="CAMPAIGN_SESSION_ID" type="text" value="${escapeHtml(
          session.CAMPAIGN_SESSION_ID || ""
        )}" />
      </label>
      <label>
        MAX_MS_DIFF
        <input data-field="MAX_MS_DIFF" type="number" min="1" value="${escapeHtml(
          session.MAX_MS_DIFF ?? DEFAULT_MAX_MS_DIFF
        )}" />
      </label>
      <label>
        STOP_AT
        <input data-field="STOP_AT" type="text" placeholder="2026-08-12T18:00:00+07:00" value="${escapeHtml(
          session.STOP_AT || ""
        )}" />
      </label>
    </div>
    <dl class="session-runtime">
      <div><dt>State</dt><dd data-role="state">${escapeHtml(sessionStateLabel(rt))}</dd></div>
      <div><dt>Hard stop</dt><dd data-role="stop">${
        rt?.stopAt ? escapeHtml(fmtTime(rt.stopAtMs || Date.parse(rt.stopAt))) : "(not set)"
      }</dd></div>
      <div><dt>Countdown</dt><dd data-role="countdown">${escapeHtml(
        fmtCountdown(rt?.stopAtMs)
      )}</dd></div>
      <div><dt>Last diff</dt><dd data-role="last-diff">${
        rt?.lastTimeDiff != null ? `${rt.lastTimeDiff} ms` : "—"
      }</dd></div>
    </dl>
    <div class="logs-head">
      <h2>Live log</h2>
      <button type="button" class="ghost small" data-action="clear-logs">Clear view</button>
    </div>
    <pre class="log-view compact" data-session-id="${attrId}"></pre>
    <h2 class="hits-title">Hit history</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Status</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody data-session-id="${attrId}">
          <tr><td colspan="4" class="muted">No hits yet</td></tr>
        </tbody>
      </table>
    </div>
  </article>`;
}

function renderSessionCards() {
  if (!formSessions.length) formSessions = [emptySession()];
  sessionsList.innerHTML = formSessions
    .map((session, index) => sessionCardHtml(session, index))
    .join("");
  renderAllSessionPanes();
}

function fillConfig(cfg) {
  for (const key of SHARED_KEYS) {
    const el = document.getElementById(`cfg-${key}`);
    if (el) el.value = cfg[key] ?? "";
  }
  const rows = Array.isArray(cfg.SESSIONS) && cfg.SESSIONS.length ? cfg.SESSIONS : [emptySession()];
  formSessions = rows.map((row) => ({
    CAMPAIGN_SESSION_ID: row.CAMPAIGN_SESSION_ID || "",
    MAX_MS_DIFF: row.MAX_MS_DIFF ?? DEFAULT_MAX_MS_DIFF,
    STOP_AT: row.STOP_AT || "",
    LISTENING: row.LISTENING !== false,
  }));
  renderSessionCards();
}

function readConfig() {
  const body = {};
  for (const key of SHARED_KEYS) {
    const el = document.getElementById(`cfg-${key}`);
    body[key] = el ? el.value : "";
  }
  body.SESSIONS = formSessions.map((row) => ({
    CAMPAIGN_SESSION_ID: String(row.CAMPAIGN_SESSION_ID || "").trim(),
    MAX_MS_DIFF: Number(row.MAX_MS_DIFF) || DEFAULT_MAX_MS_DIFF,
    STOP_AT: String(row.STOP_AT || "").trim(),
    LISTENING: row.LISTENING !== false,
  }));
  return body;
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function applySnapshot(data) {
  connectionLogs = data.connectionLogs || [];
  bySession = data.bySession || {};
  if (data.status) renderStatus(data.status);
  renderConnectionLogs();
  renderAllSessionPanes();
}

function openStream() {
  closeStream();
  eventSource = new EventSource("/api/logs/stream");
  eventSource.addEventListener("snapshot", (ev) => {
    applySnapshot(JSON.parse(ev.data));
  });
  eventSource.addEventListener("log", (ev) => {
    const entry = JSON.parse(ev.data);
    if (entry.sessionId) {
      const ring = ringFor(entry.sessionId);
      ring.logs.push(entry);
      if (ring.logs.length > LOG_LIMIT) ring.logs = ring.logs.slice(-LOG_LIMIT);
      renderSessionLogs(entry.sessionId);
    } else {
      connectionLogs.push(entry);
      if (connectionLogs.length > LOG_LIMIT) {
        connectionLogs = connectionLogs.slice(-LOG_LIMIT);
      }
      renderConnectionLogs();
    }
  });
  eventSource.addEventListener("hit", (ev) => {
    const entry = JSON.parse(ev.data);
    const ring = ringFor(entry.sessionId);
    ring.hits.push(entry);
    if (ring.hits.length > HIT_LIMIT) ring.hits = ring.hits.slice(-HIT_LIMIT);
    renderSessionHits(entry.sessionId);
  });
  eventSource.addEventListener("status", (ev) => {
    renderStatus(JSON.parse(ev.data));
  });
  eventSource.onerror = () => {
    // browser will retry; if we lost the session, next API call will bounce to login
  };
}

async function bootApp() {
  showApp();
  const [cfg, st] = await Promise.all([api("/api/config"), api("/api/status")]);
  fillConfig(cfg);
  renderStatus(st);
  openStream();
  if (!countdownTimer) {
    countdownTimer = setInterval(updateCountdown, 1000);
  }
}

sessionsList.addEventListener("input", (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const card = e.target.closest(".session-card");
  const index = Number(card?.dataset.index);
  if (!Number.isInteger(index) || !formSessions[index]) return;
  const value = e.target.value;
  formSessions[index][field] = field === "MAX_MS_DIFF" ? Number(value) : value;
  if (field === "CAMPAIGN_SESSION_ID") {
    const id = String(value || "").trim();
    card.querySelectorAll("[data-session-id]").forEach((el) => {
      el.dataset.sessionId = id;
    });
    renderSessionLogs(id);
    renderSessionHits(id);
    updateSessionRuntimes();
  }
});

sessionsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest(".session-card");
  const index = Number(card?.dataset.index);
  const action = btn.dataset.action;
  const id = (formSessions[index]?.CAMPAIGN_SESSION_ID || "").trim();

  if (action === "clear-logs") {
    if (id) ringFor(id).logs = [];
    renderSessionLogs(id);
    return;
  }

  if (action === "remove") {
    if (!id) {
      formSessions.splice(index, 1);
      if (!formSessions.length) formSessions.push(emptySession());
      renderSessionCards();
      return;
    }
    setActionError("");
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      fillConfig(data.config);
      if (data.status) renderStatus(data.status);
    } catch (err) {
      setActionError(err.message);
    }
    return;
  }

  if (action === "listen" || action === "unlisten") {
    if (!id) return;
    setActionError("");
    try {
      const data = await api(
        `/api/sessions/${encodeURIComponent(id)}/${action}`,
        { method: "POST" }
      );
      if (data.config) {
        const row = (data.config.SESSIONS || []).find(
          (s) => String(s.CAMPAIGN_SESSION_ID || "").trim() === id
        );
        if (row && formSessions[index]) {
          formSessions[index].LISTENING = row.LISTENING !== false;
        }
      }
      if (data.status) renderStatus(data.status);
    } catch (err) {
      setActionError(err.message);
    }
  }
});

document.getElementById("btn-add-session").addEventListener("click", () => {
  formSessions.push(emptySession());
  renderSessionCards();
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: loginPassword.value }),
    });
    loginPassword.value = "";
    await bootApp();
  } catch (err) {
    loginError.hidden = false;
    loginError.textContent = err.message;
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

async function runAction(path) {
  setActionError("");
  try {
    const data = await api(path, { method: "POST" });
    if (data.status) renderStatus(data.status);
  } catch (err) {
    setActionError(err.message);
  }
}

document.getElementById("btn-start").addEventListener("click", () => {
  runAction("/api/client/start");
});
document.getElementById("btn-stop").addEventListener("click", () => {
  runAction("/api/client/stop");
});
document.getElementById("btn-restart").addEventListener("click", () => {
  runAction("/api/client/restart");
});

document.getElementById("config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  saveStatus.textContent = "Saving…";
  setActionError("");
  try {
    const data = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify(readConfig()),
    });
    fillConfig(data.config);
    if (data.status) renderStatus(data.status);
    saveStatus.textContent = data.savedTo ? `Saved to ${data.savedTo}` : "Saved";
  } catch (err) {
    saveStatus.textContent = "";
    setActionError(err.message);
  }
});

document.getElementById("btn-clear-conn-logs").addEventListener("click", () => {
  connectionLogs = [];
  renderConnectionLogs();
});

(async function init() {
  try {
    const me = await api("/api/me");
    if (me.authenticated) await bootApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
