import type { DecisionExecutionRecord, PositionContext, PositionSide, PositionSnapshot, TradeExperience } from "../types.js";
import { addDecimal, compareDecimal, isPositiveDecimal, multiplyDecimal } from "./decimal.js";
import { upsertPositionContext } from "../agent/position-context.js";
import { classifyProviderLifecycle, providerWeightedEntryPriceMatches, type ProviderLifecycleEvidence } from "./provider-lifecycle-reconciliation.js";
import { resolveProviderLifecycleSide } from "./provider-lifecycle-side.js";

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
  fills?: readonly ProviderFillEvidence[];
  currentPosition: PositionSnapshot;
  currentPositionLifecycle?: ProviderLifecycleEvidence;
  allowUnknownProviderExecution?: boolean;
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

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export function providerTimestampIso(value: unknown): string | null {
  let milliseconds: number;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    milliseconds = value;
  } else if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return null;
    if (/^\d+$/.test(normalized)) {
      const parsed = Number(normalized);
      if (!Number.isSafeInteger(parsed)) return null;
      milliseconds = parsed;
    } else {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.exec(normalized);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      const second = match[6] ? Number(match[6]) : 0;
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
      if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
      const parsed = Date.parse(normalized);
      if (!Number.isFinite(parsed)) return null;
      milliseconds = parsed;
    }
  } else {
    return null;
  }
  if (milliseconds < 0 || milliseconds > MAX_DATE_MILLISECONDS) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

export interface ProviderOrderReadback {
  orderId: string;
  clientOid: string;
  symbol: string;
  side: "buy" | "sell";
  positionSide: PositionSide;
  tradeSide: string;
  quantity: string;
  executedQuantity: string;
  averageFillPrice: string | null;
  status: string;
  createdAt: string;
}

export function parseProviderOrderReadback(value: unknown): ProviderOrderReadback | null {
  const source = record(value);
  const orderId = text(source.orderId);
  const clientOid = text(source.clientOid);
  const symbol = text(source.symbol);
  const side = text(source.side).toLowerCase();
  const positionSide = providerPositionSide(source.posSide);
  const tradeSide = text(source.tradeSide);
  const quantity = text(source.qty, text(source.size));
  const executedQuantity = text(source.cumExecQty, text(source.filledQty));
  const averageFillPrice = text(source.avgPrice, text(source.priceAvg)) || null;
  const status = text(source.orderStatus, text(source.status)).toLowerCase();
  const createdAt = providerTimestampIso(source.createdTime);
  if (!orderId || !clientOid || !symbol || (side !== "buy" && side !== "sell") || !positionSide || !tradeSide
    || !quantity || !executedQuantity || !status || !createdAt) return null;
  return { orderId, clientOid, symbol, side, positionSide, tradeSide, quantity, executedQuantity, averageFillPrice, status, createdAt };
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
  const createdAt = providerTimestampIso(source.createdTime);
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
  return row ? parseProviderFillRow(row) : null;
}

export interface ProviderFillEvidenceReadback {
  records: ProviderFillEvidence[];
  providerRowCount: number;
  invalidProviderRowCount: number;
}

export type ProviderFillAggregation =
  | { valid: true; fills: ProviderFillEvidence[]; executedQuantity: string; executedValue: string; averageFillPrice: string }
  | { valid: false; code: "PROVIDER_FILL_SET_EMPTY" | "PROVIDER_FILL_ID_DUPLICATE" | "PROVIDER_FILL_IDENTITY_MISMATCH" | "PROVIDER_FILL_SIDE_MISMATCH" | "PROVIDER_FILL_QUANTITY_MISMATCH" | "PROVIDER_FILL_PRICE_MISMATCH" };

export function aggregateProviderFillEvidence(
  fills: readonly ProviderFillEvidence[],
  order: ProviderOrderEvidence,
  expectedQuantity: string,
  expectedAveragePrice: string,
  expectedLifecycleSide: "OPEN" | "CLOSE",
): ProviderFillAggregation {
  if (fills.length === 0) return { valid: false, code: "PROVIDER_FILL_SET_EMPTY" };
  const fillIds = new Set<string>();
  for (const fill of fills) {
    if (fillIds.has(fill.fillId)) return { valid: false, code: "PROVIDER_FILL_ID_DUPLICATE" };
    fillIds.add(fill.fillId);
    if (fill.orderId !== order.orderId || fill.clientOid !== order.clientOid || fill.symbol !== order.symbol
      || fill.side !== order.side || fill.positionSide !== order.positionSide) {
      return { valid: false, code: "PROVIDER_FILL_IDENTITY_MISMATCH" };
    }
    if (resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide) !== expectedLifecycleSide
      || resolveProviderLifecycleSide(order.side, order.positionSide, order.tradeSide) !== expectedLifecycleSide) {
      return { valid: false, code: "PROVIDER_FILL_SIDE_MISMATCH" };
    }
  }
  let executedQuantity: string;
  let executedValue: string;
  try {
    executedQuantity = fills.reduce((sum, fill) => addDecimal(sum, fill.quantity), "0");
    executedValue = fills.reduce((sum, fill) => addDecimal(sum, multiplyDecimal(fill.quantity, fill.price)), "0");
  } catch {
    return { valid: false, code: "PROVIDER_FILL_QUANTITY_MISMATCH" };
  }
  if (!isPositiveDecimal(expectedQuantity) || !isPositiveDecimal(order.quantity) || !isPositiveDecimal(order.executedQuantity)
    || compareDecimal(order.quantity, expectedQuantity) !== 0 || compareDecimal(order.executedQuantity, expectedQuantity) !== 0
    || compareDecimal(executedQuantity, expectedQuantity) !== 0) {
    return { valid: false, code: "PROVIDER_FILL_QUANTITY_MISMATCH" };
  }
  const weightedFills = fills.map((fill) => ({ quantity: fill.quantity, execPrice: fill.price }));
  if (!providerWeightedEntryPriceMatches(weightedFills, expectedAveragePrice)
    || !providerWeightedEntryPriceMatches(weightedFills, order.averageFillPrice)) {
    return { valid: false, code: "PROVIDER_FILL_PRICE_MISMATCH" };
  }
  return { valid: true, fills: [...fills].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.fillId.localeCompare(right.fillId)), executedQuantity, executedValue, averageFillPrice: expectedAveragePrice };
}

export function parseProviderFillEvidenceRows(value: unknown): ProviderFillEvidenceReadback {
  const rows = record(value).list;
  if (!Array.isArray(rows)) return { records: [], providerRowCount: 0, invalidProviderRowCount: 0 };
  const records = rows.flatMap((row) => {
    const parsed = parseProviderFillRow(row);
    return parsed ? [parsed] : [];
  });
  return { records, providerRowCount: rows.length, invalidProviderRowCount: rows.length - records.length };
}

function parseProviderFillRow(value: unknown): ProviderFillEvidence | null {
  const source = record(value);
  const fillId = text(source.execId, text(source.execLinkId));
  const orderId = text(source.orderId);
  const clientOid = text(source.clientOid);
  const symbol = text(source.symbol);
  const side = text(source.side).toLowerCase();
  const positionSide = providerPositionSide(source.posSide);
  const tradeSide = text(source.tradeSide);
  const quantity = text(source.execQty);
  const price = text(source.execPrice);
  const createdAt = providerTimestampIso(source.createdTime);
  if (!fillId || !orderId || !clientOid || !symbol || (side !== "buy" && side !== "sell") || !positionSide || !tradeSide || !isPositiveDecimal(quantity) || !isPositiveDecimal(price) || !createdAt) return null;
  return { fillId, orderId, clientOid, symbol, side, positionSide, tradeSide, quantity, price, createdAt };
}

export function isReadbackOnlyExecutionMismatch(record: DecisionExecutionRecord): boolean {
  const reconciliation = record.reconciliationResult;
  if (!record.executionResult || record.executionResult.status !== "filled" || !reconciliation || reconciliation.status === "MATCHED") return false;
  return reconciliation.codes.length > 0 && reconciliation.codes.every((code) => READBACK_ONLY_CODES.has(code));
}

export function reconcileLateExecution(input: LateExecutionReconciliationInput): LateExecutionReconciliationResult {
  const { record, order, fill, currentPosition, existingExperience, existingContext, resolvedAt } = input;
  const fills = input.fills ?? [fill];
  const decision = record.decision;
  const execution = record.executionResult;
  const unknownLateExecution = input.allowUnknownProviderExecution === true
    && execution?.status === "unknown"
    && record.reconciliationResult?.status === "UNKNOWN"
    && record.executionRequest?.clientOrderId === execution.clientOrderId
    && record.executionRequest.symbol === decision.symbol
    && record.executionRequest.positionSide === decision.positionSide
    && record.executionRequest.action === decision.action;
  if (!execution || (!isReadbackOnlyExecutionMismatch(record) && !unknownLateExecution)) throw new Error("LATE_RECONCILIATION_NOT_ELIGIBLE");
  if (decision.action !== "OPEN_LONG" && decision.action !== "OPEN_SHORT") throw new Error("LATE_RECONCILIATION_NOT_OPEN");
  if (!decision.positionSide) throw new Error("LATE_RECONCILIATION_POSITION_SIDE_REQUIRED");
  if (providerTimestampIso(order.createdAt) !== order.createdAt || fills.some((item) => providerTimestampIso(item.createdAt) !== item.createdAt)) throw new Error("LATE_RECONCILIATION_TIMESTAMP_INVALID");

  const expectedClientOid = execution.clientOrderId || record.executionRequest?.clientOrderId;
  if (!expectedClientOid || order.clientOid !== expectedClientOid || fills.some((item) => item.clientOid !== expectedClientOid)) throw new Error("LATE_RECONCILIATION_CLIENT_ORDER_MISMATCH");
  if (execution.providerOrderId && order.orderId !== execution.providerOrderId) throw new Error("LATE_RECONCILIATION_PROVIDER_ORDER_MISMATCH");
  if (fills.some((item) => item.orderId !== order.orderId)) throw new Error("LATE_RECONCILIATION_FILL_ORDER_MISMATCH");
  if (order.symbol !== decision.symbol || fills.some((item) => item.symbol !== decision.symbol) || currentPosition.symbol !== decision.symbol) throw new Error("LATE_RECONCILIATION_SYMBOL_MISMATCH");
  if (order.positionSide !== decision.positionSide || fills.some((item) => item.positionSide !== decision.positionSide) || currentPosition.positionSide !== decision.positionSide) throw new Error("LATE_RECONCILIATION_SIDE_MISMATCH");
  if (!isPositiveDecimal(currentPosition.quantity)) throw new Error("LATE_RECONCILIATION_POSITION_MISSING");
  if (order.status !== "filled") throw new Error("LATE_RECONCILIATION_ORDER_NOT_FILLED");
  const expectedExecutedQuantity = unknownLateExecution ? record.executionRequest!.quantity : execution.executedQuantity;
  if (compareDecimal(order.quantity, order.executedQuantity) !== 0 || compareDecimal(order.executedQuantity, expectedExecutedQuantity) !== 0) throw new Error("LATE_RECONCILIATION_QUANTITY_MISMATCH");
  const expectedAveragePrice = execution.averageFillPrice ?? order.averageFillPrice;
  if (!isPositiveDecimal(order.averageFillPrice) || !isPositiveDecimal(expectedAveragePrice)) throw new Error("LATE_RECONCILIATION_PRICE_MISMATCH");
  const aggregate = aggregateProviderFillEvidence(fills, order, expectedExecutedQuantity, expectedAveragePrice, "OPEN");
  if (!aggregate.valid) throw new Error(`LATE_RECONCILIATION_${aggregate.code}`);
  const expectedProviderSide = decision.positionSide === "LONG" ? "buy" : "sell";
  if (order.side !== expectedProviderSide || fills.some((item) => item.side !== expectedProviderSide)) throw new Error("LATE_RECONCILIATION_PROVIDER_SIDE_MISMATCH");
  if (!isOpeningTradeSide(order.tradeSide, decision.positionSide) || fills.some((item) => !isOpeningTradeSide(item.tradeSide, decision.positionSide!))) throw new Error("LATE_RECONCILIATION_TRADE_SIDE_MISMATCH");

  if (input.currentPositionLifecycle) {
    const lifecycle = input.currentPositionLifecycle;
    const classification = classifyProviderLifecycle(lifecycle);
    if (classification.classification !== "MATCHED_OPEN") throw new Error(`LATE_RECONCILIATION_CURRENT_POSITION_${classification.classification}_${classification.reason}`);
    if (lifecycle.entryIdentity?.entryDecisionId !== decision.decisionId || lifecycle.entryIdentity.clientOid !== expectedClientOid
      || lifecycle.entryIdentity.providerOrderId !== order.orderId) throw new Error("LATE_RECONCILIATION_CURRENT_POSITION_ENTRY_IDENTITY_MISMATCH");
    const current = lifecycle.providerPositions.find((item) => item.symbol === currentPosition.symbol && item.positionSide === currentPosition.positionSide);
    if (!current || compareDecimal(current.quantity, currentPosition.quantity) !== 0
      || !current.entryPrice || !currentPosition.entryPrice || compareDecimal(current.entryPrice, currentPosition.entryPrice) !== 0) {
      throw new Error("LATE_RECONCILIATION_CURRENT_POSITION_READBACK_MISMATCH");
    }
  } else if (currentPosition.entryPrice && isPositiveDecimal(currentPosition.entryPrice)
    && compareDecimal(currentPosition.entryPrice, aggregate.averageFillPrice) !== 0) {
    throw new Error("LATE_RECONCILIATION_POSITION_ENTRY_MISMATCH");
  }

  if (existingExperience?.outcomeStatus === "OPEN" && existingExperience.entryDecisionId === decision.decisionId) {
    if (
      !existingContext
      || existingContext.symbol !== decision.symbol
      || existingContext.positionSide !== decision.positionSide
      || existingContext.experienceId !== existingExperience.experienceId
      || existingContext.entryDecisionId !== decision.decisionId
    ) throw new Error("LATE_RECONCILIATION_STATE_INCONSISTENCY");
    return {
      status: "ALREADY_RECONCILED",
      experience: existingExperience,
      positionContext: existingContext,
      auditMetadata: { ...auditMetadata(record, existingExperience, order, resolvedAt), fillCount: String(aggregate.fills.length), fillIds: aggregate.fills.map((item) => item.fillId).join(",") },
    };
  }
  if (existingExperience?.outcomeStatus === "OPEN" && existingExperience.entryDecisionId !== decision.decisionId) throw new Error("LATE_RECONCILIATION_CONTRADICTORY_OPEN_LIFECYCLE");

  const firstFill = aggregate.fills[0]!;
  const experience = buildReconciledExperience(existingExperience, decision, execution, firstFill, aggregate.averageFillPrice, aggregate.executedValue);
  const positionContext = upsertPositionContext(existingContext ?? null, decision, resolvedAt, experience);
  if (!positionContext) throw new Error("LATE_RECONCILIATION_CONTEXT_FAILED");
  return {
    status: "RECONCILED", experience, positionContext,
    auditMetadata: { ...auditMetadata(record, experience, order, resolvedAt), fillCount: String(aggregate.fills.length), fillIds: aggregate.fills.map((item) => item.fillId).join(",") },
  };
}

function buildReconciledExperience(existing: TradeExperience | undefined, decision: LateExecutionReconciliationInput["record"]["decision"], execution: NonNullable<DecisionExecutionRecord["executionResult"]>, fill: ProviderFillEvidence, aggregateAveragePrice = fill.price, aggregateExecutedValue = execution.positionNotional): TradeExperience {
  const entryTime = fill.createdAt;
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
    entryPrice: aggregateAveragePrice,
    entryTime,
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: "",
    selectedLeverage: execution.leverage,
    marginAllocationPct: decision.marginAllocationPct,
    marginAllocated: execution.marginAllocated,
    positionNotional: aggregateExecutedValue,
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
