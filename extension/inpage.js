// inpage.js — page context (not a content script)
// Hook fetch and XHR to capture x-csrf-token used by the app itself.

(function () {
  const CSRF_HEADER = "x-csrf-token";
  let lastCsrf = null;

  function report(token, source) {
    if (!token || token === lastCsrf) return;
    lastCsrf = token;
    window.postMessage({ __relayAuto__: true, type: "CSRF", token, source }, "*");
  }

  // Try cookies too (some apps mirror CSRF in a cookie)
  function sniffCookies() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)(?:csrf|xsrf|x-csrf-token|csrf-token)=([^;]+)/i);
      if (m) report(decodeURIComponent(m[1]), "cookie");
    } catch {}
  }
  sniffCookies();

  // Hook fetch
  const _fetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    try {
      const url = (typeof input === "string" ? input : input.url) || "";
      const hdrs = (init && init.headers) || (typeof input !== "string" ? input.headers : null);
      // read outgoing header
      if (hdrs) {
        let token = null;
        if (hdrs instanceof Headers) token = hdrs.get(CSRF_HEADER);
        else if (Array.isArray(hdrs)) {
          const found = hdrs.find(([k]) => String(k).toLowerCase() === CSRF_HEADER);
          if (found) token = found[1];
        } else if (typeof hdrs === "object") {
          for (const k of Object.keys(hdrs)) {
            if (k.toLowerCase() === CSRF_HEADER) { token = hdrs[k]; break; }
          }
        }
        if (token) report(token, "fetch-header");
      }
      const res = await _fetch.apply(this, arguments);
      // some stacks echo CSRF on response headers too
      try {
        const t = res.headers.get(CSRF_HEADER);
        if (t) report(t, "fetch-response");
      } catch {}
      return res;
    } catch (e) {
      return _fetch.apply(this, arguments);
    }
  };

  // Hook XHR
  (function () {
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    let lastHeaders = null;

    XMLHttpRequest.prototype.open = function () {
      lastHeaders = {};
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        lastHeaders[k] = v;
        if (k && k.toLowerCase() === CSRF_HEADER) report(v, "xhr-header");
      } catch {}
      return XMLHttpRequest.prototype.__proto__.setRequestHeader.call(this, k, v);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        // after send, read response headers when done
        this.addEventListener("readystatechange", function () {
          if (this.readyState === 2 /* HEADERS_RECEIVED */) {
            try {
              const t = this.getResponseHeader(CSRF_HEADER);
              if (t) report(t, "xhr-response");
            } catch {}
          }
        });
      } catch {}
      return _send.apply(this, arguments);
    };
  })();
})();
