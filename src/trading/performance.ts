import type { AccountSnapshot, TradeExperience, TradingJournal } from "../types.js";
import { cyclePlanDecisions, effectiveExecutionResult, effectiveReconciliationResult, normalizeCycleDecisions } from "../storage/journal-normalizer.js";
import { addDecimal, compareDecimal, isDecimal, isPositiveDecimal, isZeroDecimal, subtractDecimal } from "./decimal.js";

export const PERFORMANCE_READ_MODEL_VERSION = "performance-v2";
export const POSITION_CONTEXT_READ_MODEL_VERSION = "position-context-v2";
export const MAX_PERSISTED_PERFORMANCE_DAYS = 62;
export const ZERO_EXTERNAL_FLOW_INVARIANT = "UNVERIFIED_ZERO_FLOW_INVARIANT";

export interface PerformanceDay {
  openingEquity: string;
  latestEquity: string;
  pnl: string;
  dailyReturnPct: string;
  trades: number;
}

export interface PerformanceAggregate {
  version: string;
  initializedAt: string;
  performanceBaselineAt: string | null;
  competitionBaselineEquity: string | null;
  latestEquity: string | null;
  totalPnl: string;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: string;
  closedTradeRealizedPnl: string;
  partialRealizedPnl: string;
  verifiedRealizedPnl: string;
  dailyPnl: Record<string, PerformanceDay>;
  netExternalInflows?: string;
  externalFlowStatus?: "VERIFIED" | typeof ZERO_EXTERNAL_FLOW_INVARIANT;
  baselineSource?: string;
  baselineInitializationReason?: string;
  latestEquityObservedAt?: string | null;
  peakEquity?: string | null;
  peakEquityObservedAt?: string | null;
  currentDrawdownPct?: string;
  maxDrawdownPct?: string;
}

export interface VerifiedLifecycleFacts {
  verifiedOpenIds: Set<string>;
  verifiedCloseIds: Set<string>;
  verifiedClosedIds: Set<string>;
  realizedPnlByClosedId: Map<string, string>;
}

export interface PerformanceObservation {
  portfolioEquity: string;
  observedAt: string;
  unrealizedPnl?: string;
  unrealizedPnlSource?: "ACCOUNT" | "POSITIONS";
}

export interface PerformanceAccounting {
  baselineEquity: string | null;
  baselineObservedAt: string | null;
  baselineSource: string;
  initializationReason: string;
  currentEquity: string | null;
  currentEquityObservedAt: string | null;
  equityDeltaSinceBaseline: string;
  netExternalInflows: string;
  externalFlowStatus: "VERIFIED" | typeof ZERO_EXTERNAL_FLOW_INVARIANT;
  netPnlSinceBaseline: string;
  closedTradeRealizedPnl: string;
  partialRealizedPnl: string;
  verifiedRealizedPnl: string;
  unrealizedPnl: string;
  unrealizedPnlSource: "ACCOUNT" | "POSITIONS" | "UNAVAILABLE";
  wins: number;
  losses: number;
  breakeven: number;
  classifiedClosedTrades: number;
  winRatePct: string;
  peakEquity: string | null;
  peakEquityObservedAt: string | null;
  currentDrawdownPct: string;
  maxDrawdownPct: string;
  source: "PROVIDER_LIVE" | "PERSISTED_LEDGER" | "UNAVAILABLE";
}

export function isPerformanceAggregate(value: unknown): value is PerformanceAggregate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PerformanceAggregate>;
  return candidate.version === PERFORMANCE_READ_MODEL_VERSION
    && typeof candidate.initializedAt === "string"
    && (candidate.performanceBaselineAt === null || typeof candidate.performanceBaselineAt === "string")
    && (candidate.competitionBaselineEquity === null || typeof candidate.competitionBaselineEquity === "string")
    && (candidate.latestEquity === null || typeof candidate.latestEquity === "string")
    && typeof candidate.totalPnl === "string"
    && typeof candidate.totalTrades === "number"
    && typeof candidate.openTrades === "number"
    && typeof candidate.closedTrades === "number"
    && typeof candidate.wins === "number"
    && typeof candidate.losses === "number"
    && typeof candidate.breakeven === "number"
    && typeof candidate.winRate === "string"
    && typeof candidate.closedTradeRealizedPnl === "string"
    && typeof candidate.partialRealizedPnl === "string"
    && typeof candidate.verifiedRealizedPnl === "string"
    && Boolean(candidate.dailyPnl && typeof candidate.dailyPnl === "object");
}

export function emptyPerformance(initializedAt: string): PerformanceAggregate {
  return {
    version: PERFORMANCE_READ_MODEL_VERSION,
    initializedAt,
    performanceBaselineAt: null,
    competitionBaselineEquity: null,
    latestEquity: null,
    totalPnl: "UNAVAILABLE",
    totalTrades: 0,
    openTrades: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: "UNAVAILABLE",
    closedTradeRealizedPnl: "0",
    partialRealizedPnl: "0",
    verifiedRealizedPnl: "",
    dailyPnl: {},
    netExternalInflows: "0",
    externalFlowStatus: ZERO_EXTERNAL_FLOW_INVARIANT,
    baselineSource: "UNAVAILABLE",
    baselineInitializationReason: "UNINITIALIZED",
    latestEquityObservedAt: null,
    peakEquity: null,
    peakEquityObservedAt: null,
    currentDrawdownPct: "0",
    maxDrawdownPct: "0",
  };
}

export function normalizePerformanceAggregate(performance: PerformanceAggregate): PerformanceAggregate {
  const baseline = performance.competitionBaselineEquity;
  const latest = performance.latestEquity;
  const peak = performance.peakEquity ?? baseline ?? latest;
  return {
    ...performance,
    closedTradeRealizedPnl: performance.closedTradeRealizedPnl ?? "0",
    partialRealizedPnl: performance.partialRealizedPnl ?? "0",
    netExternalInflows: performance.netExternalInflows ?? "0",
    externalFlowStatus: performance.externalFlowStatus ?? ZERO_EXTERNAL_FLOW_INVARIANT,
    baselineSource: performance.baselineSource ?? (baseline ? "PERSISTED_PERFORMANCE_AGGREGATE" : "UNAVAILABLE"),
    baselineInitializationReason: performance.baselineInitializationReason ?? (baseline ? "PRESERVED_EXISTING_BASELINE" : "UNINITIALIZED"),
    latestEquityObservedAt: performance.latestEquityObservedAt ?? performance.performanceBaselineAt,
    peakEquity: peak,
    peakEquityObservedAt: performance.peakEquityObservedAt ?? performance.performanceBaselineAt,
    currentDrawdownPct: performance.currentDrawdownPct ?? (peak && latest ? drawdownPercentage(peak, latest) : "0"),
    maxDrawdownPct: performance.maxDrawdownPct ?? (peak && latest ? drawdownPercentage(peak, latest) : "0"),
  };
}

export function updateEquity(performance: PerformanceAggregate, equity: string, observedAt: string): PerformanceAggregate {
  if (!isPositiveDecimal(equity)) return performance;
  if (isOlderObservation(performance.latestEquityObservedAt, observedAt) || isOlderObservation(performance.performanceBaselineAt, observedAt)) return performance;
  const date = observedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return performance;
  const currentDay = performance.dailyPnl[date];
  const day: PerformanceDay = currentDay
    ? { ...currentDay, latestEquity: equity }
    : { openingEquity: equity, latestEquity: equity, pnl: "0", dailyReturnPct: "0", trades: 0 };
  day.pnl = subtractDecimal(day.latestEquity, day.openingEquity);
  day.dailyReturnPct = percentage(day.pnl, day.openingEquity);
  const dailyPnl = Object.fromEntries(Object.entries({ ...performance.dailyPnl, [date]: day }).sort(([left], [right]) => left.localeCompare(right)).slice(-MAX_PERSISTED_PERFORMANCE_DAYS));
  const totalPnl = performance.competitionBaselineEquity ? subtractDecimal(equity, performance.competitionBaselineEquity) : "UNAVAILABLE";
  const normalized = normalizePerformanceAggregate(performance);
  const previousPeak = normalized.peakEquity;
  const isNewPeak = !previousPeak || compareDecimal(equity, previousPeak) > 0;
  const peakEquity = isNewPeak ? equity : previousPeak;
  const currentDrawdownPct = peakEquity ? drawdownPercentage(peakEquity, equity) : "0";
  const maxDrawdownPct = maximumPercentage(normalized.maxDrawdownPct ?? "0", currentDrawdownPct);
  return {
    ...normalized,
    latestEquity: equity,
    latestEquityObservedAt: observedAt,
    totalPnl,
    dailyPnl,
    peakEquity,
    peakEquityObservedAt: isNewPeak ? observedAt : normalized.peakEquityObservedAt ?? null,
    currentDrawdownPct,
    maxDrawdownPct,
  };
}

export function recordVerifiedOpen(performance: PerformanceAggregate, equity: string, observedAt: string): PerformanceAggregate {
  const updated = updateEquity(performance, equity, observedAt);
  const date = observedAt.slice(0, 10);
  const day = updated.dailyPnl[date];
  return {
    ...updated,
    totalTrades: updated.totalTrades + 1,
    openTrades: updated.openTrades + 1,
    dailyPnl: day ? { ...updated.dailyPnl, [date]: { ...day, trades: day.trades + 1 } } : updated.dailyPnl,
  };
}

export function recordVerifiedClose(performance: PerformanceAggregate, realizedPnl: string | undefined, equity: string, observedAt: string): PerformanceAggregate {
  const updated = updateEquity(performance, equity, observedAt);
  const closed = updated.closedTrades + 1;
  if (!isDecimal(realizedPnl)) return { ...updated, openTrades: Math.max(0, updated.openTrades - 1), closedTrades: closed, winRate: classifiedWinRate(updated.wins, updated.losses, updated.breakeven) };
  const wins = updated.wins + (isPositiveDecimal(realizedPnl) ? 1 : 0);
  const losses = updated.losses + (compareDecimal(realizedPnl, "0") < 0 ? 1 : 0);
  const breakeven = updated.breakeven + (isZeroDecimal(realizedPnl) ? 1 : 0);
  return {
    ...updated,
    openTrades: Math.max(0, updated.openTrades - 1),
    closedTrades: closed,
    wins,
    losses,
    breakeven,
    winRate: classifiedWinRate(wins, losses, breakeven),
    closedTradeRealizedPnl: updated.closedTradeRealizedPnl ? addDecimal(updated.closedTradeRealizedPnl, realizedPnl) : realizedPnl,
    verifiedRealizedPnl: updated.verifiedRealizedPnl ? addDecimal(updated.verifiedRealizedPnl, realizedPnl) : realizedPnl,
  };
}

export function recordVerifiedPartial(performance: PerformanceAggregate, realizedPnl: string, equity: string, observedAt: string): PerformanceAggregate {
  if (!isDecimal(realizedPnl)) return updateEquity(performance, equity, observedAt);
  const updated = updateEquity(performance, equity, observedAt);
  return {
    ...updated,
    partialRealizedPnl: updated.partialRealizedPnl ? addDecimal(updated.partialRealizedPnl, realizedPnl) : realizedPnl,
    verifiedRealizedPnl: updated.verifiedRealizedPnl ? addDecimal(updated.verifiedRealizedPnl, realizedPnl) : realizedPnl,
  };
}

export function performanceTotalPnl(performance: PerformanceAggregate): string {
  if (!performance.competitionBaselineEquity || !performance.latestEquity) return "UNAVAILABLE";
  return subtractDecimal(performance.latestEquity, performance.competitionBaselineEquity);
}

export function buildPerformanceAccounting(performance: PerformanceAggregate, observation?: PerformanceObservation): PerformanceAccounting {
  const normalized = normalizePerformanceAggregate(performance);
  const effectiveObservation = observation && !isOlderObservation(normalized.latestEquityObservedAt, observation.observedAt) && !isOlderObservation(normalized.performanceBaselineAt, observation.observedAt) ? observation : undefined;
  const currentEquity = effectiveObservation?.portfolioEquity ?? normalized.latestEquity;
  const currentEquityObservedAt = effectiveObservation?.observedAt ?? normalized.latestEquityObservedAt ?? normalized.performanceBaselineAt;
  const source = effectiveObservation ? "PROVIDER_LIVE" : currentEquity ? "PERSISTED_LEDGER" : "UNAVAILABLE";
  const baselineEquity = normalized.competitionBaselineEquity;
  const equityDeltaSinceBaseline = baselineEquity && currentEquity ? subtractDecimal(currentEquity, baselineEquity) : "UNAVAILABLE";
  const netExternalInflows = normalized.netExternalInflows ?? "0";
  const netPnlSinceBaseline = baselineEquity && currentEquity && isDecimal(netExternalInflows)
    ? subtractDecimal(equityDeltaSinceBaseline, netExternalInflows)
    : "UNAVAILABLE";
  const peakEquity = normalized.peakEquity && currentEquity && compareDecimal(currentEquity, normalized.peakEquity) > 0 ? currentEquity : normalized.peakEquity;
  const currentDrawdownPct = peakEquity && currentEquity ? drawdownPercentage(peakEquity, currentEquity) : "UNAVAILABLE";
  const maxDrawdownPct = currentDrawdownPct === "UNAVAILABLE" ? normalized.maxDrawdownPct ?? "UNAVAILABLE" : maximumPercentage(normalized.maxDrawdownPct ?? "0", currentDrawdownPct);
  return {
    baselineEquity,
    baselineObservedAt: normalized.performanceBaselineAt,
    baselineSource: normalized.baselineSource ?? "UNAVAILABLE",
    initializationReason: normalized.baselineInitializationReason ?? "UNAVAILABLE",
    currentEquity,
    currentEquityObservedAt,
    equityDeltaSinceBaseline,
    netExternalInflows,
    externalFlowStatus: normalized.externalFlowStatus ?? ZERO_EXTERNAL_FLOW_INVARIANT,
    netPnlSinceBaseline,
    closedTradeRealizedPnl: normalized.closedTradeRealizedPnl,
    partialRealizedPnl: normalized.partialRealizedPnl,
    verifiedRealizedPnl: normalized.verifiedRealizedPnl || "UNAVAILABLE",
    unrealizedPnl: effectiveObservation?.unrealizedPnl ?? "UNAVAILABLE",
    unrealizedPnlSource: effectiveObservation?.unrealizedPnlSource ?? "UNAVAILABLE",
    wins: normalized.wins,
    losses: normalized.losses,
    breakeven: normalized.breakeven,
    classifiedClosedTrades: normalized.wins + normalized.losses + normalized.breakeven,
    winRatePct: classifiedWinRate(normalized.wins, normalized.losses, normalized.breakeven),
    peakEquity: peakEquity ?? null,
    peakEquityObservedAt: peakEquity === currentEquity && currentEquityObservedAt ? currentEquityObservedAt : normalized.peakEquityObservedAt ?? normalized.performanceBaselineAt ?? null,
    currentDrawdownPct,
    maxDrawdownPct,
    source,
  };
}

function isOlderObservation(previous: string | null | undefined, next: string): boolean {
  if (!previous) return false;
  const previousMs = Date.parse(previous);
  const nextMs = Date.parse(next);
  return Number.isFinite(previousMs) && Number.isFinite(nextMs) && nextMs < previousMs;
}

export function currentMonthDailyPnl(performance: PerformanceAggregate, now = new Date()): Record<string, { pnl: string; trades: number; dailyReturnPct: string }> {
  const month = now.toISOString().slice(0, 7);
  return Object.fromEntries(Object.entries(performance.dailyPnl).filter(([date]) => date.startsWith(month)).map(([date, day]) => [date, { pnl: day.pnl, trades: day.trades, dailyReturnPct: day.dailyReturnPct }]));
}

export function bootstrapPerformance(journals: readonly TradingJournal[], experiences: readonly TradeExperience[], initializedAt: string): PerformanceAggregate {
  const performance = emptyPerformance(initializedAt);
  const closedStatuses = new Set(["PROFITABLE", "LOSING", "BREAK_EVEN", "CLOSED_UNCLASSIFIED"]);
  const closedExperiences = experiences.filter((experience) => closedStatuses.has(experience.outcomeStatus) && Boolean(experience.exitDecisionId && experience.exitTime));
  const openExperiences = experiences.filter((experience) => experience.outcomeStatus === "OPEN");
  const closedPnl = sumDecimalValues(closedExperiences.filter((experience) => experience.realizedPnlVerified === true && isDecimal(experience.realizedPnl)).map((experience) => experience.realizedPnl));
  const partialFromRecords = verifiedPartialRealizedPnl(journals);
  const partialFromOpenEpisodes = sumDecimalValues(openExperiences.filter((experience) => experience.realizedPnlVerified === true && isDecimal(experience.realizedPnl)).map((experience) => experience.realizedPnl));
  const partialPnl = isZeroDecimal(partialFromRecords) ? partialFromOpenEpisodes : partialFromRecords;
  let result = {
    ...performance,
    totalTrades: closedExperiences.length + openExperiences.length,
    closedTrades: closedExperiences.length,
    openTrades: openExperiences.length,
    wins: closedExperiences.filter((experience) => experience.outcomeStatus === "PROFITABLE" && experience.realizedPnlVerified === true && isDecimal(experience.realizedPnl)).length,
    losses: closedExperiences.filter((experience) => experience.outcomeStatus === "LOSING" && experience.realizedPnlVerified === true && isDecimal(experience.realizedPnl)).length,
    breakeven: closedExperiences.filter((experience) => experience.outcomeStatus === "BREAK_EVEN" && experience.realizedPnlVerified === true && isDecimal(experience.realizedPnl)).length,
    closedTradeRealizedPnl: closedPnl,
    partialRealizedPnl: partialPnl,
    verifiedRealizedPnl: addDecimal(closedPnl, partialPnl),
  };
  result = { ...result, winRate: classifiedWinRate(result.wins, result.losses, result.breakeven) };
  const baselinePortfolio = journals
    .map((journal) => journal.portfolio)
    .filter((portfolio): portfolio is AccountSnapshot => Boolean(portfolio && isPositiveDecimal(portfolio.portfolioEquity)))
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))[0];
  if (baselinePortfolio) {
    result = {
      ...result,
      performanceBaselineAt: baselinePortfolio.observedAt,
      competitionBaselineEquity: baselinePortfolio.portfolioEquity,
      latestEquity: baselinePortfolio.portfolioEquity,
      latestEquityObservedAt: baselinePortfolio.observedAt,
      peakEquity: baselinePortfolio.portfolioEquity,
      peakEquityObservedAt: baselinePortfolio.observedAt,
      baselineSource: "PROVIDER_LIVE",
      baselineInitializationReason: "FIRST_TRUSTWORTHY_PROVIDER_OBSERVATION",
    };
    result = updateEquity(result, baselinePortfolio.portfolioEquity, baselinePortfolio.observedAt);
  }
  return result;
}

function verifiedPartialRealizedPnl(journals: readonly TradingJournal[]): string {
  const seen = new Set<string>();
  let total = "0";
  for (const journal of journals) {
    if (journal.mode !== "AUTONOMOUS") continue;
    const normalized = normalizeCycleDecisions(journal);
    for (const record of normalized.records) {
      if (record.decision.action !== "REDUCE" || seen.has(record.decision.decisionId)) continue;
      seen.add(record.decision.decisionId);
      const execution = effectiveExecutionResult(journal, record.decision, record);
      const reconciliation = effectiveReconciliationResult(journal, record.decision, record);
      if (execution?.status === "filled" && reconciliation?.status === "MATCHED" && isDecimal(execution.realizedPnl)) total = addDecimal(total, execution.realizedPnl);
    }
  }
  return total;
}

function sumDecimalValues(values: readonly (string | undefined)[]): string {
  return values.filter(isDecimal).reduce((total, value) => addDecimal(total, value), "0");
}

export function verifiedLifecycleFacts(journals: readonly TradingJournal[]): VerifiedLifecycleFacts {
  const verifiedOpenIds = new Set<string>();
  const verifiedCloseIds = new Set<string>();
  const verifiedClosedIds = new Set<string>();
  const realizedPnlByClosedId = new Map<string, string>();
  for (const journal of journals) {
    if (journal.mode !== "AUTONOMOUS") continue;
    const normalized = normalizeCycleDecisions(journal);
    const decisions = [...cyclePlanDecisions(journal), ...normalized.records.map((record) => record.decision)].filter((decision, index, list) => list.findIndex((candidate) => candidate.decisionId === decision.decisionId) === index);
    for (const decision of decisions) {
      const record = normalized.records.find((candidate) => candidate.decision.decisionId === decision.decisionId);
      const execution = effectiveExecutionResult(journal, decision, record);
      const reconciliation = effectiveReconciliationResult(journal, decision, record);
      if ((decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT") && execution?.status === "filled" && reconciliation?.status === "MATCHED") verifiedOpenIds.add(decision.decisionId);
      if (decision.action === "CLOSE" && execution?.status === "filled" && reconciliation?.status === "MATCHED") verifiedCloseIds.add(decision.decisionId);
    }
  }
  return { verifiedOpenIds, verifiedCloseIds, verifiedClosedIds, realizedPnlByClosedId };
}

function percentage(value: string, denominator: string): string {
  if (!isDecimal(value) || !isPositiveDecimal(denominator)) return "0";
  const valueParts = decimalParts(value);
  const denominatorParts = decimalParts(denominator);
  const scale = Math.max(valueParts.scale, denominatorParts.scale);
  const numerator = valueParts.integer * 10n ** BigInt(scale - valueParts.scale) * 100n * 10n ** 8n;
  const divisor = denominatorParts.integer * 10n ** BigInt(scale - denominatorParts.scale);
  return decimalText(numerator / divisor, 8);
}

function drawdownPercentage(peak: string, current: string): string {
  if (!isPositiveDecimal(peak) || !isDecimal(current) || compareDecimal(current, peak) >= 0) return "0";
  return percentage(subtractDecimal(peak, current), peak);
}

function maximumPercentage(left: string, right: string): string {
  if (left === "UNAVAILABLE") return right;
  if (right === "UNAVAILABLE") return left;
  return compareDecimal(left, right) >= 0 ? left : right;
}

function ratioPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "UNAVAILABLE";
  return decimalText(BigInt(numerator) * 10000000000n / BigInt(denominator), 8);
}

function classifiedWinRate(wins: number, losses: number, breakeven: number): string {
  return ratioPercent(wins, wins + losses + breakeven);
}

function decimalParts(value: string): { integer: bigint; scale: number } {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match?.[2]) throw new Error("INVALID_DECIMAL");
  return { integer: BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`), scale: match[3]?.length ?? 0 };
}

function decimalText(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = (negative ? -value : value).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${magnitude}`;
  const fraction = magnitude.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction ? `${magnitude.slice(0, -scale)}.${fraction}` : magnitude.slice(0, -scale)}`;
}
