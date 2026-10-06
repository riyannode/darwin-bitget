import { describe, expect, it, vi } from "vitest";
import { runTimedCyclePhase, type CyclePhase } from "../src/agent/cycle-phase-timing.js";

describe("cycle phase timing telemetry", () => {
  it("emits only the bounded phase and duration fields", async () => {
    const log = vi.fn();
    const result = await runTimedCyclePhase("DECISION_QWEN", async () => "result", log);
    expect(result).toBe("result");
    expect(log).toHaveBeenCalledOnce();
    const eventLine = log.mock.calls[0]?.[0];
    expect(eventLine).toBeTypeOf("string");
    const event = JSON.parse(eventLine as string) as Record<string, unknown>;
    expect(event).toMatchObject({ event: "CYCLE_PHASE_TIMING", phase: "DECISION_QWEN" });
    expect(Object.keys(event).sort()).toEqual(["durationMs", "event", "phase"]);
    expect(typeof event.durationMs).toBe("number");
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not change phase results when telemetry logging throws", async () => {
    await expect(runTimedCyclePhase("RESEARCH", async () => 42, () => { throw new Error("logging unavailable"); })).resolves.toBe(42);
  });

  it("preserves phase errors even when telemetry logging throws", async () => {
    const failure = new Error("phase failed");
    await expect(runTimedCyclePhase("FINALIZE", async () => { throw failure; }, () => { throw new Error("logging unavailable"); })).rejects.toBe(failure);
  });

  it("exposes only the fixed allowed phases", () => {
    const phases: CyclePhase[] = ["INITIAL_PORTFOLIO", "INSTRUMENTS", "MARKET_SCAN", "MARKET_EVIDENCE", "POSITION_MANAGEMENT", "RESEARCH", "DECISION_QWEN", "EXECUTION_PLAN", "FINALIZE"];
    expect(phases).toHaveLength(9);
  });
});
