import { describe, expect, it } from "vitest";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import { calculateExecutionAmounts, providerQuantityCodes } from "../src/trading/order-quantity.js";
import type { AccountSnapshot, Decision, EvidenceBundle, Instrument, PositionSnapshot, RuntimeConfig } from "../src/types.js";

const config: RuntimeConfig = {
  tradingMode: "PAPER",
  agentMode: "AUTONOMOUS",
  ownerPolicy: { paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 15, emergencyStop: false },
  evidenceMaxAgeSeconds: 90,
  bitgetCategory: "USDT-FUTURES",
  bitgetApiBaseUrl: "https://api.bitget.com",
  qwenBaseUrl: "https://example.test",
  qwenModel: "qwen3.8-max",
};

const account: AccountSnapshot = {
  balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0", positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "1000", positions: [], realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-12T00:00:00.000Z",
};
const market = { symbol: "KORUUSDT", lastPrice: "100", bidPrice: "99.9", askPrice: "100.1", priceChange24h: "0", volume24h: "1000", observedAt: account.observedAt } as const;
const instrument: Instrument = { symbol: "KORUUSDT", category: "USDT-FUTURES", baseCoin: "KORU", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "2", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5" };
const mstrInstrument: Instrument = { symbol: "MSTRUSDT", category: "USDT-FUTURES", baseCoin: "MSTR", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "NO", status: "online", minOrderQty: "0.01", maxOrderQty: "200", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "25" };
const mstrPosition: PositionSnapshot = { symbol: "MSTRUSDT", positionSide: "LONG", quantity: "16.43", notional: "2536.9563", marginAllocated: "847.17427378", leverage: "3", entryPrice: "137.51", markPrice: "154.41", unrealizedPnl: "277.667", unrealizedPnlPct: "32.77566477096616", realizedPnl: "0" };
const mstrMarket = { symbol: "MSTRUSDT", lastPrice: "154.41", bidPrice: "154.40", askPrice: "154.42", priceChange24h: "0.00816", volume24h: "315666.38", observedAt: "2026-09-21T04:14:48.616Z" } as const;
const mstrAccount: AccountSnapshot = { balance: "50000", availableBalance: "47000", availableMargin: "47000", marginUsage: "0", positionNotional: "2536.9563", totalPositionNotional: "2536.9563", positionQuantity: "16.43", portfolioEquity: "50000", positions: [mstrPosition], realizedPnl: "0", unrealizedPnl: "277.667", openOrders: 0, openOrderSymbols: [], observedAt: mstrMarket.observedAt };
const mstrBundle: EvidenceBundle = { market: mstrMarket, account: mstrAccount, instrument: mstrInstrument, evidence: [] };

function mstrDecision(action: "REDUCE" | "CLOSE" | "OPEN_LONG" | "INCREASE", overrides: Partial<Decision> = {}): Decision {
  return { decisionId: "mstr-decision", cycleId: "mstr-cycle", action, positionSide: "LONG", symbol: "MSTRUSDT", marginAllocationPct: action === "OPEN_LONG" ? "1" : "0", additionalMarginPct: action === "INCREASE" ? "1" : null, leverage: "3", reductionPct: action === "REDUCE" ? "25" : action === "CLOSE" ? "100" : null, confidence: 0.7, thesis: "test", strategyThesis: "test", supportingFactors: [], riskFactors: [], evidenceUsed: [], lessonsUsed: [], createdAt: mstrMarket.observedAt, ...overrides };
}

function decision(marginAllocationPct: string): Decision {
  return { decisionId: "decision-1", cycleId: "cycle-1", action: "OPEN_SHORT", positionSide: "SHORT", symbol: "KORUUSDT", marginAllocationPct, leverage: "2", reductionPct: null, confidence: 0.6, thesis: "test", strategyThesis: "test", supportingFactors: [], riskFactors: [], evidenceUsed: [], lessonsUsed: [], createdAt: account.observedAt };
}

describe("provider quantity validation", () => {
  it("allows a quantity below the provider maximum", () => {
    expect(providerQuantityCodes("1.99", instrument, market.lastPrice)).toEqual([]);
  });

  it("allows a quantity exactly at the provider maximum", () => {
    expect(providerQuantityCodes("2", instrument, market.lastPrice)).toEqual([]);
  });

  it("blocks a quantity above the provider maximum before an execution request", () => {
    const result = evaluateRiskGate(config, { decision: decision("10.5"), instrument, account, market, evidenceObservedAt: account.observedAt, openOrderSymbols: [], supportedUniverse: [instrument.symbol], emergencyStop: false, dailyDrawdownBlocked: false });
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toContain("MAX_ORDER_QTY");
  });

  it("blocks the KORU paper maximum without clamping the requested quantity", () => {
    const koru = { ...instrument, maxOrderQty: "100" };
    expect(providerQuantityCodes("116.33", koru, "19.371")).toContain("MAX_ORDER_QTY");
  });

  it("rejects quantities that do not match provider precision or step", () => {
    expect(providerQuantityCodes("1.005", instrument, market.lastPrice)).toEqual(["INVALID_ORDER_QUANTITY"]);
    expect(providerQuantityCodes("0.001", instrument, market.lastPrice)).toEqual(expect.arrayContaining(["MIN_ORDER_QTY", "INVALID_ORDER_QUANTITY"]));
  });
});

describe("provider-safe management quantities", () => {
  it("quantizes a 25% MSTR reduction down to exactly 4.10", () => {
    const amounts = calculateExecutionAmounts(mstrDecision("REDUCE"), mstrBundle);
    expect(amounts.quantity).toBe("4.10");
    expect(amounts.positionNotional).toBe("633.081");
  });

  it("blocks a reduction that quantizes below the provider minimum without rounding up", () => {
    const bundle = { ...mstrBundle, account: { ...mstrAccount, positions: [{ ...mstrPosition, quantity: "0.01", notional: "1.5441", marginAllocated: "0.5" }], positionQuantity: "0.01", positionNotional: "1.5441" } };
    const result = evaluateRiskGate(config, { decision: mstrDecision("REDUCE"), instrument: mstrInstrument, account: bundle.account, market: mstrMarket, evidenceObservedAt: mstrMarket.observedAt, openOrderSymbols: [], supportedUniverse: [mstrInstrument.symbol], emergencyStop: false, dailyDrawdownBlocked: false });
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toEqual(expect.arrayContaining(["MIN_ORDER_QTY", "INVALID_ORDER_QUANTITY"]));
  });

  it("blocks a quantized reduction below minimum notional", () => {
    const instrument = { ...mstrInstrument, minOrderAmount: "1000" };
    const amounts = calculateExecutionAmounts(mstrDecision("REDUCE"), { ...mstrBundle, instrument });
    expect(providerQuantityCodes(amounts.quantity, instrument, mstrMarket.lastPrice)).toContain("MIN_ORDER_AMOUNT");
  });

  it("keeps CLOSE at the complete current provider quantity", () => {
    const amounts = calculateExecutionAmounts(mstrDecision("CLOSE"), mstrBundle);
    expect(amounts.quantity).toBe("16.43");
    expect(providerQuantityCodes(amounts.quantity, mstrInstrument, mstrMarket.lastPrice)).toEqual([]);
  });

  it("keeps existing OPEN and INCREASE quantity behavior unchanged", () => {
    const open = calculateExecutionAmounts(mstrDecision("OPEN_LONG", { marginAllocationPct: "1", reductionPct: null }), { ...mstrBundle, account: { ...mstrAccount, positions: [] } });
    const increase = calculateExecutionAmounts(mstrDecision("INCREASE", { additionalMarginPct: "1", reductionPct: null }), mstrBundle);
    expect(open.quantity).toBe("9.71");
    expect(increase.quantity).toBe("9.71");
  });
});
