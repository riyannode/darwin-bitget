import { describe, expect, it } from "vitest";
import { resolveDashboardPortfolio } from "../src/agent/portfolio.js";
import type { AccountSnapshot } from "../src/types.js";

const portfolio: AccountSnapshot = {
  balance: "1000",
  availableBalance: "900",
  availableMargin: "900",
  marginUsage: "100",
  positionNotional: "300",
  totalPositionNotional: "300",
  positionQuantity: "3",
  portfolioEquity: "1000",
  positions: [{ symbol: "CRCLUSDT", positionSide: "LONG", quantity: "3", entryPrice: "100", markPrice: "101", marginAllocated: "100", leverage: "3", notional: "300", unrealizedPnl: "3", unrealizedPnlPct: "1", realizedPnl: "0" }],
  realizedPnl: "0",
  unrealizedPnl: "3",
  openOrders: 0,
  openOrderSymbols: [],
  observedAt: "2026-09-13T00:00:00.000Z",
};

describe("dashboard portfolio freshness", () => {
  it("marks provider readback as live", () => {
    const result = resolveDashboardPortfolio(portfolio, null, "2026-09-13T00:01:00.000Z");
    expect(result).toEqual({ value: portfolio, freshness: { source: "PROVIDER_LIVE", observedAt: portfolio.observedAt, stale: false } });
  });

  it("falls back to journal portfolio without fabricating zero state", () => {
    const result = resolveDashboardPortfolio(null, portfolio, "2026-09-13T00:02:00.000Z");
    expect(result).toEqual({ value: portfolio, freshness: { source: "JOURNAL_FALLBACK", observedAt: portfolio.observedAt, stale: true } });
  });
});
