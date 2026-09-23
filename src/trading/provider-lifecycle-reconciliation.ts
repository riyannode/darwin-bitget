import type { TradeExperience } from "../types.js";
import { addDecimal, compareDecimal, isDecimal, isPositiveDecimal, subtractDecimal } from "./decimal.js";

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
  evidenceComplete?: boolean;
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

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}

function currentPositionEntryMatches(fills: readonly ProviderLifecycleFill[], expectedQuantity: string, expectedPrice: string): boolean {
  try {
    if (!fills.length || !isPositiveDecimal(expectedQuantity) || !isPositiveDecimal(expectedPrice)
      || !fills.every((fill) => isPositiveDecimal(fill.quantity) && isPositiveDecimal(fill.execPrice))) return false;
    const ordered = [...fills].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    for (let index = 1; index < ordered.length; index += 1) {
      if (Date.parse(ordered[index - 1]!.createdAt) === Date.parse(ordered[index]!.createdAt)
        && ordered[index - 1]!.tradeSide !== ordered[index]!.tradeSide) return false;
    }
    const quantities = ordered.map((fill) => decimalParts(fill.quantity));
    const prices = ordered.map((fill) => decimalParts(fill.execPrice));
    const quantityScale = Math.max(...quantities.map((part) => part.scale));
    const priceScale = Math.max(...prices.map((part) => part.scale));
    let currentQuantity = 0n;
    let costNumerator = 0n;
    let costDenominator = 1n;
    for (let index = 0; index < ordered.length; index += 1) {
      const fill = ordered[index]!;
      const quantity = quantities[index]!.coefficient * 10n ** BigInt(quantityScale - quantities[index]!.scale);
      if (fill.tradeSide === "open") {
        const price = prices[index]!.coefficient * 10n ** BigInt(priceScale - prices[index]!.scale);
        costNumerator += quantity * price * costDenominator;
        const divisor = greatestCommonDivisor(costNumerator, costDenominator);
        costNumerator /= divisor;
        costDenominator /= divisor;
        currentQuantity += quantity;
      } else if (fill.tradeSide === "close") {
        if (quantity > currentQuantity) return false;
        const remainingQuantity = currentQuantity - quantity;
        if (currentQuantity > 0n) {
          costNumerator *= remainingQuantity;
          costDenominator *= currentQuantity;
          const divisor = greatestCommonDivisor(costNumerator, costDenominator);
          costNumerator /= divisor;
          costDenominator /= divisor;
        }
        currentQuantity = remainingQuantity;
      } else return false;
    }
    const expectedQuantityParts = decimalParts(expectedQuantity);
    const expectedQuantityUnits = expectedQuantityParts.coefficient * 10n ** BigInt(Math.max(quantityScale, expectedQuantityParts.scale) - expectedQuantityParts.scale);
    const scaledCurrentQuantity = currentQuantity * 10n ** BigInt(Math.max(quantityScale, expectedQuantityParts.scale) - quantityScale);
    if (scaledCurrentQuantity !== expectedQuantityUnits || currentQuantity === 0n) return false;

    const expected = decimalParts(expectedPrice);
    const numerator = costNumerator * 10n ** BigInt(expected.scale);
    const denominator = costDenominator * currentQuantity * 10n ** BigInt(priceScale);
    const rounded = (numerator + denominator / 2n) / denominator;
    return rounded === expected.coefficient;
  } catch {
    return false;
  }
}

const MAX_OPENING_CHRONOLOGY_SKEW_MS = 5_000;

function isNearTimestamp(value: string, reference: string): boolean {
  const timestamp = validTimestamp(value);
  const referenceTimestamp = validTimestamp(reference);
  return timestamp !== null && referenceTimestamp !== null && Math.abs(timestamp - referenceTimestamp) <= MAX_OPENING_CHRONOLOGY_SKEW_MS;
}

function openingIdentityIsProven(evidence: ProviderLifecycleEvidence, openingTime: string): boolean {
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
  return fills.length > 0 && fills.every((fill) => isPositiveDecimal(fill.quantity) && isNearTimestamp(fill.createdAt, openingTime));
}

type LifecycleFillReconstruction =
  | { ok: true; openingFills: ProviderLifecycleFill[]; closingFills: ProviderLifecycleFill[]; openQuantity: string; closeQuantity: string; remainingQuantity: string }
  | { ok: false; classification: "PROVIDER_EXTERNAL" | "UNRESOLVED" | "CONTRADICTORY"; reason: string };

function reconstructProviderLifecycleFills(evidence: ProviderLifecycleEvidence, openingTime: string, closingTime?: string): LifecycleFillReconstruction {
  if (evidence.evidenceComplete === false) return { ok: false, classification: "UNRESOLVED", reason: "PROVIDER_LIFECYCLE_EVIDENCE_TRUNCATED" };
  const openingMs = validTimestamp(openingTime);
  const closingMs = closingTime ? validTimestamp(closingTime) : null;
  if (openingMs === null || (closingTime && closingMs === null)) return { ok: false, classification: "UNRESOLVED", reason: "PROVIDER_LIFECYCLE_TIME_INVALID" };
  const side = evidence.experience.positionSide;
  if (!side) return { ok: false, classification: "UNRESOLVED", reason: "LOCAL_POSITION_SIDE_MISSING" };
  const sameSymbolFills = evidence.fills.filter((fill) => fill.symbol === evidence.experience.symbol);
  if (sameSymbolFills.some((fill) => validTimestamp(fill.createdAt) === null)) return { ok: false, classification: "UNRESOLVED", reason: "PROVIDER_FILL_TIME_INVALID" };
  const entryIdentity = evidence.entryIdentity;
  const isInLifecycle = (fill: ProviderLifecycleFill): boolean => {
    const timestamp = validTimestamp(fill.createdAt)!;
    const isEntrySkew = fill.tradeSide === "open" && entryIdentity?.providerOrderId === fill.providerOrderId
      && entryIdentity.clientOid === fill.clientOid && isNearTimestamp(fill.createdAt, openingTime);
    const inLifecycle = timestamp >= openingMs && (closingMs === null || timestamp <= closingMs);
    return isEntrySkew || inLifecycle;
  };
  if (sameSymbolFills.some((fill) => (fill.positionSide === null || (fill.positionSide !== "LONG" && fill.positionSide !== "SHORT")) && isInLifecycle(fill))) {
    return { ok: false, classification: "UNRESOLVED", reason: "LIFECYCLE_FILL_POSITION_SIDE_MISSING" };
  }
  const samePositionFills = sameSymbolFills.filter((fill) => fill.positionSide === side);
  const fills = samePositionFills.filter(isInLifecycle);
  if (fills.some((fill) => fill.origin === "PROVIDER_EXTERNAL")) return { ok: false, classification: "PROVIDER_EXTERNAL", reason: "PROVIDER_EXTERNAL_QUANTITY_CHANGE_IN_LIFECYCLE" };
  if (fills.some((fill) => fill.origin !== "DARWIN")) return { ok: false, classification: "UNRESOLVED", reason: "LIFECYCLE_FILL_ORIGIN_UNATTRIBUTED" };
  if (fills.some((fill) => fill.tradeSide !== "open" && fill.tradeSide !== "close")) return { ok: false, classification: "UNRESOLVED", reason: "LIFECYCLE_FILL_TRADE_SIDE_UNKNOWN" };
  if (fills.some((fill) => !isPositiveDecimal(fill.quantity))) return { ok: false, classification: "CONTRADICTORY", reason: "LIFECYCLE_FILL_QUANTITY_INVALID" };
  if (fills.some((fill) => !orderForFill(fill, evidence.orders))) return { ok: false, classification: "UNRESOLVED", reason: "LIFECYCLE_FILL_ORDER_IDENTITY_UNPROVEN" };
  const openingFills = fills.filter((fill) => fill.tradeSide === "open");
  const closingFills = fills.filter((fill) => fill.tradeSide === "close");
  if (!openingFills.length) return { ok: false, classification: "UNRESOLVED", reason: "LIFECYCLE_OPENING_FILLS_MISSING" };
  const openQuantity = exactSum(openingFills.map((fill) => fill.quantity));
  const closeQuantity = exactSum(closingFills.map((fill) => fill.quantity));
  if (openQuantity === null || closeQuantity === null) return { ok: false, classification: "CONTRADICTORY", reason: "LIFECYCLE_FILL_QUANTITY_INVALID" };
  let remainingQuantity: string;
  try {
    remainingQuantity = subtractDecimal(openQuantity, closeQuantity);
  } catch {
    return { ok: false, classification: "CONTRADICTORY", reason: "LIFECYCLE_FILL_QUANTITY_INVALID" };
  }
  if (compareDecimal(remainingQuantity, "0") < 0) return { ok: false, classification: "CONTRADICTORY", reason: "LIFECYCLE_CLOSE_EXCEEDS_OPEN_QUANTITY" };
  return { ok: true, openingFills, closingFills, openQuantity, closeQuantity, remainingQuantity };
}

function verifyProviderQuantityTotals(
  reconstruction: Extract<LifecycleFillReconstruction, { ok: true }>,
  expectedOpenQuantity: string | null,
  expectedCloseQuantity: string | null,
): ProviderLifecycleResult | null {
  if (expectedOpenQuantity !== null && (!isPositiveDecimal(expectedOpenQuantity) || compareDecimal(reconstruction.openQuantity, expectedOpenQuantity) !== 0)) {
    return result("CONTRADICTORY", "OPENING_FILL_QUANTITY_RESIDUAL", reconstruction.openQuantity);
  }
  if (expectedCloseQuantity !== null && (!isDecimal(expectedCloseQuantity) || compareDecimal(expectedCloseQuantity, "0") < 0 || compareDecimal(reconstruction.closeQuantity, expectedCloseQuantity) !== 0)) {
    return result("CONTRADICTORY", "CLOSING_FILL_QUANTITY_RESIDUAL", reconstruction.closeQuantity);
  }
  return null;
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
    if (current.length === 1 && experience.outcomeStatus !== "OPEN") {
      const positionFills = evidence.fills.filter((fill) => fill.symbol === current[0]!.symbol && fill.positionSide === current[0]!.positionSide);
      if (positionFills.some((fill) => fill.origin === "PROVIDER_EXTERNAL")) return result("PROVIDER_EXTERNAL", "CURRENT_POSITION_ATTRIBUTED_EXTERNAL");
      if (positionFills.some((fill) => fill.origin === "DARWIN" && orderForFill(fill, evidence.orders))) {
        return result("PROVIDER_POSITION_WITHOUT_LOCAL_LIFECYCLE", "CURRENT_POSITION_HAS_PROVIDER_LEDGER_IDENTITY");
      }
    }
    if (current.length === 1 && experience.outcomeStatus === "OPEN") {
      const position = current[0]!;
      if (!position.openedAt) return result("UNRESOLVED", "CURRENT_POSITION_OPEN_TIME_MISSING");
      const reconstruction = reconstructProviderLifecycleFills(evidence, position.openedAt);
      if (!reconstruction.ok) return result(reconstruction.classification, reconstruction.reason);
      if (!openingIdentityIsProven(evidence, position.openedAt)) return result("UNRESOLVED", "CURRENT_POSITION_ENTRY_IDENTITY_UNPROVEN");
      if (!position.entryPrice || !isPositiveDecimal(position.entryPrice)) return result("UNRESOLVED", "CURRENT_POSITION_ENTRY_PRICE_MISSING_OR_INVALID");
      if (compareDecimal(reconstruction.remainingQuantity, position.quantity) !== 0) return result("CONTRADICTORY", "CURRENT_POSITION_FILL_QUANTITY_RESIDUAL", reconstruction.remainingQuantity);
      if (!currentPositionEntryMatches([...reconstruction.openingFills, ...reconstruction.closingFills], position.quantity, position.entryPrice)) {
        return result("CONTRADICTORY", "CURRENT_POSITION_COST_BASIS_MISMATCH");
      }
      return result("MATCHED_OPEN", "CURRENT_PROVIDER_POSITION_AND_FULL_FILL_QUANTITY_MATCH");
    }
    return result("UNRESOLVED", "PROVIDER_POSITION_HISTORY_OR_ENTRY_IDENTITY_MISSING");
  }

  if (history.symbol !== experience.symbol || history.positionSide !== side) return result("CONTRADICTORY", "POSITION_HISTORY_IDENTITY_MISMATCH");
  if (history.origin === "PROVIDER_EXTERNAL") return result("PROVIDER_EXTERNAL", "POSITION_HISTORY_ATTRIBUTED_EXTERNAL");
  if (history.origin !== "DARWIN" && history.origin !== "UNATTRIBUTED") return result("UNRESOLVED", "POSITION_HISTORY_ORIGIN_INVALID");
  if (!history.providerPositionHistoryId) return result("UNRESOLVED", "POSITION_HISTORY_ID_MISSING");

  if (current.length === 1) {
    if (experience.outcomeStatus !== "OPEN") return result("CONTRADICTORY", "CURRENT_PROVIDER_POSITION_CONTRADICTS_LOCAL_LIFECYCLE");
    if (!history.openTotalPos || !history.avgEntryPrice) return result("UNRESOLVED", "CURRENT_POSITION_ENTRY_IDENTITY_UNPROVEN");
    if (history.closeTotalPos !== null && (!isDecimal(history.closeTotalPos) || compareDecimal(history.closeTotalPos, "0") < 0)) {
      return result("UNRESOLVED", "CURRENT_POSITION_CLOSE_QUANTITY_INVALID");
    }
    if (history.closeTotalPos && compareDecimal(history.openTotalPos, history.closeTotalPos) === 0
      && isPositiveDecimal(history.closeTotalPos) && validTimestamp(history.closingTime) !== null) {
      return result("CONTRADICTORY", "CURRENT_PROVIDER_POSITION_CONTRADICTS_CLOSED_HISTORY");
    }
    const reconstruction = reconstructProviderLifecycleFills(evidence, history.openingTime);
    if (!reconstruction.ok) return result(reconstruction.classification, reconstruction.reason);
    if (!openingIdentityIsProven(evidence, history.openingTime)) return result("UNRESOLVED", "CURRENT_POSITION_ENTRY_IDENTITY_UNPROVEN");
    const totalsError = verifyProviderQuantityTotals(reconstruction, history.openTotalPos, history.closeTotalPos);
    if (totalsError) return totalsError;
    if (!weightedEntryMatches(reconstruction.openingFills, history.avgEntryPrice)) return result("CONTRADICTORY", "OPENING_FILL_WEIGHTED_PRICE_MISMATCH");
    if (compareDecimal(reconstruction.remainingQuantity, current[0]!.quantity) !== 0) {
      return result("CONTRADICTORY", "CURRENT_PROVIDER_POSITION_FILL_QUANTITY_RESIDUAL", reconstruction.remainingQuantity);
    }
    if (!current[0]!.entryPrice || !isPositiveDecimal(current[0]!.entryPrice)) {
      return result("UNRESOLVED", "CURRENT_POSITION_ENTRY_PRICE_MISSING_OR_INVALID");
    }
    if (!currentPositionEntryMatches([...reconstruction.openingFills, ...reconstruction.closingFills], current[0]!.quantity, current[0]!.entryPrice)) {
      return result("CONTRADICTORY", "CURRENT_POSITION_COST_BASIS_MISMATCH");
    }
    return result("MATCHED_OPEN", "CURRENT_PROVIDER_POSITION_AND_FULL_FILL_QUANTITY_MATCH");
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

  const reconstruction = reconstructProviderLifecycleFills(evidence, history.openingTime, history.closingTime);
  if (!reconstruction.ok) return result(reconstruction.classification, reconstruction.reason);
  if (!openingIdentityIsProven(evidence, history.openingTime)) return result("UNRESOLVED", "DARWIN_OPENING_FILL_IDENTITY_UNPROVEN");
  const totalsError = verifyProviderQuantityTotals(reconstruction, openQuantity, closeQuantity);
  if (totalsError) return totalsError;
  if (!reconstruction.closingFills.length) return result("UNRESOLVED", "DARWIN_CLOSING_FILLS_MISSING");
  if (!history.avgEntryPrice || !weightedEntryMatches(reconstruction.openingFills, history.avgEntryPrice)) {
    return result("CONTRADICTORY", "OPENING_FILL_WEIGHTED_PRICE_MISMATCH");
  }
  if (compareDecimal(reconstruction.remainingQuantity, "0") !== 0) return result("CONTRADICTORY", "POSITION_HISTORY_OPEN_CLOSE_QUANTITY_MISMATCH");
  if (experience.outcomeStatus !== "OPEN") return result("MATCHED_CLOSED", "LOCAL_AND_PROVIDER_LIFECYCLES_CLOSED", reconstruction.closeQuantity);
  return result("LOCAL_OPEN_PROVIDER_CLOSED", "PROVIDER_LEDGER_PROVES_FULL_DARWIN_CLOSE", reconstruction.closeQuantity);
}
