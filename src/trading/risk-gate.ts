import type { AccountSnapshot, Decision, Instrument, MarketSnapshot, RiskGateResult, RuntimeConfig } from "../types.js";
import { calculateExecutionAmounts, providerQuantityCodes } from "./order-quantity.js";

const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);

function scaled(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value.trim());
  if (!match?.[1]) throw new Error("INVALID_DECIMAL");
  return BigInt(match[1]) * UNIT + BigInt((match[2] ?? "").padEnd(SCALE, "0"));
}

function decimalText(value: bigint): string {
  const text = value.toString().padStart(SCALE + 1, "0");
  const fraction = text.slice(-SCALE).replace(/0+$/, "");
  return fraction ? `${text.slice(0, -SCALE)}.${fraction}` : text.slice(0, -SCALE);
}

function multiply(left: string, right: string): string {
  const product = scaled(left) * scaled(right);
  return decimalText(product / UNIT);
}

function percentageOf(value: string, percentage: string): string {
  return decimalText((scaled(value) * scaled(percentage)) / (100n * UNIT));
}

function add(left: string, right: string): string {
  return decimalText(scaled(left) + scaled(right));
}

function compare(left: string, right: string): number {
  const difference = scaled(left) - scaled(right);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

function isFresh(observedAt: string, maxAgeSeconds: number, now: Date): boolean {
  const age = now.getTime() - new Date(observedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeSeconds * 1000;
}

function position(account: AccountSnapshot, symbol: string, side: "LONG" | "SHORT") {
  return account.positions.find((candidate) => candidate.symbol === symbol && candidate.positionSide === side);
}

function addCode(codes: string[], code: string): void {
  if (!codes.includes(code)) codes.push(code);
}

function addProviderQuantityCodes(decision: Decision, context: RiskContext, codes: string[]): void {
  if (decision.action === "REVERSE") return;
  try {
    const amounts = calculateExecutionAmounts(decision, {
      market: context.market,
      account: context.account,
      instrument: context.instrument,
      evidence: [],
    });
    for (const code of providerQuantityCodes(amounts.quantity, context.instrument, context.market.lastPrice)) addCode(codes, code);
  } catch {
    addCode(codes, "INVALID_ORDER_QUANTITY");
  }
}

export interface RiskContext {
  decision: Decision;
  instrument: Instrument;
  account: AccountSnapshot;
  market: MarketSnapshot;
  evidenceObservedAt: string;
  openOrderSymbols: string[];
  supportedUniverse: readonly string[];
  emergencyStop: boolean;
  dailyDrawdownBlocked: boolean;
  now?: Date;
}

export function evaluateRiskGate(config: RuntimeConfig, context: RiskContext): RiskGateResult {
  const now = context.now ?? new Date();
  const codes: string[] = [];
  const { decision, instrument, account } = context;

  if (context.emergencyStop) addCode(codes, "EMERGENCY_STOP");
  if (!config.ownerPolicy.paperOnly) addCode(codes, "PAPER_ONLY");
  const managesPosition = ["CLOSE", "REDUCE", "HOLD", "INCREASE", "REVERSE"].includes(decision.action)
    && account.positions.some((held) => held.symbol === decision.symbol && (decision.action === "HOLD" || held.positionSide === decision.positionSide));
  if (!context.supportedUniverse.includes(decision.symbol) && !managesPosition) addCode(codes, "SYMBOL_NOT_ALLOWED");
  if (instrument.symbol !== decision.symbol || instrument.status.toLowerCase() !== "online") addCode(codes, "INSTRUMENT_UNAVAILABLE");
  if (!isFresh(context.evidenceObservedAt, config.evidenceMaxAgeSeconds, now)) addCode(codes, "STALE_EVIDENCE");
  if (context.dailyDrawdownBlocked) addCode(codes, "DAILY_DRAWDOWN");
  if (decision.action === "HOLD") return { status: codes.length === 0 ? "PASS" : "BLOCK", codes, checkedAt: now.toISOString() };

  if (context.openOrderSymbols.includes(decision.symbol)) addCode(codes, "DUPLICATE_ORDER");
  if (decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT") {
    validateOpeningDecision(config, context, codes);
  } else if (decision.action === "INCREASE") {
    validateIncreaseDecision(config, context, codes);
  } else if (decision.action === "REVERSE") {
    validateReverseDecision(config, context, codes);
  } else {
    validateClosingDecision(context, codes);
  }
  return { status: codes.length === 0 ? "PASS" : "BLOCK", codes, checkedAt: now.toISOString() };
}

function validateOpeningDecision(config: RuntimeConfig, context: RiskContext, codes: string[]): void {
  const { decision, instrument, account } = context;
  if (!decision.positionSide || (decision.action === "OPEN_LONG" && decision.positionSide !== "LONG") || (decision.action === "OPEN_SHORT" && decision.positionSide !== "SHORT")) addCode(codes, "POSITION_SIDE_REQUIRED");
  let margin: string;
  try {
    margin = percentageOf(account.portfolioEquity, decision.marginAllocationPct);
    if (compare(decision.marginAllocationPct, "0") <= 0) addCode(codes, "INVALID_MARGIN_ALLOCATION");
    const existing = decision.positionSide ? position(account, decision.symbol, decision.positionSide) : undefined;
    const postTradeMargin = add(margin, existing?.marginAllocated ?? "0");
    if (compare(postTradeMargin, percentageOf(account.portfolioEquity, config.ownerPolicy.maxSinglePositionMarginPct)) > 0) addCode(codes, "MAX_SINGLE_POSITION_MARGIN_PCT");
    if (compare(margin, account.availableMargin) > 0) addCode(codes, "INSUFFICIENT_MARGIN");
  } catch {
    margin = "0";
    addCode(codes, "INVALID_MARGIN_ALLOCATION");
  }
  let positionNotional = "0";
  try {
    if (compare(decision.leverage, "0") <= 0) addCode(codes, "INVALID_LEVERAGE");
    if (compare(decision.leverage, config.ownerPolicy.maxLeverage) > 0) addCode(codes, "MAX_LEVERAGE");
    if (compare(decision.leverage, instrument.leverageMin) < 0 || compare(decision.leverage, instrument.leverageMax) > 0) addCode(codes, "PROVIDER_LEVERAGE");
    positionNotional = multiply(margin, decision.leverage);
    if (compare(positionNotional, instrument.minOrderAmount) < 0) addCode(codes, "MIN_ORDER_AMOUNT");
  } catch {
    addCode(codes, "INVALID_LEVERAGE");
  }
  addProviderQuantityCodes(decision, context, codes);
  if (scaled(account.portfolioEquity) <= 0n) addCode(codes, "INVALID_PORTFOLIO_EQUITY");
}

function validateIncreaseDecision(config: RuntimeConfig, context: RiskContext, codes: string[]): void {
  const { decision, instrument, account } = context;
  if (!decision.positionSide) {
    addCode(codes, "POSITION_SIDE_REQUIRED");
    return;
  }
  const current = position(account, decision.symbol, decision.positionSide);
  if (!current || compare(current.quantity, "0") <= 0) {
    addCode(codes, "POSITION_NOT_OPEN");
    return;
  }
  let additionalMargin = "0";
  try {
    if (!decision.additionalMarginPct || compare(decision.additionalMarginPct, "0") <= 0) addCode(codes, "INVALID_ADDITIONAL_MARGIN");
    additionalMargin = percentageOf(account.portfolioEquity, decision.additionalMarginPct ?? "0");
    const postActionMargin = add(current.marginAllocated, additionalMargin);
    if (compare(postActionMargin, percentageOf(account.portfolioEquity, config.ownerPolicy.maxSinglePositionMarginPct)) > 0) addCode(codes, "MAX_SINGLE_POSITION_MARGIN_PCT");
    if (compare(additionalMargin, account.availableMargin) > 0) addCode(codes, "INSUFFICIENT_MARGIN");
  } catch {
    addCode(codes, "INVALID_ADDITIONAL_MARGIN");
  }
  try {
    if (compare(decision.leverage, current.leverage) !== 0) addCode(codes, "LEVERAGE_CHANGE_NOT_ALLOWED");
    if (compare(decision.leverage, config.ownerPolicy.maxLeverage) > 0) addCode(codes, "MAX_LEVERAGE");
    if (compare(current.leverage, config.ownerPolicy.maxLeverage) > 0) addCode(codes, "MAX_LEVERAGE");
    if (compare(current.leverage, instrument.leverageMin) < 0 || compare(current.leverage, instrument.leverageMax) > 0) addCode(codes, "PROVIDER_LEVERAGE");
    if (compare(multiply(additionalMargin, current.leverage), instrument.minOrderAmount) < 0) addCode(codes, "MIN_ORDER_AMOUNT");
  } catch {
    addCode(codes, "INVALID_LEVERAGE");
  }
  try {
    if (scaled(account.portfolioEquity) <= 0n) addCode(codes, "INVALID_PORTFOLIO_EQUITY");
  } catch {
    addCode(codes, "INVALID_PORTFOLIO_EQUITY");
  }
  addProviderQuantityCodes(decision, context, codes);
}

function validateReverseDecision(config: RuntimeConfig, context: RiskContext, codes: string[]): void {
  const { decision, instrument, account } = context;
  if (!decision.positionSide) {
    addCode(codes, "POSITION_SIDE_REQUIRED");
    return;
  }
  const current = position(account, decision.symbol, decision.positionSide);
  if (!current || compare(current.quantity, "0") <= 0) addCode(codes, "POSITION_NOT_OPEN");
  if (!decision.targetPositionSide) addCode(codes, "REVERSE_TARGET_SIDE_REQUIRED");
  if (decision.targetPositionSide === decision.positionSide) addCode(codes, "REVERSE_TARGET_SIDE_NOT_OPPOSITE");
  try {
    if (compare(decision.marginAllocationPct, "0") <= 0) addCode(codes, "INVALID_MARGIN_ALLOCATION");
    const margin = percentageOf(account.portfolioEquity, decision.marginAllocationPct);
    if (compare(margin, account.availableMargin) > 0) addCode(codes, "INSUFFICIENT_MARGIN");
    if (compare(margin, percentageOf(account.portfolioEquity, config.ownerPolicy.maxSinglePositionMarginPct)) > 0) addCode(codes, "MAX_SINGLE_POSITION_MARGIN_PCT");
    if (compare(multiply(margin, decision.leverage), instrument.minOrderAmount) < 0) addCode(codes, "MIN_ORDER_AMOUNT");
  } catch {
    addCode(codes, "INVALID_MARGIN_ALLOCATION");
  }
  try {
    if (compare(decision.leverage, "0") <= 0) addCode(codes, "INVALID_LEVERAGE");
    if (compare(decision.leverage, config.ownerPolicy.maxLeverage) > 0) addCode(codes, "MAX_LEVERAGE");
    if (compare(decision.leverage, instrument.leverageMin) < 0 || compare(decision.leverage, instrument.leverageMax) > 0) addCode(codes, "PROVIDER_LEVERAGE");
  } catch {
    addCode(codes, "INVALID_LEVERAGE");
  }
}

function validateClosingDecision(context: RiskContext, codes: string[]): void {
  const { decision, account, instrument } = context;
  if (!decision.positionSide) {
    addCode(codes, "POSITION_SIDE_REQUIRED");
    return;
  }
  const current = position(account, decision.symbol, decision.positionSide);
  if (!current || compare(current.quantity, "0") <= 0) {
    addCode(codes, "INSUFFICIENT_POSITION");
    return;
  }
  if (decision.action === "REDUCE") {
    if (!decision.reductionPct || compare(decision.reductionPct, "0") <= 0 || compare(decision.reductionPct, "100") >= 0) addCode(codes, "INVALID_REDUCTION_PCT");
    if (decision.reductionPct) {
      const reducedNotional = percentageOf(current.notional, decision.reductionPct);
      if (compare(reducedNotional, instrument.minOrderAmount) < 0) addCode(codes, "MIN_ORDER_AMOUNT");
    }
  }
  addProviderQuantityCodes(decision, context, codes);
}

export function marginAllocation(account: AccountSnapshot, marginAllocationPct: string): string {
  return percentageOf(account.portfolioEquity, marginAllocationPct);
}

export function leveragedNotional(margin: string, leverage: string): string {
  return multiply(margin, leverage);
}
