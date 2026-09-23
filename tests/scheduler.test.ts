import { describe, expect, it } from "vitest";
import { reconcileProviderLedgerSchedule, scheduleTradingCycle, temporaryScanIntervalActive, TEMPORARY_SCAN_INTERVAL_DURATION_MS, TEMPORARY_SCAN_INTERVAL_MINUTES, PROVIDER_LEDGER_INTERVAL_SECONDS, type CycleScheduler } from "../src/agent/scheduler.js";

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

  it("maintains exactly one separate 15-minute provider-ledger schedule", async () => {
    let schedules = [{ id: "provider-old", callback: "runScheduledProviderSync", type: "interval", intervalSeconds: 300 }];
    const cancelled: string[] = [];
    const scheduler: CycleScheduler = {
      listSchedules: async () => schedules,
      cancelSchedule: async (id) => { cancelled.push(id); schedules = schedules.filter((schedule) => schedule.id !== id); return true; },
      scheduleEvery: async (seconds, callback) => {
        schedules.push({ id: "provider-new", callback, type: "interval", intervalSeconds: seconds });
        return "provider-new";
      },
    };
    expect(await reconcileProviderLedgerSchedule(scheduler)).toBe(true);
    expect(PROVIDER_LEDGER_INTERVAL_SECONDS).toBe(900);
    expect(cancelled).toEqual(["provider-old"]);
    expect(schedules).toEqual([{ id: "provider-new", callback: "runScheduledProviderSync", type: "interval", intervalSeconds: 900 }]);
    expect(await reconcileProviderLedgerSchedule(scheduler)).toBe(true);
    expect(schedules).toHaveLength(1);
  });

  it("keeps the temporary interval active for exactly two hours", () => {
    const activatedAt = Date.parse("2026-09-12T00:00:00.000Z");
    const expiresAt = new Date(activatedAt + TEMPORARY_SCAN_INTERVAL_DURATION_MS).toISOString();

    expect(TEMPORARY_SCAN_INTERVAL_MINUTES).toBe(3);
    expect(TEMPORARY_SCAN_INTERVAL_DURATION_MS).toBe(2 * 60 * 60 * 1000);
    expect(temporaryScanIntervalActive(expiresAt, false, activatedAt + TEMPORARY_SCAN_INTERVAL_DURATION_MS - 1)).toBe(true);
    expect(temporaryScanIntervalActive(expiresAt, false, activatedAt + TEMPORARY_SCAN_INTERVAL_DURATION_MS)).toBe(false);
    expect(temporaryScanIntervalActive(expiresAt, true, activatedAt)).toBe(false);
  });
});
