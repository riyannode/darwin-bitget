import type { Action, PositionManagementState, PositionSide, PositionSnapshot, PositionContext, TradeExperience } from "../types.js";

const METRIC_DECIMAL_PLACES = 8;
const MAX_PRIOR_MANAGEMENT_ACTIONS = 5;

function roundedMetric(value: number): number {
  return Number(value.toFixed(METRIC_DECIMAL_PLACES));
}

function metricText(value: number): string {
  return roundedMetric(value).toString();
}

function positivePrice(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`INVALID_POSITION_MANAGEMENT_${field}`);
  return parsed;
}

export function currentReturnPct(entryPrice: string, currentPrice: string, positionSide: PositionSide): number {
  const entry = positivePrice(entryPrice, "ENTRY_PRICE");
  const current = positivePrice(currentPrice, "CURRENT_PRICE");
  const raw = positionSide === "LONG"
    ? (current - entry) / entry * 100
    : (entry - current) / entry * 100;
  return roundedMetric(raw);
}

export function profitGivebackPct(maximumFavorableReturnPct: number, currentReturn: number): number {
  if (maximumFavorableReturnPct <= 0) return 0;
  const raw = (maximumFavorableReturnPct - Math.max(currentReturn, 0)) / maximumFavorableReturnPct * 100;
  return roundedMetric(Math.min(100, Math.max(0, raw)));
}

export function buildPositionManagementState(
  position: Pick<PositionSnapshot, "symbol" | "positionSide">,
  experience: TradeExperience,
  currentPrice: string,
  observedAt: string,
  positionContext?: Pick<PositionContext, "managementEvents"> | null,
): { state: PositionManagementState; experience: TradeExperience } {
  const currentReturn = currentReturnPct(experience.entryPrice, currentPrice, position.positionSide);
  const persistedPeak = Number(experience.maximumFavorableExcursion);
  const priorPeak = Number.isFinite(persistedPeak) && persistedPeak > 0 ? roundedMetric(persistedPeak) : 0;
  const maximumFavorableReturn = roundedMetric(Math.max(priorPeak, currentReturn, 0));
  const updatedExperience = maximumFavorableReturn > priorPeak
    ? { ...experience, maximumFavorableExcursion: metricText(maximumFavorableReturn) }
    : experience;
  const entryTime = Date.parse(experience.entryTime);
  const observedTime = Date.parse(observedAt);
  const timeInTradeMinutes = Number.isFinite(entryTime) && Number.isFinite(observedTime)
    ? roundedMetric(Math.max(0, observedTime - entryTime) / 60_000)
    : 0;
  const priorManagementActions: Action[] = (positionContext?.managementEvents ?? [])
    .slice(-MAX_PRIOR_MANAGEMENT_ACTIONS)
    .map((event) => event.action);
  return {
    state: {
      symbol: position.symbol,
      positionSide: position.positionSide,
      entryPrice: experience.entryPrice,
      currentPrice,
      currentReturnPct: currentReturn,
      maximumFavorableReturnPct: maximumFavorableReturn,
      profitGivebackPct: profitGivebackPct(maximumFavorableReturn, currentReturn),
      timeInTradeMinutes,
      priorManagementActions,
    },
    experience: updatedExperience,
  };
}
