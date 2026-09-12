import { describe, expect, it } from "vitest";
import { autonomousDecisionSetSchema, buildDecisionPrompt, rankMarketCandidates } from "../src/agent/decision.js";
import type { AccountSnapshot, DecisionContext, EvidenceBundle, Instrument, MarketSnapshot } from "../src/types.js";

function snapshot(symbol: string, change: string, volume: string): MarketSnapshot {
  return { symbol, lastPrice: "100", bidPrice: "99.9", askPrice: "100.1", priceChange24h: change, volume24h: volume, observedAt: "2026-09-12T00:00:00.000Z" };
}

describe("market candidate pre-ranking", () => {
  it("ranks activity without treating price direction as a signal", () => {
    const result = rankMarketCandidates([
      snapshot("LOWVOLUSDT", "8", "10"),
      snapshot("HIGHDOWNUSDT", "-2", "90"),
      snapshot("HIGHUPUSDT", "2", "90"),
      snapshot("MAXVOLUSDT", "-8", "100"),
    ], 4);

    expect(result.map((entry) => entry.symbol)).toEqual(["MAXVOLUSDT", "HIGHDOWNUSDT", "HIGHUPUSDT", "LOWVOLUSDT"]);
  });

  it("limits the Qwen retrieval pool to the configured bound", () => {
    const scan = Array.from({ length: 30 }, (_, index) => snapshot(`STOCK${index}USDT`, String(index), String(index + 1)));

    expect(rankMarketCandidates(scan)).toHaveLength(25);
  });

  it("sends only deep-evidence symbols to the decision prompt", () => {
    const instrument: Instrument = { symbol: "NVDAUSDT", category: "USDT-FUTURES", baseCoin: "NVDA", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5" };
    const market: MarketSnapshot = snapshot("NVDAUSDT", "1", "100");
    const account: AccountSnapshot = { balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0", positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "1000", positions: [], realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: market.observedAt };
    const bundle: EvidenceBundle = { market, account, instrument, evidence: [] };
    const context: DecisionContext = { bundles: [bundle], supportedUniverse: ["NVDAUSDT", "OTHERUSDT"], experiences: [], openExperiences: [], lessons: [], observedAt: market.observedAt, mandate: "mandate", openPositions: [] };

    const prompt = buildDecisionPrompt(context, "cycle-1");

    expect(prompt).toContain('"deepEvidenceSymbols":["NVDAUSDT"]');
    expect(prompt).toContain('"portfolio"');
    expect(prompt).not.toContain('"account":');
    expect(prompt).not.toContain('"mandate":');
    expect(prompt).not.toContain('"openPositions":');
    expect(prompt).not.toContain("OTHERUSDT");
    expect(prompt).not.toContain('"evidence":');
  });

  it("allows multiple exits but no opening action inside exitDecisions", () => {
    const longExit = { action: "REDUCE" as const, positionSide: "LONG" as const, symbol: "NVDAUSDT", marginAllocationPct: "0", leverage: "2", reductionPct: "50", confidence: 0.7, thesis: "thesis", strategyThesis: "strategy", supportingFactors: ["factor"], riskFactors: ["risk"], evidenceUsed: ["ticker"], lessonsUsed: [] };
    const shortExit = { ...longExit, action: "CLOSE" as const, positionSide: "SHORT" as const, symbol: "SMCIUSDT", reductionPct: null };
    const parsed = autonomousDecisionSetSchema.parse({ ...longExit, action: "HOLD", positionSide: null, symbol: "NVDAUSDT", marginAllocationPct: "0", reductionPct: null, exitDecisions: [longExit, shortExit] });

    expect(parsed.exitDecisions).toHaveLength(2);
    expect(() => autonomousDecisionSetSchema.parse({ ...longExit, action: "HOLD", positionSide: null, marginAllocationPct: "0", reductionPct: null, exitDecisions: [{ ...longExit, action: "OPEN_LONG" }] })).toThrow();
  });
});
