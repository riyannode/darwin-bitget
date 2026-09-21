import type { DecisionExecutionRecord, PositionContext, PositionSide, PositionSnapshot, TradeExperience } from "../types.js";
import { compareDecimal, isPositiveDecimal } from "./decimal.js";
import { upsertPositionContext } from "../agent/position-context.js";

const READBACK_ONLY_CODES = new Set(["POSITION_READBACK_UNAVAILABLE", "POSITION_READBACK_MISSING"]);

export interface ProviderOrderEvidence {
  orderId: string;
  clientOid: string;
  symbol: string;
  side: "buy" | "sell";
  positionSide: PositionSide;
  tradeSide: string;
  quantity: string;
  executedQuantity: string;
  averageFillPrice: string;
  status: "filled";
  createdAt: string;
}

export interface ProviderFillEvidence {
  fillId: string;
  orderId: string;
  clientOid: string;
  symbol: string;
  side: "buy" | "sell";
  positionSide: PositionSide;
  tradeSide: string;
  quantity: string;
  price: string;
  createdAt: string;
}

export interface LateExecutionReconciliationInput {
  record: DecisionExecutionRecord;
  order: ProviderOrderEvidence;
  fill: ProviderFillEvidence;
  currentPosition: PositionSnapshot;
  existingExperience?: TradeExperience;
  existingContext?: PositionContext | null;
  resolvedAt: string;
}

export interface LateExecutionReconciliationResult {
  status: "RECONCILED" | "ALREADY_RECONCILED";
  experience: TradeExperience;
  positionContext: PositionContext;
  auditMetadata: Record<string, string>;
}

export function parseProviderOrderEvidence(value: unknown): ProviderOrderEvidence | null {
  const source = record(value);
  const orderId = text(source.orderId);
  const clientOid = text(source.clientOid);
  const symbol = text(source.symbol);
  const side = text(source.side).toLowerCase();
  const positionSide = providerPositionSide(source.posSide);
  const tradeSide = text(source.tradeSide);
  const quantity = text(source.qty, text(source.size));
  const executedQuantity = text(source.cumExecQty, text(source.filledQty));
  const averageFillPrice = text(source.avgPrice, text(source.priceAvg));
  const status = text(source.orderStatus, text(source.status)).toLowerCase();
  const createdAt = text(source.createdTime, text(source.cTime));
  if (!orderId || !clientOid || !symbol || (side !== "buy" && side !== "sell") || !positionSide || !tradeSide || !quantity || !executedQuantity || !averageFillPrice || status !== "filled" || !createdAt) return null;
  return { orderId, clientOid, symbol, side, positionSide, tradeSide, quantity, executedQuantity, averageFillPrice, status: "filled", createdAt };
}

export function parseProviderFillEvidence(value: unknown, expectedOrder: ProviderOrderEvidence): ProviderFillEvidence | null {
  const rows = record(value).list;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((candidate) => {
    const source = record(candidate);
    return text(source.orderId) === expectedOrder.orderId && text(source.clientOid) === expectedOrder.clientOid;
  });
  if (!row) return null;
  const source = record(row);
  const fillId = text(source.execId, text(source.execLinkId));
  const orderId = text(source.orderId);
  const clientOid = text(source.clientOid);
  const symbol = text(source.symbol);
  const side = text(source.side).toLowerCase();
  const positionSide = providerPositionSide(source.posSide);
  const tradeSide = text(source.tradeSide);
  const quantity = text(source.execQty);
  const price = text(source.execPrice);
  const createdAt = text(source.createdTime, text(source.cTime));
  if (!fillId || !orderId || !clientOid || !symbol || (side !== "buy" && side !== "sell") || !positionSide || !tradeSide || !quantity || !price || !createdAt) return null;
  return { fillId, orderId, clientOid, symbol, side, positionSide, tradeSide, quantity, price, createdAt };
}

export function isReadbackOnlyExecutionMismatch(record: DecisionExecutionRecord): boolean {
  const reconciliation = record.reconciliationResult;
  if (!record.executionResult || record.executionResult.status !== "filled" || !reconciliation || reconciliation.status === "MATCHED") return false;
  return reconciliation.codes.length > 0 && reconciliation.codes.every((code) => READBACK_ONLY_CODES.has(code));
}

export function reconcileLateExecution(input: LateExecutionReconciliationInput): LateExecutionReconciliationResult {
  const { record, order, fill, currentPosition, existingExperience, existingContext, resolvedAt } = input;
  const decision = record.decision;
  const execution = record.executionResult;
  if (!execution || !isReadbackOnlyExecutionMismatch(record)) throw new Error("LATE_RECONCILIATION_NOT_ELIGIBLE");
  if (decision.action !== "OPEN_LONG" && decision.action !== "OPEN_SHORT") throw new Error("LATE_RECONCILIATION_NOT_OPEN");
  if (!decision.positionSide) throw new Error("LATE_RECONCILIATION_POSITION_SIDE_REQUIRED");

  const expectedClientOid = execution.clientOrderId || record.executionRequest?.clientOrderId;
  if (!expectedClientOid || order.clientOid !== expectedClientOid || fill.clientOid !== expectedClientOid) throw new Error("LATE_RECONCILIATION_CLIENT_ORDER_MISMATCH");
  if (execution.providerOrderId && order.orderId !== execution.providerOrderId) throw new Error("LATE_RECONCILIATION_PROVIDER_ORDER_MISMATCH");
  if (fill.orderId !== order.orderId) throw new Error("LATE_RECONCILIATION_FILL_ORDER_MISMATCH");
  if (order.symbol !== decision.symbol || fill.symbol !== decision.symbol || currentPosition.symbol !== decision.symbol) throw new Error("LATE_RECONCILIATION_SYMBOL_MISMATCH");
  if (order.positionSide !== decision.positionSide || fill.positionSide !== decision.positionSide || currentPosition.positionSide !== decision.positionSide) throw new Error("LATE_RECONCILIATION_SIDE_MISMATCH");
  if (!isPositiveDecimal(currentPosition.quantity)) throw new Error("LATE_RECONCILIATION_POSITION_MISSING");
  if (order.status !== "filled") throw new Error("LATE_RECONCILIATION_ORDER_NOT_FILLED");
  if (compareDecimal(order.executedQuantity, execution.executedQuantity) !== 0 || compareDecimal(fill.quantity, execution.executedQuantity) !== 0) throw new Error("LATE_RECONCILIATION_QUANTITY_MISMATCH");
  if (compareDecimal(order.executedQuantity, fill.quantity) !== 0) throw new Error("LATE_RECONCILIATION_FILL_QUANTITY_MISMATCH");
  if (!isPositiveDecimal(order.averageFillPrice) || !isPositiveDecimal(fill.price) || compareDecimal(order.averageFillPrice, fill.price) !== 0) throw new Error("LATE_RECONCILIATION_PRICE_MISMATCH");
  if (currentPosition.entryPrice && isPositiveDecimal(currentPosition.entryPrice) && compareDecimal(currentPosition.entryPrice, fill.price) !== 0) throw new Error("LATE_RECONCILIATION_POSITION_ENTRY_MISMATCH");
  const expectedProviderSide = decision.positionSide === "LONG" ? "buy" : "sell";
  if (order.side !== expectedProviderSide || fill.side !== expectedProviderSide) throw new Error("LATE_RECONCILIATION_PROVIDER_SIDE_MISMATCH");
  if (!isOpeningTradeSide(order.tradeSide, decision.positionSide) || !isOpeningTradeSide(fill.tradeSide, decision.positionSide)) throw new Error("LATE_RECONCILIATION_TRADE_SIDE_MISMATCH");

  if (existingExperience?.outcomeStatus === "OPEN" && existingExperience.entryDecisionId === decision.decisionId) {
    return {
      status: "ALREADY_RECONCILED",
      experience: existingExperience,
      positionContext: upsertPositionContext(existingContext ?? null, decision, resolvedAt, existingExperience) ?? existingContext ?? throwContextError(),
      auditMetadata: auditMetadata(record, existingExperience, order, resolvedAt),
    };
  }
  if (existingExperience?.outcomeStatus === "OPEN" && existingExperience.entryDecisionId !== decision.decisionId) throw new Error("LATE_RECONCILIATION_CONTRADICTORY_OPEN_LIFECYCLE");

  const experience = buildReconciledExperience(existingExperience, decision, execution, fill, currentPosition);
  const positionContext = upsertPositionContext(existingContext ?? null, decision, resolvedAt, experience);
  if (!positionContext) throw new Error("LATE_RECONCILIATION_CONTEXT_FAILED");
  return { status: "RECONCILED", experience, positionContext, auditMetadata: auditMetadata(record, experience, order, resolvedAt) };
}

function buildReconciledExperience(existing: TradeExperience | undefined, decision: LateExecutionReconciliationInput["record"]["decision"], execution: NonNullable<DecisionExecutionRecord["executionResult"]>, fill: ProviderFillEvidence, position: PositionSnapshot): TradeExperience {
  const entryTime = fill.createdAt || execution.submittedAt;
  return {
    ...(existing ?? {
      experienceId: `late-reconciled-${decision.decisionId}`,
      symbol: decision.symbol,
      positionSide: decision.positionSide,
      action: decision.action,
      entryDecisionId: decision.decisionId,
      entryThesis: decision.thesis,
      exitThesis: "",
      evidenceAtEntry: ["PROVIDER_ORDER", "PROVIDER_FILL", "PROVIDER_POSITION"],
      evidenceAtExit: [],
      lessonsUsed: decision.lessonsUsed,
      marketContext: "LATE_PROVIDER_RECONCILIATION",
      maximumFavorableExcursion: "0",
      maximumAdverseExcursion: "0",
      drawdownContribution: "0",
      liquidationDistance: "0",
    }),
    symbol: decision.symbol,
    positionSide: decision.positionSide,
    action: decision.action,
    entryDecisionId: decision.decisionId,
    entryPrice: fill.price,
    entryTime,
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: "",
    selectedLeverage: execution.leverage,
    marginAllocationPct: decision.marginAllocationPct,
    marginAllocated: position.marginAllocated || execution.marginAllocated,
    positionNotional: position.notional || execution.positionNotional,
    realizedPnl: "0",
    realizedPnlPct: "0",
    exitThesis: "",
    outcomeStatus: "OPEN",
    lastAction: decision.action,
    realizedPnlVerified: false,
  };
}

function auditMetadata(record: DecisionExecutionRecord, experience: TradeExperience, order: ProviderOrderEvidence, resolvedAt: string): Record<string, string> {
  return {
    originalCycleId: record.decision.cycleId,
    decisionId: record.decision.decisionId,
    experienceId: experience.experienceId,
    symbol: record.decision.symbol,
    positionSide: record.decision.positionSide ?? "UNKNOWN",
    providerOrderId: order.orderId,
    clientOrderId: order.clientOid,
    resolutionSource: "AUTHORITATIVE_PROVIDER_ORDER_FILL_POSITION",
    resolvedAt,
  };
}

function isOpeningTradeSide(value: string, side: PositionSide): boolean {
  const normalized = value.toLowerCase();
  return normalized === "open" || normalized === (side === "LONG" ? "open_long" : "open_short");
}

function throwContextError(): never {
  throw new Error("LATE_RECONCILIATION_CONTEXT_FAILED");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function providerPositionSide(value: unknown): PositionSide | null {
  const normalized = text(value).toUpperCase();
  return normalized === "LONG" ? "LONG" : normalized === "SHORT" ? "SHORT" : null;
}
