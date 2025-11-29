const DEFAULTS = {
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

const els = {
  locale: document.getElementById("locale"),
  country: document.getElementById("country"),
  lat: document.getElementById("lat"),
  lng: document.getElementById("lng"),
  distance: document.getElementById("distance"),
  pageSize: document.getElementById("pageSize"),
  minPay: document.getElementById("minPay"),
  fastMs: document.getElementById("fastMs"),
  earliest: document.getElementById("earliest"),
  keywords: document.getElementById("keywords"),
  save: document.getElementById("save"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status")
};

function loadUI(cfg) {
  els.locale.value = cfg.locale ?? DEFAULTS.locale;
  els.country.value = cfg.country ?? DEFAULTS.country;
  els.lat.value = cfg.latitude ?? DEFAULTS.latitude;
  els.lng.value = cfg.longitude ?? DEFAULTS.longitude;
  els.distance.value = cfg.distanceKm ?? DEFAULTS.distanceKm;
  els.pageSize.value = cfg.pageSize ?? DEFAULTS.pageSize;
  els.minPay.value = cfg.minPayRate ?? DEFAULTS.minPayRate;
  els.fastMs.value = cfg.fastMs ?? DEFAULTS.fastMs;
  els.earliest.value = cfg.earliestStartHours ?? DEFAULTS.earliestStartHours;
  els.keywords.value = cfg.keywords ?? DEFAULTS.keywords;
}

function setStatus(text) {
  if (els.status) {
    els.status.textContent = `status: ${text}`;
  }
}

function gatherSettings() {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    locale: (els.locale.value || DEFAULTS.locale).trim(),
    country: (els.country.value || DEFAULTS.country).trim(),
    latitude: number(els.lat.value, DEFAULTS.latitude),
    longitude: number(els.lng.value, DEFAULTS.longitude),
    distanceKm: number(els.distance.value, DEFAULTS.distanceKm),
    pageSize: number(els.pageSize.value, DEFAULTS.pageSize),
    minPayRate: number(els.minPay.value, DEFAULTS.minPayRate),
    fastMs: number(els.fastMs.value, DEFAULTS.fastMs),
    earliestStartHours: number(els.earliest.value, DEFAULTS.earliestStartHours),
    keywords: (els.keywords.value || "").trim()
  };
}

function sendBgCommand(type, extra = {}) {
  chrome.runtime.sendMessage({ target: "bg", type, ...extra }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message);
    } else if (resp?.ok === false && resp.error) {
      setStatus(resp.error);
    } else {
      setTimeout(refreshStatus, 200);
    }
  });
}

function refreshStatus() {
  chrome.runtime.sendMessage({ target: "bg", type: "GET_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus("background unreachable");
      return;
    }
    const running = resp?.status?.running;
    setStatus(running ? "running" : "idle");
  });
}

chrome.storage.sync.get(DEFAULTS, (items) => {
  if (chrome.runtime.lastError) {
    setStatus(`load error: ${chrome.runtime.lastError.message}`);
    loadUI(DEFAULTS);
    return;
  }
  loadUI({ ...DEFAULTS, ...items });
  refreshStatus();
});

els.save.onclick = () => {
  const settings = gatherSettings();
  chrome.storage.sync.set(settings, () => {
    if (chrome.runtime.lastError) {
      setStatus(`save error: ${chrome.runtime.lastError.message}`);
    } else {
      setStatus("settings saved");
    }
  });
};

els.start.onclick = () => {
  const settings = gatherSettings();
  chrome.storage.sync.set(settings, () => {
    if (chrome.runtime.lastError) {
      setStatus(`save error: ${chrome.runtime.lastError.message}`);
      return;
    }
    setStatus("starting…");
    sendBgCommand("POLL_START", { settings });
  });
};

els.stop.onclick = () => {
  setStatus("stopping…");
  sendBgCommand("POLL_STOP");
};
