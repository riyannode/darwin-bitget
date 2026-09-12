import { addDecimal, isDecimal } from "../trading/decimal.js";
import type { ActivityEvent, Decision, DecisionExecutionRecord, ExecutionRequest, ExecutionResult, ReconciliationResult, TradeExperience, TradingJournal } from "../types.js";
import type { StoredCycle } from "./store.js";

export interface PaperLogPeriod {
  start: string | null;
  end: string | null;
}

export interface PaperLogExport {
  exportGeneratedAt: string;
  period: PaperLogPeriod;
  environment: string;
  paperMode: true;
  model: string;
  version: string;
  commit: string;
  summary: PaperLogSummary;
  cycles: PaperLogCycle[];
  decisions: PaperLogDecision[];
  experiences: PaperLogExperience[];
  events: ActivityEvent[];
}

export interface PaperLogSummary {
  totalCycles: number;
  completedCycles: number;
  failedCycles: number;
  decisions: Record<Decision["action"], number>;
  verifiedExecutions: number;
  unresolvedExecutions: number;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  realizedPnl: string;
  currentDrawdownPct: string | null;
  maxDrawdownPct: string | null;
}

export interface PaperLogCycle {
  cycleId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  decisionIds: string[];
  eventTypes: string[];
}

export interface PaperLogDecision {
  cycleId: string;
  decisionId: string;
  timestamp: string;
  action: Decision["action"];
  symbol: string;
  positionSide: Decision["positionSide"];
  marginAllocationPct: string;
  leverage: string;
  reductionPct: string | null;
  confidence: number;
  strategyThesis: string;
  supportingFactors: string[];
  riskFactors: string[];
  evidenceUsed: string[];
  lessonsUsed: string[];
  riskGate: { status: string; codes: string[] } | null;
  executionRequest: PaperLogExecutionRequest | null;
  executionResult: PaperLogExecutionResult | null;
  reconciliation: { status: string; codes: string[]; realizedPnl: string | null } | null;
  providerVerified: boolean;
  realizedPnl: string | null;
  reflectionIds: string[];
  createdLessonIds: string[];
}

export interface PaperLogExecutionRequest {
  symbol: string;
  action: string;
  positionSide: string;
  tradeSide: string;
  marginAllocated: string;
  leverage: string;
  positionNotional: string;
  reductionPct: string | null;
  quantity: string;
  clientOrderId: string;
}

export interface PaperLogExecutionResult {
  provider: string;
  providerOrderId: string | null;
  clientOrderId: string;
  status: string;
  requestedQuantity: string;
  executedQuantity: string;
  averageFillPrice: string | null;
  fees: string | null;
  funding: string | null;
  realizedPnl: string | null;
  realizedPnlPct: string | null;
  providerCode: string | null;
  providerReadbackCode: string | null;
  readBackAt: string;
}

export interface PaperLogExperience {
  experienceId: string;
  symbol: string;
  positionSide: TradeExperience["positionSide"];
  action: TradeExperience["action"];
  entryDecisionId: string;
  exitDecisionId: string;
  entryPrice: string;
  exitPrice: string;
  entryTime: string;
  exitTime: string;
  selectedLeverage: string;
  marginAllocationPct: string;
  marginAllocated: string;
  positionNotional: string;
  realizedPnl: string | null;
  realizedPnlPct: string | null;
  outcomeStatus: TradeExperience["outcomeStatus"];
  realizedPnlVerified: boolean;
  fees: string | null;
  funding: string | null;
  lessonsUsed: string[];
}

export function parsePaperLogPeriod(from: string | null, to: string | null): PaperLogPeriod {
  const start = normalizeTimestamp(from);
  const end = normalizeTimestamp(to);
  if (start && end && start > end) throw new Error("INVALID_EXPORT_PERIOD");
  return { start, end };
}

function normalizeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("INVALID_EXPORT_PERIOD");
  return timestamp.toISOString();
}

function executionRequest(request: ExecutionRequest | undefined): PaperLogExecutionRequest | null {
  if (!request) return null;
  return {
    symbol: request.symbol,
    action: request.action,
    positionSide: request.positionSide,
    tradeSide: request.tradeSide,
    marginAllocated: request.marginAllocated,
    leverage: request.leverage,
    positionNotional: request.positionNotional,
    reductionPct: request.reductionPct,
    quantity: request.quantity,
    clientOrderId: request.clientOrderId,
  };
}

function executionResult(result: ExecutionResult | undefined): PaperLogExecutionResult | null {
  if (!result) return null;
  return {
    provider: result.provider,
    providerOrderId: result.providerOrderId ?? null,
    clientOrderId: result.clientOrderId,
    status: result.status,
    requestedQuantity: result.requestedQuantity,
    executedQuantity: result.executedQuantity,
    averageFillPrice: result.averageFillPrice ?? null,
    fees: result.fees ?? null,
    funding: result.funding ?? null,
    realizedPnl: result.realizedPnl ?? null,
    realizedPnlPct: result.realizedPnlPct ?? null,
    providerCode: result.providerCode ?? null,
    providerReadbackCode: result.providerReadbackCode ?? null,
    readBackAt: result.readBackAt,
  };
}

function reconciliation(result: ReconciliationResult | undefined): PaperLogDecision["reconciliation"] {
  if (!result) return null;
  return { status: result.status, codes: result.codes, realizedPnl: result.realizedPnl ?? null };
}

function isVerified(record: DecisionExecutionRecord | undefined): boolean {
  return Boolean(record?.executionResult && record.executionResult.status === "filled" && record.reconciliationResult?.status === "MATCHED");
}

function decisionRecord(journal: TradingJournal, decision: Decision, record: DecisionExecutionRecord | undefined): PaperLogDecision {
  const verified = isVerified(record);
  const realizedPnl = verified && record?.executionResult?.realizedPnl ? record.executionResult.realizedPnl : null;
  const reflectionIds = [journal.reflection?.reflectionId ?? "", ...(journal.exitReflections ?? []).map((reflection) => reflection.reflectionId)].filter(Boolean);
  return {
    cycleId: journal.cycleId,
    decisionId: decision.decisionId,
    timestamp: decision.createdAt,
    action: decision.action,
    symbol: decision.symbol,
    positionSide: decision.positionSide,
    marginAllocationPct: decision.marginAllocationPct,
    leverage: decision.leverage,
    reductionPct: decision.reductionPct,
    confidence: decision.confidence,
    strategyThesis: decision.strategyThesis,
    supportingFactors: decision.supportingFactors,
    riskFactors: decision.riskFactors,
    evidenceUsed: decision.evidenceUsed,
    lessonsUsed: decision.lessonsUsed,
    riskGate: record?.riskGateResult ? { status: record.riskGateResult.status, codes: record.riskGateResult.codes } : journal.riskGateResult ? { status: journal.riskGateResult.status, codes: journal.riskGateResult.codes } : null,
    executionRequest: executionRequest(record?.executionRequest ?? (journal.decision?.decisionId === decision.decisionId ? journal.executionRequest : undefined)),
    executionResult: executionResult(record?.executionResult ?? (journal.decision?.decisionId === decision.decisionId ? journal.executionResult : undefined)),
    reconciliation: reconciliation(record?.reconciliationResult ?? (journal.decision?.decisionId === decision.decisionId ? journal.reconciliationResult : undefined)),
    providerVerified: verified,
    realizedPnl,
    reflectionIds,
    createdLessonIds: journal.createdLessons,
  };
}

function cycleDecisions(journal: TradingJournal): PaperLogDecision[] {
  const records = journal.exitExecutions ?? [];
  const seen = new Set<string>();
  const decisions = [journal.decision, ...(journal.exitDecisions ?? [])].filter((decision): decision is Decision => Boolean(decision));
  return decisions.flatMap((decision) => {
    if (seen.has(decision.decisionId)) return [];
    seen.add(decision.decisionId);
    return [decisionRecord(journal, decision, records.find((record) => record.decision.decisionId === decision.decisionId))];
  });
}

function exportExperience(experience: TradeExperience): PaperLogExperience {
  const verified = experience.realizedPnlVerified === true;
  return {
    experienceId: experience.experienceId,
    symbol: experience.symbol,
    positionSide: experience.positionSide,
    action: experience.action,
    entryDecisionId: experience.entryDecisionId,
    exitDecisionId: experience.exitDecisionId,
    entryPrice: experience.entryPrice,
    exitPrice: experience.exitPrice,
    entryTime: experience.entryTime,
    exitTime: experience.exitTime,
    selectedLeverage: experience.selectedLeverage,
    marginAllocationPct: experience.marginAllocationPct,
    marginAllocated: experience.marginAllocated,
    positionNotional: experience.positionNotional,
    realizedPnl: verified ? experience.realizedPnl : null,
    realizedPnlPct: verified ? experience.realizedPnlPct : null,
    outcomeStatus: experience.outcomeStatus,
    realizedPnlVerified: verified,
    fees: experience.fees ?? null,
    funding: experience.funding ?? null,
    lessonsUsed: experience.lessonsUsed,
  };
}

function percentChange(baseline: string, current: string): string | null {
  const base = Number(baseline);
  const value = Number(current);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(value)) return null;
  return (((value - base) / base) * 100).toFixed(8);
}

function summarizeDrawdown(journals: readonly TradingJournal[]): { current: string | null; maximum: string | null } {
  const byDate = new Map<string, string>();
  for (const journal of journals) {
    const equity = journal.portfolio?.portfolioEquity;
    if (!equity) continue;
    const date = journal.startedAt.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, equity);
  }
  const drawdowns = journals.flatMap((journal) => {
    const equity = journal.portfolio?.portfolioEquity;
    const baseline = equity ? byDate.get(journal.startedAt.slice(0, 10)) : undefined;
    const value = equity && baseline ? percentChange(baseline, equity) : null;
    return value ? [value] : [];
  });
  const numeric = drawdowns.map(Number).filter(Number.isFinite);
  return { current: numeric.length ? drawdowns[drawdowns.length - 1] ?? null : null, maximum: numeric.length ? Math.min(...numeric).toFixed(8) : null };
}

export function buildPaperLogExport(input: {
  generatedAt: string;
  period: PaperLogPeriod;
  environment: string;
  model: string;
  version: string;
  commit: string;
  cycles: readonly StoredCycle[];
  journals: readonly TradingJournal[];
  experiences: readonly TradeExperience[];
  events: readonly ActivityEvent[];
}): PaperLogExport {
  const journals = input.journals.filter((journal) => journal.mode === "AUTONOMOUS");
  const journalByCycle = new Map(journals.map((journal) => [journal.cycleId, journal]));
  const cycleIds = new Set(journals.map((journal) => journal.cycleId));
  const events = input.events.filter((event) => cycleIds.has(event.cycleId));
  const cycles = input.cycles.filter((cycle) => cycleIds.has(cycle.cycleId)).map((cycle) => {
    const journal = journalByCycle.get(cycle.cycleId);
    const cycleEvents = events.filter((event) => event.cycleId === cycle.cycleId);
    return {
      cycleId: cycle.cycleId,
      status: cycle.status,
      startedAt: cycle.startedAt,
      completedAt: cycle.completedAt,
      durationMs: journal?.durationMs ?? null,
      decisionIds: journal ? cycleDecisions(journal).map((decision) => decision.decisionId) : [],
      eventTypes: cycleEvents.map((event) => event.type),
    };
  });
  const decisions = journals.flatMap(cycleDecisions);
  const experienceIds = new Set(journals.flatMap((journal) => journal.experienceIds ?? []));
  const experiences = input.experiences.filter((experience) => experienceIds.has(experience.experienceId)).map(exportExperience);
  const decisionCounts: Record<Decision["action"], number> = { HOLD: 0, OPEN_LONG: 0, OPEN_SHORT: 0, REDUCE: 0, CLOSE: 0 };
  for (const decision of decisions) decisionCounts[decision.action] += 1;
  const verifiedExecutions = decisions.filter((decision) => decision.providerVerified).length;
  const unresolvedExecutions = decisions.filter((decision) => decision.executionResult && !decision.providerVerified).length;
  const closed = experiences.filter((experience) => ["PROFITABLE", "LOSING", "BREAK_EVEN"].includes(experience.outcomeStatus));
  const realizedPnl = experiences.filter((experience) => experience.realizedPnlVerified && typeof experience.realizedPnl === "string" && isDecimal(experience.realizedPnl)).reduce((total, experience) => addDecimal(total, experience.realizedPnl ?? "0"), "0");
  const drawdown = summarizeDrawdown(journals);
  return {
    exportGeneratedAt: input.generatedAt,
    period: input.period,
    environment: input.environment,
    paperMode: true,
    model: input.model,
    version: input.version,
    commit: input.commit,
    summary: {
      totalCycles: cycles.length,
      completedCycles: cycles.filter((cycle) => cycle.status === "COMPLETED").length,
      failedCycles: cycles.filter((cycle) => cycle.status === "FAILED").length,
      decisions: decisionCounts,
      verifiedExecutions,
      unresolvedExecutions,
      closedTrades: closed.length,
      wins: closed.filter((experience) => experience.outcomeStatus === "PROFITABLE").length,
      losses: closed.filter((experience) => experience.outcomeStatus === "LOSING").length,
      breakeven: closed.filter((experience) => experience.outcomeStatus === "BREAK_EVEN").length,
      realizedPnl,
      currentDrawdownPct: drawdown.current,
      maxDrawdownPct: drawdown.maximum,
    },
    cycles,
    decisions,
    experiences,
    events,
  };
}

function csvValue(value: unknown): string {
  const text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join(" | ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function paperLogToCsv(exported: PaperLogExport): string {
  const header = ["cycleId", "cycleStatus", "cycleStartedAt", "cycleCompletedAt", "eventTypes", "decisionId", "decisionTimestamp", "action", "symbol", "positionSide", "marginAllocationPct", "leverage", "reductionPct", "confidence", "strategyThesis", "supportingFactors", "riskFactors", "evidenceUsed", "lessonsUsed", "riskGateStatus", "riskGateCodes", "tradeSide", "positionNotional", "clientOrderId", "providerOrderId", "executionStatus", "requestedQuantity", "executedQuantity", "reconciliationStatus", "reconciliationCodes", "providerVerified", "realizedPnl", "reflectionIds", "createdLessonIds"];
  const rows = exported.cycles.flatMap((cycle) => {
    const decisions = exported.decisions.filter((decision) => decision.cycleId === cycle.cycleId);
    if (!decisions.length) return [[cycle.cycleId, cycle.status, cycle.startedAt, cycle.completedAt, cycle.eventTypes, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]];
    return decisions.map((decision) => [cycle.cycleId, cycle.status, cycle.startedAt, cycle.completedAt, cycle.eventTypes, decision.decisionId, decision.timestamp, decision.action, decision.symbol, decision.positionSide, decision.marginAllocationPct, decision.leverage, decision.reductionPct, decision.confidence, decision.strategyThesis, decision.supportingFactors, decision.riskFactors, decision.evidenceUsed, decision.lessonsUsed, decision.riskGate?.status, decision.riskGate?.codes, decision.executionRequest?.tradeSide, decision.executionRequest?.positionNotional, decision.executionRequest?.clientOrderId, decision.executionResult?.providerOrderId, decision.executionResult?.status, decision.executionResult?.requestedQuantity, decision.executionResult?.executedQuantity, decision.reconciliation?.status, decision.reconciliation?.codes, decision.providerVerified, decision.realizedPnl, decision.reflectionIds, decision.createdLessonIds]);
  });
  return [header, ...rows].map((row) => row.map(csvValue).join(",")).join("\r\n") + "\r\n";
}
