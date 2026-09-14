import type { ExecutionCapacityHint, EvidenceBundle, Instrument } from "../types.js";
import { effectiveMaxOrderQuantity } from "./order-quantity.js";

interface DecimalValue { integer: bigint; scale: number }

function decimalParts(value: string): DecimalValue {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match?.[1]) throw new Error("INVALID_DECIMAL");
  return { integer: BigInt(`${match[1]}${match[2] ?? ""}`), scale: match[2]?.length ?? 0 };
}

function decimalText(integer: bigint, scale: number): string {
  const text = integer.toString().padStart(scale + 1, "0");
  if (scale === 0) return text;
  const fraction = text.slice(-scale).replace(/0+$/, "");
  return fraction ? `${text.slice(0, -scale)}.${fraction}` : text.slice(0, -scale);
}

function multiplyDecimal(left: string, right: string): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  return decimalText(a.integer * b.integer, a.scale + b.scale);
}

function divideFloor(numerator: string, denominator: string, scale: number): string {
  const a = decimalParts(numerator);
  const b = decimalParts(denominator);
  if (b.integer <= 0n) throw new Error("INVALID_DECIMAL_DIVISOR");
  const exponent = scale + b.scale - a.scale;
  const scaledNumerator = exponent >= 0 ? a.integer * 10n ** BigInt(exponent) : a.integer / 10n ** BigInt(-exponent);
  return decimalText(scaledNumerator / b.integer, scale);
}

function floorInteger(value: string): bigint {
  const parsed = decimalParts(value);
  return parsed.integer / 10n ** BigInt(parsed.scale);
}

function ceilInteger(value: string): bigint {
  const parsed = decimalParts(value);
  const unit = 10n ** BigInt(parsed.scale);
  return (parsed.integer + unit - 1n) / unit;
}

function maxSupportedLeverage(instrument: Instrument, ownerMaxLeverage: string): { first: bigint; last: bigint } {
  const first = ceilInteger(instrument.leverageMin);
  const last = [floorInteger(instrument.leverageMax), floorInteger(ownerMaxLeverage)].reduce((lowest, value) => value < lowest ? value : lowest);
  return { first, last };
}

export function buildExecutionCapacityHint(bundle: Pick<EvidenceBundle, "market" | "account" | "instrument">, ownerMaxLeverage: string): ExecutionCapacityHint {
  const { market, account, instrument } = bundle;
  const maxOrderQty = effectiveMaxOrderQuantity(instrument);
  const maxExecutableNotional = multiplyDecimal(maxOrderQty, market.lastPrice);
  const maxMarginAllocationPctByLeverage: Record<string, string> = {};
  const leverage = maxSupportedLeverage(instrument, ownerMaxLeverage);
  for (let value = leverage.first; value <= leverage.last; value += 1n) {
    maxMarginAllocationPctByLeverage[value.toString()] = divideFloor(multiplyDecimal(maxExecutableNotional, "100"), multiplyDecimal(account.portfolioEquity, value.toString()), 4);
  }
  return {
    symbol: instrument.symbol,
    minOrderQty: instrument.minOrderQty,
    maxOrderQty: maxOrderQty,
    minOrderAmount: instrument.minOrderAmount,
    quantityStep: instrument.quantityStep,
    lastPrice: market.lastPrice,
    maxExecutableNotional,
    maxMarginAllocationPctByLeverage,
  };
}

export function buildExecutionCapacityHints(bundles: readonly Pick<EvidenceBundle, "market" | "account" | "instrument">[], ownerMaxLeverage: string): ExecutionCapacityHint[] {
  return bundles.map((bundle) => buildExecutionCapacityHint(bundle, ownerMaxLeverage));
}

export function calculatedCapacityQuantity(bundle: Pick<EvidenceBundle, "market" | "account" | "instrument">, marginAllocationPct: string, leverage: string): string {
  return divideFloor(multiplyDecimal(multiplyDecimal(bundle.account.portfolioEquity, marginAllocationPct), leverage), multiplyDecimal(bundle.market.lastPrice, "100"), bundle.instrument.quantityPrecision);
}
