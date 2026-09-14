import { describe, expect, it } from "vitest";
import { buildExecutionCapacityHint, calculatedCapacityQuantity } from "../src/trading/execution-capacity.js";
import type { EvidenceBundle } from "../src/types.js";

const bundle: Pick<EvidenceBundle, "market" | "account" | "instrument"> = {
  market: { symbol: "KORUUSDT", lastPrice: "19.026", bidPrice: "19.026", askPrice: "19.027", priceChange24h: "-0.15", volume24h: "4200000", observedAt: "2026-09-14T21:47:12.969Z" },
  account: { balance: "50070.24599329", availableBalance: "50065.28708048", availableMargin: "50065.28708048", marginUsage: "4.95891281", positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "50070.24599329", positions: [], realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: "2026-09-14T21:47:12.969Z" },
  instrument: { symbol: "KORUUSDT", category: "USDT-FUTURES", baseCoin: "KORU", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100", minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "20" },
};

describe("execution capacity hints", () => {
  it("uses the same provider quantity bounds without floating point sizing", () => {
    const hint = buildExecutionCapacityHint(bundle, "5");
    expect(hint).toMatchObject({ symbol: "KORUUSDT", maxOrderQty: "100", maxExecutableNotional: "1902.6", minOrderQty: "0.01", quantityStep: "0.01" });
    expect(hint.maxMarginAllocationPctByLeverage).toMatchObject({ "1": "3.7998", "3": "1.2666", "5": "0.7599" });
  });

  it("shows the old KORU proposal is oversized while a smaller valid allocation is expressible", () => {
    expect(calculatedCapacityQuantity(bundle, "1.5", "3")).toBe("118.42");
    expect(calculatedCapacityQuantity(bundle, "1.2", "3")).toBe("94.74");
  });
});
