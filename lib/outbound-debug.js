const dns = require("dns").promises;
const https = require("https");
const http = require("http");
const { URL } = require("url");

const INTERESTING_HEADERS = [
  "cf-ray",
  "cf-mitigated",
  "cf-cache-status",
  "cf-connecting-ip",
  "server",
  "location",
  "content-type",
  "retry-after",
  "www-authenticate",
  "x-request-id",
  "x-error-code",
  "x-envoy-upstream-service-time",
];

function pickHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      INTERESTING_HEADERS.includes(lower) ||
      lower.startsWith("cf-") ||
      lower.startsWith("x-")
    ) {
      out[lower] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

function sanitizeBody(body) {
  const text = String(body || "")
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[token]")
    .replace(/session_access_token=[^;\s]+/gi, "session_access_token=[redacted]")
    .replace(/cf_clearance=[^;\s]+/gi, "cf_clearance=[redacted]");
  const title = text.match(/<title[^>]*>([^<]+)<\/title>/i);
  return {
    title: title ? title[1].trim() : null,
    looksLikeCloudflareChallenge:
      /cf-mitigated|cloudflare|just a moment|attention required/i.test(text),
    preview: text.replace(/\s+/g, " ").trim().slice(0, 280),
  };
}

function httpsUrlFromSocket(socketUrl) {
  return String(socketUrl || "")
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/$/, "");
}

function engineIoPollingUrl(socketUrl, wsPath) {
  const base = httpsUrlFromSocket(socketUrl);
  let path = wsPath || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.endsWith("/")) path += "/";
  return `${base}${path}?EIO=4&transport=polling`;
}

function summarizeSocketError(error) {
  if (!error) return { message: "(no error object)" };
  const desc = error.description;
  const descHeaders =
    desc && typeof desc === "object"
      ? pickHeaders(desc.headers || desc._headers)
      : {};
  return {
    name: error.name || null,
    message: error.message || String(error),
    type: error.type || null,
    code: error.code || null,
    description:
      desc && typeof desc === "object"
        ? desc.message || desc.statusMessage || String(desc)
        : desc
          ? String(desc)
          : null,
    httpStatus: desc?.statusCode || desc?.status || null,
    httpHeaders: descHeaders,
    context: error.context ? String(error.context).slice(0, 240) : null,
  };
}

function railwayMeta() {
  const keys = [
    "RAILWAY_ENVIRONMENT_NAME",
    "RAILWAY_SERVICE_NAME",
    "RAILWAY_REPLICA_ID",
    "RAILWAY_PRIVATE_IP",
    "RAILWAY_PUBLIC_DOMAIN",
    "RAILWAY_REGION",
    "RAILWAY_DEPLOYMENT_ID",
    "RAILWAY_PROJECT_NAME",
  ];
  const out = {};
  for (const key of keys) {
    if (process.env[key]) out[key] = process.env[key];
  }
  return out;
}

async function resolveHost(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true });
    return records.map((r) => `${r.address} (${r.family === 6 ? "AAAA" : "A"})`);
  } catch (err) {
    return [`lookup failed: ${err.code || err.message}`];
  }
}

function probeGet(url, headers) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({ error: `invalid url: ${err.message}` });
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers,
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          if (size < 4096) {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || "",
            headers: pickHeaders(res.headers),
            body: sanitizeBody(Buffer.concat(chunks).toString("utf8")),
          });
        });
      }
    );
    req.on("error", (err) => {
      resolve({
        error: err.message,
        code: err.code || null,
        syscall: err.syscall || null,
        address: err.address || null,
        port: err.port || null,
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout after 10s" });
    });
    req.end();
  });
}

async function diagnoseOutbound({
  socketUrl,
  wsPath,
  origin,
  userAgent,
  acceptLanguage,
  cookiePresent,
  requestHeaderNames,
  socketError,
}) {
  let hostname = "";
  try {
    hostname = new URL(httpsUrlFromSocket(socketUrl)).hostname;
  } catch {
    hostname = socketUrl;
  }

  const probeUrl = engineIoPollingUrl(socketUrl, wsPath);
  const probeHeaders = {
    Origin: origin,
    "User-Agent": userAgent,
    "Accept-Language": acceptLanguage || "en",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  const [resolved, probe] = await Promise.all([
    resolveHost(hostname),
    probeGet(probeUrl, probeHeaders),
  ]);

  const cfMitigated =
    probe?.headers?.["cf-mitigated"] ||
    socketError?.httpHeaders?.["cf-mitigated"] ||
    null;

  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    target: {
      socketUrl,
      wsPath,
      origin,
      hostname,
      resolved,
      engineIoPollingUrl: probeUrl,
    },
    client: {
      cookieHeaderPresent: !!cookiePresent,
      requestHeaderNames: requestHeaderNames || [],
      userAgent: userAgent || "",
    },
    socketError: summarizeSocketError(socketError),
    httpProbe: probe,
    railway: railwayMeta(),
    interpretation: interpret(probe, cfMitigated, socketError),
  };
}

function interpret(probe, cfMitigated, socketError) {
  const status = probe?.status;
  const mitigated = String(cfMitigated || probe?.headers?.["cf-mitigated"] || "");
  const msg = String(socketError?.message || socketError?.description || "");
  if (status === 403 || msg.includes("403")) {
    if (/challenge/i.test(mitigated) || probe?.body?.looksLikeCloudflareChallenge) {
      return [
        "Cloudflare returned 403 with a bot/JS challenge (cf-mitigated=challenge).",
        "IP Allow does not always skip Bot Fight / Super Bot Fight / Bot Management.",
        "In Cloudflare Security Events, search this timestamp and cf-ray; confirm the action is Allow vs Challenge.",
        "If using Railway Static Outbound IPs, allowlist ALL assigned IPv4s (traffic is load-balanced) and redeploy after enabling them.",
      ].join(" ");
    }
    return "HTTP/WS 403. Check Cloudflare Security Events for this cf-ray and whether WAF or Bot Management issued the block.";
  }
  if (probe?.error) {
    return `HTTP probe failed (${probe.error}). Outbound TCP/TLS from this replica may be broken; compare with Railway network flows.`;
  }
  return "WebSocket connect failed; see socketError and httpProbe for status/headers.";
}

function formatReport(diag) {
  const lines = [
    "===== OUTBOUND FAILURE (copy this block for DevOps) =====",
    JSON.stringify(diag, null, 2),
    "===== END OUTBOUND FAILURE =====",
  ];
  return lines.join("\n");
}

module.exports = {
  diagnoseOutbound,
  formatReport,
  pickHeaders,
  summarizeSocketError,
};
