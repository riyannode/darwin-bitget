import type { AccountSnapshot, HistoricalBar, Instrument, MarketSnapshot, PositionSide, PositionSnapshot } from "../types.js";

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
    maxOrderQty: text(entry.maxOrderQty),
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
      return {
        symbol,
        positionSide: side,
        quantity,
        notional,
        marginAllocated: text(entry.margin, text(entry.marginSize, "0")),
        leverage: text(entry.leverage, "1"),
        entryPrice: text(entry.openPriceAvg, text(entry.averageOpenPrice, "0")),
        unrealizedPnl: text(entry.unrealizedPnl, text(entry.unrealizedPL, text(entry.upl, "0"))),
        realizedPnl: text(entry.realizedPnl, text(entry.achievedProfits, "0")),
        ...(text(entry.ctime, text(entry.openTime)) ? { openedAt: text(entry.ctime, text(entry.openTime)) } : {}),
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
    realizedPnl: text(account.realizedPnl, "0"),
    unrealizedPnl: positions.reduce((total, position) => addDecimal(total, position.unrealizedPnl), "0"),
    openOrders: openOrders.length,
    openOrderSymbols: openOrders.map((entry) => text(entry.symbol)).filter(Boolean),
    observedAt,
  };
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
  fees?: string;
}

export interface PositionHistorySummary {
  averageClosePrice?: string;
  realizedPnl?: string;
  fees?: string;
  funding?: string;
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
    ...(pnl.length > 0 ? { realizedPnl: sumSignedDecimals(pnl) } : {}),
    ...(fees.length > 0 ? { fees: sumSignedDecimals(fees) } : {}),
  };
}

export function parsePositionHistorySummary(value: unknown): PositionHistorySummary {
  const payload = record(value);
  const container = Array.isArray(payload.list) ? payload.list : [];
  const rows = records(container);
  const row = rows[0];
  if (!row) return {};
  const fees = [text(row.openFee), text(row.closeFee)].filter(Boolean);
  return {
    ...(text(row.closeAvgPrice) ? { averageClosePrice: text(row.closeAvgPrice) } : {}),
    ...(text(row.pnl) ? { realizedPnl: text(row.pnl) } : {}),
    ...(fees.length > 0 ? { fees: sumSignedDecimals(fees) } : {}),
    ...(text(row.totalFunding) ? { funding: text(row.totalFunding) } : {}),
  };
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
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
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
