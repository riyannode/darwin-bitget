import { describe, expect, it } from "vitest";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import type { AccountSnapshot, Action, Decision, Instrument, RuntimeConfig } from "../src/types.js";

// A live provider position with no local lifecycle is only safe to manage in a risk-reducing
// direction. These tests pin that boundary: CLOSE/REDUCE/HOLD pass the lifecycle gate, every
// exposure-increasing action stays blocked, and no other gate is relaxed.

const config: RuntimeConfig = {
  tradingMode: "PAPER",
  agentMode: "AUTONOMOUS",
  ownerPolicy: { paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false },
  evidenceMaxAgeSeconds: 90,
  bitgetCategory: "USDT-FUTURES",
  bitgetApiBaseUrl: "https://api.bitget.com",
  qwenBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  qwenModel: "qwen3.8-max",
};

const instrument: Instrument = { symbol: "COINUSDT", category: "USDT-FUTURES", baseCoin: "COIN", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "crypto", isRwa: "NO", status: "online", minOrderQty: "0.001", maxOrderQty: "100", minOrderAmount: "10", pricePrecision: 2, quantityPrecision: 3, quantityStep: "0.001", leverageMin: "1", leverageMax: "10" };

const observedAt = "2026-09-12T00:00:00.000Z";

/** Provider-live position with no matching local experience. */
const livePositionAccount: AccountSnapshot = {
  balance: "1000",
  availableBalance: "1000",
  availableMargin: "1000",
  marginUsage: "0",
  positionNotional: "200",
  totalPositionNotional: "200",
  positionQuantity: "1",
  portfolioEquity: "1000",
  positions: [{ symbol: "COINUSDT", positionSide: "LONG", quantity: "1", notional: "200", marginAllocated: "50", leverage: "3", entryPrice: "20000", unrealizedPnl: "0", realizedPnl: "0" }],
  realizedPnl: "0",
  unrealizedPnl: "0",
  openOrders: 0,
  openOrderSymbols: [],
  observedAt,
};

const localMissing = ["LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG"];
const providerMissing = ["PROVIDER_POSITION_MISSING:COINUSDT:LONG"];

function decision(action: Action, positionSide: "LONG" | "SHORT" = "LONG", targetPositionSide: "LONG" | "SHORT" | null = null): Decision {
  return {
    decisionId: "decision-1",
    cycleId: "cycle-1",
    action,
    positionSide,
    symbol: "COINUSDT",
    marginAllocationPct: "10",
    additionalMarginPct: action === "INCREASE" ? "5" : null,
    leverage: "3",
    reductionPct: action === "REDUCE" ? "50" : null,
    targetPositionSide,
    confidence: 0.7,
    thesis: "provider-live management",
    strategyThesis: "unattributed live position",
    supportingFactors: ["factor"],
    riskFactors: ["risk"],
    evidenceUsed: ["TICKER"],
    lessonsUsed: [],
    createdAt: observedAt,
  };
}

function context(next: Decision, overrides: Record<string, unknown> = {}) {
  return {
    decision: next,
    instrument,
    account: livePositionAccount,
    market: { symbol: "COINUSDT", lastPrice: "20000", bidPrice: "19999", askPrice: "20001", priceChange24h: "0", volume24h: "1000", observedAt },
    evidenceObservedAt: observedAt,
    openOrderSymbols: [],
    supportedUniverse: ["COINUSDT"],
    emergencyStop: false,
    dailyDrawdownBlocked: false,
    now: new Date(observedAt),
    positionDiscrepancies: localMissing,
    ...overrides,
  };
}

function evaluate(next: Decision, overrides: Record<string, unknown> = {}) {
  return evaluateRiskGate(config, context(next, overrides) as never);
}

describe("provider-live unresolved lifecycle gate", () => {
  it("1. allows CLOSE for a live provider position with no local experience", () => {
    const result = evaluate(decision("CLOSE"));
    expect(result.codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("2. allows REDUCE for a live provider position with no local experience", () => {
    const result = evaluate(decision("REDUCE"));
    expect(result.codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("3. allows HOLD for a live provider position with no local experience", () => {
    const result = evaluate(decision("HOLD"));
    expect(result.status).toBe("PASS");
    expect(result.codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("4. still blocks INCREASE for the same unresolved position", () => {
    const result = evaluate(decision("INCREASE"));
    expect(result.codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("5. still blocks REVERSE for the same unresolved position", () => {
    const result = evaluate(decision("REVERSE", "LONG", "SHORT"));
    expect(result.codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("5b. blocks the reverse close leg so no opposite-side opening can follow", () => {
    const result = evaluate(decision("CLOSE"), { parentDecision: decision("REVERSE", "LONG", "SHORT") });
    expect(result.codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("6. keeps fail-closed behavior when the provider position is missing entirely", () => {
    for (const action of ["CLOSE", "REDUCE", "HOLD"] as const) {
      const result = evaluate(decision(action), { positionDiscrepancies: providerMissing });
      expect(result.codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    }
  });

  it("7. keeps fail-closed behavior when the provider read has no live position", () => {
    const emptyAccount = { ...livePositionAccount, positions: [] } as AccountSnapshot;
    const result = evaluate(decision("CLOSE"), { account: emptyAccount, positionDiscrepancies: providerMissing });
    expect(result.codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("8. keeps emergency stop blocking CLOSE and REDUCE", () => {
    for (const action of ["CLOSE", "REDUCE"] as const) {
      const result = evaluate(decision(action), { emergencyStop: true });
      expect(result.codes).toContain("EMERGENCY_STOP");
    }
  });

  it("9. keeps the unresolved prior execution quarantine blocking CLOSE and REDUCE", () => {
    for (const action of ["CLOSE", "REDUCE"] as const) {
      const result = evaluate(decision(action), { unresolvedExecutionSymbols: ["COINUSDT"] });
      expect(result.codes).toContain("UNRESOLVED_PRIOR_EXECUTION");
    }
  });

  it("10. keeps every other deterministic gate active for a relaxed CLOSE", () => {
    // Drawdown still guards exposure-increasing actions; risk-reducing CLOSE stays allowed.
    expect(evaluate(decision("CLOSE"), { dailyDrawdownBlocked: true }).codes).not.toContain("DAILY_DRAWDOWN");
    expect(evaluate(decision("INCREASE"), { dailyDrawdownBlocked: true }).codes).toContain("DAILY_DRAWDOWN");
    expect(evaluate(decision("CLOSE"), { emergencyStop: true }).codes).toContain("EMERGENCY_STOP");
    expect(evaluate(decision("CLOSE"), { evidenceObservedAt: "2026-09-11T00:00:00.000Z" }).codes).toContain("STALE_EVIDENCE");
    expect(evaluate(decision("CLOSE"), { account: { ...livePositionAccount, openOrders: null } }).codes).toContain("OPEN_ORDERS_READ_UNAVAILABLE");
    expect(evaluate(decision("CLOSE"), { openOrderSymbols: ["COINUSDT"] }).codes).toContain("DUPLICATE_ORDER");
    // Position management is intentionally exempt from the universe gate so an exit stays
    // possible; the exposure-increasing side of the same symbol is not.
    expect(evaluate(decision("CLOSE"), { supportedUniverse: ["BTCUSDT"] }).codes).not.toContain("SYMBOL_NOT_ALLOWED");
    expect(evaluate(decision("OPEN_LONG"), { supportedUniverse: ["BTCUSDT"] }).codes).toContain("SYMBOL_NOT_ALLOWED");
    expect(evaluate(decision("CLOSE"), { instrument: { ...instrument, status: "offline" } }).codes).toContain("INSTRUMENT_UNAVAILABLE");
    // The provider position must still actually exist for a CLOSE to be meaningful.
    expect(evaluate(decision("CLOSE"), { account: { ...livePositionAccount, positions: [] } as AccountSnapshot }).codes).toContain("INSUFFICIENT_POSITION");
  });

  it("11. does not relax a side that does not match the live provider position", () => {
    const result = evaluate(decision("CLOSE", "SHORT"), { positionDiscrepancies: ["LOCAL_EXPERIENCE_MISSING:COINUSDT:SHORT"] });
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toContain("INSUFFICIENT_POSITION");
  });

  it("12. keeps both discrepancy codes independent so neither is globally disabled", () => {
    expect(evaluate(decision("OPEN_LONG"), { positionDiscrepancies: localMissing }).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    expect(evaluate(decision("OPEN_LONG"), { positionDiscrepancies: [] }).codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    expect(evaluate(decision("CLOSE"), { positionDiscrepancies: [...localMissing, ...providerMissing] }).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });
});