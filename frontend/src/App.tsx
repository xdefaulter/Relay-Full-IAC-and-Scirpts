import React, { useEffect, useState } from "react";

interface NodeInfo {
    nodeId: string;
    status: string;
    lastHeartbeat: number | null;
    lastPollAt: number | null;
    lastPollDurationMs: number | null;
    lastError?: string;
}

interface Load {
    id: string;
    lane: string;
    payout: number;
    pickupTime: string;
    createdAt: number;
    sourceNodeId: string;
}

interface LogEntry {
    ts: number;
    level: string;
    nodeId?: string;
    message: string;
}

const API_BASE = import.meta.env.VITE_API_BASE || "";

export const App: React.FC = () => {
    const [nodes, setNodes] = useState<NodeInfo[]>([]);
    const [loads, setLoads] = useState<Load[]>([]);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [config, setConfig] = useState<{ periodMs: number; staggerMs: number } | null>(null);

    // Filter states
    const [filterLevel, setFilterLevel] = useState<string>("ALL");
    const [filterNodeId, setFilterNodeId] = useState<string>("");

    // Auto-scroll ref
    const logEndRef = React.useRef<HTMLDivElement>(null);

    useEffect(() => {
        const fetchAll = async () => {
            try {
                const [nodesRes, loadsRes, logsRes, configRes] = await Promise.all([
                    fetch(`${API_BASE}/api/nodes`),
                    fetch(`${API_BASE}/api/loads`),
                    fetch(`${API_BASE}/api/logs`),
                    fetch(`${API_BASE}/api/config`),
                ]);
                setNodes((await nodesRes.json()).nodes);
                setLoads((await loadsRes.json()).loads);
                setLogs((await logsRes.json()).logs);
                setConfig(await configRes.json());
            } catch (e) {
                console.error("Failed to fetch data", e);
            }
        };
        fetchAll();
        const interval = setInterval(fetchAll, 5000);
        return () => clearInterval(interval);
    }, []);

    // Auto-scroll effect
    useEffect(() => {
        if (logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs]);

    const filteredLogs = logs.filter(log => {
        if (filterLevel !== "ALL" && log.level.toUpperCase() !== filterLevel) return false;
        if (filterNodeId && (!log.nodeId || !log.nodeId.toLowerCase().includes(filterNodeId.toLowerCase()))) return false;
        return true;
    });

    return (
        <div className="app">
            <header>
                <h1>Relay Pulse Manager</h1>
                {config && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span>Period: {config.periodMs}ms | Stagger: {config.staggerMs}ms</span>
                        <div className="controls">
                            <button onClick={() => fetch(`${API_BASE}/api/start`, { method: 'POST' })}>Start Polling</button>
                            <button onClick={() => fetch(`${API_BASE}/api/stop`, { method: 'POST' })}>Stop Polling</button>
                        </div>
                    </div>
                )}
            </header>

            <section>
                <h2>Nodes</h2>
                <div className="nodes-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '1rem' }}>
                    {nodes.map((n) => (
                        <div key={n.nodeId} className={`node-card status-${n.status.toLowerCase()}`} style={{ border: '1px solid #ccc', padding: '1rem', borderRadius: '8px' }}>
                            <h3>{n.nodeId}</h3>
                            <p>Status: {n.status}</p>
                            <p>Last heartbeat: {n.lastHeartbeat ? new Date(n.lastHeartbeat).toLocaleTimeString() : "never"}</p>
                            <p>Last poll: {n.lastPollAt ? new Date(n.lastPollAt).toLocaleTimeString() : "never"}</p>
                            <p>Duration: {n.lastPollDurationMs ?? "-"} ms</p>
                            {n.lastError && <p className="error" style={{ color: 'red' }}>Error: {n.lastError}</p>}
                        </div>
                    ))}
                </div>
            </section>

            <section>
                <h2>Recent Loads</h2>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                            <th>Node</th>
                            <th>Lane</th>
                            <th>Payout</th>
                            <th>Pickup</th>
                            <th>Seen</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loads.slice(0, 50).map((l) => (
                            <tr key={l.id + l.createdAt} style={{ borderBottom: '1px solid #eee' }}>
                                <td>{l.sourceNodeId}</td>
                                <td>{l.lane}</td>
                                <td>{l.payout}</td>
                                <td>{l.pickupTime}</td>
                                <td>{new Date(l.createdAt).toLocaleTimeString()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>

            <section>
                <h2>Logs</h2>
                <div className="log-controls">
                    <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)}>
                        <option value="ALL">All Levels</option>
                        <option value="INFO">Info</option>
                        <option value="WARN">Warn</option>
                        <option value="ERROR">Error</option>
                    </select>
                    <input
                        type="text"
                        placeholder="Filter by Node ID..."
                        value={filterNodeId}
                        onChange={(e) => setFilterNodeId(e.target.value)}
                    />
                </div>
                <div className="log-terminal">
                    {filteredLogs.slice(-200).map((log, idx) => (
                        <div key={idx} className={`log-entry log-${log.level}`}>
                            <span className="log-ts">[{new Date(log.ts).toLocaleTimeString()}]</span>
                            <span className="log-level">[{log.level.toUpperCase()}]</span>
                            <span className="log-node">{log.nodeId ? `[${log.nodeId}]` : "[-]"}</span>
                            <span className="log-msg">{log.message}</span>
                        </div>
                    ))}
                    <div ref={logEndRef} />
                </div>
            </section>
        </div>
    );
};
