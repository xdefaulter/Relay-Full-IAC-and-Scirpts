import { PollingConfig, SearchSettings } from "./types";

export const config: PollingConfig = {
    periodMs: parseInt(process.env.PERIOD_MS || "400", 10), // Default 400ms = 2.5Hz max frequency
    staggerMs: parseInt(process.env.STAGGER_MS || "200", 10),
    minWorkerPeriod: 400, // Enforced minimum period per worker (2Hz)
    minGlobalDelay: 300,  // Enforced minimum delay between ANY two polls (2.5Hz aggregate)
};

export const defaultSearchSettings: SearchSettings = {
    origin: {
        name: "BRAMPTON",
        stateCode: "ON",
        latitude: 43.7882,
        longitude: -79.73719,
        displayValue: "BRAMPTON, ON"
    },
    radius: 50,
    resultSize: 2,
    minPayout: 450,
    maxDistance: 192,
    fastMs: 400,
    stopOnFirstLoad: true,
    autoBookFirst: true,
    phaseMs: 0,
    savedSearchId: "",
    minRatePerMile: null,
    startDelayMs: 0,
    earliestStartHours: 0
};
