import type { Decision, EvidenceBundle, Instrument, PositionSnapshot } from "../types.js";
import { isDecimal } from "./decimal.js";

export interface ExecutionAmounts {
  marginAllocated: string;
  leverage: string;
  fullNotional: string;
  fullQuantity: string;
  reductionPct: string | null;
  positionNotional: string;
  quantity: string;
}

export type ProviderQuantityCode = "MIN_ORDER_QTY" | "MAX_ORDER_QTY" | "INVALID_ORDER_QUANTITY" | "MIN_ORDER_AMOUNT";

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

function compareDecimal(left: string, right: string): number {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftInteger = leftParts.integer * 10n ** BigInt(scale - leftParts.scale);
  const rightInteger = rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return leftInteger === rightInteger ? 0 : leftInteger > rightInteger ? 1 : -1;
}

function multiplyDecimal(left: string, right: string): string {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  return decimalText(leftParts.integer * rightParts.integer, leftParts.scale + rightParts.scale);
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

function percentage(value: string, percentageValue: string): string {
  const scaledValue = decimalParts(value);
  const scaledPercentage = decimalParts(percentageValue);
  return decimalText(scaledValue.integer * scaledPercentage.integer, scaledValue.scale + scaledPercentage.scale + 2);
}

function isOpening(action: Decision["action"]): boolean {
  return action === "OPEN_LONG" || action === "OPEN_SHORT" || action === "INCREASE";
}

function findPosition(bundle: EvidenceBundle, decision: Decision): PositionSnapshot | undefined {
  return decision.positionSide
    ? bundle.account.positions.find((position) => position.symbol === decision.symbol && position.positionSide === decision.positionSide)
    : undefined;
}

export function calculateExecutionAmounts(decision: Decision, bundle: EvidenceBundle): ExecutionAmounts {
  if (decision.action === "HOLD") throw new Error("HOLD_NOT_EXECUTABLE");
  if (decision.action === "REVERSE") throw new Error("REVERSE_NOT_EXPANDED");
  const current = findPosition(bundle, decision);
  if (decision.action === "INCREASE" && !current) throw new Error("POSITION_NOT_OPEN");
  if (decision.action === "INCREASE" && (!decision.additionalMarginPct || compareDecimal(decision.additionalMarginPct, "0") <= 0)) throw new Error("INVALID_ADDITIONAL_MARGIN");
  const opening = isOpening(decision.action);
  const marginAllocated = decision.action === "INCREASE"
    ? percentage(bundle.account.portfolioEquity, decision.additionalMarginPct ?? "0")
    : opening
      ? percentage(bundle.account.portfolioEquity, decision.marginAllocationPct)
      : current?.marginAllocated ?? "0";
  const leverage = decision.action === "INCREASE" ? current?.leverage ?? "1" : opening ? decision.leverage : current?.leverage ?? "1";
  const fullNotional = opening ? multiplyDecimal(marginAllocated, leverage) : current?.notional ?? "0";
  const fullQuantity = opening ? divideDecimal(fullNotional, bundle.market.lastPrice, bundle.instrument.quantityPrecision) : current?.quantity ?? "0";
  const reductionPct = decision.action === "REDUCE" ? decision.reductionPct : decision.action === "CLOSE" ? "100" : null;
  const positionNotional = reductionPct ? percentage(fullNotional, reductionPct) : fullNotional;
  const quantity = reductionPct ? percentage(fullQuantity, reductionPct) : fullQuantity;
  return { marginAllocated: reductionPct ? percentage(marginAllocated, reductionPct) : marginAllocated, leverage, fullNotional, fullQuantity, reductionPct, positionNotional, quantity };
}

function isMultiple(value: string, step: string): boolean {
  const valueParts = decimalParts(value);
  const stepParts = decimalParts(step);
  const scale = Math.max(valueParts.scale, stepParts.scale);
  const valueInteger = valueParts.integer * 10n ** BigInt(scale - valueParts.scale);
  const stepInteger = stepParts.integer * 10n ** BigInt(scale - stepParts.scale);
  return stepInteger > 0n && valueInteger % stepInteger === 0n;
}

function addCode(codes: ProviderQuantityCode[], code: ProviderQuantityCode): void {
  if (!codes.includes(code)) codes.push(code);
}

export function effectiveMaxOrderQuantity(instrument: Instrument): string {
  if (!isDecimal(instrument.maxOrderQty) || !isDecimal(instrument.quantityStep) || compareDecimal(instrument.quantityStep, "0") <= 0) return instrument.maxOrderQty;
  const max = decimalParts(instrument.maxOrderQty);
  const step = decimalParts(instrument.quantityStep);
  const scale = Math.max(max.scale, step.scale);
  const maxInteger = max.integer * 10n ** BigInt(scale - max.scale);
  const stepInteger = step.integer * 10n ** BigInt(scale - step.scale);
  return decimalText((maxInteger / stepInteger) * stepInteger, scale);
}

export function providerQuantityCodes(quantity: string, instrument: Instrument, marketPrice: string): ProviderQuantityCode[] {
  const codes: ProviderQuantityCode[] = [];
  try {
    if (!isDecimal(quantity) || quantity.startsWith("-")) {
      addCode(codes, "INVALID_ORDER_QUANTITY");
      return codes;
    }
    const parts = decimalParts(quantity);
    if (parts.integer <= 0n || parts.scale > instrument.quantityPrecision) addCode(codes, "INVALID_ORDER_QUANTITY");
    if (isDecimal(instrument.minOrderQty) && compareDecimal(quantity, instrument.minOrderQty) < 0) addCode(codes, "MIN_ORDER_QTY");
    if (isDecimal(instrument.maxOrderQty) && compareDecimal(quantity, instrument.maxOrderQty) > 0) addCode(codes, "MAX_ORDER_QTY");
    if (isDecimal(instrument.quantityStep) && compareDecimal(instrument.quantityStep, "0") > 0 && !isMultiple(quantity, instrument.quantityStep)) addCode(codes, "INVALID_ORDER_QUANTITY");
    if (isDecimal(instrument.minOrderAmount) && isDecimal(marketPrice) && compareDecimal(multiplyDecimal(quantity, marketPrice), instrument.minOrderAmount) < 0) addCode(codes, "MIN_ORDER_AMOUNT");
  } catch {
    addCode(codes, "INVALID_ORDER_QUANTITY");
  }
  return codes;
}
