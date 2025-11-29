const AUTH_KEY = "hiring_auth_token";
const GRAPHQL_ENDPOINT = "https://e5mquma77feepi2bdn4d6h3mpu.appsync-api.us-east-1.amazonaws.com/graphql";
const JOB_QUERY = `
  query searchJobCardsByLocation($searchJobRequest: SearchJobRequest!) {
    searchJobCardsByLocation(searchJobRequest: $searchJobRequest) {
      nextToken
      jobCards {
        jobId
        jobTitle
        jobType
        employmentType
        city
        state
        locationName
        totalPayRateMin
        totalPayRateMax
        currencyCode
        distance
        featuredJob
        bonusJob
        scheduleCount
        geoClusterDescription
        surgePay
        tagLine
        payFrequency
        __typename
      }
      __typename
    }
  }
`;

const PUSHOVER_TOKEN = "a3wvzek7edab5dwock8odbii2mj7pb";
const PUSHOVER_USER = "u3nv828bbvf5v2vkfi3nqphp2nnvxo";

const DEFAULT_SETTINGS = {
  locale: "en-CA",
  country: "Canada",
  latitude: 51.045113,
  longitude: -114.057141,
  distanceKm: 150,
  pageSize: 50,
  minPayRate: 20,
  fastMs: 5000,
  earliestStartHours: 0,
  keywords: ""
};

const subscribers = new Map();
let primaryTabId = null;
let cachedAuth = null;
let authTimestamp = 0;
const AUTH_TTL = 15 * 60 * 1000;

const poller = new class HiringPoller {
  constructor() {
    this.running = false;
    this.settings = { ...DEFAULT_SETTINGS };
    this.metrics = this.createMetrics();
    this.controller = null;
    this.lastJobs = null;
    this.waitResolve = null;
    this.waitTimeout = null;
    this.notifiedJobs = new Set();
    this.notificationOrder = [];
  }

  createMetrics() {
    return {
      polls: 0,
      jobsFound: 0,
      qualified: 0,
      errors: 0,
      lastError: null,
      lastDuration: 0
    };
  }

  status() {
    return {
      running: this.running,
      settings: this.settings,
      metrics: this.metrics,
      lastJobs: this.lastJobs
    };
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

  async start(settings = {}) {
    const stored = await readSyncSettings();
    this.settings = sanitizeSettings({ ...stored, ...settings });
    if (this.running) {
      this.broadcast("POLL_STATUS", this.status());
      return;
    }

    const hasTab = await ensureHiringTab();
    if (!hasTab) {
      throw new Error("Open hiring.amazon.ca/app#/jobSearch first");
    }

    this.running = true;
    this.metrics = this.createMetrics();
    this.loop();
    this.broadcast("POLL_STATUS", this.status());
  }

  async stop() {
    this.running = false;
    if (this.controller) {
      try { this.controller.abort(); } catch (_) {}
      this.controller = null;
    }
    this.cancelPendingWait();
    this.broadcast("POLL_STATUS", this.status());
  }

  async loop() {
    while (this.running) {
      const loopStart = performance.now();
      let hadError = false;
      this.controller = new AbortController();

      try {
        const auth = await ensureAuthToken();
        if (!this.running) break;
        if (!auth) throw new Error("Missing Authorization token");

        const payload = buildSearchPayload(this.settings);
        const response = await runSearchInTab(payload, auth, this.settings, this.controller.signal);
        if (!this.running) break;
        this.handleResults(response);
      } catch (error) {
        hadError = true;
        this.metrics.errors += 1;
        this.metrics.lastError = error?.message || String(error);
        console.warn("[Hiring SW] poll error:", error);
        this.broadcast("POLL_ERROR", { message: this.metrics.lastError });
      } finally {
        this.controller = null;
      }

      const elapsed = performance.now() - loopStart;
      this.metrics.lastDuration = elapsed;
      if (!this.running) break;
      await this.waitForNext(elapsed, hadError);
    }
  }

  async waitForNext(elapsed, hadError) {
    const pollMs = Math.max(1000, Number(this.settings.fastMs) || 5000);
    let delay = Math.max(0, pollMs - elapsed);
    if (hadError) {
      delay = Math.max(delay, Math.min(8000, pollMs * 1.5));
    }
    if (delay <= 0) return;
    await new Promise((resolve) => {
      this.waitResolve = () => {
        if (this.waitTimeout) clearTimeout(this.waitTimeout);
        this.waitTimeout = null;
        this.waitResolve = null;
        resolve();
      };
      this.waitTimeout = setTimeout(this.waitResolve, delay);
    });
  }

  cancelPendingWait() {
    if (this.waitResolve) {
      this.waitResolve();
    }
  }

  handleResults(response) {
    const jobCards = response?.jobCards || [];
    this.metrics.polls += 1;
    this.metrics.jobsFound += jobCards.length;

    const qualified = jobCards.filter((job) => {
      const minRate = Number(job.totalPayRateMin) || 0;
      return minRate >= this.settings.minPayRate;
    });
    this.metrics.qualified += qualified.length;

    this.lastJobs = {
      receivedAt: Date.now(),
      total: jobCards.length,
      qualified
    };

    this.broadcast("POLL_RESULTS", {
      total: jobCards.length,
      qualified
    });

    const freshJobs = qualified.filter((job) => job?.jobId && !this.notifiedJobs.has(job.jobId));
    if (freshJobs.length) {
      freshJobs.forEach((job) => this.trackNotifiedJob(job.jobId));
      this.broadcast("NEW_JOBS", { jobs: freshJobs });
      this.notifyNewJobs(freshJobs).catch((error) => {
        console.warn("[Hiring SW] pushover error:", error.message || error);
      });
    }

    this.broadcast("POLL_STATUS", this.status());
  }

  trackNotifiedJob(jobId) {
    if (!jobId) return;
    this.notifiedJobs.add(jobId);
    this.notificationOrder.push(jobId);
    if (this.notificationOrder.length > 200) {
      const removed = this.notificationOrder.shift();
      if (removed) this.notifiedJobs.delete(removed);
    }
  }

  async notifyNewJobs(jobs) {
    if (!PUSHOVER_TOKEN || !PUSHOVER_USER || !jobs.length) return;
    const summaryLines = jobs.slice(0, 3).map((job) => {
      const pay = job.totalPayRateMin ? `$${Math.round(job.totalPayRateMin)}` : "";
      return `${job.jobTitle || "Job"} ${pay} ${job.locationName || job.city || ""}`.trim();
    });
    const title = jobs.length === 1 ? "Found 1 job" : `Found ${jobs.length} jobs`;
    const message = `${title} near ${this.settings.country}\n${summaryLines.join("\n")}`.trim();
    await sendPushover(message);
  }
}();

function sanitizeSettings(input = {}) {
  const result = { ...DEFAULT_SETTINGS };
  result.locale = typeof input.locale === "string" ? input.locale : DEFAULT_SETTINGS.locale;
  result.country = typeof input.country === "string" ? input.country : DEFAULT_SETTINGS.country;
  result.latitude = Number.isFinite(input.latitude) ? input.latitude : DEFAULT_SETTINGS.latitude;
  result.longitude = Number.isFinite(input.longitude) ? input.longitude : DEFAULT_SETTINGS.longitude;
  result.distanceKm = clamp(Number(input.distanceKm), 5, 500, DEFAULT_SETTINGS.distanceKm);
  result.pageSize = clamp(Number(input.pageSize), 10, 200, DEFAULT_SETTINGS.pageSize);
  result.minPayRate = clamp(Number(input.minPayRate), 0, 1000, DEFAULT_SETTINGS.minPayRate);
  result.fastMs = clamp(Number(input.fastMs), 1000, 60000, DEFAULT_SETTINGS.fastMs);
  result.earliestStartHours = clamp(Number(input.earliestStartHours), 0, 720, DEFAULT_SETTINGS.earliestStartHours);
  result.keywords = typeof input.keywords === "string" ? input.keywords.trim() : "";
  return result;
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function buildSearchPayload(settings) {
  const payload = {
    locale: settings.locale,
    country: settings.country,
    keyWords: settings.keywords || "",
    equalFilters: [],
    containFilters: [
      { key: "isPrivateSchedule", val: ["false"] }
    ],
    rangeFilters: [],
    orFilters: [],
    dateFilters: []
  };

  const startDate = computeStartDate(settings.earliestStartHours);
  if (startDate) {
    payload.dateFilters.push({
      key: "firstDayOnSite",
      range: { startDate }
    });
  }

  payload.sorters = [];
  payload.pageSize = settings.pageSize;
  payload.geoQueryClause = {
    lat: settings.latitude,
    lng: settings.longitude,
    unit: "km",
    distance: settings.distanceKm
  };
  return payload;
}

function computeStartDate(offsetHours) {
  const hours = Number(offsetHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const target = new Date(Date.now() + hours * 3600000);
  return target.toISOString().slice(0, 10);
}

async function runSearchInTab(searchPayload, authToken, settings, signal) {
  const response = await sendMessageToHiringTab({
    target: "content",
    type: "RUN_SEARCH",
    body: {
      operationName: "searchJobCardsByLocation",
      variables: { searchJobRequest: searchPayload },
      query: JOB_QUERY
    },
    headers: {
      authorization: authToken,
      country: settings.country,
      iscanary: "false",
      "accept-language": `${settings.locale},en;q=0.9`
    }
  }, signal);

  if (!response?.ok) {
    const error = new Error(response?.error || "search failed");
    error.status = response?.status;
    throw error;
  }

  const graph = response.data || {};
  if (Array.isArray(graph.errors) && graph.errors.length) {
    throw new Error(graph.errors[0]?.message || "GraphQL error");
  }

  const jobCards = graph.data?.searchJobCardsByLocation?.jobCards || [];
  return { jobCards };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSyncSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      if (chrome.runtime.lastError) {
        resolve(DEFAULT_SETTINGS);
      } else {
        resolve(items || DEFAULT_SETTINGS);
      }
    });
  });
}

function setAuthToken(token) {
  cachedAuth = token;
  authTimestamp = Date.now();
  chrome.storage.session.set({ [AUTH_KEY]: token }, () => {});
}

async function ensureAuthToken() {
  if (cachedAuth && Date.now() - authTimestamp < AUTH_TTL) {
    return cachedAuth;
  }

  const stored = await new Promise((resolve) => {
    chrome.storage.session.get(AUTH_KEY, (items) => resolve(items?.[AUTH_KEY]));
  });
  if (stored) {
    cachedAuth = stored;
    authTimestamp = Date.now();
    return stored;
  }

  const response = await requestAuthFromTabs();
  if (response) {
    setAuthToken(response);
    return response;
  }
  return null;
}

async function requestAuthFromTabs() {
  try {
    const resp = await sendMessageToHiringTab({ target: "content", type: "REQUEST_AUTH" });
    return resp?.token || null;
  } catch {
    return null;
  }
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

async function ensureHiringTab() {
  if (subscribers.size > 0) return true;
  const tabs = await chrome.tabs.query({ url: "https://hiring.amazon.ca/*" });
  subscribers.clear();
  primaryTabId = null;
  if (tabs.length) {
    for (const tab of tabs) {
      if (tab.id != null) subscribers.set(tab.id, Date.now());
    }
    primaryTabId = tabs[0]?.id ?? null;
    return true;
  }
  return false;
}

function sendMessageToTab(tabId, payload, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal) {
      if (signal.aborted) {
        return onAbort();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function sendMessageToHiringTab(payload, signal) {
  let tabId = getPrimaryTabId();
  if (tabId == null) {
    const hasTab = await ensureHiringTab();
    if (!hasTab) {
      throw new Error("Open hiring.amazon.ca/app#/jobSearch first");
    }
    tabId = getPrimaryTabId();
  }
  return sendMessageToTab(tabId, payload, signal);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "bg") return;

  switch (msg.type) {
    case "REGISTER_CONTENT":
      if (sender.tab && sender.tab.id != null) {
        subscribers.set(sender.tab.id, Date.now());
        primaryTabId = sender.tab.id;
        sendResponse({ ok: true, status: poller.status() });
      }
      return false;
    case "SET_AUTH":
      if (msg.token) setAuthToken(msg.token);
      sendResponse({ ok: true });
      return false;
    case "POLL_START":
      respondAsync(poller.start(msg.settings || {}), sendResponse);
      return true;
    case "POLL_STOP":
      respondAsync(poller.stop(), sendResponse);
      return true;
    case "GET_STATUS":
      sendResponse({ ok: true, status: poller.status() });
      return false;
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  subscribers.delete(tabId);
  if (primaryTabId === tabId) primaryTabId = null;
});

function respondAsync(promise, sendResponse) {
  promise
    .then((payload) => sendResponse({ ok: true, ...(payload || {}) }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
}

async function sendPushover(message) {
  const params = new URLSearchParams({
    token: PUSHOVER_TOKEN,
    user: PUSHOVER_USER,
    message
  });

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Pushover error ${response.status}`);
  }
}
