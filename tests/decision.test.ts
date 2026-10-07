import { describe, expect, it } from "vitest";
import { assertOpenPositionCountWithinPlanLimit, buildCycleDecisionPlanSchema, buildDecisionPrompt, calculateActionCapacity, countOpenPositionLifecycles, cycleDecisionPlanSchema, buildEvidenceSymbols, filterNewEntryMarketCandidates, MAX_FINANCIAL_WRITES_PER_CYCLE, MAX_TOTAL_ACTIONS_PER_CYCLE, orderCycleActions, rankMarketCandidates, selectDeterministicEntryCandidates, validateCycleDecisionPlan } from "../src/agent/decision.js";
import type { AccountSnapshot, CycleDecisionPlan, Decision, DecisionContext, EvidenceBundle, Instrument, MarketSnapshot, PositionManagementState, PositionSnapshot, TradeExperience } from "../src/types.js";
import { buildDecisionTaskPrompt, DECISION_TASK_PROMPT, PROMPT_VERSIONS } from "../src/agent/mandate.js";

function snapshot(symbol: string, change = "1", volume = "100"): MarketSnapshot {
  return { symbol, lastPrice: "100", bidPrice: "99.9", askPrice: "100.1", priceChange24h: change, volume24h: volume, observedAt: "2026-09-12T00:00:00.000Z" };
}

function instrument(symbol: string): Instrument {
  return { symbol, category: "USDT-FUTURES", baseCoin: symbol.replace("USDT", ""), quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5" };
}

function position(symbol: string, side: "LONG" | "SHORT" = "LONG", marginAllocated = "10"): PositionSnapshot {
  return { symbol, positionSide: side, quantity: "1", notional: "100", marginAllocated, leverage: "2", entryPrice: "100", unrealizedPnl: "0", realizedPnl: "0" };
}

function account(positions: PositionSnapshot[]): AccountSnapshot {
  return { balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0", positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "1000", positions, realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-12T00:00:00.000Z" };
}

function bundle(symbol: string, positions: PositionSnapshot[] = []): EvidenceBundle {
  const market = snapshot(symbol);
  return { market, account: account(positions), instrument: instrument(symbol), evidence: [{ source: "test", observedAt: market.observedAt, type: "DEEP", symbol, payload: {} }] };
}

function decision(action: Decision["action"], symbol: string, side: "LONG" | "SHORT" | null, id = `${action}-${symbol}`, overrides: Partial<Decision> = {}): Decision {
  const target = side === "LONG" ? "SHORT" : side === "SHORT" ? "LONG" : null;
  return { decisionId: id, cycleId: "cycle-1", action, positionSide: side, symbol, marginAllocationPct: action === "HOLD" || action === "INCREASE" || action === "REDUCE" || action === "CLOSE" ? "0" : "1", additionalMarginPct: action === "INCREASE" ? "5" : null, leverage: "2", reductionPct: action === "REDUCE" ? "50" : action === "CLOSE" ? "100" : null, targetPositionSide: action === "REVERSE" ? target : null, confidence: 0.7, thesis: "bounded thesis", strategyThesis: "bounded strategy", supportingFactors: ["deep evidence"], riskFactors: ["risk"], evidenceUsed: ["DEEP"], lessonsUsed: [], createdAt: "2026-09-12T00:00:00.000Z", ...overrides };
}

function context(positions: PositionSnapshot[], entrySymbols: string[] = ["NVDAUSDT"], positionManagementState: PositionManagementState[] = []): DecisionContext {
  const symbols = [...new Set([...positions.map((item) => item.symbol), ...entrySymbols])];
  return { bundles: symbols.map((symbol) => bundle(symbol, positions)), supportedUniverse: ["NVDAUSDT", "COINUSDT", "CRCLUSDT"], openPositionSymbols: positions.map((item) => item.symbol), entryCandidateSymbols: entrySymbols, experiences: [], openExperiences: [], lessons: [], observedAt: "2026-09-12T00:00:00.000Z", mandate: "mandate", openPositions: positions, positionManagementState };
}

function openExperience(experienceId: string, outcomeStatus: TradeExperience["outcomeStatus"] = "OPEN"): TradeExperience {
  return {
    experienceId, symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG", entryDecisionId: `entry-${experienceId}`,
    entryPrice: "190.81", entryTime: "2026-09-12T00:00:00.000Z", exitDecisionId: "", exitPrice: "0", exitTime: "",
    selectedLeverage: "3", marginAllocationPct: "10", marginAllocated: "700", positionNotional: "2100",
    realizedPnl: "0", realizedPnlPct: "0", maximumFavorableExcursion: "UNAVAILABLE", maximumAdverseExcursion: "UNAVAILABLE",
    drawdownContribution: "UNAVAILABLE", liquidationDistance: "UNAVAILABLE", entryThesis: experienceId, exitThesis: "",
    evidenceAtEntry: [], evidenceAtExit: [], lessonsUsed: [], marketContext: "UNKNOWN", outcomeStatus, origin: "DARWIN",
  } as TradeExperience;
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
  it("serializes only resolved current OPEN lifecycles while preserving completed history", () => {
    const stale = openExperience("stale-darwin-open");
    const current = openExperience("repaired-current-open");
    const completed = openExperience("completed-history", "PROFITABLE");
    const decisionContext = {
      ...context([position("COINUSDT")], []),
      experiences: [stale, completed, current],
      openExperiences: [current],
    };

    const prompt = JSON.parse(buildDecisionPrompt(decisionContext, "cycle-1")) as {
      openExperiences: TradeExperience[];
      experiences: TradeExperience[];
    };

    expect(prompt.openExperiences.map((experience) => experience.experienceId)).toEqual(["repaired-current-open"]);
    expect(prompt.experiences.map((experience) => experience.experienceId)).toEqual(["completed-history", "repaired-current-open"]);
    expect(JSON.stringify(prompt)).not.toContain("stale-darwin-open");
  });

  it("does not serialize stale local OPEN history as current for an external live position", () => {
    const stale = openExperience("stale-darwin-open");
    const decisionContext = {
      ...context([position("COINUSDT")], []),
      experiences: [stale],
      openExperiences: [],
    };

    const prompt = JSON.parse(buildDecisionPrompt(decisionContext, "cycle-1")) as {
      openExperiences: TradeExperience[];
      experiences: TradeExperience[];
    };

    expect(prompt.openExperiences).toEqual([]);
    expect(prompt.experiences).toEqual([]);
    expect(JSON.stringify(prompt)).not.toContain("stale-darwin-open");
  });


  it("represents one existing CRCL LONG as HOLD", () => {
    const existing = position("CRCLUSDT");
    const value = plan([decision("HOLD", "CRCLUSDT", "LONG")]);
    expect(() => validateCycleDecisionPlan(value, context([existing], []))).not.toThrow();
    expect(value.positionActions[0]).toMatchObject({ action: "HOLD", symbol: "CRCLUSDT", positionSide: "LONG" });
  });

  it("accepts numeric zero representations for management margins and numeric 100 for CLOSE", () => {
    for (const marginAllocationPct of ["0", "0.0", "0.00"]) {
      expect(() => cycleDecisionPlanSchema.parse({ positionActions: [decision("HOLD", "CRCLUSDT", "LONG", "hold-schema", { marginAllocationPct })], entryActions: [] })).not.toThrow();
    }
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [decision("INCREASE", "CRCLUSDT", "LONG", "increase-schema", { marginAllocationPct: "0.0", additionalMarginPct: "5" })], entryActions: [] })).not.toThrow();
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [decision("REDUCE", "CRCLUSDT", "LONG", "reduce-schema", { marginAllocationPct: "0.00", reductionPct: "50" })], entryActions: [] })).not.toThrow();
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [decision("CLOSE", "CRCLUSDT", "LONG", "close-schema", { marginAllocationPct: "0.0", reductionPct: "100.0" })], entryActions: [] })).not.toThrow();
  });

  it("rejects positive management margins and non-total CLOSE reductions", () => {
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [decision("HOLD", "CRCLUSDT", "LONG", "hold-positive", { marginAllocationPct: "5" })], entryActions: [] })).toThrow("INVALID_MARGIN_ALLOCATION");
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [decision("CLOSE", "CRCLUSDT", "LONG", "close-partial", { marginAllocationPct: "0.0", reductionPct: "90" })], entryActions: [] })).toThrow("INVALID_REDUCTION_PCT");
  });

  it("accepts the structured decision field types", () => {
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_LONG", "NVDAUSDT", "LONG")] })).not.toThrow();
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_LONG", "NVDAUSDT", "LONG", "valid-fields", { thesis: "one thesis", strategyThesis: "one strategy", confidence: 0.5, supportingFactors: ["one factor"], riskFactors: ["one risk"], evidenceUsed: ["DEEP"], lessonsUsed: ["lesson-1"] })] })).not.toThrow();
  });

  it("rejects scalar values for array decision fields", () => {
    for (const field of ["riskFactors", "supportingFactors", "evidenceUsed", "lessonsUsed"] as const) {
      expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_LONG", "NVDAUSDT", "LONG", `${field}-scalar`, { [field]: "one item" })] })).toThrow();
    }
  });

  it("accepts OPEN_LONG only with LONG positionSide", () => {
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_LONG", "NVDAUSDT", "LONG")] })).not.toThrow();
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_LONG", "NVDAUSDT", "SHORT")] })).toThrow("INVALID_POSITION_SIDE");
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_LONG", "NVDAUSDT", null)] })).toThrow("INVALID_POSITION_SIDE");
  });

  it("accepts OPEN_SHORT only with SHORT positionSide", () => {
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_SHORT", "NVDAUSDT", "SHORT")] })).not.toThrow();
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_SHORT", "NVDAUSDT", "LONG")] })).toThrow("INVALID_POSITION_SIDE");
    expect(() => cycleDecisionPlanSchema.parse({ positionActions: [], entryActions: [decision("OPEN_SHORT", "NVDAUSDT", null)] })).toThrow("INVALID_POSITION_SIDE");
  });

  it("allows CRCL HOLD and NVDA OPEN_LONG in the same cycle", () => {
    const value = plan([decision("HOLD", "CRCLUSDT", "LONG")], [decision("OPEN_LONG", "NVDAUSDT", "LONG")]);
    expect(() => validateCycleDecisionPlan(value, context([position("CRCLUSDT")]))).not.toThrow();
  });

  it("allows CRCL INCREASE and NVDA OPEN_LONG in the same cycle", () => {
    const value = plan([decision("INCREASE", "CRCLUSDT", "LONG")], [decision("OPEN_LONG", "NVDAUSDT", "LONG")]);
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

  it("accepts INCREASE only for the actually open provider side", () => {
    expect(() => validateCycleDecisionPlan(plan([decision("INCREASE", "CRCLUSDT", "LONG")]), context([position("CRCLUSDT", "LONG")], []))).not.toThrow();
    expect(() => validateCycleDecisionPlan(plan([decision("INCREASE", "CRCLUSDT", "SHORT")]), context([position("CRCLUSDT", "LONG")], []))).toThrow("POSITION_NOT_OPEN");
  });

  it("requires REVERSE to target the opposite side", () => {
    expect(() => validateCycleDecisionPlan(plan([decision("REVERSE", "CRCLUSDT", "LONG")]), context([position("CRCLUSDT", "LONG")], []))).not.toThrow();
    expect(() => validateCycleDecisionPlan(plan([decision("REVERSE", "CRCLUSDT", "SHORT")]), context([position("CRCLUSDT", "SHORT")], []))).not.toThrow();
    expect(() => validateCycleDecisionPlan(plan([decision("REVERSE", "CRCLUSDT", "LONG", "reverse-same", { targetPositionSide: "LONG" })]), context([position("CRCLUSDT", "LONG")], []))).toThrow("REVERSE_TARGET_SIDE_NOT_OPPOSITE");
  });

  it("requires exactly one management action for every existing position", () => {
    const positions = [position("CRCLUSDT", "LONG"), position("MSTRUSDT", "LONG"), position("TSLAUSDT", "SHORT")];
    const value = plan([decision("HOLD", "CRCLUSDT", "LONG"), decision("CLOSE", "MSTRUSDT", "LONG"), decision("REDUCE", "TSLAUSDT", "SHORT")]);
    expect(() => validateCycleDecisionPlan(value, context(positions, []))).not.toThrow();
    expect(() => validateCycleDecisionPlan(plan([decision("HOLD", "CRCLUSDT", "LONG")]), context(positions, []))).toThrow("MISSING_POSITION_MANAGEMENT");
  });

  it("accepts an empty no-write plan when no positions or opportunities exist", () => {
    expect(() => validateCycleDecisionPlan(plan(), context([], []))).not.toThrow();
    const holdOnly = plan([decision("HOLD", "CRCLUSDT", "LONG")], []);
    expect(() => validateCycleDecisionPlan(holdOnly, context([position("CRCLUSDT")], []))).not.toThrow();
    expect(holdOnly.entryActions).toEqual([]);
  });

  it("keeps remaining entry capacity aligned with the five-position cap", () => {
    expect([0, 1, 2, 3, 4, 5].map((openCount) => calculateActionCapacity(openCount).remainingEntrySlots)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(MAX_TOTAL_ACTIONS_PER_CYCLE).toBe(5);
  });

  it("counts provider position sides rather than unique symbols for entry capacity", () => {
    const positions = [position("AAPLUSDT", "LONG"), position("AAPLUSDT", "SHORT"), position("METAUSDT", "LONG"), position("TSLAUSDT", "LONG"), position("KORUUSDT", "SHORT")];
    const count = countOpenPositionLifecycles(positions);
    expect(count).toBe(5);
    expect(calculateActionCapacity(count).remainingEntrySlots).toBe(0);
  });

  it("rejects more open positions than the five-action plan can represent", () => {
    const positions = Array.from({ length: MAX_TOTAL_ACTIONS_PER_CYCLE + 1 }, (_, index) => position(`OPEN${index}USDT`));
    expect(() => assertOpenPositionCountWithinPlanLimit(positions)).toThrow("OPEN_POSITION_COUNT_EXCEEDS_PLAN_LIMIT");
    expect(() => validateCycleDecisionPlan(plan(positions.map((item) => decision("HOLD", item.symbol, item.positionSide))), context(positions, []))).toThrow("OPEN_POSITION_COUNT_EXCEEDS_PLAN_LIMIT");
  });

  it("calculates remaining entry slots without changing the five-action cap", () => {
    expect(calculateActionCapacity(5)).toEqual({ openPositionCount: 5, remainingEntrySlots: 0 });
    expect(calculateActionCapacity(4)).toEqual({ openPositionCount: 4, remainingEntrySlots: 1 });
    expect(MAX_TOTAL_ACTIONS_PER_CYCLE).toBe(5);
  });

  it("returns no entry candidates when remaining capacity is zero", () => {
    expect(selectDeterministicEntryCandidates([snapshot("NVDAUSDT")], ["NVDAUSDT"], [], 0)).toEqual([]);
  });

  it("selects the first two ranked candidates without changing rank order", () => {
    const ranked = rankMarketCandidates([snapshot("LOWUSDT", "1", "1"), snapshot("TOPUSDT", "5", "100"), snapshot("MIDUSDT", "3", "30")]);
    const selected = selectDeterministicEntryCandidates(ranked, ["LOWUSDT", "TOPUSDT", "MIDUSDT"], [], 2);
    expect(selected).toEqual(["TOPUSDT", "MIDUSDT"]);
  });

  it("excludes currently open and unsupported symbols without changing remaining rank order", () => {
    const ranked = [snapshot("OPENUSDT"), snapshot("UNSUPPORTEDUSDT"), snapshot("FIRSTUSDT"), snapshot("SECONDUSDT")];
    const selected = selectDeterministicEntryCandidates(ranked, ["OPENUSDT", "FIRSTUSDT", "SECONDUSDT"], ["OPENUSDT"], 2);
    expect(selected).toEqual(["FIRSTUSDT", "SECONDUSDT"]);
    expect(buildEvidenceSymbols(["OPENUSDT"], selected)).toEqual(["OPENUSDT", "FIRSTUSDT", "SECONDUSDT"]);
  });

  it("bounds shortlist length by the total action capacity", () => {
    expect(selectDeterministicEntryCandidates(Array.from({ length: 7 }, (_, index) => snapshot(`S${index}USDT`)), Array.from({ length: 7 }, (_, index) => `S${index}USDT`), [], 99)).toHaveLength(MAX_TOTAL_ACTIONS_PER_CYCLE);
  });

  it("enforces capacity in the generated model schema before semantic execution", () => {
    const positions = ["CRCLUSDT", "SKHYUSDT", "HOODUSDT", "MSTRUSDT", "COINUSDT"];
    const valid = { positionActions: positions.map((symbol) => decision("HOLD", symbol, "LONG")), entryActions: [] };
    expect(() => buildCycleDecisionPlanSchema(5).parse(valid)).not.toThrow();
    expect(() => buildCycleDecisionPlanSchema(5).parse({ positionActions: valid.positionActions.slice(0, 4), entryActions: [] })).toThrow();
    expect(() => buildCycleDecisionPlanSchema(5).parse({ positionActions: valid.positionActions, entryActions: [decision("OPEN_LONG", "NVDAUSDT", "LONG")] })).toThrow();
    expect(() => validateCycleDecisionPlan(plan(valid.positionActions), context(positions.map((symbol) => position(symbol)), []))).not.toThrow();
  });

  it("allows only one entry for four positions and two for three positions", () => {
    const four = buildCycleDecisionPlanSchema(4);
    const three = buildCycleDecisionPlanSchema(3);
    const positionActions = (count: number) => Array.from({ length: count }, (_, index) => decision("HOLD", `OPEN${index}USDT`, "LONG"));
    expect(() => four.parse({ positionActions: positionActions(4), entryActions: [decision("OPEN_LONG", "NVDAUSDT", "LONG")] })).not.toThrow();
    expect(() => four.parse({ positionActions: positionActions(4), entryActions: [decision("OPEN_LONG", "NVDAUSDT", "LONG"), decision("OPEN_LONG", "COINUSDT", "LONG")] })).toThrow();
    expect(() => three.parse({ positionActions: positionActions(3), entryActions: [decision("OPEN_LONG", "NVDAUSDT", "LONG"), decision("OPEN_LONG", "COINUSDT", "LONG")] })).not.toThrow();
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
    const ordered = orderCycleActions(plan([decision("HOLD", "ZUSDT", "LONG"), decision("INCREASE", "DUSDT", "LONG"), decision("REDUCE", "AUSDT", "LONG"), decision("CLOSE", "BUSDT", "LONG")], [decision("OPEN_LONG", "CUSDT", "LONG")]));
    expect(ordered.map((item) => item.action)).toEqual(["CLOSE", "REDUCE", "INCREASE", "OPEN_LONG", "HOLD"]);
  });

  it("rejects a five-intent plan whose reverse expansion would exceed the physical-write cap", () => {
    const reverse = decision("REVERSE", "CRCLUSDT", "LONG");
    const entries = ["NVDAUSDT", "COINUSDT", "MSTRUSDT", "TSLAUSDT"].map((symbol) => decision("OPEN_LONG", symbol, "LONG"));
    const value = plan([reverse], entries);
    const testContext = { ...context([position("CRCLUSDT")], entries.map((entry) => entry.symbol)), supportedUniverse: ["CRCLUSDT", ...entries.map((entry) => entry.symbol)] };
    expect(MAX_FINANCIAL_WRITES_PER_CYCLE).toBe(5);
    expect(() => validateCycleDecisionPlan(value, testContext)).toThrow("MAX_FINANCIAL_WRITES_PER_CYCLE");
  });

  it("sends full evidence once and keeps open/entry symbols to identify its role", () => {
    const existing = position("CRCLUSDT");
    const payload = JSON.parse(buildDecisionPrompt(context([existing], ["NVDAUSDT"]), "cycle-1")) as {
      deepEvidence: Array<{ symbol: string; market: { lastPrice: string } }>;
      openPositionSymbols: string[];
      entryCandidateSymbols: string[];
      openPositionEvidence?: unknown;
      entryCandidateEvidence?: unknown;
    };
    expect(payload.deepEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "CRCLUSDT", market: expect.objectContaining({ lastPrice: "100" }) }),
      expect.objectContaining({ symbol: "NVDAUSDT", market: expect.objectContaining({ lastPrice: "100" }) }),
    ]));
    expect(payload.openPositionSymbols).toContain("CRCLUSDT");
    expect(payload.entryCandidateSymbols).toContain("NVDAUSDT");
    expect(payload).not.toHaveProperty("openPositionEvidence");
    expect(payload).not.toHaveProperty("entryCandidateEvidence");
  });

  it("keeps management and entry constraints while labeling evidence by symbol", () => {
    const existing = position("CRCLUSDT");
    const prompt = buildDecisionPrompt(context([existing]), "cycle-1");
    expect(prompt).toContain('"openPositionSymbols":["CRCLUSDT"]');
    expect(prompt).toContain('"entryCandidateSymbols":["NVDAUSDT"]');
    expect(prompt).toContain('"supportedUniverse"');
    expect(prompt).toContain('"maxTotalActionsPerCycle":5');
    expect(prompt).toContain('"maxFinancialWritesPerCycle":5');
    expect(prompt).toContain('"executionCapacityHints"');
    expect(prompt).toContain("positionManagementState contains deterministic TypeScript-computed lifecycle values");
    expect(prompt).toContain('"openPositionCount":1');
    expect(prompt).toContain('"remainingEntrySlots":4');
    expect(prompt).toContain("entryActions.length MUST NOT exceed remainingEntrySlots");
    expect(PROMPT_VERSIONS.decision).toBe("darwin-decision-v10");
    expect(DECISION_TASK_PROMPT).toContain("use openPositionSymbols and entryCandidateSymbols to distinguish existing-position and entry-candidate evidence");
    expect(DECISION_TASK_PROMPT).toContain('HOLD: positionSide = actual provider side, marginAllocationPct = "0"');
    expect(DECISION_TASK_PROMPT).toContain('INCREASE: positionSide = actual provider side, marginAllocationPct = "0"');
    expect(DECISION_TASK_PROMPT).toContain('REDUCE: positionSide = actual provider side, marginAllocationPct = "0"');
    expect(DECISION_TASK_PROMPT).toContain('CLOSE: positionSide = actual provider side, marginAllocationPct = "0"');
    expect(DECISION_TASK_PROMPT).toContain('REVERSE: positionSide = current provider side, targetPositionSide is opposite');
    expect(DECISION_TASK_PROMPT).toContain('For OPEN_LONG entryActions, positionSide MUST be "LONG"; for OPEN_SHORT entryActions, positionSide MUST be "SHORT".');
    expect(DECISION_TASK_PROMPT).toContain('marginAllocationPct is positive, leverage is proposed leverage');
    expect(DECISION_TASK_PROMPT).toContain("TypeScript will not silently clamp an invalid proposal");
    expect(DECISION_TASK_PROMPT).toContain("supportingFactors: JSON array of strings");
    expect(DECISION_TASK_PROMPT).toContain("riskFactors: JSON array of strings");
    expect(DECISION_TASK_PROMPT).toContain("evidenceUsed: JSON array of strings");
    expect(DECISION_TASK_PROMPT).toContain("lessonsUsed: JSON array of strings");
    expect(DECISION_TASK_PROMPT).toContain("thesis: string");
    expect(DECISION_TASK_PROMPT).toContain("strategyThesis: string");
    expect(DECISION_TASK_PROMPT).toContain("confidence: number between 0 and 1");
    expect(DECISION_TASK_PROMPT).toContain("HARD OUTPUT LIMITS");
    expect(DECISION_TASK_PROMPT).toContain("thesis: <=500 characters");
    expect(DECISION_TASK_PROMPT).toContain("strategyThesis: <=500 characters");
    expect(DECISION_TASK_PROMPT).toContain("each supportingFactors item: <=240 characters");
    expect(DECISION_TASK_PROMPT).toContain("each riskFactors item: <=240 characters");
  });

  it("includes deterministic position lifecycle state in the prompt", () => {
    const prompt = buildDecisionPrompt(context([position("CRCLUSDT")], [], [{ symbol: "CRCLUSDT", positionSide: "LONG", entryPrice: "100", currentPrice: "106", currentReturnPct: 6, maximumFavorableReturnPct: 10, maximumFavorableReturnBasis: "SINCE_ENTRY", profitGivebackPct: 40, timeInTradeMinutes: 15, priorManagementActions: ["HOLD", "HOLD", "REDUCE", "HOLD"] }]), "cycle-1");
    expect(prompt).toContain('"currentReturnPct":6');
    expect(prompt).toContain('"maximumFavorableReturnPct":10');
    expect(prompt).toContain('"profitGivebackPct":40');
    expect(prompt).toContain('"timeInTradeMinutes":15');
    expect(prompt).toContain('"priorManagementActions":["HOLD","HOLD","REDUCE","HOLD"]');
  });

  it("requires no entry actions when five positions consume the action capacity", () => {
    const prompt = buildDecisionPrompt(context([position("CRCLUSDT"), position("SKHYUSDT"), position("HOODUSDT"), position("MSTRUSDT"), position("COINUSDT")]), "cycle-1");
    expect(prompt).toContain('"openPositionCount":5');
    expect(prompt).toContain('"remainingEntrySlots":0');
    expect(prompt).toContain("If remainingEntrySlots = 0, entryActions MUST be []");
    expect(prompt).toContain("PORTFOLIO CAPACITY IS FULL");
    expect(buildDecisionTaskPrompt(false, 5, 0)).toContain("Do not evaluate or propose unrelated new entries in this cycle");
  });

  it("allows one entry slot when four positions require management", () => {
    const prompt = buildDecisionPrompt(context([position("CRCLUSDT"), position("SKHYUSDT"), position("HOODUSDT"), position("MSTRUSDT")]), "cycle-1");
    expect(prompt).toContain('"openPositionCount":4');
    expect(prompt).toContain('"remainingEntrySlots":1');
  });

  it("omits Signal-specific material when the disabled context has no research evidence", () => {
    const prompt = buildDecisionPrompt(context([position("CRCLUSDT")]), "cycle-1");
    expect(prompt).not.toContain("researchEvidence");
    expect(prompt).not.toContain("researchRule");
    expect(buildDecisionTaskPrompt(false)).not.toContain("Research signals");
    expect(buildDecisionTaskPrompt(true)).toContain("Research signals");
    const enabledPrompt = buildDecisionPrompt({ ...context([position("CRCLUSDT")]), researchEvidence: [] }, "cycle-1");
    expect(enabledPrompt).toContain("researchEvidence");
    expect(enabledPrompt).toContain("researchRule");
  });
});
