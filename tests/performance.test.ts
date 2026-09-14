import { describe, expect, it } from "vitest";
import type { AccountSnapshot, Decision, DecisionExecutionRecord, ExecutionResult, ReconciliationResult, TradeExperience, TradingJournal } from "../src/types.js";
import { bootstrapPerformance, emptyPerformance, performanceTotalPnl, recordVerifiedClose, recordVerifiedOpen, updateEquity } from "../src/trading/performance.js";

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

  it("starts daily history at the first trustworthy observation", () => {
    const value = updateEquity(emptyPerformance(at), "1000", "2026-09-14T23:59:00.000Z");
    expect(Object.keys(value.dailyPnl)).toEqual(["2026-09-14"]);
    expect(value.dailyPnl["2026-09-12"]).toBeUndefined();
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
});
