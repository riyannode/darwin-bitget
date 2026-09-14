import type { TradeExperience, TradingJournal } from "../types.js";
import { cyclePlanDecisions, effectiveExecutionResult, effectiveReconciliationResult, normalizeCycleDecisions } from "../storage/journal-normalizer.js";
import { addDecimal, isDecimal, subtractDecimal } from "./decimal.js";

export const PERFORMANCE_READ_MODEL_VERSION = "performance-v1";
export const POSITION_CONTEXT_READ_MODEL_VERSION = "position-context-v1";
export const MAX_PERSISTED_PERFORMANCE_DAYS = 62;

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
  verifiedRealizedPnl: string;
  dailyPnl: Record<string, PerformanceDay>;
}

export interface VerifiedLifecycleFacts {
  verifiedOpenIds: Set<string>;
  verifiedCloseIds: Set<string>;
  verifiedClosedIds: Set<string>;
  realizedPnlByClosedId: Map<string, string>;
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
    verifiedRealizedPnl: "",
    dailyPnl: {},
  };
}

export function updateEquity(performance: PerformanceAggregate, equity: string, observedAt: string): PerformanceAggregate {
  if (!isDecimal(equity) || Number(equity) <= 0) return performance;
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
  return {
    ...performance,
    latestEquity: equity,
    totalPnl,
    dailyPnl,
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

export function recordVerifiedClose(performance: PerformanceAggregate, realizedPnl: string, equity: string, observedAt: string): PerformanceAggregate {
  if (!isDecimal(realizedPnl)) return updateEquity(performance, equity, observedAt);
  const updated = updateEquity(performance, equity, observedAt);
  const pnl = Number(realizedPnl);
  const closed = updated.closedTrades + 1;
  const wins = updated.wins + (pnl > 0 ? 1 : 0);
  const losses = updated.losses + (pnl < 0 ? 1 : 0);
  const breakeven = updated.breakeven + (pnl === 0 ? 1 : 0);
  return {
    ...updated,
    openTrades: Math.max(0, updated.openTrades - 1),
    closedTrades: closed,
    wins,
    losses,
    breakeven,
    winRate: ratioPercent(wins, closed),
    verifiedRealizedPnl: updated.verifiedRealizedPnl ? addDecimal(updated.verifiedRealizedPnl, realizedPnl) : realizedPnl,
  };
}

export function performanceTotalPnl(performance: PerformanceAggregate): string {
  if (!performance.competitionBaselineEquity || !performance.latestEquity) return "UNAVAILABLE";
  return subtractDecimal(performance.latestEquity, performance.competitionBaselineEquity);
}

export function currentMonthDailyPnl(performance: PerformanceAggregate, now = new Date()): Record<string, { pnl: string; trades: number; dailyReturnPct: string }> {
  const month = now.toISOString().slice(0, 7);
  return Object.fromEntries(Object.entries(performance.dailyPnl).filter(([date]) => date.startsWith(month)).map(([date, day]) => [date, { pnl: day.pnl, trades: day.trades, dailyReturnPct: day.dailyReturnPct }]));
}

export function bootstrapPerformance(journals: readonly TradingJournal[], experiences: readonly TradeExperience[], initializedAt: string): PerformanceAggregate {
  const performance = emptyPerformance(initializedAt);
  const facts = verifiedLifecycleFacts(journals);
  let result = { ...performance, totalTrades: facts.verifiedOpenIds.size };
  const closedExperiences = experiences.filter((experience) => {
    const closed = experience.outcomeStatus === "PROFITABLE" || experience.outcomeStatus === "LOSING" || experience.outcomeStatus === "BREAK_EVEN";
    if (closed && facts.verifiedOpenIds.has(experience.entryDecisionId) && facts.verifiedCloseIds.has(experience.exitDecisionId) && experience.realizedPnlVerified === true) {
      facts.verifiedClosedIds.add(experience.experienceId);
      facts.realizedPnlByClosedId.set(experience.experienceId, experience.realizedPnl);
      return true;
    }
    return false;
  });
  result = { ...result, closedTrades: closedExperiences.length, openTrades: Math.max(0, result.totalTrades - closedExperiences.length) };
  for (const experience of closedExperiences) {
    const pnl = facts.realizedPnlByClosedId.get(experience.experienceId) ?? experience.realizedPnl;
    if (!isDecimal(pnl)) continue;
    const value = Number(pnl);
    result = {
      ...result,
      wins: result.wins + (value > 0 ? 1 : 0),
      losses: result.losses + (value < 0 ? 1 : 0),
      breakeven: result.breakeven + (value === 0 ? 1 : 0),
      verifiedRealizedPnl: result.verifiedRealizedPnl ? addDecimal(result.verifiedRealizedPnl, pnl) : pnl,
    };
  }
  result = { ...result, winRate: result.closedTrades ? ratioPercent(result.wins, result.closedTrades) : "UNAVAILABLE" };
  const latestPortfolio = journals.find((journal) => journal.portfolio?.portfolioEquity);
  if (latestPortfolio?.portfolio && isDecimal(latestPortfolio.portfolio.portfolioEquity) && Number(latestPortfolio.portfolio.portfolioEquity) > 0) {
    result = {
      ...result,
      performanceBaselineAt: latestPortfolio.portfolio.observedAt,
      competitionBaselineEquity: latestPortfolio.portfolio.portfolioEquity,
      latestEquity: latestPortfolio.portfolio.portfolioEquity,
    };
    result = updateEquity(result, latestPortfolio.portfolio.portfolioEquity, latestPortfolio.portfolio.observedAt);
  }
  return result;
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
  if (!isDecimal(denominator) || Number(denominator) <= 0) return "0";
  const valueParts = decimalParts(value);
  const denominatorParts = decimalParts(denominator);
  const numerator = valueParts.integer * 100n * 10n ** BigInt(8 + denominatorParts.scale);
  const quotient = numerator / (denominatorParts.integer * 10n ** BigInt(valueParts.scale));
  return decimalText(quotient, 8);
}

function ratioPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "UNAVAILABLE";
  return decimalText(BigInt(numerator) * 10000000000n / BigInt(denominator), 8);
}

function decimalParts(value: string): { integer: bigint; scale: number } {
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match?.[1]) throw new Error("INVALID_DECIMAL");
  return { integer: BigInt(`${match[0].startsWith("-") ? "-" : ""}${match[1]}${match[2] ?? ""}`), scale: match[2]?.length ?? 0 };
}

function decimalText(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = (negative ? -value : value).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${magnitude}`;
  const fraction = magnitude.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction ? `${magnitude.slice(0, -scale)}.${fraction}` : magnitude.slice(0, -scale)}`;
}
