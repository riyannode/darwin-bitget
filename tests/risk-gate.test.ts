import { describe, expect, it } from "vitest";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import type { AccountSnapshot, Action, Decision, Instrument, RuntimeConfig } from "../src/types.js";

const config: RuntimeConfig = {
  tradingMode: "PAPER", agentMode: "AUTONOMOUS", ownerPolicy: { paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 15, emergencyStop: false }, evidenceMaxAgeSeconds: 90, bitgetCategory: "USDT-FUTURES", bitgetApiBaseUrl: "https://api.bitget.com", qwenBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", qwenModel: "qwen3.8-max",
};

const instrument: Instrument = { symbol: "BTCUSDT", category: "USDT-FUTURES", baseCoin: "BTC", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "crypto", isRwa: "NO", status: "online", minOrderQty: "0.001", maxOrderQty: "100", minOrderAmount: "10", pricePrecision: 2, quantityPrecision: 3, quantityStep: "0.001", leverageMin: "1", leverageMax: "10" };
const account: AccountSnapshot = { balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0", positionNotional: "200", totalPositionNotional: "200", positionQuantity: "0.01", portfolioEquity: "1000", positions: [{ symbol: "BTCUSDT", positionSide: "LONG", quantity: "0.01", notional: "200", marginAllocated: "50", leverage: "4", entryPrice: "20000", unrealizedPnl: "0", realizedPnl: "0" }], realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-12T00:00:00.000Z" };

function decision(action: Action, marginAllocationPct = "10", leverage = "2", reductionPct: string | null = null): Decision {
  const side = action === "OPEN_SHORT" || (action !== "OPEN_LONG" && action !== "HOLD" && action !== "REDUCE" && action !== "CLOSE" && false) ? "SHORT" : action === "REDUCE" || action === "CLOSE" ? "LONG" : action === "OPEN_LONG" ? "LONG" : null;
  return { decisionId: "decision-1", cycleId: "cycle-1", action, positionSide: side, symbol: "BTCUSDT", marginAllocationPct, leverage, reductionPct, confidence: 0.7, thesis: "evidence", strategyThesis: "contextual futures hypothesis", supportingFactors: ["factor"], riskFactors: ["risk"], evidenceUsed: ["TICKER"], lessonsUsed: [], createdAt: "2026-09-12T00:00:00.000Z" };
}

function context(next: Decision, availableMargin = account.availableMargin) { return { decision: next, instrument, account: { ...account, availableMargin }, evidenceObservedAt: account.observedAt, openOrderSymbols: [], supportedUniverse: ["BTCUSDT"], emergencyStop: false, dailyDrawdownBlocked: false, now: new Date(account.observedAt) }; }

describe("futures risk gate", () => {
  it("blocks margin allocation above owner limit and unavailable margin", () => {
    const result = evaluateRiskGate(config, context(decision("OPEN_LONG", "40", "2"), "50"));
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toEqual(expect.arrayContaining(["MAX_SINGLE_POSITION_MARGIN_PCT", "INSUFFICIENT_MARGIN"]));
  });

  it("does not impose a fixed profit or loss exit rule", () => {
    const result = evaluateRiskGate(config, context(decision("HOLD", "0", "1")));
    expect(result.status).toBe("PASS");
  });

  it("allows a bounded reduction for the selected position side", () => {
    const result = evaluateRiskGate(config, context(decision("REDUCE", "0", "1", "25")));
    expect(result.status).toBe("PASS");
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
