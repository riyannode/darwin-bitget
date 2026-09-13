import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import { TraderAgent } from "../src/agent/agent.js";
import { reconcileTradingSchedule, type CycleSchedule, type SchedulerReconciliationState } from "../src/agent/scheduler.js";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const INTERVAL_MINUTES = 15;
const INTERVAL_SECONDS = INTERVAL_MINUTES * 60;
const STALE_NEXT_SCAN = new Date(NOW - (INTERVAL_SECONDS + 31) * 1000).toISOString();
const FUTURE_NEXT_SCAN = new Date(NOW + 5 * 60 * 1000).toISOString();

type TestState = SchedulerReconciliationState & {
  lastStatus: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
  lastCycleId: string | null;
};

type TestAgent = TestState & {
  state: TestState;
  listSchedules: ReturnType<typeof vi.fn>;
  cancelSchedule: ReturnType<typeof vi.fn>;
  scheduleEvery: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  reconcileScheduler: (intervalMinutes: number, options?: { ensureSchedule?: boolean; now?: number }) => Promise<unknown>;
};

const getDiagnostics = (TraderAgent.prototype as unknown as {
  getSchedulerDiagnostics: (this: TestAgent, intervalMinutes: number, now?: number) => Promise<Record<string, unknown>>;
}).getSchedulerDiagnostics;
const reconcileScheduler = (TraderAgent.prototype as unknown as {
  reconcileScheduler: (this: TestAgent, intervalMinutes: number, options?: { ensureSchedule?: boolean; now?: number }) => Promise<unknown>;
}).reconcileScheduler;
const runScheduledCycle = (TraderAgent.prototype as unknown as {
  runScheduledCycle: (this: Record<string, unknown>) => Promise<void>;
}).runScheduledCycle;
const recordEventBestEffort = (TraderAgent.prototype as unknown as {
  recordEventBestEffort: (this: Record<string, unknown>, type: string, cycleId: string, metadata?: Record<string, string>) => void;
}).recordEventBestEffort;

function cycleSchedule(id: string, intervalSeconds = INTERVAL_SECONDS, time = NOW / 1000 + intervalSeconds): CycleSchedule {
  return { id, callback: "runScheduledCycle", type: "interval", intervalSeconds, time };
}

function makeScheduler(initialSchedules: CycleSchedule[]) {
  let schedules = initialSchedules.map((entry) => ({ ...entry }));
  let createdCount = 0;
  const listSchedules = vi.fn(async () => schedules.map((entry) => ({ ...entry })));
  const cancelSchedule = vi.fn(async (id: string) => {
    const existed = schedules.some((entry) => entry.id === id);
    schedules = schedules.filter((entry) => entry.id !== id);
    return existed;
  });
  const scheduleEvery = vi.fn(async (seconds: number) => {
    const existing = schedules.find((entry) => entry.callback === "runScheduledCycle" && entry.type === "interval" && entry.intervalSeconds === seconds);
    if (existing) return existing;
    const created = cycleSchedule(`created-${++createdCount}`, seconds);
    schedules.push(created);
    return created;
  });
  return { listSchedules, cancelSchedule, scheduleEvery, getSchedules: () => schedules.map((entry) => ({ ...entry })) };
}

function makeAgent(initialSchedules: CycleSchedule[], state: Partial<TestState> = {}): TestAgent {
  const scheduler = makeScheduler(initialSchedules);
  const agent = {
    state: {
      paused: false,
      emergencyStop: false,
      activeCycle: false,
      lastStatus: "COMPLETED" as const,
      lastCycleId: null,
      nextScanAt: STALE_NEXT_SCAN,
      ...state,
    },
    listSchedules: scheduler.listSchedules,
    cancelSchedule: scheduler.cancelSchedule,
    scheduleEvery: scheduler.scheduleEvery,
    setState: vi.fn((nextState: TestState) => { agent.state = nextState; }),
    reconcileScheduler,
  } as unknown as TestAgent;
  return agent;
}

describe("stale scheduler recovery", () => {
  it("A: healthy matching schedule remains unchanged", async () => {
    const agent = makeAgent([cycleSchedule("healthy")], { nextScanAt: FUTURE_NEXT_SCAN });

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).not.toHaveBeenCalled();
    expect(agent.setState).not.toHaveBeenCalled();
    expect(diagnostics).toMatchObject({ nextScanAt: FUTURE_NEXT_SCAN, nextScanStale: false, matchingScheduleCount: 1, schedulerHealthy: true });
  });

  it("B: stale matching schedule is canceled and replaced exactly once", async () => {
    const agent = makeAgent([cycleSchedule("stale-matching")]);

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).toHaveBeenCalledOnce();
    expect(agent.cancelSchedule).toHaveBeenCalledWith("stale-matching");
    expect(agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(agent.scheduleEvery).toHaveBeenCalledWith(900, "runScheduledCycle", undefined, { _idempotent: true });
    expect(diagnostics).toMatchObject({ nextScanStale: false, matchingScheduleCount: 1, schedulerHealthy: true });
  });

  it("C: missing schedule with stale nextScan creates one schedule", async () => {
    const agent = makeAgent([]);

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(diagnostics).toMatchObject({ nextScanStale: false, matchingScheduleCount: 1, schedulerHealthy: true });
  });

  it("D: wrong interval schedule is replaced", async () => {
    const agent = makeAgent([cycleSchedule("wrong-interval", 1800, NOW / 1000 + 1800)]);

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).toHaveBeenCalledWith("wrong-interval");
    expect(agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(diagnostics).toMatchObject({ nextScanStale: false, matchingScheduleCount: 1, schedulerHealthy: true });
  });

  it("E: paused agent does not recreate or cancel schedules", async () => {
    const agent = makeAgent([cycleSchedule("paused-existing")], { paused: true });

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).not.toHaveBeenCalled();
  });

  it("F: emergency stop does not recreate or cancel schedules", async () => {
    const agent = makeAgent([cycleSchedule("emergency-existing")], { emergencyStop: true });

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).not.toHaveBeenCalled();
  });

  it("G: active RUNNING cycle does not recreate or cancel schedules", async () => {
    const agent = makeAgent([cycleSchedule("running-existing")], {
      lastStatus: "RUNNING",
      activeCycle: true,
    });

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).not.toHaveBeenCalled();
  });

  it("H: repeated diagnostics do not create duplicates", async () => {
    const agent = makeAgent([cycleSchedule("stale-once")]);

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);
    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).toHaveBeenCalledOnce();
    expect(agent.scheduleEvery).toHaveBeenCalledOnce();
    const finalSchedules = await (agent.listSchedules as unknown as () => Promise<CycleSchedule[]>)();
    expect(finalSchedules.filter((entry) => entry.callback === "runScheduledCycle")).toHaveLength(1);
  });

  it("uses now plus the configured interval when the SDK omits schedule time", async () => {
    const scheduler = makeScheduler([]);
    scheduler.scheduleEvery.mockImplementationOnce(async () => {
      return { id: "created-without-time", callback: "runScheduledCycle", type: "interval", intervalSeconds: INTERVAL_SECONDS };
    });
    scheduler.listSchedules.mockImplementationOnce(async () => []);
    scheduler.listSchedules.mockImplementationOnce(async () => [{ id: "created-without-time", callback: "runScheduledCycle", type: "interval", intervalSeconds: INTERVAL_SECONDS }]);

    const result = await reconcileTradingSchedule(scheduler, INTERVAL_MINUTES, {
      paused: false,
      emergencyStop: false,
      activeCycle: false,
      nextScanAt: STALE_NEXT_SCAN,
    }, { now: NOW });

    expect(result.nextScanAt).toBe(new Date(NOW + INTERVAL_MINUTES * 60_000).toISOString());
  });
});

describe("scheduled callback telemetry", () => {
  it("does not let callback telemetry failure prevent cycle handling", async () => {
    const policy = {
      paperOnly: true,
      maxSinglePositionMarginPct: "30",
      maxLeverage: "5",
      maxDailyDrawdownPct: "10",
      drawdownCooldownMinutes: 60,
      scanIntervalMinutes: 15,
      emergencyStop: false,
    };
    const fake = {
      state: { paused: false, emergencyStop: false, lastCycleId: null },
      env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", EVIDENCE_MAX_AGE_SECONDS: "90" },
      recordEvent: vi.fn(() => { throw new Error("STORAGE_QUOTA"); }),
      recordEventBestEffort,
      ensureActivePolicy: vi.fn(() => policy),
      ensureTradingSchedule: vi.fn(async () => undefined),
      runCycle: vi.fn(async () => undefined),
    };

    await runScheduledCycle.call(fake);

    expect(fake.ensureTradingSchedule).toHaveBeenCalledOnce();
    expect(fake.runCycle).toHaveBeenCalledOnce();
  });
});
