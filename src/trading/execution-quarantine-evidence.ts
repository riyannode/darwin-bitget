import { compareDecimal, isDecimal, isPositiveDecimal, subtractDecimal } from "./decimal.js";
import {
  aggregateProviderFillEvidence,
  type ProviderFillAggregation,
  type ProviderFillEvidence,
  type ProviderOrderReadback,
} from "./late-reconciliation.js";
import { resolveProviderLifecycleSide } from "./provider-lifecycle-side.js";
import type { PositionSide } from "../types.js";

const CANCELED_ORDER_HISTORY_RETENTION_MS = 2 * 60 * 60 * 1_000;

export function isExactQuarantineQuantityTransition(before: string, after: string, executedQuantity: string): boolean {
  if (!isPositiveDecimal(before) || !isDecimal(after) || !isPositiveDecimal(executedQuantity)
    || compareDecimal(after, "0") < 0 || compareDecimal(before, after) <= 0) return false;
  try {
    return compareDecimal(subtractDecimal(before, after), executedQuantity) === 0;
  } catch {
    return false;
  }
}

export interface ExecutionQuarantineSearchIdentity {
  symbol: string;
  clientOrderId: string;
  providerOrderId?: string;
  positionSide: PositionSide;
  lifecycleSide: "OPEN" | "CLOSE";
  expectedQuantity?: string;
  expectedAveragePrice?: string;
}

export type ExecutionQuarantineSearchStatus =
  | "FOUND_EXACT"
  | "NOT_FOUND_AUTHORITATIVE"
  | "INCOMPLETE"
  | "IDENTITY_CONFLICT";

export interface ExecutionQuarantineSearchResult {
  status: ExecutionQuarantineSearchStatus;
  reason: string;
  order: ProviderOrderReadback | null;
  fills: ProviderFillEvidence[];
  aggregate: ProviderFillAggregation | null;
  authoritativeNotFound: boolean;
}

export function assessExecutionQuarantineHistory(input: {
  identity: ExecutionQuarantineSearchIdentity;
  orders: readonly ProviderOrderReadback[];
  fills: readonly ProviderFillEvidence[];
  historyComplete: boolean;
  directOrderLookup?: "FOUND" | "PROVIDER_NOT_FOUND" | "TRANSIENT_FAILURE" | "UNPARSEABLE";
  submittedAt?: string;
  observedAt?: string;
}): ExecutionQuarantineSearchResult {
  const { identity, orders, fills, historyComplete, directOrderLookup = "UNPARSEABLE" } = input;
  const candidates = orders.filter((order) => order.clientOid === identity.clientOrderId
    || Boolean(identity.providerOrderId && order.orderId === identity.providerOrderId));
  const possibleFills = fills.filter((fill) => fill.clientOid === identity.clientOrderId
    || Boolean(identity.providerOrderId && fill.orderId === identity.providerOrderId));

  if (candidates.length === 0) {
    if (possibleFills.length > 0) return result("IDENTITY_CONFLICT", "PROVIDER_FILL_WITHOUT_EXACT_ORDER", null, possibleFills, null);
    if (!historyComplete) return result("INCOMPLETE", "PROVIDER_HISTORY_COVERAGE_INCOMPLETE", null, [], null);
    const submittedMs = input.submittedAt ? Date.parse(input.submittedAt) : NaN;
    const observedMs = input.observedAt ? Date.parse(input.observedAt) : NaN;
    if (!Number.isFinite(submittedMs) || !Number.isFinite(observedMs) || observedMs < submittedMs) {
      return result("INCOMPLETE", "PROVIDER_NOT_FOUND_TIME_BOUNDS_INVALID", null, [], null);
    }
    if (observedMs - submittedMs > CANCELED_ORDER_HISTORY_RETENTION_MS) {
      return result("INCOMPLETE", "ORDER_HISTORY_CANCELED_RETENTION_EXPIRED", null, [], null);
    }
    if (directOrderLookup === "PROVIDER_NOT_FOUND") {
      return result("NOT_FOUND_AUTHORITATIVE", "DIRECT_NOT_FOUND_WITHIN_RETENTION_AND_COMPLETE_HISTORY", null, [], null);
    }
    return result("INCOMPLETE", directOrderLookup === "TRANSIENT_FAILURE"
      ? "DIRECT_ORDER_LOOKUP_TRANSIENT_FAILURE"
      : "DIRECT_ORDER_LOOKUP_NOT_AUTHORITATIVE", null, [], null);
  }
  if (candidates.length !== 1) return result("IDENTITY_CONFLICT", "MULTIPLE_PROVIDER_ORDERS_FOR_QUARANTINE_IDENTITY", null, [], null);

  const order = candidates[0]!;
  if (order.clientOid !== identity.clientOrderId
    || (identity.providerOrderId && order.orderId !== identity.providerOrderId)
    || order.symbol !== identity.symbol || order.positionSide !== identity.positionSide
    || resolveProviderLifecycleSide(order.side, order.positionSide, order.tradeSide) !== identity.lifecycleSide) {
    return result("IDENTITY_CONFLICT", "PROVIDER_ORDER_IDENTITY_OR_SIDE_MISMATCH", order, [], null);
  }
  if (order.status !== "filled") return result("INCOMPLETE", "PROVIDER_ORDER_NOT_FINAL_FILLED", order, possibleFills, null);

  const relatedFills = fills.filter((fill) => fill.orderId === order.orderId || fill.clientOid === identity.clientOrderId);
  if (relatedFills.length === 0) return result("INCOMPLETE", "PROVIDER_ORDER_FILL_EVIDENCE_MISSING", order, [], null);
  if (relatedFills.some((fill) => fill.orderId !== order.orderId || fill.clientOid !== identity.clientOrderId
    || fill.symbol !== identity.symbol || fill.positionSide !== identity.positionSide
    || resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide) !== identity.lifecycleSide)) {
    return result("IDENTITY_CONFLICT", "PROVIDER_FILL_IDENTITY_OR_SIDE_MISMATCH", order, relatedFills, null);
  }
  if (!order.averageFillPrice || !isPositiveDecimal(order.averageFillPrice)
    || !isPositiveDecimal(order.executedQuantity)
    || (identity.expectedQuantity && (!isPositiveDecimal(identity.expectedQuantity) || compareDecimal(order.executedQuantity, identity.expectedQuantity) !== 0))) {
    return result("IDENTITY_CONFLICT", "PROVIDER_ORDER_QUANTITY_OR_PRICE_MISMATCH", order, relatedFills, null);
  }
  const expectedAveragePrice = identity.expectedAveragePrice ?? order.averageFillPrice;
  const evidenceOrder = { ...order, status: "filled" as const, averageFillPrice: order.averageFillPrice };
  const aggregate = aggregateProviderFillEvidence(relatedFills, evidenceOrder, order.executedQuantity, expectedAveragePrice, identity.lifecycleSide);
  if (!aggregate.valid) {
    const status = historyComplete ? "IDENTITY_CONFLICT" : "INCOMPLETE";
    return result(status, aggregate.code, order, relatedFills, aggregate);
  }
  return historyComplete
    ? result("FOUND_EXACT", "EXACT_ORDER_AND_AGGREGATE_FILLS_CONFIRMED", order, aggregate.fills, aggregate)
    : result("INCOMPLETE", "EXACT_ORDER_FOUND_HISTORY_COVERAGE_INCOMPLETE", order, aggregate.fills, aggregate);
}

function result(
  status: ExecutionQuarantineSearchStatus,
  reason: string,
  order: ProviderOrderReadback | null,
  fills: ProviderFillEvidence[],
  aggregate: ProviderFillAggregation | null,
): ExecutionQuarantineSearchResult {
  return { status, reason, order, fills, aggregate, authoritativeNotFound: status === "NOT_FOUND_AUTHORITATIVE" };
}
