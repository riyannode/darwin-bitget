import { afterEach, describe, expect, it, vi } from "vitest";
import { BitgetClient, executableIntersection } from "../src/bitget/client.js";
import { parseInstruments } from "../src/bitget/types.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS" });
const row = (symbol: string) => ({ symbol, category: "USDT-FUTURES", status: "online", symbolType: "stock", isRwa: "NO", minOrderQty: "0.01", maxMarketOrderQty: "1000", minOrderAmount: "5", minLeverage: "1", maxLeverage: "25", pricePrecision: 3, quantityPrecision: 2, quantityMultiplier: "0.01" });
const publicRows = ["SOXLUSDT", "SNXXUSDT", "KORUUSDT", "NVDAUSDT"].map(row);
const demoRows = ["KORUUSDT", "NVDAUSDT"].map(row);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Demo executable universe", () => {
  it("excludes SOXL and SNXX and includes KORU and NVDA without requiring isRwa YES", () => {
    expect(executableIntersection(parseInstruments(publicRows), parseInstruments(demoRows), "USDT-FUTURES").map(x => x.symbol)).toEqual(["KORUUSDT", "NVDAUSDT"]);
  });

  it("requires online stock metadata in both catalogs and uses Demo limits", () => {
    const demo = parseInstruments([{ ...row("NVDAUSDT"), maxLeverage: "5" }, { ...row("KORUUSDT"), status: "offline" }]);
    expect(executableIntersection(parseInstruments(publicRows), demo, "USDT-FUTURES")).toMatchObject([{ symbol: "NVDAUSDT", leverageMax: "5", quantityStep: "0.01" }]);
  });

  it("rejects online stock rows whose execution metadata is missing or non-positive", () => {
    const valid = { ...row("VALIDUSDT"), maxMarketOrderQty: "100", minLeverage: "1", pricePrecision: 2, quantityPrecision: 2 };
    const invalid = [
      { ...row("BAD-MINUSDT"), minOrderQty: "0" },
      { ...row("BAD-AMOUNTUSDT"), minOrderAmount: "not-a-number" },
      { ...row("BAD-STEPUSDT"), quantityMultiplier: "0" },
      { ...row("BAD-MISSING-STEPUSDT"), quantityMultiplier: undefined },
      { ...row("BAD-LEVERAGEUSDT"), minLeverage: "6", maxLeverage: "5" },
      { ...row("BAD-MAXUSDT"), maxMarketOrderQty: "" },
    ];
    const eligible = executableIntersection(parseInstruments([valid, ...invalid]), parseInstruments([valid, ...invalid]), "USDT-FUTURES");
    expect(eligible.map((instrument) => instrument.symbol)).toEqual(["VALIDUSDT"]);
  });

  it("fetches full Demo catalog by GET without a symbol filter or financial operation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: "00000", data: demoRows }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BitgetClient(config);
    vi.spyOn(client, "getInstruments").mockResolvedValue(parseInstruments(publicRows));
    const write = vi.spyOn(client, "placePaperOrder");
    expect((await client.getTradableInstruments()).map(x => x.symbol)).toEqual(["KORUUSDT", "NVDAUSDT"]);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.bitget.com/api/v3/market/instruments?category=USDT-FUTURES");
    expect(options.headers).toEqual({ paptrading: "1" });
    expect(options.method ?? "GET").toBe("GET");
    expect(write).not.toHaveBeenCalled();
  });

  it.each([Response.json({ code: "25100", data: null }), Response.json({ code: "00000", data: {} })])("fails closed on rejected or malformed Demo discovery", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const client = new BitgetClient(config);
    const publicRead = vi.spyOn(client, "getInstruments").mockResolvedValue(parseInstruments(publicRows));
    await expect(client.getTradableInstruments()).rejects.toThrow();
    expect(publicRead).not.toHaveBeenCalled();
  });

  it("fails closed on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("NETWORK_FAILURE")));
    await expect(new BitgetClient(config).getTradableInstruments()).rejects.toThrow("NETWORK_FAILURE");
  });

  it("keeps valid symbol bundles when another symbol market read fails and preserves canonical account facts", async () => {
    const gateway = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/account-assets")) return Response.json({ data: { usdtEquity: "50000" }, endpoint: "fixture", requestTime: "0" });
      if (path.endsWith("/position-info") || path.endsWith("/open-orders")) return Response.json({ data: [], endpoint: "fixture", requestTime: "0" });
      throw new Error(`UNEXPECTED_ROUTE_${path}`);
    });
    vi.stubGlobal("fetch", gateway);
    const client = new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_GATEWAY_URL: "https://gateway.test", BITGET_GATEWAY_SERVICE_SECRET: "gateway-secret" }));
    const account = await client.getDashboardPortfolio();
    vi.spyOn(client, "getMarketSnapshot").mockImplementation(async (symbol) => {
      if (symbol === "MSTRUSDT") throw new Error("MSTR_TICKER_UNAVAILABLE");
      return { symbol, lastPrice: "100", bidPrice: "99", askPrice: "101", priceChange24h: "0.01", volume24h: "1000", observedAt: "2026-10-04T00:00:00.000Z" };
    });
    vi.spyOn(client, "getHistoricalBars").mockResolvedValue([]);
    const evidence = await client.collectSymbolMarketEvidence(["MSTRUSDT", "HOODUSDT"], account, parseInstruments([row("MSTRUSDT"), row("HOODUSDT")]));

    expect(evidence.bundles.map((bundle) => bundle.instrument.symbol)).toEqual(["HOODUSDT"]);
    expect(evidence.unavailable.map((item) => item.symbol)).toEqual(["MSTRUSDT"]);
    expect(account.portfolioEquity).toBe("50000");
    expect(account.positions).toEqual([]);
  });

  it("keeps a symbol-specific market failure separate from account evidence", async () => {
    const gateway = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/account-assets")) return Response.json({ data: { usdtEquity: "50000" }, endpoint: "fixture", requestTime: "0" });
      if (path.endsWith("/position-info") || path.endsWith("/open-orders")) return Response.json({ data: [], endpoint: "fixture", requestTime: "0" });
      throw new Error(`UNEXPECTED_ROUTE_${path}`);
    });
    vi.stubGlobal("fetch", gateway);
    const client = new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_GATEWAY_URL: "https://gateway.test", BITGET_GATEWAY_SERVICE_SECRET: "gateway-secret" }));
    const account = await client.getDashboardPortfolio();
    const evidence = vi.spyOn(client, "getMarketSnapshot").mockRejectedValue(new Error("REACHED_MARKET_READ"));
    const result = await client.collectSymbolMarketEvidence(["SOXLUSDT"], account, parseInstruments([row("SOXLUSDT")]));
    expect(result.bundles).toEqual([]);
    expect(result.unavailable).toMatchObject([{ symbol: "SOXLUSDT", operation: "marketEvidence" }]);
    expect(evidence).toHaveBeenCalledWith("SOXLUSDT");
    expect(account.portfolioEquity).toBe("50000");
  });
});
