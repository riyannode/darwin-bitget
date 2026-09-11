import { describe, expect, it } from "vitest";
import { QWEN_DATA_BOUNDARY } from "../src/agent/mandate.js";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import type { AccountSnapshot, Decision, Instrument, RuntimeConfig } from "../src/types.js";
import { promptRegressionDataset } from "./prompt-regression-dataset.js";

const config: RuntimeConfig = {
  tradingMode: "PAPER",
  agentMode: "AUTONOMOUS",
  ownerPolicy: { paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 15, emergencyStop: false },
  evidenceMaxAgeSeconds: 90,
  bitgetCategory: "USDT-FUTURES",
  bitgetApiBaseUrl: "https://example.test",
  qwenBaseUrl: "https://example.test",
  qwenModel: "qwen3.8-max",
};

const instrument: Instrument = { symbol: "NVDAUSDT", category: "USDT-FUTURES", baseCoin: "NVDA", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5" };
const account: AccountSnapshot = { balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0", positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "1000", positions: [], realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-12T00:00:00.000Z" };

describe("prompt security boundary", () => {
  it("keeps malicious runtime text in a local regression dataset", () => {
    expect(promptRegressionDataset).toHaveLength(3);
    expect(QWEN_DATA_BOUNDARY).toContain("untrusted data");
    expect(QWEN_DATA_BOUNDARY).toContain("PAPER mode");
    expect(QWEN_DATA_BOUNDARY).toContain("authentication");
  });

  it("keeps deterministic limits authoritative over injected thesis text", () => {
    const decision: Decision = { decisionId: "decision-1", cycleId: "cycle-1", action: "OPEN_LONG", positionSide: "LONG", symbol: "NVDAUSDT", marginAllocationPct: "10", leverage: "99", reductionPct: null, confidence: 1, thesis: promptRegressionDataset[1], strategyThesis: promptRegressionDataset[2], supportingFactors: [], riskFactors: [], evidenceUsed: [], lessonsUsed: [], createdAt: "2026-09-12T00:00:00.000Z" };
    const result = evaluateRiskGate(config, { decision, instrument, account, evidenceObservedAt: account.observedAt, openOrderSymbols: [], supportedUniverse: [instrument.symbol], emergencyStop: false, dailyDrawdownBlocked: false });
    expect(result.status).toBe("BLOCK");
    expect(result.codes).toContain("MAX_LEVERAGE");
  });
});
