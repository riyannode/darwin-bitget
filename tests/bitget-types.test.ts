import { describe, expect, it } from "vitest";
import { normalizeProviderProfitRate, parseAccount, parseDashboardPortfolio, parseFillSummary, parseInstruments, parsePositionHistorySummary } from "../src/bitget/types.js";
import type { Instrument, MarketSnapshot } from "../src/types.js";

describe("Bitget provider readback", () => {
  it("preserves tokenized stock metadata from the instrument catalog", () => {
    expect(parseInstruments([{ symbol: "NVDAUSDT", category: "USDT-FUTURES", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", minOrderAmount: "5", maxOrderQty: "100", pricePrecision: "2", quantityPrecision: "2", sizeMultiplier: "0.01", minLeverage: "1", maxLeverage: "100" }])[0]).toMatchObject({ symbol: "NVDAUSDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", minOrderAmount: "5", leverageMin: "1", leverageMax: "100" });
  });

  it("preserves the provider short side and quantity fields", () => {
    const instrument = { symbol: "BTCUSDT", category: "USDT-FUTURES", baseCoin: "BTC", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "crypto", isRwa: "NO", status: "online", minOrderQty: "0.001", maxOrderQty: "100", minOrderAmount: "10", pricePrecision: 2, quantityPrecision: 3, quantityStep: "0.001", leverageMin: "1", leverageMax: "5" } satisfies Instrument;
    const market = { symbol: "BTCUSDT", lastPrice: "100", bidPrice: "99.9", askPrice: "100.1", priceChange24h: "0", volume24h: "100", observedAt: "2026-09-12T00:00:00.000Z" } satisfies MarketSnapshot;
    const account = parseAccount({ account: { totalEquity: "1000", available: "900" }, positions: [{ symbol: "BTCUSDT", holdSide: "short", total: "0.5", marginSize: "50", openPriceAvg: "100" }] }, instrument, market, market.observedAt);
    expect(account.positions[0]).toMatchObject({ positionSide: "SHORT", quantity: "0.5", marginAllocated: "50" });
  });

  it("reads UTA equity and effective margin fields", () => {
    const instrument = { symbol: "NVDAUSDT", category: "USDT-FUTURES", baseCoin: "NVDA", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5" } satisfies Instrument;
    const market = { symbol: "NVDAUSDT", lastPrice: "100", bidPrice: "99.9", askPrice: "100.1", priceChange24h: "0", volume24h: "100", observedAt: "2026-09-12T00:00:00.000Z" } satisfies MarketSnapshot;

    const account = parseAccount({ accountEquity: "11.13919278", usdtEquity: "11.13921165", effEquity: "6.19299777", assets: [] }, instrument, market, market.observedAt);
    const assetRows = parseAccount([{ coin: "USDT", equity: "100", available: "90" }], instrument, market, market.observedAt);

    expect(account).toMatchObject({ portfolioEquity: "11.13921165", availableMargin: "6.19299777" });
    expect(assetRows).toMatchObject({ portfolioEquity: "100", availableMargin: "90" });
  });

  it("preserves provider live position values for the dashboard", () => {
    const portfolio = parseDashboardPortfolio(
      { usdtEquity: "50000", availableMargin: "47000", marginUsed: "3000", positionValue: "2996.3654" },
      [{ symbol: "CRCLUSDT", posSide: "long", total: "32.69", avgPrice: "91.7", markPrice: "91.82", leverage: "3", positionBalance: "998.78", unrealisedPnl: "-0.9807", profitRate: "-0.0009", liqPrice: "44.2" }],
      { list: [{ symbol: "CRCLUSDT", orderId: "open-1" }] },
      "2026-09-12T17:00:00.000Z",
    );

    expect(portfolio).toMatchObject({ portfolioEquity: "50000", availableMargin: "47000", marginUsage: "3000", openOrders: 1, unrealizedPnl: "-0.9807" });
    expect(portfolio.positions[0]).toMatchObject({ symbol: "CRCLUSDT", positionSide: "LONG", quantity: "32.69", entryPrice: "91.7", markPrice: "91.82", marginAllocated: "998.78", leverage: "3", notional: "2996.3654", unrealizedPnl: "-0.9807", unrealizedPnlPct: "-0.09", liquidationPrice: "44.2" });
  });

  it("normalizes negative provider ROI ratios to percentage points", () => {
    expect(normalizeProviderProfitRate("-0.0006598963645957")).toBe("-0.06598963645957");
  });

  it("normalizes positive, zero, and missing provider ROI ratios", () => {
    expect(normalizeProviderProfitRate("0.012345")).toBe("1.2345");
    expect(normalizeProviderProfitRate("0")).toBe("0");
    expect(normalizeProviderProfitRate(undefined)).toBeUndefined();
  });

  it("fails closed when the account response has no equity field", () => {
    const instrument = { symbol: "NVDAUSDT", category: "USDT-FUTURES", baseCoin: "NVDA", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5" } satisfies Instrument;
    const market = { symbol: "NVDAUSDT", lastPrice: "100", bidPrice: "99.9", askPrice: "100.1", priceChange24h: "0", volume24h: "100", observedAt: "2026-09-12T00:00:00.000Z" } satisfies MarketSnapshot;

    expect(() => parseAccount({ unexpected: "1" }, instrument, market, market.observedAt)).toThrow("INVALID_PORTFOLIO_EQUITY_unexpected");
  });

  it("sums fill PnL and fees without inventing values", () => {
    const result = parseFillSummary({ list: [{ execPrice: "100", execQty: "1", execPnl: "-0.25", feeDetail: [{ fee: "-0.1" }] }, { execPrice: "101", execQty: "0.5", execPnl: "0.05", feeDetail: [{ fee: "-0.05" }] }] });
    expect(result).toMatchObject({ averageFillPrice: "100.33333333", executedQuantity: "1.5", realizedPnl: "-0.2", fees: "-0.15" });
  });

  it("reads historical position PnL, funding, and fees", () => {
    const result = parsePositionHistorySummary({ list: [{ closeAvgPrice: "101", pnl: "2.5", totalFunding: "-0.1", openFee: "-0.2", closeFee: "-0.3" }] });
    expect(result).toEqual({ averageClosePrice: "101", realizedPnl: "2.5", fees: "-0.5", funding: "-0.1" });
  });
});
