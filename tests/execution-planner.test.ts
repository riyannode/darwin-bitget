import { describe, expect, it } from "vitest";
import { executeCyclePlan } from "../src/trading/execution-planner.js";
import type { AccountSnapshot, CycleDecisionPlan, Decision, DecisionExecutionRecord, EvidenceBundle, ExecutionResult, ReconciliationResult } from "../src/types.js";

const account = (availableMargin: string): AccountSnapshot => ({ balance: "1000", availableBalance: availableMargin, availableMargin, marginUsage: "0", positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "1000", positions: [], realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-12T00:00:00.000Z" });
const decision = (action: Decision["action"], symbol: string, positionSide: "LONG" | "SHORT" = "LONG"): Decision => ({ decisionId: `${action}-${symbol}`, cycleId: "cycle-1", action, positionSide, symbol, marginAllocationPct: action === "OPEN_LONG" || action === "OPEN_SHORT" ? "1" : "0", leverage: "1", reductionPct: action === "REDUCE" ? "50" : null, confidence: 0.5, thesis: "thesis", strategyThesis: "strategy", supportingFactors: ["factor"], riskFactors: ["risk"], evidenceUsed: ["evidence"], lessonsUsed: [], createdAt: "2026-09-12T00:00:00.000Z" });
const bundle = (symbol: string, availableMargin: string): EvidenceBundle => ({ market: { symbol, lastPrice: "100", bidPrice: "99", askPrice: "101", priceChange24h: "1", volume24h: "100", observedAt: "2026-09-12T00:00:00.000Z" }, account: account(availableMargin), instrument: { symbol, category: "USDT-FUTURES", baseCoin: symbol.replace("USDT", ""), quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5" }, evidence: [] });

function result(item: Decision, status: "filled" | "unknown" = "filled"): DecisionExecutionRecord {
  if (item.action === "HOLD") return { decision: item, riskGateResult: { status: "PASS", codes: [], checkedAt: "2026-09-12T00:00:00.000Z" } };
  const execution: ExecutionResult = { provider: "test", clientOrderId: `client-${item.decisionId}`, symbol: item.symbol, action: item.action === "REVERSE" ? "CLOSE" : item.action, positionSide: item.positionSide ?? "LONG", providerSide: "buy", tradeSide: item.action === "OPEN_LONG" || item.action === "OPEN_SHORT" ? "open" : "close", marginAllocated: "10", leverage: "1", positionNotional: "10", requestedQuantity: "1", executedQuantity: status === "filled" ? "1" : "0", status, submittedAt: "2026-09-12T00:00:00.000Z", readBackAt: "2026-09-12T00:00:00.000Z" };
  const reconciliation: ReconciliationResult = { status: status === "filled" ? "MATCHED" : "UNKNOWN", codes: [], execution };
  return { decision: item, riskGateResult: { status: "PASS", codes: [], checkedAt: "2026-09-12T00:00:00.000Z" }, executionResult: execution, reconciliationResult: reconciliation };
}

describe("sequential cycle execution planner", () => {
  it("uses CLOSE, REDUCE, OPEN order and refreshes portfolio between writes", async () => {
    const close = decision("CLOSE", "CRCLUSDT");
    const reduce = decision("REDUCE", "MSTRUSDT");
    const entry = decision("OPEN_LONG", "NVDAUSDT");
    const hold = decision("HOLD", "TSLAUSDT", "SHORT");
    const plan = { positionActions: [hold, reduce, close] as CycleDecisionPlan["positionActions"], entryActions: [entry] as CycleDecisionPlan["entryActions"] };
    const events: string[] = [];
    let refreshCount = 0;
    const resultValue = await executeCyclePlan(plan, {
      refreshEvidence: async (symbol) => { events.push(`evidence:${symbol}`); return bundle(symbol, refreshCount === 0 ? "100" : "50"); },
      execute: async (item, current, category) => { events.push(`execute:${item.action}:${current.account.availableMargin}:${category}`); return result(item); },
      persist: async (item) => { events.push(`persist:${item.decision.action}`); },
      refreshPortfolio: async () => { refreshCount += 1; events.push(`portfolio:${refreshCount}`); return account(String(100 - refreshCount * 10)); },
    });
    expect(resultValue.stoppedAfterAmbiguity).toBe(false);
    expect(resultValue.records.map((item) => item.decision.action)).toEqual(["CLOSE", "REDUCE", "OPEN_LONG", "HOLD"]);
    expect(events.filter((event) => event.startsWith("portfolio:"))).toEqual(["portfolio:1", "portfolio:2", "portfolio:3"]);
    expect(events.indexOf("portfolio:1")).toBeLessThan(events.indexOf("evidence:MSTRUSDT"));
    expect(events.indexOf("portfolio:2")).toBeLessThan(events.indexOf("evidence:NVDAUSDT"));
    expect(events.indexOf("portfolio:3")).toBeGreaterThan(events.indexOf("persist:OPEN_LONG"));
  });

  it("stops after the first unresolved write and does not call later execution", async () => {
    const first = decision("CLOSE", "CRCLUSDT");
    const second = decision("OPEN_LONG", "NVDAUSDT");
    const executed: string[] = [];
    const resultValue = await executeCyclePlan({ positionActions: [first] as CycleDecisionPlan["positionActions"], entryActions: [second] as CycleDecisionPlan["entryActions"] }, {
      refreshEvidence: async (symbol) => bundle(symbol, "100"),
      execute: async (item) => { executed.push(item.symbol); return result(item, "unknown"); },
      persist: async () => undefined,
      refreshPortfolio: async () => account("100"),
    });
    expect(resultValue.stoppedAfterAmbiguity).toBe(true);
    expect(executed).toEqual(["CRCLUSDT"]);
    expect(resultValue.records).toHaveLength(1);
  });

  it("stops after a filled write whose position readback is unresolved", async () => {
    const first = decision("CLOSE", "CRCLUSDT");
    const second = decision("OPEN_LONG", "NVDAUSDT");
    const executed: string[] = [];
    const resultValue = await executeCyclePlan({ positionActions: [first] as CycleDecisionPlan["positionActions"], entryActions: [second] as CycleDecisionPlan["entryActions"] }, {
      refreshEvidence: async (symbol) => bundle(symbol, "100"),
      execute: async (item) => {
        executed.push(item.symbol);
        const base = result(item);
        return { ...base, reconciliationResult: { ...base.reconciliationResult!, status: "MISMATCH" as const, codes: ["POSITION_READBACK_UNAVAILABLE"] } };
      },
      persist: async () => undefined,
      refreshPortfolio: async () => account("100"),
    });
    expect(resultValue.stoppedAfterAmbiguity).toBe(true);
    expect(executed).toEqual(["CRCLUSDT"]);
    expect(resultValue.records).toHaveLength(1);
  });

  it("expands REVERSE into a verified close, unrelated entry, then opposite entry", async () => {
    const reverse: Decision = { ...decision("CLOSE", "CRCLUSDT"), decisionId: "reverse-1", action: "REVERSE", marginAllocationPct: "10", targetPositionSide: "SHORT", reductionPct: null };
    const unrelated = decision("OPEN_LONG", "NVDAUSDT");
    const events: string[] = [];
    const resultValue = await executeCyclePlan({ positionActions: [reverse] as CycleDecisionPlan["positionActions"], entryActions: [unrelated] as CycleDecisionPlan["entryActions"] }, {
      refreshEvidence: async (symbol) => { events.push(`evidence:${symbol}`); return bundle(symbol, "100"); },
      execute: async (item, _current, actionCategory, parent) => { events.push(`execute:${item.action}:${actionCategory}:${parent?.decisionId ?? "none"}`); return result(item); },
      persist: async (item) => { events.push(`persist:${item.decision.action}:${item.parentDecisionId ?? "none"}`); },
      refreshPortfolio: async () => { events.push("portfolio"); return account("100"); },
    });
    expect(resultValue.stoppedAfterAmbiguity).toBe(false);
    expect(resultValue.records.map((record) => record.decision.action)).toEqual(["CLOSE", "OPEN_LONG", "OPEN_SHORT"]);
    expect(resultValue.records.filter((record) => record.parentDecisionId === "reverse-1")).toHaveLength(2);
    expect(events.filter((event) => event.startsWith("execute:")).map((event) => event.split(":")[1])).toEqual(["CLOSE", "OPEN_LONG", "OPEN_SHORT"]);
  });

  it("never submits the opposite entry when reverse close is unresolved", async () => {
    const reverse: Decision = { ...decision("CLOSE", "CRCLUSDT"), decisionId: "reverse-unresolved", action: "REVERSE", marginAllocationPct: "10", targetPositionSide: "SHORT", reductionPct: null };
    const executed: string[] = [];
    const resultValue = await executeCyclePlan({ positionActions: [reverse] as CycleDecisionPlan["positionActions"], entryActions: [] }, {
      refreshEvidence: async (symbol) => bundle(symbol, "100"),
      execute: async (item) => { executed.push(item.action); return result(item, "unknown"); },
      persist: async () => undefined,
      refreshPortfolio: async () => account("100"),
    });
    expect(resultValue.stoppedAfterAmbiguity).toBe(true);
    expect(executed).toEqual(["CLOSE"]);
  });

  it("stops before the opposite entry on reverse close mismatch or visible old position", async () => {
    const reverse: Decision = { ...decision("CLOSE", "CRCLUSDT"), decisionId: "reverse-mismatch", action: "REVERSE", marginAllocationPct: "10", targetPositionSide: "SHORT", reductionPct: null };
    const mismatched = await executeCyclePlan({ positionActions: [reverse] as CycleDecisionPlan["positionActions"], entryActions: [] }, {
      refreshEvidence: async (symbol) => bundle(symbol, "100"),
      execute: async (item) => { const recordValue = result(item); return { ...recordValue, reconciliationResult: { ...recordValue.reconciliationResult!, status: "MISMATCH" as const } }; },
      persist: async () => undefined,
      refreshPortfolio: async () => account("100"),
    });
    expect(mismatched.records.map((record) => record.decision.action)).toEqual(["CLOSE"]);
    const visible = await executeCyclePlan({ positionActions: [reverse] as CycleDecisionPlan["positionActions"], entryActions: [] }, {
      refreshEvidence: async (symbol) => bundle(symbol, "100"),
      execute: async (item) => result(item),
      persist: async () => undefined,
      refreshPortfolio: async () => ({ ...account("100"), positions: [{ symbol: "CRCLUSDT", positionSide: "LONG", quantity: "1", notional: "100", marginAllocated: "10", leverage: "1", entryPrice: "100", unrealizedPnl: "0", realizedPnl: "0" }] }),
    });
    expect(visible.records.map((record) => record.decision.action)).toEqual(["CLOSE"]);
    expect(visible.stoppedAfterAmbiguity).toBe(true);
  });

  it("keeps a reverse closed when the opposite entry risk gate blocks", async () => {
    const reverse: Decision = { ...decision("CLOSE", "CRCLUSDT"), decisionId: "reverse-blocked", action: "REVERSE", marginAllocationPct: "10", targetPositionSide: "SHORT", reductionPct: null };
    const executed: string[] = [];
    const resultValue = await executeCyclePlan({ positionActions: [reverse] as CycleDecisionPlan["positionActions"], entryActions: [] }, {
      refreshEvidence: async (symbol) => bundle(symbol, "100"),
      execute: async (item) => { executed.push(item.action); return item.action === "OPEN_SHORT" ? { decision: item, riskGateResult: { status: "BLOCK", codes: ["MAX_LEVERAGE"], checkedAt: "2026-09-12T00:00:00.000Z" } } : result(item); },
      persist: async () => undefined,
      refreshPortfolio: async () => account("100"),
    });
    expect(resultValue.stoppedAfterAmbiguity).toBe(false);
    expect(executed).toEqual(["CLOSE", "OPEN_SHORT"]);
    expect(resultValue.records[1]?.executionResult).toBeUndefined();
  });
});
