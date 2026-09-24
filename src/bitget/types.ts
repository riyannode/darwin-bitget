import type { AccountSnapshot, HistoricalBar, Instrument, MarketSnapshot, PositionSide, PositionSnapshot } from "../types.js";
import { providerTimestampIso } from "./provider-ledger.js";

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_PROVIDER_RESPONSE");
  return value as Record<string, unknown>;
}

export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("INVALID_PROVIDER_RESPONSE");
  return value.map(record);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function parseInstruments(value: unknown): Instrument[] {
  return records(value).map((entry) => ({
    symbol: text(entry.symbol),
    category: text(entry.category),
    baseCoin: text(entry.baseCoin),
    quoteCoin: text(entry.quoteCoin),
    marginCoin: text(entry.marginCoin, text(entry.quoteCoin)),
    symbolType: text(entry.symbolType),
    isRwa: text(entry.isRwa),
    status: text(entry.status),
    minOrderQty: text(entry.minOrderQty),
    maxOrderQty: text(entry.maxMarketOrderQty, text(entry.maxOrderQty)),
    minOrderAmount: text(entry.minOrderAmount),
    pricePrecision: integer(entry.pricePrecision),
    quantityPrecision: integer(entry.quantityPrecision),
    quantityStep: text(entry.quantityMultiplier, text(entry.sizeMultiplier, text(entry.quantityStep, text(entry.minOrderQty, "0")))),
    leverageMin: text(entry.minLeverage, text(entry.leverageMin, "1")),
    leverageMax: text(entry.maxLeverage, text(entry.leverageMax, "1")),
  }));
}

export function parseTicker(value: unknown, symbol: string, observedAt: string): MarketSnapshot {
  const rows = Array.isArray(value) ? records(value) : [record(value)];
  const entry = rows.find((candidate) => text(candidate.symbol) === symbol) ?? rows[0];
  if (!entry) throw new Error("MISSING_TICKER");
  return {
    symbol,
    lastPrice: text(entry.lastPrice),
    bidPrice: text(entry.bid1Price),
    askPrice: text(entry.ask1Price),
    priceChange24h: text(entry.price24hPcnt),
    volume24h: text(entry.volume24h),
    observedAt,
  };
}

export function parseHistoricalBars(value: unknown): HistoricalBar[] {
  if (!Array.isArray(value)) throw new Error("INVALID_PROVIDER_RESPONSE");
  return value.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const [timestamp, open, high, low, close, volume] = row;
    if ([timestamp, open, high, low, close, volume].some((entry) => typeof entry !== "string" && typeof entry !== "number")) return [];
    return [{ observedAt: new Date(Number(timestamp)).toISOString(), open: String(open), high: String(high), low: String(low), close: String(close), volume: String(volume) }];
  });
}

export function parseAccount(value: unknown, instrument: Instrument, market: MarketSnapshot, observedAt: string): AccountSnapshot {
  const sourceRows = Array.isArray(value) ? records(value) : [];
  const overview = Array.isArray(value) ? {} : record(value);
  const accountRows = Array.isArray(overview.account) ? records(overview.account) : Array.isArray(overview.list) ? records(overview.list) : [];
  const nestedAccount = overview.account && typeof overview.account === "object" && !Array.isArray(overview.account) ? record(overview.account) : undefined;
  const account = accountRows[0] ?? nestedAccount ?? sourceRows[0] ?? overview;
  const assetRows = Array.isArray(value) ? sourceRows : Array.isArray(account.assets) ? records(account.assets) : Array.isArray(overview.assets) ? records(overview.assets) : [];
  const positionPayload = overview.positions;
  const positionRows = Array.isArray(positionPayload) ? records(positionPayload) : positionPayload && typeof positionPayload === "object" && !Array.isArray(positionPayload) && Array.isArray((positionPayload as Record<string, unknown>).list) ? records((positionPayload as Record<string, unknown>).list) : [];
  const positions = positionRows
    .map((entry): PositionSnapshot => {
      const symbol = text(entry.symbol, instrument.symbol);
      const side = text(entry.posSide, text(entry.positionSide, text(entry.holdSide, "LONG"))).toUpperCase() === "SHORT" ? "SHORT" : "LONG";
      const quantity = text(entry.total, text(entry.available, text(entry.quantity, text(entry.size, "0"))));
      const notional = text(entry.notional, symbol === instrument.symbol ? multiplyDecimal(quantity, market.lastPrice) : "0");
      const openedAt = firstTimestamp(entry, ["ctime", "openTime"]);
      return {
        symbol,
        positionSide: side,
        quantity,
        notional,
        marginAllocated: text(entry.margin, text(entry.marginSize, "0")),
        leverage: text(entry.leverage, "1"),
        entryPrice: text(entry.openPriceAvg, text(entry.averageOpenPrice, "0")),
        unrealizedPnl: text(entry.unrealizedPnl, text(entry.unrealizedPL, text(entry.upl, "0"))),
        realizedPnl: text(entry.realizedPnl, text(entry.realizedPL, text(entry.achievedProfits))),
        ...(text(entry.funding, text(entry.fundingFee, text(entry.totalFunding))) ? { funding: text(entry.funding, text(entry.fundingFee, text(entry.totalFunding))) } : {}),
        ...(text(entry.fees, text(entry.fee, text(entry.feeAmount))) ? { fees: text(entry.fees, text(entry.fee, text(entry.feeAmount))) } : {}),
        ...(openedAt ? { openedAt } : {}),
        ...(text(entry.liquidationPrice) ? { liquidationPrice: text(entry.liquidationPrice) } : {}),
      };
    });
  const totalPositionNotional = positions.reduce((total, position) => addDecimal(total, position.notional), "0");
  const accountEquity = Array.isArray(value) ? "" : firstDecimal(account, ["usdtEquity", "accountEquity", "totalEquity", "equity", "balance"]);
  const equity = accountEquity || sumAssetValues(assetRows, ["usdValue", "equity", "balance"]);
  const accountAvailable = Array.isArray(value) ? "" : firstDecimal(account, ["effEquity", "available", "availableMargin", "availableBalance"]);
  const availableMargin = accountAvailable || sumAssetValues(assetRows, ["available", "equity", "balance"]) || equity;
  if (!equity || equity === "0") throw new Error(`INVALID_PORTFOLIO_EQUITY_${Object.keys(account).sort().join("_") || "EMPTY"}`);
  const openOrderPayload = overview.openOrders;
  const openOrders = Array.isArray(openOrderPayload) ? records(openOrderPayload) : openOrderPayload && typeof openOrderPayload === "object" && !Array.isArray(openOrderPayload) && Array.isArray((openOrderPayload as Record<string, unknown>).list) ? records((openOrderPayload as Record<string, unknown>).list) : [];
  const instrumentPosition = positions.find((position) => position.symbol === instrument.symbol);
  const accountRealizedPnl = firstSignedText(account, ["realizedPnl", "realizedPL"]);
  const positionRealizedPnl = positions.map((position) => position.realizedPnl).filter(isSignedDecimal);
  const realizedPnl = accountRealizedPnl || (positionRealizedPnl.length ? sumSignedDecimals(positionRealizedPnl) : "");
  return {
    balance: text(account.balance, equity),
    availableBalance: availableMargin,
    availableMargin,
    marginUsage: subtractDecimal(equity, availableMargin),
    positionNotional: instrumentPosition?.notional ?? "0",
    totalPositionNotional,
    positionQuantity: instrumentPosition?.quantity ?? "0",
    portfolioEquity: equity,
    positions,
    realizedPnl,
    unrealizedPnl: positions.reduce((total, position) => addDecimal(total, position.unrealizedPnl), "0"),
    ...(firstSignedText(account, ["funding", "fundingFee", "totalFunding"]) ? { funding: firstSignedText(account, ["funding", "fundingFee", "totalFunding"]) } : {}),
    ...(firstSignedText(account, ["fees", "fee", "feeAmount", "totalFee"]) ? { fees: firstSignedText(account, ["fees", "fee", "feeAmount", "totalFee"]) } : {}),
    openOrders: openOrders.length,
    openOrderSymbols: openOrders.map((entry) => text(entry.symbol)).filter(Boolean),
    observedAt,
  };
}

export function parseDashboardPortfolio(accountValue: unknown, positionsValue: unknown, openOrdersValue: unknown, observedAt: string): AccountSnapshot {
  const sourceRows = Array.isArray(accountValue) ? records(accountValue) : [];
  const overview = Array.isArray(accountValue) ? {} : record(accountValue);
  const accountRows = Array.isArray(overview.account) ? records(overview.account) : Array.isArray(overview.list) ? records(overview.list) : [];
  const nestedAccount = overview.account && typeof overview.account === "object" && !Array.isArray(overview.account) ? record(overview.account) : undefined;
  const account = accountRows[0] ?? nestedAccount ?? sourceRows[0] ?? overview;
  const assetRows = Array.isArray(accountValue) ? sourceRows : Array.isArray(account.assets) ? records(account.assets) : Array.isArray(overview.assets) ? records(overview.assets) : [];
  const positions = providerRows(positionsValue)
    .map(parseDashboardPosition)
    .filter((position) => hasPositionQuantity(position.quantity));
  const orders = providerRows(openOrdersValue);
  const accountEquity = firstDecimal(account, ["usdtEquity", "accountEquity", "totalEquity", "equity", "balance"]) || sumAssetValues(assetRows, ["usdValue", "equity", "balance"]);
  if (!accountEquity || accountEquity === "0") throw new Error(`INVALID_PORTFOLIO_EQUITY_${Object.keys(account).sort().join("_") || "EMPTY"}`);
  const availableMargin = firstDecimal(account, ["availableMargin", "availableBalance", "available", "effEquity"]) || sumAssetValues(assetRows, ["available", "equity", "balance"]);
  const accountMarginUsed = firstDecimal(account, ["marginUsed", "usedMargin", "occupiedMargin", "occupiedMarginAmount", "totalMargin"]);
  // UTA documents `imr` as an initial-margin amount, not a generic used-margin field.
  const initialMargin = firstDecimal(account, ["imr"]);
  const positionMarginUsage = positions.map((position) => position.marginAllocated).filter(Boolean).reduce((total, margin) => addDecimal(total, margin), "0");
  const marginUsage = accountMarginUsed;
  const providerPositionValue = firstDecimal(account, ["positionValue"]);
  const normalizedPositions: PositionSnapshot[] = positions.map((position) => {
    if (position.notional) return position;
    if (positions.length === 1 && providerPositionValue) return { ...position, notional: providerPositionValue };
    if (position.quantity && position.markPrice) return { ...position, notional: multiplyDecimal(position.quantity, position.markPrice) };
    return position;
  });
  const notionalValues = normalizedPositions.map((position) => position.notional).filter(Boolean);
  const totalPositionNotional = notionalValues.reduce((total, notional) => addDecimal(total, notional), "0");
  const pnlValues = normalizedPositions.map((position) => position.unrealizedPnl).filter(Boolean);
  const unrealizedPnl = pnlValues.length ? sumSignedDecimals(pnlValues) : normalizedPositions.length ? "" : "0";
  return {
    balance: firstText(account, ["balance", "usdtBalance"], accountEquity),
    availableBalance: availableMargin,
    availableMargin,
    marginUsage,
    ...(accountMarginUsed ? { accountMarginUsed } : {}),
    ...(initialMargin ? { initialMargin } : {}),
    ...(positionMarginUsage ? { positionMargin: positionMarginUsage } : {}),
    positionNotional: totalPositionNotional,
    totalPositionNotional,
    positionQuantity: normalizedPositions.reduce((total, position) => addDecimal(total, position.quantity), "0"),
    portfolioEquity: accountEquity,
    positions: normalizedPositions,
    ...(firstSignedText(account, ["realizedPnl", "realizedPL"]) ? { realizedPnl: firstSignedText(account, ["realizedPnl", "realizedPL"]), realizedPnlSource: "ACCOUNT" as const } : { realizedPnl: "" }),
    ...(normalizedPositions.map((position) => position.realizedPnl).filter(isSignedDecimal).length ? { positionRealizedPnl: sumSignedDecimals(normalizedPositions.map((position) => position.realizedPnl).filter(isSignedDecimal)) } : {}),
    unrealizedPnl: firstSignedText(account, ["usdtUnrealisedPnl", "unrealisedPnl", "unrealizedPnl", "unrealizedPL", "totalUnrealizedPL"]) || unrealizedPnl,
    unrealizedPnlSource: firstSignedText(account, ["usdtUnrealisedPnl", "unrealisedPnl", "unrealizedPnl", "unrealizedPL", "totalUnrealizedPL"]) ? "ACCOUNT" : "POSITIONS",
    ...(firstSignedText(account, ["funding", "fundingFee", "totalFunding"]) ? { funding: firstSignedText(account, ["funding", "fundingFee", "totalFunding"]) } : {}),
    ...(firstSignedText(account, ["fees", "fee", "feeAmount", "totalFee"]) ? { fees: firstSignedText(account, ["fees", "fee", "feeAmount", "totalFee"]) } : {}),
    ...(firstSignedText(account, ["cashDividend"]) ? { cashDividend: firstSignedText(account, ["cashDividend"]) } : {}),
    openOrders: orders.length,
    openOrderSymbols: orders.map((entry) => text(entry.symbol)).filter(Boolean),
    observedAt,
  };
}

export function accountForEvidenceSymbol(account: AccountSnapshot, symbol: string): AccountSnapshot {
  const position = account.positions.find((candidate) => candidate.symbol === symbol);
  return {
    ...account,
    positionNotional: position?.notional ?? "0",
    positionQuantity: position?.quantity ?? "0",
  };
}

function providerRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return records(value);
  const payload = record(value);
  if ("list" in payload) return Array.isArray(payload.list) ? records(payload.list) : [];
  if ("data" in payload) return Array.isArray(payload.data) ? records(payload.data) : [];
  return [payload];
}

function parseDashboardPosition(entry: Record<string, unknown>): PositionSnapshot {
  const quantity = firstText(entry, ["total", "available", "quantity", "size"]);
  const markPrice = firstText(entry, ["markPrice", "markPx", "marketPrice", "currentPrice", "lastPrice"]);
  const unrealizedPnlPct = parseProviderProfitRate(entry);
  const openedAt = firstTimestamp(entry, ["ctime", "cTime", "createdTime", "openTime"]);
  const position: PositionSnapshot = {
    symbol: text(entry.symbol),
    positionSide: parsePositionSide(firstText(entry, ["posSide", "positionSide", "holdSide"], "LONG")),
    quantity,
    notional: firstText(entry, ["notional", "positionNotional", "positionValue", "value"]),
    marginAllocated: firstText(entry, ["marginSize", "margin", "marginAllocated", "isolatedMargin", "positionMargin", "positionBalance"]),
    leverage: firstText(entry, ["leverage"], "1"),
    entryPrice: firstText(entry, ["openPriceAvg", "avgPrice", "averageOpenPrice", "entryPrice"]),
    unrealizedPnl: firstText(entry, ["unrealisedPnl", "unrealizedPnl", "unrealizedPL", "upl", "unrealizedProfit"]),
    realizedPnl: firstText(entry, ["curRealisedPnl", "realizedPnl", "realizedPL", "achievedProfits"]),
    ...(firstText(entry, ["curRealisedPnl", "realizedPnl", "realizedPL", "achievedProfits"]) ? { realizedPnlSource: "CURRENT_POSITION" as const } : {}),
    ...(firstText(entry, ["funding", "fundingFee", "totalFunding"]) ? { funding: firstText(entry, ["funding", "fundingFee", "totalFunding"]) } : {}),
    ...(providerFees(entry) ? { fees: providerFees(entry) } : {}),
    ...(firstText(entry, ["cashDividend"]) ? { cashDividend: firstText(entry, ["cashDividend"]) } : {}),
    ...(markPrice ? { markPrice } : {}),
    ...(openedAt ? { openedAt } : {}),
    ...(firstText(entry, ["utime", "uTime", "updatedTime"]) ? { updatedAt: firstText(entry, ["utime", "uTime", "updatedTime"]) } : {}),
    ...(firstText(entry, ["liquidationPrice", "liqPrice"]) ? { liquidationPrice: firstText(entry, ["liquidationPrice", "liqPrice"]) } : {}),
  };
  if (unrealizedPnlPct !== undefined) position.unrealizedPnlPct = unrealizedPnlPct;
  return position;
}

export function normalizeProviderProfitRate(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  // Bitget UTA profitRate is decimal ROI; the dashboard stores percentage points.
  return multiplySignedDecimal(value, "100");
}

function parseProviderProfitRate(entry: Record<string, unknown>): string | undefined {
  const percentage = firstText(entry, ["unrealizedPnlPct", "unrealizedPnlPercent"]);
  if (percentage) return percentage;
  return normalizeProviderProfitRate(firstText(entry, ["unrealizedPLRatio", "unrealizedPLR", "uplRatio", "profitRate"]) || undefined);
}

function firstTimestamp(entry: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const timestamp = providerTimestampIso(entry[key]);
    if (timestamp) return timestamp;
  }
  return undefined;
}

function firstText(entry: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = text(entry[key]);
    if (value) return value;
  }
  return fallback;
}

function firstSignedText(entry: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(entry[key]);
    if (isSignedDecimal(value)) return value;
  }
  return "";
}

function providerFees(entry: Record<string, unknown>): string {
  const components = [text(entry.openFeeTotal), text(entry.closeFeeTotal)].filter(isSignedDecimal);
  if (components.length) return sumSignedDecimals(components);
  return firstSignedText(entry, ["fees", "fee", "feeAmount", "totalFee", "deductedFee"]);
}

function isSignedDecimal(value: string | undefined): value is string {
  return typeof value === "string" && /^[-+]?\d+(?:\.\d+)?$/.test(value.trim());
}

function hasPositionQuantity(value: string): boolean {
  if (!value) return false;
  try {
    return decimalParts(value).integer !== 0n;
  } catch {
    return value !== "0";
  }
}

export function parsePositionSymbols(value: unknown): string[] {
  const container = Array.isArray(value) ? value : record(value).list;
  const rows = Array.isArray(container) ? records(container) : [];
  return rows.map((entry) => text(entry.symbol)).filter((symbol, index) => symbol && text(entryQuantity(rows[index] ?? {}), "0") !== "0");
}

export interface FillSummary {
  averageFillPrice?: string;
  executedQuantity?: string;
  realizedPnl?: string;
  realizedPnlSource?: "FILL";
  realizedPnlIncludesCosts?: boolean;
  fees?: string;
}

export interface PositionHistorySummary {
  averageClosePrice?: string;
  realizedPnl?: string;
  realizedPnlSource?: "POSITION_HISTORY_NET_PROFIT" | "POSITION_HISTORY_PNL";
  realizedPnlIncludesCosts?: boolean;
  fees?: string;
  funding?: string;
  cashDividend?: string;
}

export function parseFillSummary(value: unknown): FillSummary {
  const payload = record(value);
  const container = Array.isArray(payload.list) ? payload.list : Array.isArray(payload.fillList) ? payload.fillList : [];
  const rows = records(container);
  if (rows.length === 0) return {};
  const prices = rows.map((entry) => text(entry.execPrice, text(entry.price))).filter(Boolean);
  const quantities = rows.map((entry) => text(entry.execQty, text(entry.baseVolume))).filter(Boolean);
  const pnl = rows.map((entry) => text(entry.execPnl, text(entry.profit, text(entry.realizedPnl)))).filter(Boolean);
  const fees = rows.flatMap((entry) => {
    const details = Array.isArray(entry.feeDetail) ? entry.feeDetail : [];
    const detailFees = details.flatMap((detail) => {
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return [];
      const value = detail as Record<string, unknown>;
      return [text(value.fee, text(value.totalFee, text(value.totalDeductionFee)))].filter(Boolean);
    });
    return detailFees.length > 0 ? detailFees : [text(entry.fee)].filter(Boolean);
  });
  const averageFillPrice = prices.length === quantities.length && prices.length > 0 ? weightedAverage(prices, quantities) : prices[0];
  return {
    ...(averageFillPrice ? { averageFillPrice } : {}),
    ...(quantities.length > 0 ? { executedQuantity: sumSignedDecimals(quantities) } : {}),
    ...(pnl.length > 0 ? { realizedPnl: sumSignedDecimals(pnl), realizedPnlSource: "FILL" as const, realizedPnlIncludesCosts: false } : {}),
    ...(fees.length > 0 ? { fees: sumSignedDecimals(fees) } : {}),
  };
}

export interface PositionHistoryQuery {
  symbol: string;
  positionSide: PositionSide;
  submittedAt?: string;
}

export function parsePositionHistorySummary(value: unknown, query?: PositionHistoryQuery): PositionHistorySummary {
  const payload = record(value);
  const container = Array.isArray(payload.list) ? payload.list : [];
  const rows = records(container);
  const row = query ? rows.find((candidate) => positionHistoryMatches(candidate, query)) : rows[0];
  if (!row) return {};
  const fees = [text(row.openFeeTotal, text(row.openFee)), text(row.closeFeeTotal, text(row.closeFee))].filter(Boolean);
  const netProfit = text(row.netProfit);
  const grossPnl = text(row.cumRealisedPnl, text(row.pnl));
  return {
    ...(text(row.closeAvgPrice) ? { averageClosePrice: text(row.closeAvgPrice) } : {}),
    ...(netProfit ? { realizedPnl: netProfit, realizedPnlSource: "POSITION_HISTORY_NET_PROFIT" as const, realizedPnlIncludesCosts: true } : grossPnl ? { realizedPnl: grossPnl, realizedPnlSource: "POSITION_HISTORY_PNL" as const, realizedPnlIncludesCosts: false } : {}),
    ...(fees.length > 0 ? { fees: sumSignedDecimals(fees) } : {}),
    ...(text(row.totalFunding) ? { funding: text(row.totalFunding) } : {}),
    ...(text(row.cashDividend) ? { cashDividend: text(row.cashDividend) } : {}),
  };
}

function positionHistoryMatches(row: Record<string, unknown>, query: PositionHistoryQuery): boolean {
  const symbol = text(row.symbol, text(row.instId));
  if (symbol && symbol !== query.symbol) return false;
  const side = text(row.posSide, text(row.holdSide));
  if (side && side.toUpperCase() !== query.positionSide) return false;
  if (!query.submittedAt) return true;
  const updatedAt = text(row.updatedTime, text(row.uTime, text(row.utime)));
  if (!updatedAt) return false;
  const updatedMs = Number(updatedAt);
  const submittedMs = Date.parse(query.submittedAt);
  return Number.isFinite(updatedMs) && Number.isFinite(submittedMs) && updatedMs >= submittedMs;
}

function entryQuantity(entry: Record<string, unknown>): unknown {
  return entry.total ?? entry.available ?? entry.quantity ?? entry.size;
}

function firstDecimal(entry: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(entry[key]);
    if (/^\d+(?:\.\d{1,8})?$/.test(value)) return value;
  }
  return "";
}

function sumAssetValues(rows: readonly Record<string, unknown>[], keys: string[]): string {
  return rows.reduce((total, row) => addDecimal(total, firstDecimal(row, keys) || "0"), "0");
}

function decimalParts(value: string): { integer: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match?.[1]) throw new Error("INVALID_DECIMAL");
  return { integer: BigInt(`${match[1]}${match[2] ?? ""}`), scale: match[2]?.length ?? 0 };
}

function multiplyDecimal(left: string, right: string): string {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = leftParts.scale + rightParts.scale;
  const value = leftParts.integer * rightParts.integer;
  return decimalText(value, scale);
}

function multiplySignedDecimal(left: string, right: string): string {
  const leftParts = signedDecimalParts(left);
  const rightParts = signedDecimalParts(right);
  return signedDecimalText(leftParts.integer * rightParts.integer, leftParts.scale + rightParts.scale);
}

function addDecimal(left: string, right: string): string {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const value = leftParts.integer * 10n ** BigInt(scale - leftParts.scale) + rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return decimalText(value, scale);
}

function subtractDecimal(left: string, right: string): string {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const value = leftParts.integer * 10n ** BigInt(scale - leftParts.scale) - rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return decimalText(value > 0n ? value : 0n, scale);
}

function decimalText(value: bigint, scale: number): string {
  const text = value.toString().padStart(scale + 1, "0");
  if (scale === 0) return text;
  const fraction = text.slice(-scale).replace(/0+$/, "");
  return fraction ? `${text.slice(0, -scale)}.${fraction}` : text.slice(0, -scale);
}

function sumSignedDecimals(values: string[]): string {
  const parts = values.map(signedDecimalParts);
  const scale = Math.max(...parts.map((part) => part.scale));
  const total = parts.reduce((sum, part) => sum + part.integer * 10n ** BigInt(scale - part.scale), 0n);
  return signedDecimalText(total, scale);
}

function weightedAverage(prices: string[], quantities: string[]): string {
  const priceParts = prices.map(signedDecimalParts);
  const quantityParts = quantities.map(signedDecimalParts);
  const priceScale = Math.max(...priceParts.map((part) => part.scale));
  const quantityScale = Math.max(...quantityParts.map((part) => part.scale));
  const totalQuantity = quantityParts.reduce((sum, part) => sum + part.integer * 10n ** BigInt(quantityScale - part.scale), 0n);
  if (totalQuantity <= 0n) return "";
  const totalValue = priceParts.reduce((sum, part, index) => sum + part.integer * 10n ** BigInt(priceScale - part.scale) * (quantityParts[index]?.integer ?? 0n) * 10n ** BigInt(quantityScale - (quantityParts[index]?.scale ?? 0)), 0n);
  const quotient = totalValue * 10n ** 8n / totalQuantity;
  return signedDecimalText(quotient, priceScale + 8);
}

function signedDecimalParts(value: string): { integer: bigint; scale: number } {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match?.[2]) throw new Error("INVALID_DECIMAL");
  const magnitude = BigInt(`${match[2]}${match[3] ?? ""}`);
  return { integer: match[1] === "-" ? -magnitude : magnitude, scale: match[3]?.length ?? 0 };
}

function signedDecimalText(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const text = magnitude.toString().padStart(scale + 1, "0");
  if (scale === 0) return negative ? `-${text}` : text;
  const fraction = text.slice(-scale).replace(/0+$/, "");
  const result = fraction ? `${text.slice(0, -scale)}.${fraction}` : text.slice(0, -scale);
  return negative ? `-${result}` : result;
}

export function parsePositionSide(value: string): PositionSide {
  return value.toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}
