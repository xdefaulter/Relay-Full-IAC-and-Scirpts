const DEFAULTS = {
  origin_name: "BRAMPTON",
  origin_state: "ON",
  origin_lat: 43.7882,
  origin_lng: -79.73719,
  origin_display: "BRAMPTON, ON",
  radius: 50,
  resultSize: 2,
  minPayout: 375,
  maxDistance: 192,
  fastMs: 300,
  phaseMs: 0,
  startDelayMs: 120000,
  stopOnFirstLoad: true,
  earliestStartHours: 0
};

const RELAY_ORIGINS = ["https://relay.amazon.com/*"];

const els = {
  name: document.getElementById("origin_name"),
  state: document.getElementById("origin_state"),
  lat: document.getElementById("origin_lat"),
  lng: document.getElementById("origin_lng"),
  disp: document.getElementById("origin_display"),
  radius: document.getElementById("radius"),
  resultSize: document.getElementById("resultSize"),
  minPayout: document.getElementById("minPayout"),
  maxDistance: document.getElementById("maxDistance"),
  fastMs: document.getElementById("fastMs"),
  phaseMs: document.getElementById("phaseMs"),
  startDelayMs: document.getElementById("startDelayMs"),
  earliestStart: document.getElementById("earliestStartHours"),
  stopOnFirstLoad: document.getElementById("stopOnFirstLoad"),
  status: document.getElementById("status"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  save: document.getElementById("save"),
  grant: document.getElementById("grantAccess")
};

function loadUI(v) {
  els.name.value = v.origin?.name ?? DEFAULTS.origin_name;
  els.state.value = v.origin?.stateCode ?? DEFAULTS.origin_state;
  els.lat.value = v.origin?.latitude ?? DEFAULTS.origin_lat;
  els.lng.value = v.origin?.longitude ?? DEFAULTS.origin_lng;
  els.disp.value = v.origin?.displayValue ?? DEFAULTS.origin_display;
  els.radius.value = v.radius ?? DEFAULTS.radius;
  els.resultSize.value = v.resultSize ?? DEFAULTS.resultSize;
  els.minPayout.value = v.minPayout ?? DEFAULTS.minPayout;
  els.maxDistance.value = v.maxDistance ?? DEFAULTS.maxDistance;
  els.fastMs.value = v.fastMs ?? DEFAULTS.fastMs;
  els.phaseMs.value = v.phaseMs ?? DEFAULTS.phaseMs;
  els.startDelayMs.value = v.startDelayMs ?? DEFAULTS.startDelayMs;
  els.earliestStart.value = v.earliestStartHours ?? DEFAULTS.earliestStartHours;
  els.stopOnFirstLoad.checked = v.stopOnFirstLoad ?? DEFAULTS.stopOnFirstLoad;
}

function validateNumber(value, min, max, defaultVal, name) {
  const num = Number(value);
  if (isNaN(num)) {
    throw new Error(`${name} must be a valid number`);
  }
  if (num < min || num > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return num;
}

function gatherSettings() {
  try {
    const latitude = validateNumber(els.lat.value, -90, 90, DEFAULTS.origin_lat, "Latitude");
    const longitude = validateNumber(els.lng.value, -180, 180, DEFAULTS.origin_lng, "Longitude");
    const radius = validateNumber(els.radius.value, 1, 500, DEFAULTS.radius, "Radius");
    const resultSize = validateNumber(els.resultSize.value, 1, 200, DEFAULTS.resultSize, "Result Size");
    const minPayout = validateNumber(els.minPayout.value, 0, 10000, DEFAULTS.minPayout, "Min Payout");
    const maxDistance = validateNumber(els.maxDistance.value, 1, 3000, DEFAULTS.maxDistance, "Max Distance");
    const fastMs = Math.max(10, validateNumber(els.fastMs.value, 10, 60000, DEFAULTS.fastMs, "Poll Interval"));
    const phaseMs = Math.max(0, validateNumber(els.phaseMs.value, 0, 60000, DEFAULTS.phaseMs, "Phase Offset"));
    const startDelayMs = Math.max(0, validateNumber(els.startDelayMs.value, 0, 600000, DEFAULTS.startDelayMs, "Start Delay"));
    const earliestStartHours = Math.max(0, validateNumber(els.earliestStart.value, 0, 72, DEFAULTS.earliestStartHours, "Earliest Start Hours"));

    const name = (els.name.value || "").trim();
    const stateCode = (els.state.value || "").trim();
    const displayValue = (els.disp.value || "").trim();

    if (!name || name.length > 100 || !/^[a-zA-Z0-9\s\-,.]+$/.test(name)) {
      throw new Error("Invalid Origin Name");
    }
    if (!stateCode || stateCode.length !== 2 || !/^[A-Z]{2}$/.test(stateCode)) {
      throw new Error("State Code must be 2 uppercase letters");
    }
    if (!displayValue || displayValue.length > 200) {
      throw new Error("Invalid Display Value");
    }

    return {
      origin: {
        name,
        stateCode,
        latitude,
        longitude,
        displayValue
      },
      radius,
      resultSize,
      minPayout,
      maxDistance,
      fastMs,
      phaseMs,
      startDelayMs,
      earliestStartHours,
      stopOnFirstLoad: !!els.stopOnFirstLoad.checked
    };
  } catch (err) {
    setStatus(`Validation error: ${err.message}`);
    throw err;
  }
}

function setStatus(t) { els.status.textContent = "status: " + t; }

function hasSiteAccess() {
  if (!chrome.permissions?.contains) return Promise.resolve(true);
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: RELAY_ORIGINS }, (granted) => resolve(!!granted));
  });
}

function requestSiteAccess() {
  if (!chrome.permissions?.request) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: RELAY_ORIGINS }, (granted) => resolve(!!granted));
  });
}

async function updateAccessUI() {
  const allowed = await hasSiteAccess();
  if (els.grant) {
    els.grant.hidden = allowed;
  }
  return allowed;
}

function summarizeInfra(status = {}) {
  const native = status.native?.connected ? "native:on" : "native:off";
  const sse = status.sse?.connected ? "sse:on" : "sse:off";
  return `${native} · ${sse}`;
}

function refreshStatusUI() {
  chrome.runtime.sendMessage({ target: "bg", type: "GET_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) {
      console.warn("[Relay Popup] status fetch failed:", chrome.runtime.lastError.message);
      setStatus("background unreachable");
      return;
    }
    const state = resp?.status;
    if (!state) {
      setStatus("no status");
      return;
    }
    const base = state.running ? "background running" : "idle";
    setStatus(`${base} · ${summarizeInfra(state)}`);
  });
}

function sendBgCommand(type, details = {}) {
  chrome.runtime.sendMessage({ target: "bg", type, ...details }, () => {
    if (chrome.runtime.lastError) {
      setStatus(`Error: ${chrome.runtime.lastError.message}`);
    } else {
      setTimeout(refreshStatusUI, 200);
    }
  });
}

function saveSettings(s, callback) {
  // Try sync first
  chrome.storage.sync.set(s, () => {
    if (chrome.runtime.lastError) {
      console.warn("[Relay Popup] sync save failed, trying local:", chrome.runtime.lastError.message);
      // Fallback to local
      chrome.storage.local.set(s, () => {
        if (chrome.runtime.lastError) {
          console.error("[Relay Popup] local save failed:", chrome.runtime.lastError.message);
          if (callback) callback(chrome.runtime.lastError);
        } else {
          if (callback) callback(null);
        }
      });
    } else {
      if (callback) callback(null);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Try sync first, then local
  chrome.storage.sync.get(null, (cfg) => {
    if (chrome.runtime.lastError) {
      console.warn("Sync storage read failed, trying local");
      chrome.storage.local.get(null, (localCfg) => {
        loadSettings(localCfg || {});
      });
    } else {
      loadSettings(cfg || {});
    }
  });

  function loadSettings(cfg) {
    // Normalize structure for UI
    loadUI({
      origin: cfg.origin || {
        name: DEFAULTS.origin_name,
        stateCode: DEFAULTS.origin_state,
        latitude: DEFAULTS.origin_lat,
        longitude: DEFAULTS.origin_lng,
        displayValue: DEFAULTS.origin_display
      },
      radius: cfg.radius ?? DEFAULTS.radius,
      resultSize: cfg.resultSize ?? DEFAULTS.resultSize,
      minPayout: cfg.minPayout ?? DEFAULTS.minPayout,
      maxDistance: cfg.maxDistance ?? DEFAULTS.maxDistance,
      fastMs: cfg.fastMs ?? DEFAULTS.fastMs,
      phaseMs: cfg.phaseMs ?? DEFAULTS.phaseMs,
      startDelayMs: cfg.startDelayMs ?? DEFAULTS.startDelayMs,
      earliestStartHours: cfg.earliestStartHours ?? DEFAULTS.earliestStartHours,
      stopOnFirstLoad: cfg.stopOnFirstLoad ?? DEFAULTS.stopOnFirstLoad
    });
  }

  els.save.onclick = () => {
    console.log("[Relay Popup] Save button clicked");
    try {
      const s = gatherSettings();
      console.log("[Relay Popup] Settings to save:", s);
      saveSettings(s, (err) => {
        if (err) {
          setStatus(`Save error: ${err.message}`);
        } else {
          console.log("[Relay Popup] Settings saved successfully");
          setStatus("settings saved");
        }
      });
    } catch (err) {
      console.error("[Relay Popup] Validation error:", err);
      // Validation error already shown in gatherSettings
    }
  };

  els.start.onclick = async () => {
    console.log("[Relay Popup] Start button clicked");
    try {
      const hasAccess = await updateAccessUI();
      if (!hasAccess) {
        setStatus("Requesting Chrome site access…");
        const granted = await requestSiteAccess();
        await updateAccessUI();
        if (!granted) {
          setStatus("Grant site access to relay.amazon.com to run");
          return;
        }
      }

      const s = gatherSettings();
      console.log("[Relay Popup] Settings to save before starting:", s);
      setStatus("saving settings...");

      // Ensure settings save completes before starting
      saveSettings(s, (err) => {
        if (err) {
          setStatus(`Save error: ${err.message}`);
          return;
        }

        console.log("[Relay Popup] Settings saved, starting background poller...");
        sendBgCommand("POLL_START", { settings: s });
        setStatus("requested start");
      });
    } catch (err) {
      console.error("[Relay Popup] Validation error:", err);
      // Validation error already shown in gatherSettings
    }
  };

  els.stop.onclick = () => {
    console.log("[Relay Popup] Stop button clicked");
    sendBgCommand("POLL_STOP");
    setStatus("stopping...");
  };

  if (els.grant) {
    els.grant.onclick = async () => {
      setStatus("Requesting Chrome site access…");
      const granted = await requestSiteAccess();
      await updateAccessUI();
      if (granted) {
        setStatus("site access granted");
      } else {
        setStatus("Chrome still blocking site access");
      }
    };
  }

  // Pull background status so the popup reflects reality
  updateAccessUI().then(() => refreshStatusUI());
});
