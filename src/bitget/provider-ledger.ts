import { addDecimal, isDecimal } from "../trading/decimal.js";

export type ProviderOrigin = "DARWIN" | "PROVIDER_EXTERNAL" | "UNATTRIBUTED";

export interface ProviderLedgerReadParams {
  category: string;
  symbol?: string;
  startTime?: string;
  endTime?: string;
  limit?: string;
  cursor?: string;
  coin?: string;
  type?: string;
}

export interface ProviderOrderRecord {
  providerOrderId: string;
  clientOid: string | null;
  category: string;
  symbol: string;
  side: string;
  posSide: string | null;
  tradeSide: string | null;
  reduceOnly: string | null;
  orderType: string | null;
  qty: string;
  cumExecQty: string;
  cumExecValue: string | null;
  avgPrice: string | null;
  orderStatus: string;
  feeTotal: string | null;
  feeDetailsJson: string | null;
  createdTime: string;
  updatedTime: string;
  origin: ProviderOrigin;
  rawProviderJson: string;
}

export interface ProviderFillRecord {
  execId: string;
  providerOrderId: string;
  clientOid: string | null;
  category: string;
  symbol: string;
  side: string;
  posSide: string | null;
  tradeSide: string | null;
  execQty: string;
  execPrice: string;
  execValue: string | null;
  execPnl: string | null;
  feeTotal: string | null;
  feeDetailsJson: string | null;
  createdTime: string;
  updatedTime: string | null;
  origin: ProviderOrigin;
  rawProviderJson: string;
}

export interface ProviderPositionHistoryRecord {
  providerPositionHistoryKey: string;
  providerPositionHistoryId: string | null;
  category: string;
  symbol: string;
  positionSide: string;
  openingTime: string;
  closingTime: string;
  avgEntryPrice: string | null;
  avgExitPrice: string | null;
  openTotalPos: string | null;
  closeTotalPos: string | null;
  /** Derived convenience alias of closeTotalPos; not a provider-native authority field. */
  closingQuantity: string;
  cumRealisedPnl: string | null;
  netProfit: string | null;
  /** Derived convenience alias of openTotalPos; not a provider-native authority field. */
  maxPositionSize: string | null;
  closingValue: string | null;
  maxPositionValue: string | null;
  /** Derived convenience alias of netProfit; cumRealisedPnl and netProfit remain separate. */
  positionPnl: string | null;
  positionRoi: string | null;
  openFeeTotal: string | null;
  closeFeeTotal: string | null;
  totalFunding: string | null;
  cashDividend: string | null;
  origin: ProviderOrigin;
  rawProviderJson: string;
}

export interface ProviderFinancialRecord {
  providerRecordKey: string;
  providerRecordId: string | null;
  category: string;
  symbol: string | null;
  type: string;
  positionType: string | null;
  coin: string | null;
  amount: string | null;
  fee: string | null;
  positionAmount: string | null;
  positionBalance: string | null;
  balance: string | null;
  providerTimestamp: string;
  origin: ProviderOrigin;
  rawProviderJson: string;
}

export interface ProviderPage<T = Record<string, unknown>> {
  rows: T[];
  cursor: string | null;
}

export function providerTimestampIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return dateFromMilliseconds(value);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const milliseconds = Number(normalized);
    return Number.isSafeInteger(milliseconds) ? dateFromMilliseconds(milliseconds) : null;
  }
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? dateFromMilliseconds(milliseconds) : null;
}

function dateFromMilliseconds(milliseconds: number): string | null {
  if (milliseconds < 0 || milliseconds > 8_640_000_000_000_000) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

export function stableProviderFingerprint(value: unknown): string {
  const canonical = canonicalJson(value);
  let hash = 1469598103934665603n;
  for (const character of canonical) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `fingerprint:${hash.toString(16).padStart(16, "0")}`;
}

export function normalizeProviderOrder(value: unknown, origin: ProviderOrigin, observedAt: string): ProviderOrderRecord | null {
  const row = asRecord(value);
  const providerOrderId = text(row.orderId);
  const category = text(row.category);
  const createdTime = providerTimestampIso(row.createdTime ?? row.ctime);
  if (!providerOrderId || !category || !createdTime) return null;
  const feeDetailsJson = jsonArray(row.feeDetail);
  return {
    providerOrderId,
    clientOid: nullableText(row.clientOid),
    category,
    symbol: text(row.symbol),
    side: text(row.side),
    posSide: nullableText(row.posSide),
    tradeSide: nullableText(row.tradeSide),
    reduceOnly: nullableText(row.reduceOnly),
    orderType: nullableText(row.orderType),
    qty: decimalText(row.qty ?? row.size) ?? "0",
    cumExecQty: decimalText(row.cumExecQty ?? row.filledQty) ?? "0",
    cumExecValue: decimalText(row.cumExecValue),
    avgPrice: decimalText(row.avgPrice ?? row.priceAvg),
    orderStatus: text(row.orderStatus ?? row.status),
    feeTotal: providerFeeTotal(row, feeDetailsJson),
    feeDetailsJson,
    createdTime,
    updatedTime: providerTimestampIso(row.updatedTime ?? row.utime) ?? createdTime,
    origin,
    rawProviderJson: rawJson(row),
  };
}

export function normalizeProviderFill(value: unknown, origin: ProviderOrigin, observedAt: string): ProviderFillRecord | null {
  const row = asRecord(value);
  const execId = text(row.execId ?? row.execLinkId);
  const providerOrderId = text(row.orderId);
  const category = text(row.category);
  const createdTime = providerTimestampIso(row.createdTime);
  if (!execId || !providerOrderId || !category || !createdTime) return null;
  const feeDetailsJson = jsonArray(row.feeDetail);
  return {
    execId,
    providerOrderId,
    clientOid: nullableText(row.clientOid),
    category,
    symbol: text(row.symbol),
    side: text(row.side),
    posSide: nullableText(row.posSide),
    tradeSide: nullableText(row.tradeSide),
    execQty: decimalText(row.execQty) ?? "0",
    execPrice: decimalText(row.execPrice) ?? "0",
    execValue: decimalText(row.execValue),
    execPnl: decimalText(row.execPnl),
    feeTotal: providerFeeTotal(row, feeDetailsJson),
    feeDetailsJson,
    createdTime,
    updatedTime: providerTimestampIso(row.updatedTime) ?? null,
    origin,
    rawProviderJson: rawJson(row),
  };
}

export function normalizeProviderPositionHistory(value: unknown, observedAt: string, origin: ProviderOrigin = "UNATTRIBUTED"): ProviderPositionHistoryRecord | null {
  const row = asRecord(value);
  const category = text(row.category);
  const symbol = text(row.symbol);
  const positionSide = text(row.posSide ?? row.positionSide ?? row.holdSide).toUpperCase();
  const openingTime = providerTimestampIso(row.openTime ?? row.openingTime ?? row.createdTime ?? row.ctime);
  const closingTime = providerTimestampIso(row.closeTime ?? row.closingTime ?? row.updatedTime ?? row.utime);
  if (!category || !symbol || !positionSide || !openingTime || !closingTime) return null;
  const providerPositionHistoryId = nullableText(row.positionId ?? row.id ?? row.posId);
  const key = providerPositionHistoryId ?? stableProviderFingerprint(row);
  return {
    providerPositionHistoryKey: key,
    providerPositionHistoryId,
    category,
    symbol,
    positionSide,
    openingTime: openingTime ?? "",
    closingTime: closingTime ?? "",
    avgEntryPrice: decimalText(row.openPriceAvg ?? row.openAvgPrice ?? row.avgOpenPrice ?? row.entryPrice),
    avgExitPrice: decimalText(row.closePriceAvg ?? row.closeAvgPrice ?? row.avgClosePrice ?? row.exitPrice),
    openTotalPos: decimalText(row.openTotalPos),
    closeTotalPos: decimalText(row.closeTotalPos),
    closingQuantity: decimalText(row.closeTotalPos) ?? "0",
    cumRealisedPnl: decimalText(row.cumRealisedPnl),
    netProfit: decimalText(row.netProfit),
    maxPositionSize: decimalText(row.openTotalPos),
    closingValue: decimalText(row.closePositionValue ?? row.closeValue ?? row.positionValue),
    maxPositionValue: decimalText(row.maxPositionValue),
    positionPnl: decimalText(row.netProfit),
    positionRoi: decimalText(row.roi ?? row.profitRate),
    openFeeTotal: decimalText(row.openFeeTotal ?? row.openFee),
    closeFeeTotal: decimalText(row.closeFeeTotal ?? row.closeFee),
    totalFunding: decimalText(row.totalFunding),
    cashDividend: decimalText(row.cashDividend),
    origin,
    rawProviderJson: rawJson(row),
  };
}

export function normalizeProviderFinancialRecord(value: unknown, observedAt: string, origin: ProviderOrigin = "UNATTRIBUTED"): ProviderFinancialRecord | null {
  const row = asRecord(value);
  const category = text(row.category);
  const type = text(row.type);
  const providerTimestamp = providerTimestampIso(row.ts ?? row.timestamp ?? row.createdTime);
  if (!category || !type || !providerTimestamp) return null;
  const providerRecordId = nullableText(row.id ?? row.recordId ?? row.record_id);
  const providerRecordKey = providerRecordId ? `${category}:${providerRecordId}` : stableProviderFingerprint(row);
  return {
    providerRecordKey,
    providerRecordId,
    category,
    symbol: nullableText(row.symbol),
    type,
    positionType: nullableText(row.positionType),
    coin: nullableText(row.coin),
    amount: decimalText(row.amount),
    fee: decimalText(row.fee),
    positionAmount: decimalText(row.positionAmount),
    positionBalance: decimalText(row.positionBalance),
    balance: decimalText(row.balance),
    providerTimestamp,
    origin,
    rawProviderJson: rawJson(row),
  };
}

export function providerPage(value: unknown): ProviderPage {
  const payload = asRecord(value);
  const nested = asRecord(payload.data);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(payload.list)
      ? payload.list
      : Array.isArray(nested.list)
        ? nested.list
        : Array.isArray(payload.data)
          ? payload.data
          : payload.list === null || nested.list === null
            ? []
            : null;
  if (!source) throw new Error("INVALID_PROVIDER_PAGE");
  const hasExplicitCursor = "cursor" in payload || "cursor" in nested || "nextCursor" in payload || "nextCursor" in nested;
  const explicitCursor = payload.cursor ?? nested.cursor ?? payload.nextCursor ?? nested.nextCursor;
  const lastRow = asRecord(source[source.length - 1]);
  const fallbackCursor = text(lastRow.orderId ?? lastRow.execId ?? lastRow.positionId ?? lastRow.tradeId ?? lastRow.id ?? lastRow.ts);
  return { rows: source.map(asRecord), cursor: hasExplicitCursor ? nullableText(explicitCursor) : nullableText(fallbackCursor) };
}

function providerFeeTotal(row: Record<string, unknown>, feeDetailsJson: string | null): string | null {
  const direct = decimalText(row.fee ?? row.feeAmount ?? row.totalFee);
  if (direct) return direct;
  if (!feeDetailsJson) return null;
  try {
    const details = JSON.parse(feeDetailsJson) as unknown[];
    const values = details.map((detail) => decimalText(asRecord(detail).fee)).filter((value): value is string => Boolean(value));
    return values.reduce((total, value) => isDecimal(total) ? addDecimal(total, value) : value, "0");
  } catch {
    return null;
  }
}

function decimalText(value: unknown): string | null {
  const candidate = text(value);
  return /^[+-]?\d+(?:\.\d+)?$/.test(candidate) ? candidate : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function nullableText(value: unknown): string | null {
  const result = text(value);
  return result ? result : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonArray(value: unknown): string | null {
  return Array.isArray(value) ? JSON.stringify(value) : null;
}

function rawJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
