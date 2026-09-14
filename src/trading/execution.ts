import type { Decision, EvidenceBundle, ExecutionRequest, ExecutionResult, PositionSnapshot } from "../types.js";
import { BitgetClient } from "../bitget/client.js";
import { leveragedNotional, marginAllocation } from "./risk-gate.js";

function decimalParts(value: string): { integer: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match?.[1]) throw new Error("INVALID_DECIMAL");
  return { integer: BigInt(`${match[1]}${match[2] ?? ""}`), scale: match[2]?.length ?? 0 };
}

function decimalText(value: bigint, scale: number): string {
  const text = value.toString().padStart(scale + 1, "0");
  if (scale === 0) return text;
  const fraction = text.slice(-scale).replace(/0+$/, "");
  return fraction ? `${text.slice(0, -scale)}.${fraction}` : text.slice(0, -scale);
}

function divideDecimal(numerator: string, denominator: string, scale: number): string {
  const left = decimalParts(numerator);
  const right = decimalParts(denominator);
  if (right.integer <= 0n) throw new Error("INVALID_MARKET_PRICE");
  const exponent = scale + right.scale - left.scale;
  const quotient = exponent >= 0
    ? (left.integer * 10n ** BigInt(exponent)) / right.integer
    : left.integer / (right.integer * 10n ** BigInt(-exponent));
  return decimalText(quotient, scale);
}

function findPosition(bundle: EvidenceBundle, decision: Decision): PositionSnapshot | undefined {
  return decision.positionSide
    ? bundle.account.positions.find((position) => position.symbol === decision.symbol && position.positionSide === decision.positionSide)
    : undefined;
}

function percentage(value: string, percentageValue: string): string {
  const scaledValue = decimalParts(value);
  const scaledPercentage = decimalParts(percentageValue);
  return decimalText(scaledValue.integer * scaledPercentage.integer / 100n, scaledValue.scale + scaledPercentage.scale);
}

function providerSide(decision: Decision): "buy" | "sell" {
  if (decision.action === "OPEN_LONG" || (decision.action === "INCREASE" && decision.positionSide === "LONG")) return "buy";
  if (decision.action === "OPEN_SHORT" || (decision.action === "INCREASE" && decision.positionSide === "SHORT")) return "sell";
  return decision.positionSide === "LONG" ? "sell" : "buy";
}

export function buildExecutionRequest(decision: Decision, bundle: EvidenceBundle, cycleId: string): ExecutionRequest {
  if (decision.action === "HOLD") throw new Error("HOLD_NOT_EXECUTABLE");
  if (decision.action === "REVERSE") throw new Error("REVERSE_NOT_EXPANDED");
  const current = findPosition(bundle, decision);
  if (decision.action === "INCREASE" && !current) throw new Error("POSITION_NOT_OPEN");
  if (decision.action === "INCREASE" && (!decision.additionalMarginPct || Number(decision.additionalMarginPct) <= 0)) throw new Error("INVALID_ADDITIONAL_MARGIN");
  const opening = decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT" || decision.action === "INCREASE";
  const marginAllocated = decision.action === "INCREASE"
    ? marginAllocation(bundle.account, decision.additionalMarginPct ?? "0")
    : opening
      ? marginAllocation(bundle.account, decision.marginAllocationPct)
      : current?.marginAllocated ?? "0";
  const leverage = decision.action === "INCREASE" ? current?.leverage ?? "1" : opening ? decision.leverage : current?.leverage ?? "1";
  const fullNotional = opening ? leveragedNotional(marginAllocated, leverage) : current?.notional ?? "0";
  const fullQuantity = opening ? divideDecimal(fullNotional, bundle.market.lastPrice, bundle.instrument.quantityPrecision) : current?.quantity ?? "0";
  const reductionPct = decision.action === "REDUCE" ? decision.reductionPct : decision.action === "CLOSE" ? "100" : null;
  const positionNotional = reductionPct ? percentage(fullNotional, reductionPct) : fullNotional;
  const quantity = reductionPct ? percentage(fullQuantity, reductionPct) : fullQuantity;
  return {
    cycleId,
    decisionId: decision.decisionId,
    symbol: decision.symbol,
    action: decision.action,
    positionSide: decision.positionSide ?? "LONG",
    providerSide: providerSide(decision),
    tradeSide: opening ? "open" : "close",
    marginAllocated: reductionPct ? percentage(marginAllocated, reductionPct) : marginAllocated,
    leverage,
    positionNotional,
    reductionPct,
    quantity,
    clientOrderId: `paper-${cycleId.replaceAll("-", "").slice(0, 16)}-${decision.decisionId.replaceAll("-", "").slice(0, 9)}`,
  };
}

export async function executePaperOrder(client: BitgetClient, request: ExecutionRequest): Promise<ExecutionResult> {
  if (!request.clientOrderId || request.clientOrderId.length > 32) throw new Error("INVALID_CLIENT_ORDER_ID");
  return client.placePaperOrder(request);
}
