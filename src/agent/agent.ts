import { Agent } from "agents";
import { ZodError } from "zod";
import type { ActivityEvent, BacktestReplay, CycleDecisionPlan, CycleDiscovery, DashboardSnapshot, Decision, DecisionExecutionRecord, Env, EvidenceBundle, LatestValidCyclePlan, Lesson, NormalizedCycleDecisions, OwnerPolicy, PositionContext, PositionManagementState, PositionSnapshot, PositionSide, ProviderExecutionFact, ReflectionResult, ResearchCycleSummary, ResearchEvidence, ResearchPlan, RuntimeConfig, TradeExperience, TradeLifecycleStatus, TradingJournal } from "../types.js";
import { loadConfig } from "../config.js";
import { BitgetClient } from "../bitget/client.js";
import { syncProviderLedger, PROVIDER_FINANCIAL_CATEGORIES, PROVIDER_TRADE_LIFECYCLE_CATEGORY } from "../bitget/provider-sync.js";
import { MANDATE_VERSION, PROMPT_VERSIONS, TRADING_MANDATE } from "./mandate.js";
import { assertOpenPositionCountWithinPlanLimit, buildEvidenceSymbols, calculateActionCapacity, countOpenPositionLifecycles, decide, filterNewEntryMarketCandidates, rankMarketCandidates, selectEntryCandidates } from "./decision.js";
import { QwenJsonError } from "./qwen.js";
import { reconcileTradingSchedule, reconcileProviderLedgerSchedule, PROVIDER_LEDGER_INTERVAL_SECONDS, temporaryScanIntervalActive, TEMPORARY_SCAN_INTERVAL_DURATION_MS, TEMPORARY_SCAN_INTERVAL_MINUTES, type SchedulerReconciliationResult } from "./scheduler.js";
import { authorizeOwner } from "./owner-auth.js";
import { retrieveLessons } from "../learning/lesson-retrieval.js";
import { reflect, reflectWithQwen } from "../learning/reflection.js";
import { backtestFailureMetadata, createBacktestLesson, runCooldownBacktestSafely } from "../learning/backtest.js";
import { ensureStorage, type SqlExecutor } from "../storage/schema.js";
import {
  loadLatestBacktest,
  loadLatestJournal,
  loadAllAutonomousJournals,
  loadAllEvents,
  loadEventById,
  loadAllExperiences,
  loadExperiencesForDecisionIds,
  loadAllStoredCycles,
  loadRecentStoredCycles,
  loadRecentJournals,
  loadRecentEvents,
  loadRecentLessons,
  loadOpenExperiences,
  loadJournalsForDecisionIds,
  loadJournalForExactDecisionCycle,
  loadUsableLessons,
  loadPerformanceAggregate,
  savePerformanceAggregate,
  loadLatestValidCyclePlan,
  loadLatestCompletedCyclePlanFromHistory,
  saveLatestValidCyclePlan,
  loadPositionContext,
  loadPositionContextsForKeys,
  savePositionContext,
  loadPositionContextBootstrap,
  savePositionContextBootstrap,
  loadDailyDrawdownState,
  loadExperiences,
  loadExperienceById,
  loadActiveOwnerPolicy,
  clampHistoryLimit,
  recordIdempotency,
  recordProviderOrderReference,
  recordLessonApplication,
  recordLessonRetrieval,
  saveBacktest,
  saveCycle,
  saveDailyDrawdownState,
  saveActiveOwnerPolicy,
  saveEvent,
  saveExperience,
  saveJournal,
  saveLesson,
  persistProviderLifecycleRepair,
} from "../storage/store.js";
import { buildPaperLogExport, parsePaperLogPeriod, paperLogToCsv } from "../storage/paper-log.js";
import { cyclePlanDecisions, cycleReadModel, normalizeCycleDecisions } from "../storage/journal-normalizer.js";
import { evaluateRiskGate } from "../trading/risk-gate.js";
import { evaluateDrawdown } from "../trading/drawdown.js";
import { loadOwnerPolicy, updateOwnerPolicy } from "../trading/policy.js";
import { buildExecutionClientOrderId, buildExecutionRequest, executePaperOrder } from "../trading/execution.js";
import { executeCyclePlan } from "../trading/execution-planner.js";
import { reconcileExecution } from "../trading/reconcile.js";
import { addDecimal, compareDecimal, isDecimal, isPositiveDecimal } from "../trading/decimal.js";
import { buildPerformanceAccounting, classifiedWinRate, emptyPerformance, isPerformanceAggregate, migratePerformanceEquityObservations, PERFORMANCE_READ_MODEL_VERSION, POSITION_CONTEXT_READ_MODEL_VERSION, updateEquity, verifiedLifecycleFacts, type PerformanceAggregate, type PerformanceObservation } from "../trading/performance.js";
import { bootstrapPositionContexts, decisionReasoning, upsertPositionContext } from "./position-context.js";
import { isReadbackOnlyExecutionMismatch, parseProviderFillEvidence, parseProviderOrderEvidence, reconcileLateExecution } from "../trading/late-reconciliation.js";
import { EvaClient } from "../eva/client.js";
import { EVA_AGENT_NAME, EVA_CAPABILITIES, EVA_EXECUTION_PROVIDERS, EVA_PROTOCOL_VERSION } from "../eva/types.js";
import { availableResearchCapabilities } from "../research/capabilities.js";
import { ResearchExecutor, type ResearchExecutionTelemetryCallback } from "../research/executor.js";
import { ResearchRouter, validateResearchPlan, type ResearchRouterInput } from "../research/router.js";
import { buildExecutionCapacityHints } from "../trading/execution-capacity.js";
import { buildPositionManagementState, reconstructMaximumFavorableReturnPct } from "../trading/position-management.js";
import { providerLedgerDiagnostics, loadProviderLifecycleEvidence, loadProviderLifecycleEvidenceBatch, loadProviderPositionHistories, loadProviderPositionHistoriesPage, loadProviderPositionHistoryDecisionIds, loadProviderLiveOpeningOrderIdentities, loadProviderExitExecutionFacts, providerLivePositionLifecycleKey, loadProviderSyncStates, type ProviderLifecycleEvidenceRequest, type ProviderPositionHistoryCursor } from "../storage/provider-ledger.js";
import { calculateNetPnlSinceBaseline, isFinancialRecordCoverageComplete } from "../trading/external-flow.js";
import { resolveExternalFlowReadModel } from "../trading/external-flow-read-model.js";
import { classifyProviderLifecycle, summarizeProviderLifecycleFillQuantities, type ProviderLifecycleClassification, type ProviderLifecycleHistory, type ProviderLifecycleEvidence, type ProviderLifecycleCandidateOrder, type ProviderLifecycleCandidateFill } from "../trading/provider-lifecycle-reconciliation.js";
import { rebuildProviderPerformance, type ProviderPerformanceLifecycle, type ProviderPerformanceTotals } from "../trading/provider-performance.js";
import { resolveProviderPerformanceReadModel } from "../trading/provider-performance-read-model.js";

class ProviderLifecycleClassificationError extends Error {
  public constructor(readonly classification: ProviderLifecycleClassification, readonly reason: string) {
    super(`PROVIDER_LIFECYCLE_${classification}:${reason}`);
  }
}



interface AgentState {
  emergencyStop: boolean;
  paused: boolean;
  lastCycleId: string | null;
  lastScanAt: string | null;
  nextScanAt: string | null;
  model: string;
  runtimeStatus: DashboardSnapshot["agent"]["status"];
  currentStage: string;
  lastStatus: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
  lastPolicyUpdateAt: string | null;
  cycleStartedAt: string | null;
  temporaryScanIntervalExpiresAt: string | null;
  temporaryScanIntervalCompleted: boolean;
  temporaryScanIntervalDurationMs: number;
  userStorageVersion: number;
}

const STALE_CYCLE_TIMEOUT_MS = 120_000;
const USER_STORAGE_VERSION = 6;
const LATEST_VALID_PLAN_MIGRATION_VERSION = 5;
const SNAPSHOT_EVENT_LIMIT = 25;

const MAX_FAILURE_DIAGNOSTIC_LENGTH = 240;

function boundedDiagnosticText(value: unknown, limit = MAX_FAILURE_DIAGNOSTIC_LENGTH): string {
  return String(value ?? "").replace(/\s+/g, " ").replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]").replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]").slice(0, limit);
}

function safeDiagnosticMessage(value: unknown, fallback: string): string {
  const text = boundedDiagnosticText(value);
  if (!text || /(prompt|system\s+message|api[_-]?key|bearer\s|secret|password|authorization)/i.test(text)) return fallback;
  return text;
}

export function failureDiagnostic(error: unknown): Record<string, string> {
  if (error instanceof ZodError) {
    const issues = error.issues.slice(0, 3);
    const first = issues[0];
    const diagnostic: Record<string, string> = {
      category: "ZOD_VALIDATION_FAILED",
      code: "ZOD_VALIDATION_FAILED",
      issueCount: String(Math.min(error.issues.length, 999)),
      firstIssuePath: boundedDiagnosticText(first?.path.map(String).join(".") || "root"),
      firstIssueCode: boundedDiagnosticText(first?.code || "unknown", 80),
      firstIssueMessage: safeDiagnosticMessage(first?.message, "Validation failed"),
    };
    issues.slice(1).forEach((issue, index) => {
      const number = index + 2;
      diagnostic[`issue${number}Path`] = boundedDiagnosticText(issue.path.map(String).join(".") || "root");
      diagnostic[`issue${number}Code`] = boundedDiagnosticText(issue.code || "unknown", 80);
      diagnostic[`issue${number}Message`] = safeDiagnosticMessage(issue.message, "Validation failed");
    });
    return diagnostic;
  }
  const rawMessage = error instanceof Error ? error.message : "Unknown runtime error";
  const normalizedMessage = boundedDiagnosticText(rawMessage);
  const candidateCode = normalizedMessage.split(":", 1)[0]?.trim() ?? "";
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(candidateCode) ? candidateCode : "RUNTIME_ERROR";
  const detail = normalizedMessage.includes(":") ? normalizedMessage.slice(normalizedMessage.indexOf(":") + 1).trim() : "Runtime error";
  const parserStage = error instanceof QwenJsonError ? error.diagnostic.parserStage : undefined;
  return { category: "RUNTIME_ERROR", code, message: safeDiagnosticMessage(detail, "Runtime error"), ...(parserStage ? { parserStage } : {}) };
}

export function appendExecutionRecordToJournal(journal: TradingJournal, record: DecisionExecutionRecord, discovery: CycleDiscovery): void {
  const existing = journal.executionRecords ?? [];
  const recordIndex = existing.findIndex((candidate) => candidate.decision.decisionId === record.decision.decisionId);
  const executionRecords = recordIndex >= 0
    ? existing.map((candidate, index) => index === recordIndex ? record : candidate)
    : [...existing, record];
  journal.executionRecords = executionRecords;
  journal.discovery = {
    ...(journal.discovery ?? discovery),
    financialWritesPerformed: executionRecords.filter((candidate) => Boolean(candidate.executionResult)).length,
  };
}

function schedulerMetrics(events: readonly { type: string; metadata?: Record<string, string> }[]): DashboardSnapshot["scheduler"] {
  const durations = events.flatMap((event) => event.type === "CYCLE_COMPLETED" && event.metadata?.durationMs ? [Number(event.metadata.durationMs)] : []).filter((value) => Number.isFinite(value));
  return {
    completedCycles: durations.length,
    averageDurationMs: durations.length ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length) : 0,
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
    inProgressCount: events.filter((event) => event.type === "CYCLE_IN_PROGRESS").length,
    staleCount: events.filter((event) => event.type === "CYCLE_STALE").length,
    failureCount: events.filter((event) => event.type === "CYCLE_FAILED" || event.type === "SCHEDULE_CALLBACK_FAILED").length,
    timeoutCount: events.filter((event) => event.type === "CYCLE_TIMEOUT").length,
    nextScanAt: null,
    nextScanStale: false,
    configuredIntervalMinutes: 0,
    matchingScheduleCount: 0,
    schedulerHealthy: false,
    tradingSchedulerHealthy: false,
    providerSyncSchedulerHealthy: false,
  };
}

function tradeLifecycleStatus(experience: TradeExperience): TradeLifecycleStatus {
  if (experience.outcomeStatus === "OPEN") return experience.lastAction === "REDUCE" ? "PARTIALLY_REDUCED" : "OPEN";
  if (experience.outcomeStatus === "PROFITABLE" || experience.outcomeStatus === "LOSING" || experience.outcomeStatus === "BREAK_EVEN" || experience.outcomeStatus === "CLOSED_UNCLASSIFIED") return "CLOSED";
  if (experience.outcomeStatus === "BLOCKED") return "BLOCKED";
  if (experience.outcomeStatus === "EXECUTION_UNRESOLVED") return "UNRESOLVED";
  return "EXECUTION_FAILURE";
}

interface ResolvedProviderTradeFact {
  source: "PROVIDER_LEDGER" | "PROVIDER_LIVE" | "PROVIDER_EXECUTION" | "UNRESOLVED";
  history?: ProviderLifecycleHistory;
  position?: PositionSnapshot;
  execution?: ProviderExecutionFact;
  providerPositionHistoryId?: string;
  providerOrderId?: string;
  unresolvedReason?: string;
  origin: "DARWIN" | "PROVIDER_EXTERNAL" | "UNATTRIBUTED";
}

function providerHistoryProbeExperience(history: ProviderLifecycleHistory, decisionId: string, isOpen: boolean): TradeExperience {
  return {
    experienceId: `provider-history:${history.providerPositionHistoryId}`,
    symbol: history.symbol,
    positionSide: history.positionSide as TradeExperience["positionSide"],
    action: history.positionSide === "SHORT" ? "OPEN_SHORT" : "OPEN_LONG",
    entryDecisionId: decisionId,
    entryPrice: history.avgEntryPrice ?? "0",
    entryTime: history.openingTime,
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: history.closingTime,
    selectedLeverage: "UNAVAILABLE",
    marginAllocationPct: "UNAVAILABLE",
    marginAllocated: "UNAVAILABLE",
    positionNotional: "UNAVAILABLE",
    realizedPnl: "UNAVAILABLE",
    realizedPnlPct: "UNAVAILABLE",
    maximumFavorableExcursion: "0",
    maximumAdverseExcursion: "0",
    drawdownContribution: "0",
    liquidationDistance: "0",
    entryThesis: "",
    exitThesis: "",
    evidenceAtEntry: [],
    evidenceAtExit: [],
    lessonsUsed: [],
    marketContext: "",
    outcomeStatus: isOpen ? "OPEN" : "CLOSED_UNCLASSIFIED",
  };
}

function providerLiveProbeExperience(position: PositionSnapshot, decisionId: string): TradeExperience {
  return {
    experienceId: `provider-live:${decisionId}`,
    symbol: position.symbol,
    positionSide: position.positionSide,
    action: position.positionSide === "SHORT" ? "OPEN_SHORT" : "OPEN_LONG",
    entryDecisionId: decisionId,
    entryPrice: position.entryPrice ?? "0",
    entryTime: position.openedAt ?? "",
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: "",
    selectedLeverage: "UNAVAILABLE",
    marginAllocationPct: "UNAVAILABLE",
    marginAllocated: "UNAVAILABLE",
    positionNotional: "UNAVAILABLE",
    realizedPnl: "UNAVAILABLE",
    realizedPnlPct: "UNAVAILABLE",
    maximumFavorableExcursion: "0",
    maximumAdverseExcursion: "0",
    drawdownContribution: "0",
    liquidationDistance: "0",
    entryThesis: "",
    exitThesis: "",
    evidenceAtEntry: [],
    evidenceAtExit: [],
    lessonsUsed: [],
    marketContext: "",
    outcomeStatus: "OPEN",
  };
}

interface ProviderTradeFactResolutionOptions {
  histories?: readonly ProviderLifecycleHistory[];
  historyDecisionIds?: ReadonlyMap<string, string>;
  historyLimit?: number;
  openPositionIdentities?: ReadonlyMap<string, { providerOrderId: string; decisionId: string }>;
  positionContexts?: ReadonlyMap<string, PositionContext>;
}

export function resolveProviderTradeFacts(
  executor: SqlExecutor,
  experiences: readonly TradeExperience[],
  category: string,
  positions: readonly PositionSnapshot[],
  options: ProviderTradeFactResolutionOptions = {},
): { facts: Map<string, ResolvedProviderTradeFact>; lifecycles: ProviderPerformanceLifecycle[]; providerOnlyHistories: Array<{ history: ProviderLifecycleHistory; decisionId: string; providerOrderId: string; managementExecutions: ProviderExecutionFact[] }>; providerOnlyOpenPositions: Array<{ position: PositionSnapshot; providerOrderId: string; decisionId: string; managementExecutions: ProviderExecutionFact[] }> } {
  const facts = new Map<string, ResolvedProviderTradeFact>();
  const lifecycles: ProviderPerformanceLifecycle[] = [];
  const histories = options.histories ? [...options.histories] : loadProviderPositionHistories(executor, category, options.historyLimit);
  const historyDecisionIds = options.historyDecisionIds ?? loadProviderPositionHistoryDecisionIds(executor, category, histories);
  const openPositionIdentities = options.openPositionIdentities ?? loadProviderLiveOpeningOrderIdentities(executor, category, positions);
  const historiesByDecision = new Map<string, Array<{ history: ProviderLifecycleHistory; historyId: string; probeId: string; decisionId: string }>>();
  const canonicalHistories = new Map<string, { history: ProviderLifecycleHistory; decisionId: string; providerOrderId: string; managementExecutions: ProviderExecutionFact[] }>();
  const canonicalHistoryEvidence = new Map<string, ProviderLifecycleEvidence>();
  const canonicalOpenPositions = new Map<string, { position: PositionSnapshot; providerOrderId: string; decisionId: string; managementExecutions: ProviderExecutionFact[] }>();

  const historyEvidenceRequests = histories.flatMap((history) => {
    const historyId = history.providerPositionHistoryId;
    if (!historyId || history.origin === "PROVIDER_EXTERNAL") return [];
    const decisionId = historyDecisionIds.get(historyId);
    if (!decisionId) return [];
    const historyHasClose = Boolean(history.openTotalPos && history.closeTotalPos && isPositiveDecimal(history.closeTotalPos)
      && compareDecimal(history.openTotalPos, history.closeTotalPos) === 0
      && history.closingTime && Number.isFinite(Date.parse(history.closingTime)));
    const livePosition = !historyHasClose ? positions.find((position) => position.symbol === history.symbol && position.positionSide === history.positionSide && isPositiveDecimal(position.quantity)) : undefined;
    const probeId = `provider-history:${historyId}`;
    return [{ requestId: probeId, experience: providerHistoryProbeExperience(history, decisionId, Boolean(livePosition)), history, ...(livePosition ? { providerPosition: livePosition } : {}) }];
  });
  const historyEvidence = loadProviderLifecycleEvidenceBatch(executor, category, historyEvidenceRequests);
  for (const request of historyEvidenceRequests) {
    const { history, experience, requestId } = request;
    const historyId = history.providerPositionHistoryId;
    const decisionId = historyId ? historyDecisionIds.get(historyId) : undefined;
    if (!historyId || !decisionId) continue;
    const evidence = historyEvidence.get(requestId);
    const classification = classifyProviderLifecycle(evidence ?? {
      experience,
      providerPositions: request.providerPosition ? [request.providerPosition] : [],
      history,
      entryIdentity: null,
      orders: [],
      fills: [],
      evidenceComplete: false,
    }).classification;
    if (classification === "MATCHED_CLOSED" || classification === "LOCAL_OPEN_PROVIDER_CLOSED") {
      const probeId = `provider-history:${historyId}`;
      facts.set(probeId, { source: "PROVIDER_LEDGER", history, providerPositionHistoryId: historyId, ...(evidence?.entryIdentity?.providerOrderId ? { providerOrderId: evidence.entryIdentity.providerOrderId } : {}), origin: "DARWIN" });
      lifecycles.push({ lifecycleId: historyId, origin: "DARWIN", status: "CLOSED", ...(history.netProfit === null ? {} : { netProfit: history.netProfit }), ...(history.closingTime ? { closedAt: history.closingTime } : {}) });
      const matches = historiesByDecision.get(decisionId) ?? [];
      matches.push({ history, historyId, probeId, decisionId });
      historiesByDecision.set(decisionId, matches);
      canonicalHistories.set(historyId, { history, decisionId, providerOrderId: evidence?.entryIdentity?.providerOrderId ?? "", managementExecutions: [] });
      if (evidence) canonicalHistoryEvidence.set(historyId, evidence);
    }
  }

  const liveEvidenceRequests: ProviderLifecycleEvidenceRequest[] = [];
  const liveIdentitiesByRequestId = new Map<string, { providerOrderId: string; decisionId: string }>();
  for (const position of positions.filter((candidate) => isPositiveDecimal(candidate.quantity))) {
    const identity = openPositionIdentities.get(providerLivePositionLifecycleKey(position));
    if (!identity) continue;
    const requestId = `provider-live:${providerLivePositionLifecycleKey(position)}`;
    liveEvidenceRequests.push({ requestId, experience: providerLiveProbeExperience(position, identity.decisionId), history: null, providerPosition: position });
    liveIdentitiesByRequestId.set(requestId, identity);
  }
  const liveEvidence = loadProviderLifecycleEvidenceBatch(executor, category, liveEvidenceRequests);
  const openPositionsByDecision = new Map<string, Array<{ position: PositionSnapshot; providerOrderId: string; decisionId: string }>>();
  for (const request of liveEvidenceRequests) {
    const identity = liveIdentitiesByRequestId.get(request.requestId);
    if (!identity) continue;
    const classification = classifyProviderLifecycle(liveEvidence.get(request.requestId) ?? {
      experience: request.experience,
      providerPositions: request.providerPosition ? [request.providerPosition] : [],
      history: null,
      entryIdentity: null,
      orders: [],
      fills: [],
      evidenceComplete: false,
    }).classification;
    if (classification !== "MATCHED_OPEN") continue;
    const position = request.providerPosition as PositionSnapshot;
    const lifecycleId = `open:${identity.providerOrderId}`;
    canonicalOpenPositions.set(identity.providerOrderId, { position, providerOrderId: identity.providerOrderId, decisionId: identity.decisionId, managementExecutions: [] });
    if (!lifecycles.some((lifecycle) => lifecycle.lifecycleId === lifecycleId)) lifecycles.push({ lifecycleId, origin: "DARWIN", status: "OPEN" });
    const matches = openPositionsByDecision.get(identity.decisionId) ?? [];
    matches.push({ position, providerOrderId: identity.providerOrderId, decisionId: identity.decisionId });
    openPositionsByDecision.set(identity.decisionId, matches);
  }

  // Local experiences only enrich already-resolved provider facts; they never create financial lifecycles.
  for (const experience of experiences) {
    if (!experience.positionSide) {
      facts.set(experience.experienceId, { source: "UNRESOLVED", origin: "UNATTRIBUTED", unresolvedReason: "LOCAL_POSITION_SIDE_MISSING" });
      continue;
    }
    const closed = (historiesByDecision.get(experience.entryDecisionId) ?? []).filter(({ history }) => history.symbol === experience.symbol && history.positionSide === experience.positionSide);
    const opened = (openPositionsByDecision.get(experience.entryDecisionId) ?? []).filter(({ position }) => position.symbol === experience.symbol && position.positionSide === experience.positionSide);
    if (closed.length === 1 && opened.length === 0) {
      const candidate = closed[0]!;
      facts.set(experience.experienceId, facts.get(candidate.probeId)!);
    } else if (opened.length === 1 && closed.length === 0) {
      const candidate = opened[0]!;
      facts.set(experience.experienceId, { source: "PROVIDER_LIVE", position: candidate.position, providerOrderId: candidate.providerOrderId, origin: "DARWIN" });
    } else {
      facts.set(experience.experienceId, {
        source: "UNRESOLVED",
        origin: "UNATTRIBUTED",
        unresolvedReason: closed.length > 1 || opened.length > 1 ? "AMBIGUOUS_PROVIDER_LIFECYCLE_MATCH" : "NO_CANONICAL_PROVIDER_LIFECYCLE_MATCH",
      });
    }
  }

  const executionFacts = loadProviderExitExecutionFacts(executor, category, experiences);
  for (const experience of experiences) {
    const execution = executionFacts.get(experience.experienceId);
    if (!execution) continue;
    const executionTimes = execution.fills.map((fill) => Date.parse(fill.filledAt)).filter(Number.isFinite);
    const matches = [...canonicalHistories.entries()].filter(([historyId, canonical]) => {
      if (canonical.history.symbol !== execution.symbol || canonical.history.positionSide !== execution.positionSide) return false;
      const evidence = canonicalHistoryEvidence.get(historyId);
      const exactOrder = evidence?.orders.some((order) => order.providerOrderId === execution.providerOrderId && order.clientOid === execution.clientOrderId && order.origin === "DARWIN")
        || evidence?.fills.some((fill) => fill.providerOrderId === execution.providerOrderId && fill.clientOid === execution.clientOrderId && fill.origin === "DARWIN");
      const openedAt = Date.parse(canonical.history.openingTime);
      const closedAt = Date.parse(canonical.history.closingTime);
      const insideLifecycle = Number.isFinite(openedAt) && Number.isFinite(closedAt) && executionTimes.some((time) => time >= openedAt && time <= closedAt);
      return Boolean(exactOrder && insideLifecycle);
    });
    if (matches.length === 1) {
      const [historyId, canonical] = matches[0]!;
      if (!canonical.managementExecutions.some((item) => item.providerOrderId === execution.providerOrderId)) canonical.managementExecutions.push(execution);
      facts.set(experience.experienceId, { source: "PROVIDER_LEDGER", history: canonical.history, providerPositionHistoryId: historyId, ...(canonical.providerOrderId ? { providerOrderId: canonical.providerOrderId } : {}), execution, origin: "DARWIN" });
      continue;
    }
    const context = options.positionContexts?.get(`${execution.symbol}:${execution.positionSide}`);
    const localAction = experience.lastAction && experience.lastAction !== "HOLD" ? experience.lastAction : experience.action;
    const hasExactManagementEvent = Boolean(context && experience.exitDecisionId === execution.decisionId && context.managementEvents.some((event) => event.decisionId === execution.decisionId && event.action === localAction));
    const openMatches = hasExactManagementEvent ? [...canonicalOpenPositions.values()].filter((canonical) => {
      if (canonical.position.symbol !== execution.symbol || canonical.position.positionSide !== execution.positionSide || canonical.decisionId !== context?.entryDecisionId) return false;
      const openedAt = Date.parse(canonical.position.openedAt ?? "");
      return Number.isFinite(openedAt) && executionTimes.length > 0 && executionTimes.every((time) => time >= openedAt);
    }) : [];
    if (openMatches.length === 1) {
      const canonical = openMatches[0]!;
      if (!canonical.managementExecutions.some((item) => item.providerOrderId === execution.providerOrderId)) canonical.managementExecutions.push(execution);
      facts.set(experience.experienceId, { source: "PROVIDER_LIVE", position: canonical.position, providerOrderId: canonical.providerOrderId, origin: "DARWIN" });
      continue;
    }
    if (facts.get(experience.experienceId)?.source === "UNRESOLVED") facts.set(experience.experienceId, { source: "PROVIDER_EXECUTION", execution, origin: "DARWIN" });
  }

  return { facts, lifecycles, providerOnlyHistories: [...canonicalHistories.values()], providerOnlyOpenPositions: [...canonicalOpenPositions.values()] };
}

function tradeLogEntries(
  experiences: readonly TradeExperience[],
  journals: readonly TradingJournal[],
  contexts: ReadonlyMap<string, PositionContext> = new Map(),
  financialFacts: ReadonlyMap<string, ResolvedProviderTradeFact> = new Map(),
): DashboardSnapshot["trades"] {
  const decisions = journals.flatMap((journal) => cyclePlanDecisions(journal));
  const verifiedOpenIds = verifiedLifecycleFacts(journals).verifiedOpenIds;
  return experiences.filter((experience) => experience.action !== "HOLD").map((experience) => {
    const context = experience.positionSide ? contexts.get(`${experience.symbol}:${experience.positionSide}`) : undefined;
    const entryDecision = decisions.find((candidate) => verifiedOpenIds.has(candidate.decisionId) && candidate.decisionId === experience.entryDecisionId && (candidate.action === "OPEN_LONG" || candidate.action === "OPEN_SHORT"));
    const exitDecision = decisions.find((candidate) => candidate.decisionId === experience.exitDecisionId);
    const lifecycleDecisions = decisions.filter((candidate) => candidate.symbol === experience.symbol && candidate.positionSide === experience.positionSide && candidate.action !== "OPEN_LONG" && candidate.action !== "OPEN_SHORT" && (!experience.exitTime || candidate.createdAt <= experience.exitTime) && candidate.createdAt >= experience.entryTime);
    const journal = journals.find((entry) => entry.experienceId === experience.experienceId || (entry.experienceIds ?? []).includes(experience.experienceId) || entry.decision?.decisionId === experience.exitDecisionId || entry.decision?.decisionId === experience.entryDecisionId);
    const record = journal ? normalizeCycleDecisions(journal).records.find((candidate) => candidate.decision.decisionId === experience.exitDecisionId || candidate.decision.decisionId === experience.entryDecisionId) : undefined;
    const action = (experience.lastAction && experience.lastAction !== "HOLD" ? experience.lastAction : experience.action) as Exclude<TradeExperience["action"], "HOLD">;
    const entryReasoning = context?.entryDecisionId === experience.entryDecisionId ? context.entryReasoning : entryDecision ? decisionReasoning(entryDecision) : undefined;
    const exitReasoning = exitDecision ? decisionReasoning(exitDecision) : undefined;
    const managementEvents = context?.entryDecisionId === experience.entryDecisionId ? context.managementEvents : lifecycleDecisions.map(decisionReasoning);
    const facts = financialFacts.get(experience.experienceId);
    const history = facts?.history;
    const livePosition = facts?.position;
    const providerExecution = facts?.source === "PROVIDER_EXECUTION" ? facts.execution : undefined;
    const isProviderClosed = facts?.source === "PROVIDER_LEDGER" && history !== undefined;
    const isProviderLive = facts?.source === "PROVIDER_LIVE" && livePosition !== undefined;
    const openedAt = history?.openingTime ?? livePosition?.openedAt ?? "UNAVAILABLE";
    const closedAt = history?.closingTime;
    const persistedReasoning = Boolean(entryReasoning || exitReasoning || managementEvents.length || experience.entryThesis.trim());
    const financialStatus = experience.outcomeStatus === "BLOCKED" ? "BLOCKED" : isProviderClosed ? "CLOSED" : isProviderLive ? "OPEN" : providerExecution ? "EXECUTION_VERIFIED" : "UNRESOLVED";
    return {
      tradeId: experience.experienceId,
      timestamp: isProviderClosed ? (closedAt ?? openedAt) : isProviderLive ? openedAt : providerExecution?.fills[0]?.filledAt ?? record?.decision.createdAt ?? "UNAVAILABLE",
      symbol: experience.symbol,
      action,
      marginAllocationPct: "UNAVAILABLE",
      marginAllocated: isProviderLive ? livePosition.marginAllocated : "UNAVAILABLE",
      leverage: isProviderLive ? livePosition.leverage : "UNAVAILABLE",
      positionNotional: isProviderLive ? livePosition.notional : "UNAVAILABLE",
      intendedMarginAllocated: experience.marginAllocated,
      intendedMarginAllocationPct: experience.marginAllocationPct,
      intendedLeverage: experience.selectedLeverage,
      intendedPositionNotional: experience.positionNotional,
      legacyEntryPrice: experience.entryPrice,
      legacyEntryTime: experience.entryTime,
      entry: history?.avgEntryPrice ?? livePosition?.entryPrice ?? "UNAVAILABLE",
      exit: history?.avgExitPrice ?? "UNAVAILABLE",
      realizedPnl: history?.netProfit ?? "UNAVAILABLE",
      status: financialStatus,
      localLifecycleStatus: tradeLifecycleStatus(experience),
      thesis: experience.entryThesis,
      orderReference: facts?.providerOrderId ?? providerExecution?.providerOrderId ?? record?.executionResult?.providerOrderId ?? record?.executionResult?.clientOrderId ?? journal?.executionResult?.providerOrderId ?? journal?.executionResult?.clientOrderId ?? "—",
      ...(facts?.providerOrderId ? { providerOrderId: facts.providerOrderId } : {}),
      positionSide: experience.positionSide,
      openedAt,
      entryTime: openedAt,
      ...(closedAt ? { closedAt, exitTime: closedAt } : {}),
      financialSource: isProviderClosed ? "PROVIDER_LEDGER" : isProviderLive ? "PROVIDER_LIVE" : providerExecution ? "PROVIDER_EXECUTION" : facts?.source ?? "UNRESOLVED",
      ...(financialStatus === "UNRESOLVED" && facts?.unresolvedReason ? { unresolvedReason: facts.unresolvedReason } : {}),
      reasoningSource: persistedReasoning
        ? "DARWIN_PERSISTED" as const
        : facts?.origin === "PROVIDER_EXTERNAL" ? "PROVIDER_EXTERNAL" as const : "UNATTRIBUTED" as const,
      origin: facts?.origin ?? "UNATTRIBUTED",
      ...(facts?.providerPositionHistoryId ? { providerPositionHistoryId: facts.providerPositionHistoryId } : {}),
      ...(providerExecution ? { providerExecution } : {}),
      ...(history ? {
        quantity: history.closeTotalPos ?? "UNAVAILABLE",
        openQuantity: history.openTotalPos ?? "UNAVAILABLE",
        closeQuantity: history.closeTotalPos ?? "UNAVAILABLE",
        cumRealisedPnl: history.cumRealisedPnl ?? "UNAVAILABLE",
        netProfit: history.netProfit ?? "UNAVAILABLE",
        openFeeTotal: history.openFeeTotal ?? "UNAVAILABLE",
        closeFeeTotal: history.closeFeeTotal ?? "UNAVAILABLE",
        totalFunding: history.totalFunding ?? "UNAVAILABLE",
        cashDividend: history.cashDividend ?? "UNAVAILABLE",
      } : livePosition ? { quantity: livePosition.quantity, unrealizedPnl: livePosition.unrealizedPnl } : { quantity: "UNAVAILABLE", unrealizedPnl: "UNAVAILABLE" }),
      ...(entryReasoning ? { entryReasoning } : {}),
      ...(exitReasoning ? { exitReasoning } : {}),
      ...(managementEvents.length ? { managementEvents } : {}),
    };
  });
}

function hasPersistedReasoningFields(value: { thesis?: string; strategyThesis?: string; supportingFactors?: readonly string[]; riskFactors?: readonly string[]; evidenceUsed?: readonly string[]; lessonsUsed?: readonly string[] } | undefined): boolean {
  return Boolean(value && (
    value.thesis?.trim() || value.strategyThesis?.trim() || value.supportingFactors?.length
    || value.riskFactors?.length || value.evidenceUsed?.length || value.lessonsUsed?.length
  ));
}

function providerPersistedReasoning(
  decisionId: string,
  symbol: string,
  positionSide: PositionSide,
  journals: readonly TradingJournal[],
  contexts: ReadonlyMap<string, PositionContext>,
): { thesis: string; orderReference: string; reasoningSource: "DARWIN_PERSISTED" | "UNATTRIBUTED"; entryReasoning?: PositionContext["entryReasoning"]; managementEvents?: PositionContext["managementEvents"] } {
  const candidateContext = contexts.get(`${symbol}:${positionSide}`);
  const context = candidateContext?.entryDecisionId === decisionId ? candidateContext : undefined;
  const relatedJournal = journals.find((entry) => entry.decision?.decisionId === decisionId || cyclePlanDecisions(entry).some((candidate) => candidate.decisionId === decisionId));
  const relatedDecision = relatedJournal
    ? cyclePlanDecisions(relatedJournal).find((candidate) => candidate.decisionId === decisionId) ?? (relatedJournal.decision?.decisionId === decisionId ? relatedJournal.decision : undefined)
    : undefined;
  const contextReasoning = context?.entryReasoning;
  const journalReasoning = relatedDecision ? decisionReasoning(relatedDecision) : undefined;
  const entryReasoning = hasPersistedReasoningFields(contextReasoning) ? contextReasoning
    : hasPersistedReasoningFields(relatedDecision) ? journalReasoning
      : undefined;
  const managementEvents = context?.managementEvents ?? [];
  const journalRecord = relatedJournal ? normalizeCycleDecisions(relatedJournal).records.find((record) => record.decision.decisionId === decisionId) : undefined;
  const orderReference = journalRecord?.executionResult?.providerOrderId
    ?? journalRecord?.executionResult?.clientOrderId
    ?? (relatedJournal?.decision?.decisionId === decisionId ? relatedJournal.executionResult?.providerOrderId ?? relatedJournal.executionResult?.clientOrderId : undefined)
    ?? "—";
  const persistedReasoning = hasPersistedReasoningFields(contextReasoning) || managementEvents.length > 0 || hasPersistedReasoningFields(relatedDecision);
  return {
    thesis: entryReasoning?.thesis ?? "",
    orderReference,
    reasoningSource: persistedReasoning ? "DARWIN_PERSISTED" : "UNATTRIBUTED",
    ...(entryReasoning ? { entryReasoning } : {}),
    ...(managementEvents.length ? { managementEvents } : {}),
  };
}

function executionEvidence(journal: TradingJournal | null): DashboardSnapshot["executionEvidence"] {
  const record = journal ? normalizeCycleDecisions(journal).records.find((candidate) => candidate.executionResult && candidate.reconciliationResult) : undefined;
  const execution = record?.executionResult ?? journal?.executionResult;
  const reconciliation = record?.reconciliationResult ?? journal?.reconciliationResult;
  if (!execution || !reconciliation) return null;
  return {
    provider: execution.provider,
    action: execution.action,
    symbol: execution.symbol,
    marginAllocated: execution.marginAllocated,
    leverage: execution.leverage,
    positionNotional: execution.positionNotional,
    orderReference: execution.providerOrderId ?? execution.clientOrderId,
    executionStatus: execution.status,
    reconciliationStatus: reconciliation.status,
    ...(execution.providerFailureClass ? { providerFailureClass: execution.providerFailureClass } : {}),
    ...(execution.providerCode ? { providerCode: execution.providerCode } : {}),
    ...(execution.providerMessage ? { providerMessage: execution.providerMessage } : {}),
    ...(execution.providerReadbackFailureClass ? { providerReadbackFailureClass: execution.providerReadbackFailureClass } : {}),
    ...(execution.providerReadbackCode ? { providerReadbackCode: execution.providerReadbackCode } : {}),
    ...(execution.providerReadbackMessage ? { providerReadbackMessage: execution.providerReadbackMessage } : {}),
    timestamp: execution.readBackAt,
  };
}

function unavailablePerformance(): DashboardSnapshot["performance"] {
  return { totalPnl: "UNAVAILABLE", winRate: "UNAVAILABLE", dailyDrawdown: "UNAVAILABLE", totalTrades: null, openTrades: null, closedTrades: null, wins: null, losses: null, breakeven: null, closedEpisodeRealizedPnl: "UNAVAILABLE", openEpisodePartialRealizedPnl: "UNAVAILABLE", verifiedRealizedPnl: "UNAVAILABLE", competitionBaselineEquity: null, latestEquity: null, performanceBaselineAt: null, dailyPnl: {} };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function cycleReadModelWithStatus(journal: TradingJournal, storedCycles: readonly { cycleId: string; status: string; startedAt: string; completedAt: string | null }[], events: readonly { type: string; cycleId: string; metadata?: Record<string, string> }[]): NormalizedCycleDecisions & { startedAt: string; completedAt: string | null } {
  const stored = storedCycles.find((cycle) => cycle.cycleId === journal.cycleId);
  const status = stored?.status === "RUNNING" || stored?.status === "COMPLETED" || stored?.status === "FAILED"
    ? stored.status
    : journal.completedAt ? "COMPLETED" : "RUNNING";
  const failureEvent = status === "FAILED" ? events.find((event) => event.type === "CYCLE_FAILED" && event.cycleId === journal.cycleId) : undefined;
  const failureCode = failureEvent?.metadata?.category ?? failureEvent?.metadata?.code;
  return {
    ...cycleReadModel(journal, status, failureCode),
    ...(failureEvent?.metadata?.firstIssuePath ? { failurePath: failureEvent.metadata.firstIssuePath } : {}),
    ...(failureEvent?.metadata?.firstIssueCode ? { failureIssue: failureEvent.metadata.firstIssueCode } : {}),
    startedAt: stored?.startedAt ?? journal.startedAt,
    completedAt: stored?.completedAt ?? journal.completedAt ?? null,
  };
}

function latestValidCycleReadModel(readModel: LatestValidCyclePlan): NormalizedCycleDecisions & { startedAt: string; completedAt: string } {
  return {
    cycleId: readModel.cycleId,
    plan: readModel.plan,
    records: [],
    ...(readModel.discovery ? { discovery: readModel.discovery } : {}),
    status: "COMPLETED",
    hasPersistedPlan: true,
    hasValidPlan: true,
    startedAt: readModel.startedAt,
    completedAt: readModel.completedAt,
  };
}

function repairedLifecycleStateIsConsistent(
  experience: TradeExperience | undefined,
  context: PositionContext | null,
  auditEvent: ActivityEvent | undefined,
  experienceId: string,
  providerPositionHistoryId: string,
): boolean {
  return Boolean(experience
    && experience.experienceId === experienceId
    && experience.financialSource === "PROVIDER_LEDGER"
    && experience.providerPositionHistoryId === providerPositionHistoryId
    && (experience.outcomeStatus === "PROFITABLE" || experience.outcomeStatus === "LOSING" || experience.outcomeStatus === "BREAK_EVEN")
    && context
    && context.experienceId === experienceId
    && context.entryDecisionId === experience.entryDecisionId
    && context.lifecycleStatus === "CLOSED"
    && context.closedProviderPositionHistoryId === providerPositionHistoryId
    && auditEvent?.type === "PROVIDER_LIFECYCLE_REPAIRED"
    && auditEvent.metadata?.experienceId === experienceId
    && auditEvent.metadata.entryDecisionId === experience.entryDecisionId
    && auditEvent.metadata.providerPositionHistoryId === providerPositionHistoryId);
}

export class TraderAgent extends Agent<Env, AgentState> {
  private readonly researchRouter = new ResearchRouter();
  private readonly researchExecutor = new ResearchExecutor();

  private setupResearchTelemetry(cycleId: string): { telemetry: ResearchExecutionTelemetryCallback; summary: ResearchCycleSummary } {
    const summary: ResearchCycleSummary = {
      cycleId,
      signalEnabled: false,
      availableSkillCount: 0,
      routerAttempted: false,
      routerPlanRequestCount: 0,
      acceptedRequestCount: 0,
      rejectedRequestCount: 0,
      requestedSkills: [],
      requestedSymbols: [],
      cacheHits: 0,
      mcpConnectAttempts: 0,
      mcpConnectSuccesses: 0,
      mcpToolCalls: 0,
      availableResults: 0,
      unavailableResults: 0,
      researchDurationMs: 0,
      finalStatus: "NOT_STARTED",
    };
    const telemetry: ResearchExecutionTelemetryCallback = (event) => {
      if (event.type === "CACHE_HIT") {
        summary.cacheHits += 1;
      } else if (event.type === "MCP_CONNECT_ATTEMPT") {
        summary.mcpConnectAttempts += 1;
      } else if (event.type === "MCP_CONNECT_SUCCESS") {
        summary.mcpConnectSuccesses += 1;
      } else if (event.type === "MCP_TOOL_ATTEMPT") {
        summary.mcpToolCalls += 1;
      }
    };
    return { telemetry, summary };
  }

  private emitResearchSummary(summary: ResearchCycleSummary): void {
    try {
      const bounded: Record<string, unknown> = {
        cycleId: summary.cycleId,
        signalEnabled: summary.signalEnabled,
        availableSkillCount: summary.availableSkillCount,
        routerAttempted: summary.routerAttempted,
        planRequests: summary.routerPlanRequestCount,
        acceptedRequests: summary.acceptedRequestCount,
        rejectedRequests: summary.rejectedRequestCount,
        requestedSkills: summary.requestedSkills.slice(0, 3),
        requestedSymbols: summary.requestedSymbols.slice(0, 3),
        cacheHits: summary.cacheHits,
        mcpConnectAttempts: summary.mcpConnectAttempts,
        mcpConnectSuccesses: summary.mcpConnectSuccesses,
        mcpToolCalls: summary.mcpToolCalls,
        availableResults: summary.availableResults,
        unavailableResults: summary.unavailableResults,
        durationMs: summary.researchDurationMs,
        finalStatus: summary.finalStatus,
      };
      console.log("DARWIN_RESEARCH_TELEMETRY", JSON.stringify(bounded));
    } catch {
      // Telemetry must never affect research or trading runtime
    }
  }

  override initialState: AgentState = {
    emergencyStop: false,
    paused: false,
    lastCycleId: null,
    lastScanAt: null,
    nextScanAt: null,
    model: "",
    runtimeStatus: "ONLINE",
    currentStage: "ONLINE",
    lastStatus: "IDLE",
    lastPolicyUpdateAt: null,
    cycleStartedAt: null,
    temporaryScanIntervalExpiresAt: null,
    temporaryScanIntervalCompleted: false,
    temporaryScanIntervalDurationMs: TEMPORARY_SCAN_INTERVAL_DURATION_MS,
    userStorageVersion: 0,
  };

  public override async onStart(): Promise<void> {
    ensureStorage(this);
    const userStorageVersion = this.state.userStorageVersion ?? 0;
    const needsLatestValidPlanMigration = userStorageVersion < LATEST_VALID_PLAN_MIGRATION_VERSION;
    if (userStorageVersion < USER_STORAGE_VERSION) {
      this.setState({
        ...this.state,
        userStorageVersion: USER_STORAGE_VERSION,
        ...(needsLatestValidPlanMigration ? {
          temporaryScanIntervalExpiresAt: null,
          temporaryScanIntervalCompleted: false,
          temporaryScanIntervalDurationMs: 0,
        } : {}),
      });
    }
    this.ensureReadModels(needsLatestValidPlanMigration);
    const policy = this.ensureActivePolicy();
    const config = loadConfig(this.env, policy);
    const activeCycle = this.state.lastStatus === "RUNNING";
    this.setState({ ...this.state, emergencyStop: policy.emergencyStop, model: config.qwenModel, runtimeStatus: activeCycle ? this.state.runtimeStatus : this.state.paused || policy.emergencyStop ? "PAUSED" : "ONLINE", currentStage: activeCycle ? this.state.currentStage : this.state.paused || policy.emergencyStop ? "PAUSED" : "ONLINE" });
    if (!this.state.paused && !policy.emergencyStop) await this.reconcileScheduler(this.activeScanIntervalMinutes(policy), { ensureSchedule: true });
    try {
      const healthy = await reconcileProviderLedgerSchedule(this);
      if (!healthy) this.recordEventBestEffort("PROVIDER_SYNC_SCHEDULE_UNHEALTHY", "CONTROL", { intervalSeconds: String(PROVIDER_LEDGER_INTERVAL_SECONDS) });
    } catch {
      this.recordEventBestEffort("PROVIDER_SYNC_SCHEDULE_UNHEALTHY", "CONTROL", { intervalSeconds: String(PROVIDER_LEDGER_INTERVAL_SECONDS), code: "SCHEDULE_RECONCILIATION_FAILED" });
    }
  }

  public override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot" && request.method === "GET") {
      let livePortfolio: DashboardSnapshot["portfolio"] | undefined;
      try {
        livePortfolio = await new BitgetClient(loadConfig(this.env, this.ensureActivePolicy())).getDashboardPortfolio();
      } catch {
        livePortfolio = undefined;
      }
      return json(await this.getDashboardSnapshot(livePortfolio));
    }
    if (url.pathname === "/position-context" && request.method === "GET") return this.getPositionContext(url);
    if (url.pathname === "/agent-journal" && request.method === "GET") return this.getAgentJournal(url);
    if (url.pathname === "/trade-history" && request.method === "GET") return this.getTradeHistory(url);
    if (url.pathname === "/learning" && request.method === "GET") return this.getLearning(url);
    if (url.pathname === "/provider-ledger" && request.method === "GET") {
      ensureStorage(this);
      const config = loadConfig(this.env, this.ensureActivePolicy());
      const categories = PROVIDER_FINANCIAL_CATEGORIES.map((category) => providerLedgerDiagnostics(this, category));
      const configured = categories.find((entry) => entry.category === config.bitgetCategory) ?? providerLedgerDiagnostics(this, config.bitgetCategory);
      return json({ ...configured, categories: categories.map((entry) => ({
        ...entry,
        status: entry.sync?.lastError ? "PARTIAL" : entry.sync?.lastSuccessfulSyncAt ? "SUCCESS" : "NOT_SYNCED",
        rowCount: entry.counts.financialRecords,
        checkpoint: entry.sync?.checkpoints.financialRecords ?? null,
      })) });
    }
    if (url.pathname === "/provider-ledger/backfill" && request.method === "POST") {
      const auth = authorizeOwner(request, this.env);
      if (!auth.authorized) return json({ error: auth.code }, auth.status);
      ensureStorage(this);
      const config = loadConfig(this.env, this.ensureActivePolicy());
      const storedPerformance = loadPerformanceAggregate<PerformanceAggregate>(this);
      const baselineAt = isPerformanceAggregate(storedPerformance) ? storedPerformance.performanceBaselineAt : null;
      const results = [];
      for (const category of PROVIDER_FINANCIAL_CATEGORIES) {
        results.push(await syncProviderLedger(new BitgetClient(config), this, {
          category,
          mode: "backfill",
          financialRecordsOnly: category !== "USDT-FUTURES",
          ...(baselineAt ? { coverageStartAt: baselineAt } : {}),
        }));
      }
      const diagnostics = PROVIDER_FINANCIAL_CATEGORIES.map((category) => providerLedgerDiagnostics(this, category));
      return json({ source: "PROVIDER_READ_ONLY_BACKFILL", baselineAt, results, categories: diagnostics.map((entry) => ({ category: entry.category, rowCount: entry.counts.financialRecords, sync: entry.sync, coverage: entry.sync?.financialRecordCoverage ?? null })) });
    }
    if (url.pathname === "/policy" && request.method === "GET") return this.getPolicyRead();
    if (url.pathname === "/export/paper-log" && request.method === "GET") return this.exportPaperLog(url);
    if ((url.pathname === "/control" || url.pathname === "/policy" || url.pathname === "/eva/connection-test") && request.method === "POST") {
      const auth = authorizeOwner(request, this.env);
      if (!auth.authorized) return json({ error: auth.code }, auth.status);
    }
    if (url.pathname === "/control" && request.method === "POST") {
      const body = await request.json().catch(() => null) as unknown;
      if (!isControlBody(body)) return json({ error: "INVALID_CONTROL" }, 400);
      if (body.action === "START" || body.action === "RESUME") {
        if (body.action === "RESUME" && this.state.emergencyStop) await this.setEmergencyStop(false);
        await this.setPaused(false);
      }
      if (body.action === "PAUSE") await this.setPaused(true);
      if (body.action === "EMERGENCY_STOP") await this.setEmergencyStop(true);
      if (body.action === "RECONCILE_LATE_EXECUTION") {
        try {
          return json({ reconciliation: await this.reconcileLateExecution(body.cycleId, body.decisionId) });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message.split(":", 1)[0] ?? "LATE_RECONCILIATION_FAILED" : "LATE_RECONCILIATION_FAILED" }, 409);
        }
      }
      if (body.action === "REPAIR_PROVIDER_CLOSED_LIFECYCLE") {
        try {
          if (body.dryRun === true) {
            return json(await this.dryRunProviderClosedLifecycle(body.experienceId, body.providerPositionHistoryId));
          }
          return json({ reconciliation: await this.repairProviderClosedLifecycle(body.experienceId, body.providerPositionHistoryId) });
        } catch (error) {
          if (error instanceof ProviderLifecycleClassificationError) {
            return json({ error: `PROVIDER_LIFECYCLE_${error.classification}`, reason: error.reason }, 409);
          }
          const message = error instanceof Error ? error.message : "PROVIDER_LIFECYCLE_REPAIR_FAILED";
          return json({ error: message.split(":", 1)[0] ?? "PROVIDER_LIFECYCLE_REPAIR_FAILED" }, 409);
        }
      }
      return json(await this.getDashboardSnapshot());
    }
    if (url.pathname === "/policy" && request.method === "POST") {
      const body = await request.json().catch(() => null) as unknown;
      if (!isPolicyBody(body)) return json({ error: "INVALID_POLICY" }, 400);
      try {
        return json(await this.applyOwnerPolicy(body));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message.split(":", 1)[0] ?? "INVALID_POLICY" : "INVALID_POLICY" }, 400);
      }
    }
    if (url.pathname === "/eva/connection-test" && request.method === "POST") {
      try {
        return json(await this.runEvaConnectionTest());
      } catch (error) {
        return json({ error: error instanceof Error ? error.message.split(":", 1)[0] ?? "EVA_CONNECTION_FAILED" : "EVA_CONNECTION_FAILED" }, 502);
      }
    }
    return new Response("NOT_FOUND", { status: 404 });
  }

  private async runEvaConnectionTest(): Promise<Record<string, unknown>> {
    const config = loadConfig(this.env, this.ensureActivePolicy());
    if (!config.evaAgentId || !config.evaAgentApiKey || !config.evaGatewayUrl) throw new Error("EVA_CREDENTIAL_MISSING");
    const result = await new EvaClient({ ...(config.evaApiUrl ? { apiUrl: config.evaApiUrl } : {}), gatewayUrl: config.evaGatewayUrl, agentId: config.evaAgentId, agentApiKey: config.evaAgentApiKey, identity: { name: EVA_AGENT_NAME, version: config.version ?? "local", model: config.qwenModel } }).connectAndTest();
    return { ...result, agentId: config.evaAgentId, protocol: EVA_PROTOCOL_VERSION, capabilities: [...EVA_CAPABILITIES], executionProviders: [...EVA_EXECUTION_PROVIDERS], endpoint: config.evaGatewayUrl };
  }

  public async runScheduledProviderSync(): Promise<void> {
    try {
      ensureStorage(this);
      const config = loadConfig(this.env, this.ensureActivePolicy());
      const client = new BitgetClient(config);
      const results = [];
      for (const category of PROVIDER_FINANCIAL_CATEGORIES) {
        results.push(await syncProviderLedger(client, this, {
          category,
          mode: "recent",
          ...(category === PROVIDER_TRADE_LIFECYCLE_CATEGORY ? {} : { financialRecordsOnly: true }),
          recentWindowMs: 24 * 60 * 60 * 1000,
          overlapMs: 15 * 60 * 1000,
          maxPagesPerRun: 120,
          maxRowsPerRun: 12_000,
        }));
      }
      const failures = results.filter((result) => result.status !== "SUCCESS").length;
      this.recordEventBestEffort(failures === 0 ? "PROVIDER_SYNC_COMPLETED" : "PROVIDER_SYNC_PARTIAL", "CONTROL", {
        categories: String(results.length),
        failures: String(failures),
        source: "READ_ONLY_PROVIDER_LEDGER",
      });
    } catch (error) {
      this.recordEventBestEffort("PROVIDER_SYNC_FAILED", "CONTROL", failureDiagnostic(error));
    }
  }

  public async runScheduledCycle(): Promise<void> {
    this.recordEventBestEffort("SCHEDULE_CALLBACK", "CONTROL");
    if (this.state.paused || this.state.emergencyStop) return;
    try {
      const policy = this.ensureActivePolicy();
      const config = loadConfig(this.env, policy);
      await this.ensureTradingSchedule(config);
      await this.runCycle();
    } catch (error) {
      const diagnostic = failureDiagnostic(error);
      const diagnosticCode = diagnostic.code ?? "RUNTIME_ERROR";
      if (diagnosticCode === "CYCLE_IN_PROGRESS") this.recordEventBestEffort("CYCLE_IN_PROGRESS", this.state.lastCycleId ?? "UNKNOWN", diagnostic);
      if (diagnosticCode.includes("TIMEOUT")) this.recordEventBestEffort("CYCLE_TIMEOUT", this.state.lastCycleId ?? "UNKNOWN", diagnostic);
      this.recordEventBestEffort("SCHEDULE_CALLBACK_FAILED", "CONTROL", diagnostic);
      return;
    }
  }

  public async runNow(): Promise<TradingJournal> {
    return this.runCycle();
  }

  public async setPaused(paused: boolean): Promise<AgentState> {
    const effectivePaused = paused || this.state.emergencyStop;
    const nextState: AgentState = { ...this.state, paused: effectivePaused, runtimeStatus: effectivePaused ? "PAUSED" : "ONLINE", currentStage: effectivePaused ? "PAUSED" : "ONLINE" };
    this.setState(nextState);
    if (effectivePaused) {
      const schedules = await this.listSchedules();
      for (const schedule of schedules.filter((entry) => entry.callback === "runScheduledCycle")) await this.cancelSchedule(schedule.id);
    }
    if (!effectivePaused) {
      const config = loadConfig(this.env, this.ensureActivePolicy());
      const intervalMinutes = this.activeScanIntervalMinutes(config.ownerPolicy);
      const hasActiveCycleMetadata = this.state.lastStatus === "RUNNING" || Boolean(this.state.cycleStartedAt);
      const staleCycleRecovered = hasActiveCycleMetadata && this.recoverStaleCycle();
      const resumeState: AgentState = staleCycleRecovered
        ? { ...nextState, lastStatus: "FAILED", cycleStartedAt: null, runtimeStatus: "ONLINE", currentStage: "ONLINE" }
        : nextState;
      if (staleCycleRecovered) this.setState(resumeState);
      await this.reconcileScheduler(intervalMinutes, {
        ensureSchedule: true,
        baseState: resumeState,
        state: {
          paused: nextState.paused,
          emergencyStop: nextState.emergencyStop,
          activeCycle: staleCycleRecovered ? false : this.state.lastStatus === "RUNNING" || Boolean(this.state.cycleStartedAt),
          nextScanAt: this.state.nextScanAt,
        },
      });
    }
    return nextState;
  }

  public async setEmergencyStop(enabled: boolean): Promise<AgentState> {
    const policy = this.ensureActivePolicy();
    const nextPolicy = { ...policy, emergencyStop: enabled };
    this.persistPolicy(policy, nextPolicy);
    const nextState: AgentState = { ...this.state, emergencyStop: enabled, runtimeStatus: enabled ? "PAUSED" : this.state.paused ? "PAUSED" : "ONLINE", currentStage: enabled ? "PAUSED" : this.state.paused ? "PAUSED" : "ONLINE", lastPolicyUpdateAt: new Date().toISOString() };
    this.setState(nextState);
    if (enabled) {
      const schedules = await this.listSchedules();
      for (const schedule of schedules.filter((entry) => entry.callback === "runScheduledCycle")) await this.cancelSchedule(schedule.id);
    }
    return nextState;
  }

  public async getStatus(): Promise<AgentState> {
    return this.state;
  }

  private exportPaperLog(url: URL): Response {
    try {
      if (this.env.TRADING_MODE !== "PAPER" || this.env.PAPER_ONLY !== "true") return json({ error: "PAPER_ONLY" }, 503);
      const format = url.searchParams.get("format") ?? "json";
      if (format !== "json" && format !== "csv") return json({ error: "INVALID_EXPORT_FORMAT" }, 400);
      const period = parsePaperLogPeriod(url.searchParams.get("from"), url.searchParams.get("to"));
      const journals = loadAllAutonomousJournals(this, period.start ?? undefined, period.end ?? undefined);
      const exported = buildPaperLogExport({
        generatedAt: new Date().toISOString(),
        period,
        environment: this.env.ENVIRONMENT?.trim() || "unknown",
        model: this.state.model || this.env.QWEN_MODEL?.trim() || "unknown",
        version: this.env.APP_VERSION?.trim() || "unknown",
        commit: this.env.GIT_COMMIT_SHA?.trim() || "unknown",
        cycles: loadAllStoredCycles(this, period.start ?? undefined, period.end ?? undefined),
        journals,
        experiences: loadAllExperiences(this),
        events: loadAllEvents(this),
      });
      if (format === "csv") return new Response(paperLogToCsv(exported), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=darwin-paper-log-full.csv", "cache-control": "no-store" } });
      return new Response(JSON.stringify(exported, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": "attachment; filename=darwin-paper-log-full.json", "cache-control": "no-store" } });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message.split(":", 1)[0] ?? "PAPER_LOG_EXPORT_FAILED" : "PAPER_LOG_EXPORT_FAILED" }, 400);
    }
  }

  private ensureTemporaryScanTest(policy: OwnerPolicy): void {
    const expiresAt = this.state.temporaryScanIntervalExpiresAt;
    if (this.state.temporaryScanIntervalDurationMs !== TEMPORARY_SCAN_INTERVAL_DURATION_MS) {
      const nextExpiresAt = new Date(Date.now() + TEMPORARY_SCAN_INTERVAL_DURATION_MS).toISOString();
      this.setState({ ...this.state, temporaryScanIntervalExpiresAt: nextExpiresAt, temporaryScanIntervalCompleted: false, temporaryScanIntervalDurationMs: TEMPORARY_SCAN_INTERVAL_DURATION_MS });
      this.recordEvent("TEMPORARY_SCAN_INTERVAL_ACTIVATED", "CONTROL", { intervalMinutes: String(TEMPORARY_SCAN_INTERVAL_MINUTES), durationHours: "2", expiresAt: nextExpiresAt });
      return;
    }
    if (this.state.temporaryScanIntervalCompleted) return;
    if (expiresAt) {
      if (new Date(expiresAt).getTime() > Date.now()) return;
      this.setState({ ...this.state, temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: true });
      this.recordEvent("TEMPORARY_SCAN_INTERVAL_EXPIRED", "CONTROL", { restoredIntervalMinutes: String(policy.scanIntervalMinutes) });
      return;
    }
    const nextExpiresAt = new Date(Date.now() + TEMPORARY_SCAN_INTERVAL_DURATION_MS).toISOString();
    this.setState({ ...this.state, temporaryScanIntervalExpiresAt: nextExpiresAt, temporaryScanIntervalCompleted: false, temporaryScanIntervalDurationMs: TEMPORARY_SCAN_INTERVAL_DURATION_MS });
    this.recordEvent("TEMPORARY_SCAN_INTERVAL_ACTIVATED", "CONTROL", { intervalMinutes: String(TEMPORARY_SCAN_INTERVAL_MINUTES), durationHours: "2", expiresAt: nextExpiresAt });
  }

  private activeScanIntervalMinutes(policy: OwnerPolicy): number {
    this.ensureTemporaryScanTest(policy);
    return temporaryScanIntervalActive(this.state.temporaryScanIntervalExpiresAt, this.state.temporaryScanIntervalCompleted) ? TEMPORARY_SCAN_INTERVAL_MINUTES : policy.scanIntervalMinutes;
  }

  private ensureReadModels(migrateLatestValidPlan = false): void {
    const initializedAt = new Date().toISOString();
    const performance = loadPerformanceAggregate<PerformanceAggregate>(this);
    const positionContextBootstrapped = loadPositionContextBootstrap(this);
    if (migrateLatestValidPlan && !loadLatestValidCyclePlan(this)) {
      const historicalLatestPlan = loadLatestCompletedCyclePlanFromHistory(this);
      if (historicalLatestPlan) saveLatestValidCyclePlan(this, historicalLatestPlan);
    }
    const needsPositionContextBootstrap = positionContextBootstrapped?.version !== POSITION_CONTEXT_READ_MODEL_VERSION;
    if (isPerformanceAggregate(performance) && !needsPositionContextBootstrap) return;
    if (!isPerformanceAggregate(performance)) savePerformanceAggregate(this, migratePerformanceEquityObservations(performance, initializedAt), initializedAt);
    if (needsPositionContextBootstrap) {
      const history = this.readBootstrapHistory();
      for (const context of bootstrapPositionContexts(history.journals, history.experiences, initializedAt)) savePositionContext(this, context);
      savePositionContextBootstrap(this, POSITION_CONTEXT_READ_MODEL_VERSION, initializedAt);
    }
  }

  private readBootstrapHistory(): { journals: TradingJournal[]; experiences: TradeExperience[] } {
    const openExperiences = loadOpenExperiences(this, 100);
    const recentJournals = loadRecentJournals(this, 100);
    const targetedJournals = loadJournalsForDecisionIds(this, openExperiences.map((experience) => experience.entryDecisionId), 100);
    const journals = [...new Map([...recentJournals, ...targetedJournals].map((journal) => [journal.cycleId, journal])).values()];
    const experiences = [...new Map([...loadExperiences(this, 100), ...openExperiences].map((experience) => [experience.experienceId, experience])).values()];
    return { journals, experiences };
  }

  private updatePerformanceReadModel(_record: DecisionExecutionRecord, bundle: EvidenceBundle, verified: boolean, _currentExperience?: TradeExperience): void {
    if (!verified || !_record.executionResult) return;
    const observedAt = _record.executionResult.readBackAt;
    const equity = _record.accountAfter?.portfolioEquity ?? bundle.account.portfolioEquity;
    this.persistPerformanceEquity(equity, observedAt);
  }

  private persistPerformanceEquity(equity: string, observedAt: string): void {
    savePerformanceAggregate(this, this.performanceWithEquity(equity, observedAt), observedAt);
  }

  private performanceWithEquity(equity: string, observedAt: string): PerformanceAggregate {
    let performance = loadPerformanceAggregate<PerformanceAggregate>(this);
    if (!isPerformanceAggregate(performance)) performance = migratePerformanceEquityObservations(performance, observedAt);
    if (!performance.competitionBaselineEquity && isPositiveDecimal(equity)) performance = { ...performance, competitionBaselineEquity: equity, latestEquity: equity, performanceBaselineAt: observedAt };
    return updateEquity(performance, equity, observedAt);
  }

  private updatePositionContext(record: DecisionExecutionRecord, experience?: TradeExperience): void {
    const decision = record.parentDecision ?? record.decision;
    const isEntry = record.decision.action === "OPEN_LONG" || record.decision.action === "OPEN_SHORT";
    const isManagement = decision.action === "HOLD" || decision.action === "INCREASE" || decision.action === "REDUCE" || decision.action === "CLOSE" || decision.action === "REVERSE";
    if (!isEntry && !isManagement) return;
    const positionSide = decision.positionSide ?? record.decision.positionSide;
    if (!positionSide) return;
    const lookupSide = isEntry ? record.decision.positionSide : positionSide;
    if (!lookupSide) return;
    const current = loadPositionContext(this, decision.symbol, lookupSide);
    const next = upsertPositionContext(current, record.decision, record.executionResult?.readBackAt ?? record.decision.createdAt, experience, record.parentDecision);
    if (next) savePositionContext(this, next);
  }

  private refreshPositionManagementState(
    experiences: TradeExperience[],
    positions: readonly PositionSnapshot[],
    bundles: readonly EvidenceBundle[],
    observedAt: string,
    lifecycleHistory: readonly TradingJournal[] = [],
  ): PositionManagementState[] {
    const states: PositionManagementState[] = [];
    for (const position of positions.filter((candidate) => Number(candidate.quantity) > 0)) {
      const experienceIndex = experiences.findIndex((candidate) => candidate.outcomeStatus === "OPEN" && candidate.symbol === position.symbol && candidate.positionSide === position.positionSide);
      if (experienceIndex < 0) continue;
      const experience = experiences[experienceIndex];
      if (!experience) continue;
      const bundle = bundles.find((candidate) => candidate.instrument.symbol === position.symbol);
      const currentPrice = bundle?.market.lastPrice ?? position.markPrice;
      if (!currentPrice) continue;
      const positionContext = loadPositionContext(this, position.symbol, position.positionSide);
      let experienceForRefresh = experience;
      if (!experience.maximumFavorableExcursionBasis) {
        const historicalPeak = reconstructMaximumFavorableReturnPct(position, experience, lifecycleHistory);
        if (historicalPeak !== null) experienceForRefresh = { ...experience, maximumFavorableExcursion: String(Math.max(Number(experience.maximumFavorableExcursion) || 0, historicalPeak)), maximumFavorableExcursionBasis: "SINCE_ENTRY" };
      }
      const result = buildPositionManagementState(position, experienceForRefresh, currentPrice, bundle?.market.observedAt ?? observedAt, positionContext);
      if (result.experience !== experience) {
        experiences[experienceIndex] = result.experience;
        saveExperience(this, result.experience, observedAt);
      }
      states.push(result.state);
    }
    return states;
  }

  public async dryRunProviderClosedLifecycle(experienceId: string, providerPositionHistoryId: string): Promise<{
    dryRun: true;
    classification: ReturnType<typeof classifyProviderLifecycle>["classification"];
    reason: string;
    evidence: {
      historyFound: boolean;
      providerPositionHistoryId: string | null;
      historyOrigin: string | null;
      avgEntryPrice: string | null;
      avgExitPrice: string | null;
      cumRealisedPnl: string | null;
      netProfit: string | null;
      openFeeTotal: string | null;
      closeFeeTotal: string | null;
      totalFunding: string | null;
      openingTime: string | null;
      closingTime: string | null;
      entryIdentityFound: boolean;
      entryIdentitySource: "IDEMPOTENCY" | "IDEMPOTENCY_CLIENT_OID" | "DERIVED_DARWIN_CLIENT_OID" | null;
      entryIdentityLookupCount: number;
      idempotencyClientOidPresent: boolean | null;
      idempotencyClientOidMatchesDeterministic: boolean | null;
      idempotencyProviderOrderIdPresent: boolean | null;
      idempotencyProviderOrderIdExact: boolean | null;
      entryIdentityCandidateLookupCount: number | null;
      entryIdentityCandidateProviderOrderIdPresent: boolean | null;
      entryIdentityCandidateSymbolMatch: boolean | null;
      entryIdentityCandidatePositionSideMatch: boolean | null;
      entryIdentityCandidateTradeSideOpen: boolean | null;
      entryIdentityCandidateDarwinOrigin: boolean | null;
      entryIdentityCandidateOpeningTimeMatch: boolean | null;
      entryDecisionId: string;
      entryClientOid: string | null;
      entryProviderOrderId: string | null;
      candidateOrder: ProviderLifecycleCandidateOrder | null;
      candidateFills: readonly ProviderLifecycleCandidateFill[];
      orderCount: number;
      fillCount: number;
      evidenceComplete: boolean;
      providerCurrentPositionPresent: boolean;
      openTotalPos: string | null;
      closeTotalPos: string | null;
      openingFillQuantity: string | null;
      closingFillQuantity: string | null;
    };
  }> {
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");
    const experience = loadExperienceById(this, experienceId);
    if (!experience) throw new Error("EXPERIENCE_NOT_FOUND");
    if (!experience.positionSide) throw new Error("LOCAL_POSITION_SIDE_MISSING");

    const context = loadPositionContext(this, experience.symbol, experience.positionSide);
    if (!context || context.entryDecisionId !== experience.entryDecisionId || (context.experienceId && context.experienceId !== experience.experienceId)) {
      throw new Error("POSITION_CONTEXT_IDENTITY_MISMATCH");
    }

    const policy = loadActiveOwnerPolicy(this) ?? loadOwnerPolicy(this.env);
    const config = loadConfig(this.env, policy);
    const portfolio = await new BitgetClient(config).getDashboardPortfolio();
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");

    const evidence = loadProviderLifecycleEvidence(this, experience, config.bitgetCategory, providerPositionHistoryId, portfolio.positions, deterministicEntryIdentity(experience, context), true);
    const reconciliation = classifyProviderLifecycle(evidence);
    const quantities = summarizeProviderLifecycleFillQuantities(evidence);
    return {
      dryRun: true,
      classification: reconciliation.classification,
      reason: reconciliation.reason,
      evidence: {
        historyFound: Boolean(evidence.history),
        providerPositionHistoryId: evidence.history?.providerPositionHistoryId ?? null,
        historyOrigin: evidence.history?.origin ?? null,
        avgEntryPrice: evidence.history?.avgEntryPrice ?? null,
        avgExitPrice: evidence.history?.avgExitPrice ?? null,
        cumRealisedPnl: evidence.history?.cumRealisedPnl ?? null,
        netProfit: evidence.history?.netProfit ?? null,
        openFeeTotal: evidence.history?.openFeeTotal ?? null,
        closeFeeTotal: evidence.history?.closeFeeTotal ?? null,
        totalFunding: evidence.history?.totalFunding ?? null,
        openingTime: evidence.history?.openingTime ?? null,
        closingTime: evidence.history?.closingTime ?? null,
        entryIdentityFound: Boolean(evidence.entryIdentity),
        entryIdentitySource: evidence.entryIdentitySource ?? null,
        entryIdentityLookupCount: evidence.entryIdentityLookupCount ?? 0,
        idempotencyClientOidPresent: evidence.idempotencyClientOidPresent ?? null,
        idempotencyClientOidMatchesDeterministic: evidence.idempotencyClientOidMatchesDeterministic ?? null,
        idempotencyProviderOrderIdPresent: evidence.idempotencyProviderOrderIdPresent ?? null,
        idempotencyProviderOrderIdExact: evidence.idempotencyProviderOrderIdExact ?? null,
        entryIdentityCandidateLookupCount: evidence.entryIdentityCandidateLookupCount ?? null,
        entryIdentityCandidateProviderOrderIdPresent: evidence.entryIdentityCandidateProviderOrderIdPresent ?? null,
        entryIdentityCandidateSymbolMatch: evidence.entryIdentityCandidateSymbolMatch ?? null,
        entryIdentityCandidatePositionSideMatch: evidence.entryIdentityCandidatePositionSideMatch ?? null,
        entryIdentityCandidateTradeSideOpen: evidence.entryIdentityCandidateTradeSideOpen ?? null,
        entryIdentityCandidateDarwinOrigin: evidence.entryIdentityCandidateDarwinOrigin ?? null,
        entryIdentityCandidateOpeningTimeMatch: evidence.entryIdentityCandidateOpeningTimeMatch ?? null,
        entryDecisionId: evidence.entryIdentity?.entryDecisionId ?? experience.entryDecisionId,
        entryClientOid: evidence.entryIdentity?.clientOid ?? null,
        entryProviderOrderId: evidence.entryIdentity?.providerOrderId ?? null,
        candidateOrder: evidence.candidateOrder ?? null,
        candidateFills: evidence.candidateFills ?? [],
        orderCount: evidence.orders.length,
        fillCount: evidence.fills.length,
        evidenceComplete: evidence.evidenceComplete === true,
        providerCurrentPositionPresent: evidence.providerPositions.some((position) => position.symbol === experience.symbol && position.positionSide === experience.positionSide),
        openTotalPos: evidence.history?.openTotalPos ?? null,
        closeTotalPos: evidence.history?.closeTotalPos ?? null,
        openingFillQuantity: quantities.openingFillQuantity,
        closingFillQuantity: quantities.closingFillQuantity,
      },
    };
  }

  public async repairProviderClosedLifecycle(experienceId: string, providerPositionHistoryId: string): Promise<{ status: "RECONCILED" | "ALREADY_RECONCILED"; experienceId: string; providerPositionHistoryId: string }> {
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");
    ensureStorage(this);
    const experience = loadExperienceById(this, experienceId);
    if (!experience) throw new Error("EXPERIENCE_NOT_FOUND");
    const eventId = providerLifecycleRepairEventId(experienceId, providerPositionHistoryId);
    if (experience.financialSource === "PROVIDER_LEDGER" && experience.providerPositionHistoryId === providerPositionHistoryId && experience.outcomeStatus !== "OPEN") {
      const context = experience.positionSide ? loadPositionContext(this, experience.symbol, experience.positionSide) : null;
      const auditEvent = loadEventById(this, eventId);
      if (!repairedLifecycleStateIsConsistent(experience, context, auditEvent, experienceId, providerPositionHistoryId)) {
        throw new Error("PROVIDER_LIFECYCLE_REPAIR_STATE_INCONSISTENT");
      }
      return { status: "ALREADY_RECONCILED", experienceId, providerPositionHistoryId };
    }
    if (experience.outcomeStatus !== "OPEN" || !experience.positionSide) throw new Error("LOCAL_LIFECYCLE_NOT_OPEN");

    const context = loadPositionContext(this, experience.symbol, experience.positionSide);
    if (!context || context.entryDecisionId !== experience.entryDecisionId || (context.experienceId && context.experienceId !== experience.experienceId)) {
      throw new Error("POSITION_CONTEXT_IDENTITY_MISMATCH");
    }
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const portfolio = await new BitgetClient(config).getDashboardPortfolio();
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");
    const evidence = loadProviderLifecycleEvidence(this, experience, config.bitgetCategory, providerPositionHistoryId, portfolio.positions, deterministicEntryIdentity(experience, context));
    const reconciliation = classifyProviderLifecycle(evidence);
    if (reconciliation.classification !== "LOCAL_OPEN_PROVIDER_CLOSED" || !evidence.history) {
      throw new ProviderLifecycleClassificationError(reconciliation.classification, reconciliation.reason);
    }
    const history = evidence.history;
    const closedExperience = providerClosedExperience(experience, history, reconciliation.closedQuantity ?? "");
    const closedContext: PositionContext = {
      ...context,
      experienceId: experience.experienceId,
      lifecycleStatus: "CLOSED",
      closedAt: history.closingTime,
      closedProviderPositionHistoryId: providerPositionHistoryId,
      updatedAt: new Date().toISOString(),
    };
    const createdAt = new Date().toISOString();
    const event = {
      eventId,
      type: "PROVIDER_LIFECYCLE_REPAIRED",
      cycleId: context.entryReasoning?.cycleId || "PROVIDER_LEDGER_RECONCILIATION",
      createdAt,
      metadata: {
        experienceId,
        entryDecisionId: experience.entryDecisionId,
        providerPositionHistoryId,
        symbol: experience.symbol,
        positionSide: experience.positionSide,
        origin: "DARWIN",
        providerPositionHistoryOrigin: history.origin,
        closedQuantity: reconciliation.closedQuantity ?? "",
        netProfit: history.netProfit ?? "",
        legacyLocalRealizedPnl: experience.realizedPnl,
      },
    };
    const written = persistProviderLifecycleRepair(this, (closure) => this.ctx.storage.transactionSync(closure), experience, context, closedExperience, closedContext, event);
    if (!written) {
      const latest = loadExperienceById(this, experienceId);
      const latestContext = latest?.positionSide ? loadPositionContext(this, latest.symbol, latest.positionSide) : null;
      const auditEvent = loadEventById(this, eventId);
      if (!repairedLifecycleStateIsConsistent(latest ?? undefined, latestContext, auditEvent, experienceId, providerPositionHistoryId)) {
        throw new Error("PROVIDER_LIFECYCLE_REPAIR_STATE_INCONSISTENT");
      }
      return { status: "ALREADY_RECONCILED", experienceId, providerPositionHistoryId };
    }
    return { status: "RECONCILED", experienceId, providerPositionHistoryId };
  }

  public async reconcileLateExecution(originalCycleId: string, decisionId: string): Promise<{ status: "RECONCILED" | "ALREADY_RECONCILED"; experienceId: string }> {
    if (!this.state.paused) throw new Error("AGENT_MUST_BE_PAUSED");
    const journal = loadJournalForExactDecisionCycle(this, originalCycleId, decisionId);
    if (!journal) throw new Error("LATE_RECONCILIATION_CYCLE_NOT_FOUND");
    const record = normalizeCycleDecisions(journal).records.find((candidate) => candidate.decision.decisionId === decisionId);
    if (!record || !isReadbackOnlyExecutionMismatch(record) || !record.executionResult) throw new Error("LATE_RECONCILIATION_RECORD_NOT_ELIGIBLE");
    const client = new BitgetClient(loadConfig(this.env, this.ensureActivePolicy()));
    const bundle = (await client.collectEvidence([record.decision.symbol]))[0];
    const position = bundle?.account.positions.find((candidate) => candidate.symbol === record.decision.symbol && candidate.positionSide === record.decision.positionSide);
    if (!bundle || !position) throw new Error("LATE_RECONCILIATION_POSITION_MISSING");
    const rawOrder = await client.getOrderDetailsRead(record.executionResult.providerOrderId, record.executionResult.clientOrderId);
    const order = parseProviderOrderEvidence(rawOrder);
    if (!order) throw new Error("LATE_RECONCILIATION_ORDER_INVALID");
    const rawFills = await client.getFillHistoryRead(order.orderId);
    const fill = parseProviderFillEvidence(rawFills, order);
    if (!fill) throw new Error("LATE_RECONCILIATION_FILL_INVALID");
    const experiences = loadAllExperiences(this);
    const existingExperience = experiences.find((experience) => experience.entryDecisionId === decisionId && experience.symbol === record.decision.symbol && experience.positionSide === record.decision.positionSide);
    const resolvedAt = new Date().toISOString();
    const result = reconcileLateExecution({
      record,
      order,
      fill,
      currentPosition: position,
      existingContext: loadPositionContext(this, record.decision.symbol, record.decision.positionSide!),
      resolvedAt,
      ...(existingExperience ? { existingExperience } : {}),
    });
    if (result.status === "ALREADY_RECONCILED") return { status: result.status, experienceId: result.experience.experienceId };
    const performance = this.performanceWithEquity(bundle.account.portfolioEquity, resolvedAt);
    saveExperience(this, result.experience, resolvedAt);
    savePositionContext(this, result.positionContext);
    savePerformanceAggregate(this, performance, resolvedAt);
    const audited = loadAllEvents(this).some((event) => event.type === "LATE_EXECUTION_RECONCILED" && event.metadata?.originalCycleId === originalCycleId && event.metadata?.decisionId === decisionId);
    if (!audited) this.recordEvent("LATE_EXECUTION_RECONCILED", originalCycleId, result.auditMetadata);
    return { status: result.status, experienceId: result.experience.experienceId };
  }

  public async getDashboardSnapshot(livePortfolio?: DashboardSnapshot["portfolio"]): Promise<DashboardSnapshot> {
    ensureStorage(this);
    if (livePortfolio) this.persistPerformanceEquity(livePortfolio.portfolioEquity, livePortfolio.observedAt);
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const journal = loadLatestJournal(this);
    const recentJournals = loadRecentJournals(this, 25);
    const storedCycles = loadRecentStoredCycles(this, 25);
    const latestPersistedPlan = loadLatestValidCyclePlan(this);
    const events = loadRecentEvents(this, SNAPSHOT_EVENT_LIMIT);
    const recentCycles = recentJournals.map((entry) => cycleReadModelWithStatus(entry, storedCycles, events));
    const latestCycle = recentCycles[0];
    const latestValidCycle = latestPersistedPlan
      ? latestValidCycleReadModel(latestPersistedPlan)
      : recentCycles.find((cycle) => cycle.status === "COMPLETED" && cycle.hasValidPlan);
    const latestCycleStatus = this.state.lastStatus === "RUNNING" && this.state.lastCycleId && this.state.cycleStartedAt
      ? { cycleId: this.state.lastCycleId, status: "RUNNING" as const, startedAt: this.state.cycleStartedAt, completedAt: null, hasPersistedPlan: false, hasValidPlan: false }
      : latestCycle?.status ? { cycleId: latestCycle.cycleId, status: latestCycle.status, startedAt: latestCycle.startedAt, completedAt: latestCycle.completedAt, hasPersistedPlan: latestCycle.hasPersistedPlan === true, hasValidPlan: latestCycle.hasValidPlan === true, ...(latestCycle.failureCode ? { failureCode: latestCycle.failureCode } : {}), ...(latestCycle.failurePath ? { failurePath: latestCycle.failurePath } : {}), ...(latestCycle.failureIssue ? { failureIssue: latestCycle.failureIssue } : {}) } : null;
    const drawdown = loadDailyDrawdownState(this);
    const drawdownPct = drawdown ? calculateDrawdownPct(drawdown.baselineEquity, drawdown.lastEquity) : "0";
    const configuredIntervalMinutes = temporaryScanIntervalActive(this.state.temporaryScanIntervalExpiresAt, this.state.temporaryScanIntervalCompleted) ? TEMPORARY_SCAN_INTERVAL_MINUTES : config.ownerPolicy.scanIntervalMinutes;
    const scheduler = await this.getSchedulerDiagnostics(configuredIntervalMinutes);
    const persistedPerformance = loadPerformanceAggregate<PerformanceAggregate>(this);
    const accountingBase = isPerformanceAggregate(persistedPerformance)
      ? buildPerformanceAccounting(persistedPerformance, livePortfolio ? { portfolioEquity: livePortfolio.portfolioEquity, observedAt: livePortfolio.observedAt, unrealizedPnl: livePortfolio.unrealizedPnl, ...(livePortfolio.unrealizedPnlSource ? { unrealizedPnlSource: livePortfolio.unrealizedPnlSource } : {}) } satisfies PerformanceObservation : undefined)
      : buildPerformanceAccounting(emptyPerformance(new Date().toISOString()), livePortfolio ? { portfolioEquity: livePortfolio.portfolioEquity, observedAt: livePortfolio.observedAt, unrealizedPnl: livePortfolio.unrealizedPnl, ...(livePortfolio.unrealizedPnlSource ? { unrealizedPnlSource: livePortfolio.unrealizedPnlSource } : {}) } satisfies PerformanceObservation : undefined);
    const baselineAt = accountingBase.baselineObservedAt;
    const syncStates = loadProviderSyncStates(this, PROVIDER_FINANCIAL_CATEGORIES);
    const lifecycleSyncState = syncStates.get(PROVIDER_TRADE_LIFECYCLE_CATEGORY) ?? null;
    const lifecyclePerformanceSignature = JSON.stringify({
      version: 1,
      category: PROVIDER_TRADE_LIFECYCLE_CATEGORY,
      revision: lifecycleSyncState?.revision ?? null,
      updatedAt: lifecycleSyncState?.updatedAt ?? null,
      lastSuccessfulSyncAt: lifecycleSyncState?.lastSuccessfulSyncAt ?? null,
      lastError: lifecycleSyncState?.lastError ?? null,
      checkpoints: lifecycleSyncState?.checkpoints ?? {},
    });
    const closedProviderPerformance = resolveProviderPerformanceReadModel(
      this,
      lifecyclePerformanceSignature,
      livePortfolio?.observedAt ?? new Date().toISOString(),
      () => {
        const closedLifecycles: ProviderPerformanceLifecycle[] = [];
        let cursor: ProviderPositionHistoryCursor | null = null;
        while (true) {
          const page = loadProviderPositionHistoriesPage(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, cursor, 100);
          const pageDecisionIds = loadProviderPositionHistoryDecisionIds(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, page.histories);
          const pageResolved = resolveProviderTradeFacts(this, [], PROVIDER_TRADE_LIFECYCLE_CATEGORY, [], {
            histories: page.histories,
            historyDecisionIds: pageDecisionIds,
            openPositionIdentities: new Map<string, { providerOrderId: string; decisionId: string }>(),
          });
          closedLifecycles.push(...pageResolved.lifecycles.filter((lifecycle) => lifecycle.status === "CLOSED"));
          if (!page.hasMore) break;
          if (!page.nextCursor) throw new Error("PROVIDER_HISTORY_PAGE_CURSOR_MISSING");
          cursor = page.nextCursor;
        }
        return rebuildProviderPerformance(closedLifecycles);
      },
    ).totals;
    const openPositionIdentities = livePortfolio
      ? loadProviderLiveOpeningOrderIdentities(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, livePortfolio.positions)
      : new Map<string, { providerOrderId: string; decisionId: string }>();
    const liveProviderPerformance = livePortfolio
      ? resolveProviderTradeFacts(this, [], PROVIDER_TRADE_LIFECYCLE_CATEGORY, livePortfolio.positions, {
        histories: [],
        historyDecisionIds: new Map<string, string>(),
        openPositionIdentities,
      })
      : null;
    const openTrades = liveProviderPerformance?.lifecycles.filter((lifecycle) => lifecycle.origin === "DARWIN" && lifecycle.status === "OPEN").length ?? 0;
    const providerPerformance: ProviderPerformanceTotals = {
      ...closedProviderPerformance,
      openTrades,
      totalTrades: closedProviderPerformance.closedTrades + openTrades,
    };
    const flowCategoryStates = PROVIDER_FINANCIAL_CATEGORIES.map((category) => {
      const sync = syncStates.get(category) ?? null;
      const coverage = sync?.financialRecordCoverage ?? null;
      const lastError = coverage?.lastError ?? sync?.lastError ?? null;
      const complete = isFinancialRecordCoverageComplete(coverage ?? undefined, baselineAt, new Date(), lastError);
      return {
        category,
        status: complete ? "SUCCESS" as const : coverage ? "PARTIAL" as const : "NOT_SYNCED" as const,
        complete,
        lastSuccessfulSyncAt: coverage?.lastSuccessfulSyncAt ?? null,
        coveredFrom: coverage?.coveredFrom ?? null,
        coveredThrough: coverage?.coveredThrough ?? null,
        lastError,
        revision: sync?.revision ?? null,
        updatedAt: sync?.updatedAt ?? null,
        financialRecordCount: null,
      };
    });
    const financialRecordCategories = flowCategoryStates.map(({ complete: _complete, revision: _revision, updatedAt: _updatedAt, financialRecordCount: _financialRecordCount, ...category }) => category);
    const allFinancialCategoriesComplete = flowCategoryStates.length === PROVIDER_FINANCIAL_CATEGORIES.length && flowCategoryStates.every((category) => category.complete);
    const flowReadModel = resolveExternalFlowReadModel(this, baselineAt, accountingBase.baselineEquity, flowCategoryStates, PROVIDER_FINANCIAL_CATEGORIES, livePortfolio?.observedAt ?? new Date().toISOString());
    const flows = flowReadModel.flows;
    const netPnlSinceBaseline = calculateNetPnlSinceBaseline(livePortfolio?.portfolioEquity, accountingBase.baselineEquity, flows);
    const accountPerformance: DashboardSnapshot["accountPerformance"] = {
      equitySource: livePortfolio ? "PROVIDER_LIVE" : "UNAVAILABLE",
      currentEquity: livePortfolio?.portfolioEquity ?? null,
      externalFlowStatus: flows.status,
      netExternalInflows: flows.netExternalInflows,
      netPnlSinceBaseline,
      financialRecordCoverage: allFinancialCategoriesComplete ? "COMPLETE" : financialRecordCategories.every((category) => category.status === "NOT_SYNCED") ? "UNAVAILABLE" : "PARTIAL",
      financialRecordCategories,
    };
    const cacheBase = isPerformanceAggregate(persistedPerformance) ? persistedPerformance : migratePerformanceEquityObservations(persistedPerformance, new Date().toISOString());
    const providerPerformanceCache: PerformanceAggregate = {
      ...cacheBase,
      version: PERFORMANCE_READ_MODEL_VERSION,
      totalPnl: providerPerformance.verifiedRealizedPnl,
      totalTrades: livePortfolio ? providerPerformance.totalTrades : providerPerformance.closedTrades,
      openTrades: livePortfolio ? providerPerformance.openTrades : 0,
      closedTrades: providerPerformance.closedTrades,
      wins: providerPerformance.wins,
      losses: providerPerformance.losses,
      breakeven: providerPerformance.breakeven,
      winRate: classifiedWinRate(providerPerformance.wins, providerPerformance.losses, providerPerformance.breakeven),
      closedEpisodeRealizedPnl: providerPerformance.closedEpisodeRealizedPnl,
      openEpisodePartialRealizedPnl: "UNAVAILABLE",
      verifiedRealizedPnl: providerPerformance.verifiedRealizedPnl,
      providerDailyPnl: providerPerformance.dailyPnl,
      financialSource: "PROVIDER_LEDGER",
      providerOpenTradeCountKnown: Boolean(livePortfolio),
      netExternalInflows: flows.netExternalInflows,
      externalFlowStatus: flows.status,
    };
    if (JSON.stringify(persistedPerformance) !== JSON.stringify(providerPerformanceCache)) savePerformanceAggregate(this, providerPerformanceCache, livePortfolio?.observedAt ?? new Date().toISOString());
    const accounting = {
      ...accountingBase,
      netExternalInflows: flows.netExternalInflows,
      externalFlowStatus: flows.status,
      netPnlSinceBaseline,
      closedEpisodeRealizedPnl: providerPerformance.closedEpisodeRealizedPnl,
      openEpisodePartialRealizedPnl: "UNAVAILABLE",
      verifiedRealizedPnl: providerPerformance.verifiedRealizedPnl,
      wins: providerPerformance.wins,
      losses: providerPerformance.losses,
      breakeven: providerPerformance.breakeven,
      classifiedClosedTrades: providerPerformance.wins + providerPerformance.losses + providerPerformance.breakeven,
      winRatePct: classifiedWinRate(providerPerformance.wins, providerPerformance.losses, providerPerformance.breakeven),
      source: livePortfolio ? "PROVIDER_LIVE" as const : "UNAVAILABLE" as const,
    };
    const performance = {
      totalPnl: providerPerformance.verifiedRealizedPnl,
      winRate: accounting.winRatePct,
      dailyDrawdown: drawdownPct,
      totalTrades: livePortfolio ? providerPerformance.totalTrades : null,
      openTrades: livePortfolio ? providerPerformance.openTrades : null,
      closedTrades: providerPerformance.closedTrades,
      wins: providerPerformance.wins,
      losses: providerPerformance.losses,
      breakeven: providerPerformance.breakeven,
      closedEpisodeRealizedPnl: providerPerformance.closedEpisodeRealizedPnl,
      openEpisodePartialRealizedPnl: "UNAVAILABLE",
      verifiedRealizedPnl: providerPerformance.verifiedRealizedPnl,
      competitionBaselineEquity: accounting.baselineEquity,
      latestEquity: accounting.currentEquity,
      performanceBaselineAt: accounting.baselineObservedAt,
      dailyPnl: providerPerformance.dailyPnl,
      financialSource: "PROVIDER_LEDGER" as const,
      scope: "DARWIN_ATTRIBUTED" as const,
      unresolvedClosedLifecycles: providerPerformance.unresolvedClosedLifecycles,
    };
    return {
      version: config.version ?? "0.2.0",
      commit: config.commit ?? "local",
      environment: config.environment ?? "production",
      agent: {
        status: this.state.runtimeStatus,
        runtimeMode: config.agentMode,
        currentStage: this.state.currentStage,
        lastScan: this.state.lastScanAt,
        nextScan: this.state.nextScanAt,
        model: this.state.model || config.qwenModel,
        paperMode: true,
      },
      portfolio: livePortfolio ?? null,
      portfolioFreshness: livePortfolio ? { source: "PROVIDER_LIVE", observedAt: livePortfolio.observedAt, stale: false } : { source: "UNAVAILABLE", observedAt: new Date().toISOString(), stale: true, errorCode: "LIVE_PORTFOLIO_REQUIRED" },
      performance,
      accountPerformance,
      performanceAccounting: accounting,
      trades: [],
      latestDecision: latestValidCycle?.plan.entryActions[0] ?? latestValidCycle?.plan.positionActions[0] ?? null,
      decisions: recentJournals.flatMap((entry) => cyclePlanDecisions(entry)),
      latestCyclePlan: latestValidCycle?.plan ?? null,
      latestCycleStatus,
      cyclePlans: recentCycles,
      latestDiscovery: latestValidCycle?.discovery ?? null,
      executionEvidence: executionEvidence(journal),
      learning: { reflection: journal?.reflection ?? null, lessons: [], lessonsUsed: journal ? cyclePlanDecisions(journal).flatMap((decision) => decision.lessonsUsed) : [], backtest: null, recentExperiences: [] },
      riskControls: { ...config.ownerPolicy, scanIntervalMinutes: temporaryScanIntervalActive(this.state.temporaryScanIntervalExpiresAt, this.state.temporaryScanIntervalCompleted) ? TEMPORARY_SCAN_INTERVAL_MINUTES : config.ownerPolicy.scanIntervalMinutes, temporaryScanIntervalExpiresAt: this.state.temporaryScanIntervalExpiresAt, drawdownBlocked: Boolean(drawdown?.cooldownUntil && new Date(drawdown.cooldownUntil).getTime() > Date.now()), drawdownCode: drawdown?.cooldownUntil ? "DRAWDOWN_COOLDOWN" : "NONE", cooldownUntil: drawdown?.cooldownUntil ?? null },
      activity: events,
      lastPolicyUpdate: events.find((event) => event.type === "POLICY_UPDATED") ?? null,
      // Snapshot scheduler metrics intentionally cover the same bounded recent event window.
      scheduler: { ...schedulerMetrics(events), ...scheduler, tradingSchedulerHealthy: scheduler.schedulerHealthy, providerSyncSchedulerHealthy: await this.isProviderSyncSchedulerHealthy() },
    };
  }

  private async isProviderSyncSchedulerHealthy(): Promise<boolean> {
    try {
      const schedules = (await this.listSchedules()).filter((schedule) => schedule.callback === "runScheduledProviderSync");
      return schedules.length === 1 && schedules[0]?.type === "interval" && schedules[0]?.intervalSeconds === PROVIDER_LEDGER_INTERVAL_SECONDS;
    } catch {
      return false;
    }
  }

  private async getSchedulerDiagnostics(intervalMinutes: number, now = Date.now()): Promise<Pick<DashboardSnapshot["scheduler"], "nextScanAt" | "nextScanStale" | "configuredIntervalMinutes" | "matchingScheduleCount" | "schedulerHealthy" | "schedulerErrorCode">> {
    try {
      const result = await this.reconcileScheduler(intervalMinutes, { now });
      const schedulerHealthy = this.state.paused || this.state.emergencyStop
        ? result.cycleSchedules.length === 0
        : result.cycleSchedules.length === 1 && result.matchingSchedules.length === 1 && !result.nextScanStale;
      return { nextScanAt: result.nextScanAt, nextScanStale: result.nextScanStale, configuredIntervalMinutes: intervalMinutes, matchingScheduleCount: result.matchingSchedules.length, schedulerHealthy };
    } catch (error) {
      const errorCode = error instanceof Error && error.message.startsWith("SCHEDULE_LIST_FAILED") ? "SCHEDULE_LIST_FAILED" : "SCHEDULE_REPAIR_FAILED";
      return { nextScanAt: this.state.nextScanAt, nextScanStale: true, configuredIntervalMinutes: intervalMinutes, matchingScheduleCount: 0, schedulerHealthy: false, schedulerErrorCode: errorCode };
    }
  }

  private async reconcileScheduler(intervalMinutes: number, options: { ensureSchedule?: boolean; now?: number; state?: Parameters<typeof reconcileTradingSchedule>[2]; baseState?: AgentState } = {}): Promise<SchedulerReconciliationResult> {
    const reconciliationState = options.state ?? {
      paused: this.state.paused,
      emergencyStop: this.state.emergencyStop,
      activeCycle: this.state.lastStatus === "RUNNING" || Boolean(this.state.cycleStartedAt),
      nextScanAt: this.state.nextScanAt,
    };
    const { state: _state, baseState, ...schedulerOptions } = options;
    const result = await reconcileTradingSchedule(this, intervalMinutes, reconciliationState, schedulerOptions);
    if (result.matchingSchedules.length === 1 && result.nextScanAt !== reconciliationState.nextScanAt) {
      this.setState({ ...(baseState ?? this.state), nextScanAt: result.nextScanAt });
    }
    return result;
  }

  private getAgentJournal(url: URL): Response {
    ensureStorage(this);
    const limit = clampHistoryLimit(Number(url.searchParams.get("limit") ?? "25"));
    const journals = loadRecentJournals(this, limit);
    const storedCycles = loadRecentStoredCycles(this, limit);
    const events = loadRecentEvents(this, limit);
    const cycles = journals.map((entry) => cycleReadModelWithStatus(entry, storedCycles, events));
    return json({ journals, cycles, latestValidCyclePlan: loadLatestValidCyclePlan(this), decisions: journals.flatMap((entry) => cyclePlanDecisions(entry)), limit });
  }

  private getPositionContext(url: URL): Response {
    ensureStorage(this);
    const symbol = url.searchParams.get("symbol")?.trim() ?? "";
    const positionSide = url.searchParams.get("positionSide");
    if (!/^[A-Z0-9_-]{1,40}$/.test(symbol) || (positionSide !== "LONG" && positionSide !== "SHORT")) return json({ error: "INVALID_POSITION_CONTEXT_KEY" }, 400);
    return json({ source: "DARWIN_PERSISTED", context: loadPositionContext(this, symbol, positionSide) });
  }

  private async getTradeHistory(url: URL): Promise<Response> {
    ensureStorage(this);
    const limit = clampHistoryLimit(Number(url.searchParams.get("limit") ?? "25"));
    const recentExperiences = loadExperiences(this, 100);
    const histories = loadProviderPositionHistories(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, 100);
    const historyDecisionIds = loadProviderPositionHistoryDecisionIds(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, histories);
    const config = loadConfig(this.env, this.ensureActivePolicy());
    let positions: PositionSnapshot[] = [];
    try {
      positions = (await new BitgetClient(config).getDashboardPortfolio()).positions;
    } catch {
      // Missing current provider evidence keeps open-trade financials unresolved.
    }
    const openPositionIdentities = loadProviderLiveOpeningOrderIdentities(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, positions);
    const reasoningDecisionIds = [...new Set([...historyDecisionIds.values(), ...[...openPositionIdentities.values()].map((identity) => identity.decisionId)])];
    const targetedExperiences = loadExperiencesForDecisionIds(this, reasoningDecisionIds, 100);
    const experiencesById = new Map([...recentExperiences, ...targetedExperiences].map((experience) => [experience.experienceId, experience]));
    const experiences = [...experiencesById.values()];
    const journalsByCycleId = new Map(loadRecentJournals(this, 100).map((journal) => [journal.cycleId, journal]));
    for (const journal of loadJournalsForDecisionIds(this, reasoningDecisionIds, 100)) journalsByCycleId.set(journal.cycleId, journal);
    const journals = [...journalsByCycleId.values()];
    const recentLivePositionKeys = positions
      .filter((position) => position.openedAt && (position.positionSide === "LONG" || position.positionSide === "SHORT"))
      .sort((left, right) => (right.openedAt ?? "").localeCompare(left.openedAt ?? ""))
      .slice(0, limit)
      .map((position) => `${position.symbol}:${position.positionSide}`);
    const contextKeys = [
      ...experiences.flatMap((experience) => experience.positionSide ? [`${experience.symbol}:${experience.positionSide}`] : []),
      ...histories.map((history) => `${history.symbol}:${history.positionSide}`),
      ...recentLivePositionKeys,
    ];
    const contexts = loadPositionContextsForKeys(this, contextKeys, Math.min(limit * 4, 400));
    const resolved = resolveProviderTradeFacts(this, experiences, PROVIDER_TRADE_LIFECYCLE_CATEGORY, positions, { histories, historyDecisionIds, openPositionIdentities, positionContexts: contexts });
    const localTrades = tradeLogEntries(experiences, journals, contexts, resolved.facts).filter((trade) => {
      const fact = experiences.find((experience) => experience.experienceId === trade.tradeId);
      const source = fact ? resolved.facts.get(fact.experienceId)?.source : undefined;
      return source !== "PROVIDER_LEDGER" && source !== "PROVIDER_LIVE";
    });
    const providerOnlyTrades: DashboardSnapshot["trades"] = resolved.providerOnlyHistories.map(({ history, decisionId, providerOrderId, managementExecutions }) => {
      const persistedReasoning = providerPersistedReasoning(decisionId, history.symbol, history.positionSide as PositionSide, journals, contexts);
      return {
        tradeId: `provider-history:${history.providerPositionHistoryId}`,
        timestamp: history.closingTime ?? history.openingTime,
        symbol: history.symbol,
        action: history.positionSide === "SHORT" ? "OPEN_SHORT" : "OPEN_LONG",
        marginAllocationPct: "UNAVAILABLE",
        marginAllocated: "UNAVAILABLE",
        leverage: "UNAVAILABLE",
        positionNotional: "UNAVAILABLE",
        entry: history.avgEntryPrice ?? "UNAVAILABLE",
        exit: history.avgExitPrice ?? "UNAVAILABLE",
        realizedPnl: history.netProfit ?? "UNAVAILABLE",
        status: "CLOSED",
        thesis: persistedReasoning.thesis,
        orderReference: providerOrderId || "UNAVAILABLE",
        providerOrderId: providerOrderId || "UNAVAILABLE",
        positionSide: history.positionSide as TradeExperience["positionSide"],
        openedAt: history.openingTime,
        entryTime: history.openingTime,
        closedAt: history.closingTime,
        exitTime: history.closingTime,
        financialSource: "PROVIDER_LEDGER",
        origin: "DARWIN",
        reasoningSource: persistedReasoning.reasoningSource,
        ...(persistedReasoning.entryReasoning ? { entryReasoning: persistedReasoning.entryReasoning } : {}),
        ...(persistedReasoning.managementEvents?.length ? { managementEvents: persistedReasoning.managementEvents } : {}),
        ...(managementExecutions.length ? { managementExecutions } : {}),
        ...(history.providerPositionHistoryId ? { providerPositionHistoryId: history.providerPositionHistoryId } : {}),
        quantity: history.closeTotalPos ?? "UNAVAILABLE",
        openQuantity: history.openTotalPos ?? "UNAVAILABLE",
        closeQuantity: history.closeTotalPos ?? "UNAVAILABLE",
        cumRealisedPnl: history.cumRealisedPnl ?? "UNAVAILABLE",
        netProfit: history.netProfit ?? "UNAVAILABLE",
        openFeeTotal: history.openFeeTotal ?? "UNAVAILABLE",
        closeFeeTotal: history.closeFeeTotal ?? "UNAVAILABLE",
        totalFunding: history.totalFunding ?? "UNAVAILABLE",
        cashDividend: history.cashDividend ?? "UNAVAILABLE",
      };
    });
    const providerOnlyLiveTrades: DashboardSnapshot["trades"] = resolved.providerOnlyOpenPositions.map(({ position, providerOrderId, decisionId, managementExecutions }) => {
      const persistedReasoning = providerPersistedReasoning(decisionId, position.symbol, position.positionSide, journals, contexts);
      return {
        tradeId: `provider-open:${providerOrderId}`,
        timestamp: position.openedAt ?? "UNAVAILABLE",
        symbol: position.symbol,
        action: position.positionSide === "SHORT" ? "OPEN_SHORT" : "OPEN_LONG",
        marginAllocationPct: "UNAVAILABLE",
        marginAllocated: position.marginAllocated,
        leverage: position.leverage,
        positionNotional: position.notional,
        entry: position.entryPrice,
        exit: "UNAVAILABLE",
        realizedPnl: "UNAVAILABLE",
        status: "OPEN",
        thesis: persistedReasoning.thesis,
        orderReference: providerOrderId,
        providerOrderId,
        positionSide: position.positionSide,
        openedAt: position.openedAt ?? "UNAVAILABLE",
        entryTime: position.openedAt ?? "UNAVAILABLE",
        financialSource: "PROVIDER_LIVE",
        origin: "DARWIN",
        reasoningSource: persistedReasoning.reasoningSource,
        ...(persistedReasoning.entryReasoning ? { entryReasoning: persistedReasoning.entryReasoning } : {}),
        ...(persistedReasoning.managementEvents?.length ? { managementEvents: persistedReasoning.managementEvents } : {}),
        ...(managementExecutions.length ? { managementExecutions } : {}),
        quantity: position.quantity,
        unrealizedPnl: position.unrealizedPnl,
        ...(position.unrealizedPnlPct ? { unrealizedPnlPct: position.unrealizedPnlPct } : {}),
        ...(position.markPrice ? { markPrice: position.markPrice } : {}),
        ...(position.liquidationPrice ? { liquidationPrice: position.liquidationPrice } : {}),
      };
    });
    const trades = [...localTrades, ...providerOnlyTrades, ...providerOnlyLiveTrades]
      .sort((left, right) => {
        const leftTime = Date.parse(left.timestamp);
        const rightTime = Date.parse(right.timestamp);
        const validLeft = Number.isFinite(leftTime) ? leftTime : -1;
        const validRight = Number.isFinite(rightTime) ? rightTime : -1;
        return validRight - validLeft || left.tradeId.localeCompare(right.tradeId);
      })
      .slice(0, limit);
    return json({ trades, financialSource: "PROVIDER_LEDGER_OR_LIVE", limit });
  }

  private getLearning(url: URL): Response {
    ensureStorage(this);
    const limit = clampHistoryLimit(Number(url.searchParams.get("limit") ?? "25"));
    const journal = loadLatestJournal(this);
    return json({ learning: { reflection: journal?.reflection ?? null, lessons: loadRecentLessons(this, limit), lessonsUsed: cyclePlanDecisions(journal).flatMap((decision) => decision.lessonsUsed), backtest: loadLatestBacktest(this), recentExperiences: loadExperiences(this, limit) }, limit });
  }

  private getPolicyRead(): Response {
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const drawdown = loadDailyDrawdownState(this);
    const events = loadRecentEvents(this, SNAPSHOT_EVENT_LIMIT);
    const riskControls: DashboardSnapshot["riskControls"] = { ...config.ownerPolicy, scanIntervalMinutes: temporaryScanIntervalActive(this.state.temporaryScanIntervalExpiresAt, this.state.temporaryScanIntervalCompleted) ? TEMPORARY_SCAN_INTERVAL_MINUTES : config.ownerPolicy.scanIntervalMinutes, temporaryScanIntervalExpiresAt: this.state.temporaryScanIntervalExpiresAt, drawdownBlocked: Boolean(drawdown?.cooldownUntil && new Date(drawdown.cooldownUntil).getTime() > Date.now()), drawdownCode: drawdown?.cooldownUntil ? "DRAWDOWN_COOLDOWN" : "NONE", cooldownUntil: drawdown?.cooldownUntil ?? null };
    return json({ riskControls, lastPolicyUpdate: events.find((event) => event.type === "POLICY_UPDATED") ?? null });
  }

  private async runCycle(): Promise<TradingJournal> {
    if (this.state.paused) throw new Error("AGENT_PAUSED");
    if (this.state.emergencyStop) throw new Error("EMERGENCY_STOP");
    if (this.state.lastStatus === "RUNNING" && !this.recoverStaleCycle()) {
      this.recordEvent("CYCLE_IN_PROGRESS", this.state.lastCycleId ?? "UNKNOWN", { code: "CYCLE_IN_PROGRESS" });
      throw new Error("CYCLE_IN_PROGRESS");
    }
    const startedAt = new Date().toISOString();
    const cycleId = crypto.randomUUID();
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const nextScanAt = new Date(Date.now() + this.activeScanIntervalMinutes(config.ownerPolicy) * 60_000).toISOString();
    this.setState({ ...this.state, lastCycleId: cycleId, lastScanAt: startedAt, nextScanAt, model: config.qwenModel, runtimeStatus: "SCANNING", currentStage: "SCANNING", lastStatus: "RUNNING", cycleStartedAt: startedAt });
    saveCycle(this, cycleId, "RUNNING", startedAt, null);
    const journal: TradingJournal = { cycleId, agentVersion: config.version ?? "0.2.0", promptVersion: MANDATE_VERSION, model: config.qwenModel, mode: config.agentMode, startedAt, retrievedLessons: [], createdLessons: [] };
    let failureStage: string | undefined;
    this.recordEvent("CYCLE_STARTED", cycleId);
    try {
      const client = new BitgetClient(config);
      const initialPortfolio = await client.getDashboardPortfolio();
      const livePositions = initialPortfolio.positions.filter((position) => Number(position.quantity) > 0);
      const openPositionSymbols = [...new Set(livePositions.map((position) => position.symbol))];
      const openPositionCount = countOpenPositionLifecycles(livePositions);
      const instruments = await client.getTradableInstruments().catch(() => {
        this.recordEvent("DEMO_UNIVERSE_UNAVAILABLE", cycleId);
        return [];
      });
      if (instruments.length === 0 && openPositionCount === 0) throw new Error("NO_TRADABLE_INSTRUMENTS");
      const supportedUniverse = instruments.map((instrument) => instrument.symbol);
      const allLessons = loadUsableLessons(this);
      const experiences = loadExperiences(this);
      const scan = await client.collectLightweightScan(instruments);
      const newEntryMarketCandidates = filterNewEntryMarketCandidates(scan, openPositionSymbols);
      const rankedScan = rankMarketCandidates(newEntryMarketCandidates);
      this.recordEvent("MARKET_SCAN", cycleId, { symbols: String(scan.length), preRanked: String(rankedScan.length) });
      this.setState({ ...this.state, runtimeStatus: "ANALYZING", currentStage: "ANALYZING" });
      const selectedEntryCandidateSymbols = await selectEntryCandidates(config, supportedUniverse, rankedScan, openPositionCount);
      const evidenceSymbols = buildEvidenceSymbols(openPositionSymbols, selectedEntryCandidateSymbols);
      if (calculateActionCapacity(openPositionCount).remainingEntrySlots === 0) this.recordEvent("CANDIDATE_SELECTION_SKIPPED", cycleId, { code: "CAPACITY_SATURATED", openPositionCount: String(openPositionCount) });
      else this.recordEvent("CANDIDATE_SELECTED", cycleId, { symbols: selectedEntryCandidateSymbols.join(",") });
      const bundles = await client.collectEvidence(evidenceSymbols);
      const lessons = bundles.flatMap((bundle) => retrieveLessons(allLessons, { symbol: bundle.instrument.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN" }, 3))
        .filter((lesson, index, list) => list.findIndex((candidate) => candidate.lessonId === lesson.lessonId) === index)
        .slice(0, 5);
      const account = bundles[0]?.account ?? await client.getDashboardPortfolio();
      const openPositions = [...new Map((bundles.flatMap((bundle) => bundle.account.positions).length ? bundles.flatMap((bundle) => bundle.account.positions) : account.positions).map((position) => [`${position.symbol}:${position.positionSide}`, position])).values()];
      const discovery: CycleDiscovery = {
        executableStockUniverseCount: instruments.length,
        scannedStockCount: scan.length,
        rankedCandidatePoolCount: rankedScan.length,
        selectedCandidateCount: selectedEntryCandidateSymbols.length,
        currentOpenPositionCount: openPositionCount,
        remainingEntrySlots: calculateActionCapacity(openPositionCount).remainingEntrySlots,
        existingPositionsManagedCount: openPositions.filter((position) => Number(position.quantity) > 0).length,
        scannedUniverseCount: scan.length,
        selectedEntryCandidateSymbols,
        managedExistingPositionSymbols: openPositions.filter((position) => Number(position.quantity) > 0).map((position) => position.symbol).sort(),
        financialWritesPerformed: 0,
      };
      journal.discovery = discovery;
      try {
        assertOpenPositionCountWithinPlanLimit(openPositions);
      } catch (error) {
        this.recordEvent("PLAN_REJECTED", cycleId, { code: "OPEN_POSITION_COUNT_EXCEEDS_PLAN_LIMIT", openPositionCount: String(openPositions.filter((position) => Number(position.quantity) > 0).length), maxActions: "5" });
        throw error;
      }
      journal.positionDiscrepancies = this.recordPositionDiscrepancies(experiences, openPositions, cycleId);
      recordLessonRetrieval(this, lessons.map((lesson) => lesson.lessonId), cycleId, startedAt);
      const drawdown = evaluateDrawdown(config.ownerPolicy, loadDailyDrawdownState(this), account.portfolioEquity, new Date());
      saveDailyDrawdownState(this, drawdown.state, new Date().toISOString());
      if (drawdown.blocked) {
        this.setState({ ...this.state, runtimeStatus: "COOLDOWN", currentStage: "COOLDOWN" });
        this.recordEvent("COOLDOWN_STARTED", cycleId, { code: drawdown.code });
      }
      const backtestSymbol = selectedEntryCandidateSymbols[0] ?? openPositionSymbols[0] ?? supportedUniverse[0] ?? "";
      let backtest: BacktestReplay | undefined;
      if (drawdown.blocked) {
        try {
          const bars = await client.getHistoricalBars(backtestSymbol);
          backtest = await runCooldownBacktestSafely(config, { symbol: backtestSymbol, bars, experiences: experiences.filter((experience) => experience.outcomeStatus !== "EXECUTION_FAILURE"), trigger: drawdown.code }, (metadata) => this.recordEvent("BACKTEST_FAILED", cycleId, metadata));
        } catch (error) {
          this.recordEvent("BACKTEST_FAILED", cycleId, backtestFailureMetadata(error));
        }
      }
      if (backtest) { saveBacktest(this, backtest); journal.backtest = backtest; this.recordEvent("BACKTEST_COMPLETED", cycleId); }
      const lifecycleHistory = experiences.some((experience) => experience.outcomeStatus === "OPEN" && !experience.maximumFavorableExcursionBasis) ? loadAllAutonomousJournals(this) : [];
      const positionManagementState = this.refreshPositionManagementState(experiences, openPositions, bundles, new Date().toISOString(), lifecycleHistory);
      journal.positionManagementState = positionManagementState;
      journal.promptVersions = { mandate: PROMPT_VERSIONS.mandate, decision: PROMPT_VERSIONS.decision };
      const openExperiences = experiences.filter((experience) => experience.outcomeStatus === "OPEN");
      const executionCapacityHints = buildExecutionCapacityHints(bundles, config.ownerPolicy.maxLeverage);
      const researchEvidence = await this.collectResearchEvidence(
        config,
        bundles,
        openPositionSymbols,
        selectedEntryCandidateSymbols,
        cycleId,
      );
      const context = { bundles, supportedUniverse, openPositionSymbols, entryCandidateSymbols: selectedEntryCandidateSymbols, experiences, openExperiences, lessons, openPositions, positionManagementState, observedAt: new Date().toISOString(), mandate: TRADING_MANDATE, ...(researchEvidence === undefined ? {} : { researchEvidence }), executionCapacityHints };
      let decisionSet: Awaited<ReturnType<typeof decide>>;
      try {
        decisionSet = await decide(config, context, cycleId);
      } catch (error) {
        if (error instanceof ZodError) failureStage = "decision_schema_validation";
        throw error;
      }
      if (decisionSet.ignoredLessonIds.length) this.recordEvent("LESSON_REFERENCE_IGNORED", cycleId, { count: String(decisionSet.ignoredLessonIds.length), ids: decisionSet.ignoredLessonIds.slice(0, 8).join(",") });
      journal.marketContext = { scan, deep: bundles.map((candidate) => ({ market: candidate.market, regime: candidate.marketRegime })) };
      journal.portfolio = account;
      journal.evidence = bundles.flatMap((candidate) => candidate.evidence);
      journal.retrievedLessons = lessons.map((lesson) => lesson.lessonId);
      const plan: CycleDecisionPlan = decisionSet.plan;
      journal.cyclePlan = plan;
      const execution = journal.positionDiscrepancies && journal.positionDiscrepancies.length > 0
        ? (() => {
          this.recordEvent("FINANCIAL_WRITES_STOPPED", cycleId, { code: "LOCAL_LIFECYCLE_UNRESOLVED" });
          this.recordEvent("PLAN_REMAINING_ACTIONS_SKIPPED", cycleId, { code: "LOCAL_LIFECYCLE_UNRESOLVED" });
          return { records: [], finalPortfolio: undefined, stoppedAfterAmbiguity: true };
        })()
        : await executeCyclePlan(plan, {
        refreshEvidence: async (symbol) => (await client.collectEvidence([symbol]))[0],
        execute: async (action, actionBundle, decisionType, parentDecision) => {
          this.setState({ ...this.state, runtimeStatus: "RISK_CHECK", currentStage: "RISK_CHECK" });
          return this.executeDecision(client, config, action, actionBundle, cycleId, supportedUniverse, drawdown.blocked, startedAt, decisionType, parentDecision, journal.positionDiscrepancies ?? []);
        },
        persist: async (record, actionBundle) => {
          appendExecutionRecordToJournal(journal, record, discovery);
          saveJournal(this, journal);
          await this.persistDecisionOutcome(config, record, actionBundle, experiences, lessons, cycleId, startedAt, journal, record.decision.action !== "HOLD");
        },
        refreshPortfolio: async () => client.getDashboardPortfolio(),
        onAmbiguousWrite: (record) => {
          this.recordEvent("FINANCIAL_WRITES_STOPPED", cycleId, { code: "EXECUTION_UNRESOLVED", symbol: record.decision.symbol, action: record.decision.action });
          this.recordEvent("PLAN_REMAINING_ACTIONS_SKIPPED", cycleId, { code: "EXECUTION_UNRESOLVED" });
        },
      });
      journal.executionRecords = execution.records;
      journal.discovery = { ...discovery, financialWritesPerformed: execution.records.filter((record) => Boolean(record.executionResult)).length };
      if (execution.finalPortfolio) journal.portfolio = execution.finalPortfolio;
      this.persistPerformanceEquity(execution.finalPortfolio?.portfolioEquity ?? account.portfolioEquity, execution.finalPortfolio?.observedAt ?? account.observedAt);
      this.setState({ ...this.state, runtimeStatus: "REFLECTING", currentStage: "REFLECTING" });
      const backtestLesson = backtest ? createBacktestLesson(backtest) : undefined;
      journal.createdLessons = [...journal.createdLessons, ...(backtestLesson ? [backtestLesson.lessonId] : [])];
      if (backtestLesson) saveLesson(this, backtestLesson);
      if (backtestLesson) this.recordEvent("LESSON_CREATED", cycleId, { source: "BACKTEST_REPLAY" });
      journal.completedAt = new Date().toISOString();
      journal.durationMs = Math.max(0, new Date(journal.completedAt).getTime() - new Date(startedAt).getTime());
      this.recordEvent("CYCLE_COMPLETED", cycleId, { durationMs: String(journal.durationMs) });
      saveJournal(this, journal);
      saveCycle(this, cycleId, "COMPLETED", startedAt, journal.completedAt);
      saveLatestValidCyclePlan(this, { cycleId, plan, ...(journal.discovery ? { discovery: journal.discovery } : {}), startedAt, completedAt: journal.completedAt });
      this.setState({ ...this.state, runtimeStatus: drawdown.blocked ? "COOLDOWN" : "ONLINE", currentStage: drawdown.blocked ? "COOLDOWN" : "ONLINE", lastStatus: "COMPLETED", cycleStartedAt: null });
      return journal;
    } catch (error) {
      journal.completedAt = new Date().toISOString();
      journal.durationMs = Math.max(0, new Date(journal.completedAt).getTime() - new Date(startedAt).getTime());
      saveJournal(this, journal);
      saveCycle(this, cycleId, "FAILED", startedAt, journal.completedAt);
      const diagnostic = failureDiagnostic(error);
      if (failureStage) this.recordEvent("DECISION_SCHEMA_VALIDATION_FAILED", cycleId, { ...diagnostic, stage: failureStage });
      this.recordEvent("CYCLE_FAILED", cycleId, { ...diagnostic, ...(failureStage ? { stage: failureStage } : {}), durationMs: String(journal.durationMs) });
      if ((diagnostic.code ?? "").includes("TIMEOUT")) this.recordEvent("CYCLE_TIMEOUT", cycleId, diagnostic);
      this.setState({ ...this.state, runtimeStatus: "ERROR", currentStage: "ERROR", lastStatus: "FAILED", cycleStartedAt: null });
      throw error;
    }
  }

  private async collectResearchEvidence(
    config: RuntimeConfig,
    bundles: readonly EvidenceBundle[],
    openPositionSymbols: readonly string[],
    entryCandidateSymbols: readonly string[],
    cycleId: string,
  ): Promise<ResearchEvidence[] | undefined> {
    const { telemetry, summary } = this.setupResearchTelemetry(cycleId);
    const phaseStartedAt = Date.now();
    summary.signalEnabled = config.bitgetSignalEnabled ?? false;

    try {
      if (!config.bitgetSignalEnabled) {
        summary.finalStatus = "SIGNAL_DISABLED";
        summary.researchDurationMs = Date.now() - phaseStartedAt;
        this.emitResearchSummary(summary);
        return undefined;
      }
      const availableResearchSkills = availableResearchCapabilities();
      summary.availableSkillCount = availableResearchSkills.length;
      if (availableResearchSkills.length === 0) {
        summary.finalStatus = "NO_AVAILABLE_CAPABILITY";
        summary.researchDurationMs = Date.now() - phaseStartedAt;
        this.emitResearchSummary(summary);
        return [];
      }
      summary.routerAttempted = true;
      const routerInput: ResearchRouterInput = {
        availableResearchSkills,
        openPositionSymbols: [...openPositionSymbols],
        entryCandidateSymbols: [...entryCandidateSymbols],
        marketEvidence: bundles.map((bundle) => ({
          symbol: bundle.instrument.symbol,
          lastPrice: bundle.market.lastPrice,
          priceChange24h: bundle.market.priceChange24h,
          volume24h: bundle.market.volume24h,
          marketRegime: bundle.marketRegime ?? "UNKNOWN",
        })),
        researchBudget: { maxResearchRequests: 3, maxMcpToolCalls: 4, concurrency: 2 },
      };
      let plan: ResearchPlan;
      try {
        plan = await this.researchRouter.plan(config, routerInput);
      } catch (routerError) {
        summary.finalStatus = "ROUTER_FAILED";
        summary.researchDurationMs = Date.now() - phaseStartedAt;
        this.emitResearchSummary(summary);
        return [];
      }
      summary.routerPlanRequestCount = plan.requests.length;
      for (const req of plan.requests) {
        if (summary.requestedSkills.length < 3) summary.requestedSkills.push(req.skill);
        if (summary.requestedSymbols.length < 3) summary.requestedSymbols.push(req.symbol ?? "GLOBAL");
      }
      const validation = validateResearchPlan(plan, routerInput);
      summary.acceptedRequestCount = validation.accepted.length;
      summary.rejectedRequestCount = validation.rejected.length;
      const evidence = await this.researchExecutor.executeWithTelemetry(validation.accepted, telemetry);
      summary.researchDurationMs = Date.now() - phaseStartedAt;
      const availableCount = evidence.filter((e) => e.status === "AVAILABLE").length;
      const unavailableCount = evidence.length - availableCount;
      summary.availableResults = availableCount;
      summary.unavailableResults = unavailableCount;
      if (evidence.length === 0) {
        summary.finalStatus = "NO_RESULTS";
      } else if (availableCount === evidence.length) {
        summary.finalStatus = "COMPLETED";
      } else if (availableCount > 0) {
        summary.finalStatus = "PARTIAL";
      } else {
        summary.finalStatus = "UNAVAILABLE";
      }
      this.emitResearchSummary(summary);
      return evidence;
    } catch (error) {
      summary.researchDurationMs = Date.now() - phaseStartedAt;
      summary.finalStatus = "ERROR";
      this.emitResearchSummary(summary);
      return [];
    }
  }

  private recoverStaleCycle(): boolean {
    const cycleStartedAt = this.state.cycleStartedAt ?? this.state.lastScanAt;
    const startedMs = cycleStartedAt ? new Date(cycleStartedAt).getTime() : 0;
    if (!cycleStartedAt || !startedMs || Date.now() - startedMs < STALE_CYCLE_TIMEOUT_MS) return false;
    const cycleId = this.state.lastCycleId ?? "UNKNOWN";
    const cycleEvents = loadRecentEvents(this, 100).filter((event) => event.cycleId === cycleId);
    const hasFinancialWrite = cycleEvents.some((event) => ["PAPER_ORDER_SUBMITTED", "EXECUTION_UNRESOLVED", "EXECUTION_VERIFIED"].includes(event.type));
    if (hasFinancialWrite) return false;
    const completedAt = new Date().toISOString();
    saveCycle(this, cycleId, "FAILED", cycleStartedAt, completedAt);
    this.recordEvent("CYCLE_STALE", cycleId, { code: "STALE_CYCLE", ageSeconds: String(Math.floor((Date.now() - startedMs) / 1000)) });
    this.setState({ ...this.state, runtimeStatus: "ERROR", currentStage: "ERROR", lastStatus: "FAILED", cycleStartedAt: null });
    return true;
  }

  private async executeDecision(
    client: BitgetClient,
    config: RuntimeConfig,
    decision: Decision,
    bundle: EvidenceBundle,
    cycleId: string,
    supportedUniverse: readonly string[],
    dailyDrawdownBlocked: boolean,
    startedAt: string,
    decisionType: "POSITION_MANAGEMENT" | "NEW_ENTRY",
    parentDecision?: Decision,
    positionDiscrepancies: readonly string[] = [],
  ): Promise<DecisionExecutionRecord> {
    const riskGateResult = evaluateRiskGate(config, { decision, instrument: bundle.instrument, account: bundle.account, market: bundle.market, evidenceObservedAt: bundle.market.observedAt, openOrderSymbols: bundle.account.openOrderSymbols, supportedUniverse, emergencyStop: this.state.emergencyStop || config.ownerPolicy.emergencyStop, dailyDrawdownBlocked, positionDiscrepancies });
    this.recordEvent("DECISION_CREATED", cycleId, { action: decision.action, symbol: decision.symbol, decisionType });
    this.recordEvent(riskGateResult.status === "PASS" ? "RISK_GATE_PASS" : "RISK_GATE_BLOCK", cycleId, { codes: riskGateResult.codes.join(","), decisionType, symbol: decision.symbol });
    const positionBefore = findPosition(bundle.account.positions, decision.symbol, decision.positionSide);
    const record: DecisionExecutionRecord = { decision, riskGateResult, ...(parentDecision ? { parentDecisionId: parentDecision.decisionId, parentAction: "REVERSE" as const, parentDecision } : {}), ...(positionBefore ? { positionBefore } : {}) };
    if (riskGateResult.status === "BLOCK" || decision.action === "HOLD") return record;
    this.setState({ ...this.state, runtimeStatus: "EXECUTING", currentStage: "EXECUTING" });
    const executionRequest = buildExecutionRequest(decision, bundle, cycleId);
    if (!recordIdempotency(this, executionRequest.clientOrderId, cycleId, decision.decisionId, startedAt)) throw new Error("DUPLICATE_ORDER");
    this.recordEvent("PAPER_ORDER_SUBMITTED", cycleId, { symbol: decision.symbol, action: decision.action, decisionType });
    const executionResult = await executePaperOrder(client, executionRequest);
    if (executionResult.providerOrderId) recordProviderOrderReference(this, executionRequest.clientOrderId, executionResult.providerOrderId);
    this.setState({ ...this.state, runtimeStatus: "RECONCILING", currentStage: "RECONCILING" });
    let positionAfter: PositionSnapshot | undefined;
    let readbackFailure = false;
    try {
      const afterBundle = (await client.collectEvidence([decision.symbol]))[0];
      if (afterBundle) {
        record.accountAfter = afterBundle.account;
        positionAfter = findPosition(afterBundle.account.positions, decision.symbol, decision.positionSide);
      }
      else readbackFailure = true;
    } catch {
      readbackFailure = true;
    }
    let reconciliationResult = reconcileExecution(executionRequest, executionResult, record.positionBefore, positionAfter);
    if (readbackFailure) reconciliationResult = { ...reconciliationResult, status: "UNKNOWN", codes: [...reconciliationResult.codes, "POSITION_READBACK_UNAVAILABLE"] };
    if (executionRequest.tradeSide === "open" && executionResult.status === "filled" && !positionAfter) reconciliationResult = { ...reconciliationResult, status: "MISMATCH", codes: [...reconciliationResult.codes, "POSITION_READBACK_MISSING"] };
    record.executionRequest = executionRequest;
    record.executionResult = executionResult;
    record.reconciliationResult = reconciliationResult;
    if (positionAfter) record.positionAfter = positionAfter;
    this.recordEvent(reconciliationResult.status === "MATCHED" ? "EXECUTION_VERIFIED" : "EXECUTION_UNRESOLVED", cycleId, {
      decisionType,
      symbol: decision.symbol,
      codes: reconciliationResult.codes.join(","),
      ...(executionResult.providerCode ? { providerCode: executionResult.providerCode } : {}),
      ...(executionResult.providerMessage ? { providerMessage: executionResult.providerMessage } : {}),
      ...(executionResult.providerReadbackCode ? { providerReadbackCode: executionResult.providerReadbackCode } : {}),
      ...(executionResult.providerReadbackMessage ? { providerReadbackMessage: executionResult.providerReadbackMessage } : {}),
    });
    return record;
  }

  private async persistDecisionOutcome(
    config: RuntimeConfig,
    record: DecisionExecutionRecord,
    bundle: EvidenceBundle,
    experiences: TradeExperience[],
    lessons: Lesson[],
    cycleId: string,
    startedAt: string,
    journal: TradingJournal,
    allowFailureReflection: boolean,
  ): Promise<{ reflection?: ReflectionResult; lesson?: Lesson }> {
    const { decision, executionResult, reconciliationResult } = record;
    const verified = Boolean(executionResult && reconciliationResult?.status === "MATCHED" && executionResult.status === "filled");
    const managementDecision = record.parentDecision ?? decision;
    const isEntryDecision = decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT";
    const isManagementDecision = managementDecision.action === "HOLD" || managementDecision.action === "INCREASE" || managementDecision.action === "REDUCE" || managementDecision.action === "CLOSE" || managementDecision.action === "REVERSE";
    if (isManagementDecision && (!isEntryDecision || verified)) this.updatePositionContext(record);
    const currentExperience = experiences.find((experience) => experience.outcomeStatus === "OPEN" && experience.symbol === decision.symbol && experience.positionSide === decision.positionSide);
    this.updatePerformanceReadModel(record, bundle, verified, currentExperience);
    const filledPositionUnverified = isEntryDecision && executionResult?.status === "filled" && isReadbackOnlyExecutionMismatch(record);
    if (!currentExperience && filledPositionUnverified && executionResult) {
      const unresolved = reflect({ decision, outcome: "EXECUTION_UNRESOLVED", failureCode: reconciliationResult?.codes.join(",") || "POSITION_READBACK_UNAVAILABLE", symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", experienceStatus: "EXECUTION_UNRESOLVED", entryPrice: executionResult.averageFillPrice ?? bundle.market.lastPrice, exitPrice: executionResult.averageFillPrice ?? bundle.market.lastPrice, evidenceAtEntry: bundle.evidence.map((evidence) => evidence.type), evidenceAtExit: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: decision.lessonsUsed, marginAllocated: executionResult.marginAllocated, positionNotional: executionResult.positionNotional });
      saveExperience(this, unresolved.experience, startedAt);
      journal.experienceId = unresolved.experience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), unresolved.experience.experienceId];
      this.recordEvent("EXECUTION_UNRESOLVED", cycleId, { symbol: decision.symbol, action: decision.action, codes: reconciliationResult?.codes.join(",") || "POSITION_READBACK_UNAVAILABLE" });
      return {};
    }
    if (!currentExperience && allowFailureReflection && (record.riskGateResult.status === "BLOCK" || (executionResult && !verified))) {
      const failure = record.riskGateResult.codes.length ? record.riskGateResult.codes.join(",") : "EXECUTION_FAILURE";
      const failureResult = reflect({ decision, outcome: record.riskGateResult.status === "BLOCK" ? "RISK_BLOCKED" : "EXECUTION_FAILURE", failureCode: failure, symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", experienceStatus: record.riskGateResult.status === "BLOCK" ? "BLOCKED" : "EXECUTION_FAILURE", entryPrice: bundle.market.lastPrice, exitPrice: bundle.market.lastPrice, evidenceAtEntry: bundle.evidence.map((evidence) => evidence.type), evidenceAtExit: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: decision.lessonsUsed, marginAllocated: record.executionRequest?.marginAllocated ?? "0", positionNotional: record.executionRequest?.positionNotional ?? "0" });
      saveExperience(this, failureResult.experience, startedAt);
      saveLesson(this, failureResult.lesson);
      journal.experienceId = failureResult.experience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), failureResult.experience.experienceId];
      journal.reflection = failureResult.reflection;
      journal.createdLessons = [...journal.createdLessons, failureResult.lesson.lessonId];
      this.recordEvent("REFLECTION_COMPLETED", cycleId, { symbol: decision.symbol, action: decision.action });
      return {};
    }
    if (decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT") {
      if (!verified || !executionResult) return {};
      const openingExperience = reflect({ decision, outcome: "OPEN", failureCode: "", symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", experienceStatus: "OPEN", entryPrice: executionResult.averageFillPrice ?? bundle.market.lastPrice, evidenceAtEntry: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: decision.lessonsUsed, marginAllocated: executionResult.marginAllocated, positionNotional: executionResult.positionNotional, realizedPnlVerified: false });
      experiences.unshift(openingExperience.experience);
      saveExperience(this, openingExperience.experience, startedAt);
      journal.experienceId = openingExperience.experience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), openingExperience.experience.experienceId];
      this.updatePositionContext(record, openingExperience.experience);
      return {};
    }
    if (decision.action === "INCREASE" && verified && currentExperience && executionResult) {
      const index = experiences.indexOf(currentExperience);
      const addedMargin = executionResult.marginAllocated;
      const updatedExperience = {
        ...currentExperience,
        marginAllocated: record.positionAfter?.marginAllocated ?? (isDecimal(currentExperience.marginAllocated) && isDecimal(addedMargin) ? addDecimal(currentExperience.marginAllocated, addedMargin) : currentExperience.marginAllocated),
        positionNotional: record.positionAfter?.notional ?? (isDecimal(currentExperience.positionNotional) && isDecimal(executionResult.positionNotional) ? addDecimal(currentExperience.positionNotional, executionResult.positionNotional) : currentExperience.positionNotional),
        selectedLeverage: executionResult.leverage,
        evidenceAtExit: bundle.evidence.map((evidence) => evidence.type),
        lastAction: "INCREASE" as const,
      };
      if (index >= 0) experiences[index] = updatedExperience;
      saveExperience(this, updatedExperience, startedAt);
      journal.experienceId = updatedExperience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), updatedExperience.experienceId];
      return {};
    }
    if (!currentExperience || !executionResult) return {};
    const realizedPnl = isDecimal(executionResult.realizedPnl) ? executionResult.realizedPnl : undefined;
    const historyPnlIsCumulative = executionResult.realizedPnlSource === "POSITION_HISTORY_NET_PROFIT" || executionResult.realizedPnlSource === "POSITION_HISTORY_PNL";
    const cumulativePnl = realizedPnl && historyPnlIsCumulative ? realizedPnl : realizedPnl && isDecimal(currentExperience.realizedPnl) ? addDecimal(currentExperience.realizedPnl, realizedPnl) : currentExperience.realizedPnl;
    const sharedInput = { decision, symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", entryPrice: currentExperience.entryPrice, exitPrice: executionResult.averageFillPrice ?? bundle.market.lastPrice, evidenceAtEntry: currentExperience.evidenceAtEntry, evidenceAtExit: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: [...new Set([...currentExperience.lessonsUsed, ...decision.lessonsUsed])], lessons: lessons.filter((lesson) => currentExperience.lessonsUsed.includes(lesson.lessonId) || decision.lessonsUsed.includes(lesson.lessonId)), marginAllocated: currentExperience.marginAllocated, positionNotional: record.positionAfter?.notional ?? currentExperience.positionNotional, realizedPnl: cumulativePnl, realizedPnlPct: executionResult.realizedPnlPct ?? currentExperience.realizedPnlPct, realizedPnlVerified: Boolean(realizedPnl), ...(executionResult.fees ? { fees: executionResult.fees } : {}), ...(executionResult.funding ? { funding: executionResult.funding } : {}) };
    if (decision.action === "CLOSE" && verified) {
      const closeInput = { ...sharedInput, outcome: realizedPnl ? "CLOSED" : "CLOSED_PNL_UNVERIFIED", failureCode: "", experienceStatus: realizedPnl ? outcomeFromPnl(cumulativePnl) : "CLOSED_UNCLASSIFIED" as const, existingExperience: currentExperience };
      const local = reflect(closeInput);
      const index = experiences.indexOf(currentExperience);
      if (index >= 0) experiences[index] = local.experience;
      saveExperience(this, local.experience, startedAt);
      journal.experienceId = local.experience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), local.experience.experienceId];
      try {
        const result = await reflectWithQwen(config, closeInput);
        saveExperience(this, result.experience, startedAt);
        saveLesson(this, result.lesson);
        recordLessonApplication(this, cycleId, result.reflection.lessonEvaluations.filter((evaluation) => result.experience.lessonsUsed.includes(evaluation.lessonId)), new Date().toISOString());
        this.recordEvent("REFLECTION_COMPLETED", cycleId, { symbol: decision.symbol, action: decision.action });
        this.recordEvent("LESSON_CREATED", cycleId, { source: result.lesson.source, symbol: decision.symbol });
        journal.createdLessons = [...journal.createdLessons, result.lesson.lessonId];
        journal.exitReflections = [...(journal.exitReflections ?? []), result.reflection];
        journal.reflection = result.reflection;
        return { reflection: result.reflection, lesson: result.lesson };
      } catch (error) {
        this.recordEvent("REFLECTION_FAILED", cycleId, { code: error instanceof Error ? error.message.split(":", 1)[0] ?? "REFLECTION_FAILED" : "REFLECTION_FAILED", symbol: decision.symbol });
      }
      return {};
    }
    if (decision.action === "REDUCE" && verified) {
      const partialInput = { ...sharedInput, outcome: "PARTIAL_REDUCE", failureCode: "", experienceStatus: "OPEN" as const, existingExperience: currentExperience };
      const local = reflect(partialInput);
      const index = experiences.indexOf(currentExperience);
      if (index >= 0) experiences[index] = local.experience;
      saveExperience(this, local.experience, startedAt);
      journal.experienceId = local.experience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), local.experience.experienceId];
      if (realizedPnl) {
        try {
          const result = await reflectWithQwen(config, partialInput);
          saveExperience(this, result.experience, startedAt);
          saveLesson(this, result.lesson);
          recordLessonApplication(this, cycleId, result.reflection.lessonEvaluations.filter((evaluation) => result.experience.lessonsUsed.includes(evaluation.lessonId)), new Date().toISOString());
          this.recordEvent("REFLECTION_COMPLETED", cycleId, { symbol: decision.symbol, action: decision.action });
          this.recordEvent("LESSON_CREATED", cycleId, { source: result.lesson.source, symbol: decision.symbol });
          journal.createdLessons = [...journal.createdLessons, result.lesson.lessonId];
          journal.exitReflections = [...(journal.exitReflections ?? []), result.reflection];
          journal.reflection = result.reflection;
          return { reflection: result.reflection, lesson: result.lesson };
        } catch (error) {
          this.recordEvent("REFLECTION_FAILED", cycleId, { ...failureDiagnostic(error), symbol: decision.symbol });
        }
      }
      return {};
    }
    if (allowFailureReflection && (record.riskGateResult.status === "BLOCK" || (executionResult && !verified))) {
      const failure = record.riskGateResult.codes.length ? record.riskGateResult.codes.join(",") : "EXECUTION_FAILURE";
      const failureResult = reflect({ decision, outcome: record.riskGateResult.status === "BLOCK" ? "RISK_BLOCKED" : "EXECUTION_FAILURE", failureCode: failure, symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", experienceStatus: record.riskGateResult.status === "BLOCK" ? "BLOCKED" : "EXECUTION_FAILURE", entryPrice: bundle.market.lastPrice, exitPrice: bundle.market.lastPrice, evidenceAtEntry: bundle.evidence.map((evidence) => evidence.type), evidenceAtExit: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: decision.lessonsUsed, marginAllocated: record.executionRequest?.marginAllocated ?? "0", positionNotional: record.executionRequest?.positionNotional ?? "0" });
      saveExperience(this, failureResult.experience, startedAt);
      saveLesson(this, failureResult.lesson);
      journal.experienceId = failureResult.experience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), failureResult.experience.experienceId];
      journal.reflection = failureResult.reflection;
      journal.createdLessons = [...journal.createdLessons, failureResult.lesson.lessonId];
      this.recordEvent("REFLECTION_COMPLETED", cycleId, { symbol: decision.symbol, action: decision.action });
    }
    return {};
  }

  private recordEvent(type: string, cycleId: string, metadata?: Record<string, string>): void {
    saveEvent(this, { eventId: crypto.randomUUID(), type, cycleId, createdAt: new Date().toISOString(), ...(metadata ? { metadata } : {}) });
  }

  private recordEventBestEffort(type: string, cycleId: string, metadata?: Record<string, string>): void {
    try {
      this.recordEvent(type, cycleId, metadata);
    } catch {
      // Telemetry must not prevent the callback from reaching cycle handling.
    }
  }

  private async ensureTradingSchedule(config: ReturnType<typeof loadConfig>): Promise<void> {
    if (this.state.paused || this.state.emergencyStop) return;
    const intervalMinutes = this.activeScanIntervalMinutes(config.ownerPolicy);
    const result = await this.reconcileScheduler(intervalMinutes, { ensureSchedule: true });
    if (result.repaired) this.recordEventBestEffort("SCHEDULE_RESCHEDULED", "CONTROL", { intervalMinutes: String(intervalMinutes) });
  }

  private recordPositionDiscrepancies(experiences: readonly TradeExperience[], positions: readonly PositionSnapshot[], cycleId: string): string[] {
    const local = experiences.filter((experience) => experience.outcomeStatus === "OPEN");
    const localKeys = new Set(local.map((experience) => `${experience.symbol}:${experience.positionSide}`));
    const providerKeys = new Set(positions.filter((position) => Number(position.quantity) > 0).map((position) => `${position.symbol}:${position.positionSide}`));
    const discrepancies: string[] = [];
    for (const experience of local) {
      const key = `${experience.symbol}:${experience.positionSide}`;
      if (!providerKeys.has(key)) {
        const code = `PROVIDER_POSITION_MISSING:${key}`;
        discrepancies.push(code);
        this.recordEvent("POSITION_STATE_DISCREPANCY", cycleId, { code, symbol: experience.symbol, positionSide: experience.positionSide ?? "UNKNOWN", experienceId: experience.experienceId });
      }
    }
    for (const position of positions.filter((candidate) => Number(candidate.quantity) > 0)) {
      const key = `${position.symbol}:${position.positionSide}`;
      if (!localKeys.has(key)) {
        const code = `LOCAL_EXPERIENCE_MISSING:${key}`;
        discrepancies.push(code);
        this.recordEvent("POSITION_STATE_DISCREPANCY", cycleId, { code, symbol: position.symbol, positionSide: position.positionSide, experienceId: "NONE", classification: "EXTERNAL_UNATTRIBUTED", origin: "PROVIDER_ONLY" });
      }
    }
    return discrepancies;
  }

  private ensureActivePolicy(): OwnerPolicy {
    const persisted = loadActiveOwnerPolicy(this);
    if (persisted) return persisted;
    const initial = loadOwnerPolicy(this.env);
    saveActiveOwnerPolicy(this, initial, new Date().toISOString());
    return initial;
  }

  private persistPolicy(previous: OwnerPolicy, next: OwnerPolicy): void {
    const updatedAt = new Date().toISOString();
    saveActiveOwnerPolicy(this, next, updatedAt);
    const changedFields = Object.keys(next).filter((key) => JSON.stringify(previous[key as keyof OwnerPolicy]) !== JSON.stringify(next[key as keyof OwnerPolicy]));
    this.recordEvent("POLICY_UPDATED", "CONTROL", { changedFields: changedFields.join(","), previous: JSON.stringify(previous), next: JSON.stringify(next) });
  }

  private async applyOwnerPolicy(value: Record<string, unknown>): Promise<DashboardSnapshot> {
    const previous = this.ensureActivePolicy();
    const next = updateOwnerPolicy(previous, value);
    this.persistPolicy(previous, next);
    const intervalMinutes = this.activeScanIntervalMinutes(next);
    this.setState({ ...this.state, emergencyStop: next.emergencyStop, nextScanAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(), lastPolicyUpdateAt: new Date().toISOString() });
    if (previous.scanIntervalMinutes !== next.scanIntervalMinutes && !this.state.paused && !next.emergencyStop) await this.reconcileScheduler(intervalMinutes, { ensureSchedule: true });
    return this.getDashboardSnapshot();
  }
}

function deterministicEntryIdentity(experience: TradeExperience, context: PositionContext): { entryDecisionId: string; clientOid: string } | undefined {
  const reasoning = context.entryReasoning;
  const expectedAction = experience.positionSide === "LONG" ? "OPEN_LONG" : experience.positionSide === "SHORT" ? "OPEN_SHORT" : null;
  if (!expectedAction || context.experienceId !== experience.experienceId || context.entryDecisionId !== experience.entryDecisionId
    || reasoning?.experienceId !== experience.experienceId || reasoning.decisionId !== experience.entryDecisionId
    || reasoning.action !== expectedAction || !reasoning.cycleId) return undefined;
  return { entryDecisionId: experience.entryDecisionId, clientOid: buildExecutionClientOrderId(reasoning.cycleId, experience.entryDecisionId) };
}

function providerLifecycleRepairEventId(experienceId: string, providerPositionHistoryId: string): string {
  return `provider-lifecycle-repair:${experienceId}:${providerPositionHistoryId}`;
}

function requiredProviderDecimal(value: string | null, field: string): string {
  if (!isDecimal(value ?? undefined)) throw new Error(`PROVIDER_FINANCIAL_EVIDENCE_MISSING:${field}`);
  return value as string;
}

function providerClosedExperience(experience: TradeExperience, history: ProviderLifecycleHistory, closedQuantity: string): TradeExperience {
  const entryPrice = requiredProviderDecimal(history.avgEntryPrice, "avgEntryPrice");
  const exitPrice = requiredProviderDecimal(history.avgExitPrice, "avgExitPrice");
  const cumRealisedPnl = requiredProviderDecimal(history.cumRealisedPnl, "cumRealisedPnl");
  const netProfit = requiredProviderDecimal(history.netProfit, "netProfit");
  const openFeeTotal = requiredProviderDecimal(history.openFeeTotal, "openFeeTotal");
  const closeFeeTotal = requiredProviderDecimal(history.closeFeeTotal, "closeFeeTotal");
  const totalFunding = requiredProviderDecimal(history.totalFunding, "totalFunding");
  const cashDividend = requiredProviderDecimal(history.cashDividend, "cashDividend");
  const providerPositionHistoryId = history.providerPositionHistoryId;
  if (!providerPositionHistoryId) throw new Error("PROVIDER_POSITION_HISTORY_ID_MISSING");
  const outcomeStatus = compareDecimal(netProfit, "0") > 0 ? "PROFITABLE" : compareDecimal(netProfit, "0") < 0 ? "LOSING" : "BREAK_EVEN";
  return {
    ...experience,
    entryPrice,
    entryTime: history.openingTime,
    exitPrice,
    exitTime: history.closingTime,
    realizedPnl: netProfit,
    outcomeStatus,
    realizedPnlVerified: true,
    financialSource: "PROVIDER_LEDGER",
    origin: "DARWIN",
    providerPositionHistoryId,
    closedQuantity,
    cumRealisedPnl,
    netProfit,
    openFeeTotal,
    closeFeeTotal,
    totalFunding,
    cashDividend,
    ...(experience.financialSource === "PROVIDER_LEDGER" ? {} : { legacyLocalRealizedPnl: experience.realizedPnl }),
  };
}

function calculateDrawdownPct(baseline: string, current: string): string {
  const base = Number(baseline);
  const equity = Number(current);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(equity)) return "0";
  return (((equity - base) / base) * 100).toFixed(2);
}

function isControlBody(value: unknown): value is { action: "START" | "PAUSE" | "RESUME" | "EMERGENCY_STOP" } | { action: "RECONCILE_LATE_EXECUTION"; cycleId: string; decisionId: string } | { action: "REPAIR_PROVIDER_CLOSED_LIFECYCLE"; experienceId: string; providerPositionHistoryId: string; dryRun?: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as { action?: unknown; cycleId?: unknown; decisionId?: unknown; experienceId?: unknown; providerPositionHistoryId?: unknown; dryRun?: unknown };
  if (body.action === "REPAIR_PROVIDER_CLOSED_LIFECYCLE") return typeof body.experienceId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(body.experienceId) && typeof body.providerPositionHistoryId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(body.providerPositionHistoryId) && (body.dryRun === undefined || typeof body.dryRun === "boolean");
  if (body.action === "RECONCILE_LATE_EXECUTION") return typeof body.cycleId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(body.cycleId) && typeof body.decisionId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(body.decisionId);
  return body.action === "START" || body.action === "PAUSE" || body.action === "RESUME" || body.action === "EMERGENCY_STOP";
}

function isPolicyBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findPosition(positions: readonly PositionSnapshot[], symbol: string, side: "LONG" | "SHORT" | null): PositionSnapshot | undefined {
  return side ? positions.find((position) => position.symbol === symbol && position.positionSide === side) : undefined;
}

function outcomeFromPnl(realizedPnl: string): "PROFITABLE" | "LOSING" | "BREAK_EVEN" {
  const value = Number(realizedPnl);
  if (value > 0) return "PROFITABLE";
  if (value < 0) return "LOSING";
  return "BREAK_EVEN";
}
