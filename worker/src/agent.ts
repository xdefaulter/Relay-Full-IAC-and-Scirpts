import WebSocket from "ws";
import { chromium, Browser, BrowserContext, Page } from "playwright";

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
let context: BrowserContext | null = null;
let page: Page | null = null;
let failureStreak = 0;
let wsRetryCount = 0;
const MAX_WS_RETRY_DELAY = 30000;

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

async function startChrome() {
    console.log("Starting Chrome with Playwright...");

    // Cleanup previous instances
    try {
        try {
            execSync("pkill -f google-chrome");
        } catch (e) {
            // Ignore if no process found
        }

        const userDataDir = "/home/pptruser/chrome-profile";
        const lockFile = path.join(userDataDir, "SingletonLock");
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
        }
    } catch (e) {
        console.warn("Cleanup warning:", e);
    }

    try {
        // Launch browser with persistent context (better extension support)
        context = await chromium.launchPersistentContext("/home/pptruser/chrome-profile", {
            headless: false, // Running with Xvfb virtual display
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-setuid-sandbox",
                "--no-zygote",
                `--disable-extensions-except=/opt/relay-extension`,
                `--load-extension=/opt/relay-extension`,
            ],
            // Playwright automatically sets DISPLAY for Xvfb
        });

        console.log("Browser context created, getting page...");

        // Get existing page or create new one
        const pages = context.pages();
        page = pages.length > 0 ? pages[0] : await context.newPage();

        // Capture page logs and errors
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

        // Set cookies if provided
        let cookiesStr = process.env.RELAY_COOKIES;
        if (process.env.RELAY_COOKIES_B64) {
            try {
                cookiesStr = Buffer.from(process.env.RELAY_COOKIES_B64, 'base64').toString('utf-8');
            } catch (e) {
                console.error("Failed to decode RELAY_COOKIES_B64:", e);
            }
        }

        if (cookiesStr) {
            try {
                const cookies = JSON.parse(cookiesStr);
                // Convert Puppeteer cookie format to Playwright format
                const playwrightCookies = cookies.map((c: any) => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    expires: c.expires || -1,
                    httpOnly: c.httpOnly || false,
                    secure: c.secure || false,
                    sameSite: c.sameSite || 'Lax'
                }));
                await context.addCookies(playwrightCookies);
                console.log(`Restored ${cookies.length} cookies.`);
            } catch (e) {
                console.error("Failed to parse RELAY_COOKIES:", e);
            }
        }

        // Check extensions
        try {
            await page.goto("chrome://extensions");
            await page.waitForTimeout(2000);
            const extensions = await page.evaluate(() => document.body.innerText);
            console.log("EXTENSIONS PAGE CONTENT:", extensions);
        } catch (e) {
            console.log("Failed to check extensions page:", e);
        }

        console.log("Navigating to relay.amazon.com/tours/loadboard...");
        try {
            await page.goto("https://relay.amazon.com/tours/loadboard", { waitUntil: "networkidle", timeout: 60000 });
            console.log("Navigation complete. Current URL:", page.url());

            // Login Logic
            if (page.url().includes("login") || page.url().includes("signin")) {
                console.log("Login page detected. Attempting login...");
                if (USERNAME && PASSWORD) {
                    try {
                        // Wait for email input
                        const emailSel = "#ap_email";
                        await page.waitForSelector(emailSel, { timeout: 10000 });
                        await page.fill(emailSel, USERNAME);

                        // Click Continue if it exists (for 2-step login)
                        const continueSel = "#continue";
                        const continueBtn = await page.$(continueSel);
                        if (continueBtn) {
                            await continueBtn.click();
                            await page.waitForTimeout(2000);
                        }

                        // Wait for password input
                        const passSel = "#ap_password";
                        await page.waitForSelector(passSel, { timeout: 10000 });
                        await page.fill(passSel, PASSWORD);

                        // Submit
                        const submitSel = "#signInSubmit";
                        await page.click(submitSel);
                        console.log("Login submitted, waiting for navigation...");
                        await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });
                        console.log("After login, current URL:", page.url());
                    } catch (loginErr) {
                        console.error("Login failed:", loginErr);
                    }
                } else {
                    console.warn("No USERNAME/PASSWORD provided for login.");
                }
            }
        } catch (navErr) {
            console.error("Navigation error:", navErr);
            throw navErr;
        }

        console.log("Chrome ready. URL:", page.url());
        return true;
    } catch (err) {
        console.error("Failed to start Chrome:", err);
        throw err;
    }
}

async function doPoll() {
    if (!page) {
        throw new Error("Page not initialized");
    }

    console.log("Triggering relay poll...");
    const result = await page.evaluate((opts) => {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("poll timeout")), 10000);

            window.postMessage(
                {
                    type: "RELAY_POLL_NOW",
                    settings: opts,
                },
                window.location.origin
            );

            const listener = (event: MessageEvent) => {
                if (event.origin !== window.location.origin) return;
                if (event.data?.type === "RELAY_POLL_RESPONSE") {
                    clearTimeout(timeout);
                    window.removeEventListener("message", listener);
                    resolve(event.data.result);
                }
            };
            window.addEventListener("message", listener);
        });
    }, {});

    console.log("Poll result:", result);
    return result;
}

function connectWS() {
    if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
        ws = null;
    }

    console.log(`Connecting to Manager at ${MANAGER_WS_URL}...`);
    ws = new WebSocket(MANAGER_WS_URL, {
        headers: {
            "x-worker-id": NODE_ID,
            "x-auth-secret": WS_SECRET,
        },
    });

    ws.on("open", () => {
        console.log("Connected to Manager");
        wsRetryCount = 0;

        // Send initial ready
        ws!.send(
            JSON.stringify({
                type: "ready",
                workerId: NODE_ID,
            })
        );
    });

    ws.on("message", async (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        console.log("Received message:", msg);

        if (msg.type === "poll") {
            try {
                const result = await doPoll();
                ws!.send(
                    JSON.stringify({
                        type: "poll_result",
                        ...result,
                    })
                );
                failureStreak = 0;
            } catch (err: any) {
                console.error("Poll error:", err);
                failureStreak++;
                ws!.send(
                    JSON.stringify({
                        type: "poll_error",
                        error: err.message || String(err),
                    })
                );

                if (failureStreak >= 5) {
                    console.error("Too many poll failures, restarting browser...");
                    await cleanup();
                    await startChrome();
                    failureStreak = 0;
                }
            }
        }
    });

    ws.on("close", () => {
        console.log("Disconnected from Manager");
        ws = null;

        // Exponential backoff
        wsRetryCount++;
        const delay = Math.min(1000 * Math.pow(2, wsRetryCount), MAX_WS_RETRY_DELAY);
        console.log(`Reconnecting in ${delay}ms (retry ${wsRetryCount})...`);
        setTimeout(() => connectWS(), delay);
    });

    ws.on("error", (err: Error) => {
        console.error("WebSocket error:", err.message);
    });
}

async function cleanup() {
    console.log("Cleaning up...");
    if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
    }
    if (page) {
        await page.close().catch(() => { });
        page = null;
    }
    if (context) {
        await context.close().catch(() => { });
        context = null;
    }
    if (browser) {
        await browser.close().catch(() => { });
        browser = null;
    }
}

async function main() {
    console.log(`Worker ${NODE_ID} starting...`);

    process.on("SIGTERM", async () => {
        console.log("SIGTERM received");
        await cleanup();
        process.exit(0);
    });

    process.on("SIGINT", async () => {
        console.log("SIGINT received");
        await cleanup();
        process.exit(0);
    });

    try {
        await startChrome();
        connectWS();
    } catch (err) {
        console.error("Fatal error:", err);
        await cleanup();
        process.exit(1);
    }
}

main();
