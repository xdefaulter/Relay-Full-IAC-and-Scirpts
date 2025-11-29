(function () {
  const HEADER_NAME = "authorization";
  const GRAPHQL_ENDPOINT = "https://e5mquma77feepi2bdn4d6h3mpu.appsync-api.us-east-1.amazonaws.com/graphql";
  let lastToken = null;

  function report(token, source) {
    if (!token || token === lastToken) return;
    lastToken = token;
    window.postMessage({ __hiringAuto__: true, type: "AUTH", token, source }, "*");
  }

  const originalFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    try {
      const headers = init?.headers || (typeof input !== "string" ? input.headers : null);
      const token = readHeader(headers, HEADER_NAME);
      if (token) report(token, "fetch");
    } catch {}

    const response = await originalFetch.apply(this, arguments);
    try {
      const hdr = response?.headers?.get?.(HEADER_NAME);
      if (hdr) report(hdr, "fetch-response");
    } catch {}
    return response;
  };

  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
    if (key && key.toLowerCase() === HEADER_NAME) {
      report(value, "xhr");
    }
    return originalSetHeader.call(this, key, value);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const payload = event?.data;
    if (!payload || payload.__hiringAutoCmd__ !== true) return;
    if (payload.type === "RUN_GRAPHQL" && payload.requestId != null) {
      executeGraphql(payload).catch((error) => {
        window.postMessage(
          { __hiringAutoResponse__: true, requestId: payload.requestId, ok: false, error: error.message || String(error) },
          "*"
        );
      });
    }
  });

  async function executeGraphql(cmd) {
    const body = typeof cmd.body === "string" ? cmd.body : JSON.stringify(cmd.body || {});
    const headers = {
      accept: "*/*",
      "content-type": "application/json",
      ...(cmd.headers || {})
    };

    const response = await window.fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers,
      body,
      credentials: "omit",
      mode: "cors"
    });
    const text = await response.text();
    window.postMessage(
      {
        __hiringAutoResponse__: true,
        requestId: cmd.requestId,
        ok: response.ok,
        status: response.status,
        body: text
      },
      "*"
    );
  }

  function readHeader(headers, name) {
    if (!headers) return null;
    if (headers instanceof Headers) {
      return headers.get(name);
    }
    if (Array.isArray(headers)) {
      const pair = headers.find(([k]) => String(k).toLowerCase() === name);
      return pair ? pair[1] : null;
    }
    if (typeof headers === "object") {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name) return headers[key];
      }
    }
    return null;
  }
})();
