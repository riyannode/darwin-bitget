import { describe, expect, it } from "vitest";
import { BitgetApiError } from "@bitget-ai/bitget-agent-sdk";
import { buildOpenOrdersReadParams, buildPaperOrderParams, buildUnresolvedExecution, extractProviderError, formatBitgetReadFailure, normalizeBitgetOrderStatus } from "../src/bitget/client.js";
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
