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
                    if (!msg.ok) n.lastError = msg.error;
                }
                log({
                    ts: Date.now(),
                    level: msg.ok ? "info" : "error",
                    nodeId,
                    message: msg.ok ? `Poll ok ${msg.durationMs}ms` : `Poll error: ${msg.error}`,
                });

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
const pendingPolls = new Set<string>();

function scheduleNextPoll() {
    setTimeout(() => {
        const now = Date.now();
        const nodeList = Array.from(nodes.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));

        // Cleanup old loads periodically (every minute)
        if (Math.random() < 0.05) { // ~once every 20 cycles if period is 3s
            const oneHourAgo = now - 3600000;
            const initialLen = loads.length;
            // Filter in place or create new array
            let keepIdx = 0;
            for (let i = 0; i < loads.length; i++) {
                if (loads[i].createdAt > oneHourAgo) {
                    loads[keepIdx++] = loads[i];
                }
            }
            loads.length = keepIdx;
        }

        let scheduledCount = 0;
        nodeList.forEach((node, idx) => {
            const ws = nodeSockets.get(node.nodeId);
            if (!ws || ws.readyState !== WebSocket.OPEN) return;

            // Don't schedule if already polling (basic overlap protection)
            if (node.status === "POLLING" && node.lastPollAt && (now - node.lastPollAt < 30000)) {
                return;
            }

            const delay = idx * config.staggerMs;
            scheduledCount++;

            setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN) return;
                node.status = "POLLING";
                ws.send(JSON.stringify({ type: "poll_now", ts: Date.now(), settings: defaultSearchSettings }));
            }, delay);
        });

        // Schedule next cycle based on period, but ensure we don't drift too fast
        // If total stagger is long, we might want to wait longer? 
        // For now, stick to periodMs but respect the loop.
        scheduleNextPoll();
    }, config.periodMs);
}

// Start the scheduler
scheduleNextPoll();

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
let pollingEnabled = true;

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
