import { addDecimal, isDecimal } from "../trading/decimal.js";
import type { ActivityEvent, Decision, DecisionExecutionRecord, ExecutionRequest, ExecutionResult, ReconciliationResult, TradeExperience, TradingJournal } from "../types.js";
import type { StoredCycle } from "./store.js";
import { cyclePlanDecisions, decisionCategory, effectiveExecutionRequest, effectiveExecutionResult, effectiveReconciliationResult, effectiveRiskGateResult, normalizeCycleDecisions } from "./journal-normalizer.js";

export interface PaperLogPeriod {
  start: string | null;
  end: string | null;
}

export interface PaperLogExport {
  schemaVersion: string;
  export: {
    generatedAt: string;
    period: PaperLogPeriod;
    environment: string;
    paperMode: true;
    model: string;
    version: string;
    commit: string | null;
    commitStatus: "AVAILABLE" | "UNAVAILABLE";
  };
  summary: PaperLogSummary;
  recentWindow: PaperLogRecentWindow;
  closedTrades: PaperLogClosedTrade[];
  verifiedExecutions: PaperLogVerifiedExecution[];
  failureBreakdown: PaperLogFailureBreakdown;
  cycles: PaperLogCycle[];
  decisions: PaperLogDecision[];
  experiences: PaperLogExperience[];
  events: ActivityEvent[];
}

export interface PaperLogSummary {
  cycles: {
    total: number;
    completed: number;
    failed: number;
    completionRatePct: string;
  };
  decisions: Record<Decision["action"], number>;
  executions: {
    verified: number;
    unresolved: number;
  };
  closedTrades: {
    total: number;
    wins: number;
    losses: number;
    breakeven: number;
    realizedPnl: string;
    partialRealizedPnl: string;
    verifiedRealizedPnl: string;
  };
  risk: {
    currentDrawdownPct: string | null;
    maxDrawdownPct: string | null;
  };
}

export interface PaperLogRecentWindow {
  size: number;
  completed: number;
  failed: number;
  verifiedExecutions: number;
  financialWrites: number;
  start: string | null;
  end: string | null;
}

export interface PaperLogClosedTrade {
  symbol: string;
  positionSide: TradeExperience["positionSide"];
  entryPrice: string;
  exitPrice: string;
  openedAt: string;
  closedAt: string;
  realizedPnl: string | null;
  realizedPnlPct: string | null;
  outcomeStatus: TradeExperience["outcomeStatus"];
  experienceId: string;
  closeCycleId: string | null;
  verified: boolean;
}

export interface PaperLogVerifiedExecution {
  cycleId: string;
  timestamp: string;
  symbol: string;
  action: Decision["action"];
  decisionId: string;
  clientOrderId: string | null;
  providerOrderId: string | null;
  fillPrice: string | null;
  quantity: string | null;
  reconciliationStatus: string;
  realizedPnl: string | null;
}

export interface PaperLogFailureBreakdown {
  byCode: Record<string, number>;
  byStage: Record<string, number>;
}

export interface PaperLogCycle {
  cycleId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  planning: {
    scannedUniverseCount: number | null;
    selectedEntryCandidates: string[];
    managedExistingPositions: string[];
    totalProposedActions: number;
  };
  execution: {
    financialWritesPerformed: number;
    verifiedExecutions: number;
    unresolvedExecutions: number;
  };
  failure: {
    code: string | null;
    stage: string | null;
    lastSuccessfulEvent: string | null;
    executionOutcome: string | null;
  } | null;
  eventTypes: string[];
  decisionIds: string[];
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

export const PAPER_LOG_SCHEMA_VERSION = "2.1.0";
const RECENT_WINDOW_SIZE = 25;

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

function lastSuccessfulEventForFailedCycle(cycleId: string, events: readonly ActivityEvent[]): string | null {
  const cycleEvents = events
    .filter((event) => event.cycleId === cycleId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const failedIndex = cycleEvents.findIndex((event) => event.type === "CYCLE_FAILED");
  if (failedIndex <= 0) return null;
  return cycleEvents[failedIndex - 1]?.type ?? null;
}

function deriveExecutionOutcome(cycleId: string, events: readonly ActivityEvent[]): string | null {
  const cycleEvents = events.filter((event) => event.cycleId === cycleId);
  const hasVerified = cycleEvents.some((event) => event.type === "EXECUTION_VERIFIED");
  const hasSubmitted = cycleEvents.some((event) => event.type === "PAPER_ORDER_SUBMITTED");
  const hasFailed = cycleEvents.some((event) => event.type === "CYCLE_FAILED");
  if (hasVerified && hasFailed) return "VERIFIED_WRITE_BEFORE_CYCLE_FAILURE";
  if (hasSubmitted && hasFailed) return "SUBMITTED_BEFORE_CYCLE_FAILURE";
  if (hasVerified) return "VERIFIED";
  if (hasSubmitted) return "SUBMITTED";
  return null;
}

function deriveFailureStage(lastSuccessfulEvent: string | null, executionOutcome: string | null): string | null {
  if (executionOutcome === "VERIFIED_WRITE_BEFORE_CYCLE_FAILURE" && lastSuccessfulEvent === "EXECUTION_VERIFIED") return "post_write_portfolio_refresh";
  if (!lastSuccessfulEvent) return "unknown";
  const stageMap: Record<string, string> = {
    CYCLE_STARTED: "startup",
    MARKET_SCAN: "market_scan",
    CANDIDATE_SELECTION_SKIPPED: "candidate_selection",
    CANDIDATE_SELECTED: "candidate_selection",
    LESSON_REFERENCE_IGNORED: "lesson_retrieval",
    RISK_GATE_PASS: "risk_gate",
    RISK_GATE_BLOCK: "risk_gate",
    DECISION_CREATED: "decision",
    PAPER_ORDER_SUBMITTED: "execution",
    EXECUTION_VERIFIED: "execution",
    EXECUTION_UNRESOLVED: "execution",
    REFLECTION_COMPLETED: "reflection",
    LESSON_CREATED: "lesson_save",
    CYCLE_COMPLETED: "finalization",
  };
  return stageMap[lastSuccessfulEvent] ?? "unknown";
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

  const cycles = input.cycles
    .filter((cycle) => cycleIds.has(cycle.cycleId))
    .map((cycle) => {
      const journal = journalByCycle.get(cycle.cycleId);
      const cycleEvents = events.filter((event) => event.cycleId === cycle.cycleId);
      const eventTypes = cycleEvents.map((event) => event.type);
      const decisions = journal ? cycleDecisions(journal) : [];
      const physicalWrites = decisions.flatMap((decision) => decision.physicalWrites);
      const verifiedExecutions = decisions.filter((decision) => decision.action !== "REVERSE" && decision.providerVerified).length + physicalWrites.filter((write) => write.providerVerified).length;
      const unresolvedExecutions = decisions.filter((decision) => decision.action !== "REVERSE" && decision.executionResult && !decision.providerVerified).length + physicalWrites.filter((write) => write.executionStatus !== null && !write.providerVerified).length;
      const financialWritesPerformed = journal?.discovery?.financialWritesPerformed ?? (journal ? normalizeCycleDecisions(journal).records.filter((record) => Boolean(record.executionResult)).length : 0);
      const failureEvent = cycleEvents.find((event) => event.type === "CYCLE_FAILED");
      const failureCode = failureEvent?.metadata?.category ?? failureEvent?.metadata?.code ?? null;
      const lastSuccessfulEvent = cycle.status === "FAILED" ? lastSuccessfulEventForFailedCycle(cycle.cycleId, events) : null;
      const executionOutcome = cycle.status === "FAILED" ? deriveExecutionOutcome(cycle.cycleId, events) : null;
      return {
        cycleId: cycle.cycleId,
        status: cycle.status,
        startedAt: cycle.startedAt,
        completedAt: cycle.completedAt,
        durationMs: journal?.durationMs ?? null,
        planning: {
          scannedUniverseCount: journal?.discovery?.scannedUniverseCount ?? null,
          selectedEntryCandidates: journal?.discovery?.selectedEntryCandidateSymbols ?? [],
          managedExistingPositions: journal?.discovery?.managedExistingPositionSymbols ?? [],
          totalProposedActions: decisions.length,
        },
        execution: {
          financialWritesPerformed,
          verifiedExecutions,
          unresolvedExecutions,
        },
        failure: cycle.status === "FAILED" ? {
          code: failureCode,
          stage: deriveFailureStage(lastSuccessfulEvent, executionOutcome),
          lastSuccessfulEvent,
          executionOutcome,
        } : null,
        eventTypes,
        decisionIds: decisions.map((decision) => decision.decisionId),
      } as PaperLogCycle;
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const decisions = journals.flatMap(cycleDecisions);
  const experienceIds = new Set(journals.flatMap((journal) => journal.experienceIds ?? []));
  const experiences = input.experiences.filter((experience) => experienceIds.has(experience.experienceId)).map(exportExperience);

  const decisionCounts: Record<Decision["action"], number> = { HOLD: 0, OPEN_LONG: 0, OPEN_SHORT: 0, INCREASE: 0, REDUCE: 0, CLOSE: 0, REVERSE: 0 };
  for (const decision of decisions) decisionCounts[decision.action] += 1;

  const physicalWrites = decisions.flatMap((decision) => decision.physicalWrites);
  const verifiedExecutions = decisions.filter((decision) => decision.action !== "REVERSE" && decision.providerVerified).length + physicalWrites.filter((write) => write.providerVerified).length;
  const unresolvedExecutions = decisions.filter((decision) => decision.action !== "REVERSE" && decision.executionResult && !decision.providerVerified).length + physicalWrites.filter((write) => write.executionStatus !== null && !write.providerVerified).length;

  const closed = experiences.filter((experience) => ["PROFITABLE", "LOSING", "BREAK_EVEN", "CLOSED_UNCLASSIFIED"].includes(experience.outcomeStatus));
  const closedTradeRealizedPnl = closed.filter((experience) => experience.realizedPnlVerified && typeof experience.realizedPnl === "string" && isDecimal(experience.realizedPnl)).reduce((total, experience) => addDecimal(total, experience.realizedPnl ?? "0"), "0");
  const partialRealizedPnl = decisions.filter((decision) => decision.action === "REDUCE" && decision.providerVerified && decision.realizedPnl !== null && isDecimal(decision.realizedPnl)).reduce((total, decision) => addDecimal(total, decision.realizedPnl ?? "0"), "0");
  const verifiedRealizedPnl = addDecimal(closedTradeRealizedPnl, partialRealizedPnl);
  const drawdown = summarizeDrawdown(journals);

  const totalCycles = cycles.length;
  const completedCycles = cycles.filter((cycle) => cycle.status === "COMPLETED").length;
  const failedCycles = cycles.filter((cycle) => cycle.status === "FAILED").length;
  const completionRatePct = totalCycles > 0 ? ((completedCycles / totalCycles) * 100).toFixed(2) : "0.00";

  const recentCycles = cycles.slice(0, RECENT_WINDOW_SIZE);
  const recentVerifiedExecutions = recentCycles.reduce((sum, cycle) => sum + cycle.execution.verifiedExecutions, 0);
  const recentFinancialWrites = recentCycles.reduce((sum, cycle) => sum + cycle.execution.financialWritesPerformed, 0);

  const closedTrades: PaperLogClosedTrade[] = closed
    .filter((experience) => experience.realizedPnlVerified)
    .map((experience) => ({
      symbol: experience.symbol,
      positionSide: experience.positionSide,
      entryPrice: experience.entryPrice,
      exitPrice: experience.exitPrice,
      openedAt: experience.entryTime,
      closedAt: experience.exitTime,
      realizedPnl: experience.realizedPnl,
      realizedPnlPct: experience.realizedPnlPct,
      outcomeStatus: experience.outcomeStatus,
      experienceId: experience.experienceId,
      closeCycleId: null,
      verified: experience.realizedPnlVerified === true,
    }));

  const verifiedExecutionsList: PaperLogVerifiedExecution[] = decisions
    .filter((decision) => decision.providerVerified)
    .map((decision) => ({
      cycleId: decision.cycleId,
      timestamp: decision.timestamp,
      symbol: decision.symbol,
      action: decision.action,
      decisionId: decision.decisionId,
      clientOrderId: decision.executionRequest?.clientOrderId ?? null,
      providerOrderId: decision.executionResult?.providerOrderId ?? null,
      fillPrice: decision.executionResult?.averageFillPrice ?? null,
      quantity: decision.executionResult?.executedQuantity ?? null,
      reconciliationStatus: decision.reconciliation?.status ?? "MATCHED",
      realizedPnl: decision.realizedPnl,
    }));

  const failureEvents = events.filter((event) => event.type === "CYCLE_FAILED");
  const byCode: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  for (const event of failureEvents) {
    const code = event.metadata?.category ?? event.metadata?.code ?? "UNKNOWN";
    byCode[code] = (byCode[code] ?? 0) + 1;
    const lastEvent = lastSuccessfulEventForFailedCycle(event.cycleId, events);
    const outcome = deriveExecutionOutcome(event.cycleId, events);
    const stage = deriveFailureStage(lastEvent, outcome) ?? "unknown";
    byStage[stage] = (byStage[stage] ?? 0) + 1;
  }

  const commitValue = input.commit?.trim();
  const commitStatus: "AVAILABLE" | "UNAVAILABLE" = commitValue && commitValue !== "unknown" && commitValue !== "local" ? "AVAILABLE" : "UNAVAILABLE";

  return {
    schemaVersion: PAPER_LOG_SCHEMA_VERSION,
    export: {
      generatedAt: input.generatedAt,
      period: input.period,
      environment: input.environment,
      paperMode: true,
      model: input.model,
      version: input.version,
      commit: commitValue && commitValue !== "unknown" && commitValue !== "local" ? commitValue : null,
      commitStatus,
    },
    summary: {
      cycles: {
        total: totalCycles,
        completed: completedCycles,
        failed: failedCycles,
        completionRatePct,
      },
      decisions: decisionCounts,
      executions: {
        verified: verifiedExecutions,
        unresolved: unresolvedExecutions,
      },
      closedTrades: {
        total: closed.length,
        wins: closed.filter((experience) => experience.outcomeStatus === "PROFITABLE").length,
        losses: closed.filter((experience) => experience.outcomeStatus === "LOSING").length,
        breakeven: closed.filter((experience) => experience.outcomeStatus === "BREAK_EVEN").length,
        realizedPnl: closedTradeRealizedPnl,
        partialRealizedPnl,
        verifiedRealizedPnl,
      },
      risk: {
        currentDrawdownPct: drawdown.current,
        maxDrawdownPct: drawdown.maximum,
      },
    },
    recentWindow: {
      size: RECENT_WINDOW_SIZE,
      completed: recentCycles.filter((cycle) => cycle.status === "COMPLETED").length,
      failed: recentCycles.filter((cycle) => cycle.status === "FAILED").length,
      verifiedExecutions: recentVerifiedExecutions,
      financialWrites: recentFinancialWrites,
      start: recentCycles.length > 0 ? recentCycles[recentCycles.length - 1]?.startedAt ?? null : null,
      end: recentCycles.length > 0 ? recentCycles[0]?.startedAt ?? null : null,
    },
    closedTrades,
    verifiedExecutions: verifiedExecutionsList,
    failureBreakdown: {
      byCode,
      byStage,
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
  const header = ["cycleId", "cycleStatus", "cycleStartedAt", "cycleCompletedAt", "eventTypes", "scannedUniverseCount", "selectedEntryCandidates", "managedExistingPositions", "totalProposedActions", "financialWritesPerformed", "decisionId", "decisionTimestamp", "actionCategory", "action", "symbol", "positionSide", "marginAllocationPct", "additionalMarginPct", "targetPositionSide", "leverage", "reductionPct", "confidence", "strategyThesis", "supportingFactors", "riskFactors", "evidenceUsed", "lessonsUsed", "riskGateStatus", "riskGateCodes", "tradeSide", "positionNotional", "clientOrderId", "providerOrderId", "executionStatus", "requestedQuantity", "executedQuantity", "providerOperation", "providerCode", "providerMessage", "providerReadbackCode", "providerReadbackMessage", "reconciliationStatus", "reconciliationCodes", "providerVerified", "realizedPnl", "physicalWrites", "reflectionIds", "createdLessonIds", "closedTradeRealizedPnl", "partialRealizedPnl", "verifiedRealizedPnl", "closedTrades", "wins", "losses", "breakeven", "winRatePct"];
  const summaryValues = [exported.summary.closedTrades.realizedPnl, exported.summary.closedTrades.partialRealizedPnl, exported.summary.closedTrades.verifiedRealizedPnl, exported.summary.closedTrades.total, exported.summary.closedTrades.wins, exported.summary.closedTrades.losses, exported.summary.closedTrades.breakeven, exported.summary.closedTrades.total > 0 ? (exported.summary.closedTrades.wins * 100 / exported.summary.closedTrades.total).toString() : "UNAVAILABLE"];
  const rows = exported.cycles.flatMap((cycle) => {
    const decisions = exported.decisions.filter((decision) => decision.cycleId === cycle.cycleId);
    const cycleValues = [cycle.cycleId, cycle.status, cycle.startedAt, cycle.completedAt, cycle.eventTypes, cycle.planning.scannedUniverseCount, cycle.planning.selectedEntryCandidates, cycle.planning.managedExistingPositions, cycle.planning.totalProposedActions, cycle.execution.financialWritesPerformed];
    if (!decisions.length) return [[...cycleValues, ...Array(header.length - cycleValues.length - summaryValues.length).fill(""), ...summaryValues]];
    return decisions.map((decision) => [...cycleValues, decision.decisionId, decision.timestamp, decision.actionCategory, decision.action, decision.symbol, decision.positionSide, decision.marginAllocationPct, decision.additionalMarginPct, decision.targetPositionSide, decision.leverage, decision.reductionPct, decision.confidence, decision.strategyThesis, decision.supportingFactors, decision.riskFactors, decision.evidenceUsed, decision.lessonsUsed, decision.riskGate?.status, decision.riskGate?.codes, decision.executionRequest?.tradeSide, decision.executionRequest?.positionNotional, decision.executionRequest?.clientOrderId, decision.executionResult?.providerOrderId, decision.executionResult?.status, decision.executionResult?.requestedQuantity, decision.executionResult?.executedQuantity, decision.executionResult?.providerOperation, decision.executionResult?.providerCode, decision.executionResult?.providerMessage, decision.executionResult?.providerReadbackCode, decision.executionResult?.providerReadbackMessage, decision.reconciliation?.status, decision.reconciliation?.codes, decision.providerVerified, decision.realizedPnl, decision.physicalWrites, decision.reflectionIds, decision.createdLessonIds, ...summaryValues]);
  });
  return [header, ...rows].map((row) => row.map(csvValue).join(",")).join("\r\n") + "\r\n";
}
