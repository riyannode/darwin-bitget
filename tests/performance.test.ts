import { describe, expect, it } from "vitest";
import type { AccountSnapshot, Decision, DecisionExecutionRecord, ExecutionResult, ReconciliationResult, TradeExperience, TradingJournal } from "../src/types.js";
import { bootstrapPerformance, buildPerformanceAccounting, emptyPerformance, migratePerformanceEquityObservations, performanceTotalPnl, recordVerifiedClose, recordVerifiedOpen, recordVerifiedPartial, updateEquity } from "../src/trading/performance.js";

const at = "2026-09-14T10:00:00.000Z";
const account: AccountSnapshot = {
  balance: "1000", availableBalance: "900", availableMargin: "900", marginUsage: "100", positionNotional: "200", totalPositionNotional: "200", positionQuantity: "1", portfolioEquity: "1000", positions: [], realizedPnl: "", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: at,
};

function decision(action: Decision["action"], id: string): Decision {
  return { decisionId: id, cycleId: "cycle-1", action, positionSide: "LONG", symbol: "CRCLUSDT", marginAllocationPct: action === "OPEN_LONG" ? "10" : "0", leverage: "3", reductionPct: action === "CLOSE" ? "100" : null, thesis: "thesis", strategyThesis: "strategy", supportingFactors: ["factor"], riskFactors: ["risk"], evidenceUsed: ["evidence"], lessonsUsed: [], confidence: 0.8, createdAt: at };
}

function execution(action: "OPEN_LONG" | "CLOSE", id: string, pnl?: string): ExecutionResult {
  return { provider: "bitget", providerOrderId: `order-${id}`, clientOrderId: `client-${id}`, symbol: "CRCLUSDT", action, positionSide: "LONG", providerSide: action === "OPEN_LONG" ? "buy" : "sell", tradeSide: action === "OPEN_LONG" ? "open" : "close", marginAllocated: "100", leverage: "3", positionNotional: "300", requestedQuantity: "3", executedQuantity: "3", status: "filled", submittedAt: at, readBackAt: at, ...(pnl !== undefined ? { realizedPnl: pnl } : {}) };
}

function recordFor(action: "OPEN_LONG" | "CLOSE", id: string, pnl?: string): DecisionExecutionRecord {
  const current = execution(action, id, pnl);
  return { decision: decision(action, id), riskGateResult: { status: "PASS", codes: [], checkedAt: at }, executionResult: current, reconciliationResult: { status: "MATCHED", codes: [], execution: current } as ReconciliationResult };
}

function experience(id: string, outcomeStatus: TradeExperience["outcomeStatus"], pnl = "0"): TradeExperience {
  return { experienceId: id, symbol: "CRCLUSDT", positionSide: "LONG", action: "OPEN_LONG", entryDecisionId: "open-1", entryPrice: "100", entryTime: at, exitDecisionId: outcomeStatus === "OPEN" ? "" : "close-1", exitPrice: "100", exitTime: outcomeStatus === "OPEN" ? "" : at, selectedLeverage: "3", marginAllocationPct: "10", marginAllocated: "100", positionNotional: "300", realizedPnl: pnl, realizedPnlPct: "0", maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0", entryThesis: "entry thesis", exitThesis: "exit thesis", evidenceAtEntry: ["ticker"], evidenceAtExit: ["position"], lessonsUsed: [], marketContext: "UNKNOWN", outcomeStatus, realizedPnlVerified: outcomeStatus !== "OPEN" };
}

describe("persisted performance aggregate", () => {
  it("migrates only equity observations and discards stale local lifecycle authority", () => {
    const migrated = migratePerformanceEquityObservations({
      version: "performance-v2",
      competitionBaselineEquity: "1000",
      performanceBaselineAt: at,
      latestEquity: "1050",
      latestEquityObservedAt: "2026-09-15T10:00:00.000Z",
      totalTrades: 8,
      closedTrades: 7,
      wins: 6,
      totalPnl: "19.1364",
      verifiedRealizedPnl: "19.1364",
      dailyPnl: { "2026-09-15": { openingEquity: "1000", latestEquity: "1050", pnl: "50", dailyReturnPct: "5", trades: 1 } },
    }, "2026-09-16T00:00:00.000Z");
    expect(migrated).toMatchObject({ version: "performance-v3-provider-ledger", competitionBaselineEquity: "1000", performanceBaselineAt: at, latestEquity: "1050", latestEquityObservedAt: "2026-09-15T10:00:00.000Z", totalTrades: 0, closedTrades: 0, wins: 0, totalPnl: "UNAVAILABLE", externalFlowStatus: "UNVERIFIED", netExternalInflows: "UNAVAILABLE", dailyPnl: {} });
    expect(JSON.stringify(migrated)).not.toContain("19.1364");
  });

  it("counts verified opens as total/open trades but not outcomes", () => {
    let value = recordVerifiedOpen(emptyPerformance(at), "1000", at);
    expect(value).toMatchObject({ totalTrades: 1, openTrades: 1, closedTrades: 0, wins: 0, losses: 0, breakeven: 0, winRate: "UNAVAILABLE" });
  });

  it("counts verified profitable, losing, and breakeven closes", () => {
    let value = emptyPerformance(at);
    value = recordVerifiedOpen(value, "1000", at);
    value = recordVerifiedOpen(value, "1000", at);
    value = recordVerifiedOpen(value, "1000", at);
    value = recordVerifiedClose(value, "2.50", "1002.50", at);
    value = recordVerifiedClose(value, "-1.25", "1001.25", at);
    value = recordVerifiedClose(value, "0", "1000", at);
    expect(value).toMatchObject({ totalTrades: 3, openTrades: 0, closedTrades: 3, wins: 1, losses: 1, breakeven: 1, winRate: "33.33333333", verifiedRealizedPnl: "1.25" });
  });

  it("counts a verified close without PnL as closed but leaves outcomes unclassified", () => {
    let value = recordVerifiedOpen(emptyPerformance(at), "1000", at);
    value = recordVerifiedClose(value, undefined, "1000", at);
    expect(value).toMatchObject({ totalTrades: 1, openTrades: 0, closedTrades: 1, wins: 0, losses: 0, breakeven: 0, winRate: "UNAVAILABLE", verifiedRealizedPnl: "" });
    value = recordVerifiedOpen(value, "1000", at);
    value = recordVerifiedClose(value, "2", "1002", at);
    expect(value).toMatchObject({ closedTrades: 2, wins: 1, losses: 0, breakeven: 0, winRate: "100" });
  });

  it("keeps the baseline stable and calculates equity delta", () => {
    let value = emptyPerformance(at);
    value = updateEquity(value, "1000", at);
    value = { ...value, competitionBaselineEquity: "1000", performanceBaselineAt: at };
    value = updateEquity(value, "1012.42", "2026-09-14T12:00:00.000Z");
    expect(value.competitionBaselineEquity).toBe("1000");
    expect(performanceTotalPnl(value)).toBe("12.42");
    expect(value.dailyPnl["2026-09-14"]).toMatchObject({ openingEquity: "1000", latestEquity: "1012.42", pnl: "12.42", dailyReturnPct: "1.242", trades: 0 });
  });

  it("adjusts net PnL for explicit external inflows without changing the baseline", () => {
    let value = emptyPerformance(at);
    value = { ...value, competitionBaselineEquity: "1000", performanceBaselineAt: at, netExternalInflows: "25", externalFlowStatus: "VERIFIED" };
    value = updateEquity(value, "1100.125", "2026-09-14T12:00:00.000Z");
    const accounting = buildPerformanceAccounting(value, { portfolioEquity: "1100.125", observedAt: "2026-09-14T12:00:00.000Z" });
    expect(value.competitionBaselineEquity).toBe("1000");
    expect(accounting.equityDeltaSinceBaseline).toBe("100.125");
    expect(accounting.netPnlSinceBaseline).toBe("75.125");
    expect(accounting.netExternalInflows).toBe("25");
  });

  it("keeps negative equity-delta PnL exact", () => {
    let value = emptyPerformance(at);
    value = { ...value, competitionBaselineEquity: "50000.00000000", performanceBaselineAt: at };
    value = updateEquity(value, "49999.87543210", "2026-09-14T12:00:00.000Z");
    expect(performanceTotalPnl(value)).toBe("-0.1245679");
  });

  it("tracks a persisted high-water mark and peak-to-trough drawdown", () => {
    let value = emptyPerformance(at);
    value = { ...value, competitionBaselineEquity: "50000", performanceBaselineAt: at };
    for (const [equity, observedAt] of [["50000", at], ["51000", "2026-09-14T11:00:00.000Z"], ["50500", "2026-09-14T12:00:00.000Z"], ["49500", "2026-09-14T13:00:00.000Z"]] as const) value = updateEquity(value, equity, observedAt);
    expect(value.peakEquity).toBe("51000");
    expect(value.currentDrawdownPct).toBe("2.94117647");
    expect(value.maxDrawdownPct).toBe("2.94117647");
  });

  it("ignores provider observations older than the persisted ledger observation", () => {
    let value = emptyPerformance(at);
    value = { ...value, competitionBaselineEquity: "1000", performanceBaselineAt: at, latestEquity: "1000", latestEquityObservedAt: at };
    value = updateEquity(value, "1010", "2026-09-14T11:00:00.000Z");
    value = updateEquity(value, "9999", "2026-09-14T10:30:00.000Z");
    expect(value.latestEquity).toBe("1010");
    expect(value.latestEquityObservedAt).toBe("2026-09-14T11:00:00.000Z");
  });

  it("does not classify a partial reduce as a closed trade", () => {
    let value = recordVerifiedOpen(emptyPerformance(at), "1000", at);
    const before = { ...value };
    value = updateEquity(value, "1001", "2026-09-14T11:00:00.000Z");
    expect(value).toMatchObject({ totalTrades: before.totalTrades, openTrades: 1, closedTrades: 0, wins: 0, losses: 0, breakeven: 0, winRate: "UNAVAILABLE" });
  });

  it("closes the old episode and opens a new episode for reverse lifecycle accounting", () => {
    let value = recordVerifiedOpen(emptyPerformance(at), "1000", at);
    value = recordVerifiedClose(value, "-2", "998", "2026-09-14T11:00:00.000Z");
    value = recordVerifiedOpen(value, "998", "2026-09-14T11:01:00.000Z");
    expect(value).toMatchObject({ totalTrades: 2, openTrades: 1, closedTrades: 1, wins: 0, losses: 1, breakeven: 0, winRate: "0", verifiedRealizedPnl: "-2" });
  });

  it("does not double-count partial reductions when the episode later closes", () => {
    let value = recordVerifiedOpen(emptyPerformance(at), "1000", at);
    value = recordVerifiedPartial(value, "10", "1010", "2026-09-14T11:00:00.000Z");
    value = recordVerifiedPartial(value, "-2", "1008", "2026-09-14T11:01:00.000Z");
    value = recordVerifiedClose(value, "-3", "1005", "2026-09-14T11:02:00.000Z", "8", "FILL");
    expect(value).toMatchObject({ closedTrades: 1, wins: 1, losses: 0, closedEpisodeRealizedPnl: "5", openEpisodePartialRealizedPnl: "0", verifiedRealizedPnl: "5", winRate: "100" });
  });

  it("treats cumulative position-history PnL as the episode total, not another contribution", () => {
    let value = recordVerifiedOpen(emptyPerformance(at), "1000", at);
    value = recordVerifiedPartial(value, "10", "1010", "2026-09-14T11:00:00.000Z");
    value = recordVerifiedClose(value, "6", "1006", "2026-09-14T11:01:00.000Z", "10", "POSITION_HISTORY_NET_PROFIT");
    expect(value).toMatchObject({ closedEpisodeRealizedPnl: "6", openEpisodePartialRealizedPnl: "0", verifiedRealizedPnl: "6", wins: 1, losses: 0, winRate: "100" });
  });
  it("subtracts the closed episode partial from a signed global partial total", () => {
    let value = emptyPerformance(at);
    value = recordVerifiedOpen(value, "1000", at);
    value = recordVerifiedPartial(value, "10", "1010", "2026-09-14T11:00:00.000Z");
    value = recordVerifiedOpen(value, "1010", "2026-09-14T11:01:00.000Z");
    value = recordVerifiedPartial(value, "-20", "990", "2026-09-14T11:02:00.000Z");
    value = recordVerifiedClose(value, "0", "990", "2026-09-14T11:03:00.000Z", "10", "FILL");
    expect(value.openEpisodePartialRealizedPnl).toBe("-20");
    let opposite = emptyPerformance(at);
    opposite = recordVerifiedOpen(opposite, "1000", at);
    opposite = recordVerifiedPartial(opposite, "-10", "990", "2026-09-14T11:00:00.000Z");
    opposite = recordVerifiedOpen(opposite, "990", "2026-09-14T11:01:00.000Z");
    opposite = recordVerifiedPartial(opposite, "20", "1010", "2026-09-14T11:02:00.000Z");
    opposite = recordVerifiedClose(opposite, "0", "1010", "2026-09-14T11:03:00.000Z", "-10", "FILL");
    expect(opposite.openEpisodePartialRealizedPnl).toBe("20");
  });

  it("uses classified closed trades as the win-rate denominator and leaves zero unavailable", () => {
    const open = emptyPerformance(at);
    expect(buildPerformanceAccounting(open, { portfolioEquity: "1000", observedAt: at }).winRatePct).toBe("UNAVAILABLE");
    let value = recordVerifiedOpen(open, "1000", at);
    value = recordVerifiedClose(value, "2", "1002", at);
    value = recordVerifiedOpen(value, "1002", at);
    value = recordVerifiedClose(value, "-1", "1001", at);
    expect(buildPerformanceAccounting(value, { portfolioEquity: "1001", observedAt: at })).toMatchObject({ wins: 1, losses: 1, classifiedClosedTrades: 2, winRatePct: "50" });
  });

  it("starts daily history at the first trustworthy observation", () => {
    const value = updateEquity(emptyPerformance(at), "1000", "2026-09-14T23:59:00.000Z");
    expect(Object.keys(value.dailyPnl)).toEqual(["2026-09-14"]);
    expect(value.dailyPnl["2026-09-12"]).toBeUndefined();
  });

  it("replays every historical equity observation during migration", () => {
    const equities = ["50000", "51000", "50500", "49500", "50400"];
    const journals = equities.map((equity, index): TradingJournal => ({ cycleId: `equity-${index}`, agentVersion: "1", model: "qwen", mode: "AUTONOMOUS", startedAt: `2026-09-${String(12 + index).padStart(2, "0")}T00:00:00.000Z`, completedAt: `2026-09-${String(12 + index).padStart(2, "0")}T00:01:00.000Z`, portfolio: { ...account, portfolioEquity: equity, observedAt: `2026-09-${String(12 + index).padStart(2, "0")}T00:00:30.000Z` }, retrievedLessons: [], createdLessons: [] }));
    const value = bootstrapPerformance(journals, [], at);
    expect(value).toMatchObject({ competitionBaselineEquity: "50000", latestEquity: "50400", peakEquity: "51000", currentDrawdownPct: "1.17647058", maxDrawdownPct: "2.94117647" });
  });
  it("bootstraps only provider-verified autonomous opens", () => {
    const open = decision("OPEN_LONG", "open-1");
    const verifiedJournal: TradingJournal = { cycleId: "cycle-1", agentVersion: "1", model: "qwen", mode: "AUTONOMOUS", startedAt: at, completedAt: at, portfolio: account, retrievedLessons: [], createdLessons: [], cyclePlan: { positionActions: [], entryActions: [open as never] }, executionRecords: [recordFor("OPEN_LONG", "open-1")] };
    const failedJournal: TradingJournal = { ...verifiedJournal, cycleId: "cycle-2", cyclePlan: { positionActions: [], entryActions: [{ ...open, decisionId: "failed-open" }] as never[] }, executionRecords: [{ ...recordFor("OPEN_LONG", "failed-open"), executionResult: { ...execution("OPEN_LONG", "failed-open"), status: "unknown" } }] };
    const value = bootstrapPerformance([verifiedJournal, failedJournal], [experience("exp-1", "OPEN")], at);
    expect(value.totalTrades).toBe(1);
    expect(value.openTrades).toBe(1);
    expect(value.closedTrades).toBe(0);
  });

  it("rebuilds canonical closed and partial lifecycle accounting", () => {
    const pnls = ["-64.857", "-18.173", "73.6127", "-21.1194"];
    const closed = pnls.map((pnl, index) => experience(`closed-${index}`, pnl === "73.6127" ? "PROFITABLE" : "LOSING", pnl));
    const partial = { ...experience("partial", "OPEN", "3.1374"), realizedPnlVerified: true };
    const reduce = decision("REDUCE", "partial-reduce");
    const reduceExecution = { ...execution("CLOSE", "partial-reduce", "3.1374"), action: "REDUCE" as const };
    const partialJournal: TradingJournal = { cycleId: "partial-cycle", agentVersion: "1", model: "qwen", mode: "AUTONOMOUS", startedAt: at, completedAt: at, retrievedLessons: [], createdLessons: [], decision: reduce, executionResult: reduceExecution, reconciliationResult: { status: "MATCHED", codes: [], execution: reduceExecution } };
    const value = bootstrapPerformance([partialJournal], [...closed, partial], at);
    expect(value).toMatchObject({ closedTrades: 4, wins: 1, losses: 3, breakeven: 0, winRate: "25", closedEpisodeRealizedPnl: "-30.5367", openEpisodePartialRealizedPnl: "3.1374", verifiedRealizedPnl: "-27.3993" });
  });

  it("chooses the earliest trustworthy provider portfolio as the migration baseline", () => {
    const older: TradingJournal = { cycleId: "older", agentVersion: "1", model: "qwen", mode: "AUTONOMOUS", startedAt: "2026-09-12T00:00:00.000Z", completedAt: "2026-09-12T00:01:00.000Z", portfolio: { ...account, portfolioEquity: "50000", observedAt: "2026-09-12T00:00:30.000Z" }, retrievedLessons: [], createdLessons: [] };
    const newer: TradingJournal = { ...older, cycleId: "newer", startedAt: "2026-09-14T09:58:00.000Z", completedAt: "2026-09-14T09:59:00.000Z", portfolio: { ...account, portfolioEquity: "50033.99009667", observedAt: "2026-09-14T09:58:49.197Z" } };
    const value = bootstrapPerformance([newer, older], [], at);
    expect(value).toMatchObject({ competitionBaselineEquity: "50000", performanceBaselineAt: "2026-09-12T00:00:30.000Z", baselineInitializationReason: "EARLIEST_STORED_PROVIDER_OBSERVATION", competitionStartVerified: false });
  });
});
