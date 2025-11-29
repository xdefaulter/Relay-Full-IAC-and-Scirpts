// content.js — OPTIMIZED for sub-100ms response time
// Key improvements:
// 1. Reduced poll interval to 50-100ms
// 2. Adaptive polling strategy
// 3. Pre-warmed connections
// 4. Optimized CSRF handling
// 5. Performance monitoring

console.log("%c[Relay] Content loaded (OPTIMIZED)", "color:#10b981;font-weight:bold");

// Inject inpage.js for CSRF capture
function injectInpageScript() {
  try {
    const url = chrome.runtime.getURL && chrome.runtime.getURL('inpage.js');
    if (!url) return;
    const inject = () => {
      try {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        (document.head || document.documentElement).appendChild(s);
        s.addEventListener('load', () => { try { s.remove(); } catch {} });
      } catch {}
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', inject); else inject();
  } catch {}
}
injectInpageScript();

// Forward CSRF tokens from inpage.js
window.addEventListener('message', (ev) => {
  try {
    const m = ev && ev.data;
    if (!m || m.__relayAuto__ !== true) return;
    if (m.type === 'CSRF' && m.token) {
      csrfCache = m.token; 
      csrfSeenAt = Date.now();
      try { chrome.runtime.sendMessage({ target: 'bg', type: 'SET_CSRF', token: m.token, source: m.source }); } catch {}
    }
  } catch {}
}, false);

// ---------- Overlay UI ----------
const overlay = (() => {
  const el = document.createElement("div");
  el.style.cssText = `
    position:fixed;right:12px;bottom:12px;z-index:2147483647;
    background:rgba(17,24,39,.94);color:#fff;font:12px system-ui,sans-serif;
    padding:10px 12px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35);min-width:300px`;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <strong>Relay Auto ⚡</strong>
      <span id="relayBadge" style="margin-left:auto;background:#1f2937;padding:2px 8px;border-radius:999px">idle</span>
    </div>
    <div id="relayStat" style="max-width:40ch;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">optimized mode</div>
    <div id="relayMetrics" style="font-size:10px;opacity:.7;margin-top:4px">---</div>`;
  const init = () => document.body && document.body.appendChild(el);
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", init); else init();
  return {
    status: (t) => { const b = el.querySelector("#relayBadge"); if (b) b.textContent = t; },
    log: (t) => { const s = el.querySelector("#relayStat"); if (s) s.textContent = t; },
    metrics: (t) => { const m = el.querySelector("#relayMetrics"); if (m) m.textContent = t; }
  };
})();

// ---------- Settings ----------
const DEFAULTS = {
  origin: { name:"BRAMPTON", stateCode:"ON", latitude:43.7882, longitude:-79.73719, displayValue:"BRAMPTON, ON" },
  radius: 50,
  minPayout: 375,
  maxDistance: 192,
  resultSize: 10,        // Reduced from 50 for speed
  fastMs: 50,            // Ultra-fast polling (network limited)
  minPollMs: 400,         // Absolute minimum
  maxPollMs: 2000,       // Backoff maximum
  autoBookFirst: true,
  savedSearchId: ""
};

let settings = { ...DEFAULTS };
chrome.storage.sync.get(DEFAULTS, (v) => { 
  settings = { ...DEFAULTS, ...v };
  // Ensure minimum bounds
  settings.resultSize = Math.min(20, settings.resultSize || 10);
  settings.fastMs = Math.max(50, settings.fastMs || 50);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const k of Object.keys(changes)) {
    settings[k] = changes[k].newValue;
  }
});

// ---------- Performance Monitoring ----------
const metrics = {
  searchLatency: [],
  parseLatency: [],
  bookLatency: [],
  pollCount: 0,
  errorCount: 0
};

function recordMetric(type, value) {
  if (metrics[type]) {
    metrics[type].push(value);
    if (metrics[type].length > 100) metrics[type].shift(); // Keep last 100
  }
}

function getMetricsSummary() {
  const avg = arr => arr.length ? (arr.reduce((a,b)=>a+b,0) / arr.length).toFixed(1) : '0';
  const min = arr => arr.length ? Math.min(...arr).toFixed(1) : '0';
  return `polls:${metrics.pollCount} avg:${avg(metrics.searchLatency)}ms min:${min(metrics.searchLatency)}ms err:${metrics.errorCount}`;
}

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => Math.floor(Math.random() * 50); // Reduced jitter

// ---------- CSRF Management (Optimized) ----------
let csrfCache = null;
let csrfSeenAt = 0;

function getCsrfFromSW() {
  return new Promise((res) =>
    chrome.runtime.sendMessage({ target: "bg", type: "GET_CSRF" }, (r) =>
      res(r && r.token ? r.token : null)
    )
  );
}

async function primeCsrf() {
  try {
    // Quick HEAD request to get CSRF
    await fetch("/loadboard/search", { 
      method: "HEAD",
      credentials: "include", 
      cache: "no-store" 
    });
    await sleep(100); // Give time for SW to capture
  } catch {}
}

async function ensureCsrf(force = false) {
  const now = Date.now();
  const ttl = 300_000; // 5 minutes (reduced from 1s)
  
  if (force || !csrfCache || (now - csrfSeenAt) >= ttl) {
    const token = await getCsrfFromSW();
    if (token) {
      csrfCache = token;
      csrfSeenAt = now;
    } else if (force) {
      await primeCsrf();
      const token2 = await getCsrfFromSW();
      if (token2) {
        csrfCache = token2;
        csrfSeenAt = now;
      }
    }
  }
  
  return csrfCache;
}

// ---------- Pre-warm Connections ----------
async function prewarmConnections() {
  try {
    overlay.log("pre-warming connections...");
    await Promise.allSettled([
      fetch("/loadboard/search", { method: "HEAD", credentials: "include" }),
      fetch("/", { method: "HEAD", credentials: "include" })
    ]);
    overlay.log("connections ready");
  } catch {}
}

// ---------- Minimal Payload Builder ----------
const staticAuditContextMap = JSON.stringify({
  rlbChannel: "EXACT_MATCH",
  isOriginCityLive: "false",
  isDestinationCityLive: "false",
  userAgent: navigator.userAgent,
  source: "AVAILABLE_WORK"
});

function buildMinimalSearchPayload(s) {
  const origin = {
    name: s.origin.name,
    stateCode: s.origin.stateCode,
    latitude: s.origin.latitude,
    longitude: s.origin.longitude,
    displayValue: s.origin.displayValue,
    isCityLive: false,
    isAnywhere: false,
    uniqueKey: `${s.origin.latitude}|${s.origin.longitude}|${s.origin.displayValue}`
  };
  
  const startCitiesRadiusFilters = JSON.stringify([{
    cityLatitude: origin.latitude,
    cityLongitude: origin.longitude,
    cityName: origin.name,
    cityStateCode: origin.stateCode,
    cityDisplayValue: origin.displayValue,
    radius: s.radius
  }]);

  return {
    workOpportunityTypeList: ["ONE_WAY","ROUND_TRIP"],
    originCity: null,
    liveCity: null,
    originCities: [origin],
    startCityName: null,
    startCityStateCode: null,
    startCityLatitude: null,
    startCityLongitude: null,
    startCityDisplayValue: null,
    startCitiesRadiusFilters,
    auditContextMap: staticAuditContextMap,
    isSkippingOutOfNetwork: false,
    resultSize: s.resultSize,
    savedSearchId: s.savedSearchId || "",
    itemToken: null
  };
}

// ---------- Optimized Search ----------
async function postSearchOptimized(signal, settings, csrf) {
  const t0 = performance.now();
  
  const payload = buildMinimalSearchPayload(settings);
  const headers = { 
    "content-type": "application/json",
    "accept-encoding": "gzip, deflate, br"
  };
  
  if (csrf) headers["x-csrf-token"] = csrf;

  let response = await fetch("/api/loadboard/search", {
    method: "POST",
    credentials: "include",
    headers,
    signal,
    priority: "high", // Experimental but supported
    referrer: "https://relay.amazon.com/loadboard/search",
    referrerPolicy: "strict-origin-when-cross-origin",
    body: JSON.stringify(payload)
  });

  // Handle CSRF refresh if needed
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    const txt = await response.text().catch(()=> "");
    if (txt.includes("CSRF")) {
      csrf = await ensureCsrf(true);
      headers["x-csrf-token"] = csrf;
      
      response = await fetch("/api/loadboard/search", {
        method: "POST",
        credentials: "include",
        headers,
        signal,
        priority: "high",
        referrer: "https://relay.amazon.com/loadboard/search",
        referrerPolicy: "strict-origin-when-cross-origin",
        body: JSON.stringify(payload)
      });
    }
  }

  if (!response.ok) {
    const err = new Error(`Search failed: HTTP ${response.status}`);
    err.status = response.status;
    err.retryAfter = response.headers.get("retry-after");
    throw err;
  }

  const t1 = performance.now();
  recordMetric('searchLatency', t1 - t0);

  const text = await response.text();
  const t2 = performance.now();
  
  // Quick check before full parse
  if (!text.includes('"workOpportunities"')) {
    return { workOpportunities: [] };
  }
  
  const data = JSON.parse(text);
  const t3 = performance.now();
  
  recordMetric('parseLatency', t3 - t2);
  
  return data;
}

// ---------- Dynamic Booking (from your existing code) ----------
function buildBookPath(wo) {
  const woId = wo.id || "";
  const version = wo.version || wo.majorVersion || 1;
  return `/api/work-opportunity/${woId}/book?majorVersion=${version}`;
}

function buildBookBodyFromSearch(searchJson, woIdx) {
  const wo = searchJson.workOpportunities[woIdx];
  const auditId = searchJson.searchAuditId || "";
  
  const body = {
    workOpportunityId: wo.id,
    version: wo.version || wo.majorVersion || 1,
    searchAuditId: auditId,
    workOpportunityType: wo.workOpportunityType || "ONE_WAY",
    workOpportunityOptionId: wo.workOpportunityOptionId || "1",
    matchDeviationDetailsList: wo.matchDeviationDetails || [],
    shipperAccountList: [],
    isRelay: false
  };

  if (wo.loads && wo.loads[0]) {
    const load = wo.loads[0];
    if (load.loadShipperAccounts) {
      body.shipperAccountList = load.loadShipperAccounts;
    }
  }

  return body;
}

async function bookLoad(wo, searchData, csrf) {
  const t0 = performance.now();
  
  const path = buildBookPath(wo);
  const body = buildBookBodyFromSearch(searchData, 0);

  const headers = { 
    "content-type": "application/json",
    "accept-encoding": "gzip, br"
  };
  if (csrf) headers["x-csrf-token"] = csrf;

  let response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers,
    priority: "high",
    referrer: "https://relay.amazon.com/loadboard/search",
    referrerPolicy: "strict-origin-when-cross-origin",
    body: JSON.stringify(body)
  });

  if (!response.ok && (response.status === 401 || response.status === 403)) {
    csrf = await ensureCsrf(true);
    headers["x-csrf-token"] = csrf;
    
    response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers,
      priority: "high",
      referrer: "https://relay.amazon.com/loadboard/search",
      referrerPolicy: "strict-origin-when-cross-origin",
      body: JSON.stringify(body)
    });
  }

  if (!response.ok) {
    const txt = await response.text().catch(()=> "");
    const err = new Error(`Booking failed: HTTP ${response.status}`);
    err.status = response.status;
    err.text = txt;
    throw err;
  }

  const t1 = performance.now();
  recordMetric('bookLatency', t1 - t0);

  return response.json();
}

// ---------- Adaptive Polling Loop ----------
let running = false;
let currentCtrl = null;
let bookedOnce = sessionStorage.getItem("__relayBooked") === "1";

async function loop() {
  overlay.status("running");
  
  // Pre-warm
  await prewarmConnections();
  
  // Ensure CSRF
  let csrf = await ensureCsrf(true);
  if (!csrf) {
    overlay.log("waiting for CSRF...");
    let tries = 0;
    while (!csrf && tries < 10) {
      await sleep(2000);
      csrf = await ensureCsrf(true);
      tries++;
    }
  }

  // CONSTANT FAST POLLING (no backoff to prevent slowdown)
  const pollMs = Math.max(50, settings.fastMs || 50);
  let consecutiveEmpty = 0;

  while (running) {
    try {
      currentCtrl?.abort();
      currentCtrl = new AbortController();

      const loopStart = performance.now();
      
      // Optimized search
      const result = await postSearchOptimized(currentCtrl.signal, settings, csrf);
      const items = result?.workOpportunities || [];
      
      metrics.pollCount++;

      if (items.length > 0) {
        const elapsed = performance.now() - loopStart;
        console.log(`%c[Relay] Found ${items.length} loads in ${elapsed.toFixed(1)}ms`, "color:#22c55e;font-weight:bold");
        overlay.log(`FOUND ${items.length} loads (${elapsed.toFixed(1)}ms) — booking...`);

        // Filter by criteria
        const qualified = items.filter(wo => {
          const payout = wo.payout?.value || 0;
          const distance = wo.totalDistance?.value || 0;
          return payout >= settings.minPayout && distance <= settings.maxDistance;
        });

        if (qualified.length === 0) {
          overlay.log(`${items.length} loads, none qualified — continuing`);
          consecutiveEmpty++;
        } else if (!settings.autoBookFirst) {
          overlay.status("stopped (found)");
          running = false;
          break;
        } else if (bookedOnce) {
          overlay.status("already booked");
          running = false;
          break;
        } else {
          // BOOK FIRST QUALIFIED
          try {
            const bookResult = await bookLoad(qualified[0], result, csrf);
            const totalTime = performance.now() - loopStart;
            console.log(`%c[Relay] BOOKED ✔ in ${totalTime.toFixed(1)}ms`, "color:#22c55e;font-weight:bold", bookResult);
            
            bookedOnce = true;
            sessionStorage.setItem("__relayBooked", "1");
            overlay.status("booked ✔");
            overlay.log(`Booked in ${totalTime.toFixed(1)}ms total`);
            running = false;
            break;
          } catch (e) {
            console.error("[Relay] Booking failed:", e);
            overlay.log(`booking failed: ${e.status || 'error'}`);
            metrics.errorCount++;
            
            if (e.status === 409 || e.status === 412) {
              // Conflict - someone else got it
              overlay.log("conflict (already booked) — resuming");
              await sleep(500);
            } else {
              await sleep(Math.min(5000, pollMs * 2));
            }
          }
        }

        // Reset counter after finding loads
        consecutiveEmpty = 0;
        
      } else {
        // No loads found - keep polling at same speed
        consecutiveEmpty++;
        
        // Just log status, NO BACKOFF
        if (consecutiveEmpty % 10 === 0) {
          overlay.log(`polling (${pollMs.toFixed(0)}ms) — ${getMetricsSummary()}`);
        }
      }

      // Update metrics display every 20 polls to reduce overhead
      if (metrics.pollCount % 20 === 0) {
        overlay.metrics(getMetricsSummary());
      }

      // Wait (compensate for processing time)
      const elapsed = performance.now() - loopStart;
      const waitTime = Math.max(0, pollMs - elapsed);
      
      if (waitTime > 0) {
        await sleep(waitTime + jitter());
      }

    } catch (e) {
      metrics.errorCount++;
      console.error("[Relay] Poll error:", e);
      
      let wait = pollMs;
      if (e && e.status === 429) {
        const ra = Number(e.retryAfter);
        wait = !isNaN(ra) && ra > 0 ? ra * 1000 : Math.min(30000, pollMs * 3);
        overlay.log(`rate limited — waiting ${(wait/1000).toFixed(0)}s`);
      } else if (e && (e.status === 503 || e.status === 502)) {
        wait = Math.min(10000, pollMs * 2);
        overlay.log(`server error — waiting ${(wait/1000).toFixed(0)}s`);
      } else {
        wait = Math.min(5000, pollMs * 1.5);
        overlay.log(`error: ${String(e).slice(0,50)}`);
      }
      
      await sleep(wait + jitter());
    }
  }
  
  overlay.status("stopped");
}

// ---------- Message Handlers ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "content") return;
  
  if (msg.type === "PING") { 
    sendResponse({ ok: true, running, metrics: getMetricsSummary() }); 
    return; 
  }
  
  if (msg.type === "START") {
    if (!/\/loadboard(\/search)?/.test(location.pathname)) {
      overlay.log("open Loadboard Search first");
      sendResponse({ ok: false, reason: "wrong-surface" });
      return;
    }
    if (!running) { 
      running = true; 
      loop(); 
    }
    sendResponse({ ok: true });
    return;
  }
  
  if (msg.type === "STOP") {
    running = false; 
    try { currentCtrl?.abort(); } catch {}
    overlay.status("stopped"); 
    sendResponse({ ok: true }); 
    return;
  }
});

// ---------- Keyboard Shortcuts ----------
addEventListener("keydown", (e) => {
  if (e.altKey && e.key.toLowerCase() === "r") { 
    if (!running) { running = true; loop(); } 
  }
  if (e.altKey && e.key.toLowerCase() === "s") { 
    running = false; 
    try { currentCtrl?.abort(); } catch {}; 
    overlay.status("stopped"); 
  }
});