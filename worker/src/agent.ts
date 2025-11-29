import WebSocket from "ws";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const MANAGER_WS_URL = process.env.MANAGER_WS_URL!;
const NODE_ID = process.env.NODE_ID || `worker-${Math.random().toString(36).slice(2)}`;
const WS_SECRET = process.env.WS_SECRET || "";
const USERNAME = process.env.RELAY_USERNAME || "";
const PASSWORD = process.env.RELAY_PASSWORD || "";

if (!WS_SECRET) {
    console.warn("WARNING: WS_SECRET not set! Connection may be rejected by manager.");
}

// --- Types ---

interface RelaySettings {
    origin: {
        latitude: number;
        longitude: number;
        name: string;
        stateCode: string;
        displayValue: string;
    };
    radius: number;
    maxDistance: number;
    minPayout: number;
    resultSize: number;
    earliestStartHours: number;
    minRatePerMile?: number;
    savedSearchId?: string;
}

interface PollResult {
    ok: boolean;
    workOpportunities?: any[];
    error?: string;
    status?: number;
    duration?: number;
    parseDuration?: number;
    retryAfter?: string | null;
}

// --- State ---

let ws: WebSocket | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let failureStreak = 0;
let wsRetryCount = 0;
const MAX_WS_RETRY_DELAY = 30000;
let cachedCsrfToken: string | null = null;

// --- Helper Functions ---

function computeEarliestStartDate(hours: any): string | null {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) return null;
    const future = new Date(Date.now() + h * 3600000);
    return future.toISOString();
}

function buildAuditContextObject(userAgent: string) {
    return {
        rlbChannel: "EXACT_MATCH",
        isOriginCityLive: "false",
        isDestinationCityLive: "false",
        userAgent: userAgent,
        source: "AVAILABLE_WORK"
    };
}

function buildSlimPayload(settings: RelaySettings, userAgent: string) {
    const origin = settings.origin;
    if (!origin) throw new Error("Missing origin in settings");

    const radiusFilter = {
        cityLatitude: origin.latitude,
        cityLongitude: origin.longitude,
        cityName: origin.name,
        cityStateCode: origin.stateCode,
        cityDisplayValue: origin.displayValue,
        radius: settings.radius
    };

    const auditContext = buildAuditContextObject(userAgent);

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
        context = await chromium.launchPersistentContext("/home/pptruser/chrome-profile", {
            headless: false, // Running with Xvfb virtual display
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-setuid-sandbox",
                "--no-zygote",
            ],
            viewport: { width: 1280, height: 1024 }
        });

        console.log("Browser context created, getting page...");

        const pages = context.pages();
        page = pages.length > 0 ? pages[0] : await context.newPage();

        // Capture page logs and errors
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

        // Capture CSRF token from headers
        page.on('request', (request: any) => {
            const headers = request.headers();
            if (headers['x-csrf-token']) {
                if (cachedCsrfToken !== headers['x-csrf-token']) {
                    console.log("Captured new CSRF token from request headers");
                    cachedCsrfToken = headers['x-csrf-token'];
                }
            }
        });

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

        console.log("Navigating to relay.amazon.com/tours/loadboard...");
        try {
            await page.goto("https://relay.amazon.com/tours/loadboard", { waitUntil: "networkidle", timeout: 60000 });
            console.log("Navigation complete. Current URL:", page.url());

            // Check for login redirect
            if (page.url().includes("login") || page.url().includes("signin")) {
                console.log("Login page detected. Attempting login...");
                if (USERNAME && PASSWORD) {
                    try {
                        const emailSel = "#ap_email";
                        await page.waitForSelector(emailSel, { timeout: 10000 });
                        await page.fill(emailSel, USERNAME);

                        const continueSel = "#continue";
                        const continueBtn = await page.$(continueSel);
                        if (continueBtn) {
                            await continueBtn.click();
                            await page.waitForTimeout(2000);
                        }

                        const passSel = "#ap_password";
                        await page.waitForSelector(passSel, { timeout: 10000 });
                        await page.fill(passSel, PASSWORD);

                        const submitSel = "#signInSubmit";
                        await page.click(submitSel);
                        console.log("Login submitted, waiting for navigation...");
                        await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });
                        console.log("After login, current URL:", page.url());

                        // Check for CAPTCHA or OTP
                        const bodyText = await page.evaluate(() => document.body.innerText);
                        if (bodyText.includes("Solve this puzzle") || bodyText.includes("One Time Password")) {
                            console.error("CRITICAL: Login blocked by CAPTCHA or OTP. Manual intervention required.");
                        }

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

async function getCsrfToken(): Promise<string> {
    if (cachedCsrfToken) return cachedCsrfToken;

    if (!page) throw new Error("Page not initialized");

    // Try to get from cookies
    const cookies = await context!.cookies("https://relay.amazon.com");
    const csrfCookie = cookies.find((c: any) => c.name === "csrf-token" || c.name === "x-csrf-token");
    if (csrfCookie) {
        console.log("Found CSRF token in cookies");
        cachedCsrfToken = decodeURIComponent(csrfCookie.value);
        return cachedCsrfToken;
    }

    // Try to get from meta tag
    const metaToken = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : null;
    });

    if (metaToken) {
        console.log("Found CSRF token in meta tag");
        cachedCsrfToken = metaToken;
        return cachedCsrfToken;
    }

    throw new Error("Could not find CSRF token. Page might not be fully loaded or logged in.");
}

async function doPoll(settings: RelaySettings) {
    if (!page) {
        throw new Error("Page not initialized");
    }

    try {
        const csrf = await getCsrfToken();
        // Get actual User Agent from the page
        const userAgent = await page.evaluate(() => navigator.userAgent);
        const payload = buildSlimPayload(settings, userAgent);

        console.log("Executing search on page...");
        const result = await page.evaluate(async ({ payload, csrf }: { payload: any, csrf: string }) => {
            const headers: Record<string, string> = {
                "content-type": "application/json",
                "x-csrf-token": csrf,
                "save-data": "on"
            };

            const start = performance.now();
            try {
                const response = await fetch("/api/loadboard/search", {
                    method: "POST",
                    credentials: "include",
                    headers,
                    body: JSON.stringify(payload),
                    cache: "no-store",
                    keepalive: true
                });
                const duration = performance.now() - start;
                const text = await response.text();

                if (!response.ok) {
                    return {
                        ok: false,
                        error: text.slice(0, 200),
                        status: response.status,
                        retryAfter: response.headers.get("retry-after")
                    };
                }

                const parseStart = performance.now();
                const parsed = JSON.parse(text || "{}");
                const parseDuration = performance.now() - parseStart;

                return {
                    ok: true,
                    workOpportunities: parsed.workOpportunities || [],
                    duration,
                    parseDuration
                };
            } catch (fetchErr: any) {
                return {
                    ok: false,
                    error: fetchErr.message || "Network error",
                    status: 0
                };
            }
        }, { payload, csrf });

        if (!result.ok) {
            if (result.status === 401 || result.status === 403) {
                console.warn("Auth error (401/403), clearing cached CSRF token");
                cachedCsrfToken = null;
            }
            throw new Error(`Search failed: ${result.status} - ${result.error}`);
        }

        console.log(`Poll success: ${result.workOpportunities.length} loads found in ${Math.round(result.duration)}ms`);
        return result;

    } catch (err) {
        console.error("Poll execution error:", err);
        throw err;
    }
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

        ws!.send(
            JSON.stringify({
                type: "ready",
                workerId: NODE_ID,
            })
        );
    });

    ws.on("message", async (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        console.log("Received message type:", msg.type);

        if (msg.type === "poll") {
            try {
                const result: any = await doPoll(msg.settings || {});
                ws!.send(
                    JSON.stringify({
                        type: "poll_result",
                        ...(result as object),
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
