// content.js — lightweight UI bridge for background poller

console.log("%c[Relay] Content bridge loaded", "color:#10b981;font-weight:bold");

// Inject inpage.js to sniff CSRF tokens directly from the page
(function injectInpage() {
  try {
    const url = chrome.runtime.getURL("inpage.js");
    const inject = () => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      (document.head || document.documentElement).appendChild(script);
      script.addEventListener("load", () => script.remove(), { once: true });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
    } else {
      inject();
    }
  } catch (error) {
    console.warn("[Relay] Failed to inject inpage bridge:", error);
  }
})();

function enableSaveDataHint() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return;
  try {
    connection.saveData = true;
  } catch { }
  try {
    Object.defineProperty(connection, "saveData", {
      configurable: true,
      get: () => true
    });
  } catch { }
}
enableSaveDataHint();

// Forward CSRF tokens from the page to the background worker
let latestCsrf = null;
window.addEventListener("message", async (event) => {
  // Security: Validate origin
  if (event.origin !== window.location.origin) return;

  const payload = event?.data;
  if (!payload) return;

  // Handle Puppeteer poll request
  if (payload.type === "RELAY_POLL_NOW") {
    try {
      // Ask background to perform a single poll
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ target: "bg", type: "POLL_ONCE", settings: payload.settings }, resolve);
      });

      if (response && response.ok) {
        window.postMessage({ type: "RELAY_POLL_RESULT", loads: response.workOpportunities || [], duration: response.duration }, "*");
      } else {
        window.postMessage({ type: "RELAY_POLL_RESULT", ok: false, error: response?.error || "Unknown poll error" }, "*");
      }
    } catch (e) {
      window.postMessage({ type: "RELAY_POLL_RESULT", ok: false, error: e.message }, "*");
    }
    return;
  }

  if (payload.__relayAuto__ !== true) return;
  if (payload.type === "CSRF" && payload.token) {
    latestCsrf = payload.token;
    chrome.runtime.sendMessage({ target: "bg", type: "SET_CSRF", token: payload.token, source: payload.source || "page" });
  }
});

// Consolidated message listener
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "content") return;

  switch (msg.type) {
    case "REQUEST_CSRF":
      sendResponse({ token: latestCsrf });
      return true;
    case "POLL_STATUS":
      applyStatus(msg.payload);
      return;
    case "POLL_RESULTS":
      handleResults(msg.payload);
      return;
    case "POLL_BOOKED":
      handleBooking(msg.payload);
      return;
    case "POLL_ERROR":
      overlay.status("error");
      overlay.log(msg.payload?.message || "poll error");
      return;
    case "POLL_HEARTBEAT":
      overlay.status("running");
      overlay.metrics(summarizeMetrics(msg.payload?.metrics));
      if (msg.payload?.metrics) {
        overlay.log(
          `avg search ${avgTime(msg.payload.metrics.searchLatency)}ms · avg parse ${avgTime(msg.payload.metrics.parseLatency)}ms`
        );
      }
      return;
    case "RUN_SEARCH":
      runSearchFromPage(msg.payload, msg.csrf)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    case "RUN_BOOK":
      runBookingFromPage(msg.path, msg.body, msg.csrf)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    default:
      return;
  }
});

// Overlay UI helpers --------------------------------------------------------
const overlay = (() => {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:2147483647",
    "background:rgba(17,24,39,.94)",
    "color:#fff",
    "font:12px system-ui,sans-serif",
    "padding:10px 12px",
    "border-radius:12px",
    "box-shadow:0 8px 32px rgba(0,0,0,.35)",
    "min-width:280px"
  ].join(";");

  // Safe DOM construction instead of innerHTML
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px";

  const title = document.createElement("strong");
  title.textContent = "Relay Auto ⚡";

  const badge = document.createElement("span");
  badge.id = "relayBadge";
  badge.style.cssText = "margin-left:auto;background:#1f2937;padding:2px 8px;border-radius:999px";
  badge.textContent = "idle";

  header.appendChild(title);
  header.appendChild(badge);

  const stat = document.createElement("div");
  stat.id = "relayStat";
  stat.style.cssText = "max-width:40ch;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  stat.textContent = "background ready";

  const metrics = document.createElement("div");
  metrics.id = "relayMetrics";
  metrics.style.cssText = "font-size:10px;opacity:.7;margin-top:4px";
  metrics.textContent = "---";

  el.appendChild(header);
  el.appendChild(stat);
  el.appendChild(metrics);

  const init = () => document.body && document.body.appendChild(el);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  return {
    status: (text) => {
      if (badge) badge.textContent = text;
    },
    log: (text) => {
      if (stat) stat.textContent = text;
    },
    metrics: (text) => {
      if (metrics) metrics.textContent = text;
    }
  };
})();

registerWithBackground();

function sendBgCommand(type, extra = {}) {
  chrome.runtime.sendMessage({ target: "bg", type, ...extra }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[Relay] command failed:", chrome.runtime.lastError.message);
    }
  });
}

// Keyboard shortcuts for power users
window.addEventListener("keydown", (event) => {
  if (!event.altKey) return;
  const key = event.key?.toLowerCase();
  if (key === "r") {
    sendBgCommand("POLL_START");
  }
  if (key === "s") {
    sendBgCommand("POLL_STOP");
    overlay.status("stopped");
  }
});

async function runSearchFromPage(payload, csrf) {
  const headers = { "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  headers["save-data"] = "on";

  const start = performance.now();
  const response = await fetch("/api/loadboard/search", {
    method: "POST",
    credentials: "include",
    headers,
    body: payload,
    cache: "no-store",
    keepalive: true,
    priority: "high",
    fetchPriority: "high"
  });
  const duration = performance.now() - start;
  const text = await response.text();
  const empty = text.includes('"workOpportunities":[]');

  if (!response.ok) {
    return {
      error: text.slice(0, 200),
      status: response.status,
      retryAfter: response.headers.get("retry-after")
    };
  }

  const parseStart = performance.now();
  const parsed = JSON.parse(text || "{}");
  const parseDuration = performance.now() - parseStart;
  return {
    workOpportunities: parsed.workOpportunities || [],
    duration,
    parseDuration
  };
}

async function runBookingFromPage(path, body, csrf) {
  const headers = { "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;

  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
    keepalive: true
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: text.slice(0, 120) };
  }

  const json = await response.json().catch(() => ({}));
  return { ok: true, body: json };
}
