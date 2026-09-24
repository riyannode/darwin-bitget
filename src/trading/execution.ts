import type { Decision, EvidenceBundle, ExecutionRequest, ExecutionResult } from "../types.js";
import { BitgetClient } from "../bitget/client.js";
import { calculateExecutionAmounts } from "./order-quantity.js";

function providerSide(decision: Decision): "buy" | "sell" {
  if (decision.action === "OPEN_LONG" || (decision.action === "INCREASE" && decision.positionSide === "LONG")) return "buy";
  if (decision.action === "OPEN_SHORT" || (decision.action === "INCREASE" && decision.positionSide === "SHORT")) return "sell";
  return decision.positionSide === "LONG" ? "sell" : "buy";
}

export function buildExecutionClientOrderId(cycleId: string, decisionId: string): string {
  return `paper-${cycleId.replaceAll("-", "").slice(0, 16)}-${decisionId.replaceAll("-", "").slice(0, 9)}`;
}

export function buildExecutionRequest(decision: Decision, bundle: EvidenceBundle, cycleId: string): ExecutionRequest {
  if (decision.action === "HOLD") throw new Error("HOLD_NOT_EXECUTABLE");
  if (decision.action === "REVERSE") throw new Error("REVERSE_NOT_EXPANDED");
  const amounts = calculateExecutionAmounts(decision, bundle);
  return {
    cycleId,
    decisionId: decision.decisionId,
    symbol: decision.symbol,
    action: decision.action,
    positionSide: decision.positionSide ?? "LONG",
    providerSide: providerSide(decision),
    tradeSide: amounts.reductionPct ? "close" : "open",
    marginAllocated: amounts.marginAllocated,
    leverage: amounts.leverage,
    positionNotional: amounts.positionNotional,
    reductionPct: amounts.reductionPct,
    quantity: amounts.quantity,
    clientOrderId: buildExecutionClientOrderId(cycleId, decision.decisionId),
  };
}

export async function executePaperOrder(client: BitgetClient, request: ExecutionRequest): Promise<ExecutionResult> {
  if (!request.clientOrderId || request.clientOrderId.length > 32) throw new Error("INVALID_CLIENT_ORDER_ID");
  return client.placePaperOrder(request);
}
