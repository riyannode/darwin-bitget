import { describe, expect, it, vi } from "vitest";
import { BitgetApiError } from "@bitget-ai/bitget-agent-sdk";
import { BitgetClient, buildOpenOrdersReadParams, buildPaperOrderParams, buildUnresolvedExecution, extractProviderError, formatBitgetReadFailure, normalizeBitgetOrderStatus } from "../src/bitget/client.js";
import { loadConfig } from "../src/config.js";
import type { ExecutionRequest } from "../src/types.js";

const request: ExecutionRequest = {
  cycleId: "cycle-1",
  decisionId: "decision-1",
  symbol: "SOXLUSDT",
  action: "OPEN_LONG",
  positionSide: "LONG",
  providerSide: "buy",
  tradeSide: "open",
  marginAllocated: "100",
  leverage: "3",
  positionNotional: "300",
  reductionPct: null,
  quantity: "2.4",
  clientOrderId: "paper-cycle1-decision1",
};

function gatewayConfig() {
  return loadConfig({ TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_GATEWAY_URL: "https://gateway.test", BITGET_GATEWAY_SERVICE_SECRET: "gateway-secret" });
}

function gatewayResponse(data: unknown): Response {
  return Response.json({ endpoint: "fixture", requestTime: "2026-09-12T00:00:00.000Z", data });
}

describe("Bitget read diagnostics", () => {
  it("reads live dashboard portfolio without invoking financial writes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/account-assets")) return gatewayResponse({ usdtEquity: "50000", availableMargin: "47000", marginUsed: "3000", positionValue: "2996.3654" });
      if (path.endsWith("/position-info")) return gatewayResponse([{ symbol: "CRCLUSDT", posSide: "long", total: "32.69", avgPrice: "91.7", markPrice: "91.82", leverage: "3", positionBalance: "998.78", unrealisedPnl: "3.9252", profitRate: "0.0039", liqPrice: "44.2" }]);
      if (path.endsWith("/open-orders")) return gatewayResponse({ list: [{ symbol: "CRCLUSDT", orderId: "open-1" }] });
      throw new Error(`UNEXPECTED_ROUTE_${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const portfolio = await new BitgetClient(gatewayConfig()).getDashboardPortfolio();
      expect(portfolio.positions[0]).toMatchObject({ symbol: "CRCLUSDT", markPrice: "91.82", unrealizedPnl: "3.9252", unrealizedPnlPct: "0.39" });
      expect(portfolio.openOrders).toBe(1);
      expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/v1/bitget/account-assets", "/v1/bitget/position-info", "/v1/bitget/open-orders"]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps account and positions live when open-orders readback is temporarily unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/account-assets")) return gatewayResponse({ usdtEquity: "50000", availableMargin: "47000", marginUsed: "3000", positionValue: "2996.3654" });
      if (path.endsWith("/position-info")) return gatewayResponse([{ symbol: "CRCLUSDT", posSide: "long", total: "32.69", avgPrice: "91.7", markPrice: "91.82", leverage: "3", positionBalance: "998.78", unrealisedPnl: "-0.98", profitRate: "-0.0009", liqPrice: "44.2" }]);
      if (path.endsWith("/open-orders")) return Response.json({ error: "BITGET_GATEWAY_FAILED_getOpenOrders", provider: { operation: "getOpenOrders", code: "40701", message: "temporary open-orders unavailable", symbol: "ACCOUNT" } }, { status: 502 });
      throw new Error(`UNEXPECTED_ROUTE_${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const portfolio = await new BitgetClient(gatewayConfig()).getDashboardPortfolio();
      expect(portfolio.portfolioEquity).toBe("50000");
      expect(portfolio.positions).toHaveLength(1);
      expect(portfolio.openOrders).toBeNull();
      expect(portfolio.openOrdersReadFailure).toEqual({ operation: "getOpenOrders", code: "40701", message: "temporary open-orders unavailable" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("records the failed operation without retrying a financial write or leaking credentials", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      return Response.json({ error: "BITGET_GATEWAY_FAILED", provider: { operation: path.endsWith("/account-info") ? "getAccountInfo" : "getOrderDetails", code: "PROVIDER_ERROR", message: "authorization: Bearer gateway-secret", symbol: "ACCOUNT" } }, { status: 502 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new BitgetClient(gatewayConfig());
      const result = await client.placePaperOrder(request);
      expect(result.providerOperation).toBe("getAccountInfo");
      expect(result.providerCode).toBe("PROVIDER_ERROR");
      expect(JSON.stringify(result)).not.toContain("gateway-secret");
      expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/v1/bitget/account-info", "/v1/bitget/order-details"]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("normalizes provider order status", () => {
    expect(normalizeBitgetOrderStatus("filled")).toBe("filled");
    expect(normalizeBitgetOrderStatus("unknown-status")).toBe("unknown");
  });

  it("uses hedge-mode position side without reduce-only on close", () => {
    const closeRequest = { ...request, action: "CLOSE" as const, positionSide: "LONG" as const, providerSide: "sell" as const, tradeSide: "close" as const };
    expect(buildPaperOrderParams(closeRequest, "hedge_mode", "USDT-FUTURES")).toEqual({ category: "USDT-FUTURES", symbol: "SOXLUSDT", side: "sell", orderType: "market", qty: "2.4", clientOid: "paper-cycle1-decision1", posSide: "long" });
  });

  it("uses reduce-only without position side in one-way mode", () => {
    const closeRequest = { ...request, action: "CLOSE" as const, positionSide: "LONG" as const, providerSide: "sell" as const, tradeSide: "close" as const };
    expect(buildPaperOrderParams(closeRequest, "one_way_mode", "USDT-FUTURES")).toEqual({ category: "USDT-FUTURES", symbol: "SOXLUSDT", side: "sell", orderType: "market", qty: "2.4", clientOid: "paper-cycle1-decision1", reduceOnly: "yes" });
  });

  it("identifies the failed operation and symbol without provider payloads", () => {
    expect(formatBitgetReadFailure("getOpenOrders", "KORUUSDT")).toBe("BITGET_READ_FAILED_getOpenOrders_KORUUSDT");
    expect(formatBitgetReadFailure("getAccountAssets")).toBe("BITGET_READ_FAILED_getAccountAssets_ACCOUNT");
  });

  it("reads open orders once at category scope", () => {
    expect(buildOpenOrdersReadParams("USDT-FUTURES")).toEqual({ category: "USDT-FUTURES" });
  });

  it("preserves SDK provider code and message for unresolved writes", () => {
    const details = extractProviderError(new BitgetApiError("Order rejected", { code: "40725", endpoint: "placeOrder" }));
    expect(details).toEqual({ code: "40725", message: "Order rejected" });
  });

  it("preserves SDK error type when the provider code is unavailable", () => {
    const details = extractProviderError(Object.assign(new Error("request timed out"), { type: "NetworkError" }));
    expect(details).toEqual({ code: "NetworkError", message: "request timed out" });
  });

  it("keeps write and readback diagnostics on an unresolved execution", () => {
    const execution = buildUnresolvedExecution(
      request,
      "2026-09-12T00:00:00.000Z",
      new BitgetApiError("Order rejected", { code: "40725", endpoint: "placeOrder" }),
      new BitgetApiError("Order not found", { code: "43025", endpoint: "getOrderDetails" }),
    );
    expect(execution.status).toBe("unknown");
    expect(execution.providerCode).toBe("40725");
    expect(execution.providerMessage).toBe("Order rejected");
    expect(execution.providerReadbackCode).toBe("43025");
    expect(execution.providerReadbackMessage).toBe("Order not found");
  });

  it("represents a definitive provider rejection as rejected, never unknown or filled", () => {
    const execution = buildUnresolvedExecution(
      request,
      "2026-09-12T00:00:00.000Z",
      { classification: "PROVIDER_REJECTED", code: "400", message: "Exceeded the maximum quantity of contract orders: 100 KORU" },
      { classification: "PROVIDER_NOT_FOUND", code: "400", message: "Order does not exist" },
    );
    expect(execution.status).toBe("rejected");
    expect(execution.providerOrderId).toBeUndefined();
    expect(execution.executedQuantity).toBe("0");
  });

  it("redacts credential-shaped values from provider messages", () => {
    const details = extractProviderError(new Error("ACCESS-KEY=secret-value passphrase:another-secret"));
    expect(details.message).toBe("ACCESS-KEY=REDACTED passphrase:REDACTED");
  });

  it("normalizes structured provider errors without requiring Error instances", () => {
    expect(extractProviderError({ code: 45001, msg: "Instrument unavailable" })).toEqual({ code: "45001", message: "Instrument unavailable" });
  });

  it("keeps unresolved writes fail-closed when both errors lack details", () => {
    const execution = buildUnresolvedExecution(request, "2026-09-12T00:00:00.000Z", {}, {});
    expect(execution.status).toBe("unknown");
    expect(execution.executedQuantity).toBe("0");
    expect(execution.providerMessage).toBe("PROVIDER_WRITE_UNKNOWN");
    expect(execution.providerCode).toBeUndefined();
    expect(execution.providerReadbackCode).toBeUndefined();
  });

  it("bounds provider messages before they reach journal evidence", () => {
    const details = extractProviderError(new Error("x".repeat(400)));
    expect(details.message).toHaveLength(240);
  });

  it("prefers the provider code over an SDK error type", () => {
    expect(extractProviderError({ code: "40010", type: "BitgetApiError", message: "Invalid request" })).toEqual({ code: "40010", message: "Invalid request" });
  });
});
