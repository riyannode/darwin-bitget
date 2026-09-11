import { describe, expect, it } from "vitest";
import { scheduleTradingCycle, type CycleScheduler } from "../src/agent/scheduler.js";

describe("cycle scheduler", () => {
  it("keeps a matching cycle schedule without duplicates", async () => {
    const cancelled: string[] = [];
    let scheduled: { seconds: number; callback: string; idempotent: boolean } | undefined;
    const scheduler: CycleScheduler = {
      listSchedules: async () => [{ id: "old-cycle", callback: "runScheduledCycle", type: "interval", intervalSeconds: 1800 }, { id: "other", callback: "other" }],
      cancelSchedule: async (id) => { cancelled.push(id); return true; },
      scheduleEvery: async (seconds, callback, _payload, options) => { scheduled = { seconds, callback, idempotent: options?._idempotent === true }; return "new-cycle"; },
    };

    await scheduleTradingCycle(scheduler, 30);

    expect(cancelled).toEqual([]);
    expect(scheduled).toBeUndefined();
  });

  it("replaces a cycle schedule when the interval changes", async () => {
    const cancelled: string[] = [];
    const scheduler: CycleScheduler = {
      listSchedules: async () => [{ id: "old-cycle", callback: "runScheduledCycle", type: "interval", intervalSeconds: 900 }],
      cancelSchedule: async (id) => { cancelled.push(id); return true; },
      scheduleEvery: async (seconds, callback, _payload, options) => ({ seconds, callback, idempotent: options?._idempotent === true }),
    };

    await scheduleTradingCycle(scheduler, 30);

    expect(cancelled).toEqual(["old-cycle"]);
  });
});
