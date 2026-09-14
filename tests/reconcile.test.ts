import { describe, expect, it } from "vitest";
import { reconcileExecution } from "../src/trading/reconcile.js";
import type { ExecutionRequest, ExecutionResult } from "../src/types.js";

const request: ExecutionRequest = { cycleId: "cycle-1", decisionId: "decision-1", symbol: "BTCUSDT", action: "OPEN_LONG", positionSide: "LONG", providerSide: "buy", tradeSide: "open", marginAllocated: "100", leverage: "2", positionNotional: "200", reductionPct: null, quantity: "0.01", clientOrderId: "paper-cycle-1" };

function execution(overrides: Partial<ExecutionResult> = {}): ExecutionResult { return { provider: "bitget", providerOrderId: "order-1", clientOrderId: request.clientOrderId, symbol: request.symbol, action: request.action, positionSide: request.positionSide, providerSide: request.providerSide, tradeSide: request.tradeSide, marginAllocated: request.marginAllocated, leverage: request.leverage, positionNotional: request.positionNotional, requestedQuantity: request.quantity, executedQuantity: request.quantity, status: "filled", submittedAt: "2026-09-12T00:00:00.000Z", readBackAt: "2026-09-12T00:00:01.000Z", ...overrides }; }

describe("execution reconciliation", () => {
  it("matches a verified provider readback", () => { expect(reconcileExecution(request, execution())).toMatchObject({ status: "MATCHED", codes: [] }); });
  it("accepts a verified close when the provider position disappears", () => {
    const closeRequest: ExecutionRequest = { ...request, action: "CLOSE", positionSide: "LONG", providerSide: "sell", tradeSide: "close", marginAllocated: "0", leverage: "2", positionNotional: "200", reductionPct: "100" };
    const closeExecution = execution({ action: "CLOSE", providerSide: "sell", tradeSide: "close" });
    expect(reconcileExecution(closeRequest, closeExecution, { symbol: "BTCUSDT", positionSide: "LONG", quantity: "2", notional: "200", marginAllocated: "100", leverage: "2", entryPrice: "100", unrealizedPnl: "0", realizedPnl: "0" })).toMatchObject({ status: "MATCHED", codes: [] });
  });
  it("does not retry an ambiguous submission", () => { const result = reconcileExecution(request, execution({ status: "unknown" })); expect(result.status).toBe("UNKNOWN"); expect(result.codes).toContain("EXECUTION_UNKNOWN"); });
  it("detects provider/request mismatches", () => { const result = reconcileExecution(request, execution({ positionSide: "SHORT" })); expect(result.status).toBe("MISMATCH"); expect(result.codes).toContain("EXECUTION_MISMATCH"); });
  it("keeps a definitive provider rejection out of verified execution", () => {
    const rejected = execution({ executedQuantity: "0", status: "rejected", providerFailureClass: "PROVIDER_REJECTED", providerReadbackFailureClass: "PROVIDER_NOT_FOUND" });
    delete rejected.providerOrderId;
    const result = reconcileExecution(request, rejected);
    expect(result.status).toBe("MISMATCH");
    expect(result.codes).toContain("PROVIDER_REJECTED");
    expect(result.codes).not.toContain("EXECUTION_UNKNOWN");
  });
});
