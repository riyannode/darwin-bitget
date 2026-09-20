import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import { TraderAgent } from "../src/agent/agent.js";
import type { CycleSchedule, SchedulerReconciliationState } from "../src/agent/scheduler.js";

const setPaused = (TraderAgent.prototype as unknown as {
  setPaused: (this: ResumeAgent, paused: boolean) => Promise<Record<string, unknown>>;
}).setPaused;
const reconcileScheduler = (TraderAgent.prototype as unknown as {
  reconcileScheduler: (this: ResumeAgent, intervalMinutes: number, options?: { ensureSchedule?: boolean; now?: number; state?: SchedulerReconciliationState }) => Promise<unknown>;
}).reconcileScheduler;

const RESUME_INTERVAL_MINUTES = 5;
const RESUME_INTERVAL_SECONDS = RESUME_INTERVAL_MINUTES * 60;

type ResumeState = SchedulerReconciliationState & {
  lastStatus: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
  cycleStartedAt: string | null;
  runtimeStatus: "ONLINE" | "PAUSED" | "SCANNING" | "ANALYZING" | "RISK_CHECK" | "EXECUTING" | "REFLECTING" | "COOLDOWN" | "ERROR";
  currentStage: string;
};

type ResumeAgent = {
  state: ResumeState;
  env: { TRADING_MODE: string; PAPER_ONLY: string; AGENT_MODE: string };
  listSchedules: ReturnType<typeof vi.fn>;
  cancelSchedule: ReturnType<typeof vi.fn>;
  scheduleEvery: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  ensureActivePolicy: ReturnType<typeof vi.fn>;
  activeScanIntervalMinutes: ReturnType<typeof vi.fn>;
  recoverStaleCycle: ReturnType<typeof vi.fn>;
  reconcileScheduler: typeof reconcileScheduler;
};

function makeScheduler(initialSchedules: CycleSchedule[] = []) {
  let schedules = initialSchedules.map((entry) => ({ ...entry }));
  let createdCount = 0;
  const listSchedules = vi.fn(async () => schedules.map((entry) => ({ ...entry })));
  const cancelSchedule = vi.fn(async (id: string) => {
    const existed = schedules.some((entry) => entry.id === id);
    schedules = schedules.filter((entry) => entry.id !== id);
    return existed;
  });
  const scheduleEvery = vi.fn(async (seconds: number, callback: string) => {
    const existing = schedules.find((entry) => entry.callback === callback && entry.type === "interval" && entry.intervalSeconds === seconds);
    if (existing) return existing;
    const created = { id: `created-${++createdCount}`, callback, type: "interval", intervalSeconds: seconds, time: Math.floor(Date.now() / 1000) + seconds } satisfies CycleSchedule;
    schedules.push(created);
    return created;
  });
  return { listSchedules, cancelSchedule, scheduleEvery, getSchedules: () => schedules.map((entry) => ({ ...entry })) };
}

function makeAgent(initialState: Partial<ResumeState> = {}, initialSchedules: CycleSchedule[] = [], staleCycleRecovered = false) {
  const scheduler = makeScheduler(initialSchedules);
  let visibleState: ResumeState = {
    paused: true,
    emergencyStop: false,
    activeCycle: false,
    nextScanAt: null,
    lastStatus: "IDLE",
    cycleStartedAt: null,
    runtimeStatus: "PAUSED",
    currentStage: "PAUSED",
    ...initialState,
  };
  let persistedState = { ...visibleState };
  const agent = {
    get state() { return visibleState; },
    env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS" },
    listSchedules: scheduler.listSchedules,
    cancelSchedule: scheduler.cancelSchedule,
    scheduleEvery: scheduler.scheduleEvery,
    // Model a durable state write whose in-memory read is not refreshed until a later invocation.
    setState: vi.fn((nextState: ResumeState) => { persistedState = { ...nextState }; }),
    ensureActivePolicy: vi.fn(() => ({
      paperOnly: true,
      maxSinglePositionMarginPct: "30",
      maxLeverage: "5",
      maxDailyDrawdownPct: "10",
      drawdownCooldownMinutes: 60,
      scanIntervalMinutes: RESUME_INTERVAL_MINUTES,
      emergencyStop: visibleState.emergencyStop,
    })),
    activeScanIntervalMinutes: vi.fn(() => RESUME_INTERVAL_MINUTES),
    recoverStaleCycle: vi.fn(() => staleCycleRecovered),
    reconcileScheduler,
  } as unknown as ResumeAgent;
  return {
    agent,
    scheduler,
    getPersistedState: () => ({ ...persistedState }),
    getVisibleState: () => ({ ...visibleState }),
    setVisibleState: (next: ResumeState) => { visibleState = { ...next }; },
  };
}

describe("authenticated RESUME scheduler recreation", () => {
  it("recreates exactly one 5-minute schedule from paused idle with zero schedules", async () => {
    const harness = makeAgent();

    await setPaused.call(harness.agent, false);

    expect(harness.agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(harness.agent.scheduleEvery).toHaveBeenCalledWith(RESUME_INTERVAL_SECONDS, "runScheduledCycle", undefined, { _idempotent: true });
    expect(harness.scheduler.getSchedules().filter((entry) => entry.callback === "runScheduledCycle")).toHaveLength(1);
    expect(harness.getPersistedState()).toMatchObject({ paused: false, nextScanAt: expect.any(String) });
    expect(Date.parse(harness.getPersistedState().nextScanAt!)).toBeGreaterThan(Date.now());
    expect(harness.getVisibleState().paused).toBe(true);
  });

  it("repeated RESUME does not duplicate the schedule", async () => {
    const harness = makeAgent();

    await setPaused.call(harness.agent, false);
    harness.setVisibleState(harness.getPersistedState());
    await setPaused.call(harness.agent, false);

    expect(harness.agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(harness.scheduler.getSchedules().filter((entry) => entry.callback === "runScheduledCycle")).toHaveLength(1);
  });

  it("does not recreate a schedule while emergency stop remains enabled", async () => {
    const harness = makeAgent({ emergencyStop: true });

    const result = await setPaused.call(harness.agent, false);

    expect(result.paused).toBe(true);
    expect(harness.agent.scheduleEvery).not.toHaveBeenCalled();
    expect(harness.scheduler.getSchedules()).toHaveLength(0);
  });

  it("does not recreate a schedule for a genuine recent RUNNING cycle", async () => {
    const harness = makeAgent({
      lastStatus: "RUNNING",
      cycleStartedAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await setPaused.call(harness.agent, false);

    expect(harness.agent.recoverStaleCycle).toHaveBeenCalledOnce();
    expect(harness.agent.scheduleEvery).not.toHaveBeenCalled();
    expect(harness.scheduler.getSchedules()).toHaveLength(0);
  });

  it("recreates after the existing stale-cycle proof clears metadata", async () => {
    const harness = makeAgent({
      lastStatus: "RUNNING",
      cycleStartedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }, [], true);

    await setPaused.call(harness.agent, false);

    expect(harness.agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(harness.scheduler.getSchedules().filter((entry) => entry.callback === "runScheduledCycle")).toHaveLength(1);
  });
});
