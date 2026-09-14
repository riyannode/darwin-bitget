import { describe, expect, it } from "vitest";
import { assertOpenPositionCountWithinPlanLimit, cycleDecisionPlanSchema, buildDecisionPrompt, MAX_TOTAL_ACTIONS_PER_CYCLE, orderCycleActions, rankMarketCandidates, validateCycleDecisionPlan } from "../src/agent/decision.js";
import type { AccountSnapshot, CycleDecisionPlan, Decision, DecisionContext, EvidenceBundle, Instrument, MarketSnapshot, PositionSnapshot } from "../src/types.js";

function snapshot(symbol: string, change = "1", volume = "100"): MarketSnapshot {
  return { symbol, lastPrice: "100", bidPrice: "99.9", askPrice: "100.1", priceChange24h: change, volume24h: volume, observedAt: "2026-09-12T00:00:00.000Z" };
}

function instrument(symbol: string): Instrument {
  return { symbol, category: "USDT-FUTURES", baseCoin: symbol.replace("USDT", ""), quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5" };
}

function position(symbol: string, side: "LONG" | "SHORT" = "LONG"): PositionSnapshot {
  return { symbol, positionSide: side, quantity: "1", notional: "100", marginAllocated: "10", leverage: "2", entryPrice: "100", unrealizedPnl: "0", realizedPnl: "0" };
}

function account(positions: PositionSnapshot[]): AccountSnapshot {
  return { balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0", positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "1000", positions, realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-12T00:00:00.000Z" };
}

function bundle(symbol: string, positions: PositionSnapshot[] = []): EvidenceBundle {
  const market = snapshot(symbol);
  return { market, account: account(positions), instrument: instrument(symbol), evidence: [{ source: "test", observedAt: market.observedAt, type: "DEEP", symbol, payload: {} }] };
}

function decision(action: Decision["action"], symbol: string, side: "LONG" | "SHORT" | null, id = `${action}-${symbol}`): Decision {
  return { decisionId: id, cycleId: "cycle-1", action, positionSide: side, symbol, marginAllocationPct: action === "HOLD" || action === "REDUCE" || action === "CLOSE" ? "0" : "1", leverage: "2", reductionPct: action === "REDUCE" ? "50" : null, confidence: 0.7, thesis: "bounded thesis", strategyThesis: "bounded strategy", supportingFactors: ["deep evidence"], riskFactors: ["risk"], evidenceUsed: ["DEEP"], lessonsUsed: [], createdAt: "2026-09-12T00:00:00.000Z" };
}

function context(positions: PositionSnapshot[], entrySymbols: string[] = ["NVDAUSDT"]): DecisionContext {
  const symbols = [...new Set([...positions.map((item) => item.symbol), ...entrySymbols])];
  return { bundles: symbols.map((symbol) => bundle(symbol, positions)), supportedUniverse: ["NVDAUSDT", "COINUSDT", "CRCLUSDT"], openPositionSymbols: positions.map((item) => item.symbol), entryCandidateSymbols: entrySymbols, experiences: [], openExperiences: [], lessons: [], observedAt: "2026-09-12T00:00:00.000Z", mandate: "mandate", openPositions: positions };
}

function plan(positionActions: Decision[] = [], entryActions: Decision[] = []): CycleDecisionPlan {
  return { positionActions: positionActions as CycleDecisionPlan["positionActions"], entryActions: entryActions as CycleDecisionPlan["entryActions"] };
}

describe("market candidate pre-ranking", () => {
  it("ranks activity deterministically without treating direction as a signal", () => {
    const result = rankMarketCandidates([snapshot("LOWVOLUSDT", "8", "10"), snapshot("HIGHDOWNUSDT", "-2", "90"), snapshot("HIGHUPUSDT", "2", "90"), snapshot("MAXVOLUSDT", "-8", "100")], 4);
    expect(result.map((entry) => entry.symbol)).toEqual(["MAXVOLUSDT", "HIGHDOWNUSDT", "HIGHUPUSDT", "LOWVOLUSDT"]);
  });
});

describe("cycle decision plan contract", () => {
  it("represents one existing CRCL LONG as HOLD", () => {
    const existing = position("CRCLUSDT");
    const value = plan([decision("HOLD", "CRCLUSDT", "LONG")]);
    expect(() => validateCycleDecisionPlan(value, context([existing], []))).not.toThrow();
    expect(value.positionActions[0]).toMatchObject({ action: "HOLD", symbol: "CRCLUSDT", positionSide: "LONG" });
  });

  it("allows CRCL HOLD and NVDA OPEN_LONG in the same cycle", () => {
    const value = plan([decision("HOLD", "CRCLUSDT", "LONG")], [decision("OPEN_LONG", "NVDAUSDT", "LONG")]);
    expect(() => validateCycleDecisionPlan(value, context([position("CRCLUSDT")]))).not.toThrow();
  });

  it("rejects CRCL OPEN_LONG when CRCL is already open", () => {
    const value = plan([decision("HOLD", "CRCLUSDT", "LONG")], [decision("OPEN_LONG", "CRCLUSDT", "LONG")]);
    expect(() => validateCycleDecisionPlan(value, context([position("CRCLUSDT")], ["CRCLUSDT"]))).toThrow("ENTRY_SYMBOL_ALREADY_OPEN");
  });

  it("rejects CRCL OPEN_SHORT when CRCL is already open", () => {
    const value = plan([decision("HOLD", "CRCLUSDT", "LONG")], [decision("OPEN_SHORT", "CRCLUSDT", "SHORT")]);
    expect(() => validateCycleDecisionPlan(value, context([position("CRCLUSDT")], ["CRCLUSDT"]))).toThrow("ENTRY_SYMBOL_ALREADY_OPEN");
  });

  it("allows CRCL CLOSE and NVDA OPEN_LONG in the same cycle", () => {
    const value = plan([decision("CLOSE", "CRCLUSDT", "LONG")], [decision("OPEN_LONG", "NVDAUSDT", "LONG")]);
    expect(() => validateCycleDecisionPlan(value, context([position("CRCLUSDT")]))).not.toThrow();
  });

  it("allows CRCL REDUCE and COIN OPEN_SHORT in the same cycle", () => {
    const value = plan([decision("REDUCE", "CRCLUSDT", "LONG")], [decision("OPEN_SHORT", "COINUSDT", "SHORT")]);
    expect(() => validateCycleDecisionPlan(value, context([position("CRCLUSDT"),], ["COINUSDT"]))).not.toThrow();
  });

  it("requires exactly one management action for every existing position", () => {
    const positions = [position("CRCLUSDT", "LONG"), position("MSTRUSDT", "LONG"), position("TSLAUSDT", "SHORT")];
    const value = plan([decision("HOLD", "CRCLUSDT", "LONG"), decision("CLOSE", "MSTRUSDT", "LONG"), decision("REDUCE", "TSLAUSDT", "SHORT")]);
    expect(() => validateCycleDecisionPlan(value, context(positions, []))).not.toThrow();
    expect(() => validateCycleDecisionPlan(plan([decision("HOLD", "CRCLUSDT", "LONG")]), context(positions, []))).toThrow("MISSING_POSITION_MANAGEMENT");
  });

  it("accepts an empty no-write plan when no positions or opportunities exist", () => {
    expect(() => validateCycleDecisionPlan(plan(), context([], []))).not.toThrow();
  });

  it("rejects more open positions than the five-action plan can represent", () => {
    const positions = Array.from({ length: MAX_TOTAL_ACTIONS_PER_CYCLE + 1 }, (_, index) => position(`OPEN${index}USDT`));
    expect(() => assertOpenPositionCountWithinPlanLimit(positions)).toThrow("OPEN_POSITION_COUNT_EXCEEDS_PLAN_LIMIT");
    expect(() => validateCycleDecisionPlan(plan(positions.map((item) => decision("HOLD", item.symbol, item.positionSide))), context(positions, []))).toThrow("OPEN_POSITION_COUNT_EXCEEDS_PLAN_LIMIT");
  });

  it("accepts exactly five total actions and rejects six", () => {
    const positions = [position("CRCLUSDT"), position("MSTRUSDT"), position("TSLAUSDT", "SHORT")];
    const five = plan([decision("HOLD", "CRCLUSDT", "LONG"), decision("HOLD", "MSTRUSDT", "LONG"), decision("HOLD", "TSLAUSDT", "SHORT")], [decision("OPEN_LONG", "NVDAUSDT", "LONG"), decision("OPEN_SHORT", "COINUSDT", "SHORT")]);
    expect(five.positionActions.length + five.entryActions.length).toBe(MAX_TOTAL_ACTIONS_PER_CYCLE);
    expect(() => validateCycleDecisionPlan(five, context(positions, ["NVDAUSDT", "COINUSDT"]))).not.toThrow();
    const six = { positionActions: five.positionActions, entryActions: [...five.entryActions, decision("OPEN_LONG", "CRCLUSDT", "LONG")] as CycleDecisionPlan["entryActions"] };
    expect(() => validateCycleDecisionPlan(six, context(positions, ["NVDAUSDT", "COINUSDT", "CRCLUSDT"]))).toThrow("MAX_TOTAL_ACTIONS_PER_CYCLE");
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: five.positionActions, entryActions: [...five.entryActions, five.entryActions[0]] })).toThrow();
  });

  it("rejects duplicate or nonexistent management actions", () => {
    const existing = position("CRCLUSDT");
    expect(() => validateCycleDecisionPlan(plan([decision("HOLD", "CRCLUSDT", "LONG"), decision("CLOSE", "CRCLUSDT", "LONG", "duplicate")]), context([existing], []))).toThrow("DUPLICATE_MANAGEMENT_ACTION");
    expect(() => validateCycleDecisionPlan(plan([decision("CLOSE", "MSTRUSDT", "LONG")]), context([existing], []))).toThrow("POSITION_NOT_OPEN");
  });

  it("rejects unsupported or duplicate new entries but allows management outside the supported universe", () => {
    const existing = position("LEGACYUSDT");
    expect(() => validateCycleDecisionPlan(plan([decision("HOLD", "LEGACYUSDT", "LONG")]), context([existing], []))).not.toThrow();
    expect(() => validateCycleDecisionPlan(plan([decision("CLOSE", "LEGACYUSDT", "LONG")]), context([existing], []))).not.toThrow();
    expect(() => validateCycleDecisionPlan(plan([], [decision("OPEN_LONG", "OTHERUSDT", "LONG")]), context([], ["OTHERUSDT"]))).toThrow("SYMBOL_NOT_ALLOWED");
    expect(() => validateCycleDecisionPlan(plan([], [decision("OPEN_LONG", "NVDAUSDT", "LONG"), decision("OPEN_SHORT", "NVDAUSDT", "SHORT")]), context([], ["NVDAUSDT"]))).toThrow("DUPLICATE_ENTRY_ACTION");
  });

  it("orders CLOSE before REDUCE before OPEN and HOLD", () => {
    const ordered = orderCycleActions(plan([decision("HOLD", "ZUSDT", "LONG"), decision("REDUCE", "AUSDT", "LONG"), decision("CLOSE", "BUSDT", "LONG")], [decision("OPEN_LONG", "CUSDT", "LONG")]));
    expect(ordered.map((item) => item.action)).toEqual(["CLOSE", "REDUCE", "OPEN_LONG", "HOLD"]);
  });

  it("labels management and entry evidence separately in the prompt", () => {
    const existing = position("CRCLUSDT");
    const prompt = buildDecisionPrompt(context([existing]), "cycle-1");
    expect(prompt).toContain('"openPositionEvidence"');
    expect(prompt).toContain('"entryCandidateEvidence"');
    expect(prompt).toContain('"supportedUniverse"');
    expect(prompt).toContain('"maxTotalActionsPerCycle":5');
  });
});
