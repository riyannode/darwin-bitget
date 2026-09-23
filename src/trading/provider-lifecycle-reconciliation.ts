import type { TradeExperience } from "../types.js";
import { addDecimal, compareDecimal, isDecimal, isPositiveDecimal } from "./decimal.js";

export type ProviderLifecycleClassification =
  | "MATCHED_OPEN"
  | "MATCHED_CLOSED"
  | "LOCAL_OPEN_PROVIDER_CLOSED"
  | "PROVIDER_POSITION_WITHOUT_LOCAL_LIFECYCLE"
  | "PROVIDER_EXTERNAL"
  | "UNRESOLVED"
  | "CONTRADICTORY";

export type ProviderEvidenceOrigin = "DARWIN" | "PROVIDER_EXTERNAL" | "UNATTRIBUTED";

export interface ProviderLifecycleHistory {
  providerPositionHistoryId: string | null;
  symbol: string;
  positionSide: string;
  openTotalPos: string | null;
  closeTotalPos: string | null;
  avgEntryPrice: string | null;
  avgExitPrice: string | null;
  cumRealisedPnl: string | null;
  netProfit: string | null;
  openFeeTotal: string | null;
  closeFeeTotal: string | null;
  totalFunding: string | null;
  cashDividend: string | null;
  openingTime: string;
  closingTime: string;
  origin: ProviderEvidenceOrigin;
}

export interface ProviderLifecyclePosition {
  symbol: string;
  positionSide: string;
  quantity: string;
  entryPrice?: string | null;
  openedAt?: string | null;
}

export interface ProviderLifecycleOrder {
  providerOrderId: string;
  clientOid: string | null;
  symbol: string;
  positionSide: string | null;
  tradeSide: string | null;
  origin: ProviderEvidenceOrigin;
}

export interface ProviderLifecycleFill {
  providerOrderId: string;
  clientOid: string | null;
  symbol: string;
  positionSide: string | null;
  tradeSide: string | null;
  quantity: string;
  execPrice: string;
  createdAt: string;
  origin: ProviderEvidenceOrigin;
}

export interface ProviderLifecycleEvidence {
  experience: TradeExperience;
  providerPositions: readonly ProviderLifecyclePosition[];
  history: ProviderLifecycleHistory | null;
  entryIdentity: { entryDecisionId: string; clientOid: string; providerOrderId: string } | null;
  orders: readonly ProviderLifecycleOrder[];
  fills: readonly ProviderLifecycleFill[];
}

export interface ProviderLifecycleResult {
  classification: ProviderLifecycleClassification;
  reason: string;
  closedQuantity?: string;
}

function result(classification: ProviderLifecycleClassification, reason: string, closedQuantity?: string): ProviderLifecycleResult {
  return { classification, reason, ...(closedQuantity !== undefined ? { closedQuantity } : {}) };
}

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function exactSum(values: readonly string[]): string | null {
  try {
    return values.reduce((sum, value) => addDecimal(sum, value), "0");
  } catch {
    return null;
  }
}

function orderForFill(fill: ProviderLifecycleFill, orders: readonly ProviderLifecycleOrder[]): ProviderLifecycleOrder | undefined {
  return orders.find((order) => order.providerOrderId === fill.providerOrderId
    && order.clientOid === fill.clientOid
    && order.symbol === fill.symbol
    && order.positionSide === fill.positionSide
    && order.tradeSide === fill.tradeSide
    && order.origin === fill.origin);
}

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match?.[2]) throw new Error("INVALID_DECIMAL");
  const fraction = match[3] ?? "";
  return { coefficient: BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${fraction}`), scale: fraction.length };
}

function weightedEntryMatches(fills: readonly Pick<ProviderLifecycleFill, "quantity" | "execPrice">[], expectedPrice: string): boolean {
  try {
    if (!fills.length || !fills.every((fill) => isPositiveDecimal(fill.quantity) && isPositiveDecimal(fill.execPrice))) return false;
    const quantities = fills.map((fill) => decimalParts(fill.quantity));
    const prices = fills.map((fill) => decimalParts(fill.execPrice));
    const quantityScale = Math.max(...quantities.map((part) => part.scale));
    const priceScale = Math.max(...prices.map((part) => part.scale));
    const totalQuantity = quantities.reduce((sum, part) => sum + part.coefficient * 10n ** BigInt(quantityScale - part.scale), 0n);
    const weightedValue = quantities.reduce((sum, quantity, index) => {
      const price = prices[index]!;
      const q = quantity.coefficient * 10n ** BigInt(quantityScale - quantity.scale);
      const p = price.coefficient * 10n ** BigInt(priceScale - price.scale);
      return sum + q * p;
    }, 0n);
    const expected = decimalParts(expectedPrice);
    // Provider history rounds weighted averages to the precision it returns.
    const targetScale = expected.scale;
    const numerator = weightedValue * 10n ** BigInt(targetScale);
    const denominator = totalQuantity * 10n ** BigInt(priceScale);
    const rounded = (numerator + denominator / 2n) / denominator;
    return rounded === expected.coefficient * 10n ** BigInt(targetScale - expected.scale);
  } catch {
    return false;
  }
}

export function providerWeightedEntryPriceMatches(fills: readonly Pick<ProviderLifecycleFill, "quantity" | "execPrice">[], expectedPrice: string): boolean {
  return weightedEntryMatches(fills, expectedPrice);
}

const MAX_OPENING_CHRONOLOGY_SKEW_MS = 5_000;

function isNearTimestamp(value: string, reference: string): boolean {
  const timestamp = validTimestamp(value);
  const referenceTimestamp = validTimestamp(reference);
  return timestamp !== null && referenceTimestamp !== null && Math.abs(timestamp - referenceTimestamp) <= MAX_OPENING_CHRONOLOGY_SKEW_MS;
}

function openingIdentityIsProven(evidence: ProviderLifecycleEvidence, openingTime: string, expectedQuantity: string, expectedEntryPrice: string): boolean {
  const { experience, entryIdentity } = evidence;
  if (!experience.positionSide || !entryIdentity || entryIdentity.entryDecisionId !== experience.entryDecisionId || !entryIdentity.clientOid || !entryIdentity.providerOrderId) return false;
  const orders = evidence.orders.filter((order) => order.providerOrderId === entryIdentity.providerOrderId
    && order.clientOid === entryIdentity.clientOid && order.symbol === experience.symbol
    && order.positionSide === experience.positionSide && order.tradeSide === "open" && order.origin === "DARWIN");
  if (orders.length !== 1) return false;
  const fills = evidence.fills.filter((fill) => fill.providerOrderId === entryIdentity.providerOrderId
    && fill.clientOid === entryIdentity.clientOid && fill.symbol === experience.symbol
    && fill.positionSide === experience.positionSide && fill.tradeSide === "open" && fill.origin === "DARWIN"
    && orderForFill(fill, orders));
  if (!fills.length || fills.some((fill) => !isNearTimestamp(fill.createdAt, openingTime))) return false;
  const opened = exactSum(fills.map((fill) => fill.quantity));
  return opened !== null && compareDecimal(opened, expectedQuantity) === 0 && weightedEntryMatches(fills, expectedEntryPrice);
}

function currentPositionHasLedgerEvidence(evidence: ProviderLifecycleEvidence, position: ProviderLifecyclePosition): boolean {
  return evidence.fills.some((fill) => fill.symbol === position.symbol && fill.positionSide === position.positionSide
    && isPositiveDecimal(fill.quantity) && orderForFill(fill, evidence.orders));
}

export function classifyProviderLifecycle(evidence: ProviderLifecycleEvidence): ProviderLifecycleResult {
  const { experience, history } = evidence;
  const side = experience.positionSide;
  if (!side) return result("UNRESOLVED", "LOCAL_POSITION_SIDE_MISSING");

  const matchingPositions = evidence.providerPositions.filter((position) => position.symbol === experience.symbol && position.positionSide === side);
  if (matchingPositions.some((position) => !isDecimal(position.quantity))) return result("UNRESOLVED", "CURRENT_PROVIDER_POSITION_QUANTITY_INVALID");
  if (matchingPositions.some((position) => compareDecimal(position.quantity, "0") < 0)) return result("CONTRADICTORY", "CURRENT_PROVIDER_POSITION_QUANTITY_NEGATIVE");
  const current = matchingPositions.filter((position) => compareDecimal(position.quantity, "0") > 0);
  if (current.length > 1) return result("CONTRADICTORY", "MULTIPLE_CURRENT_PROVIDER_POSITIONS");

  if (!history) {
    if (current.length === 1 && experience.outcomeStatus === "OPEN" && current[0]?.openedAt && current[0].entryPrice
      && openingIdentityIsProven(evidence, current[0].openedAt, current[0].quantity, current[0].entryPrice)) {
      return result("MATCHED_OPEN", "CURRENT_PROVIDER_POSITION_AND_ENTRY_IDENTITY_MATCH");
    }
    if (current.length === 1 && currentPositionHasLedgerEvidence(evidence, current[0]!)) {
      const positionFills = evidence.fills.filter((fill) => fill.symbol === current[0]!.symbol && fill.positionSide === current[0]!.positionSide && orderForFill(fill, evidence.orders));
      if (positionFills.some((fill) => fill.origin === "PROVIDER_EXTERNAL")) return result("PROVIDER_EXTERNAL", "CURRENT_POSITION_ATTRIBUTED_EXTERNAL");
      if (experience.outcomeStatus !== "OPEN") return result("PROVIDER_POSITION_WITHOUT_LOCAL_LIFECYCLE", "CURRENT_POSITION_HAS_PROVIDER_LEDGER_IDENTITY");
    }
    return result("UNRESOLVED", "PROVIDER_POSITION_HISTORY_OR_ENTRY_IDENTITY_MISSING");
  }

  if (history.symbol !== experience.symbol || history.positionSide !== side) return result("CONTRADICTORY", "POSITION_HISTORY_IDENTITY_MISMATCH");
  if (history.origin === "PROVIDER_EXTERNAL") return result("PROVIDER_EXTERNAL", "POSITION_HISTORY_ATTRIBUTED_EXTERNAL");
  if (history.origin !== "DARWIN" && history.origin !== "UNATTRIBUTED") return result("UNRESOLVED", "POSITION_HISTORY_ORIGIN_INVALID");
  if (!history.providerPositionHistoryId) return result("UNRESOLVED", "POSITION_HISTORY_ID_MISSING");

  if (current.length === 1) {
    if (experience.outcomeStatus !== "OPEN") return result("CONTRADICTORY", "CURRENT_PROVIDER_POSITION_CONTRADICTS_LOCAL_LIFECYCLE");
    if (history.openTotalPos && history.closeTotalPos && isPositiveDecimal(history.closeTotalPos)
      && compareDecimal(history.openTotalPos, history.closeTotalPos) === 0
      && validTimestamp(history.closingTime) !== null) {
      return result("CONTRADICTORY", "CURRENT_PROVIDER_POSITION_CONTRADICTS_CLOSED_HISTORY");
    }
    if (!history.openTotalPos || !history.avgEntryPrice || !openingIdentityIsProven(evidence, history.openingTime, history.openTotalPos, history.avgEntryPrice)) return result("UNRESOLVED", "CURRENT_POSITION_ENTRY_IDENTITY_UNPROVEN");
    return result("MATCHED_OPEN", "CURRENT_PROVIDER_POSITION_AND_ENTRY_IDENTITY_MATCH");
  }
  const openQuantity = history.openTotalPos;
  const closeQuantity = history.closeTotalPos;
  if (!openQuantity || !closeQuantity || !isPositiveDecimal(openQuantity) || !isPositiveDecimal(closeQuantity)) return result("UNRESOLVED", "POSITION_HISTORY_QUANTITY_MISSING_OR_INVALID");
  const financialValues = [history.avgEntryPrice, history.avgExitPrice, history.cumRealisedPnl, history.netProfit, history.openFeeTotal, history.closeFeeTotal, history.totalFunding, history.cashDividend];
  if (financialValues.some((value) => !isDecimal(value ?? undefined))) return result("UNRESOLVED", "PROVIDER_FINANCIAL_EVIDENCE_INCOMPLETE");
  if (compareDecimal(openQuantity, closeQuantity) !== 0) return result("CONTRADICTORY", "POSITION_HISTORY_OPEN_CLOSE_QUANTITY_MISMATCH");
  const openingMs = validTimestamp(history.openingTime);
  const closingMs = validTimestamp(history.closingTime);
  if (openingMs === null || closingMs === null || closingMs <= openingMs) return result("CONTRADICTORY", "POSITION_HISTORY_TIME_INVALID");

  const identity = evidence.entryIdentity;
  if (!identity || identity.entryDecisionId !== experience.entryDecisionId || !identity.clientOid || !identity.providerOrderId) return result("UNRESOLVED", "ENTRY_DECISION_IDENTITY_UNPROVEN");
  const openingOrders = evidence.orders.filter((order) => order.providerOrderId === identity.providerOrderId
    && order.clientOid === identity.clientOid
    && order.symbol === experience.symbol
    && order.positionSide === side
    && order.tradeSide === "open"
    && order.origin === "DARWIN");
  if (openingOrders.length !== 1) return result("UNRESOLVED", "DARWIN_OPENING_ORDER_IDENTITY_UNPROVEN");
  const openingFills = evidence.fills.filter((fill) => fill.providerOrderId === identity.providerOrderId
    && fill.clientOid === identity.clientOid
    && fill.symbol === experience.symbol
    && fill.positionSide === side
    && fill.tradeSide === "open"
    && fill.origin === "DARWIN"
    && orderForFill(fill, openingOrders));
  if (!openingFills.length || openingFills.some((fill) => !isNearTimestamp(fill.createdAt, history.openingTime))) return result("UNRESOLVED", "DARWIN_OPENING_FILL_IDENTITY_UNPROVEN");
  const opened = exactSum(openingFills.map((fill) => fill.quantity));
  if (!opened || !isDecimal(opened) || compareDecimal(opened, openQuantity) !== 0) return result("CONTRADICTORY", "OPENING_FILL_QUANTITY_RESIDUAL");
  if (!history.avgEntryPrice || !weightedEntryMatches(openingFills, history.avgEntryPrice)) return result("CONTRADICTORY", "OPENING_FILL_WEIGHTED_PRICE_MISMATCH");

  const closingOrders = evidence.orders.filter((order) => order.tradeSide === "close"
    && order.symbol === experience.symbol
    && order.positionSide === side
    && Boolean(order.clientOid)
    && order.origin === "DARWIN");
  const closeOrderIds = new Set(closingOrders.map((order) => order.providerOrderId));
  const closeCandidates = evidence.fills.filter((fill) => {
    const time = validTimestamp(fill.createdAt);
    return time !== null && time >= openingMs && time <= closingMs
      && (closeOrderIds.has(fill.providerOrderId) || (fill.symbol === experience.symbol && fill.tradeSide === "close"));
  });
  if (closeCandidates.some((fill) => fill.symbol !== experience.symbol || fill.positionSide !== side || fill.tradeSide !== "close" || fill.origin !== "DARWIN" || !orderForFill(fill, closingOrders))) {
    return result("CONTRADICTORY", "CLOSING_FILL_IDENTITY_OR_ORIGIN_CONTRADICTORY");
  }
  if (!closeCandidates.length) return result("UNRESOLVED", "DARWIN_CLOSING_FILLS_MISSING");
  if (closeCandidates.some((fill) => !isPositiveDecimal(fill.quantity))) return result("CONTRADICTORY", "CLOSING_FILL_QUANTITY_INVALID");
  const closed = exactSum(closeCandidates.map((fill) => fill.quantity));
  if (!closed || compareDecimal(closed, closeQuantity) !== 0) return result("CONTRADICTORY", "CLOSING_FILL_QUANTITY_RESIDUAL", closed ?? "0");
  if (experience.outcomeStatus !== "OPEN") return result("MATCHED_CLOSED", "LOCAL_AND_PROVIDER_LIFECYCLES_CLOSED", closed);
  return result("LOCAL_OPEN_PROVIDER_CLOSED", "PROVIDER_LEDGER_PROVES_FULL_DARWIN_CLOSE", closed);
}
