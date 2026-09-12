import { describe, expect, it, vi } from "vitest";
import { BitgetApiError, BitgetRestClient } from "@bitget-ai/bitget-agent-sdk";
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

describe("Bitget read diagnostics", () => {
  it("reads live dashboard portfolio without invoking financial writes", async () => {
    const providerResult = (data: unknown) => ({ endpoint: "fixture", requestTime: "2026-09-12T00:00:00.000Z", data, raw: { code: "00000", data } });
    const sdk = vi.spyOn(BitgetRestClient.prototype, "callOperation").mockImplementation(async (operation) => {
      if (operation === "getAccountAssets") return providerResult({ usdtEquity: "50000", availableMargin: "47000", marginUsed: "3000", positionValue: "2996.3654" });
      if (operation === "getPositionInfo") return providerResult([{ symbol: "CRCLUSDT", posSide: "long", total: "32.69", avgPrice: "91.7", markPrice: "91.82", leverage: "3", positionBalance: "998.78", unrealisedPnl: "3.9252", profitRate: "0.0039", liqPrice: "44.2" }]);
      if (operation === "getOpenOrders") return providerResult({ list: [{ symbol: "CRCLUSDT", orderId: "open-1" }] });
      throw new Error(`UNEXPECTED_OPERATION_${operation}`);
    });
    try {
      const portfolio = await new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_API_KEY: "fixture-key", BITGET_SECRET_KEY: "fixture-secret", BITGET_PASSPHRASE: "fixture-passphrase" })).getDashboardPortfolio();
      expect(portfolio.positions[0]).toMatchObject({ symbol: "CRCLUSDT", markPrice: "91.82", unrealizedPnl: "3.9252", unrealizedPnlPct: "0.39" });
      expect(portfolio.openOrders).toBe(1);
      expect(sdk.mock.calls.map(([operation]) => operation)).toEqual(["getAccountAssets", "getPositionInfo", "getOpenOrders"]);
    } finally { sdk.mockRestore(); }
  });

  it("keeps account and positions live when open-orders readback is temporarily unavailable", async () => {
    const providerResult = (data: unknown) => ({ endpoint: "fixture", requestTime: "2026-09-12T00:00:00.000Z", data, raw: { code: "00000", data } });
    const sdk = vi.spyOn(BitgetRestClient.prototype, "callOperation").mockImplementation(async (operation) => {
      if (operation === "getAccountAssets") return providerResult({ usdtEquity: "50000", availableMargin: "47000", marginUsed: "3000", positionValue: "2996.3654" });
      if (operation === "getPositionInfo") return providerResult([{ symbol: "CRCLUSDT", posSide: "long", total: "32.69", avgPrice: "91.7", markPrice: "91.82", leverage: "3", positionBalance: "998.78", unrealisedPnl: "-0.98", profitRate: "-0.0009", liqPrice: "44.2" }]);
      if (operation === "getOpenOrders") throw { code: "40701", msg: "temporary open-orders unavailable" };
      throw new Error(`UNEXPECTED_OPERATION_${operation}`);
    });
    try {
      const portfolio = await new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_API_KEY: "fixture-key", BITGET_SECRET_KEY: "fixture-secret", BITGET_PASSPHRASE: "fixture-passphrase" })).getDashboardPortfolio();
      expect(portfolio.portfolioEquity).toBe("50000");
      expect(portfolio.positions).toHaveLength(1);
      expect(portfolio.openOrders).toBeNull();
      expect(portfolio.openOrdersReadFailure).toEqual({ operation: "getOpenOrders", code: "40701", message: "temporary open-orders unavailable" });
    } finally { sdk.mockRestore(); }
  });

  it("records the failed operation without retrying a financial write or leaking credentials", async () => {
    const sdk = vi.spyOn(BitgetRestClient.prototype, "callOperation").mockRejectedValue({ code: "PROVIDER_ERROR", message: "fixture-passphrase" });
    try {
      const client = new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_API_KEY: "fixture-key", BITGET_SECRET_KEY: "fixture-secret", BITGET_PASSPHRASE: "fixture-passphrase" }));
      const result = await client.placePaperOrder(request);
      expect(result.providerOperation).toBe("getAccountInfo");
      expect(result.providerCode).toBe("PROVIDER_ERROR");
      expect(JSON.stringify(result)).not.toContain("fixture-passphrase");
      expect(sdk.mock.calls.map(([operation]) => operation)).toEqual(["getAccountInfo", "getOrderDetails"]);
    } finally { sdk.mockRestore(); }
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
