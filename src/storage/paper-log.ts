import { addDecimal, isDecimal } from "../trading/decimal.js";
import type { ActivityEvent, Decision, DecisionExecutionRecord, ExecutionRequest, ExecutionResult, ReconciliationResult, TradeExperience, TradingJournal } from "../types.js";
import type { StoredCycle } from "./store.js";
import { cyclePlanDecisions, decisionCategory, effectiveExecutionRequest, effectiveExecutionResult, effectiveReconciliationResult, effectiveRiskGateResult, normalizeCycleDecisions } from "./journal-normalizer.js";

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
  scannedUniverseCount: number | null;
  selectedEntryCandidates: string[];
  managedExistingPositions: string[];
  totalProposedActions: number;
  financialWritesPerformed: number;
}

export interface PaperLogDecision {
  cycleId: string;
  decisionId: string;
  timestamp: string;
  actionCategory: "POSITION_MANAGEMENT" | "NEW_ENTRY";
  action: Decision["action"];
  symbol: string;
  positionSide: Decision["positionSide"];
  marginAllocationPct: string;
  additionalMarginPct: string | null;
  leverage: string;
  reductionPct: string | null;
  targetPositionSide: Decision["targetPositionSide"];
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
  physicalWrites: PaperLogPhysicalWrite[];
  reflectionIds: string[];
  createdLessonIds: string[];
}

export interface PaperLogPhysicalWrite {
  decisionId: string;
  parentDecisionId: string | null;
  action: string;
  symbol: string;
  positionSide: string;
  tradeSide: string;
  marginAllocated: string;
  leverage: string;
  positionNotional: string;
  orderReference: string | null;
  executionStatus: string | null;
  reconciliationStatus: string | null;
  providerVerified: boolean;
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
  providerOperation: string | null;
  providerCode: string | null;
  providerMessage: string | null;
  providerReadbackCode: string | null;
  providerReadbackMessage: string | null;
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
    providerOperation: result.providerOperation ?? null,
    providerCode: result.providerCode ?? null,
    providerMessage: result.providerMessage ?? null,
    providerReadbackCode: result.providerReadbackCode ?? null,
    providerReadbackMessage: result.providerReadbackMessage ?? null,
    readBackAt: result.readBackAt,
  };
}

function reconciliation(result: ReconciliationResult | undefined): PaperLogDecision["reconciliation"] {
  if (!result) return null;
  return { status: result.status, codes: result.codes, realizedPnl: result.realizedPnl ?? null };
}

function physicalWrite(record: DecisionExecutionRecord): PaperLogPhysicalWrite {
  const execution = record.executionResult;
  const reconciliationResult = record.reconciliationResult;
  const verified = execution?.status === "filled" && reconciliationResult?.status === "MATCHED";
  return {
    decisionId: record.decision.decisionId,
    parentDecisionId: record.parentDecisionId ?? null,
    action: record.decision.action,
    symbol: record.decision.symbol,
    positionSide: record.decision.positionSide ?? "",
    tradeSide: execution?.tradeSide ?? "",
    marginAllocated: execution?.marginAllocated ?? "0",
    leverage: execution?.leverage ?? record.decision.leverage,
    positionNotional: execution?.positionNotional ?? "0",
    orderReference: execution?.providerOrderId ?? execution?.clientOrderId ?? null,
    executionStatus: execution?.status ?? null,
    reconciliationStatus: reconciliationResult?.status ?? null,
    providerVerified: verified,
  };
}

function decisionRecord(journal: TradingJournal, decision: Decision, record: DecisionExecutionRecord | undefined, physicalWrites: PaperLogPhysicalWrite[] = []): PaperLogDecision {
  const effectiveExecution = effectiveExecutionResult(journal, decision, record);
  const effectiveReconciliation = effectiveReconciliationResult(journal, decision, record);
  const verified = effectiveExecution?.status === "filled" && effectiveReconciliation?.status === "MATCHED";
  const realizedPnl = verified && effectiveExecution?.realizedPnl ? effectiveExecution.realizedPnl : null;
  const reflectionIds = [journal.reflection?.reflectionId ?? "", ...(journal.exitReflections ?? []).map((reflection) => reflection.reflectionId)].filter(Boolean);
  return {
    cycleId: journal.cycleId,
    decisionId: decision.decisionId,
    timestamp: decision.createdAt,
    actionCategory: decisionCategory(journal, decision),
    action: decision.action,
    symbol: decision.symbol,
    positionSide: decision.positionSide,
    marginAllocationPct: decision.marginAllocationPct,
    additionalMarginPct: decision.additionalMarginPct ?? null,
    leverage: decision.leverage,
    reductionPct: decision.reductionPct,
    targetPositionSide: decision.targetPositionSide ?? null,
    confidence: decision.confidence,
    strategyThesis: decision.strategyThesis,
    supportingFactors: decision.supportingFactors,
    riskFactors: decision.riskFactors,
    evidenceUsed: decision.evidenceUsed,
    lessonsUsed: decision.lessonsUsed,
    riskGate: (() => { const result = effectiveRiskGateResult(journal, decision, record); return result ? { status: result.status, codes: result.codes } : null; })(),
    executionRequest: executionRequest(effectiveExecutionRequest(journal, decision, record)),
    executionResult: executionResult(effectiveExecution),
    reconciliation: reconciliation(effectiveReconciliation),
    providerVerified: verified,
    realizedPnl,
    physicalWrites,
    reflectionIds,
    createdLessonIds: journal.createdLessons,
  };
}

function cycleDecisions(journal: TradingJournal): PaperLogDecision[] {
  const records = normalizeCycleDecisions(journal).records;
  const seen = new Set<string>();
  const decisions = cyclePlanDecisions(journal);
  return decisions.flatMap((decision) => {
    if (seen.has(decision.decisionId)) return [];
    seen.add(decision.decisionId);
    return [decisionRecord(journal, decision, records.find((record) => record.decision.decisionId === decision.decisionId), records.filter((record) => record.parentDecisionId === decision.decisionId).map(physicalWrite))];
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

export function calculatePeakDrawdown(equities: readonly string[]): { current: string | null; maximum: string | null } {
  let runningPeak: number | null = null;
  let currentDrawdown: number | null = null;
  let maximumDrawdown = 0;
  for (const equityText of equities) {
    const equity = Number(equityText);
    if (!Number.isFinite(equity) || equity < 0) continue;
    runningPeak = runningPeak === null ? equity : Math.max(runningPeak, equity);
    if (runningPeak <= 0) continue;
    currentDrawdown = ((equity - runningPeak) / runningPeak) * 100;
    maximumDrawdown = Math.min(maximumDrawdown, currentDrawdown);
  }
  return { current: currentDrawdown === null ? null : currentDrawdown.toFixed(8), maximum: runningPeak === null ? null : maximumDrawdown.toFixed(8) };
}

function summarizeDrawdown(journals: readonly TradingJournal[]): { current: string | null; maximum: string | null } {
  return calculatePeakDrawdown(journals.flatMap((journal) => journal.portfolio?.portfolioEquity ? [journal.portfolio.portfolioEquity] : []));
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
      scannedUniverseCount: journal?.discovery?.scannedUniverseCount ?? null,
      selectedEntryCandidates: journal?.discovery?.selectedEntryCandidateSymbols ?? [],
      managedExistingPositions: journal?.discovery?.managedExistingPositionSymbols ?? [],
      totalProposedActions: journal ? cycleDecisions(journal).length : 0,
      financialWritesPerformed: journal?.discovery?.financialWritesPerformed ?? (journal ? normalizeCycleDecisions(journal).records.filter((record) => Boolean(record.executionResult)).length : 0),
    };
  });
  const decisions = journals.flatMap(cycleDecisions);
  const experienceIds = new Set(journals.flatMap((journal) => journal.experienceIds ?? []));
  const experiences = input.experiences.filter((experience) => experienceIds.has(experience.experienceId)).map(exportExperience);
  const decisionCounts: Record<Decision["action"], number> = { HOLD: 0, OPEN_LONG: 0, OPEN_SHORT: 0, INCREASE: 0, REDUCE: 0, CLOSE: 0, REVERSE: 0 };
  for (const decision of decisions) decisionCounts[decision.action] += 1;
  const physicalWrites = decisions.flatMap((decision) => decision.physicalWrites);
  const verifiedExecutions = decisions.filter((decision) => decision.action !== "REVERSE" && decision.providerVerified).length + physicalWrites.filter((write) => write.providerVerified).length;
  const unresolvedExecutions = decisions.filter((decision) => decision.action !== "REVERSE" && decision.executionResult && !decision.providerVerified).length + physicalWrites.filter((write) => write.executionStatus !== null && !write.providerVerified).length;
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
  const header = ["cycleId", "cycleStatus", "cycleStartedAt", "cycleCompletedAt", "eventTypes", "scannedUniverseCount", "selectedEntryCandidates", "managedExistingPositions", "totalProposedActions", "financialWritesPerformed", "decisionId", "decisionTimestamp", "actionCategory", "action", "symbol", "positionSide", "marginAllocationPct", "additionalMarginPct", "targetPositionSide", "leverage", "reductionPct", "confidence", "strategyThesis", "supportingFactors", "riskFactors", "evidenceUsed", "lessonsUsed", "riskGateStatus", "riskGateCodes", "tradeSide", "positionNotional", "clientOrderId", "providerOrderId", "executionStatus", "requestedQuantity", "executedQuantity", "providerOperation", "providerCode", "providerMessage", "providerReadbackCode", "providerReadbackMessage", "reconciliationStatus", "reconciliationCodes", "providerVerified", "realizedPnl", "physicalWrites", "reflectionIds", "createdLessonIds"];
  const rows = exported.cycles.flatMap((cycle) => {
    const decisions = exported.decisions.filter((decision) => decision.cycleId === cycle.cycleId);
    const cycleValues = [cycle.cycleId, cycle.status, cycle.startedAt, cycle.completedAt, cycle.eventTypes, cycle.scannedUniverseCount, cycle.selectedEntryCandidates, cycle.managedExistingPositions, cycle.totalProposedActions, cycle.financialWritesPerformed];
    if (!decisions.length) return [[...cycleValues, ...Array(header.length - cycleValues.length).fill("")]];
    return decisions.map((decision) => [...cycleValues, decision.decisionId, decision.timestamp, decision.actionCategory, decision.action, decision.symbol, decision.positionSide, decision.marginAllocationPct, decision.additionalMarginPct, decision.targetPositionSide, decision.leverage, decision.reductionPct, decision.confidence, decision.strategyThesis, decision.supportingFactors, decision.riskFactors, decision.evidenceUsed, decision.lessonsUsed, decision.riskGate?.status, decision.riskGate?.codes, decision.executionRequest?.tradeSide, decision.executionRequest?.positionNotional, decision.executionRequest?.clientOrderId, decision.executionResult?.providerOrderId, decision.executionResult?.status, decision.executionResult?.requestedQuantity, decision.executionResult?.executedQuantity, decision.executionResult?.providerOperation, decision.executionResult?.providerCode, decision.executionResult?.providerMessage, decision.executionResult?.providerReadbackCode, decision.executionResult?.providerReadbackMessage, decision.reconciliation?.status, decision.reconciliation?.codes, decision.providerVerified, decision.realizedPnl, decision.physicalWrites, decision.reflectionIds, decision.createdLessonIds]);
  });
  return [header, ...rows].map((row) => row.map(csvValue).join(",")).join("\r\n") + "\r\n";
}
