import { describe, expect, it } from "vitest";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import type { AccountSnapshot, Action, Decision, Instrument, RuntimeConfig } from "../src/types.js";

const config: RuntimeConfig = {
  tradingMode: "PAPER", agentMode: "AUTONOMOUS", ownerPolicy: { paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 15, emergencyStop: false }, evidenceMaxAgeSeconds: 90, bitgetCategory: "USDT-FUTURES", bitgetApiBaseUrl: "https://api.bitget.com", qwenBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", qwenModel: "qwen3.8-max",
};

const instrument: Instrument = { symbol: "BTCUSDT", category: "USDT-FUTURES", baseCoin: "BTC", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "crypto", isRwa: "NO", status: "online", minOrderQty: "0.001", maxOrderQty: "100", minOrderAmount: "10", pricePrecision: 2, quantityPrecision: 3, quantityStep: "0.001", leverageMin: "1", leverageMax: "10" };
const account: AccountSnapshot = { balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0", positionNotional: "200", totalPositionNotional: "200", positionQuantity: "0.01", portfolioEquity: "1000", positions: [{ symbol: "BTCUSDT", positionSide: "LONG", quantity: "0.01", notional: "200", marginAllocated: "50", leverage: "4", entryPrice: "20000", unrealizedPnl: "0", realizedPnl: "0" }], realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-12T00:00:00.000Z" };

function decision(action: Action, marginAllocationPct = "10", leverage = "2", reductionPct: string | null = null, additionalMarginPct: string | null = null, positionSide: "LONG" | "SHORT" = "LONG", targetPositionSide: "LONG" | "SHORT" | null = null): Decision {
  return { decisionId: "decision-1", cycleId: "cycle-1", action, positionSide, symbol: "BTCUSDT", marginAllocationPct, additionalMarginPct, leverage, reductionPct, targetPositionSide, confidence: 0.7, thesis: "evidence", strategyThesis: "contextual futures hypothesis", supportingFactors: ["factor"], riskFactors: ["risk"], evidenceUsed: ["TICKER"], lessonsUsed: [], createdAt: "2026-09-12T00:00:00.000Z" };
}

function context(next: Decision, availableMargin = account.availableMargin, accountOverride: AccountSnapshot = account) { return { decision: next, instrument, account: { ...accountOverride, availableMargin }, market: { symbol: "BTCUSDT", lastPrice: "20000", bidPrice: "19999", askPrice: "20001", priceChange24h: "0", volume24h: "1000", observedAt: account.observedAt }, evidenceObservedAt: account.observedAt, openOrderSymbols: [], supportedUniverse: ["BTCUSDT"], emergencyStop: false, dailyDrawdownBlocked: false, now: new Date(account.observedAt) }; }

describe("futures risk gate", () => {
  it("blocks public-only entries even when a position is already held", () => {
    for (const symbol of ["SOXLUSDT", "SNXXUSDT"]) {
      const next = context({ ...decision("OPEN_LONG"), symbol });
      const result = evaluateRiskGate(config, { ...next, instrument: { ...instrument, symbol }, supportedUniverse: ["KORUUSDT", "NVDAUSDT"] });
      expect(result.codes).toContain("SYMBOL_NOT_ALLOWED");
    }
    expect(evaluateRiskGate(config, { ...context(decision("OPEN_LONG")), supportedUniverse: [] }).codes).toContain("SYMBOL_NOT_ALLOWED");
  });

  it("retains existing position exits when executable discovery is empty", () => {
    expect(evaluateRiskGate(config, { ...context(decision("CLOSE", "0", "1")), supportedUniverse: [] }).status).toBe("PASS");
    expect(evaluateRiskGate(config, { ...context(decision("REDUCE", "0", "1", "20")), supportedUniverse: [] }).status).toBe("PASS");
  });
  it("blocks margin allocation above owner limit and unavailable margin", () => {
    const result = evaluateRiskGate(config, context(decision("OPEN_LONG", "40", "2"), "50"));
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toEqual(expect.arrayContaining(["MAX_SINGLE_POSITION_MARGIN_PCT", "INSUFFICIENT_MARGIN"]));
  });

  it("keeps financial actions blocked during daily drawdown cooldown", () => {
    const result = evaluateRiskGate(config, { ...context(decision("OPEN_LONG")), dailyDrawdownBlocked: true });
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toContain("DAILY_DRAWDOWN");
  });

  it("does not impose a fixed profit or loss exit rule", () => {
    const result = evaluateRiskGate(config, context(decision("HOLD", "0", "1")));
    expect(result.status).toBe("PASS");
  });

  it("allows a bounded reduction for the selected position side", () => {
    const result = evaluateRiskGate(config, context(decision("REDUCE", "0", "1", "20")));
    expect(result.status).toBe("PASS");
  });

  it("fails closed when the provider position has no usable local lifecycle", () => {
    const result = evaluateRiskGate(config, { ...context(decision("REDUCE", "0", "1", "20")), positionDiscrepancies: ["LOCAL_EXPERIENCE_MISSING:BTCUSDT:LONG"] });
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("calculates INCREASE post-action margin against the hard cap", () => {
    const twentyFourPercent: AccountSnapshot = { ...account, positions: [{ ...account.positions[0]!, marginAllocated: "240" }] };
    const accepted = evaluateRiskGate(config, context(decision("INCREASE", "0", "4", null, "5"), "1000", twentyFourPercent));
    expect(accepted.status).toBe("PASS");
    const blocked = evaluateRiskGate(config, context(decision("INCREASE", "0", "2", null, "10"), "1000", twentyFourPercent));
    expect(blocked.status).toBe("BLOCK");
    expect(blocked.codes).toContain("MAX_SINGLE_POSITION_MARGIN_PCT");
  });

  it("uses the provider leverage for INCREASE and rejects model leverage overrides", () => {
    const accepted = evaluateRiskGate(config, context(decision("INCREASE", "0", "4", null, "5")));
    expect(accepted.status).toBe("PASS");
    const override = evaluateRiskGate(config, context(decision("INCREASE", "0", "6", null, "5")));
    expect(override.status).toBe("BLOCK");
    expect(override.codes).toEqual(expect.arrayContaining(["LEVERAGE_CHANGE_NOT_ALLOWED", "MAX_LEVERAGE"]));
  });

  it("requires REVERSE to target the opposite side", () => {
    const valid = evaluateRiskGate(config, context(decision("REVERSE", "10", "2", null, null, "LONG", "SHORT")));
    expect(valid.status).toBe("PASS");
    const invalid = evaluateRiskGate(config, context(decision("REVERSE", "10", "2", null, null, "LONG", "LONG")));
    expect(invalid.status).toBe("BLOCK");
    expect(invalid.codes).toContain("REVERSE_TARGET_SIDE_NOT_OPPOSITE");
  });

  it("blocks leverage above the owner boundary", () => {
    const result = evaluateRiskGate(config, context(decision("OPEN_LONG", "10", "6")));
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toContain("MAX_LEVERAGE");
  });

  it("blocks stale evidence", () => {
    const result = evaluateRiskGate(config, { ...context(decision("OPEN_LONG", "10", "2")), evidenceObservedAt: "2026-09-11T23:00:00.000Z" });
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toContain("STALE_EVIDENCE");
  });
});
