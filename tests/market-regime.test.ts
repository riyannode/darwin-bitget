import { describe, expect, it } from "vitest";
import { classifyMarketRegime } from "../src/trading/market-regime.js";
import type { HistoricalBar, MarketSnapshot } from "../src/types.js";

const market: MarketSnapshot = { symbol: "BTCUSDT", lastPrice: "105", bidPrice: "104.9", askPrice: "105.1", priceChange24h: "0.01", volume24h: "100", observedAt: "2026-09-12T00:00:00.000Z" };

function bars(closes: number[]): HistoricalBar[] {
  return closes.map((close, index) => ({ observedAt: new Date(Date.UTC(2026, 8, 12, 0, index * 15)).toISOString(), open: String(close), high: String(close + 0.2), low: String(close - 0.2), close: String(close), volume: "100" }));
}

describe("market regime", () => {
  it("classifies persistent upward movement", () => {
    expect(classifyMarketRegime(market, bars([100, 101, 102, 103, 104, 105]))).toBe("TRENDING_UP");
  });

  it("returns unknown when history is insufficient", () => {
    expect(classifyMarketRegime(market, bars([100, 101, 100]))).toBe("UNKNOWN");
  });
});
