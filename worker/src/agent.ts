import WebSocket from "ws";
import puppeteer, { Browser, Page } from "puppeteer";

const MANAGER_WS_URL = process.env.MANAGER_WS_URL!;
const NODE_ID = process.env.NODE_ID || `worker-${Math.random().toString(36).slice(2)}`;
const WS_SECRET = process.env.WS_SECRET || "";
const USERNAME = process.env.RELAY_USERNAME || "";
const PASSWORD = process.env.RELAY_PASSWORD || "";

if (!WS_SECRET) {
    console.warn("WARNING: WS_SECRET not set! Connection may be rejected by manager.");
}

let ws: WebSocket | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let failureStreak = 0;
let wsRetryCount = 0;
const MAX_WS_RETRY_DELAY = 30000;

async function startChrome() {
    console.log("Starting Chrome...");
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: "/usr/bin/google-chrome-stable",
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-setuid-sandbox",
                "--disable-extensions-except=/opt/relay-extension",
                "--load-extension=/opt/relay-extension",
                "--user-data-dir=/home/pptruser/chrome-profile",
            ],
            dumpio: true,
        });
        console.log("Browser launched, creating page...");
        page = await browser.newPage();
        console.log("Navigating to relay.amazon.com...");
        try {
            await page.goto("https://relay.amazon.com", { waitUntil: "networkidle2", timeout: 60000 });
            console.log("Navigation complete.");

            // Login Logic
            if (page.url().includes("login") || page.url().includes("signin")) {
                console.log("Login page detected. Attempting login...");
                if (USERNAME && PASSWORD) {
                    try {
                        // Wait for email input
                        const emailSel = "#ap_email";
                        await page.waitForSelector(emailSel, { timeout: 5000 });
                        await page.type(emailSel, USERNAME);

                        // Password
                        const passSel = "#ap_password";
                        await page.waitForSelector(passSel, { timeout: 5000 });
                        await page.type(passSel, PASSWORD);

                        // Submit
                        const submitSel = "#signInSubmit";
                        await page.waitForSelector(submitSel, { timeout: 5000 });
                        await page.click(submitSel);

                        console.log("Credentials submitted. Waiting for navigation...");
                        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });
                        console.log("Login navigation complete.");
                    } catch (e) {
                        console.error("Login automation failed:", e);
                    }
                } else {
                    console.warn("Login page detected but no credentials provided (RELAY_USERNAME/RELAY_PASSWORD).");
                }
            }

        } catch (e) {
            console.error("Navigation failed:", e);
        }
    } catch (e) {
        console.error("Chrome launch failed:", e);
    }
}

function sanitizeSettings(settings: any) {
    if (!settings || typeof settings !== "object") return {};
    // Whitelist only known safe primitives
    const safe: any = {};
    const allowedKeys = [
        "origin", "radius", "resultSize", "minPayout", "maxDistance",
        "fastMs", "stopOnFirstLoad", "autoBookFirst", "phaseMs",
        "savedSearchId", "minRatePerMile", "startDelayMs", "earliestStartHours"
    ];

    for (const key of allowedKeys) {
        if (key in settings) {
            safe[key] = settings[key];
        }
    }
    return safe;
}

async function doPoll(settings?: any) {
    if (!page) {
        console.warn("Page not ready, skipping poll");
        return;
    }
    const started = Date.now();
    const safeSettings = sanitizeSettings(settings);

    try {
        const loads = await page.evaluate((s) => {
            return new Promise((resolve, reject) => {
                window.postMessage({ type: "RELAY_POLL_NOW", settings: s }, "*");
                const timeout = setTimeout(() => {
                    reject(new Error("poll timeout"));
                }, 15000);
                window.addEventListener(
                    "message",
                    function handler(ev) {
                        if (ev.data && ev.data.type === "RELAY_POLL_RESULT") {
                            clearTimeout(timeout);
                            window.removeEventListener("message", handler);
                            resolve(ev.data.loads || []);
                        }
                    },
                    { once: true }
                );
            });
        }, safeSettings);

        const durationMs = Date.now() - started;
        failureStreak = 0;
        sendToManager({
            type: "poll_result",
            ok: true,
            durationMs,
            loads,
        });
    } catch (e: any) {
        failureStreak++;
        const durationMs = Date.now() - started;
        console.error("Poll error:", e);
        sendToManager({
            type: "poll_result",
            ok: false,
            durationMs,
            error: String(e),
        });

        if (failureStreak >= 5) {
            console.error("Too many failures, restarting browser");
            await restartBrowser();
            // Don't reset streak immediately, wait for a success
        }
    }
}

async function restartBrowser() {
    try {
        if (browser) await browser.close();
    } catch { }
    browser = null;
    page = null;

    // Add delay before restart to prevent rapid loops
    await new Promise(r => setTimeout(r, 5000));
    await startChrome();
}

function sendToManager(msg: any) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

let heartbeatInterval: NodeJS.Timeout | null = null;

function connectWs() {
    // Add authentication token to WebSocket URL
    const wsUrl = WS_SECRET
        ? `${MANAGER_WS_URL}?token=${encodeURIComponent(WS_SECRET)}`
        : MANAGER_WS_URL;

    ws = new WebSocket(wsUrl);
    ws.on("open", () => {
        console.log("Connected to manager");
        wsRetryCount = 0;
        sendToManager({ type: "hello", nodeId: NODE_ID });

        // Clear any existing interval just in case
        if (heartbeatInterval) clearInterval(heartbeatInterval);

        heartbeatInterval = setInterval(() => {
            sendToManager({ type: "heartbeat", ts: Date.now() });
        }, 10000);
    });
    ws.on("message", async (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "poll_now") {
            await doPoll(msg.settings);
        }
    });
    ws.on("close", () => {
        console.log("WS closed, reconnecting...");

        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        const delay = Math.min(1000 * Math.pow(2, wsRetryCount), MAX_WS_RETRY_DELAY);
        wsRetryCount++;
        setTimeout(connectWs, delay);
    });
    ws.on("error", (err) => {
        console.error("WS error:", err);
    });
}

(async () => {
    connectWs();
    await startChrome();

    process.on("SIGTERM", async () => {
        try {
            if (browser) await browser.close();
        } catch { }
        process.exit(0);
    });
})();
