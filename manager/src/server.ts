import express from "express";
import cors from "cors";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { NodeInfo, Load, LogEntry } from "./types";
import { config, defaultSearchSettings } from "./config";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

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
    let nodeId: string | null = null;

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "hello") {
                nodeId = msg.nodeId;
                nodeSockets.set(nodeId, ws);
                nodes.set(nodeId, {
                    nodeId,
                    status: "IDLE",
                    lastHeartbeat: Date.now(),
                    lastPollAt: null,
                    lastPollDurationMs: null,
                });
                log({ ts: Date.now(), level: "info", nodeId, message: "Agent connected" });
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

app.get("/api/loads", (_req, res) => {
    res.json({ loads: loads.slice(-200).reverse() });
});

app.get("/api/logs", (_req, res) => {
    res.json({ logs: logs.slice(-300).reverse() });
});

app.get("/api/config", (_req, res) => {
    res.json(config);
});

const port = process.env.PORT || 3000;
const wsPort = process.env.WS_PORT || 8080;
server.listen(wsPort, () => {
    console.log(`HTTP+WS server listening on ${wsPort}`);
});
