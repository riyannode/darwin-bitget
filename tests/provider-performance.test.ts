import { describe, expect, it } from "vitest";
import { rebuildProviderPerformance } from "../src/trading/provider-performance.js";

describe("provider-backed DARWIN performance rebuild", () => {
  it("counts one unique provider lifecycle, not execution fragments, and excludes external/unattributed PnL", () => {
    const input = [
      { lifecycleId: "1485976014620573698", origin: "DARWIN" as const, status: "CLOSED" as const, netProfit: "33.19485709", closedAt: "2026-09-22T01:43:06.332Z" },
      { lifecycleId: "1485976014620573698", origin: "DARWIN" as const, status: "CLOSED" as const, netProfit: "33.19485709", closedAt: "2026-09-22T01:43:06.332Z" },
      { lifecycleId: "provider-external-1", origin: "PROVIDER_EXTERNAL" as const, status: "CLOSED" as const, netProfit: "900" },
      { lifecycleId: "unattributed-1", origin: "UNATTRIBUTED" as const, status: "CLOSED" as const, netProfit: "100" },
      { lifecycleId: "open-order-1", origin: "DARWIN" as const, status: "OPEN" as const },
    ];
    expect(rebuildProviderPerformance(input)).toEqual({
      source: "PROVIDER_LEDGER",
      closedTrades: 1,
      openTrades: 1,
      totalTrades: 2,
      wins: 1,
      losses: 0,
      breakeven: 0,
      closedEpisodeRealizedPnl: "33.19485709",
      verifiedRealizedPnl: "33.19485709",
      unresolvedClosedLifecycles: 0,
      dailyPnl: { "2026-09-22": { pnl: "33.19485709", trades: 1 } },
    });
  });

  it("does not claim verified PnL for a closed provider lifecycle missing netProfit", () => {
    expect(rebuildProviderPerformance([{ lifecycleId: "closed-1", origin: "DARWIN", status: "CLOSED" }])).toMatchObject({
      closedTrades: 1,
      wins: 0,
      losses: 0,
      breakeven: 0,
      closedEpisodeRealizedPnl: "UNAVAILABLE",
      verifiedRealizedPnl: "UNAVAILABLE",
      unresolvedClosedLifecycles: 1,
    });
  });

  it("fails closed when the same provider lifecycle has contradictory classifications", () => {
    expect(() => rebuildProviderPerformance([
      { lifecycleId: "same", origin: "DARWIN", status: "CLOSED", netProfit: "1" },
      { lifecycleId: "same", origin: "PROVIDER_EXTERNAL", status: "CLOSED", netProfit: "1" },
    ])).toThrow("PROVIDER_PERFORMANCE_DUPLICATE_LIFECYCLE_CONTRADICTION");
  });
});
