const CONFIG_KEYS = [
  "ACCESS_TOKEN",
  "ROOM_NAME",
  "CAMPAIGN_ID",
  "MAX_MS_DIFF",
  "STOP_AT",
  "COOKIE",
  "SOCKET_URL",
  "WS_PATH",
  "API_BASE_URL",
  "ORIGIN",
  "USER_AGENT",
  "DEVICE_ID",
  "COUNTRY_CODE",
  "CURRENCY",
  "LANG",
  "REFERER",
];

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginPassword = document.getElementById("login-password");
const loginError = document.getElementById("login-error");
const actionError = document.getElementById("action-error");
const saveStatus = document.getElementById("save-status");
const hitsBody = document.getElementById("hits-body");
const logView = document.getElementById("log-view");
const connBadge = document.getElementById("conn-badge");

let hits = [];
let logs = [];
let status = null;
let eventSource = null;
let countdownTimer = null;

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

function renderStatus(next) {
  status = next;
  setBadge(next);
  document.getElementById("st-running").textContent = next.running
    ? next.connected
      ? "Running · connected"
      : "Running · disconnected"
    : "Stopped";
  document.getElementById("st-socket").textContent = next.socketId || "—";
  document.getElementById("st-error").textContent = next.lastError || "—";
  document.getElementById("st-room").textContent = next.roomName || "—";
  document.getElementById("st-campaign").textContent = next.campaignId || "—";
  document.getElementById("st-users").textContent = next.userCount
    ? `${next.userCount}${next.multiUser ? " · round-robin" : ""}`
    : "—";
  document.getElementById("st-diff").textContent =
    next.maxMsDiff != null ? `${next.maxMsDiff} ms` : "—";
  document.getElementById("st-stop").textContent = next.stopAt
    ? fmtTime(next.stopAtMs || Date.parse(next.stopAt))
    : "(not set)";
  updateCountdown();
}

function updateCountdown() {
  const el = document.getElementById("st-countdown");
  if (!status?.stopAtMs) {
    el.textContent = "—";
    return;
  }
  const diff = status.stopAtMs - Date.now();
  if (diff <= 0) {
    el.textContent = "reached";
    return;
  }
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  el.textContent = `${h}h ${m}m ${sec}s`;
}

function renderHits() {
  if (!hits.length) {
    hitsBody.innerHTML = `<tr><td colspan="4" class="muted">No hits yet</td></tr>`;
    return;
  }
  const rows = [...hits].reverse().slice(0, 50);
  hitsBody.innerHTML = rows
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

function renderLogs() {
  logView.innerHTML = logs
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
  logView.scrollTop = logView.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fillConfig(cfg) {
  for (const key of CONFIG_KEYS) {
    const el = document.getElementById(`cfg-${key}`);
    if (!el) continue;
    el.value = cfg[key] ?? "";
  }
}

function readConfig() {
  const body = {};
  for (const key of CONFIG_KEYS) {
    const el = document.getElementById(`cfg-${key}`);
    body[key] = el ? el.value : "";
  }
  if (body.MAX_MS_DIFF !== "") body.MAX_MS_DIFF = Number(body.MAX_MS_DIFF);
  return body;
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function openStream() {
  closeStream();
  eventSource = new EventSource("/api/logs/stream");
  eventSource.addEventListener("snapshot", (ev) => {
    const data = JSON.parse(ev.data);
    logs = data.logs || [];
    hits = data.hits || [];
    if (data.status) renderStatus(data.status);
    renderLogs();
    renderHits();
  });
  eventSource.addEventListener("log", (ev) => {
    logs.push(JSON.parse(ev.data));
    if (logs.length > 500) logs = logs.slice(-500);
    renderLogs();
  });
  eventSource.addEventListener("hit", (ev) => {
    hits.push(JSON.parse(ev.data));
    if (hits.length > 100) hits = hits.slice(-100);
    renderHits();
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

document.getElementById("btn-clear-logs").addEventListener("click", () => {
  logs = [];
  renderLogs();
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
