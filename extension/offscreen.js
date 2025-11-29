const STREAM_RETRY_MS = 5000;
let eventSource = null;
let streamUrl = null;

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function bootstrap() {
  try {
    const response = await sendMessage({ target: "bg", type: "OFFSCREEN_READY" });
    streamUrl = response?.streamUrl;
    if (!streamUrl) {
      console.warn("[Offscreen] Missing stream URL");
      return;
    }
    startStream();
  } catch (error) {
    console.error("[Offscreen] bootstrap failed:", error);
  }
}

function startStream() {
  if (!streamUrl) return;
  try {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    eventSource = new EventSource(streamUrl, { withCredentials: true });
    eventSource.onopen = () => {
      sendMessage({ target: "bg", type: "SSE_EVENT", detail: { kind: "open" } }).catch(() => {});
    };
    eventSource.onmessage = (event) => {
      sendMessage({ target: "bg", type: "SSE_EVENT", detail: { kind: "message", data: event.data } }).catch(() => {});
    };
    eventSource.onerror = (error) => {
      sendMessage({
        target: "bg",
        type: "SSE_EVENT",
        detail: { kind: "error", error: error?.message || "EventSource error" }
      }).catch(() => {});
      eventSource?.close();
      eventSource = null;
      setTimeout(startStream, STREAM_RETRY_MS);
    };
  } catch (error) {
    console.error("[Offscreen] EventSource failed:", error);
    setTimeout(startStream, STREAM_RETRY_MS);
  }
}

bootstrap();
