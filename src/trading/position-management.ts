import type { SqlExecutor } from "../storage/schema.js";
import { loadPositionContext } from "../storage/store.js";
import { providerLivePositionLifecycleKey } from "../storage/provider-ledger.js";
import { resolveLifecycleExperience, type ProviderLiveIdentity } from "../agent/provider-live-lifecycle.js";
import type { Action, MaximumFavorableExcursionBasis, PositionManagementState, PositionSide, PositionSnapshot, PositionContext, TradeExperience, TradingJournal } from "../types.js";

/**
 * A persisted PositionContext may only describe a lifecycle when symbol, side,
 * entry decision, experience, and lifecycle status all agree.
 */
export function positionContextMatchesLifecycle(context: PositionContext | null, experience: TradeExperience): boolean {
  return Boolean(context
    && context.symbol === experience.symbol
    && context.positionSide === experience.positionSide
    && context.experienceId === experience.experienceId
    && context.entryDecisionId === experience.entryDecisionId
    && (context.lifecycleStatus === undefined || context.lifecycleStatus === "OPEN"));
}

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

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
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

/**
 * Reconstruct only provider-backed market observations recorded while the
 * matching provider position was open. Returns null when none exists.
 */
export function reconstructMaximumFavorableReturnPct(
  position: Pick<PositionSnapshot, "symbol" | "positionSide">,
  experience: TradeExperience,
  journals: readonly TradingJournal[],
): number | null {
  const entryTime = Date.parse(experience.entryTime);
  if (!Number.isFinite(entryTime)) return null;
  let peak: number | null = null;
  for (const journal of [...journals].sort((left, right) => left.startedAt.localeCompare(right.startedAt))) {
    if (journal.mode !== "AUTONOMOUS" || !journal.portfolio || Date.parse(journal.portfolio.observedAt) < entryTime) continue;
    const open = journal.portfolio.positions.some((candidate) => candidate.symbol === position.symbol && candidate.positionSide === position.positionSide && Number(candidate.quantity) > 0);
    if (!open) continue;
    const marketContext = record(journal.marketContext);
    const deep = Array.isArray(marketContext.deep) ? marketContext.deep : [];
    const market = deep.map((candidate) => record(candidate)).map((candidate) => record(candidate.market)).find((candidate) => text(candidate.symbol) === position.symbol);
    const observedAt = text(market?.observedAt);
    const currentPrice = text(market?.lastPrice);
    if (!observedAt || !currentPrice || Date.parse(observedAt) < entryTime) continue;
    const observedReturn = currentReturnPct(experience.entryPrice, currentPrice, position.positionSide);
    peak = peak === null ? Math.max(observedReturn, 0) : Math.max(peak, observedReturn, 0);
  }
  return peak;
}

/**
 * A lifecycle the trading cycle resolved this cycle: current provider-live,
 * deterministically matched to an experience, and backed by a matching
 * PositionContext. Only these may drive a bounded history read.
 */
export interface ResolvedPositionLifecycle {
  symbol: string;
  positionSide: PositionSide;
  experience: TradeExperience;
  /** Earliest provider-live entry time, when deterministically known. */
  entryTime: string | null;
  /** True when this lifecycle has no established excursion basis yet. */
  requiresReconstruction: boolean;
}

/**
 * Resolve the lifecycles the position-management phase acts on this cycle.
 *
 * A lifecycle qualifies only when it is current provider-live with a positive
 * quantity, resolves to exactly one deterministic DARWIN experience, and is
 * backed by a matching PositionContext. Stale historical OPEN experiences that
 * match no live position are structurally excluded, so they can never decide
 * whether the cycle reads history.
 *
 * This is a pure function of persisted state rather than agent state, so the
 * reconstruction gate has exactly one definition shared by the cycle and tests.
 */
export function resolvePositionManagementLifecycles(
  executor: SqlExecutor,
  experiences: readonly TradeExperience[],
  positions: readonly PositionSnapshot[],
  liveIdentities: ReadonlyMap<string, ProviderLiveIdentity> = new Map(),
): ResolvedPositionLifecycle[] {
  const resolved: ResolvedPositionLifecycle[] = [];
  for (const position of positions.filter((candidate) => Number(candidate.quantity) > 0)) {
    // A provider-external management record carries no entry price or entry time, so lifecycle
    // metrics cannot be derived from it. It is excluded here rather than failing the cycle.
    const positionContext = loadPositionContext(executor, position.symbol, position.positionSide);
    const experience = resolveLifecycleExperience(experiences, position, liveIdentities.get(providerLivePositionLifecycleKey(position)));
    if (!experience || !positionContextMatchesLifecycle(positionContext, experience)) continue;
    const entryTime = Date.parse(experience.entryTime);
    resolved.push({
      symbol: position.symbol,
      positionSide: position.positionSide,
      experience,
      entryTime: Number.isFinite(entryTime) ? experience.entryTime : null,
      requiresReconstruction: experience.outcomeStatus === "OPEN" && !experience.maximumFavorableExcursionBasis,
    });
  }
  return resolved;
}

/**
 * Whether the trading cycle must read bounded journal history this cycle.
 *
 * The gate considers only lifecycles that are simultaneously current
 * provider-live, deterministically resolved, and backed by a matching
 * PositionContext. A stale historical OPEN row for the same symbol and side is
 * therefore incapable of forcing a history read, which is what previously made
 * reconstruction repeat forever.
 */
export function positionHistoryReconstructionRequired(
  lifecycles: readonly ResolvedPositionLifecycle[],
): boolean {
  return lifecycles.some((lifecycle) => lifecycle.requiresReconstruction);
}

/**
 * Current provider-live, deterministically resolved, context-matched lifecycles.
 *
 * The bounded read is derived only from these, so unrelated and stale history can
 * never widen the trading cycle's read.
 */
export function positionHistoryRequests(
  lifecycles: readonly ResolvedPositionLifecycle[],
): ResolvedPositionLifecycle[] {
  return lifecycles.filter((lifecycle) => lifecycle.requiresReconstruction);
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
  // Pre-patch OPEN experiences have no trustworthy persisted price series. Their
  // peak is therefore explicitly scoped to the first deterministic observation.
  const maximumFavorableReturnBasis: MaximumFavorableExcursionBasis = experience.maximumFavorableExcursionBasis ?? "SINCE_FIRST_DETERMINISTIC_OBSERVATION";
  const updatedExperience = experience.outcomeStatus === "OPEN" && (maximumFavorableReturn > priorPeak || !experience.maximumFavorableExcursionBasis)
    ? { ...experience, maximumFavorableExcursion: maximumFavorableReturn > priorPeak ? metricText(maximumFavorableReturn) : experience.maximumFavorableExcursion, maximumFavorableExcursionBasis: maximumFavorableReturnBasis }
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
      maximumFavorableReturnBasis,
      profitGivebackPct: profitGivebackPct(maximumFavorableReturn, currentReturn),
      timeInTradeMinutes,
      priorManagementActions,
    },
    experience: updatedExperience,
  };
}
