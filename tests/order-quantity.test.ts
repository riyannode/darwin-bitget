import { describe, expect, it } from "vitest";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import { providerQuantityCodes } from "../src/trading/order-quantity.js";
import type { AccountSnapshot, Decision, Instrument, RuntimeConfig } from "../src/types.js";

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
