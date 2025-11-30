export type NodeStatus = "UNKNOWN" | "IDLE" | "POLLING" | "ERROR";

export interface NodeInfo {
  nodeId: string;
  status: NodeStatus;
  lastHeartbeat: number | null;
  lastPollAt: number | null;
  lastPollDurationMs: number | null;
  lastError?: string;
}

export interface Load {
  id: string;
  lane: string;
  payout: number;
  pickupTime: string;
  createdAt: number;
  sourceNodeId: string;
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  nodeId?: string;
  message: string;
}

export interface PollingConfig {
  periodMs: number;
  staggerMs: number;
  minWorkerPeriod: number;
  minGlobalDelay: number;
}

export interface SearchSettings {
  origin: {
    name: string;
    stateCode: string;
    latitude: number;
    longitude: number;
    displayValue: string;
  };
  radius: number;
  resultSize: number;
  minPayout: number;
  maxDistance: number;
  fastMs: number;
  stopOnFirstLoad: boolean;
  autoBookFirst: boolean;
  phaseMs: number;
  savedSearchId: string;
  minRatePerMile: number | null;
  startDelayMs: number;
  earliestStartHours: number;
}
