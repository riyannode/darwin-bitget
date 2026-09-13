import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import { TraderAgent } from "../src/agent/agent.js";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const INTERVAL_MINUTES = 15;
const STALE_NEXT_SCAN = new Date(NOW - (INTERVAL_MINUTES * 60 + 31) * 1000).toISOString();
const FUTURE_NEXT_SCAN = new Date(NOW + 5 * 60 * 1000).toISOString();

type Schedule = {
  id: string;
  callback: string;
  type: "interval" | "other";
  intervalSeconds?: number;
  time?: number;
};

type TestState = {
  paused: boolean;
  emergencyStop: boolean;
  lastStatus: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
  cycleStartedAt: string | null;
  nextScanAt: string | null;
};

type FakeAgent = TestState & {
  state: TestState;
  listSchedules: ReturnType<typeof vi.fn>;
  cancelSchedule: ReturnType<typeof vi.fn>;
  scheduleEvery: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  runCycle: ReturnType<typeof vi.fn>;
  executeDecision: ReturnType<typeof vi.fn>;
};

const getDiagnostics = (TraderAgent.prototype as unknown as {
  getSchedulerDiagnostics: (this: FakeAgent, intervalMinutes: number, now?: number) => Promise<Record<string, unknown>>;
}).getSchedulerDiagnostics;

function schedule(id: string, time = NOW / 1000 + INTERVAL_MINUTES * 60): Schedule {
  return { id, callback: "runScheduledCycle", type: "interval", intervalSeconds: INTERVAL_MINUTES * 60, time };
}

function fakeAgent(initialSchedules: Schedule[], refreshedSchedules = initialSchedules, state: Partial<TestState> = {}): FakeAgent {
  const queue = [initialSchedules, initialSchedules, refreshedSchedules];
  const agent = {
    state: {
      paused: false,
      emergencyStop: false,
      lastStatus: "COMPLETED" as const,
      cycleStartedAt: null,
      nextScanAt: STALE_NEXT_SCAN,
      ...state,
    },
    listSchedules: vi.fn(async () => queue.shift() ?? refreshedSchedules),
    cancelSchedule: vi.fn(async () => true),
    scheduleEvery: vi.fn(async () => "created-cycle"),
    setState: vi.fn((nextState: TestState) => { agent.state = nextState; }),
    runCycle: vi.fn(() => { throw new Error("RUN_CYCLE_MUST_NOT_BE_CALLED"); }),
    executeDecision: vi.fn(() => { throw new Error("FINANCIAL_EXECUTION_MUST_NOT_BE_CALLED"); }),
  } as unknown as FakeAgent;
  return agent;
}

describe("stale scheduler recovery", () => {
  it("healthy matching schedule causes no mutation", async () => {
    const agent = fakeAgent([schedule("healthy")], [schedule("healthy")], { nextScanAt: FUTURE_NEXT_SCAN });

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).not.toHaveBeenCalled();
    expect(agent.setState).not.toHaveBeenCalled();
    expect(diagnostics).toMatchObject({ nextScanAt: FUTURE_NEXT_SCAN, nextScanStale: false, matchingScheduleCount: 1, schedulerHealthy: true });
  });

  it("missing schedule with stale nextScan creates exactly one schedule", async () => {
    const repaired = schedule("repaired");
    const agent = fakeAgent([], [repaired]);

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(agent.scheduleEvery).toHaveBeenCalledWith(900, "runScheduledCycle", undefined, { _idempotent: true });
    expect(agent.setState).toHaveBeenCalledOnce();
    expect(agent.state.nextScanAt).toBe(new Date(repaired.time! * 1000).toISOString());
    expect(diagnostics).toMatchObject({ nextScanStale: false, matchingScheduleCount: 1, schedulerHealthy: true });
  });

  it("duplicate schedules are reconciled to exactly one", async () => {
    const repaired = schedule("single-after-repair");
    const agent = fakeAgent([schedule("duplicate-a"), schedule("duplicate-b")], [repaired]);

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).toHaveBeenCalledTimes(2);
    expect(agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(diagnostics).toMatchObject({ matchingScheduleCount: 1, schedulerHealthy: true });
  });

  it("paused agent does not create a schedule", async () => {
    const agent = fakeAgent([], [], { paused: true });

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).not.toHaveBeenCalled();
    expect(agent.setState).not.toHaveBeenCalled();
  });

  it("emergency stop does not create a schedule", async () => {
    const agent = fakeAgent([], [], { emergencyStop: true });

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.cancelSchedule).not.toHaveBeenCalled();
    expect(agent.scheduleEvery).not.toHaveBeenCalled();
    expect(agent.setState).not.toHaveBeenCalled();
  });

  it("active cycle does not trigger recovery", async () => {
    const agent = fakeAgent([], [], { lastStatus: "RUNNING", cycleStartedAt: new Date(NOW - 60_000).toISOString() });

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.scheduleEvery).not.toHaveBeenCalled();
    expect(agent.setState).not.toHaveBeenCalled();
  });

  it("fresh future nextScan does not repair a missing schedule", async () => {
    const agent = fakeAgent([], [], { nextScanAt: FUTURE_NEXT_SCAN });

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.scheduleEvery).not.toHaveBeenCalled();
    expect(agent.setState).not.toHaveBeenCalled();
    expect(diagnostics).toMatchObject({ nextScanAt: FUTURE_NEXT_SCAN, nextScanStale: false, matchingScheduleCount: 0, schedulerHealthy: false });
  });

  it("recovery never invokes runCycle", async () => {
    const agent = fakeAgent([], [schedule("repaired")]);

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.runCycle).not.toHaveBeenCalled();
  });

  it("recovery never invokes financial execution", async () => {
    const agent = fakeAgent([], [schedule("repaired")]);

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.executeDecision).not.toHaveBeenCalled();
  });

  it("reports schedule inspection failure without mutating state", async () => {
    const agent = fakeAgent([], []);
    agent.listSchedules.mockRejectedValueOnce(new Error("SCHEDULER_UNAVAILABLE"));

    const diagnostics = await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.scheduleEvery).not.toHaveBeenCalled();
    expect(agent.setState).not.toHaveBeenCalled();
    expect(diagnostics).toMatchObject({ schedulerHealthy: false, schedulerErrorCode: "SCHEDULE_LIST_FAILED" });
  });

  it("disarms a schedule if pause arrives during recovery", async () => {
    const agent = fakeAgent([], [schedule("repaired")]);
    agent.scheduleEvery.mockImplementation(async () => {
      agent.state = { ...agent.state, paused: true };
      return "created-cycle";
    });

    await getDiagnostics.call(agent, INTERVAL_MINUTES, NOW);

    expect(agent.scheduleEvery).toHaveBeenCalledOnce();
    expect(agent.cancelSchedule).toHaveBeenCalledWith("repaired");
    expect(agent.setState).not.toHaveBeenCalled();
  });
});
