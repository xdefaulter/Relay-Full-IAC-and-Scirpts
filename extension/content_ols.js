// content.js — Relay Loadboard (CSP-safe)
// Requires the MV3 background service worker (sw.js) from our previous step.

console.log("%c[Relay] Content script loaded (CSP-safe)", "color:#10b981;font-weight:bold;font-size:14px");
console.log("[Relay] Current URL:", window.location.href);
console.log("[Relay] Origin:", window.location.origin);
console.log("[Relay] User Agent:", navigator.userAgent);

// ---------- Small in-page overlay (status) ----------
const overlay = (() => {
  const el = document.createElement("div");
  el.style.cssText = `
    position:fixed;right:12px;bottom:12px;z-index:2147483647;
    background:rgba(17,24,39,.94);color:#fff;font:12px system-ui,sans-serif;
    padding:10px 12px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35);min-width:220px`;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <strong>Relay Auto</strong>
      <span id="relayBadge" style="margin-left:auto;background:#1f2937;padding:2px 8px;border-radius:999px">idle</span>
    </div>
    <div id="relayStat" style="max-width:36ch;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">waiting…</div>`;
  const init = () => {
    if (document.body) {
      document.body.appendChild(el);
    } else {
      // Retry in case body not ready yet
      setTimeout(init, 100);
    }
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", init); else init();
  return {
    status: (t) => { const b = el.querySelector("#relayBadge"); if (b) b.textContent = t; },
    log: (t) => { const s = el.querySelector("#relayStat"); if (s) s.textContent = t; }
  };
})();

// ---------- Settings (synced with popup/options) ----------
const DEFAULTS = {
  origin: { name:"BRAMPTON", stateCode:"ON", latitude:43.7882, longitude:-79.73719, displayValue:"BRAMPTON, ON" },
  radius: 50,
  minPayout: 375,
  maxDistance: 192,
  resultSize: 50,
  fastMs: 5000,
  stopOnFirstLoad: true
};

// Deep clone helper to prevent mutation
const deepClone = (obj) => JSON.parse(JSON.stringify(obj));

let settings = deepClone(DEFAULTS);
let settingsReady = false;

chrome.storage.sync.get(DEFAULTS, (v) => {
  if (chrome.runtime.lastError) {
    console.error("[Relay] Storage error:", chrome.runtime.lastError);
    settings = deepClone(DEFAULTS);
  } else {
    settings = deepClone({ ...DEFAULTS, ...v });
    console.log("[Relay] Initial settings loaded:", settings);
  }
  settingsReady = true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  console.log("[Relay] Settings changed:", changes);
  for (const k of Object.keys(changes)) {
    // Deep clone to prevent mutation issues
    settings[k] = deepClone(changes[k].newValue);
    console.log(`[Relay] Updated setting: ${k} =`, settings[k]);
  }
});

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Proportional jitter: 0-20% of base interval (capped at 500ms max)
const jitter = (baseMs) => {
  const jitterPercent = 0.2; // 20%
  const maxJitter = Math.min(baseMs * jitterPercent, 500);
  return Math.floor(Math.random() * maxJitter);
};

// Ask background SW for the latest CSRF (captured from the page’s own requests)
function getCsrf() {
  return new Promise((res) =>
    chrome.runtime.sendMessage({ target: "bg", type: "GET_CSRF" }, (r) => {
      res((r && r.token) || null);
    })
  );
}

// Build payload (keeps structure incl. JSON-in-string fields)
function buildPayload(s) {
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
  const auditContextMap = JSON.stringify({
    rlbChannel: "EXACT_MATCH",
    isOriginCityLive: "false",
    isDestinationCityLive: "false",
    userAgent: navigator.userAgent,
    source: "AVAILABLE_WORK"
  });

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
    isOriginCityLive: null,
    startCityRadius: s.radius,
    destinationCity: null,
    startCitiesRadiusFilters,
    multiselectDestinationCitiesRadiusFilters: null,
    exclusionCitiesFilter: null,
    endCityName: null,
    endCityStateCode: null,
    endCityDisplayValue: null,
    endCityLatitude: null,
    endCityLongitude: null,
    isDestinationCityLive: null,
    endCityRadius: null,
    startDate: null,
    endDate: null,
    minDistance: null,
    maxDistance: s.maxDistance,
    minimumDurationInMillis: null,
    maximumDurationInMillis: null,
    minPayout: s.minPayout,
    minPricePerDistance: null,
    driverTypeFilters: [],
    uiiaCertificationsFilter: [],
    workOpportunityOperatingRegionFilter: [],
    loadingTypeFilters: [],
    maximumNumberOfStops: null,
    workOpportunityAccessType: null,
    sortByField: "startTime",
    sortOrder: "asc",
    visibilityStatusType: "ALL",
    categorizedEquipmentTypeList: [{
      equipmentCategory: "PROVIDED",
      equipmentsList: [
        "FIFTY_THREE_FOOT_TRUCK",
        "SKIRTED_FIFTY_THREE_FOOT_TRUCK",
        "FIFTY_THREE_FOOT_DRY_VAN",
        "FIFTY_THREE_FOOT_A5_AIR_TRAILER",
        "FORTY_FIVE_FOOT_TRUCK"
      ]
    }],
    categorizedEquipmentTypeListForFilterPills: [{
      equipmentCategory: "PROVIDED",
      equipmentsList: ["FIFTY_THREE_FOOT_TRUCK"]
    }],
    nextItemToken: 0,
    resultSize: s.resultSize,
    searchURL: "",
    savedSearchId: "",                // important: avoid stale/foreign GUIDs
    isAutoRefreshCall: true,
    notificationId: "",
    auditContextMap
  };
}

// Single page call
async function callSearch(nextItemToken, signal, s, csrf) {
  const url = `${window.location.origin}/api/loadboard/search`;
  const headers = { "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;

  const payload = { ...buildPayload(s), nextItemToken };

  console.log(`%c[Relay] → Fetch: POST ${url}`, "color:#06b6d4;font-weight:bold");
  console.log("[Relay] Request headers:", headers);
  console.log("[Relay] Request payload:", payload);
  console.log("[Relay] CSRF token:", csrf ? csrf.substring(0, 30) + "..." : "NONE");

  let r;
  try {
    const fetchStart = performance.now();
    r = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      referrer: "https://relay.amazon.com/loadboard/search",
      referrerPolicy: "strict-origin-when-cross-origin",
      body: JSON.stringify(payload),
      signal
    });
    const fetchEnd = performance.now();

    console.log(`%c[Relay] ← Response: ${r.status} ${r.statusText} (${Math.round(fetchEnd - fetchStart)}ms)`,
      r.ok ? "color:#10b981;font-weight:bold" : "color:#ef4444;font-weight:bold");
    console.log("[Relay] Response headers:", Object.fromEntries([...r.headers.entries()]));
  } catch (fetchError) {
    console.error("%c[Relay] ✗ Fetch failed!", "color:#ef4444;font-weight:bold", fetchError);
    throw fetchError;
  }

  if (r.status === 400) {
    const errorBody = await r.text().catch(() => "Could not read error body");
    console.error("[Relay] 400 Error body:", errorBody);
    throw Object.assign(new Error("400 (likely CSRF missing or payload mismatch)"), { status: 400 });
  }
  if (r.status === 403) {
    const errorBody = await r.text().catch(() => "Could not read error body");
    console.error("[Relay] 403 Error body:", errorBody);
    throw Object.assign(new Error("403 (CSRF likely stale)"), { status: 403, invalidateCsrf: true });
  }
  if (!r.ok) {
    const errorBody = await r.text().catch(() => "Could not read error body");
    console.error(`[Relay] ${r.status} Error body:`, errorBody);
    throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, retryAfter: r.headers.get("Retry-After") });
  }

  const data = await r.json();
  console.log("[Relay] Response data:", data);
  console.log(`[Relay] Opportunities in response: ${data?.workOpportunities?.length || 0}`);

  // Validate response structure
  if (!data || typeof data !== 'object') {
    throw Object.assign(new Error("Invalid API response format"), { status: 500 });
  }

  return data;
}

// All pages with deduplication
async function fetchAllPages(signal, s, csrf) {
  let token = 0, all = [];
  const seen = new Set(); // Track IDs to prevent duplicates
  let pageNum = 0;

  console.log("[Relay] Starting paginated fetch...");

  for (let i = 0; i < 50; i++) {
    // Check if aborted before each page request
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    pageNum++;
    console.log(`[Relay] Fetching page ${pageNum}, token: ${token}`);

    const data = await callSearch(token, signal, s, csrf);
    const arr = Array.isArray(data?.workOpportunities) ? data.workOpportunities : [];

    console.log(`[Relay] Page ${pageNum} returned ${arr.length} item(s)`);

    // Deduplicate by ID
    let duplicates = 0;
    for (const item of arr) {
      const id = item?.workOpportunityId || item?.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        all.push(item);
      } else if (id) {
        duplicates++;
      }
    }

    if (duplicates > 0) {
      console.log(`[Relay] Filtered out ${duplicates} duplicate(s) on page ${pageNum}`);
    }

    if (data?.nextItemToken == null) {
      console.log(`[Relay] No more pages (reached end at page ${pageNum})`);
      break;
    }
    token = data.nextItemToken;
  }

  console.log(`[Relay] Pagination complete: ${pageNum} page(s), ${all.length} unique load(s)`);
  return all;
}

// ---------- Runner (polls gently; stops on first load if configured) ----------
let running = false;
let currentCtrl = null;
let loopMutex = false; // Prevent multiple concurrent loops
let lastWakeTime = Date.now(); // Track system wake

async function loop() {
  // Mutex: prevent multiple concurrent loops
  if (loopMutex) {
    console.warn("[Relay] Loop already running, ignoring duplicate start");
    return;
  }
  loopMutex = true;

  console.log("%c[Relay] ═══════════════════════════════════════", "color:#3b82f6;font-weight:bold");
  console.log("%c[Relay] Starting polling loop", "color:#3b82f6;font-weight:bold");
  console.log("%c[Relay] ═══════════════════════════════════════", "color:#3b82f6;font-weight:bold");
  console.log("[Relay] Settings:", settings);
  console.log("%c[Relay] 📡 Network Tab Tip: Open DevTools > Network tab > Uncheck 'Hide extension URLs' if enabled", "color:#f59e0b;background:#fef3c7;padding:4px;");
  console.log("%c[Relay] 🔍 Look for POST requests to '/api/loadboard/search' in the Network tab", "color:#f59e0b;background:#fef3c7;padding:4px;");

  // Verify we're on the right domain
  if (!window.location.hostname.includes('relay.amazon.com')) {
    console.error(`%c[Relay] ✗ Wrong domain! Expected relay.amazon.com but got ${window.location.hostname}`, "color:#ef4444;font-weight:bold");
    overlay.log("Error: Wrong domain");
    loopMutex = false;
    return;
  }
  console.log(`%c[Relay] ✓ Domain verified: ${window.location.hostname}`, "color:#10b981");

  overlay.status("running");
  const baseMs = Math.max(10, Number(settings.fastMs) || 5000);
  console.log(`[Relay] Base polling interval: ${baseMs}ms`);

  let backoffMs = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 20;

  // Wait for CSRF first (up to ~60s) but respect running flag
  console.log("[Relay] Fetching CSRF token...");
  let csrf = await getCsrf();
  let tries = 0;
  while (!csrf && tries < 20 && running) {
    console.log(`[Relay] Waiting for CSRF token... (attempt ${tries + 1}/20)`);
    overlay.log("waiting for CSRF… (interact with page once)");
    await sleep(3000);
    if (!running) break; // Check if stopped during wait
    csrf = await getCsrf();
    tries++;
  }
  if (csrf) {
    console.log("[Relay] CSRF token acquired:", csrf.substring(0, 20) + "...");
  } else if (running) {
    console.warn("[Relay] No CSRF token available, will attempt without it");
    overlay.log("no CSRF yet; will still try (gentle)");
  }

  let pollCount = 0;
  while (running) {
    pollCount++;
    console.log(`%c[Relay] Poll iteration #${pollCount}`, "color:#8b5cf6;font-weight:bold");

    // Detect system sleep/wake
    const now = Date.now();
    const timeSinceLastWake = now - lastWakeTime;
    if (timeSinceLastWake > 120000) {
      // System likely slept (>2 min gap)
      console.log("%c[Relay] System wake detected, refreshing CSRF", "color:#f59e0b;font-weight:bold");
      csrf = await getCsrf();
      consecutiveErrors = 0; // Reset error counter
      backoffMs = 0;
    }
    lastWakeTime = now;

    try {
      // Clean abort of previous request if any
      if (currentCtrl) {
        currentCtrl.abort();
        currentCtrl = null;
        await sleep(100); // Brief pause to let abort propagate
      }

      currentCtrl = new AbortController();
      overlay.log("polling…");
      console.log("[Relay] Starting API request...");

      // Refresh CSRF each loop, but invalidate on 403
      const freshCsrf = await getCsrf();
      if (freshCsrf && freshCsrf !== csrf) {
        console.log("[Relay] CSRF token refreshed");
        csrf = freshCsrf;
      }

      const startTime = Date.now();
      const items = await fetchAllPages(currentCtrl.signal, settings, csrf);
      const elapsed = Date.now() - startTime;

      console.log(`[Relay] API request completed in ${elapsed}ms`);
      console.log(`[Relay] Found ${items.length} load(s)`);

      // Reset error counter on success
      consecutiveErrors = 0;

      if (items.length > 0 && settings.stopOnFirstLoad) {
        overlay.status("stopped (found)");
        console.log("%c[Relay] ✓ FOUND LOADS — stopping", "color:#22c55e;font-weight:bold;font-size:14px");
        console.log("%c[Relay] Load Details:", "color:#22c55e;font-weight:bold");
        console.table(items.map(item => ({
          id: item.workOpportunityId || item.id,
          origin: item.startLocation?.cityDisplayValue || 'N/A',
          destination: item.endLocation?.cityDisplayValue || 'N/A',
          payout: item.totalPayout || item.payout || 'N/A',
          distance: item.totalDistance || item.distance || 'N/A',
          startTime: item.startTime || 'N/A'
        })));
        console.log("[Relay] Full load data:", items);
        running = false;
        break;
      } else if (items.length > 0) {
        overlay.log(`items=${items.length} (continuing)`);
        console.log("%c[Relay] Found loads but continuing polling (stopOnFirstLoad=false)", "color:#3b82f6");
        console.log("[Relay] Load data:", items);
        backoffMs = 0;
      } else {
        // Apply gentle backoff even for empty results
        overlay.log("no loads yet");
        console.log("[Relay] No loads found in this poll");
        backoffMs = Math.min(30000, backoffMs ? backoffMs + 2000 : 0);
      }

      const jitterMs = jitter(baseMs);
      const nextWait = baseMs + backoffMs + jitterMs;
      console.log(`[Relay] Sleeping for ${nextWait}ms before next poll (base: ${baseMs}ms + backoff: ${backoffMs}ms + jitter: ${jitterMs}ms)`);
      await sleep(nextWait);
    } catch (e) {
      // Skip if aborted (user stopped)
      if (e.name === "AbortError") {
        console.log("[Relay] Request aborted by user");
        overlay.log("request aborted");
        break;
      }

      consecutiveErrors++;
      console.error(`%c[Relay] Error in poll #${pollCount} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, "color:#ef4444", e);

      // Circuit breaker: stop after too many consecutive errors
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        overlay.status("stopped (error limit)");
        overlay.log(`Stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        console.error("%c[Relay] ✗ Circuit breaker triggered - too many consecutive errors, stopping", "color:#ef4444;font-weight:bold");
        running = false;
        break;
      }

      // Invalidate CSRF on 403
      if (e.invalidateCsrf) {
        csrf = null;
        console.warn("[Relay] CSRF token invalidated (403 error), will refresh on next iteration");
      }

      let wait = baseMs + jitter(baseMs);
      if (e && (e.status === 429 || e.status === 503)) {
        const ra = Number(e.retryAfter);
        if (!Number.isNaN(ra) && ra > 0) {
          wait = ra * 1000;
          console.log(`[Relay] Rate limited (${e.status}), using Retry-After: ${ra}s`);
        } else {
          backoffMs = Math.min(60000, backoffMs ? backoffMs * 2 : 4000);
          wait = backoffMs + jitter(backoffMs);
          console.log(`[Relay] Rate limited (${e.status}), exponential backoff: ${Math.round(wait/1000)}s`);
        }
      } else if (e && (e.status === 400 || e.status === 403)) {
        backoffMs = Math.min(15000, backoffMs ? backoffMs + 2000 : 5000);
        wait = backoffMs + jitter(backoffMs);
        console.log(`[Relay] Auth/validation error (${e.status}), backing off: ${Math.round(wait/1000)}s`);
      } else {
        backoffMs = Math.min(60000, backoffMs ? backoffMs * 2 : 4000);
        wait = backoffMs + jitter(backoffMs);
        console.log(`[Relay] Generic error, exponential backoff: ${Math.round(wait/1000)}s`);
      }
      overlay.log(`error: ${String(e.message || e)}; sleep≈${Math.round(wait/1000)}s (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
      console.log(`[Relay] Sleeping ${wait}ms before retry... (backoff: ${backoffMs}ms + jitter: ${Math.round(wait - backoffMs)}ms)`);
      await sleep(wait);
    }
  }

  // Cleanup
  console.log("%c[Relay] Polling loop ended", "color:#6366f1;font-weight:bold");
  currentCtrl?.abort();
  currentCtrl = null;
  loopMutex = false;
  if (!running) overlay.status("stopped");
}

// Helper to notify popup of state change
function notifyPopup() {
  chrome.runtime.sendMessage({ target: "popup", type: "STATE_CHANGED", running }).catch(() => {
    // Popup may not be open, ignore error
  });
}

// ---------- Messages from popup ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "content") return;

  console.log("[Relay] Received message:", msg.type);

  if (msg.type === "PING") {
    console.log(`[Relay] PING response: running=${running}`);
    sendResponse({ ok: true, running });
    return;
  }

  if (msg.type === "START") {
    if (!running && settingsReady) {
      console.log("%c[Relay] START command received from popup", "color:#10b981;font-weight:bold");
      running = true;
      loop();
      sendResponse({ ok: true });
    } else if (!settingsReady) {
      console.warn("[Relay] START rejected: Settings not ready");
      sendResponse({ ok: false, error: "Settings not ready" });
    } else {
      console.warn("[Relay] START rejected: Already running");
      sendResponse({ ok: false, error: "Already running" });
    }
    return;
  }

  if (msg.type === "STOP") {
    console.log("%c[Relay] STOP command received from popup", "color:#ef4444;font-weight:bold");
    running = false;
    try { currentCtrl?.abort(); } catch {}
    overlay.status("stopped");
    sendResponse({ ok: true });
    return;
  }
});

// ---------- Optional keyboard shortcuts for quick testing ----------
addEventListener("keydown", (e) => {
  if (e.altKey && e.key.toLowerCase() === "r") {
    if (!running && settingsReady) {
      console.log("%c[Relay] START via keyboard shortcut (Alt+R)", "color:#10b981;font-weight:bold");
      running = true;
      loop();
      notifyPopup();
    } else if (!settingsReady) {
      console.warn("[Relay] START rejected: Settings not ready (Alt+R)");
    } else {
      console.warn("[Relay] START rejected: Already running (Alt+R)");
    }
  }
  if (e.altKey && e.key.toLowerCase() === "s") {
    console.log("%c[Relay] STOP via keyboard shortcut (Alt+S)", "color:#ef4444;font-weight:bold");
    running = false;
    try { currentCtrl?.abort(); } catch {};
    overlay.status("stopped");
    notifyPopup();
  }
});
