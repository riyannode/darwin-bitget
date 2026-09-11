import type { ExecutionResult, ExecutionRequest, PositionSnapshot, ReconciliationResult } from "../types.js";

export function reconcileExecution(
  request: ExecutionRequest,
  execution: ExecutionResult,
  positionBefore?: PositionSnapshot,
  positionAfter?: PositionSnapshot,
): ReconciliationResult {
  const codes: string[] = [];
  if (execution.symbol !== request.symbol) codes.push("EXECUTION_MISMATCH");
  if (execution.action !== request.action) codes.push("EXECUTION_MISMATCH");
  if (execution.positionSide !== request.positionSide) codes.push("EXECUTION_MISMATCH");
  if (execution.providerSide !== request.providerSide) codes.push("EXECUTION_MISMATCH");
  if (execution.tradeSide !== request.tradeSide) codes.push("EXECUTION_MISMATCH");
  if (execution.clientOrderId !== request.clientOrderId) codes.push("EXECUTION_MISMATCH");
  if (execution.status === "unknown") codes.push("EXECUTION_UNKNOWN");
  if (!["filled", "partially_filled"].includes(execution.status)) codes.push("EXECUTION_NOT_FILLED");
  if (!execution.providerOrderId && execution.status !== "not_found") codes.push("MISSING_PROVIDER_REFERENCE");
  if (request.tradeSide === "open" && positionAfter && Number(positionAfter.quantity) <= 0) codes.push("POSITION_OPEN_UNVERIFIED");
  if (request.tradeSide === "close" && positionBefore && !positionAfter) codes.push("POSITION_READBACK_MISSING");
  if (request.tradeSide === "close" && positionBefore && positionAfter && request.action === "CLOSE" && Number(positionAfter.quantity) > 0) codes.push("POSITION_NOT_CLOSED");
  if (request.tradeSide === "close" && positionBefore && positionAfter && request.action === "REDUCE" && Number(positionAfter.quantity) >= Number(positionBefore.quantity)) codes.push("POSITION_NOT_REDUCED");
  const status = codes.includes("EXECUTION_UNKNOWN")
    ? "UNKNOWN"
    : codes.length > 0
      ? "MISMATCH"
      : "MATCHED";
  return { status, codes, execution };
}
