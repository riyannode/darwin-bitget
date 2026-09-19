import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import { TraderAgent } from "../src/agent/agent.js";
import { TEMPORARY_SCAN_INTERVAL_DURATION_MS, TEMPORARY_SCAN_INTERVAL_MINUTES } from "../src/agent/scheduler.js";

const getEnsureTemporaryScanTest = (TraderAgent.prototype as unknown as {
  ensureTemporaryScanTest: (this: Record<string, unknown>, policy: { scanIntervalMinutes: number }) => void;
}).ensureTemporaryScanTest;

interface CapturedEvent {
  type: string;
  cycleId: string;
  metadata?: Record<string, string>;
}

function makeAgent(state: Record<string, unknown>, events: CapturedEvent[]): Record<string, unknown> {
  const agentState = {
    emergencyStop: false,
    paused: false,
    lastCycleId: null,
    lastScanAt: null,
    currentStage: "ONLINE",
    runtimeStatus: "ONLINE",
    lastStatus: "IDLE",
    cycleStartedAt: null,
    temporaryScanIntervalExpiresAt: null,
    temporaryScanIntervalCompleted: false,
    temporaryScanIntervalDurationMs: TEMPORARY_SCAN_INTERVAL_DURATION_MS,
    ...state,
  };
  return {
    state: agentState,
    setState: vi.fn((next: Record<string, unknown>) => { Object.assign(agentState, next); }),
    recordEvent: vi.fn((_type: string, _cycleId: string, _metadata?: Record<string, string>) => {
      const entry: CapturedEvent = { type: _type, cycleId: _cycleId };
      if (_metadata !== undefined) entry.metadata = _metadata;
      events.push(entry);
    }),
    recordEventBestEffort: vi.fn((_self: unknown, type: string, cycleId: string, metadata?: Record<string, string>) => {
      const entry: CapturedEvent = { type, cycleId };
      if (metadata !== undefined) entry.metadata = metadata;
      events.push(entry);
    }),
  };
}

describe("temporary scan interval restored-interval telemetry", () => {
  it("reports restoredIntervalMinutes equal to policy value when not 15", () => {
    const events: CapturedEvent[] = [];
    const NOW = Date.parse("2026-09-14T00:00:00.000Z");
    const expiresAt = new Date(NOW - 1000).toISOString();
    const agent = makeAgent({ temporaryScanIntervalExpiresAt: expiresAt, temporaryScanIntervalCompleted: false, temporaryScanIntervalDurationMs: TEMPORARY_SCAN_INTERVAL_DURATION_MS }, events);
    const policy = { scanIntervalMinutes: 5 };

    const originalNow = Date.now;
    try {
      Date.now = () => NOW;
      getEnsureTemporaryScanTest.call(agent as never, policy);
    } finally {
      Date.now = originalNow;
    }

    const expiredEvent = events.find((e) => e.type === "TEMPORARY_SCAN_INTERVAL_EXPIRED");
    expect(expiredEvent).toBeDefined();
    expect(expiredEvent?.metadata?.restoredIntervalMinutes).toBe("5");
  });

  it("reports restoredIntervalMinutes equal to policy value when 10 (another non-default)", () => {
    const events: CapturedEvent[] = [];
    const NOW = Date.parse("2026-09-14T00:00:00.000Z");
    const expiresAt = new Date(NOW - 1000).toISOString();
    const agent = makeAgent({ temporaryScanIntervalExpiresAt: expiresAt, temporaryScanIntervalCompleted: false, temporaryScanIntervalDurationMs: TEMPORARY_SCAN_INTERVAL_DURATION_MS }, events);
    const policy = { scanIntervalMinutes: 10 };

    const originalNow = Date.now;
    try {
      Date.now = () => NOW;
      getEnsureTemporaryScanTest.call(agent as never, policy);
    } finally {
      Date.now = originalNow;
    }

    const expiredEvent = events.find((e) => e.type === "TEMPORARY_SCAN_INTERVAL_EXPIRED");
    expect(expiredEvent).toBeDefined();
    expect(expiredEvent?.metadata?.restoredIntervalMinutes).toBe("10");
  });

  it("does not emit TEMPORARY_SCAN_INTERVAL_EXPIRED when interval is still active", () => {
    const events: CapturedEvent[] = [];
    const NOW = Date.parse("2026-09-14T00:00:00.000Z");
    const expiresAt = new Date(NOW + 60_000).toISOString();
    const agent = makeAgent({ temporaryScanIntervalExpiresAt: expiresAt, temporaryScanIntervalCompleted: false, temporaryScanIntervalDurationMs: TEMPORARY_SCAN_INTERVAL_DURATION_MS }, events);
    const policy = { scanIntervalMinutes: 5 };

    const originalNow = Date.now;
    try {
      Date.now = () => NOW;
      getEnsureTemporaryScanTest.call(agent as never, policy);
    } finally {
      Date.now = originalNow;
    }

    const expiredEvent = events.find((e) => e.type === "TEMPORARY_SCAN_INTERVAL_EXPIRED");
    expect(expiredEvent).toBeUndefined();
  });

  it("re-activates when durationMs does not match the current constant", () => {
    const events: CapturedEvent[] = [];
    const agent = makeAgent({ temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: false, temporaryScanIntervalDurationMs: 0 }, events);
    const policy = { scanIntervalMinutes: 5 };

    const originalNow = Date.now;
    try {
      Date.now = () => Date.parse("2026-09-14T00:00:00.000Z");
      getEnsureTemporaryScanTest.call(agent as never, policy);
    } finally {
      Date.now = originalNow;
    }

    const activatedEvent = events.find((e) => e.type === "TEMPORARY_SCAN_INTERVAL_ACTIVATED");
    expect(activatedEvent).toBeDefined();
    expect(activatedEvent?.metadata?.intervalMinutes).toBe(String(TEMPORARY_SCAN_INTERVAL_MINUTES));
  });
});
