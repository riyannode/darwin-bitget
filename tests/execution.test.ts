import { describe, expect, it } from "vitest";
import { buildExecutionRequest } from "../src/trading/execution.js";
import type { Decision, EvidenceBundle } from "../src/types.js";

const decision: Decision = { decisionId: "decision-1", cycleId: "cycle-1", action: "OPEN_LONG", positionSide: "LONG", symbol: "BTCUSDT", marginAllocationPct: "10", leverage: "2", reductionPct: null, confidence: 0.7, thesis: "bounded paper entry", strategyThesis: "bounded futures hypothesis", supportingFactors: ["ticker"], riskFactors: ["uncertainty"], evidenceUsed: ["TICKER"], lessonsUsed: [], createdAt: "2026-09-12T00:00:00.000Z" };
const bundle = { market: { symbol: "BTCUSDT", lastPrice: "200.25", bidPrice: "200.20", askPrice: "200.30", priceChange24h: "0.01", volume24h: "1000", observedAt: "2026-09-12T00:00:00.000Z" }, account: { balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0", positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "1000", positions: [], realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-12T00:00:00.000Z" }, instrument: { symbol: "BTCUSDT", category: "USDT-FUTURES", baseCoin: "BTC", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "crypto", isRwa: "NO", status: "online", minOrderQty: "0.001", maxOrderQty: "100", minOrderAmount: "10", pricePrecision: 2, quantityPrecision: 4, quantityStep: "0.0001", leverageMin: "1", leverageMax: "10" }, evidence: [] } satisfies EvidenceBundle;

describe("paper futures execution request", () => {
  it("derives notional from margin and leverage with integer arithmetic", () => {
    const request = buildExecutionRequest(decision, bundle, "12345678-1234-1234-1234-123456789012");
    expect(request.marginAllocated).toBe("100");
    expect(request.positionNotional).toBe("200");
    expect(request.quantity).toBe("0.9987");
    expect(request.providerSide).toBe("buy");
    expect(request.tradeSide).toBe("open");
    expect(request.clientOrderId).toHaveLength(32);
  });

  it("increases the existing side with additional margin and provider leverage", () => {
    const increase: Decision = { ...decision, decisionId: "decision-increase", action: "INCREASE", marginAllocationPct: "0", additionalMarginPct: "5", leverage: "10", positionSide: "LONG" };
    const existing = { symbol: "BTCUSDT", positionSide: "LONG" as const, quantity: "0.5", notional: "400.5", marginAllocated: "100.125", leverage: "4", entryPrice: "200.25", unrealizedPnl: "-2", realizedPnl: "0" };
    const request = buildExecutionRequest(increase, { ...bundle, account: { ...bundle.account, positions: [existing] } }, "12345678-1234-1234-1234-123456789012");
    expect(request.marginAllocated).toBe("50");
    expect(request.positionNotional).toBe("200");
    expect(request.leverage).toBe("4");
    expect(request.providerSide).toBe("buy");
    expect(request.tradeSide).toBe("open");
  });
});
