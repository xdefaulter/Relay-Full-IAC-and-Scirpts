const CSRF_KEY = "relay_csrf_token";
const SEARCH_ENDPOINT = "https://relay.amazon.com/api/loadboard/search";
const BOOK_ENDPOINT_ROOT = "https://relay.amazon.com/api/loadboard";
const EVENT_STREAM_URL = "https://relay.amazon.com/api/loadboard/events";
const LOADBOARD_TAB_URL = "https://relay.amazon.com/loadboard/search";
const RELAY_ORIGIN_PERMISSION = "https://relay.amazon.com/*";
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const SSE_JUSTIFICATION = "Listen to Relay loadboard events without a visible tab.";
const NATIVE_HOST = "relay.auto.daemon";

const DEFAULT_SETTINGS = {
  origin: { name: "BRAMPTON", stateCode: "ON", latitude: 43.7882, longitude: -79.73719, displayValue: "BRAMPTON, ON" },
  radius: 50,
  resultSize: 2,
  minPayout: 375,
  maxDistance: 192,
  fastMs: 300,
  stopOnFirstLoad: true,
  autoBookFirst: true,
  phaseMs: 0,
  savedSearchId: "",
  minRatePerMile: null,
  startDelayMs: 0,
  earliestStartHours: 0
};

const subscribers = new Map(); // tabId -> timestamp
let primaryTabId = null;
let cachedCsrf = null;
let csrfTimestamp = 0;
const CSRF_TTL = 600_000;
const pendingTabReady = new Map(); // tabId -> { resolve, reject }

let poller;

function respondAsync(promise, sendResponse) {
  promise
    .then((payload) => sendResponse({ ok: true, ...(payload || {}) }))
    .catch((error) => {
      console.error("[SW] async handler error:", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
}

function getPrimaryTabId() {
  if (primaryTabId != null && subscribers.has(primaryTabId)) {
    return primaryTabId;
  }
  const next = subscribers.keys().next();
  if (!next.done) {
    primaryTabId = next.value;
    return primaryTabId;
  }
  return null;
}

function setCsrf(token, source) {
  cachedCsrf = token;
  csrfTimestamp = Date.now();

  const saveToStorage = (storageArea) => {
    storageArea.set({ [CSRF_KEY]: token }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[SW] storage set failed:", chrome.runtime.lastError.message);
      }
    });
  };

  // Try session storage first (preferred for CSRF)
  saveToStorage(chrome.storage.session);
  poller.onCsrfUpdate(token, source);
}

async function getStoredCsrf() {
  if (cachedCsrf && Date.now() - csrfTimestamp < CSRF_TTL) {
    return cachedCsrf;
  }

  const obj = await new Promise((resolve) => {
    chrome.storage.session.get(CSRF_KEY, (items) => resolve(items));
  });

  const token = obj?.[CSRF_KEY] || null;
  if (token) {
    cachedCsrf = token;
    csrfTimestamp = Date.now();
  }
  return token;
}

function cloneSettingsBase() {
  if (typeof structuredClone === "function") {
    return structuredClone(DEFAULT_SETTINGS);
  }
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function sanitizeSettings(input = {}) {
  const base = cloneSettingsBase();
  if (input.origin) base.origin = { ...base.origin, ...input.origin };
  if (typeof input.radius === "number") base.radius = Math.min(500, Math.max(1, input.radius));
  if (typeof input.resultSize === "number") base.resultSize = Math.min(50, Math.max(1, input.resultSize));
  if (typeof input.minPayout === "number") base.minPayout = Math.max(0, input.minPayout);
  if (typeof input.maxDistance === "number") base.maxDistance = Math.max(1, input.maxDistance);
  if (typeof input.fastMs === "number") base.fastMs = Math.max(10, input.fastMs);
  if (typeof input.stopOnFirstLoad === "boolean") base.stopOnFirstLoad = input.stopOnFirstLoad;
  if (typeof input.autoBookFirst === "boolean") base.autoBookFirst = input.autoBookFirst;
  if (typeof input.phaseMs === "number") {
    const maxPhase = Math.max(10, base.fastMs);
    base.phaseMs = Math.max(0, Math.min(60000, input.phaseMs)) % maxPhase;
  }
  if (typeof input.startDelayMs === "number") {
    base.startDelayMs = Math.max(0, Math.min(600000, input.startDelayMs));
  }
  if (typeof input.earliestStartHours === "number") {
    base.earliestStartHours = Math.max(0, Math.min(72, input.earliestStartHours));
  }
  if (typeof input.sseEndpoint === "string" && input.sseEndpoint.startsWith("https://")) {
    base.sseEndpoint = input.sseEndpoint;
  }
  return base;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return;
  const hasDocument = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
  if (hasDocument) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_SCRAPING"],
    justification: SSE_JUSTIFICATION
  });
}

async function closeOffscreenDocument() {
  if (!chrome.offscreen) return;
  const hasDocument = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
  if (!hasDocument) return;
  await chrome.offscreen.closeDocument();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhase(interval, phase) {
  if (!Number.isFinite(phase)) return 0;
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  const normalized = ((phase % interval) + interval) % interval;
  return normalized;
}

function computePhaseDelay(now, interval, phase) {
  const normalizedPhase = normalizePhase(interval, phase);
  const current = now % interval;
  if (current <= normalizedPhase) return normalizedPhase - current;
  return interval - (current - normalizedPhase);
}

function alignToExactSecond(timestamp) {
  const base = Number.isFinite(timestamp) ? timestamp : Date.now();
  return Math.ceil(base / 1000) * 1000;
}

function readSyncSettings() {
  return new Promise((resolve) => {
    // Try sync first
    chrome.storage.sync.get(null, (items) => {
      if (chrome.runtime.lastError) {
        console.warn("[SW] sync read failed, trying local:", chrome.runtime.lastError.message);
        // Fallback to local
        chrome.storage.local.get(null, (localItems) => {
          resolve(localItems || {});
        });
      } else {
        resolve(items || {});
      }
    });
  });
}

class RelayPoller {
  constructor() {
    this.running = false;
    this.settings = sanitizeSettings();
    this.metrics = this.createMetrics();
    this.controller = null;
    this.lastSummary = null;
    this.cachedPayloadString = null;
    this.cachedPayloadBuffer = null;
    this.cachedPayloadKey = "";
    this.nativePort = null;
    this.nativeSeq = 0;
    this.nativePending = new Map();
    this.nativeFailed = false;
    this.nativeConnected = false;
    this.nativeLastMessage = 0;
    this.ssePromise = null;
    this.sseResolve = null;
    this.sseTimeout = null;
    this.sseState = {
      connected: false,
      lastEvent: null,
      lastError: null
    };
    this.lastAuditContextMap = null;
  }

  createMetrics() {
    return {
      pollCount: 0,
      loadsFound: 0,
      qualifiedLoads: 0,
      rateLimitHits: 0,
      errors: 0,
      lastError: null,
      lastDuration: 0,
      searchLatency: [],
      parseLatency: [],
      lastUpdate: 0
    };
  }

  status() {
    return {
      running: this.running,
      settings: this.settings,
      metrics: {
        ...this.metrics,
        searchLatency: this.metrics.searchLatency.slice(-5),
        parseLatency: this.metrics.parseLatency.slice(-5)
      },
      lastSummary: this.lastSummary,
      native: {
        connected: this.nativeConnected,
        failed: this.nativeFailed,
        lastMessage: this.nativeLastMessage
      },
      sse: { ...this.sseState }
    };
  }

  onCsrfUpdate(token, source) {
    if (!token) return;
    if (!this.running) return;
    console.log("[SW] CSRF updated from", source);
  }

  getSseUrl() {
    return this.settings.sseEndpoint || EVENT_STREAM_URL;
  }

  registerTab(tabId) {
    subscribers.set(tabId, Date.now());
  }

  broadcast(type, payload) {
    for (const [tabId] of subscribers.entries()) {
      chrome.tabs.sendMessage(tabId, { target: "content", type, payload }, () => {
        if (chrome.runtime.lastError) {
          subscribers.delete(tabId);
        }
      });
    }
  }

  broadcastStatus() {
    this.broadcast("POLL_STATUS", this.status());
  }

  async start(settings = {}) {
    const stored = await readSyncSettings();
    const merged = { ...stored, ...settings };
    this.settings = sanitizeSettings(merged);
    this.cachedPayloadString = null;
    this.cachedPayloadBuffer = null;
    this.cachedPayloadKey = "";
    if (this.running) {
      this.broadcastStatus();
      return;
    }

    const hasRelayTab = await ensureRelayTabAvailable({ create: true });
    if (!hasRelayTab) {
      throw new Error("Open relay.amazon.com/loadboard/search first");
    }

    this.running = true;
    this.metrics = this.createMetrics();
    await ensureOffscreenDocument();
    await this.waitForStartPhase();
    this.loop(); // fire and forget
    this.broadcastStatus();
  }

  async stop() {
    this.running = false;
    if (this.controller) {
      try { this.controller.abort(); } catch { }
      this.controller = null;
    }
    this.cancelSseWait();
    await closeOffscreenDocument();
    this.broadcastStatus();
  }

  async waitForStartPhase() {
    const pollMs = Math.max(10, this.settings.fastMs);
    const phaseMs = normalizePhase(pollMs, Number(this.settings.phaseMs) || 0);
    const startDelay = Math.max(0, Number(this.settings.startDelayMs) || 0);

    const alignedStartTarget = alignToExactSecond(Date.now() + startDelay);
    const prePhaseDelay = Math.max(0, alignedStartTarget - Date.now());
    if (prePhaseDelay > 0) {
      await sleep(prePhaseDelay);
    }

    const delay = computePhaseDelay(Date.now(), pollMs, phaseMs);
    if (delay > 0) {
      await sleep(delay);
    }
  }

  async loop() {
    let isPolling = false;
    while (this.running) {
      if (isPolling) {
        await sleep(50);
        continue;
      }
      isPolling = true;

      const loopStart = performance.now();
      const ctrl = new AbortController();
      this.controller = ctrl;
      let hadError = false;

      try {
        const csrf = await ensureCsrfToken();
        if (!csrf) throw new Error("Missing CSRF token");

        const payload = this.getPayloadString();
        const result = await this.performSearch(payload, csrf);
        await this.handleResult(result, csrf, loopStart);
      } catch (error) {
        hadError = true;
        this.metrics.errors += 1;
        this.metrics.lastError = error?.message || String(error);
        this.broadcast("POLL_ERROR", { message: this.metrics.lastError });
        console.error("[SW] Poll loop error:", error);
      } finally {
        this.controller = null;
        isPolling = false;
      }

      const elapsed = performance.now() - loopStart;
      this.metrics.lastDuration = elapsed;
      await this.waitForNext(elapsed, hadError);
      this.cancelSseWait();
    }
  }

  async pollOnce(settings = {}) {
    const csrf = await ensureCsrfToken();
    if (!csrf) throw new Error("Missing CSRF token");

    if (settings && Object.keys(settings).length > 0) {
      const stored = await readSyncSettings();
      const merged = { ...stored, ...settings };
      this.settings = sanitizeSettings(merged);
      this.cachedPayloadString = null;
    }

    const payload = this.getPayloadString();
    const result = await this.performSearch(payload, csrf);
    return result;
  }

  async performSearch(payload, csrf) {
    const result = await this.fetchSearchResults(payload, csrf);
    this.metrics.searchLatency.push(result.duration || 0);
    this.metrics.parseLatency.push(result.parseDuration || 0);

    // Bounded metrics arrays
    if (this.metrics.searchLatency.length > 100) this.metrics.searchLatency.shift();
    if (this.metrics.parseLatency.length > 100) this.metrics.parseLatency.shift();

    return result;
  }

  async fetchSearchResults(payload, csrf) {
    const result = await sendMessageToRelayTab({
      target: "content",
      type: "RUN_SEARCH",
      payload,
      csrf
    });

    if (!result?.workOpportunities) {
      // Handle 401/403 by clearing CSRF
      if (result?.status === 401 || result?.status === 403) {
        console.warn("[SW] Auth error, clearing CSRF");
        cachedCsrf = null;
        chrome.storage.session.remove(CSRF_KEY);
      }
      const err = new Error(result?.error || "Search failed in tab");
      err.status = result?.status;
      err.retryAfter = result?.retryAfter;
      throw err;
    }

    return result;
  }

  async handleResult(result, csrf, loopStart) {
    const items = result?.workOpportunities || [];
    this.metrics.pollCount += 1;
    this.metrics.lastUpdate = Date.now();

    if (!items.length) {
      this.broadcast("POLL_HEARTBEAT", {
        pollCount: this.metrics.pollCount,
        empty: true,
        metrics: this.metrics
      });
      return;
    }

    this.metrics.loadsFound += items.length;
    const qualified = this.filterLoads(items);
    this.metrics.qualifiedLoads += qualified.length;

    this.lastSummary = {
      receivedAt: Date.now(),
      total: items.length,
      qualifiedCount: qualified.length,
      fastest: qualified[0]?.payout?.value || 0
    };

    this.broadcast("POLL_RESULTS", {
      total: items.length,
      qualified,
      duration: performance.now() - loopStart
    });

    if (!qualified.length) {
      return;
    }

    if (!this.settings.autoBookFirst) {
      if (this.settings.stopOnFirstLoad) {
        await this.stop();
      }
      return;
    }

    try {
      const booking = await this.bookLoad(qualified[0], result, csrf);
      this.broadcast("POLL_BOOKED", { workOpportunityId: qualified[0].id, booking });
      if (this.settings.stopOnFirstLoad) {
        await this.stop();
      }
    } catch (error) {
      console.error("[SW] Booking error:", error);
      this.broadcast("POLL_ERROR", { message: `booking failed: ${error.message}` });
    }
  }

  filterLoads(items) {
    const minPay = Number(this.settings.minPayout) || 0;
    const maxDistance = Number(this.settings.maxDistance) || Infinity;

    return items.filter((wo) => {
      const payout = wo.payout?.value || 0;
      const distance = wo.totalDistance?.value || Infinity;
      return payout >= minPay && distance <= maxDistance;
    });
  }

  async waitForNext(elapsed, hadError) {
    const pollMs = Math.max(10, this.settings.fastMs);
    const phaseMs = normalizePhase(pollMs, Number(this.settings.phaseMs) || 0);
    const baseDelay = Math.max(0, pollMs - (elapsed || 0));
    const alignedDelay = computePhaseDelay(Date.now() + baseDelay, pollMs, phaseMs);

    let waitDelay = Math.max(baseDelay, alignedDelay);
    if (hadError) {
      waitDelay = Math.max(waitDelay, Math.min(5000, pollMs * 1.5));
    }

    const timer = sleep(waitDelay);
    const sse = this.awaitSseWake();

    await Promise.race([timer, sse]);
  }

  awaitSseWake() {
    if (this.ssePromise) return this.ssePromise;
    this.ssePromise = new Promise((resolve) => {
      this.sseResolve = resolve;
      this.sseTimeout = setTimeout(() => this.cancelSseWait(), 10000);
    });
    return this.ssePromise;
  }

  cancelSseWait() {
    if (this.sseResolve) this.sseResolve("timeout");
    if (this.sseTimeout) clearTimeout(this.sseTimeout);
    this.ssePromise = null;
    this.sseResolve = null;
    this.sseTimeout = null;
  }

  handleSseWake(detail) {
    if (!detail) return;
    if (detail.kind === "open") {
      this.sseState.connected = true;
      this.sseState.lastEvent = Date.now();
      this.sseState.lastError = null;
      this.broadcastStatus();
      return;
    }

    if (detail.kind === "error") {
      this.sseState.connected = false;
      this.sseState.lastError = detail.error || "stream error";
      this.broadcastStatus();
      return;
    }

    if (detail.kind === "message") {
      this.sseState.lastEvent = Date.now();
      if (this.sseResolve) {
        this.sseResolve(detail);
        this.cancelSseWait();
      }
      return;
    }
  }

  getPayloadString() {
    const dynamicStart = hasDynamicStartDate(this.settings);
    const key = JSON.stringify({
      origin: this.settings.origin,
      radius: this.settings.radius,
      maxDistance: this.settings.maxDistance,
      minPayout: this.settings.minPayout,
      resultSize: this.settings.resultSize,
      earliestStartHours: this.settings.earliestStartHours || 0
    });

    if (!dynamicStart && this.cachedPayloadString && this.cachedPayloadKey === key) {
      return this.cachedPayloadString;
    }

    const payload = buildSlimPayload(this.settings);
    const json = JSON.stringify(payload);
    this.lastAuditContextMap = payload.auditContextMap || null;

    if (dynamicStart) {
      this.cachedPayloadString = null;
      this.cachedPayloadKey = "";
      this.cachedPayloadBuffer = null;
      return json;
    }

    this.cachedPayloadKey = key;
    this.cachedPayloadString = json;
    this.cachedPayloadBuffer = new TextEncoder().encode(json);
    return this.cachedPayloadString;
  }

  getPayloadBuffer() {
    if (!this.cachedPayloadBuffer) {
      const str = this.getPayloadString();
      if (this.cachedPayloadBuffer) return this.cachedPayloadBuffer;
      return new TextEncoder().encode(str);
    }
    return this.cachedPayloadBuffer;
  }

  async bookLoad(workOpportunity, searchData, csrf) {
    const prepared = await this.ensureBookingContext(workOpportunity, searchData, csrf);
    let targetWo = prepared.workOpportunity;
    let targetSearch = prepared.searchData;

    const initialResponse = await submitBookingRequest(targetWo, targetSearch, csrf, this.lastAuditContextMap);
    if (initialResponse?.ok) {
      return initialResponse.body || {};
    }

    if (!shouldRetryBooking(initialResponse)) {
      throw buildBookingError(initialResponse);
    }

    const woId = targetWo?.id;
    console.warn(`[SW] Booking version mismatch for ${woId} — refreshing and retrying once`);
    const refreshed = await this.refreshWorkOpportunity(woId, csrf);
    if (!refreshed?.workOpportunity || !refreshed?.searchData) {
      throw buildBookingError(initialResponse);
    }

    targetWo = refreshed.workOpportunity;
    targetSearch = refreshed.searchData;

    const retryResponse = await submitBookingRequest(targetWo, targetSearch, csrf, this.lastAuditContextMap);
    if (retryResponse?.ok) {
      return retryResponse.body || {};
    }

    throw buildBookingError(retryResponse);
  }

  async ensureBookingContext(workOpportunity, searchData, csrf) {
    if (hasBookingIdentifiers(workOpportunity)) {
      return { workOpportunity, searchData };
    }

    const refreshed = await this.refreshWorkOpportunity(workOpportunity?.id, csrf);
    if (refreshed?.workOpportunity && hasBookingIdentifiers(refreshed.workOpportunity)) {
      return refreshed;
    }

    throw new Error(`Missing booking identifiers for ${workOpportunity?.id || "workOpportunity"}`);
  }

  async refreshWorkOpportunity(workOpportunityId, csrf) {
    if (!workOpportunityId) {
      return {};
    }
    try {
      const payload = this.getPayloadString();
      const refreshed = await this.fetchSearchResults(payload, csrf);
      const updated = refreshed.workOpportunities?.find((wo) => wo.id === workOpportunityId) || null;
      return { searchData: refreshed, workOpportunity: updated };
    } catch (error) {
      console.warn(`[SW] Failed to refresh work opportunity ${workOpportunityId}:`, error);
      return {};
    }
  }

  ensureNativePort() {
    if (this.nativePort || this.nativeFailed) return;
    try {
      this.nativePort = chrome.runtime.connectNative(NATIVE_HOST);
      this.nativeConnected = true;
      this.nativeLastMessage = Date.now();
      this.nativePort.onMessage.addListener((msg) => this.handleNativeMessage(msg));
      this.nativePort.onDisconnect.addListener(() => {
        this.rejectAllNativePending(new Error("Native host disconnected"));
        this.nativePort = null;
        this.nativeFailed = true;
        this.nativeConnected = false;
        this.broadcastStatus();
      });
      this.broadcastStatus();
    } catch (error) {
      console.warn("[SW] Native messaging not available:", error.message);
      this.nativePort = null;
      this.nativeFailed = true;
      this.nativeConnected = false;
      this.broadcastStatus();
    }
  }

  handleNativeMessage(msg) {
    this.nativeLastMessage = Date.now();
    if (msg?.type === "log") {
      console.log("[Native]", msg.message);
      return;
    }
    const pending = this.nativePending.get(msg?.id);
    if (!pending) return;

    this.nativePending.delete(msg.id);
    if (pending.abortHandler && pending.signal) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg);
    }
  }

  nativeRequest(type, payload, signal) {
    if (!this.nativePort) return Promise.reject(new Error("Native host unavailable"));
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    const id = ++this.nativeSeq;

    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        this.nativePending.delete(id);
        reject(new DOMException("Aborted", "AbortError"));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.nativePending.set(id, { resolve, reject, abortHandler, signal });

      try {
        this.nativePort.postMessage({ id, type, payload });
      } catch (error) {
        this.nativePending.delete(id);
        if (signal) signal.removeEventListener("abort", abortHandler);
        reject(error);
      }
    });
  }

  async nativeFetch(options, signal) {
    const response = await this.nativeRequest("fetch", options, signal);
    if (!response || response.ok === false) {
      throw new Error(response?.error || "Native fetch failed");
    }

    const body = response.body ? decodeBase64(response.body) : new Uint8Array();
    const headers = new Headers(response.headers || {});
    return new Response(body, { status: response.status || 200, headers });
  }

  rejectAllNativePending(error) {
    for (const [id, pending] of this.nativePending.entries()) {
      if (pending.abortHandler && pending.signal) {
        pending.signal.removeEventListener("abort", pending.abortHandler);
      }
      pending.reject(error);
      this.nativePending.delete(id);
    }
  }
}

async function ensureCsrfToken(force = false) {
  if (!force) {
    const cached = await getStoredCsrf();
    if (cached && validateCsrfToken(cached)) return cached;
  }

  const fromTabs = await requestCsrfFromTabs();
  if (fromTabs && validateCsrfToken(fromTabs)) {
    setCsrf(fromTabs, "content-request");
    return fromTabs;
  }

  await sleep(50);
  const stored = await getStoredCsrf();
  return (stored && validateCsrfToken(stored)) ? stored : null;
}

function validateCsrfToken(token) {
  return typeof token === "string" && token.length > 20; // Basic validation
}

async function requestCsrfFromTabs() {
  try {
    const response = await sendMessageToRelayTab({ target: "content", type: "REQUEST_CSRF" });
    return response?.token || null;
  } catch {
    return null;
  }
}

function sendMessageToTab(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function refreshRelayTabs() {
  const tabs = await chrome.tabs.query({ url: "https://relay.amazon.com/*" });
  subscribers.clear();
  primaryTabId = null;

  if (Array.isArray(tabs) && tabs.length) {
    for (const tab of tabs) {
      if (tab.id != null) {
        subscribers.set(tab.id, Date.now());
      }
    }
    primaryTabId = tabs[0]?.id ?? null;
    return true;
  }
  return false;
}

function hasRequiredHostPermission() {
  if (!chrome.permissions?.contains) return Promise.resolve(true);
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [RELAY_ORIGIN_PERMISSION] }, (granted) => resolve(!!granted));
  });
}

async function ensureRelayTabAvailable(options = {}) {
  if (!await hasRequiredHostPermission()) {
    throw new Error("Grant Chrome site access to relay.amazon.com");
  }
  if (subscribers.size > 0) return true;
  if (await refreshRelayTabs()) return true;
  if (!options.create) return false;
  return openRelayTab();
}

async function openRelayTab() {
  try {
    const tab = await createRelayTab();
    if (!tab || tab.id == null) return false;
    primaryTabId = tab.id;
    await waitForTabRegistration(tab.id);
    return true;
  } catch (error) {
    console.warn("[SW] Failed to auto-open Relay tab:", error);
    return false;
  }
}

function createRelayTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: LOADBOARD_TAB_URL, active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(tab);
      }
    });
  });
}

function waitForTabRegistration(tabId, timeoutMs = 15000) {
  if (subscribers.has(tabId)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTabReady.delete(tabId);
      reject(new Error("Timed out waiting for relay.amazon.com tab"));
    }, timeoutMs);

    pendingTabReady.set(tabId, {
      resolve: () => {
        clearTimeout(timeout);
        pendingTabReady.delete(tabId);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        pendingTabReady.delete(tabId);
        reject(error);
      }
    });
  });
}

function resolvePendingTab(tabId) {
  const pending = pendingTabReady.get(tabId);
  if (pending) {
    pending.resolve();
  }
}

function rejectPendingTab(tabId, error) {
  const pending = pendingTabReady.get(tabId);
  if (pending) {
    pending.reject(error || new Error("Relay tab closed"));
    pendingTabReady.delete(tabId);
  }
}

async function sendMessageToRelayTab(payload) {
  let tabId = getPrimaryTabId();
  if (tabId == null) {
    const available = await ensureRelayTabAvailable({ create: true });
    if (!available) {
      throw new Error("Open relay.amazon.com/loadboard/search in a tab");
    }
    tabId = getPrimaryTabId();
  }

  // Verify tab is still valid
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.discarded) {
      subscribers.delete(tabId);
      if (primaryTabId === tabId) primaryTabId = null;
      // Retry will handle getting a new tab
      return sendMessageToTabWithRetry(null, payload);
    }
  } catch (e) {
    subscribers.delete(tabId);
    if (primaryTabId === tabId) primaryTabId = null;
  }

  return sendMessageToTabWithRetry(tabId, payload);
}

async function sendMessageToTabWithRetry(tabId, payload, retries = 1) {
  try {
    if (tabId == null) {
      // Force refresh if no tab ID provided
      throw new Error("No tab ID");
    }
    return await sendMessageToTab(tabId, payload);
  } catch (error) {
    if (tabId) subscribers.delete(tabId);
    if (primaryTabId === tabId) primaryTabId = null;

    if (retries > 0) {
      const refreshed = await refreshRelayTabs();
      if (refreshed) {
        const nextTabId = getPrimaryTabId();
        if (nextTabId != null) {
          return sendMessageToTabWithRetry(nextTabId, payload, retries - 1);
        }
      }
    }
    throw error;
  }
}

function buildSlimPayload(settings) {
  const origin = settings.origin;
  const radiusFilter = {
    cityLatitude: origin.latitude,
    cityLongitude: origin.longitude,
    cityName: origin.name,
    cityStateCode: origin.stateCode,
    cityDisplayValue: origin.displayValue,
    radius: settings.radius
  };

  const auditContext = buildAuditContextObject();

  const categorizedEquipment = [{
    equipmentCategory: "PROVIDED",
    equipmentsList: [
      "FIFTY_THREE_FOOT_TRUCK",
      "SKIRTED_FIFTY_THREE_FOOT_TRUCK",
      "FIFTY_THREE_FOOT_DRY_VAN",
      "FIFTY_THREE_FOOT_A5_AIR_TRAILER",
      "FORTY_FIVE_FOOT_TRUCK"
    ]
  }];

  return {
    workOpportunityTypeList: ["ONE_WAY", "ROUND_TRIP"],
    originCity: null,
    liveCity: null,
    originCities: [origin],
    startCityName: null,
    startCityStateCode: null,
    startCityLatitude: null,
    startCityLongitude: null,
    startCityDisplayValue: null,
    isOriginCityLive: null,
    startCityRadius: settings.radius,
    destinationCity: null,
    originCitiesRadiusFilters: [radiusFilter],
    destinationCitiesRadiusFilters: null,
    exclusionCitiesFilter: null,
    endCityName: null,
    endCityStateCode: null,
    endCityDisplayValue: null,
    endCityLatitude: null,
    endCityLongitude: null,
    isDestinationCityLive: null,
    endCityRadius: null,
    startDate: computeEarliestStartDate(settings.earliestStartHours),
    endDate: null,
    minDistance: null,
    maxDistance: settings.maxDistance,
    minimumDurationInMillis: null,
    maximumDurationInMillis: null,
    minPayout: settings.minPayout,
    minPricePerDistance: settings.minRatePerMile || null,
    driverTypeFilters: [],
    uiiaCertificationsFilter: [],
    workOpportunityOperatingRegionFilter: [],
    loadingTypeFilters: [],
    maximumNumberOfStops: null,
    workOpportunityAccessType: null,
    sortByField: "startTime",
    sortOrder: "asc",
    visibilityStatusType: "ALL",
    categorizedEquipmentTypeList: categorizedEquipment,
    categorizedEquipmentTypeListForFilterPills: [{
      equipmentCategory: "PROVIDED",
      equipmentsList: ["FIFTY_THREE_FOOT_TRUCK"]
    }],
    nextItemToken: 0,
    resultSize: settings.resultSize,
    searchURL: "",
    savedSearchId: settings.savedSearchId || "",
    isAutoRefreshCall: false,
    notificationId: "",
    auditContextMap: JSON.stringify(auditContext)
  };
}

function buildBookPath(workOpportunity) {
  const { id, version, optionId, majorVersion } = extractBookingIdentifiers(workOpportunity);
  return `/${id}/${String(version)}/option/${String(optionId)}/majorVersion/${String(majorVersion)}`;
}

function buildBookBodyFromSearch(searchJson, workOpportunity, auditContextMap) {
  const auditId = searchJson?.searchAuditId || "";
  const { id, version, optionId, majorVersion } = extractBookingIdentifiers(workOpportunity);
  return {
    workOpportunityId: id,
    version,
    majorVersion,
    searchAuditId: auditId,
    workOpportunityType: workOpportunity.workOpportunityType || "ONE_WAY",
    workOpportunityOptionId: optionId,
    matchDeviationDetailsList: buildMatchDeviationList(workOpportunity),
    shipperAccountList: extractShipperAccounts(workOpportunity),
    totalCost: buildTotalCostSnapshot(workOpportunity),
    aggregatedCostItems: Array.isArray(workOpportunity.aggregatedCostItems) ? workOpportunity.aggregatedCostItems : [],
    auditContextMap: resolveAuditContextMap(auditContextMap, searchJson)
  };
}

function extractBookingIdentifiers(workOpportunity) {
  if (!workOpportunity || typeof workOpportunity !== "object") {
    throw new Error("Invalid workOpportunity payload");
  }
  const id = ensureBookingField(workOpportunity.id, "workOpportunityId");
  const version = ensureBookingField(workOpportunity.version, "version", id);
  const optionId = ensureBookingField(workOpportunity.workOpportunityOptionId, "workOpportunityOptionId", id);
  const majorVersion = ensureBookingField(workOpportunity.majorVersion, "majorVersion", id);
  return { id, version, optionId, majorVersion };
}

function ensureBookingField(value, field, workOpportunityId = "unknown") {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing ${field} for workOpportunity ${workOpportunityId}`);
  }
  return value;
}

async function submitBookingRequest(workOpportunity, searchData, csrf, auditContextMap) {
  const body = buildBookBodyFromSearch(searchData, workOpportunity, auditContextMap);
  return sendMessageToRelayTab({
    target: "content",
    type: "RUN_BOOK",
    path: `${BOOK_ENDPOINT_ROOT}${buildBookPath(workOpportunity)}`,
    body,
    csrf
  });
}

function shouldRetryBooking(response) {
  if (!response) return false;
  if (response.status === 409 || response.status === 412) return true;
  const errorText = typeof response.error === "string" ? response.error.toLowerCase() : "";
  return errorText.includes("version_changed") || errorText.includes("version changed");
}

function buildBookingError(response) {
  if (response instanceof Error) return response;
  const status = response?.status;
  const message = typeof response?.error === "string" && response.error.trim().length > 0
    ? response.error.trim()
    : `Booking failed ${status || "tab-error"}`;
  const error = new Error(message);
  if (status) error.status = status;
  return error;
}

function hasBookingIdentifiers(workOpportunity) {
  if (!workOpportunity || typeof workOpportunity !== "object") return false;
  return Boolean(
    workOpportunity.id &&
    workOpportunity.workOpportunityOptionId != null &&
    workOpportunity.version != null &&
    workOpportunity.majorVersion != null
  );
}

function resolveAuditContextMap(explicitMap, searchJson) {
  const fromExplicit = sanitizeAuditContextMap(explicitMap);
  if (fromExplicit) return fromExplicit;
  const fromSearch = sanitizeAuditContextMap(searchJson?.auditContextMap);
  if (fromSearch) return fromSearch;
  return buildDefaultAuditContextString();
}

function sanitizeAuditContextMap(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

function buildDefaultAuditContextString() {
  return JSON.stringify(buildAuditContextObject());
}

function buildAuditContextObject() {
  return {
    rlbChannel: "EXACT_MATCH",
    isOriginCityLive: "false",
    isDestinationCityLive: "false",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "RelayAuto/ServiceWorker",
    source: "AVAILABLE_WORK"
  };
}

function buildTotalCostSnapshot(workOpportunity) {
  const payout = normalizeMonetaryAmount(workOpportunity?.payout);
  if (payout) return payout;

  const aggregated = Array.isArray(workOpportunity?.aggregatedCostItems) ? workOpportunity.aggregatedCostItems : [];
  if (aggregated.length) {
    let total = 0;
    let unit = null;
    let hasValue = false;
    for (const item of aggregated) {
      const amount = normalizeMonetaryAmount(item?.monetaryAmount);
      if (!amount) continue;
      total += amount.value;
      if (!unit && amount.unit) {
        unit = amount.unit;
      }
      hasValue = true;
    }
    if (hasValue) {
      return { value: total, unit: unit || payout?.unit || "USD" };
    }
  }

  return null;
}

function normalizeMonetaryAmount(monetary) {
  if (!monetary || typeof monetary !== "object") return null;
  const value = Number(monetary.value);
  if (!Number.isFinite(value)) return null;
  const unit = monetary.unit || monetary.currencyCode || monetary.currency || "USD";
  return { value, unit };
}

function extractShipperAccounts(workOpportunity) {
  if (!workOpportunity) return [];
  if (Array.isArray(workOpportunity.shipperAccountList) && workOpportunity.shipperAccountList.length) {
    return workOpportunity.shipperAccountList;
  }

  const loads = Array.isArray(workOpportunity.loads) ? workOpportunity.loads : [];
  for (const load of loads) {
    if (Array.isArray(load?.loadShipperAccounts) && load.loadShipperAccounts.length) {
      return load.loadShipperAccounts;
    }
  }

  return [];
}

function buildMatchDeviationList(workOpportunity) {
  if (!workOpportunity) return [];
  if (Array.isArray(workOpportunity.matchDeviationDetails) && workOpportunity.matchDeviationDetails.length) {
    return workOpportunity.matchDeviationDetails;
  }
  if (Array.isArray(workOpportunity.matchDeviationDetailsList) && workOpportunity.matchDeviationDetailsList.length) {
    return workOpportunity.matchDeviationDetailsList;
  }
  return [];
}

function hasDynamicStartDate(settings) {
  return Number(settings?.earliestStartHours) > 0;
}

function computeEarliestStartDate(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  const future = new Date(Date.now() + h * 3600000);
  return future.toISOString();
}

poller = new RelayPoller();

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;
    for (const header of details.requestHeaders) {
      if (header.name && header.name.toLowerCase() === "x-csrf-token" && header.value) {
        setCsrf(header.value, "webRequest");
        break;
      }
    }
  },
  { urls: ["https://relay.amazon.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "bg") return;

  switch (msg.type) {
    case "GET_CSRF":
      respondAsync(getStoredCsrf().then((token) => ({ token })), sendResponse);
      return true;

    case "SET_CSRF":
      if (msg.token) setCsrf(msg.token, msg.source || "content");
      sendResponse({ ok: true });
      return false;

    case "REGISTER_CONTENT":
      if (sender.tab && sender.tab.id != null) {
        subscribers.set(sender.tab.id, Date.now());
        primaryTabId = sender.tab.id;
        resolvePendingTab(sender.tab.id);
        sendResponse({ ok: true, status: poller.status() });
      }
      return false;

    case "POLL_START":
      respondAsync(poller.start(msg.settings || {}), sendResponse);
      return true;

    case "POLL_STOP":
      respondAsync(poller.stop(), sendResponse);
      return true;

    case "POLL_ONCE":
      console.log("[SW] Received POLL_ONCE", msg.settings);
      respondAsync(poller.pollOnce(msg.settings), sendResponse);
      return true;

    case "GET_STATUS":
      sendResponse({ ok: true, status: poller.status() });
      return false;

    case "SSE_EVENT":
      poller.handleSseWake(msg.detail || {});
      sendResponse({ ok: true });
      return false;

    case "OFFSCREEN_READY":
      sendResponse({ ok: true, streamUrl: poller.getSseUrl() });
      return false;

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  subscribers.delete(tabId);
  if (primaryTabId === tabId) {
    primaryTabId = null;
  }
  rejectPendingTab(tabId, new Error("Relay tab closed"));
});

chrome.runtime.onSuspend?.addListener(() => {
  poller.stop();
});

function decodeBase64(str) {
  if (!str) return new Uint8Array();
  const binary = atob(str);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
