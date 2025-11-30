import express from "express";
import cors from "cors";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { NodeInfo, Load, LogEntry } from "./types";
import { config, defaultSearchSettings } from "./config";

const app = express();
app.use(cors({
    origin: process.env.CORS_ORIGIN || "*", // Default to * if not set, but should be set in prod
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: '1mb' })); // Limit payload size

// WebSocket authentication secret from environment
const WS_SECRET = process.env.WS_SECRET || "";
if (!WS_SECRET) {
    console.warn("WARNING: WS_SECRET not set! WebSocket connections are not authenticated!");
}

const server = http.createServer(app);

// Log all requests
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] HTTP ${req.method} ${req.url}`);
    next();
});

// Log upgrade attempts
server.on('upgrade', (req, socket, head) => {
    console.log(`[${new Date().toISOString()}] UPGRADE ${req.url}`);
});

const wss = new WebSocketServer({ server, path: "/agent" });

wss.on('error', (err) => {
    console.error("WebSocket Server Error:", err);
});

wss.on('headers', (headers, req) => {
    console.log(`[${new Date().toISOString()}] WSS Headers received for ${req.url}`);
});

const nodes = new Map<string, NodeInfo>();
const nodeSockets = new Map<string, WebSocket>();
const loads: Load[] = [];
const logs: LogEntry[] = [];
let pollingEnabled = true;

function log(entry: LogEntry) {
    logs.push(entry);
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    console.log(`[${new Date(entry.ts).toISOString()}] ${entry.level.toUpperCase()}: ${entry.message}`);
}

wss.on("connection", (ws, req) => {
    console.log(`[${new Date().toISOString()}] WSS Connection accepted from ${req.socket.remoteAddress}`);
    // Authenticate WebSocket connection via query parameter
    const url = new URL(req.url || "", `ws://localhost`);
    const token = url.searchParams.get("token");

    if (WS_SECRET && token !== WS_SECRET) {
        console.warn(`Unauthorized WebSocket connection attempt. Received: '${token}', Expected: '${WS_SECRET}'`);
        ws.close(1008, "Unauthorized");
        return;
    }

    let nodeId: string | null = null;

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "hello") {
                nodeId = msg.nodeId;
                if (nodeId) {
                    nodeSockets.set(nodeId, ws);
                    nodes.set(nodeId, {
                        nodeId,
                        status: "IDLE",
                        lastHeartbeat: Date.now(),
                        lastPollAt: null,
                        lastPollDurationMs: null,
                    });
                    log({ ts: Date.now(), level: "info", nodeId, message: "Agent connected" });
                }
            } else if (msg.type === "heartbeat" && nodeId) {
                const n = nodes.get(nodeId);
                if (n) n.lastHeartbeat = Date.now();
            } else if (msg.type === "poll_result" && nodeId) {
                const n = nodes.get(nodeId);
                if (n) {
                    n.lastPollAt = Date.now();
                    n.lastPollDurationMs = msg.durationMs || null;
                    n.status = msg.ok ? "IDLE" : "ERROR";
                    if (!msg.ok) {
                        n.lastError = msg.error;
                    } else {
                        n.lastError = undefined;
                    }
                }
                log({
                    ts: Date.now(),
                    level: msg.ok ? "info" : "error",
                    nodeId,
                    message: msg.ok ? `Poll ok ${msg.durationMs}ms` : `Poll error: ${msg.error}`,
                });

                if (msg.booking) {
                    log({
                        ts: Date.now(),
                        level: msg.booking.error ? "error" : "info",
                        nodeId,
                        message: msg.booking.error
                            ? `Booking failed: ${msg.booking.error}`
                            : `Booking successful! ID: ${msg.booking.workOpportunityId || 'unknown'}`
                    });
                }

                if (Array.isArray(msg.loads)) {
                    for (const l of msg.loads) {
                        loads.push({
                            ...l,
                            sourceNodeId: nodeId,
                            createdAt: Date.now(),
                        });
                    }
                    if (loads.length > 1000) loads.splice(0, loads.length - 1000);
                }
            }
        } catch (e) {
            console.error("Error in WS message:", e);
        }
    });

    ws.on("close", () => {
        if (nodeId) {
            log({ ts: Date.now(), level: "warn", nodeId, message: "Agent disconnected" });
            const n = nodes.get(nodeId);
            if (n) n.status = "UNKNOWN";
            nodeSockets.delete(nodeId);
        }
    });
});

// Simple rate limiting state
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;

function rateLimitMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    let clientData = requestCounts.get(ip);
    if (!clientData || now > clientData.resetTime) {
        clientData = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
        requestCounts.set(ip, clientData);
    }

    clientData.count++;

    if (clientData.count > RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({ error: "Too many requests" });
    }

    next();
}

// Apply rate limiting to API routes
app.use('/api/', rateLimitMiddleware);

// Robust scheduler
// Robust Tick-Based Scheduler
let lastGlobalPollTime = 0;
let lastScheduledNodeIndex = -1;

function runSchedulerTick() {
    if (!pollingEnabled) return;

    const now = Date.now();

    // 1. Enforce Global Delay (no two polls within minGlobalDelay)
    if (now - lastGlobalPollTime < config.minGlobalDelay) {
        return;
    }

    // 2. Find next eligible worker
    const nodeList = Array.from(nodes.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    if (nodeList.length === 0) return;

    // Round-robin search
    let found = false;
    for (let i = 0; i < nodeList.length; i++) {
        const idx = (lastScheduledNodeIndex + 1 + i) % nodeList.length;
        const node = nodeList[idx];
        const ws = nodeSockets.get(node.nodeId);

        if (!ws || ws.readyState !== WebSocket.OPEN) continue;

        // Check if worker is busy (basic check)
        if (node.status === "POLLING" && node.lastPollAt && (now - node.lastPollAt < 30000)) {
            continue;
        }

        // 3. Enforce Worker Period (max frequency per worker)
        // If lastPollAt is null, they are eligible immediately
        if (node.lastPollAt && (now - node.lastPollAt < config.minWorkerPeriod)) {
            continue;
        }

        // Found eligible worker
        node.status = "POLLING";
        // We update lastPollAt here to prevent double-scheduling in next tick
        // It will be updated again on result, but this is safe.
        node.lastPollAt = now;

        ws.send(JSON.stringify({ type: "poll_now", ts: now, settings: defaultSearchSettings }));

        lastGlobalPollTime = now;
        lastScheduledNodeIndex = idx;
        found = true;
        break; // Only one poll per tick to strictly enforce global delay
    }
}

// Run scheduler tick frequently (e.g. every 50ms)
// The tick rate determines the precision of the scheduling.
setInterval(runSchedulerTick, 50);

// Cleanup task (keep this separate)
setInterval(() => {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    if (loads.length > 0 && Math.random() < 0.1) {
        let keepIdx = 0;
        for (let i = 0; i < loads.length; i++) {
            if (loads[i].createdAt > oneHourAgo) {
                loads[keepIdx++] = loads[i];
            }
        }
        loads.length = keepIdx;
    }
}, 60000);

// REST API for frontend
app.get("/api/nodes", (_req, res) => {
    res.json({ nodes: Array.from(nodes.values()) });
});

app.get("/api/loads", (req, res) => {
    const limit = Math.min(parseInt((req.query.limit as string) || "200"), 1000);
    res.json({ loads: loads.slice(-limit).reverse() });
});

app.get("/api/logs", (req, res) => {
    const limit = Math.min(parseInt((req.query.limit as string) || "300"), 1000);
    res.json({ logs: logs.slice(-limit) });
});

// Polling control
// pollingEnabled is defined at top of file

app.post("/api/start", (req, res) => {
    pollingEnabled = true;
    console.log("Polling started via API");
    res.json({ status: "started" });
});

app.post("/api/stop", (req, res) => {
    pollingEnabled = false;
    console.log("Polling stopped via API");
    res.json({ status: "stopped" });
});

app.get("/api/config", (_req, res) => {
    res.json({ ...config, pollingEnabled });
});

// Health check endpoint
app.get("/health", (_req, res) => {
    const health = {
        status: "OK",
        uptime: process.uptime(),
        timestamp: Date.now(),
        nodes: nodes.size,
        wsConnections: nodeSockets.size,
        memory: process.memoryUsage(),
    };
    res.json(health);
});

// Readiness check
app.get("/ready", (_req, res) => {
    if (nodes.size > 0 && Array.from(nodes.values()).some(n => n.status !== "UNKNOWN")) {
        res.status(200).json({ ready: true, nodes: nodes.size });
    } else {
        res.status(503).json({ ready: false, reason: "No active workers connected" });
    }
});

const port = process.env.PORT || 3000;
const wsPort = process.env.WS_PORT || 8080;

server.listen(wsPort, () => {
    console.log(`HTTP+WS server listening on ${wsPort}`);
    console.log(`Health check available at http://localhost:${wsPort}/health`);
    console.log(`WebSocket auth: ${WS_SECRET ? 'ENABLED' : 'DISABLED (WARNING!)'}`);
});
