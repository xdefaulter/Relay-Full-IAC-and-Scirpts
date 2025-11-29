console.log("%c[Hiring] Content bridge loaded", "color:#2563eb;font-weight:bold");

(function injectInpage() {
  try {
    const url = chrome.runtime.getURL("inpage.js");
    const apply = () => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      (document.head || document.documentElement).appendChild(script);
      script.addEventListener("load", () => script.remove(), { once: true });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    } else {
      apply();
    }
  } catch (error) {
    console.warn("[Hiring] failed to inject inpage hook", error);
  }
})();

let latestAuth = null;
const pendingRequests = new Map();
let nextRequestId = 1;
const SNAPSHOT_MAX_CHARS = 500000;
const SNAPSHOT_LIMIT = 3;

window.addEventListener("message", (event) => {
  const payload = event?.data;
  if (!payload) return;

  if (payload.__hiringAuto__ === true && payload.type === "AUTH" && payload.token) {
    latestAuth = payload.token;
    chrome.runtime.sendMessage({ target: "bg", type: "SET_AUTH", token: payload.token });
    return;
  }

  if (payload.__hiringAutoResponse__ === true && payload.requestId != null) {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending) return;
    pendingRequests.delete(payload.requestId);
    clearTimeout(pending.timeout);
    if (payload.ok) {
      pending.resolve({ ok: true, data: safeJsonParse(payload.body || "{}"), status: payload.status });
    } else {
      pending.reject(new Error(payload.error || "request failed"));
    }
  }
});

const overlay = (() => {
  const node = document.createElement("div");
  node.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "background:rgba(15,23,42,.92)",
    "color:#fff",
    "font:12px system-ui,sans-serif",
    "padding:12px",
    "border-radius:14px",
    "box-shadow:0 8px 30px rgba(15,23,42,.4)",
    "min-width:260px"
  ].join(";");
  node.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <strong>Hiring Auto</strong>
      <span id="hiringBadge" style="margin-left:auto;background:#0f172a;border-radius:999px;padding:2px 10px">idle</span>
    </div>
    <div id="hiringLog" style="opacity:.85;margin-bottom:4px">waiting for background…</div>
    <div id="hiringMetrics" style="font-size:10px;opacity:.7;margin-bottom:6px">—</div>
    <div id="hiringPrompt" style="display:none;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:8px;margin-bottom:6px;background:rgba(147,197,253,.15);font-size:11px;"></div>
    <div id="hiringJobsWrapper" style="max-height:180px;overflow:auto;border-top:1px solid rgba(255,255,255,.08);padding-top:6px">
      <ul id="hiringJobs" style="list-style:none;padding:0;margin:0;font-size:11px;display:flex;flex-direction:column;gap:6px">
        <li style="opacity:.7">no jobs yet</li>
      </ul>
    </div>
  `;
  const init = () => document.body && document.body.appendChild(node);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  return {
    status(text) {
      const badge = node.querySelector("#hiringBadge");
      if (badge) badge.textContent = text;
    },
    log(text) {
      const el = node.querySelector("#hiringLog");
      if (el) el.textContent = text;
    },
    metrics(text) {
      const el = node.querySelector("#hiringMetrics");
      if (el) el.textContent = text;
    },
    jobs(list) {
      const el = node.querySelector("#hiringJobs");
      if (!el) return;
      if (!list || !list.length) {
        el.innerHTML = `<li style="opacity:.7">no matching jobs</li>`;
        return;
      }
      el.innerHTML = list
        .slice(0, 5)
        .map((job) => renderJob(job))
        .join("");
    }
    ,
    prompt(jobs) {
      const prompt = node.querySelector("#hiringPrompt");
      if (!prompt) return;
      if (!jobs || !jobs.length) {
        prompt.style.display = "none";
        prompt.textContent = "";
        return;
      }
      const lines = jobs
        .slice(0, 2)
        .map(
          (job) =>
            `${escapeHtml(job.jobTitle || "Job")} — ${escapeHtml(job.locationName || job.city || "Unknown location")}`
        )
        .join("<br>");
      prompt.innerHTML = `<div style="font-weight:600;margin-bottom:4px;">🎯 New job${jobs.length > 1 ? "s" : ""} found</div>${lines}`;
      prompt.style.display = "block";
      setTimeout(() => {
        prompt.style.display = "none";
      }, 7000);
    }
  };
})();

function summarizeMetrics(metrics = {}) {
  return `polls:${metrics.polls || 0} · jobs:${metrics.jobsFound || 0} · qualified:${metrics.qualified || 0}`;
}

function renderJob(job = {}) {
  const payMin = formatMoney(job.totalPayRateMin, job.currencyCode);
  const payMax = formatMoney(job.totalPayRateMax, job.currencyCode);
  const payText = payMin && payMax ? `${payMin} - ${payMax}` : payMin || payMax || "—";
  const distance = job.distance ? `${Number(job.distance).toFixed(1)}km` : "";
  const location = [job.locationName || job.city, job.state].filter(Boolean).join(", ");
  return `
    <li style="border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:6px 8px;background:rgba(15,23,42,.6)">
      <div style="font-weight:600;">${escapeHtml(job.jobTitle || "Job")}</div>
      <div style="opacity:.8;">${escapeHtml(location || "Unknown location")}</div>
      <div style="display:flex;justify-content:space-between;opacity:.85;margin-top:2px;font-size:10px;">
        <span>${escapeHtml(payText)}</span>
        <span>${escapeHtml(distance)}</span>
      </div>
    </li>
  `;
}

function formatMoney(value, currency) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  const cur = currency || "CAD";
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(num);
  } catch {
    return `${cur} ${num.toFixed(0)}`;
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyStatus(status) {
  if (!status) return;
  overlay.status(status.running ? "running" : "idle");
  overlay.metrics(summarizeMetrics(status.metrics));
  if (status.lastJobs) {
    overlay.log(`${status.lastJobs.total} jobs · ${status.lastJobs.qualified.length} match`);
    overlay.jobs(status.lastJobs.qualified);
  } else {
    overlay.log(status.running ? "polling hiring API…" : "background idle");
    overlay.jobs([]);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "content") return;

  switch (msg.type) {
    case "POLL_STATUS":
      applyStatus(msg.payload);
      return;
    case "POLL_RESULTS":
      overlay.status("result");
      overlay.log(`${msg.payload.total} jobs · ${msg.payload.qualified.length} match`);
      overlay.jobs(msg.payload.qualified);
      return;
    case "NEW_JOBS":
      handleNewJobs(msg.payload?.jobs || []);
      return;
    case "POLL_ERROR":
      overlay.status("error");
      overlay.log(msg.payload?.message || "poll error");
      return;
    case "REQUEST_AUTH":
      sendResponse({ token: latestAuth });
      return true;
    case "RUN_SEARCH":
      runSearchRequest(msg.body, msg.headers)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    default:
      return;
  }
});

function register() {
  chrome.runtime.sendMessage({ target: "bg", type: "REGISTER_CONTENT" }, (resp) => {
    if (chrome.runtime.lastError) {
      overlay.log(chrome.runtime.lastError.message);
      return;
    }
    applyStatus(resp?.status);
  });
}
register();

function runSearchRequest(body, headers = {}) {
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("GraphQL request timed out"));
    }, 10000);

    pendingRequests.set(requestId, { resolve, reject, timeout });
    window.postMessage(
      {
        __hiringAutoCmd__: true,
        type: "RUN_GRAPHQL",
        requestId,
        body,
        headers
      },
      "*"
    );
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function handleNewJobs(jobs) {
  if (!jobs || !jobs.length) return;
  overlay.prompt(jobs);
  savePageSnapshot(jobs);
}

function savePageSnapshot(jobs) {
  const jobIds = jobs.map((job) => job.jobId).filter(Boolean);
  if (!jobIds.length) return;
  const html = document.documentElement?.outerHTML || "";
  const trimmed = html.length > SNAPSHOT_MAX_CHARS ? html.slice(0, SNAPSHOT_MAX_CHARS) : html;
  const snapshot = { savedAt: Date.now(), jobIds, html: trimmed };

  chrome.storage.local.get({ hiringSnapshots: [] }, (items) => {
    const list = Array.isArray(items.hiringSnapshots) ? items.hiringSnapshots : [];
    list.unshift(snapshot);
    const limited = list.slice(0, SNAPSHOT_LIMIT);
    chrome.storage.local.set({ hiringSnapshots: limited });
  });
}
