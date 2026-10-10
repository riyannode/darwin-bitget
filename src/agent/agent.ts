import { Agent } from "agents";
import { ZodError } from "zod";
import type { ActivityEvent, BacktestReplay, CycleDecisionPlan, CycleDiscovery, DashboardSnapshot, Decision, DecisionExecutionRecord, Env, EvidenceBundle, LatestValidCyclePlan, Lesson, NormalizedCycleDecisions, OwnerPolicy, PositionContext, PositionManagementState, PositionSnapshot, PositionSide, ProviderExecutionFact, ReflectionResult, ResearchCycleSummary, ResearchEvidence, ResearchPlan, RuntimeConfig, TradeExperience, TradeLifecycleStatus, TradingJournal } from "../types.js";
import { loadConfig } from "../config.js";
import { BitgetClient, BitgetReadError, BOUNDED_SUBMISSION_CONFIRMATION_ATTEMPTS, type MarketEvidenceFailure } from "../bitget/client.js";
import { createProviderOriginReadSummary, emitProviderOriginReadSummary, syncProviderLedger, PROVIDER_FINANCIAL_CATEGORIES, PROVIDER_TRADE_LIFECYCLE_CATEGORY } from "../bitget/provider-sync.js";
import { MANDATE_VERSION, PROMPT_VERSIONS, TRADING_MANDATE } from "./mandate.js";
import { assertOpenPositionCountWithinPlanLimit, buildEvidenceSymbols, calculateActionCapacity, countOpenPositionLifecycles, decide, filterNewEntryMarketCandidates, rankMarketCandidates, selectDeterministicEntryCandidates } from "./decision.js";
import { runTimedCyclePhase } from "./cycle-phase-timing.js";
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
  loadBoundedPositionManagementHistory,
  loadAllEvents,
  loadEventById,
  loadAllExperiences,
  loadExperiencesForDecisionIds,
  loadAllStoredCycles,
  loadPaperLogArchivePage,
  capturePaperLogCollectionExportHighWaterRowIds,
  loadPaperLogCollectionExportMutationRevision,
  loadPaperLogCollectionExportPage,
  PAPER_LOG_COLLECTION_EXPORT_PAGE_LIMIT,
  PAPER_LOG_COLLECTION_EXPORT_PAGE_MAX_BYTES,
  type PaperLogCollectionExportHighWaterRowIds,
  loadPaperLogArchiveSnapshot,
  computePaperLogArchiveContentSha256,
  computeExecutionQuarantineContentSha256,
  loadPaperLogCollectionEpoch,
  loadPaperLogCollectionExportSize,
  savePaperLogCollectionEpoch,
  type PaperLogArchiveSnapshot,
  type PaperLogArchiveTable,
  type PaperLogCollectionEpoch,
  loadRecentStoredCycles,
  loadRecentJournals,
  loadJournalBackfillPage,
  loadExecutionQuarantineBackfillState,
  saveExecutionQuarantineBackfillState,
  loadRecentEvents,
  loadRecentLessons,
  loadOpenExperiences,
  loadJournalsForDecisionIds,
  loadJournalsForDecisionIdsDetailed,
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
  loadExecutionQuarantines,
  loadExecutionQuarantineResolution,
  loadExecutionQuarantineRecoveryAuditEvents,
  loadLegacyExecutionQuarantineArchive,
  saveLegacyExecutionQuarantineBaseline,
  appendLegacyExecutionQuarantineArchive,
  canonicalEvidenceSha256,
  isLegacyExecutionQuarantineBaselined,
  loadExperiences,
  loadExperienceById,
  loadJournalsForExperienceIds,
  loadActiveOwnerPolicy,
  clampHistoryLimit,
  recordIdempotency,
  recordProviderOrderReference,
  recordLessonApplication,
  recordLessonRetrieval,
  saveBacktest,
  saveCycle,
  saveDailyDrawdownState,
  saveExecutionQuarantine,
  clearExecutionQuarantine,
  recordExecutionQuarantineResolution,
  saveActiveOwnerPolicy,
  hasEvent,
  saveEvent,
  saveExperience,
  saveJournal,
  saveLesson,
  persistProviderLifecycleRepair,
} from "../storage/store.js";
import { buildPaperLogExport, parsePaperLogPeriod, paperLogCollectionPageToCsv, paperLogToCsv } from "../storage/paper-log.js";
import { cyclePlanDecisions, cycleReadModel, normalizeCycleDecisions, blockedRiskGateResult } from "../storage/journal-normalizer.js";
import { evaluateRiskGate } from "../trading/risk-gate.js";
import { evaluateDrawdown } from "../trading/drawdown.js";
import { loadOwnerPolicy, updateOwnerPolicy } from "../trading/policy.js";
import { buildExecutionClientOrderId, buildExecutionRequest, executePaperOrder } from "../trading/execution.js";
import { executeCyclePlan } from "../trading/execution-planner.js";
import { reconcileExecution, isDefinitivelyRejectedExecution } from "../trading/reconcile.js";
import { readBoundedProviderHistory } from "../bitget/provider-history-read.js";
import { assessExecutionQuarantineHistory, assessExecutionQuarantineRecoveryReadiness, isCompleteBoundedProviderFillHistory, isExactQuarantineQuantityTransition } from "../trading/execution-quarantine-evidence.js";
import { assessLegacyQuarantineRebaseline, legacyQuarantineIdentityKey, legacyRebaselineManagedSymbols, selectOwnerApprovedLegacyQuarantines, type LegacyQuarantineIdentity } from "../trading/legacy-quarantine-rebaseline.js";
import { addDecimal, compareDecimal, isDecimal, isPositiveDecimal, subtractDecimal } from "../trading/decimal.js";
import { buildPerformanceAccounting, classifiedWinRate, emptyPerformance, isPerformanceAggregate, migratePerformanceEquityObservations, PERFORMANCE_READ_MODEL_VERSION, POSITION_CONTEXT_READ_MODEL_VERSION, updateEquity, verifiedLifecycleFacts, type PerformanceAggregate, type PerformanceObservation } from "../trading/performance.js";
import { bootstrapPositionContexts, decisionReasoning, entryReasoning, upsertPositionContext } from "./position-context.js";
import {
  conflictsProviderIdentity,
  darwinLifecycleExperienceId,
  darwinLifecycleRepairEventId,
  isDarwinOwnedExperience,
  managementOutcomeStatus,
  providerEntryTime,
  providerFact,
  providerManagementExperienceId,
  remainingOpenState,
  repairedDarwinOpenExperience,
  resolveLifecycleExperience,
  REPAIR_REASON,
  UNAVAILABLE_ATTRIBUTE,
  type ProviderLiveIdentity,
} from "./provider-live-lifecycle.js";
import { aggregateProviderFillEvidence, isReadbackOnlyExecutionMismatch, parseProviderFillEvidence, parseProviderFillEvidenceRows, parseProviderOrderEvidence, parseProviderOrderReadback, reconcileLateExecution } from "../trading/late-reconciliation.js";
import { EvaClient } from "../eva/client.js";
import { EVA_AGENT_NAME, EVA_CAPABILITIES, EVA_EXECUTION_PROVIDERS, EVA_PROTOCOL_VERSION } from "../eva/types.js";
import { availableResearchCapabilities } from "../research/capabilities.js";
import { ResearchExecutor, type ResearchExecutionTelemetryCallback } from "../research/executor.js";
import { ResearchRouter, validateResearchPlan, type ResearchRouterInput } from "../research/router.js";
import { buildExecutionCapacityHints } from "../trading/execution-capacity.js";
import { buildPositionManagementState, positionContextMatchesLifecycle, positionHistoryReconstructionRequired, positionHistoryRequests, reconstructMaximumFavorableReturnPct, resolvePositionManagementLifecycles } from "../trading/position-management.js";
import { loadExecutionQuarantineDiagnostics } from "../storage/execution-quarantine-diagnostics.js";
import { normalizeProviderFill, normalizeProviderOrder, normalizeProviderPositionHistory, providerPage, type ProviderOrigin } from "../bitget/provider-ledger.js";
import { resolveProviderOrigin, providerLedgerDiagnostics, providerLedgerDiagnosticsBatch, loadProviderLifecycleEvidence, loadProviderLifecycleEvidenceBatch, loadProviderPositionHistories, loadRecentProviderPositionHistories, loadProviderPositionHistoryDecisionIds, loadProviderLiveOpeningOrderIdentities, loadProviderExitExecutionFacts, providerLivePositionLifecycleKey, loadProviderSyncStates, loadProviderDataRevisions, ProviderLifecycleIdentityLookupError, type ProviderLifecycleEvidenceRequest } from "../storage/provider-ledger.js";
import { calculateNetPnlSinceBaseline, isFinancialRecordCoverageComplete } from "../trading/external-flow.js";
import { resolveExternalFlowReadModel } from "../trading/external-flow-read-model.js";
import { classifyProviderLifecycle, reconcileProviderLifecycleFinancials, reconstructProviderLifecycleTransitions, summarizeProviderLifecycleFillQuantities, type ProviderLifecycleClassification, type ProviderLifecycleHistory, type ProviderLifecycleEvidence, type ProviderLifecycleFill, type ProviderLifecycleCandidateOrder, type ProviderLifecycleCandidateFill } from "../trading/provider-lifecycle-reconciliation.js";
import { type ProviderPerformanceLifecycle, type ProviderPerformanceTotals } from "../trading/provider-performance.js";
import { resolveProviderLifecycleSide } from "../trading/provider-lifecycle-side.js";
import { ProviderPerformanceMaterializationError, loadProviderPerformanceMaterializationState, providerPerformanceMigrationProgress, resolveProviderPerformanceMaterializedTotals, runProviderPerformanceMigrationBatch, type ProviderPerformanceLifecycleRow, type ProviderPerformanceRevisions } from "../trading/provider-performance-materializer.js";
import { boundedDiagnosticText, safeDiagnosticMessage } from "../shared/failure-diagnostics.js";

type DarwinLifecycleRepairPreparation =
  | { status: "READY"; experience: TradeExperience; context: PositionContext; entryThesis: string; experienceCreated: boolean; contextChanged: boolean; eventId: string }
  | { status: "BLOCKED"; eventType: "DARWIN_LIFECYCLE_REPAIR_INCOMPLETE" | "DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT"; reason: string; existingContext: PositionContext | null; experienceId: string };

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
/**
 * Bounded local state read for the legacy rebaseline assessment. The rebaseline classifies no
 * order, so it needs only the current open lifecycles, never a full history scan.
 */
const MAX_LEGACY_REBASELINE_EXPERIENCES = 100;
const USER_STORAGE_VERSION = 6;
const LATEST_VALID_PLAN_MIGRATION_VERSION = 5;
const SNAPSHOT_EVENT_LIMIT = 25;
const MAX_PAPER_LOG_EXPORT_ROWS = 500;
const MAX_PAPER_LOG_EXPORT_PAYLOAD_BYTES = 2 * 1024 * 1024;
const initializedStorageExecutors = new WeakSet<object>();

type PaperLogCollectionPageCursor = {
  version: 1;
  epochId: string;
  highWaterRowIds: PaperLogCollectionExportHighWaterRowIds;
  revision: number;
  period: { start: string; end: string | null };
  table: PaperLogArchiveTable | null;
  afterRowId: number;
};

const PAPER_LOG_ARCHIVE_TABLES = ["journals", "cycles", "experiences", "events"] as const;

function encodePaperLogCollectionPageCursor(cursor: PaperLogCollectionPageCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

function decodePaperLogCollectionPageCursor(value: string, epoch: PaperLogCollectionEpoch): PaperLogCollectionPageCursor | null {
  if (!value || value.length > 4096) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const cursor = parsed as Partial<PaperLogCollectionPageCursor>;
    const highWater = cursor.highWaterRowIds;
    const isCanonicalTimestamp = (candidate: unknown): candidate is string => typeof candidate === "string"
      && Number.isFinite(Date.parse(candidate)) && new Date(candidate).toISOString() === candidate;
    if (cursor.version !== 1 || cursor.epochId !== epoch.epochId || !Number.isSafeInteger(cursor.afterRowId) || Number(cursor.afterRowId) < 0
      || !Number.isSafeInteger(cursor.revision) || Number(cursor.revision) < 0
      || !cursor.period || !isCanonicalTimestamp(cursor.period.start)
      || (cursor.period.end !== null && !isCanonicalTimestamp(cursor.period.end))
      || (cursor.period.end !== null && cursor.period.end < cursor.period.start)
      || (cursor.table !== null && !PAPER_LOG_ARCHIVE_TABLES.includes(cursor.table as PaperLogArchiveTable))
      || !highWater || !PAPER_LOG_ARCHIVE_TABLES.every((table) => Number.isSafeInteger(highWater[table]) && highWater[table] >= 0)) return null;
    return cursor as PaperLogCollectionPageCursor;
  } catch {
    return null;
  }
}

function ensureStorageInitialized(executor: SqlExecutor): void {
  if (initializedStorageExecutors.has(executor)) return;
  ensureStorage(executor);
  initializedStorageExecutors.add(executor);
}

function readProviderPerformanceRevisions(executor: SqlExecutor): ProviderPerformanceRevisions {
  const revisions = loadProviderDataRevisions(executor, [PROVIDER_TRADE_LIFECYCLE_CATEGORY]).get(PROVIDER_TRADE_LIFECYCLE_CATEGORY);
  if (!revisions) throw new Error("PROVIDER_DATA_REVISION_UNAVAILABLE");
  return { lifecycleRevision: revisions.lifecycleRevision, identityRevision: revisions.identityRevision };
}

function resolveProviderPerformanceRows(
  executor: SqlExecutor,
  rows: readonly ProviderPerformanceLifecycleRow[],
  path: string,
): ReadonlyMap<string, ProviderPerformanceLifecycle | null> {
  if (rows.length === 0) return new Map();
  const histories = rows.filter((row) => row.category === PROVIDER_TRADE_LIFECYCLE_CATEGORY).map((row) => row.history);
  let decisionIds: Map<string, string>;
  try {
    decisionIds = loadProviderPositionHistoryDecisionIds(executor, PROVIDER_TRADE_LIFECYCLE_CATEGORY, histories, path);
  } catch (error) {
    if (error instanceof ProviderLifecycleIdentityLookupError) throw new ProviderPerformanceMaterializationError(error.code);
    throw error;
  }
  const resolved = resolveProviderTradeFacts(executor, [], PROVIDER_TRADE_LIFECYCLE_CATEGORY, [], {
    histories,
    historyDecisionIds: decisionIds,
    openPositionIdentities: new Map<string, { providerOrderId: string; decisionId: string }>(),
    queryPath: path,
  });
  const lifecycles = new Map<string, ProviderPerformanceLifecycle>();
  for (const lifecycle of resolved.lifecycles) {
    const previous = lifecycles.get(lifecycle.lifecycleId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(lifecycle)) throw new ProviderPerformanceMaterializationError("PROVIDER_PERFORMANCE_DUPLICATE_LIFECYCLE_CONTRADICTION");
    lifecycles.set(lifecycle.lifecycleId, lifecycle);
  }
  return new Map(rows.map((row) => [row.historyKey, lifecycles.get(row.history.providerPositionHistoryId ?? "") ?? null]));
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
  const canonicalCode = /^[A-Z][A-Z0-9_]{1,79}$/.test(candidateCode);
  const code = canonicalCode ? candidateCode : "RUNTIME_ERROR";
  const detail = canonicalCode && normalizedMessage.includes(":")
    ? normalizedMessage.slice(normalizedMessage.indexOf(":") + 1).trim()
    : normalizedMessage;
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
  queryPath?: string;
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
  const historyEvidence = loadProviderLifecycleEvidenceBatch(executor, category, historyEvidenceRequests, options.queryPath);
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
  const liveEvidence = loadProviderLifecycleEvidenceBatch(executor, category, liveEvidenceRequests, options.queryPath);
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
  blockedReasonEvidenceComplete = true,
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
    // Surface why a proposal was rejected, read only from the persisted gate evaluation. No
    // unique authoritative attribution means no reason field at all; never a guess.
    const blockedGate = financialStatus === "BLOCKED" ? blockedRiskGateResult(experience, journals, blockedReasonEvidenceComplete) : undefined;
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
      ...(blockedGate ? { blockedReasonCodes: [...blockedGate.codes], riskGateCheckedAt: blockedGate.checkedAt } : {}),
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

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readBoundedJsonRequest(request: Request, maxBytes: number): Promise<{ value: unknown } | { error: "INVALID_JSON_REQUEST" | "JSON_REQUEST_TOO_LARGE" }> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > maxBytes)) return { error: "JSON_REQUEST_TOO_LARGE" };
  const reader = request.clone().body?.getReader();
  if (!reader) return { error: "INVALID_JSON_REQUEST" };
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return { error: "JSON_REQUEST_TOO_LARGE" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { error: "INVALID_JSON_REQUEST" };
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { error: "INVALID_JSON_REQUEST" };
  }
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

function recoveredQuarantineAuditIsConsistent(
  record: DecisionExecutionRecord,
  identity: { symbol: string; cycleId: string; decisionId: string; clientOrderId: string },
  providerOrderId: string,
  context: PositionContext | null | undefined,
  experience: TradeExperience | undefined,
  audit: ReturnType<typeof loadExecutionQuarantineRecoveryAuditEvents>,
  repairEvent?: ReturnType<typeof loadEventById>,
): { evidenceHash: string; providerPositionHistoryId?: string } | null {
  if (!audit.complete || !context || !experience || experience.symbol !== identity.symbol
    || experience.positionSide !== record.decision.positionSide || context.experienceId !== experience.experienceId) return null;
  const clearEvents = audit.cleared.filter((event) => event.metadata?.providerOrderId === providerOrderId);
  if (audit.cleared.length !== 1 || clearEvents.length !== 1) return null;
  const cleared = clearEvents[0]!;
  const evidenceHash = cleared.metadata?.evidenceHash;
  if (typeof evidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(evidenceHash)
    || cleared.metadata?.symbol !== identity.symbol
    || cleared.metadata?.decisionId !== identity.decisionId || cleared.metadata?.clientOrderId !== identity.clientOrderId) return null;

  if (record.decision.action === "OPEN_LONG" || record.decision.action === "OPEN_SHORT") {
    const reconciled = audit.reconciled.filter((event) => event.metadata?.providerOrderId === providerOrderId);
    if (audit.reconciled.length !== 1 || experience.entryDecisionId !== identity.decisionId || experience.outcomeStatus !== "OPEN"
      || context.entryDecisionId !== identity.decisionId || cleared.eventId !== `q-cleared:${evidenceHash}`
      || cleared.metadata?.code !== "AUTHORITATIVE_LIFECYCLE_RECONCILIATION") return null;
    const recovery = reconciled[0]!;
    if (recovery.eventId !== `q-recovery:${evidenceHash}` || recovery.metadata?.originalCycleId !== identity.cycleId
      || recovery.metadata?.decisionId !== identity.decisionId || recovery.metadata?.clientOrderId !== identity.clientOrderId
      || recovery.metadata?.evidenceHash !== evidenceHash) return null;
    return { evidenceHash };
  }

  if (record.decision.action !== "REDUCE" && record.decision.action !== "CLOSE") return null;
  if (audit.reconciled.length !== 0) return null;
  const historyId = cleared.metadata?.providerPositionHistoryId;
  if (typeof historyId !== "string" || !historyId || cleared.eventId !== `q-close:${evidenceHash}`
    || cleared.metadata?.resolution !== "AUTHORITATIVE_REDUCE_CLOSE_LIFECYCLE"
    || context.entryDecisionId !== experience.entryDecisionId || context.closedProviderPositionHistoryId !== historyId
    || !repairEvent || !repairedLifecycleStateIsConsistent(experience, context, repairEvent, experience.experienceId, historyId)
    || repairEvent.metadata?.quarantineDecisionId !== identity.decisionId
    || repairEvent.metadata?.quarantineClientOrderId !== identity.clientOrderId
    || repairEvent.metadata?.quarantineProviderOrderId !== providerOrderId
    || repairEvent.metadata?.evidenceHash !== evidenceHash) return null;
  return { evidenceHash, providerPositionHistoryId: historyId };
}

export class TraderAgent extends Agent<Env, AgentState> {
  private readonly researchRouter = new ResearchRouter();
  private readonly researchExecutor = new ResearchExecutor();

  public measuredSql<T>(
    path: string,
    queryName: string,
    strings: TemplateStringsArray,
    values: (string | number | boolean | null)[],
    onRowsRead?: (rowsRead: number) => void,
  ): T[] {
    const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
    const cursor = this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(query, ...values);
    const rows = cursor.toArray();
    const rowsRead = cursor.rowsRead;
    try {
      if (onRowsRead) onRowsRead(rowsRead);
      else console.log(JSON.stringify({ event: "DO_SQL_READ", path, queryName, rowsRead }));
    } catch {
      // Read telemetry must not affect the request.
    }
    return rows as unknown as T[];
  }

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
    ensureStorageInitialized(this);
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
    this.seedExecutionQuarantinesFromRecentJournals();
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

  private async paperLogArchive(request: Request, url: URL): Promise<Response> {
    const auth = authorizeOwner(request, this.env);
    if (!auth.authorized) return json({ error: auth.code }, auth.status);
    if (this.env.TRADING_MODE !== "PAPER" || this.env.PAPER_ONLY !== "true") return json({ error: "PAPER_ONLY" }, 503);
    const readRuntimeState = (): { paused: boolean; runtimeStatus: string; cycleStartedAt: string | null } => {
      const rows = this.sql<{ state: string }>`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id' LIMIT 1`;
      const state: unknown = rows[0] ? JSON.parse(rows[0].state) : null;
      if (typeof state !== "object" || state === null || typeof (state as Record<string, unknown>).paused !== "boolean"
        || typeof (state as Record<string, unknown>).runtimeStatus !== "string") throw new Error("AGENT_STATE_UNAVAILABLE");
      return {
        paused: (state as Record<string, unknown>).paused as boolean,
        runtimeStatus: (state as Record<string, unknown>).runtimeStatus as string,
        cycleStartedAt: typeof (state as Record<string, unknown>).cycleStartedAt === "string" ? (state as Record<string, unknown>).cycleStartedAt as string : null,
      };
    };
    let runtimeState: ReturnType<typeof readRuntimeState>;
    try {
      runtimeState = readRuntimeState();
    } catch {
      return json({ error: "PAPER_LOG_ARCHIVE_STATE_UNAVAILABLE" }, 503);
    }
    if (!runtimeState.paused || runtimeState.runtimeStatus !== "PAUSED" || runtimeState.cycleStartedAt) {
      return json({ error: "PAPER_LOG_ARCHIVE_REQUIRES_PAUSED_IDLE_AGENT" }, 409);
    }
    let hasTradingSchedule: boolean;
    try {
      hasTradingSchedule = (await this.listSchedules()).some((entry) => entry.callback === "runScheduledCycle");
    } catch {
      return json({ error: "PAPER_LOG_ARCHIVE_SCHEDULER_READ_FAILED" }, 503);
    }
    if (hasTradingSchedule) return json({ error: "PAPER_LOG_ARCHIVE_REQUIRES_ZERO_TRADING_SCHEDULES" }, 409);
    try {
      runtimeState = readRuntimeState();
    } catch {
      return json({ error: "PAPER_LOG_ARCHIVE_STATE_UNAVAILABLE" }, 503);
    }
    if (!runtimeState.paused || runtimeState.runtimeStatus !== "PAUSED" || runtimeState.cycleStartedAt) return json({ error: "PAPER_LOG_ARCHIVE_REQUIRES_PAUSED_IDLE_AGENT" }, 409);
    const operation = url.searchParams.get("op");
    if (operation === "snapshot") {
      let snapshot: PaperLogArchiveSnapshot;
      let archiveContentSha256: string;
      let quarantineContentSha256: string;
      let lockedState: ReturnType<typeof readRuntimeState>;
      let quarantineIdentities: Array<{ symbol: string; cycleId: string; decisionId: string; clientOrderId: string }>;
      try {
        const captured = await this.ctx.blockConcurrencyWhile(async () => {
          try {
            const state = readRuntimeState();
            if (!state.paused || state.runtimeStatus !== "PAUSED" || state.cycleStartedAt) return { ok: false as const, code: "PAPER_LOG_ARCHIVE_REQUIRES_PAUSED_IDLE_AGENT" };
            if ((await this.listSchedules()).some((entry) => entry.callback === "runScheduledCycle")) return { ok: false as const, code: "PAPER_LOG_ARCHIVE_REQUIRES_ZERO_TRADING_SCHEDULES" };
            const stableState = readRuntimeState();
            if (!stableState.paused || stableState.runtimeStatus !== "PAUSED" || stableState.cycleStartedAt) return { ok: false as const, code: "PAPER_LOG_ARCHIVE_REQUIRES_PAUSED_IDLE_AGENT" };
            const stableSnapshot = loadPaperLogArchiveSnapshot(this, "/api/paper-log/archive");
            const contentSha256 = await computePaperLogArchiveContentSha256(this, stableSnapshot, "/api/paper-log/archive");
            const quarantineContentSha256 = await computeExecutionQuarantineContentSha256(this);
            const quarantineIdentities = loadExecutionQuarantines(this).map(({ symbol, cycleId, decisionId, clientOrderId, reason, createdAt }) => ({ symbol, cycleId, decisionId, clientOrderId, reason, createdAt }))
              .sort((left, right) => `${left.symbol}\u0000${left.cycleId}\u0000${left.decisionId}\u0000${left.clientOrderId}`.localeCompare(`${right.symbol}\u0000${right.cycleId}\u0000${right.decisionId}\u0000${right.clientOrderId}`));
            return { ok: true as const, snapshot: stableSnapshot, contentSha256, quarantineContentSha256, state: stableState, quarantineIdentities };
          } catch {
            return { ok: false as const, code: "PAPER_LOG_ARCHIVE_SNAPSHOT_FAILED" };
          }
        });
        if (!captured.ok) return json({ error: captured.code }, captured.code === "PAPER_LOG_ARCHIVE_SNAPSHOT_FAILED" ? 503 : 409);
        snapshot = captured.snapshot;
        archiveContentSha256 = captured.contentSha256;
        quarantineContentSha256 = captured.quarantineContentSha256;
        lockedState = captured.state;
        quarantineIdentities = captured.quarantineIdentities;
      } catch {
        return json({ error: "PAPER_LOG_ARCHIVE_SNAPSHOT_FAILED" }, 503);
      }
      let collectionEpoch: PaperLogCollectionEpoch | null;
      try {
        collectionEpoch = loadPaperLogCollectionEpoch(this);
      } catch {
        return json({ error: "PAPER_LOG_COLLECTION_EPOCH_INVALID" }, 503);
      }
      return json({
        source: "PRODUCTION_AUTONOMOUS_PAPER",
        observedAt: new Date().toISOString(),
        deployedSha: this.env.GIT_COMMIT_SHA?.trim() || "unknown",
        paused: lockedState.paused,
        tradingScheduleCount: 0,
        quarantineIdentities,
        snapshot: { ...snapshot, contentSha256: archiveContentSha256, quarantineContentSha256 },
        collectionEpoch,
      });
    }
    if (operation !== "page") return json({ error: "INVALID_PAPER_LOG_ARCHIVE_OPERATION" }, 400);
    const tableValue = url.searchParams.get("table");
    if (tableValue !== "journals" && tableValue !== "cycles" && tableValue !== "experiences" && tableValue !== "events") return json({ error: "INVALID_PAPER_LOG_ARCHIVE_TABLE" }, 400);
    const parseInteger = (value: string | null): number | null => value !== null && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
    const afterRowId = parseInteger(url.searchParams.get("afterRowId"));
    const throughRowId = parseInteger(url.searchParams.get("throughRowId"));
    const limit = parseInteger(url.searchParams.get("limit"));
    if (afterRowId === null || throughRowId === null || throughRowId < afterRowId || limit === null || limit < 1 || limit > 50) {
      return json({ error: "INVALID_PAPER_LOG_ARCHIVE_CURSOR" }, 400);
    }
    try {
      return json({
        source: "PRODUCTION_AUTONOMOUS_PAPER",
        table: tableValue satisfies PaperLogArchiveTable,
        quarantineIdentities: loadExecutionQuarantines(this).map(({ symbol, cycleId, decisionId, clientOrderId, reason, createdAt }) => ({ symbol, cycleId, decisionId, clientOrderId, reason, createdAt }))
          .sort((left, right) => `${left.symbol}\u0000${left.cycleId}\u0000${left.decisionId}\u0000${left.clientOrderId}`.localeCompare(`${right.symbol}\u0000${right.cycleId}\u0000${right.decisionId}\u0000${right.clientOrderId}`)),
        page: loadPaperLogArchivePage(this, { table: tableValue, afterRowId, throughRowId, limit }, "/api/paper-log/archive"),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":", 1)[0] ?? "PAPER_LOG_ARCHIVE_PAGE_FAILED" : "PAPER_LOG_ARCHIVE_PAGE_FAILED";
      return json({ error: code }, code === "PAPER_LOG_ARCHIVE_ROW_EXCEEDS_BYTE_LIMIT" ? 413 : 400);
    }
  }

  private async startPaperLogCollectionEpoch(request: Request, body: { action: "START_PAPER_LOG_COLLECTION_EPOCH"; archiveManifestSha256: string; archiveContentSha256: string; quarantineContentSha256: string; archivedCounts: Record<PaperLogArchiveTable, number>; highWaterRowIds: Record<PaperLogArchiveTable, number> }): Promise<Response> {
    const auth = authorizeOwner(request, this.env);
    if (!auth.authorized) return json({ error: auth.code }, auth.status);
    if (this.env.TRADING_MODE !== "PAPER" || this.env.PAPER_ONLY !== "true") return json({ error: "PAPER_ONLY" }, 503);
    const readRuntimeState = (): { paused: boolean; runtimeStatus: string; cycleStartedAt: string | null } => {
      const rows = this.sql<{ state: string }>`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id' LIMIT 1`;
      const state: unknown = rows[0] ? JSON.parse(rows[0].state) : null;
      if (typeof state !== "object" || state === null || typeof (state as Record<string, unknown>).paused !== "boolean"
        || typeof (state as Record<string, unknown>).runtimeStatus !== "string") throw new Error("AGENT_STATE_UNAVAILABLE");
      return {
        paused: (state as Record<string, unknown>).paused as boolean,
        runtimeStatus: (state as Record<string, unknown>).runtimeStatus as string,
        cycleStartedAt: typeof (state as Record<string, unknown>).cycleStartedAt === "string" ? (state as Record<string, unknown>).cycleStartedAt as string : null,
      };
    };
    try {
      const beforeScheduleRead = readRuntimeState();
      if (!beforeScheduleRead.paused || beforeScheduleRead.runtimeStatus !== "PAUSED" || beforeScheduleRead.cycleStartedAt) return json({ error: "PAPER_LOG_COLLECTION_EPOCH_REQUIRES_PAPER_PAUSED_IDLE_AGENT" }, 409);
    } catch {
      return json({ error: "PAPER_LOG_COLLECTION_EPOCH_STATE_UNAVAILABLE" }, 503);
    }
    let hasTradingSchedule: boolean;
    try {
      hasTradingSchedule = (await this.listSchedules()).some((entry) => entry.callback === "runScheduledCycle");
    } catch {
      return json({ error: "PAPER_LOG_COLLECTION_EPOCH_SCHEDULER_READ_FAILED" }, 503);
    }
    if (hasTradingSchedule) return json({ error: "PAPER_LOG_COLLECTION_EPOCH_REQUIRES_ZERO_TRADING_SCHEDULES" }, 409);
    try {
      const afterScheduleRead = readRuntimeState();
      if (!afterScheduleRead.paused || afterScheduleRead.runtimeStatus !== "PAUSED" || afterScheduleRead.cycleStartedAt) return json({ error: "PAPER_LOG_COLLECTION_EPOCH_REQUIRES_PAPER_PAUSED_IDLE_AGENT" }, 409);
    } catch {
      return json({ error: "PAPER_LOG_COLLECTION_EPOCH_STATE_UNAVAILABLE" }, 503);
    }
    let existingEpoch: PaperLogCollectionEpoch | null;
    try {
      existingEpoch = loadPaperLogCollectionEpoch(this);
    } catch {
      return json({ error: "PAPER_LOG_COLLECTION_EPOCH_INVALID" }, 503);
    }
    if (existingEpoch?.archiveManifestSha256 === body.archiveManifestSha256) {
      const proofMatches = existingEpoch.archiveContentSha256 === body.archiveContentSha256 && existingEpoch.quarantineContentSha256 === body.quarantineContentSha256 && (["journals", "cycles", "experiences", "events"] as const).every((table) =>
        existingEpoch.archivedCounts[table] === body.archivedCounts[table] && existingEpoch.highWaterRowIds[table] === body.highWaterRowIds[table]);
      if (!proofMatches) return json({ error: "PAPER_LOG_ARCHIVE_MANIFEST_PROOF_CONFLICT" }, 409);
      return json({ collectionEpoch: existingEpoch, idempotentReplay: true });
    }
    if (existingEpoch) return json({ error: "PAPER_LOG_COLLECTION_EPOCH_ALREADY_STARTED" }, 409);
    const startedAt = new Date().toISOString();
    try {
      return await this.ctx.blockConcurrencyWhile(async () => {
        try {
          const lockedState = readRuntimeState();
          if (!lockedState.paused || lockedState.runtimeStatus !== "PAUSED" || lockedState.cycleStartedAt) return json({ error: "PAPER_LOG_COLLECTION_EPOCH_REQUIRES_PAPER_PAUSED_IDLE_AGENT" }, 409);
          if ((await this.listSchedules()).some((entry) => entry.callback === "runScheduledCycle")) return json({ error: "PAPER_LOG_COLLECTION_EPOCH_REQUIRES_ZERO_TRADING_SCHEDULES" }, 409);
          const finalState = readRuntimeState();
          if (!finalState.paused || finalState.runtimeStatus !== "PAUSED" || finalState.cycleStartedAt) return json({ error: "PAPER_LOG_COLLECTION_EPOCH_REQUIRES_PAPER_PAUSED_IDLE_AGENT" }, 409);
          const activeEpoch = loadPaperLogCollectionEpoch(this);
          if (activeEpoch) {
            const sameProof = activeEpoch.archiveManifestSha256 === body.archiveManifestSha256
              && activeEpoch.archiveContentSha256 === body.archiveContentSha256
              && activeEpoch.quarantineContentSha256 === body.quarantineContentSha256
              && (["journals", "cycles", "experiences", "events"] as const).every((table) =>
                activeEpoch.archivedCounts[table] === body.archivedCounts[table] && activeEpoch.highWaterRowIds[table] === body.highWaterRowIds[table]);
            return sameProof ? json({ collectionEpoch: activeEpoch, idempotentReplay: true }) : json({ error: "PAPER_LOG_COLLECTION_EPOCH_ALREADY_STARTED" }, 409);
          }
          const snapshot = loadPaperLogArchiveSnapshot(this, "/api/paper-log/archive/epoch");
          if (Object.values(snapshot.tables).some((boundary) => boundary.invalidPayloadRows > 0)) return json({ error: "PAPER_LOG_ARCHIVE_SOURCE_INVALID" }, 409);
          const currentCounts = Object.fromEntries(Object.entries(snapshot.tables).map(([table, boundary]) => [table, boundary.rowCount])) as Record<PaperLogArchiveTable, number>;
          const currentHighWater = Object.fromEntries(Object.entries(snapshot.tables).map(([table, boundary]) => [table, boundary.highWaterRowId])) as Record<PaperLogArchiveTable, number>;
          const matches = (left: Record<string, number>, right: Record<string, number>): boolean => Object.keys(currentCounts).every((table) => left[table] === right[table]);
          if (!matches(body.archivedCounts, currentCounts) || !matches(body.highWaterRowIds, currentHighWater)) return json({ error: "PAPER_LOG_ARCHIVE_BOUNDARY_CHANGED" }, 409);
          const sourceContentSha256 = await computePaperLogArchiveContentSha256(this, snapshot, "/api/paper-log/archive/epoch");
          if (sourceContentSha256 !== body.archiveContentSha256) return json({ error: "PAPER_LOG_ARCHIVE_CONTENT_CHANGED" }, 409);
          const quarantineContentSha256 = await computeExecutionQuarantineContentSha256(this);
          if (quarantineContentSha256 !== body.quarantineContentSha256) return json({ error: "PAPER_LOG_ARCHIVE_QUARANTINE_STATE_CHANGED" }, 409);
          const epoch: PaperLogCollectionEpoch = {
            schemaVersion: 1,
            epochId: crypto.randomUUID(),
            startedAt,
            archiveManifestSha256: body.archiveManifestSha256,
            archiveContentSha256: sourceContentSha256,
            quarantineContentSha256,
            archivedCounts: currentCounts,
            highWaterRowIds: currentHighWater,
          };
          savePaperLogCollectionEpoch(this, epoch, startedAt);
          return json({ collectionEpoch: epoch, currentPeriod: { cycleCount: 0, journalCount: 0 }, lifetimePerformanceBaselineChanged: false });
        } catch {
          return json({ error: "PAPER_LOG_COLLECTION_EPOCH_STATE_UNAVAILABLE" }, 503);
        }
      });
    } catch {
      return json({ error: "PAPER_LOG_COLLECTION_EPOCH_STATE_UNAVAILABLE" }, 503);
    }
  }

  private async executionQuarantineDiagnostics(request: Request, url: URL): Promise<Response> {
    const auth = authorizeOwner(request, this.env);
    if (!auth.authorized) return json({ error: auth.code }, auth.status);

    const rawSymbols = url.searchParams.get("symbols") ?? "";
    if (rawSymbols.length > 256) return json({ error: "INVALID_SYMBOLS" }, 400);
    let separatorCount = 0;
    for (const character of rawSymbols) {
      if (character === "," && ++separatorCount >= 8) return json({ error: "INVALID_SYMBOLS" }, 400);
    }
    const rawSymbolList = rawSymbols.split(",");
    const symbols = [...new Set(rawSymbolList.map((symbol) => symbol.trim()))];
    if (symbols.length === 0 || symbols.some((symbol) => !/^[A-Z0-9]{2,16}USDT$/.test(symbol))) {
      return json({ error: "INVALID_SYMBOLS" }, 400);
    }

    ensureStorageInitialized(this);
    const config = loadConfig(this.env, loadActiveOwnerPolicy(this) ?? loadOwnerPolicy(this.env));
    let diagnostics;
    try {
      diagnostics = loadExecutionQuarantineDiagnostics(this, symbols, config.bitgetCategory);
    } catch (error) {
      return json({ error: error instanceof Error && error.message === "EXECUTION_QUARANTINE_STATE_INVALID" ? error.message : "EXECUTION_QUARANTINE_DIAGNOSTICS_UNAVAILABLE" }, 503);
    }

    const client = new BitgetClient(config);
    let livePortfolio: Awaited<ReturnType<BitgetClient["getDashboardPortfolio"]>> | null = null;
    let livePortfolioError = "PROVIDER_READ_FAILED";
    if (diagnostics.length > 0) {
      try {
        livePortfolio = await client.getDashboardPortfolio();
      } catch (error) {
        livePortfolioError = error instanceof Error && /^[A-Z0-9_-]{1,80}$/.test(error.message) ? error.message : "PROVIDER_READ_FAILED";
      }
    }
    const decimalEqual = (left: string | undefined, right: string | undefined): boolean => {
      if (!left || !right) return false;
      try { return compareDecimal(left, right) === 0; } catch { return false; }
    };
    const enriched = [];
    for (const diagnostic of diagnostics) {
      const providerOrderId = diagnostic.executionResult?.providerOrderId ?? diagnostic.priorResolution?.providerOrderId;
      const providerPosition = livePortfolio?.positions.find((position) => position.symbol === diagnostic.identity.symbol && (!diagnostic.decision?.positionSide || position.positionSide === diagnostic.decision.positionSide));
      const providerPositionReadback = livePortfolio
        ? { status: "SUCCESS", observedAt: livePortfolio.observedAt, position: providerPosition ? { symbol: providerPosition.symbol, positionSide: providerPosition.positionSide, quantity: providerPosition.quantity, entryPrice: providerPosition.entryPrice, markPrice: providerPosition.markPrice, leverage: providerPosition.leverage } : null }
        : { status: "READ_ERROR", code: livePortfolioError, position: null };
      try {
        const rawOrder = await client.getOrderDetailsRead(providerOrderId || undefined, diagnostic.identity.clientOrderId);
        const order = parseProviderOrderReadback(rawOrder);
        if (!order) {
          enriched.push({ ...diagnostic, providerPositionReadback, providerReadback: { source: "DIRECT_PROVIDER_READBACK", status: "ORDER_NOT_FOUND_OR_INCOMPLETE", order: null, fills: [], matches: null } });
          continue;
        }
        const expectedLifecycleSide = diagnostic.executionResult && diagnostic.decision?.positionSide
          ? resolveProviderLifecycleSide(diagnostic.executionResult.providerSide, diagnostic.decision.positionSide, diagnostic.executionResult.tradeSide)
          : "UNRESOLVED";
        const orderLifecycleSide = resolveProviderLifecycleSide(order.side, order.positionSide, order.tradeSide);
        const orderMatches = {
          clientOrderId: order.clientOid === diagnostic.identity.clientOrderId,
          providerOrderId: providerOrderId ? order.orderId === providerOrderId : Boolean(order.orderId),
          symbol: order.symbol === diagnostic.identity.symbol,
          providerSide: diagnostic.executionResult?.providerSide ? order.side === diagnostic.executionResult.providerSide : null,
          positionSide: diagnostic.decision?.positionSide ? order.positionSide === diagnostic.decision.positionSide : null,
          tradeSide: expectedLifecycleSide === "UNRESOLVED" || expectedLifecycleSide === "CONTRADICTORY"
            ? false
            : orderLifecycleSide === expectedLifecycleSide,
          normalizedLifecycleSide: orderLifecycleSide,
          status: diagnostic.executionResult?.status
            ? diagnostic.executionResult.status === "unknown" ? order.status === "filled" : order.status === diagnostic.executionResult.status.toLowerCase()
            : null,
          executedQuantity: diagnostic.executionResult?.status !== "unknown" && diagnostic.executionResult?.executedQuantity
            ? decimalEqual(order.executedQuantity, diagnostic.executionResult.executedQuantity) : null,
          averageFillPrice: diagnostic.executionResult?.status !== "unknown" && diagnostic.executionResult?.averageFillPrice
            ? decimalEqual(order.averageFillPrice ?? undefined, diagnostic.executionResult.averageFillPrice) : null,
        };
        const orderIdentityMatches = [orderMatches.clientOrderId, orderMatches.providerOrderId, orderMatches.symbol, orderMatches.providerSide, orderMatches.positionSide, orderMatches.tradeSide].every((match) => match === true);
        const orderMatchesExecution = Object.entries(orderMatches)
          .filter(([key, match]) => key !== "normalizedLifecycleSide" && match !== null)
          .every(([, match]) => match === true);
        const rawFills = await client.getFillHistoryRead(order.orderId);
        const fillBatch = parseProviderFillEvidenceRows(rawFills);
        const fills = fillBatch.records;
        let fillQuantityTotal: string | null = null;
        try {
          fillQuantityTotal = fills.reduce((total, fill) => addDecimal(total, fill.quantity), "0");
        } catch {
          fillQuantityTotal = null;
        }
        const fillMatches = fills.map((fill) => {
          const fillLifecycleSide = resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide);
          return {
            fillId: fill.fillId,
            clientOrderId: fill.clientOid === diagnostic.identity.clientOrderId,
            providerOrderId: (!providerOrderId || fill.orderId === providerOrderId) && fill.orderId === order.orderId,
            symbol: fill.symbol === diagnostic.identity.symbol,
            providerSide: diagnostic.executionResult?.providerSide ? fill.side === diagnostic.executionResult.providerSide : null,
            positionSide: diagnostic.decision?.positionSide ? fill.positionSide === diagnostic.decision.positionSide : null,
            tradeSide: expectedLifecycleSide === "UNRESOLVED" || expectedLifecycleSide === "CONTRADICTORY"
              ? false
              : fillLifecycleSide === expectedLifecycleSide,
            normalizedLifecycleSide: fillLifecycleSide,
            matchesQuarantineIdentity: orderIdentityMatches
              && fill.clientOid === diagnostic.identity.clientOrderId
              && (!providerOrderId || fill.orderId === providerOrderId)
              && fill.orderId === order.orderId
              && fill.symbol === diagnostic.identity.symbol
              && Boolean(diagnostic.executionResult?.providerSide && fill.side === diagnostic.executionResult.providerSide)
              && Boolean(diagnostic.decision?.positionSide && fill.positionSide === diagnostic.decision.positionSide)
              && expectedLifecycleSide !== "UNRESOLVED" && expectedLifecycleSide !== "CONTRADICTORY"
              && fillLifecycleSide === expectedLifecycleSide,
            quantity: fill.quantity,
            price: fill.price,
            createdAt: fill.createdAt,
          };
        });
        const allProviderFillRowsParsed = fillBatch.providerRowCount > 0 && fillBatch.invalidProviderRowCount === 0 && fills.length === fillBatch.providerRowCount;
        const allFillsMatchExactIdentity = allProviderFillRowsParsed && fillMatches.every((fill) => fill.matchesQuarantineIdentity);
        const providerOrderEvidence = parseProviderOrderEvidence(rawOrder);
        const providerLifecycleAggregate = providerOrderEvidence && (orderLifecycleSide === "OPEN" || orderLifecycleSide === "CLOSE")
          ? aggregateProviderFillEvidence(fills, providerOrderEvidence, providerOrderEvidence.executedQuantity, providerOrderEvidence.averageFillPrice, orderLifecycleSide)
          : null;
        enriched.push({
          ...diagnostic,
          providerPositionReadback,
          providerReadback: {
            source: "DIRECT_PROVIDER_READBACK",
            status: fillBatch.invalidProviderRowCount > 0 ? "ORDER_AND_FILLS_INCOMPLETE" : fills.length > 0 ? "ORDER_AND_FILLS_FOUND" : "ORDER_FOUND_FILL_NOT_FOUND_OR_UNPARSEABLE",
            order: { orderId: order.orderId, clientOrderId: order.clientOid, symbol: order.symbol, side: order.side, positionSide: order.positionSide, tradeSide: order.tradeSide, quantity: order.quantity, executedQuantity: order.executedQuantity, averageFillPrice: order.averageFillPrice, status: order.status, createdAt: order.createdAt },
            fills: fillMatches,
            matches: {
              order: orderMatches,
              orderMatchesExecution,
              matchingProviderFillRows: fillBatch.providerRowCount,
              invalidMatchingProviderFillRows: fillBatch.invalidProviderRowCount,
              allFillsMatchExactIdentity,
              fillClientOrderIds: fillBatch.providerRowCount > 0 && fillBatch.invalidProviderRowCount === 0 && fills.every((fill) => fill.clientOid === diagnostic.identity.clientOrderId),
              fillOrderIds: !providerOrderId && fillBatch.providerRowCount > 0 && fillBatch.invalidProviderRowCount === 0
                ? fills.every((fill) => fill.orderId === order.orderId)
                : Boolean(providerOrderId) && fillBatch.providerRowCount > 0 && fillBatch.invalidProviderRowCount === 0 && fills.every((fill) => fill.orderId === order.orderId && fill.orderId === providerOrderId),
              fillSymbols: fillBatch.providerRowCount > 0 && fillBatch.invalidProviderRowCount === 0 && fills.every((fill) => fill.symbol === diagnostic.identity.symbol),
              fillSides: fillBatch.providerRowCount > 0 && fillBatch.invalidProviderRowCount === 0 && fills.every((fill) => fill.side === order.side && fill.positionSide === order.positionSide && resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide) === orderLifecycleSide),
              aggregateFillQuantity: allFillsMatchExactIdentity && providerLifecycleAggregate?.valid && fillQuantityTotal !== null ? fillQuantityTotal : null,
              aggregateFillQuantityMatchesExecution: !diagnostic.executionResult?.executedQuantity || diagnostic.executionResult.status === "unknown"
                ? null
                : allFillsMatchExactIdentity && fillQuantityTotal !== null
                  ? decimalEqual(fillQuantityTotal, diagnostic.executionResult.executedQuantity)
                  : false,
              aggregateProviderOrder: providerLifecycleAggregate?.valid ? {
                status: "MATCHED",
                fillCount: providerLifecycleAggregate.fills.length,
                fillIds: providerLifecycleAggregate.fills.map((fill) => fill.fillId),
                executedQuantity: providerLifecycleAggregate.executedQuantity,
                executedValue: providerLifecycleAggregate.executedValue,
                weightedAveragePrice: providerLifecycleAggregate.averageFillPrice,
              } : providerLifecycleAggregate ? { status: "MISMATCH", code: providerLifecycleAggregate.code } : { status: "INCOMPLETE" },
              aggregateFillWeightedPriceMatchesExecution: diagnostic.executionResult?.averageFillPrice
                ? providerLifecycleAggregate?.valid === true && decimalEqual(providerLifecycleAggregate.averageFillPrice, diagnostic.executionResult.averageFillPrice)
                : null,
              orderTradeSideNormalized: orderLifecycleSide,
              expectedTradeSideNormalized: expectedLifecycleSide,
            },
          },
        });
      } catch (error) {
        const providerErrorCode = error instanceof Error && /^[A-Z0-9_-]{1,80}$/.test(error.message) ? error.message : "PROVIDER_READ_FAILED";
        enriched.push({ ...diagnostic, providerPositionReadback, providerReadback: { source: "DIRECT_PROVIDER_READBACK", status: "READ_ERROR", code: providerErrorCode, order: null, fills: [], matches: null } });
      }
    }
    return new Response(JSON.stringify({ source: "PERSISTED_RISK_STATE", observedAt: new Date().toISOString(), requestedSymbols: symbols, diagnostics: enriched }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/paper-log/archive") {
      return noStore(await this.paperLogArchive(request, url));
    }
    if (request.method === "GET" && url.pathname === "/export/paper-log") {
      return noStore(this.exportPaperLog(url, request));
    }
    if (request.method === "POST" && url.pathname === "/paper-log/archive/epoch") {
      const auth = authorizeOwner(request, this.env);
      if (!auth.authorized) return noStore(json({ error: auth.code }, auth.status));
      const parsed = await readBoundedJsonRequest(request, 4096);
      if ("error" in parsed) return noStore(json({ error: parsed.error }, parsed.error === "JSON_REQUEST_TOO_LARGE" ? 413 : 400));
      if (!isControlBody(parsed.value) || parsed.value.action !== "START_PAPER_LOG_COLLECTION_EPOCH") return noStore(json({ error: "INVALID_PAPER_LOG_EPOCH_REQUEST" }, 400));
      return noStore(await this.startPaperLogCollectionEpoch(request, parsed.value));
    }
    if (request.method === "POST" && url.pathname === "/control") {
      const auth = authorizeOwner(request, this.env);
      if (!auth.authorized) return json({ error: auth.code }, auth.status);
      const parsed = await readBoundedJsonRequest(request, 4096);
      if ("error" in parsed) return json({ error: parsed.error }, parsed.error === "JSON_REQUEST_TOO_LARGE" ? 413 : 400);
      if (typeof parsed.value === "object" && parsed.value !== null && "action" in parsed.value && parsed.value.action === "START_PAPER_LOG_COLLECTION_EPOCH") return json({ error: "USE_PAPER_LOG_ARCHIVE_EPOCH_ENDPOINT" }, 409);
    }
    return super.fetch(request);
  }

  public override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/export/paper-log" && request.method === "GET") return noStore(TraderAgent.prototype.exportPaperLog.call(this, url, request));
    if (url.pathname === "/execution-quarantines" && request.method === "GET") return this.executionQuarantineDiagnostics(request, url);
    if (url.pathname === "/snapshot" && request.method === "GET") {
      const config = loadConfig(this.env, this.ensureActivePolicy());
      let livePortfolio: DashboardSnapshot["portfolio"] | undefined;
      try {
        livePortfolio = await new BitgetClient(config).getDashboardPortfolio();
      } catch {
        livePortfolio = undefined;
      }
      try {
        return json(await this.getDashboardSnapshot(livePortfolio, config));
      } catch (error) {
        if (error instanceof ProviderPerformanceMaterializationError) return json({ error: error.code }, 503);
        throw error;
      }
    }
    if (url.pathname === "/position-context" && request.method === "GET") return this.getPositionContext(url);
    if (url.pathname === "/agent-journal" && request.method === "GET") return this.getAgentJournal(url);
    if (url.pathname === "/trade-history" && request.method === "GET") return this.getTradeHistory(url);
    if (url.pathname === "/learning" && request.method === "GET") return this.getLearning(url);
    if (url.pathname === "/provider-ledger" && request.method === "GET") {
      const auth = authorizeOwner(request, this.env);
      if (!auth.authorized) return json({ error: auth.code }, auth.status);
      ensureStorageInitialized(this);
      const config = loadConfig(this.env, this.ensureActivePolicy());
      const categories = [...providerLedgerDiagnosticsBatch(this, PROVIDER_FINANCIAL_CATEGORIES, "/api/provider-ledger").values()];
      const configured = categories.find((entry) => entry.category === config.bitgetCategory) ?? providerLedgerDiagnostics(this, config.bitgetCategory, "/api/provider-ledger");
      return json({ ...configured, categories: categories.map((entry) => ({
        ...entry,
        status: entry.sync?.lastError ? "PARTIAL" : entry.sync?.lastSuccessfulSyncAt ? "SUCCESS" : "NOT_SYNCED",
        rowCount: entry.counts.financialRecords,
        checkpoint: entry.sync?.checkpoints.financialRecords ?? null,
      })) });
    }
    if (url.pathname === "/provider-performance/rebuild" && request.method === "POST") {
      const auth = authorizeOwner(request, this.env);
      if (!auth.authorized) return json({ error: auth.code }, auth.status);
      if (this.env.TRADING_MODE !== "PAPER" || this.env.PAPER_ONLY !== "true" || !this.state.paused || this.state.runtimeStatus !== "PAUSED") {
        return json({ error: "PROVIDER_PERFORMANCE_REBUILD_REQUIRES_PAPER_PAUSED" }, 409);
      }
      ensureStorageInitialized(this);
      const now = new Date().toISOString();
      try {
        const state = runProviderPerformanceMigrationBatch(
          this,
          (closure) => this.ctx.storage.transactionSync(closure),
          PROVIDER_TRADE_LIFECYCLE_CATEGORY,
          now,
          () => readProviderPerformanceRevisions(this),
          (rows, path) => resolveProviderPerformanceRows(this, rows, path),
        );
        return json({ source: "PROVIDER_LEDGER", ...providerPerformanceMigrationProgress(state) });
      } catch (error) {
        if (error instanceof ProviderPerformanceMaterializationError) {
          const state = loadProviderPerformanceMaterializationState(this);
          return json({ error: error.code, ...(state ? providerPerformanceMigrationProgress(state) : {}) }, 409);
        }
        throw error;
      }
    }
    if (url.pathname === "/provider-ledger/backfill" && request.method === "POST") {
      const auth = authorizeOwner(request, this.env);
      if (!auth.authorized) return json({ error: auth.code }, auth.status);
      ensureStorageInitialized(this);
      const config = loadConfig(this.env, this.ensureActivePolicy());
      const storedPerformance = loadPerformanceAggregate<PerformanceAggregate>(this);
      const baselineAt = isPerformanceAggregate(storedPerformance) ? storedPerformance.performanceBaselineAt : null;
      const results = [];
      const originReadSummary = createProviderOriginReadSummary("/api/provider-ledger/backfill");
      try {
        for (const category of PROVIDER_FINANCIAL_CATEGORIES) {
          results.push(await syncProviderLedger(new BitgetClient(config), this, {
            category,
            mode: "backfill",
            telemetryPath: "/api/provider-ledger/backfill",
            originReadSummary,
            financialRecordsOnly: category !== "USDT-FUTURES",
            ...(baselineAt ? { coverageStartAt: baselineAt } : {}),
          }));
        }
      } finally {
        emitProviderOriginReadSummary(originReadSummary);
      }
      const diagnostics = [...providerLedgerDiagnosticsBatch(this, PROVIDER_FINANCIAL_CATEGORIES, "/api/provider-ledger/backfill").values()];
      return json({ source: "PROVIDER_READ_ONLY_BACKFILL", baselineAt, results, categories: diagnostics.map((entry) => ({ category: entry.category, rowCount: entry.counts.financialRecords, sync: entry.sync, coverage: entry.sync?.financialRecordCoverage ?? null })) });
    }
    if (url.pathname === "/policy" && request.method === "GET") return this.getPolicyRead();
    if (url.pathname === "/export/paper-log" && request.method === "GET") return noStore(TraderAgent.prototype.exportPaperLog.call(this, url, request));
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
      if (body.action === "START_PAPER_LOG_COLLECTION_EPOCH") return json({ error: "USE_PAPER_LOG_ARCHIVE_EPOCH_ENDPOINT" }, 409);
      if (body.action === "REBASELINE_LEGACY_EXECUTION_QUARANTINE") {
        const result = await this.rebaselineLegacyExecutionQuarantine(body.quarantines);
        return json(result, result.status === "REBASELINED" ? 200 : 409);
      }
      if (body.action === "DRY_RUN_EXECUTION_QUARANTINE_RECOVERY") {
        try {
          return json(await this.dryRunExecutionQuarantineRecovery(body.cycleId, body.decisionId, body.evidenceThrough));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message.split(":", 1)[0] ?? "EXECUTION_QUARANTINE_DRY_RUN_FAILED" : "EXECUTION_QUARANTINE_DRY_RUN_FAILED" }, 409);
        }
      }
      if (body.action === "RECONCILE_LATE_EXECUTION") {
        try {
          return json({ reconciliation: await this.reconcileLateExecution(body.cycleId, body.decisionId, body.evidenceHash, body.evidenceThrough) });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message.split(":", 1)[0] ?? "LATE_RECONCILIATION_FAILED" : "LATE_RECONCILIATION_FAILED" }, 409);
        }
      }
      if (body.action === "RECOVER_QUARANTINED_CLOSED_EXECUTION") {
        try {
          return json({ reconciliation: await this.recoverQuarantinedClosedExecution(body.cycleId, body.decisionId, body.evidenceHash, body.evidenceThrough) });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message.split(":", 1)[0] ?? "CLOSED_LIFECYCLE_QUARANTINE_RECOVERY_FAILED" : "CLOSED_LIFECYCLE_QUARANTINE_RECOVERY_FAILED" }, 409);
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
    const originReadSummary = createProviderOriginReadSummary("scheduled_provider_sync");
    try {
      ensureStorageInitialized(this);
      const config = loadConfig(this.env, this.ensureActivePolicy());
      const client = new BitgetClient(config);
      const results = [];
      for (const category of PROVIDER_FINANCIAL_CATEGORIES) {
        results.push(await syncProviderLedger(client, this, {
          category,
          mode: "recent",
          telemetryPath: "scheduled_provider_sync",
          originReadSummary,
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
    } finally {
      emitProviderOriginReadSummary(originReadSummary);
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

  private exportPaperLogCollectionPage(url: URL, format: "json" | "csv", epoch: PaperLogCollectionEpoch): Response {
    const operation = url.searchParams.get("page");
    if (operation === "snapshot") {
      if (url.searchParams.has("cursor")) return json({ error: "INVALID_PAPER_LOG_COLLECTION_EXPORT_CURSOR" }, 400);
      const requestedPeriod = parsePaperLogPeriod(url.searchParams.get("from"), url.searchParams.get("to"));
      if (requestedPeriod.end && requestedPeriod.end < epoch.startedAt) return json({ error: "PAPER_LOG_PERIOD_OUTSIDE_COLLECTION_EPOCH" }, 416);
      const period = {
        start: requestedPeriod.start && requestedPeriod.start > epoch.startedAt ? requestedPeriod.start : epoch.startedAt,
        end: requestedPeriod.end,
      };
      const highWaterRowIds = capturePaperLogCollectionExportHighWaterRowIds(this);
      const revision = loadPaperLogCollectionExportMutationRevision(this);
      const initialCursors = Object.fromEntries(PAPER_LOG_ARCHIVE_TABLES.map((table) => [table, encodePaperLogCollectionPageCursor({
        version: 1,
        epochId: epoch.epochId,
        highWaterRowIds,
        revision,
        period,
        table,
        afterRowId: table === "experiences" ? 0 : epoch.highWaterRowIds[table],
      })]));
      return json({
        schemaVersion: 1,
        source: "ACTIVE_COLLECTION_EPOCH",
        summaryScope: "NOT_INCLUDED_IN_RAW_PAGES",
        epochId: epoch.epochId,
        collectionStartedAt: epoch.startedAt,
        period,
        highWaterRowIds,
        revision,
        pageRowLimit: PAPER_LOG_COLLECTION_EXPORT_PAGE_LIMIT,
        pagePayloadByteLimit: PAPER_LOG_COLLECTION_EXPORT_PAGE_MAX_BYTES,
        cursors: initialCursors,
      });
    }
    if (operation !== "next") return json({ error: "INVALID_PAPER_LOG_COLLECTION_EXPORT_PAGE_OPERATION" }, 400);
    const cursorValue = url.searchParams.get("cursor");
    const cursor = cursorValue ? decodePaperLogCollectionPageCursor(cursorValue, epoch) : null;
    if (!cursor || !cursor.table || cursor.period.start < epoch.startedAt) return json({ error: "INVALID_PAPER_LOG_COLLECTION_EXPORT_CURSOR" }, 400);
    const currentRevision = loadPaperLogCollectionExportMutationRevision(this);
    if (currentRevision !== cursor.revision) return json({ error: "PAPER_LOG_COLLECTION_EXPORT_SNAPSHOT_STALE", restartWithNewSnapshot: true }, 409);
    const latestHighWater = capturePaperLogCollectionExportHighWaterRowIds(this);
    if (PAPER_LOG_ARCHIVE_TABLES.some((table) => cursor.highWaterRowIds[table] > latestHighWater[table])) return json({ error: "INVALID_PAPER_LOG_COLLECTION_EXPORT_CURSOR" }, 400);
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? PAPER_LOG_COLLECTION_EXPORT_PAGE_LIMIT
      : /^(0|[1-9][0-9]*)$/.test(limitValue) ? Number(limitValue) : Number.NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAPER_LOG_COLLECTION_EXPORT_PAGE_LIMIT) return json({ error: "INVALID_PAPER_LOG_COLLECTION_EXPORT_LIMIT" }, 400);
    try {
      const page = loadPaperLogCollectionExportPage(this, epoch, {
        table: cursor.table,
        afterRowId: cursor.afterRowId,
        throughRowIds: cursor.highWaterRowIds,
        period: cursor.period,
        limit,
      }, "/api/export/paper-log/page");
      if (page.hasMore && page.nextCursor <= cursor.afterRowId) return json({ error: "PAPER_LOG_COLLECTION_EXPORT_CURSOR_DID_NOT_ADVANCE" }, 500);
      const nextCursor = page.hasMore ? encodePaperLogCollectionPageCursor({ ...cursor, afterRowId: page.nextCursor }) : null;
      const metadata = {
        schemaVersion: 1 as const,
        source: "ACTIVE_COLLECTION_EPOCH" as const,
        summaryScope: "NOT_INCLUDED_IN_RAW_PAGES" as const,
        epochId: epoch.epochId,
        startedAt: epoch.startedAt,
        period: cursor.period,
        highWaterRowIds: cursor.highWaterRowIds,
        revision: cursor.revision,
        nextCursor,
        hasMore: page.hasMore,
        rowCount: page.rows.length,
        payloadBytes: page.payloadBytes,
      };
      if (format === "csv") return new Response(paperLogCollectionPageToCsv(cursor.table, page.rows, metadata), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=darwin-paper-log-${epoch.epochId}-${cursor.table}.csv`, "cache-control": "no-store" },
      });
      return new Response(JSON.stringify({
        schemaVersion: 1,
        source: "ACTIVE_COLLECTION_EPOCH",
        summaryScope: "NOT_INCLUDED_IN_RAW_PAGES",
        epochId: epoch.epochId,
        collectionStartedAt: epoch.startedAt,
        period: cursor.period,
        highWaterRowIds: cursor.highWaterRowIds,
        revision: cursor.revision,
        table: cursor.table,
        page: { nextCursor, hasMore: page.hasMore, rowCount: page.rows.length, payloadBytes: page.payloadBytes },
        rows: page.rows,
      }), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename=darwin-paper-log-${epoch.epochId}-${cursor.table}.json`, "cache-control": "no-store" } });
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":", 1)[0] ?? "PAPER_LOG_COLLECTION_EXPORT_PAGE_FAILED" : "PAPER_LOG_COLLECTION_EXPORT_PAGE_FAILED";
      const status = code === "PAPER_LOG_COLLECTION_HAS_INVALID_PAYLOAD" ? 409
        : code === "PAPER_LOG_COLLECTION_EXPORT_ROW_EXCEEDS_BYTE_LIMIT" || code === "PAPER_LOG_COLLECTION_EXPORT_PAGE_EXCEEDS_BYTE_LIMIT" ? 413
          : code === "PAPER_LOG_COLLECTION_EXPORT_REVISION_UNAVAILABLE" || code === "PAPER_LOG_COLLECTION_EXPORT_HIGH_WATER_UNAVAILABLE" ? 503
            : 400;
      return json({ error: code }, status);
    }
  }

  private exportPaperLog(url: URL, request: Request): Response {
    if (url.searchParams.has("page")) {
      const auth = authorizeOwner(request, this.env);
      if (!auth.authorized) return json({ error: auth.code }, auth.status);
    }
    try {
      if (this.env.TRADING_MODE !== "PAPER" || this.env.PAPER_ONLY !== "true") return json({ error: "PAPER_ONLY" }, 503);
      const format = url.searchParams.get("format") ?? "json";
      if (format !== "json" && format !== "csv") return json({ error: "INVALID_EXPORT_FORMAT" }, 400);
      const epoch = loadPaperLogCollectionEpoch(this);
      if (!epoch) return json({ error: "PAPER_LOG_COLLECTION_EPOCH_NOT_INITIALIZED" }, 409);
      if (url.searchParams.has("page")) return this.exportPaperLogCollectionPage(url, format, epoch);
      const requestedPeriod = parsePaperLogPeriod(url.searchParams.get("from"), url.searchParams.get("to"));
      if (requestedPeriod.end && requestedPeriod.end < epoch.startedAt) return json({ error: "PAPER_LOG_PERIOD_OUTSIDE_COLLECTION_EPOCH" }, 416);
      const start = requestedPeriod.start && requestedPeriod.start > epoch.startedAt ? requestedPeriod.start : epoch.startedAt;
      const period = { start, end: requestedPeriod.end };
      const exportSize = loadPaperLogCollectionExportSize(this, epoch, period.start ?? undefined, period.end ?? undefined);
      if (exportSize.invalidPayloadRows > 0) return json({ error: "PAPER_LOG_COLLECTION_HAS_INVALID_PAYLOAD" }, 409);
      if (exportSize.unpairedCurrentCycleRows > 0 || exportSize.unpairedCurrentJournalRows > 0) return json({ error: "PAPER_LOG_COLLECTION_HAS_UNPAIRED_CYCLES", unpairedCurrentCycleRows: exportSize.unpairedCurrentCycleRows, unpairedCurrentJournalRows: exportSize.unpairedCurrentJournalRows }, 409);
      if (exportSize.rowCount > MAX_PAPER_LOG_EXPORT_ROWS || exportSize.payloadBytes > MAX_PAPER_LOG_EXPORT_PAYLOAD_BYTES) {
        return json({ error: "PAPER_LOG_EXPORT_REQUIRES_BOUNDED_PAGES", rowCount: exportSize.rowCount, payloadBytes: exportSize.payloadBytes, hint: "Use page=snapshot for bounded row pages; use from/to only for smaller period summaries." }, 413);
      }
      const journals = loadAllAutonomousJournals(this, period.start ?? undefined, period.end ?? undefined, "/api/export/paper-log", "paper_log_current_epoch_journals", epoch.highWaterRowIds.journals);
      const exported = buildPaperLogExport({
        generatedAt: new Date().toISOString(),
        period,
        environment: this.env.ENVIRONMENT?.trim() || "unknown",
        model: this.env.QWEN_MODEL?.trim() || "unknown",
        version: this.env.APP_VERSION?.trim() || "unknown",
        commit: this.env.GIT_COMMIT_SHA?.trim() || "unknown",
        cycles: loadAllStoredCycles(this, period.start ?? undefined, period.end ?? undefined, "/api/export/paper-log", "paper_log_current_epoch_cycles", epoch.highWaterRowIds.cycles),
        journals,
        experiences: loadAllExperiences(this, "/api/export/paper-log", "paper_log_current_epoch_experiences", epoch.highWaterRowIds.experiences, period.start ?? undefined, period.end ?? undefined, epoch),
        events: loadAllEvents(this, "/api/export/paper-log", "paper_log_current_epoch_events", epoch.highWaterRowIds.events, period.start ?? undefined, period.end ?? undefined, epoch),
        includeUnlinkedEvents: true,
        collectionEpoch: { epochId: epoch.epochId, startedAt: epoch.startedAt, archiveManifestSha256: epoch.archiveManifestSha256, archiveContentSha256: epoch.archiveContentSha256, quarantineContentSha256: epoch.quarantineContentSha256 },
      });
      if (format === "csv") return new Response(paperLogToCsv(exported), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=darwin-paper-log-${epoch.epochId}.csv`, "cache-control": "no-store" } });
      return new Response(JSON.stringify(exported), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename=darwin-paper-log-${epoch.epochId}.json`, "cache-control": "no-store" } });
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":", 1)[0] ?? "PAPER_LOG_EXPORT_FAILED" : "PAPER_LOG_EXPORT_FAILED";
      const status = code === "PAPER_LOG_COLLECTION_EXPORT_REVISION_UNAVAILABLE" || code === "PAPER_LOG_COLLECTION_EXPORT_HIGH_WATER_UNAVAILABLE" ? 503 : 400;
      return json({ error: code }, status);
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

  private seedExecutionQuarantinesFromRecentJournals(): void {
    const existingSymbols = new Set(loadExecutionQuarantines(this).map((entry) => entry.symbol));
    const seedJournals = (journals: readonly TradingJournal[]): void => {
      for (const journal of journals) {
        if (journal.mode !== "AUTONOMOUS") continue;
        for (const record of normalizeCycleDecisions(journal).records) {
          const execution = record.executionResult;
          if (!execution) continue;
          const clientOrderId = record.executionRequest?.clientOrderId ?? execution.clientOrderId;
          const quarantineIdentity = { symbol: record.decision.symbol, decisionId: record.decision.decisionId, cycleId: journal.cycleId, clientOrderId };
          const priorResolution = loadExecutionQuarantineResolution(this, quarantineIdentity);
          if (priorResolution) {
            if (clearExecutionQuarantine(this, quarantineIdentity, priorResolution.resolvedAt)) {
              existingSymbols.delete(record.decision.symbol);
              this.recordEvent("EXECUTION_QUARANTINE_CLEARED", journal.cycleId, {
                ...quarantineIdentity,
                code: "PERSISTED_AUTHORITATIVE_RECONCILIATION",
                providerOrderId: priorResolution.providerOrderId,
                source: "HISTORICAL_JOURNAL_SEED",
              });
            }
            continue;
          }
          if (isDefinitivelyRejectedExecution(execution, record.executionRequest, { cycleId: journal.cycleId, decisionId: record.decision.decisionId })) {
            if (clearExecutionQuarantine(this, quarantineIdentity, execution.readBackAt)) {
              existingSymbols.delete(record.decision.symbol);
              this.recordEvent("EXECUTION_QUARANTINE_CLEARED", journal.cycleId, {
                ...quarantineIdentity,
                code: "DETERMINISTIC_PROVIDER_REJECTION",
                source: "HISTORICAL_JOURNAL_RECONCILIATION",
              });
            }
            continue;
          }
          if (execution.status !== "unknown" && record.reconciliationResult?.status === "MATCHED") continue;
          if (isLegacyExecutionQuarantineBaselined(this, quarantineIdentity)) continue;
          if (existingSymbols.has(record.decision.symbol)) continue;
          const reason = execution.status === "unknown"
            ? "EXECUTION_UNKNOWN"
            : record.reconciliationResult?.codes.join(",") || "EXECUTION_NOT_RECONCILED";
          // A proven pre-submit failure never created an order, so it must not become a quarantine.
          if (isDefinitivelyRejectedExecution(execution, record.executionRequest, { cycleId: journal.cycleId, decisionId: record.decision.decisionId })) continue;
          saveExecutionQuarantine(this, {
            symbol: record.decision.symbol,
            decisionId: record.decision.decisionId,
            cycleId: journal.cycleId,
            clientOrderId,
            reason,
            createdAt: execution.submittedAt,
          });
          existingSymbols.add(record.decision.symbol);
          this.recordEvent("EXECUTION_QUARANTINED", journal.cycleId, {
            symbol: record.decision.symbol,
            decisionId: record.decision.decisionId,
            clientOrderId,
            reason,
            code: "UNRESOLVED_PRIOR_EXECUTION",
            source: "HISTORICAL_JOURNAL_SEED",
          });
        }
      }
    };

    const backfill = loadExecutionQuarantineBackfillState(this);
    if (backfill.complete) {
      seedJournals(loadRecentJournals(this, 50, "on_start", "on_start_quarantine_recent_journals"));
      return;
    }

    let cursor = backfill.cursor;
    while (true) {
      const page = loadJournalBackfillPage(this, cursor, 50, "on_start", "on_start_execution_quarantine_journal_page");
      seedJournals(page.journals);
      if (!page.hasMore) {
        saveExecutionQuarantineBackfillState(this, { complete: true, cursor: null }, new Date().toISOString());
        return;
      }
      if (!page.nextCursor) throw new Error("EXECUTION_QUARANTINE_BACKFILL_CURSOR_MISSING");
      cursor = page.nextCursor;
      saveExecutionQuarantineBackfillState(this, { complete: false, cursor }, new Date().toISOString());
    }
  }

  private ensureReadModels(migrateLatestValidPlan = false): void {
    const initializedAt = new Date().toISOString();
    const performance = loadPerformanceAggregate<PerformanceAggregate>(this);
    const positionContextBootstrapped = loadPositionContextBootstrap(this);
    if (migrateLatestValidPlan && !loadLatestValidCyclePlan(this)) {
      const historicalLatestPlan = loadLatestCompletedCyclePlanFromHistory(this, "on_start", "on_start_latest_completed_cycle_plan");
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
    const openExperiences = loadOpenExperiences(this, 100, "on_start", "on_start_bootstrap_open_experiences");
    const recentJournals = loadRecentJournals(this, 100, "on_start", "on_start_bootstrap_recent_journals");
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
    liveIdentities: ReadonlyMap<string, ProviderLiveIdentity> = new Map(),
  ): PositionManagementState[] {
    const states: PositionManagementState[] = [];
    for (const position of positions.filter((candidate) => Number(candidate.quantity) > 0)) {
      // A provider-external management record carries no entry price or entry time, so lifecycle
      // metrics cannot be derived from it. It is excluded here rather than failing the cycle.
      const positionContext = loadPositionContext(this, position.symbol, position.positionSide);
      const experienceIndex = experiences.findIndex((candidate) =>
        resolveLifecycleExperience([candidate], position, liveIdentities.get(providerLivePositionLifecycleKey(position))) === candidate
        && positionContextMatchesLifecycle(positionContext, candidate));
      if (experienceIndex < 0) continue;
      const experience = experiences[experienceIndex];
      if (!experience) continue;
      const bundle = bundles.find((candidate) => candidate.instrument.symbol === position.symbol);
      const currentPrice = bundle?.market.lastPrice ?? position.markPrice;
      if (!currentPrice) continue;
      let experienceForRefresh = experience;
      if (!experience.maximumFavorableExcursionBasis) {
        const historicalPeak = reconstructMaximumFavorableReturnPct(position, experience, lifecycleHistory);
        if (historicalPeak !== null) experienceForRefresh = { ...experience, maximumFavorableExcursion: String(Math.max(Number(experience.maximumFavorableExcursion) || 0, historicalPeak)), maximumFavorableExcursionBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" };
        else if (experience.maximumFavorableExcursion === "UNAVAILABLE") {
          // CASE B: no usable prior historical observation exists, so the current
          // provider-backed market observation is itself the first deterministic
          // observation. buildPositionManagementState below derives the excursion
          // from that observation and stamps the basis, so the next cycle's gate is
          // false and no further history scan is requested. No historical MFE/MAE is
          // invented: only the current observation is used.
          experienceForRefresh = experience;
        }
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

  public async repairProviderClosedLifecycle(experienceId: string, providerPositionHistoryId: string, quarantineProof?: { identity: { symbol: string; decisionId: string; cycleId: string; clientOrderId: string }; providerOrderId: string; fillIds: string[]; executedQuantity: string; positionBefore?: string; positionAfter?: string; scannedOrders: Array<{ providerOrderId: string; createdAt: string }>; scannedFills: ProviderLifecycleFillEvidenceRow[]; evidenceHash: string; providerFillFinancials: Array<{ fillId: string; execPnl: string; feeTotal: string }>; providerPositionHistoryEvidence: ProviderLifecycleHistory }): Promise<{ status: "RECONCILED" | "ALREADY_RECONCILED"; experienceId: string; providerPositionHistoryId: string }> {
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");
    ensureStorageInitialized(this);
    const experience = loadExperienceById(this, experienceId);
    if (!experience) throw new Error("EXPERIENCE_NOT_FOUND");
    const eventId = providerLifecycleRepairEventId(experienceId, providerPositionHistoryId);
    if (experience.financialSource === "PROVIDER_LEDGER" && experience.providerPositionHistoryId === providerPositionHistoryId && experience.outcomeStatus !== "OPEN") {
      const context = experience.positionSide ? loadPositionContext(this, experience.symbol, experience.positionSide) : null;
      const auditEvent = loadEventById(this, eventId);
      if (!repairedLifecycleStateIsConsistent(experience, context, auditEvent, experienceId, providerPositionHistoryId)) throw new Error("PROVIDER_LIFECYCLE_REPAIR_STATE_INCONSISTENT");
      if (quarantineProof) {
        const priorResolution = loadExecutionQuarantineResolution(this, quarantineProof.identity);
        const active = loadExecutionQuarantines(this).some((item) => item.symbol === quarantineProof.identity.symbol && item.decisionId === quarantineProof.identity.decisionId && item.cycleId === quarantineProof.identity.cycleId && item.clientOrderId === quarantineProof.identity.clientOrderId);
        if (!priorResolution || priorResolution.providerOrderId !== quarantineProof.providerOrderId || active) throw new Error("EXECUTION_QUARANTINE_REPAIR_STATE_INCONSISTENT");
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
    if (quarantineProof && !providerLifecycleHistoryMatches(history, quarantineProof.providerPositionHistoryEvidence)) throw new Error("CLOSED_LIFECYCLE_DIRECT_POSITION_HISTORY_MISMATCH");
    const lifecycleFinancialRollup = quarantineProof ? reconcileProviderLifecycleFinancials(history, evidence.fills) : null;
    if (lifecycleFinancialRollup && !lifecycleFinancialRollup.valid) throw new Error(lifecycleFinancialRollup.code);
    if (quarantineProof) {
      const historyStart = Date.parse(history.openingTime);
      const historyEnd = Date.parse(history.closingTime);
      const directOrderIds = quarantineProof.scannedOrders.filter((row) => isTimestampWithin(row.createdAt, historyStart, historyEnd)).map((row) => row.providerOrderId).sort();
      const localOrderIds = evidence.orders.filter((row) => typeof row.createdAt === "string" && isTimestampWithin(row.createdAt, historyStart, historyEnd)).map((row) => row.providerOrderId).sort();
      const directFills = quarantineProof.scannedFills.filter((row) => isTimestampWithin(row.createdAt, historyStart, historyEnd));
      const localFills = evidence.fills.filter((row) => isTimestampWithin(row.createdAt, historyStart, historyEnd));
      if (JSON.stringify(directOrderIds) !== JSON.stringify(localOrderIds) || !providerLifecycleFillsMatch(directFills, localFills)) throw new Error("CLOSED_LIFECYCLE_PROVIDER_LEDGER_COVERAGE_MISMATCH");
      const qRecord = loadJournalForExactDecisionCycle(this, quarantineProof.identity.cycleId, quarantineProof.identity.decisionId);
      const qEntry = qRecord && normalizeCycleDecisions(qRecord).records.find((candidate) => candidate.decision.decisionId === quarantineProof.identity.decisionId);
      if (!qEntry || (qEntry.decision.action !== "REDUCE" && qEntry.decision.action !== "CLOSE") || qEntry.decision.symbol !== experience.symbol || qEntry.decision.positionSide !== experience.positionSide) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_JOURNAL_MISMATCH");
      const qOrders = evidence.orders.filter((order) => order.providerOrderId === quarantineProof.providerOrderId && order.clientOid === quarantineProof.identity.clientOrderId);
      if (qOrders.length !== 1 || qOrders[0]?.symbol !== experience.symbol || qOrders[0]?.positionSide !== experience.positionSide || qOrders[0]?.origin !== "DARWIN" || resolveProviderLifecycleSide(qOrders[0].side, qOrders[0].positionSide, qOrders[0].tradeSide) !== "CLOSE") throw new Error("CLOSED_LIFECYCLE_QUARANTINE_ORDER_NOT_IN_LOCAL_LIFECYCLE");
      const qFillSet = new Set(quarantineProof.fillIds);
      const qFills = evidence.fills.filter((fill) => fill.fillId && qFillSet.has(fill.fillId));
      if (qFills.length !== qFillSet.size || qFills.some((fill) => fill.providerOrderId !== quarantineProof.providerOrderId || fill.clientOid !== quarantineProof.identity.clientOrderId || fill.symbol !== experience.symbol || fill.positionSide !== experience.positionSide || fill.origin !== "DARWIN" || resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide) !== "CLOSE")) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_FILLS_NOT_IN_LOCAL_LIFECYCLE");
      const replay = reconstructProviderLifecycleTransitions(evidence);
      if (!replay.ok) throw new ProviderLifecycleClassificationError(replay.classification, replay.reason);
      const qTransitions = replay.transitions.filter((transition) => transition.fillId !== null && qFillSet.has(transition.fillId));
      const qTransitionIndexes = qTransitions.map((transition) => replay.transitions.indexOf(transition));
      const executedQuantity = qTransitions.reduce((sum, transition) => addDecimal(sum, subtractDecimal(transition.quantityBefore, transition.quantityAfter)), "0");
      const quarantinePositionBefore = qTransitions[0]?.quantityBefore ?? null;
      const quarantinePositionAfter = qTransitions.at(-1)?.quantityAfter ?? null;
      if (qTransitions.length !== qFillSet.size || qTransitions.some((transition) => transition.lifecycleSide !== "CLOSE")
        || compareDecimal(executedQuantity, quarantineProof.executedQuantity) !== 0
        || !quarantinePositionBefore || !quarantinePositionAfter
        || !isExactQuarantineQuantityTransition(quarantinePositionBefore, quarantinePositionAfter, quarantineProof.executedQuantity)
        || qTransitionIndexes.some((index, offset) => offset > 0 && index !== qTransitionIndexes[offset - 1]! + 1)) {
        throw new Error("CLOSED_LIFECYCLE_QUARANTINE_QUANTITY_TRANSITION_UNPROVEN");
      }
      if (quarantineProof.providerFillFinancials.length !== qFillSet.size || quarantineProof.providerFillFinancials.some((fill) => !qFillSet.has(fill.fillId) || !isDecimal(fill.execPnl) || !isDecimal(fill.feeTotal))) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_FINANCIAL_EVIDENCE_INVALID");
      const localQFinancials = new Map(qFills.map((fill) => [fill.fillId!, fill]));
      if (quarantineProof.providerFillFinancials.some((fill) => {
        const local = localQFinancials.get(fill.fillId);
        return !local || !providerDecimalEvidenceMatches(fill.execPnl, local.execPnl) || !providerDecimalEvidenceMatches(fill.feeTotal, local.feeTotal);
      })) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_FINANCIAL_LEDGER_MISMATCH");
      quarantineProof.positionBefore = quarantinePositionBefore;
      quarantineProof.positionAfter = quarantinePositionAfter;
    }
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
        ...(quarantineProof ? { quarantineDecisionId: quarantineProof.identity.decisionId, quarantineClientOrderId: quarantineProof.identity.clientOrderId, quarantineProviderOrderId: quarantineProof.providerOrderId, quarantineFillIds: JSON.stringify(quarantineProof.fillIds), quarantineExecutedQuantity: quarantineProof.executedQuantity, quarantinePositionBefore: quarantineProof.positionBefore ?? "", quarantinePositionAfter: quarantineProof.positionAfter ?? "", providerFillFinancials: JSON.stringify(quarantineProof.providerFillFinancials), providerLifecycleFinancialRollup: JSON.stringify(lifecycleFinancialRollup), evidenceHash: quarantineProof.evidenceHash } : {}),
      },
    };
    const quarantineResolution = quarantineProof ? { ...quarantineProof.identity, providerOrderId: quarantineProof.providerOrderId, resolvedAt: createdAt } : undefined;
    const quarantineClearedEvent = quarantineProof ? {
      eventId: `q-close:${quarantineProof.evidenceHash}`,
      type: "EXECUTION_QUARANTINE_CLEARED",
      cycleId: quarantineProof.identity.cycleId,
      createdAt,
      metadata: { ...quarantineProof.identity, providerOrderId: quarantineProof.providerOrderId, providerPositionHistoryId, resolution: "AUTHORITATIVE_REDUCE_CLOSE_LIFECYCLE", evidenceHash: quarantineProof.evidenceHash, executedQuantity: quarantineProof.executedQuantity, positionBefore: quarantineProof.positionBefore ?? "", positionAfter: quarantineProof.positionAfter ?? "", providerFillFinancials: JSON.stringify(quarantineProof.providerFillFinancials), providerLifecycleFinancialRollup: JSON.stringify(lifecycleFinancialRollup), providerNetProfit: history.netProfit ?? "", providerCloseFeeTotal: history.closeFeeTotal ?? "" },
    } : undefined;
    const written = persistProviderLifecycleRepair(this, (closure) => this.ctx.storage.transactionSync(closure), experience, context, closedExperience, closedContext, event, quarantineResolution, quarantineClearedEvent);
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

  /**
 * Owner-approved rebaseline of legacy execution quarantines.
 *
 * This is the terminal resolution for a quarantine whose bounded order-history search no
 * longer terminates. It requires a PAUSED idle agent and two independent, agreeing provider
 * reads of positions, open orders and the account. It never classifies the old order: the
 * archived entry keeps its original identity, reason, execution status and reconciliation
 * codes verbatim, so nothing is falsely marked FILLED, REJECTED or RECONCILED. The current
 * provider positions become the operational baseline instead.
 *
 * Only the exact legacy identities the owner named are archived. Any other active quarantine,
 * including a recent ambiguous write, is left untouched and keeps blocking its own symbol.
 */
public async rebaselineLegacyExecutionQuarantine(requestedIdentities: readonly LegacyQuarantineIdentity[]): Promise<Record<string, unknown>> {
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED" || this.state.cycleStartedAt || this.state.lastStatus === "RUNNING") {
      return { status: "REJECTED", blockers: ["EXECUTION_IN_PROGRESS"], rebaselined: [] };
    }
    ensureStorageInitialized(this);
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const activeQuarantines = loadExecutionQuarantines(this);
    if (activeQuarantines.length === 0) return { status: "REJECTED", blockers: ["NO_APPROVED_LEGACY_QUARANTINE"], rebaselined: [] };

    // The owner approves exact identities, never "everything currently quarantined". Each one is
    // re-checked against live persisted state, and only provably legacy ones are admitted.
    const selection = selectOwnerApprovedLegacyQuarantines({
      requested: requestedIdentities,
      activeQuarantines,
      nowMs: Date.now(),
      journalSymbolFor: (identity) => {
        const journal = loadJournalForExactDecisionCycle(this, identity.cycleId, identity.decisionId);
        return journal ? normalizeCycleDecisions(journal).records.find((candidate) => candidate.decision.decisionId === identity.decisionId)?.decision.symbol ?? null : null;
      },
    });
    const approvedQuarantines = selection.selected;
    const approvedSymbols = [...new Set(approvedQuarantines.map((entry) => entry.symbol))].sort();
    if (approvedQuarantines.length === 0) {
      this.recordEventBestEffort("LEGACY_QUARANTINE_REBASELINE_REJECTED", "CONTROL", {
        code: "NO_APPROVED_LEGACY_QUARANTINE",
        requested: String(requestedIdentities.length),
        source: "OWNER_APPROVED_LEGACY_REBASELINE",
      });
      return { status: "REJECTED", blockers: ["NO_APPROVED_LEGACY_QUARANTINE"], activeQuarantineCount: activeQuarantines.length, rejected: selection.rejected };
    }

    const client = new BitgetClient(config);
    const readSnapshot = async (): Promise<{ account: Awaited<ReturnType<BitgetClient["getDashboardPortfolio"]>>; observedAt: string } | null> => {
      try {
        const account = await client.getDashboardPortfolio();
        return { account, observedAt: account.observedAt };
      } catch {
        return null;
      }
    };
    const first = await readSnapshot();
    const second = first ? await readSnapshot() : null;

    const positionDiscrepancies = this.recordPositionDiscrepancies(
      loadOpenExperiences(this, MAX_LEGACY_REBASELINE_EXPERIENCES, "/api/control", "legacy_rebaseline_open_experiences"),
      first?.account.positions ?? [],
      "CONTROL",
    );
    const assessment = assessLegacyQuarantineRebaseline({
      paused: this.state.paused,
      runtimeStatus: this.state.runtimeStatus,
      cycleStartedAt: this.state.cycleStartedAt,
      paperOnly: this.env.TRADING_MODE === "PAPER" && this.env.PAPER_ONLY === "true",
      firstSnapshot: first,
      secondSnapshot: second,
      approvedQuarantineSymbols: approvedSymbols,
      positions: first?.account.positions ?? [],
    });
    if (!assessment.eligible) {
      this.recordEventBestEffort("LEGACY_QUARANTINE_REBASELINE_REJECTED", "CONTROL", {
        code: assessment.blockers.join(","),
        symbols: approvedSymbols.join(","),
        source: "OWNER_APPROVED_LEGACY_REBASELINE",
      });
      return { status: "REJECTED", blockers: assessment.blockers, approvedQuarantineSymbols: approvedSymbols, rejected: selection.rejected, positionDiscrepancies };
    }

    const rebaselineId = `legacy-rebaseline-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const rebaselineAt = new Date().toISOString();
    const evidence = {
      rebaselineId,
      category: config.bitgetCategory,
      portfolioEquity: assessment.portfolioEquity,
      availableMargin: assessment.availableMargin,
      openOrderCount: assessment.openOrderCount,
      snapshotEvidence: assessment.snapshotEvidence,
      positions: assessment.baselinePositions,
      positionFingerprint: assessment.positionFingerprint,
      approvedQuarantineSymbols: approvedSymbols,
      approvedQuarantineIdentities: approvedQuarantines.map((entry) => ({ symbol: entry.symbol, cycleId: entry.cycleId, decisionId: entry.decisionId, clientOrderId: entry.clientOrderId, reason: entry.reason, createdAt: entry.createdAt })),
      rejectedIdentities: selection.rejected,
    };
    const evidenceSha256 = await canonicalEvidenceSha256(evidence);
    const archiveEntries = approvedQuarantines.map((entry) => {
      const journal = loadJournalForExactDecisionCycle(this, entry.cycleId, entry.decisionId);
      const record = journal ? normalizeCycleDecisions(journal).records.find((candidate) => candidate.decision.decisionId === entry.decisionId) : undefined;
      return {
        status: "LEGACY_BASELINED" as const,
        symbol: entry.symbol,
        cycleId: entry.cycleId,
        decisionId: entry.decisionId,
        clientOrderId: entry.clientOrderId,
        reason: entry.reason,
        createdAt: entry.createdAt,
        // Original facts preserved verbatim: the order is never reclassified by this rebaseline.
        originalExecutionStatus: record?.executionResult?.status ?? "UNAVAILABLE",
        originalReconciliationCodes: record?.reconciliationResult?.codes.join(",") ?? "UNAVAILABLE",
        rebaselineId,
        rebaselineAt,
        evidenceSha256,
      };
    });
    const baseline = {
      rebaselineId,
      rebaselineAt,
      category: config.bitgetCategory,
      status: "LEGACY_BASELINED" as const,
      portfolioEquity: assessment.portfolioEquity,
      availableMargin: assessment.availableMargin,
      openOrderCount: assessment.openOrderCount,
      snapshotEvidence: assessment.snapshotEvidence,
      positions: assessment.baselinePositions,
      positionFingerprint: assessment.positionFingerprint,
      evidenceSha256,
    };
    const eventId = `legacy-rebaseline:${rebaselineId}`;
    const expectedIdentities = approvedQuarantines.map((entry) => legacyQuarantineIdentityKey(entry)).sort();
    let concurrencyConflict: string | null = null;
    let persisted = false;
    try {
      persisted = this.ctx.storage.transactionSync(() => {
      // The two provider reads above are asynchronous, so agent state and quarantine state may
      // have moved on. Re-verify the pause condition and the exact approved identities inside
      // the transaction: a length check alone would accept a different quarantine set.
      if (!this.state.paused || this.state.runtimeStatus !== "PAUSED" || this.state.cycleStartedAt || this.state.lastStatus === "RUNNING") {
        concurrencyConflict = "AGENT_STATE_CHANGED";
        return false;
      }
      const current = loadExecutionQuarantines(this);
      const currentKeys = current.filter((entry) => expectedIdentities.includes(legacyQuarantineIdentityKey(entry))).map((entry) => legacyQuarantineIdentityKey(entry)).sort();
      if (currentKeys.length !== expectedIdentities.length || currentKeys.some((key, index) => key !== expectedIdentities[index])) {
        concurrencyConflict = "LEGACY_QUARANTINE_STATE_CHANGED";
        return false;
      }
      saveLegacyExecutionQuarantineBaseline(this, baseline);
      appendLegacyExecutionQuarantineArchive(this, archiveEntries);
      for (const entry of approvedQuarantines) {
        // Throw rather than return: this runs after the baseline and archive writes, so only a
        // rollback leaves the rebaseline atomic.
        if (!clearExecutionQuarantine(this, entry, rebaselineAt)) {
          concurrencyConflict = "LEGACY_QUARANTINE_CLEAR_FAILED";
          throw new Error("LEGACY_QUARANTINE_CLEAR_FAILED");
        }
      }
      if (!hasEvent(this, eventId)) {
        saveEvent(this, {
          eventId,
          type: "LEGACY_EXECUTION_QUARANTINE_BASELINED",
          cycleId: "CONTROL",
          createdAt: rebaselineAt,
          metadata: {
            rebaselineId,
            evidenceSha256,
            symbols: approvedSymbols.join(","),
            archivedCount: String(archiveEntries.length),
            archivedIdentities: JSON.stringify(expectedIdentities),
            rejectedIdentities: JSON.stringify(selection.rejected),
            baselinePositions: JSON.stringify(assessment.baselinePositions),
            snapshotEvidence: JSON.stringify(assessment.snapshotEvidence),
            openOrderCount: String(assessment.openOrderCount),
            source: "OWNER_APPROVED_LEGACY_REBASELINE",
            // Explicit statement that no legacy order was reclassified.
            orderClassification: "UNCHANGED_ARCHIVED_NOT_RECONCILED",
          },
        });
      }
      return true;
      });
    } catch {
      // The transaction rolled back, so nothing was written. Report the conflict rather than
      // surfacing a raw error to the owner.
      this.recordEventBestEffort("LEGACY_QUARANTINE_REBASELINE_REJECTED", "CONTROL", {
        code: concurrencyConflict ?? "LEGACY_QUARANTINE_COMMIT_FAILED",
        symbols: approvedSymbols.join(","),
        source: "OWNER_APPROVED_LEGACY_REBASELINE",
      });
      return { status: "REJECTED", blockers: [concurrencyConflict ?? "LEGACY_QUARANTINE_COMMIT_FAILED"], approvedQuarantineSymbols: approvedSymbols, rejected: selection.rejected };
    }
    if (!persisted) {
      return { status: "REJECTED", blockers: [concurrencyConflict ?? "LEGACY_QUARANTINE_STATE_CHANGED"], approvedQuarantineSymbols: approvedSymbols, rejected: selection.rejected };
    }

    const remainingQuarantineSymbols = [...new Set(loadExecutionQuarantines(this).map((entry) => entry.symbol))].sort();
    const managed = legacyRebaselineManagedSymbols(assessment.baselinePositions, approvedSymbols);
    return {
      status: "REBASELINED",
      rebaselineId,
      rebaselineAt,
      evidenceSha256,
      baseline,
      archived: archiveEntries,
      providerPositionSymbols: managed.providerPositionSymbols,
      eligibleAgainSymbols: managed.eligibleAgainSymbols,
      // Quarantines the owner did not approve stay active and keep blocking their own symbol.
      remainingActiveQuarantineSymbols: remainingQuarantineSymbols,
      rejected: selection.rejected,
      riskLimitsUnchanged: true,
    };
  }

  public async dryRunExecutionQuarantineRecovery(originalCycleId: string, decisionId: string, throughInput?: string): Promise<Record<string, unknown>> {
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");
    ensureStorageInitialized(this);
    const journal = loadJournalForExactDecisionCycle(this, originalCycleId, decisionId);
    if (!journal) throw new Error("EXECUTION_QUARANTINE_CYCLE_NOT_FOUND");
    const record = normalizeCycleDecisions(journal).records.find((candidate) => candidate.decision.decisionId === decisionId);
    if (!record) throw new Error("EXECUTION_QUARANTINE_DECISION_NOT_FOUND");
    const request = record.executionRequest;
    const execution = record.executionResult;
    const symbol = record.decision.symbol;
    const positionSide = request?.positionSide ?? record.decision.positionSide;
    const clientOrderId = request?.clientOrderId ?? execution?.clientOrderId;
    if (!positionSide || !clientOrderId) throw new Error("EXECUTION_QUARANTINE_IDENTITY_INCOMPLETE");
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const quarantine = loadExecutionQuarantineDiagnostics(this, [symbol], config.bitgetCategory)
      .find((candidate) => candidate.identity.cycleId === originalCycleId
        && candidate.identity.decisionId === decisionId
        && candidate.identity.clientOrderId === clientOrderId);
    if (!quarantine) {
      const identity = { symbol, cycleId: originalCycleId, decisionId, clientOrderId };
      const resolution = loadExecutionQuarantineResolution(this, identity);
      const stillActive = loadExecutionQuarantines(this).some((item) => item.symbol === symbol && item.cycleId === originalCycleId && item.decisionId === decisionId && item.clientOrderId === clientOrderId);
      if (resolution && !stillActive) {
        const positionContext = positionSide ? loadPositionContext(this, symbol, positionSide) : null;
        const recoveredExperience = positionContext?.experienceId ? loadExperienceById(this, positionContext.experienceId) : undefined;
        const recoveryAudit = loadExecutionQuarantineRecoveryAuditEvents(this, identity);
        const historyId = positionContext?.closedProviderPositionHistoryId;
        const repairEvent = historyId && positionContext?.experienceId
          ? loadEventById(this, providerLifecycleRepairEventId(positionContext.experienceId, historyId))
          : undefined;
        const recovered = recoveredQuarantineAuditIsConsistent(record, identity, resolution.providerOrderId, positionContext ?? undefined, recoveredExperience ?? undefined, recoveryAudit, repairEvent);
        if (!recovered) throw new Error("EXECUTION_QUARANTINE_RESOLUTION_STATE_INCONSISTENT");
        return { status: "ALREADY_RECOVERED", recoveryEligible: false, identity, evidenceHash: recovered.evidenceHash, experienceId: recoveredExperience?.experienceId ?? null, providerPositionHistoryId: recovered.providerPositionHistoryId ?? null, resolution };
      }
      throw new Error(resolution ? "EXECUTION_QUARANTINE_RESOLUTION_STATE_INCONSISTENT" : "EXECUTION_QUARANTINE_NOT_ACTIVE");
    }

    const experiences = loadAllExperiences(this, "execution_quarantine_recovery", "execution_quarantine_recovery_experiences");
    const localExperience = experiences.find((candidate) => candidate.entryDecisionId === decisionId && candidate.symbol === symbol && candidate.positionSide === positionSide);
    const context = loadPositionContext(this, symbol, positionSide);
    const contextExperience = context?.experienceId ? loadExperienceById(this, context.experienceId) : undefined;
    const startCandidates = [execution?.submittedAt, localExperience?.entryTime, contextExperience?.entryTime]
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
    const createdAt = record.decision.createdAt;
    if (Number.isFinite(Date.parse(createdAt))) startCandidates.push(createdAt);
    if (startCandidates.length === 0) throw new Error("EXECUTION_QUARANTINE_HISTORY_START_MISSING");
    const from = new Date(Math.min(...startCandidates.map((value) => Date.parse(value)))).toISOString();
    const now = new Date();
    const through = throughInput ? new Date(throughInput) : now;
    if (!Number.isFinite(through.getTime()) || through.getTime() > now.getTime() || through.getTime() < Date.parse(from)) throw new Error("EXECUTION_QUARANTINE_HISTORY_WINDOW_INVALID");
    const history = await readBoundedProviderHistory(new BitgetClient(config), {
      category: config.bitgetCategory,
      symbol,
      from,
      through: through.toISOString(),
      now,
      maxPages: 24,
      maxRows: 2_400,
    });

    let directOrder: ReturnType<typeof parseProviderOrderReadback> = null;
    let directOrderRead = "NOT_ATTEMPTED";
    try {
      const raw = await new BitgetClient(config).getOrderDetailsRead(execution?.providerOrderId, clientOrderId);
      directOrder = parseProviderOrderReadback(raw);
      directOrderRead = directOrder ? "FOUND" : "UNPARSEABLE";
    } catch (error) {
      directOrderRead = providerReadFailureCode(error);
    }
    const parsedHistoryOrders = history.rows.orders.map((row) => parseProviderOrderReadback(row));
    const invalidOrderRows = parsedHistoryOrders.filter((candidate) => candidate === null).length;
    const ordersById = new Map<string, NonNullable<ReturnType<typeof parseProviderOrderReadback>>>();
    for (const candidate of [...parsedHistoryOrders, directOrder]) {
      if (!candidate) continue;
      const prior = ordersById.get(candidate.orderId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(candidate)) throw new Error("EXECUTION_QUARANTINE_PROVIDER_ORDER_READBACK_CONFLICT");
      ordersById.set(candidate.orderId, candidate);
    }
    const parsedFills = parseProviderFillEvidenceRows({ list: history.rows.fills });
    const historyFillFinancials = new Map<string, { execPnl: string | null; feeTotal: string | null }>();
    for (const row of history.rows.fills) {
      const normalized = normalizeProviderFill({ ...row, category: config.bitgetCategory }, "UNATTRIBUTED", through.toISOString());
      if (normalized) historyFillFinancials.set(normalized.execId, { execPnl: normalized.execPnl, feeTotal: normalized.feeTotal });
    }
    const invalidFillRows = parsedFills.invalidProviderRowCount;
    const expectedLifecycleSide = request
      ? resolveProviderLifecycleSide(request.providerSide, request.positionSide, request.tradeSide)
      : execution && positionSide
        ? resolveProviderLifecycleSide(execution.providerSide, positionSide, execution.tradeSide)
        : "UNRESOLVED";
    if (expectedLifecycleSide !== "OPEN" && expectedLifecycleSide !== "CLOSE") throw new Error("EXECUTION_QUARANTINE_TRADE_SIDE_INVALID");
    const expectedQuantity = execution?.status === "filled" ? execution.executedQuantity : request?.quantity;
    const expectedAveragePrice = execution?.status === "filled" ? execution.averageFillPrice : undefined;
    const historyComplete = history.status === "COMPLETE" && invalidOrderRows === 0 && invalidFillRows === 0;
    const assessment = assessExecutionQuarantineHistory({
      identity: {
        symbol,
        clientOrderId,
        ...(execution?.providerOrderId ? { providerOrderId: execution.providerOrderId } : {}),
        positionSide,
        lifecycleSide: expectedLifecycleSide,
        ...(expectedQuantity ? { expectedQuantity } : {}),
        ...(expectedAveragePrice ? { expectedAveragePrice } : {}),
      },
      orders: [...ordersById.values()],
      fills: parsedFills.records,
      historyComplete,
      directOrderLookup: directOrderRead === "FOUND" ? "FOUND" : directOrderRead === "PROVIDER_NOT_FOUND" ? "PROVIDER_NOT_FOUND" : directOrderRead === "UNPARSEABLE" ? "UNPARSEABLE" : "TRANSIENT_FAILURE",
      submittedAt: execution?.submittedAt ?? createdAt,
      observedAt: through.toISOString(),
    });

    let portfolioRead: Record<string, unknown>;
    let portfolioPositions: PositionSnapshot[] = [];
    let currentPosition: Record<string, unknown> | null = null;
    try {
      const portfolio = await new BitgetClient(config).getDashboardPortfolio();
      portfolioPositions = portfolio.positions;
      const position = portfolio.positions.find((candidate) => candidate.symbol === symbol && candidate.positionSide === positionSide);
      currentPosition = position ? {
        symbol: position.symbol,
        positionSide: position.positionSide,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        openedAt: position.openedAt ?? null,
      } : null;
      portfolioRead = { status: "OK", observedAt: portfolio.observedAt };
    } catch (error) {
      portfolioRead = { status: "READ_ERROR", code: providerReadFailureCode(error) };
    }
    const idem = this.sql<{ client_order_id: string; provider_order_id: string | null; created_at: string }>`
      SELECT client_order_id, provider_order_id, created_at FROM idempotency
      WHERE decision_id = ${decisionId} ORDER BY created_at, client_order_id LIMIT 2
    `;
    const hashRows = (rows: Record<string, unknown>[]) => [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const hashInput = JSON.stringify({
      identity: quarantine.identity,
      from,
      through: through.toISOString(),
      checkpoints: history.checkpoints,
      historyRows: {
        orders: hashRows(history.rows.orders),
        fills: hashRows(history.rows.fills),
        positionHistory: hashRows(history.rows.positionHistory),
        financialRecords: hashRows(history.rows.financialRecords),
      },
      directOrderRead,
      orders: [...ordersById.values()].sort((left, right) => left.orderId.localeCompare(right.orderId)),
      fills: parsedFills.records.sort((left, right) => left.fillId.localeCompare(right.fillId)),
      assessment: { status: assessment.status, reason: assessment.reason },
      portfolioRead: { status: portfolioRead.status, code: portfolioRead.code ?? null },
      currentPosition,
      idempotency: idem,
    });
    const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput));
    const evidenceHash = [...new Uint8Array(hashBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const exactHistory = history.rows.positionHistory.filter((row) => String(row.symbol ?? "") === symbol
      && String(row.posSide ?? row.positionSide ?? "").toUpperCase() === positionSide);
    const positionHistoryEvidence = exactHistory.flatMap((row) => {
      const normalized = normalizeProviderPositionHistory(row, through.toISOString(), "UNATTRIBUTED");
      if (!normalized?.providerPositionHistoryId) return [];
      return [{
        providerPositionHistoryId: normalized.providerPositionHistoryId,
        symbol: normalized.symbol,
        positionSide: normalized.positionSide,
        openingTime: normalized.openingTime,
        closingTime: normalized.closingTime,
        openTotalPos: normalized.openTotalPos,
        closeTotalPos: normalized.closeTotalPos,
        avgEntryPrice: normalized.avgEntryPrice,
        avgExitPrice: normalized.avgExitPrice,
        cumRealisedPnl: normalized.cumRealisedPnl,
        netProfit: normalized.netProfit,
        openFeeTotal: normalized.openFeeTotal,
        closeFeeTotal: normalized.closeFeeTotal,
        totalFunding: normalized.totalFunding,
        cashDividend: normalized.cashDividend,
        origin: "UNATTRIBUTED",
      } satisfies ProviderLifecycleHistory];
    });
    const exactFinancialRows = history.rows.financialRecords.filter((row) => String(row.orderId ?? row.order_id ?? "") === (assessment.order?.orderId ?? "")
      || String(row.clientOid ?? row.client_oid ?? "") === clientOrderId);
    const isOpenAction = record.decision.action === "OPEN_LONG" || record.decision.action === "OPEN_SHORT";
    const isClosedAction = record.decision.action === "REDUCE" || record.decision.action === "CLOSE";
    let lifecycleClassification: ProviderLifecycleClassification | "UNRESOLVED" = "UNRESOLVED";
    let lifecycleReason = "PROVIDER_LIFECYCLE_NOT_CLASSIFIED";
    let lifecycleEvidenceComplete = false;
    let lifecycleCoverageMatches = false;
    if (portfolioRead.status === "OK" && historyComplete && (isOpenAction || isClosedAction)) {
      try {
        const lifecycleExperience = isOpenAction
          ? localExperience ?? (currentPosition ? providerLiveProbeExperience(portfolioPositions.find((position) => position.symbol === symbol && position.positionSide === positionSide)!, decisionId) : undefined)
          : contextExperience;
        if (lifecycleExperience) {
          let lifecycleHistoryId = "";
          let directPositionHistoryMatches = isOpenAction;
          if (isClosedAction) {
            const localHistories = loadProviderPositionHistories(this, config.bitgetCategory, 500)
              .filter((candidate) => candidate.symbol === symbol && candidate.positionSide === positionSide && isNearTimestamp(candidate.openingTime, lifecycleExperience.entryTime));
            const localHistory = localHistories.length === 1 ? localHistories[0] : undefined;
            const directMatches = localHistory?.providerPositionHistoryId
              ? positionHistoryEvidence.filter((candidate) => candidate.providerPositionHistoryId === localHistory.providerPositionHistoryId)
              : [];
            lifecycleHistoryId = localHistory?.providerPositionHistoryId ?? "";
            directPositionHistoryMatches = Boolean(localHistory && directMatches.length === 1 && providerLifecycleHistoryMatches(localHistory, directMatches[0]!));
          }
          const lifecycleEvidence = loadProviderLifecycleEvidence(
            this,
            lifecycleExperience,
            config.bitgetCategory,
            lifecycleHistoryId,
            portfolioPositions,
            context ? deterministicEntryIdentity(lifecycleExperience, context) : { entryDecisionId: lifecycleExperience.entryDecisionId, clientOid: clientOrderId },
          );
          const lifecycleResult = classifyProviderLifecycle(lifecycleEvidence);
          lifecycleClassification = lifecycleResult.classification;
          lifecycleReason = lifecycleResult.reason;
          const currentLifecycleStart = isOpenAction
            ? Date.parse(portfolioPositions.find((position) => position.symbol === symbol && position.positionSide === positionSide)?.openedAt ?? "")
            : Date.parse(lifecycleExperience.entryTime);
          const lifecycleStart = currentLifecycleStart;
          const lifecycleEnd = through.getTime();
          const directOrderIds = parsedHistoryOrders.filter((candidate) => candidate !== null && candidate.symbol === symbol
            && candidate.positionSide === positionSide && isTimestampWithin(candidate.createdAt, lifecycleStart - 5_000, lifecycleEnd))
            .map((candidate) => candidate!.orderId).sort();
          const localOrderIds = lifecycleEvidence.orders.filter((candidate) => isTimestampWithin(candidate.createdAt ?? "", lifecycleStart - 5_000, lifecycleEnd))
            .map((candidate) => candidate.providerOrderId).sort();
          const directFills = parsedFills.records.filter((candidate) => candidate.symbol === symbol && candidate.positionSide?.toUpperCase() === positionSide
            && isTimestampWithin(candidate.createdAt, lifecycleStart - 5_000, lifecycleEnd)).map((candidate) => ({
              fillId: candidate.fillId,
              providerOrderId: candidate.orderId,
              clientOid: candidate.clientOid,
              symbol: candidate.symbol,
              side: candidate.side,
              positionSide: candidate.positionSide,
              tradeSide: candidate.tradeSide,
              quantity: candidate.quantity,
              execPrice: candidate.price,
              execPnl: historyFillFinancials.get(candidate.fillId)?.execPnl ?? null,
              feeTotal: historyFillFinancials.get(candidate.fillId)?.feeTotal ?? null,
              createdAt: candidate.createdAt,
              origin: "UNATTRIBUTED" as const,
            }));
          const localFills = lifecycleEvidence.fills.filter((candidate) => isTimestampWithin(candidate.createdAt, lifecycleStart - 5_000, lifecycleEnd));
          lifecycleCoverageMatches = JSON.stringify(directOrderIds) === JSON.stringify(localOrderIds)
            && providerLifecycleFillsMatch(directFills, localFills)
            && directPositionHistoryMatches;
          lifecycleEvidenceComplete = lifecycleEvidence.evidenceComplete !== false && lifecycleCoverageMatches;
        }
      } catch {
        lifecycleClassification = "UNRESOLVED";
        lifecycleReason = "LOCAL_PROVIDER_LIFECYCLE_RECONSTRUCTION_FAILED";
        lifecycleEvidenceComplete = false;
        lifecycleCoverageMatches = false;
      }
    }
    const unknownLateExecution = execution?.status === "unknown"
      && record.reconciliationResult?.status === "UNKNOWN"
      && isOpenAction
      && request?.clientOrderId === execution.clientOrderId
      && request.symbol === symbol
      && request.positionSide === positionSide
      && request.action === record.decision.action;
    const actionSpecificRequirementsMet = isOpenAction
      ? Boolean(execution && (isReadbackOnlyExecutionMismatch(record) || unknownLateExecution))
      : isClosedAction
        && Boolean(request && request.clientOrderId === clientOrderId && request.positionSide === positionSide
          && context && contextExperience?.outcomeStatus === "OPEN"
          && context.entryDecisionId === contextExperience.entryDecisionId
          && context.experienceId === contextExperience.experienceId);
    const readiness = assessExecutionQuarantineRecoveryReadiness({
      action: record.decision.action,
      identityExact: quarantine.identity.symbol === symbol && quarantine.identity.cycleId === originalCycleId
        && quarantine.identity.decisionId === decisionId && quarantine.identity.clientOrderId === clientOrderId,
      historyComplete,
      orderFound: directOrderRead === "FOUND" && assessment.status === "FOUND_EXACT",
      fillsComplete: assessment.status === "FOUND_EXACT" && assessment.aggregate?.valid === true,
      lifecycleClassification,
      lifecycleEvidenceComplete,
      actionSpecificRequirementsMet,
      currentPositionRead: portfolioRead.status === "OK" ? "OK" : "ERROR",
      currentPositionPresent: currentPosition !== null,
      currentPositionUnchanged: lifecycleCoverageMatches,
    });
    const recoveryBlockers = [...new Set([
      ...(!historyComplete ? history.errors[0] ? [history.errors[0]] : [] : []),
      ...(assessment.status !== "FOUND_EXACT" ? [assessment.reason] : []),
      ...readiness.blockers,
    ])];
    const recoveryBlocker = recoveryBlockers[0] ?? null;
    return {
      status: "DRY_RUN",
      mode: "READ_ONLY",
      recoveryEligible: readiness.recoveryEligible,
      recoveryBlocker,
      recoveryBlockers,
      lifecycleClassification,
      lifecycleReason,
      evidenceHash,
      evidenceThrough: through.toISOString(),
      identity: quarantine.identity,
      journal: { action: record.decision.action, executionStatus: execution?.status ?? null, reconciliation: record.reconciliationResult?.status ?? null },
      directOrderRead,
      providerHistory: {
        status: historyComplete ? "COMPLETE" : "INCOMPLETE",
        requestedFrom: history.requestedFrom,
        requestedThrough: history.requestedThrough,
        coveredFrom: history.coveredFrom,
        coveredThrough: history.coveredThrough,
        withinProviderRetention: history.withinProviderRetention,
        checkpoints: history.checkpoints,
        errors: history.errors,
        parsedOrderRows: parsedHistoryOrders.length - invalidOrderRows,
        invalidOrderRows,
        parsedFillRows: parsedFills.records.length,
        invalidFillRows,
        matchingPositionHistoryRows: exactHistory.length,
        positionHistoryEvidence,
        matchingFinancialRows: exactFinancialRows.length,
      },
      orderSearch: {
        status: assessment.status,
        reason: assessment.reason,
        authoritativeNotFound: assessment.authoritativeNotFound,
        order: assessment.order ? {
          providerOrderId: assessment.order.orderId,
          clientOrderId: assessment.order.clientOid,
          symbol: assessment.order.symbol,
          side: assessment.order.side,
          positionSide: assessment.order.positionSide,
          tradeSide: assessment.order.tradeSide,
          quantity: assessment.order.quantity,
          executedQuantity: assessment.order.executedQuantity,
          averageFillPrice: assessment.order.averageFillPrice,
          status: assessment.order.status,
          createdAt: assessment.order.createdAt,
        } : null,
        fills: assessment.fills.map((fill) => ({ fillId: fill.fillId, providerOrderId: fill.orderId, clientOrderId: fill.clientOid, quantity: fill.quantity, price: fill.price, side: fill.side, positionSide: fill.positionSide, tradeSide: fill.tradeSide, createdAt: fill.createdAt })),
        aggregate: assessment.aggregate,
      },
      lifecycleEvidence: {
        orders: parsedHistoryOrders.filter((order): order is NonNullable<typeof order> => order !== null && order.symbol === symbol && order.positionSide === positionSide).map((order) => ({ providerOrderId: order.orderId, createdAt: order.createdAt })).sort((left, right) => left.providerOrderId.localeCompare(right.providerOrderId)),
        fills: parsedFills.records.filter((fill) => fill.symbol === symbol && fill.positionSide?.toUpperCase() === positionSide).map((fill) => ({ fillId: fill.fillId, providerOrderId: fill.orderId, clientOid: fill.clientOid, symbol: fill.symbol, side: fill.side, positionSide: fill.positionSide, tradeSide: fill.tradeSide, quantity: fill.quantity, execPrice: fill.price, execPnl: historyFillFinancials.get(fill.fillId)?.execPnl ?? null, feeTotal: historyFillFinancials.get(fill.fillId)?.feeTotal ?? null, createdAt: fill.createdAt })).sort((left, right) => left.fillId.localeCompare(right.fillId)),
      },
      currentPosition: { read: portfolioRead, position: currentPosition },
      localContext: {
        experienceId: localExperience?.experienceId ?? null,
        experienceStatus: localExperience?.outcomeStatus ?? null,
        entryDecisionId: localExperience?.entryDecisionId ?? null,
        contextEntryDecisionId: context?.entryDecisionId ?? null,
        idempotency: idem,
        providerLedger: {
          orders: quarantine.providerLedger.orders,
          fills: quarantine.providerLedger.fills,
        },
      },
    };
  }

  public async recoverQuarantinedClosedExecution(originalCycleId: string, decisionId: string, evidenceHash: string, evidenceThrough: string): Promise<{ status: "RECONCILED" | "ALREADY_RECONCILED"; experienceId: string; providerPositionHistoryId: string }> {
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");
    const dryRun = await this.dryRunExecutionQuarantineRecovery(originalCycleId, decisionId, evidenceThrough);
    if (dryRun.status === "ALREADY_RECOVERED") {
      if (dryRun.evidenceHash !== evidenceHash) throw new Error("EXECUTION_QUARANTINE_EVIDENCE_CHANGED_REDRY_RUN_REQUIRED");
      return { status: "ALREADY_RECONCILED", experienceId: String(dryRun.experienceId ?? ""), providerPositionHistoryId: String(dryRun.providerPositionHistoryId ?? "") };
    }
    if (dryRun.evidenceHash !== evidenceHash) throw new Error("EXECUTION_QUARANTINE_EVIDENCE_CHANGED_REDRY_RUN_REQUIRED");
    if (dryRun.recoveryEligible !== true) throw new Error("EXECUTION_QUARANTINE_RECOVERY_NOT_ELIGIBLE");
    if (dryRun.status !== "DRY_RUN" || dryRun.directOrderRead !== "FOUND" || (dryRun.orderSearch as { status?: string } | undefined)?.status !== "FOUND_EXACT") throw new Error("EXECUTION_QUARANTINE_PROVIDER_EVIDENCE_NOT_READY");
    const historyCoverage = dryRun.providerHistory as { status?: string } | undefined;
    const positionRead = dryRun.currentPosition as { read?: { status?: string }; position?: unknown } | undefined;
    if (historyCoverage?.status !== "COMPLETE" || positionRead?.read?.status !== "OK" || positionRead.position !== null) throw new Error("CLOSED_LIFECYCLE_PROVIDER_COVERAGE_INCOMPLETE");
    const journal = loadJournalForExactDecisionCycle(this, originalCycleId, decisionId);
    if (!journal) throw new Error("EXECUTION_QUARANTINE_CYCLE_NOT_FOUND");
    const record = normalizeCycleDecisions(journal).records.find((candidate) => candidate.decision.decisionId === decisionId);
    if (!record || (record.decision.action !== "REDUCE" && record.decision.action !== "CLOSE") || !record.decision.positionSide || !record.executionRequest) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_ACTION_INVALID");
    const identity = dryRun.identity as { symbol: string; decisionId: string; cycleId: string; clientOrderId: string } | undefined;
    const foundOrder = (dryRun.orderSearch as { order?: { providerOrderId?: string; clientOrderId?: string; symbol?: string; side?: string; positionSide?: string; tradeSide?: string; executedQuantity?: string; averageFillPrice?: string; status?: string } | undefined } | undefined)?.order;
    const fillRows = (dryRun.orderSearch as { fills?: Array<{ fillId: string; providerOrderId: string; clientOrderId: string; symbol: string; quantity: string; price: string; side: string; positionSide: string; tradeSide: string }> } | undefined)?.fills ?? [];
    const fillIds = fillRows.map((fill) => fill.fillId);
    if (!identity || !foundOrder?.providerOrderId || foundOrder.clientOrderId !== record.executionRequest.clientOrderId || foundOrder.symbol !== record.decision.symbol || !fillIds.length || new Set(fillIds).size !== fillIds.length) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_IDENTITY_INCOMPLETE");
    const lifecycleSide = resolveProviderLifecycleSide(foundOrder.side, foundOrder.positionSide, foundOrder.tradeSide);
    if (lifecycleSide !== "CLOSE" || fillRows.some((fill) => fill.providerOrderId !== foundOrder.providerOrderId || fill.clientOrderId !== identity.clientOrderId || fill.symbol !== identity.symbol || fill.positionSide !== record.decision.positionSide || resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide) !== "CLOSE")) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_FILL_IDENTITY_MISMATCH");
    const expectedQuantity = record.executionResult?.status === "filled" ? record.executionResult.executedQuantity : record.executionRequest.quantity;
    const expectedPrice = record.executionResult?.averageFillPrice ?? foundOrder.averageFillPrice;
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const client = new BitgetClient(config);
    const rawOrder = await client.getOrderDetailsRead(foundOrder.providerOrderId, identity.clientOrderId);
    const exactOrder = parseProviderOrderEvidence(rawOrder);
    if (!exactOrder || exactOrder.orderId !== foundOrder.providerOrderId || exactOrder.clientOid !== identity.clientOrderId || exactOrder.symbol !== identity.symbol || exactOrder.positionSide !== record.decision.positionSide) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_ORDER_IDENTITY_MISMATCH");
    const rawFillHistory = await client.getFillHistoryRead(exactOrder.orderId);
    const fillBatch = parseProviderFillEvidenceRows(rawFillHistory);
    if (!isCompleteBoundedProviderFillHistory(rawFillHistory, fillBatch.providerRowCount)
      || fillBatch.providerRowCount === 0 || fillBatch.invalidProviderRowCount !== 0 || fillBatch.records.length !== fillBatch.providerRowCount) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_FILL_HISTORY_INCOMPLETE");
    const aggregate = aggregateProviderFillEvidence(fillBatch.records, exactOrder, expectedQuantity, expectedPrice ?? exactOrder.averageFillPrice, "CLOSE");
    if (!aggregate.valid || fillIds.some((fillId) => !aggregate.fills.some((fill) => fill.fillId === fillId))) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_FILL_AGGREGATE_MISMATCH");
    const rawFillRows = providerPage(rawFillHistory).rows;
    const providerFillFinancials = fillIds.map((fillId) => {
      const raw = rawFillRows.find((row) => String(row.execId ?? row.exec_id ?? "") === fillId);
      const normalized = raw && normalizeProviderFill({ ...raw, category: config.bitgetCategory }, "DARWIN", evidenceThrough);
      if (!normalized?.execPnl || !normalized.feeTotal || !isDecimal(normalized.execPnl) || !isDecimal(normalized.feeTotal)) throw new Error("CLOSED_LIFECYCLE_QUARANTINE_FINANCIAL_EVIDENCE_MISSING");
      return { fillId, execPnl: normalized.execPnl, feeTotal: normalized.feeTotal };
    });
    const context = loadPositionContext(this, record.decision.symbol, record.decision.positionSide);
    const experience = context?.experienceId ? loadExperienceById(this, context.experienceId) : undefined;
    if (!context || !experience || experience.outcomeStatus !== "OPEN" || context.entryDecisionId !== experience.entryDecisionId || (context.experienceId && context.experienceId !== experience.experienceId)) throw new Error("CLOSED_LIFECYCLE_LOCAL_CONTEXT_MISSING_OR_MISMATCHED");
    const histories = loadProviderPositionHistories(this, config.bitgetCategory, 500).filter((history) => history.symbol === experience.symbol && history.positionSide === experience.positionSide && isNearTimestamp(history.openingTime, experience.entryTime));
    if (histories.length !== 1 || !histories[0]?.providerPositionHistoryId) throw new Error(histories.length === 0 ? "CLOSED_LIFECYCLE_POSITION_HISTORY_NOT_FOUND" : "CLOSED_LIFECYCLE_POSITION_HISTORY_AMBIGUOUS");
    const directHistoryRows = (dryRun.providerHistory as { positionHistoryEvidence?: ProviderLifecycleHistory[] } | undefined)?.positionHistoryEvidence ?? [];
    const matchingDirectHistories = directHistoryRows.filter((history) => history.providerPositionHistoryId === histories[0]!.providerPositionHistoryId);
    if (matchingDirectHistories.length !== 1 || !providerLifecycleHistoryMatches(histories[0]!, matchingDirectHistories[0]!)) throw new Error("CLOSED_LIFECYCLE_DIRECT_POSITION_HISTORY_MISSING_OR_MISMATCHED");
    const lifecycleEvidence = dryRun.lifecycleEvidence as { orders?: Array<{ providerOrderId: string; createdAt: string }>; fills?: ProviderLifecycleFillEvidenceRow[] } | undefined;
    const proof = { identity, providerOrderId: exactOrder.orderId, fillIds, executedQuantity: aggregate.executedQuantity, scannedOrders: lifecycleEvidence?.orders ?? [], scannedFills: lifecycleEvidence?.fills ?? [], evidenceHash, providerFillFinancials, providerPositionHistoryEvidence: matchingDirectHistories[0]! };
    return this.repairProviderClosedLifecycle(experience.experienceId, histories[0].providerPositionHistoryId, proof);
  }

  public async reconcileLateExecution(originalCycleId: string, decisionId: string, evidenceHash: string, evidenceThrough: string): Promise<{ status: "RECONCILED" | "ALREADY_RECONCILED"; experienceId: string }> {
    if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");
    const dryRun = await this.dryRunExecutionQuarantineRecovery(originalCycleId, decisionId, evidenceThrough);
    if (dryRun.status === "ALREADY_RECOVERED") {
      if (dryRun.evidenceHash !== evidenceHash) throw new Error("EXECUTION_QUARANTINE_EVIDENCE_CHANGED_REDRY_RUN_REQUIRED");
      return { status: "ALREADY_RECONCILED", experienceId: String(dryRun.experienceId ?? "") };
    }
    if (dryRun.evidenceHash !== evidenceHash) throw new Error("EXECUTION_QUARANTINE_EVIDENCE_CHANGED_REDRY_RUN_REQUIRED");
    if (dryRun.recoveryEligible !== true) throw new Error("EXECUTION_QUARANTINE_RECOVERY_NOT_ELIGIBLE");
    if (dryRun.status !== "DRY_RUN" || (dryRun.orderSearch as { status?: string } | undefined)?.status !== "FOUND_EXACT") throw new Error("EXECUTION_QUARANTINE_PROVIDER_EVIDENCE_NOT_READY");
    const journal = loadJournalForExactDecisionCycle(this, originalCycleId, decisionId);
    if (!journal) throw new Error("LATE_RECONCILIATION_CYCLE_NOT_FOUND");
    const record = normalizeCycleDecisions(journal).records.find((candidate) => candidate.decision.decisionId === decisionId);
    if (!record) throw new Error("LATE_RECONCILIATION_RECORD_NOT_FOUND");
    const unknownLateExecution = record.executionResult?.status === "unknown"
      && record.reconciliationResult?.status === "UNKNOWN"
      && (record.decision.action === "OPEN_LONG" || record.decision.action === "OPEN_SHORT")
      && record.executionRequest?.clientOrderId === record.executionResult.clientOrderId
      && record.executionRequest.symbol === record.decision.symbol
      && record.executionRequest.positionSide === record.decision.positionSide
      && record.executionRequest.action === record.decision.action;
    if (!record.executionResult || (!isReadbackOnlyExecutionMismatch(record) && !unknownLateExecution)) throw new Error("LATE_RECONCILIATION_RECORD_NOT_ELIGIBLE");
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const client = new BitgetClient(config);
    const portfolio = await client.getDashboardPortfolio();
    const position = portfolio.positions.find((candidate) => candidate.symbol === record.decision.symbol && candidate.positionSide === record.decision.positionSide);
    if (!position) throw new Error("LATE_RECONCILIATION_POSITION_MISSING");
    const rawOrder = await client.getOrderDetailsRead(record.executionResult.providerOrderId, record.executionResult.clientOrderId);
    const order = parseProviderOrderEvidence(rawOrder);
    if (!order) throw new Error("LATE_RECONCILIATION_ORDER_INVALID");
    const rawFills = await client.getFillHistoryRead(order.orderId);
    const fillBatch = parseProviderFillEvidenceRows(rawFills);
    if (!isCompleteBoundedProviderFillHistory(rawFills, fillBatch.providerRowCount)
      || fillBatch.providerRowCount === 0 || fillBatch.invalidProviderRowCount !== 0 || fillBatch.records.length !== fillBatch.providerRowCount) throw new Error("LATE_RECONCILIATION_FILL_SET_INCOMPLETE");
    const fills = fillBatch.records;
    const expectedLifecycleSide = resolveProviderLifecycleSide(record.executionResult.providerSide, record.executionResult.positionSide, record.executionResult.tradeSide);
    if (expectedLifecycleSide !== "OPEN") throw new Error("LATE_RECONCILIATION_NOT_OPEN_EXECUTION");
    const expectedExecutionQuantity = unknownLateExecution ? record.executionRequest!.quantity : record.executionResult.executedQuantity;
    const aggregate = aggregateProviderFillEvidence(fills, order, expectedExecutionQuantity, record.executionResult.averageFillPrice ?? order.averageFillPrice, "OPEN");
    if (!aggregate.valid) throw new Error(aggregate.code);
    const experiences = loadAllExperiences(this, "late_reconciliation", "late_reconciliation_all_experiences");
    const existingExperience = experiences.find((experience) => experience.entryDecisionId === decisionId && experience.symbol === record.decision.symbol && experience.positionSide === record.decision.positionSide);
    const existingContext = loadPositionContext(this, record.decision.symbol, record.decision.positionSide!);
    if (existingContext && existingContext.entryDecisionId !== decisionId) throw new Error("LATE_RECONCILIATION_POSITION_CONTEXT_IDENTITY_MISMATCH");
    const lifecycleExperience = existingExperience ?? providerLiveProbeExperience(position, decisionId);
    const lifecycleEvidence = loadProviderLifecycleEvidence(this, {
      ...lifecycleExperience,
      outcomeStatus: "OPEN",
      entryDecisionId: decisionId,
      entryTime: existingExperience?.entryTime || position.openedAt || record.executionResult.submittedAt,
    }, config.bitgetCategory, "", portfolio.positions, {
      entryDecisionId: decisionId,
      clientOid: record.executionRequest?.clientOrderId ?? record.executionResult.clientOrderId,
    });
    const scanLifecycle = dryRun.lifecycleEvidence as { orders?: Array<{ providerOrderId: string; createdAt: string }>; fills?: ProviderLifecycleFillEvidenceRow[] } | undefined;
    const lifeStart = Date.parse(position.openedAt ?? "");
    const lifeEnd = Date.parse(evidenceThrough);
    const directOrderIds = (scanLifecycle?.orders ?? []).filter((row) => isTimestampWithin(row.createdAt, lifeStart - 5_000, lifeEnd)).map((row) => row.providerOrderId).sort();
    const localOrderIds = lifecycleEvidence.orders.filter((row) => typeof row.createdAt === "string" && isTimestampWithin(row.createdAt, lifeStart - 5_000, lifeEnd)).map((row) => row.providerOrderId).sort();
    const directFills = (scanLifecycle?.fills ?? []).filter((row) => isTimestampWithin(row.createdAt, lifeStart - 5_000, lifeEnd));
    const localFills = lifecycleEvidence.fills.filter((row) => isTimestampWithin(row.createdAt, lifeStart - 5_000, lifeEnd));
    if (JSON.stringify(directOrderIds) !== JSON.stringify(localOrderIds) || !providerLifecycleFillsMatch(directFills, localFills)) throw new Error("LATE_RECONCILIATION_PROVIDER_LEDGER_COVERAGE_MISMATCH");
    const lifecycle = classifyProviderLifecycle(lifecycleEvidence);
    if (lifecycle.classification !== "MATCHED_OPEN") throw new ProviderLifecycleClassificationError(lifecycle.classification, lifecycle.reason);
    if (lifecycleEvidence.entryIdentity?.providerOrderId !== order.orderId || lifecycleEvidence.entryIdentity.clientOid !== order.clientOid) throw new Error("LATE_RECONCILIATION_ENTRY_IDENTITY_MISMATCH");
    const resolvedAt = new Date().toISOString();
    const result = reconcileLateExecution({
      record,
      order,
      fill: fills[0]!,
      fills,
      currentPosition: position,
      currentPositionLifecycle: lifecycleEvidence,
      allowUnknownProviderExecution: unknownLateExecution,
      existingContext,
      resolvedAt,
      ...(existingExperience ? { existingExperience } : {}),
    });
    const clientOrderId = record.executionRequest?.clientOrderId ?? record.executionResult.clientOrderId;
    const quarantineIdentity = { symbol: record.decision.symbol, decisionId, cycleId: originalCycleId, clientOrderId };
    const performance = this.performanceWithEquity(portfolio.portfolioEquity, resolvedAt);
    const recoveryEventId = `q-recovery:${evidenceHash}`;
    const clearedEventId = `q-cleared:${evidenceHash}`;
    const resolutionEvent = {
      eventId: recoveryEventId,
      type: "LATE_EXECUTION_RECONCILED",
      cycleId: originalCycleId,
      createdAt: resolvedAt,
      metadata: { ...result.auditMetadata, originalCycleId, decisionId, clientOrderId, providerOrderId: order.orderId, evidenceHash, experienceId: result.experience.experienceId },
    };
    const clearedEvent = {
      eventId: clearedEventId,
      type: "EXECUTION_QUARANTINE_CLEARED",
      cycleId: originalCycleId,
      createdAt: resolvedAt,
      metadata: { symbol: record.decision.symbol, decisionId, clientOrderId, providerOrderId: order.orderId, code: "AUTHORITATIVE_LIFECYCLE_RECONCILIATION", evidenceHash },
    };
    this.ctx.storage.transactionSync(() => {
      if (!this.state.paused || this.state.runtimeStatus !== "PAUSED") throw new Error("AGENT_MUST_BE_PAUSED");
      const priorResolution = loadExecutionQuarantineResolution(this, quarantineIdentity);
      if (priorResolution && priorResolution.providerOrderId !== order.orderId) throw new Error("EXECUTION_QUARANTINE_RESOLUTION_IDENTITY_CONFLICT");
      const active = loadExecutionQuarantines(this).some((item) => item.symbol === quarantineIdentity.symbol
        && item.decisionId === quarantineIdentity.decisionId && item.cycleId === quarantineIdentity.cycleId
        && item.clientOrderId === quarantineIdentity.clientOrderId);
      if (!active && !priorResolution) throw new Error("EXECUTION_QUARANTINE_NOT_ACTIVE");
      if (result.status !== "ALREADY_RECONCILED") {
        saveExperience(this, result.experience, resolvedAt);
        savePositionContext(this, result.positionContext);
        savePerformanceAggregate(this, performance, resolvedAt);
      }
      if (!loadEventById(this, recoveryEventId)) saveEvent(this, resolutionEvent);
      recordExecutionQuarantineResolution(this, { ...quarantineIdentity, providerOrderId: order.orderId, resolvedAt });
      if (active && !clearExecutionQuarantine(this, quarantineIdentity, resolvedAt)) throw new Error("EXECUTION_QUARANTINE_ATOMIC_CLEAR_FAILED");
      if (!loadEventById(this, clearedEventId)) saveEvent(this, clearedEvent);
    });
    return { status: result.status, experienceId: result.experience.experienceId };
  }

  public async getDashboardSnapshot(livePortfolio?: DashboardSnapshot["portfolio"], activeConfig?: RuntimeConfig): Promise<DashboardSnapshot> {
    ensureStorageInitialized(this);
    if (livePortfolio) this.persistPerformanceEquity(livePortfolio.portfolioEquity, livePortfolio.observedAt);
    const config = activeConfig ?? loadConfig(this.env, this.ensureActivePolicy());
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
    const dataRevisions = loadProviderDataRevisions(this, PROVIDER_FINANCIAL_CATEGORIES);
    const lifecycleRevisions = dataRevisions.get(PROVIDER_TRADE_LIFECYCLE_CATEGORY);
    if (!lifecycleRevisions) throw new Error("PROVIDER_DATA_REVISION_UNAVAILABLE");
    const closedProviderPerformance = resolveProviderPerformanceMaterializedTotals(
      this,
      (closure) => this.ctx.storage.transactionSync(closure),
      PROVIDER_TRADE_LIFECYCLE_CATEGORY,
      livePortfolio?.observedAt ?? new Date().toISOString(),
      () => ({ lifecycleRevision: lifecycleRevisions.lifecycleRevision, identityRevision: lifecycleRevisions.identityRevision }),
      (rows, path) => resolveProviderPerformanceRows(this, rows, path),
    );
    const openPositionIdentities = livePortfolio
      ? loadProviderLiveOpeningOrderIdentities(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, livePortfolio.positions, "/api/snapshot")
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
        revision: dataRevisions.get(category)?.financialRevision ?? 0,
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
    ensureStorageInitialized(this);
    const limit = clampHistoryLimit(Number(url.searchParams.get("limit") ?? "25"));
    const journals = loadRecentJournals(this, limit);
    const storedCycles = loadRecentStoredCycles(this, limit);
    const events = loadRecentEvents(this, limit);
    const cycles = journals.map((entry) => cycleReadModelWithStatus(entry, storedCycles, events));
    return json({ journals, cycles, latestValidCyclePlan: loadLatestValidCyclePlan(this), decisions: journals.flatMap((entry) => cyclePlanDecisions(entry)), limit });
  }

  private getPositionContext(url: URL): Response {
    ensureStorageInitialized(this);
    const symbol = url.searchParams.get("symbol")?.trim() ?? "";
    const positionSide = url.searchParams.get("positionSide");
    if (!/^[A-Z0-9_-]{1,40}$/.test(symbol) || (positionSide !== "LONG" && positionSide !== "SHORT")) return json({ error: "INVALID_POSITION_CONTEXT_KEY" }, 400);
    return json({ source: "DARWIN_PERSISTED", context: loadPositionContext(this, symbol, positionSide) });
  }

  private async getTradeHistory(url: URL): Promise<Response> {
    ensureStorageInitialized(this);
    const limit = clampHistoryLimit(Number(url.searchParams.get("limit") ?? "25"));
    const MAX_EXCEPTIONAL_EXPERIENCES = 5;
    const recentExperiences = loadExperiences(this, Math.min(limit, MAX_EXCEPTIONAL_EXPERIENCES));
    const histories = loadRecentProviderPositionHistories(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, limit, "/api/trade-history");
    const historyDecisionIds = loadProviderPositionHistoryDecisionIds(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, histories, "/api/trade-history");
    const config = loadConfig(this.env, this.ensureActivePolicy());
    let positions: PositionSnapshot[] = [];
    try {
      positions = (await new BitgetClient(config).getDashboardPortfolio()).positions;
    } catch {
      // Missing current provider evidence keeps open-trade financials unresolved.
    }
    const openPositionIdentities = loadProviderLiveOpeningOrderIdentities(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, positions, "/api/trade-history");
    const reasoningDecisionIds = [...new Set([
      ...historyDecisionIds.values(),
      ...[...openPositionIdentities.values()].map((identity) => identity.decisionId),
      ...recentExperiences.flatMap((experience) => [experience.entryDecisionId, experience.exitDecisionId]),
    ])];
    const targetedExperiences = loadExperiencesForDecisionIds(this, reasoningDecisionIds, Math.min(reasoningDecisionIds.length, 100), "/api/trade-history");
    const experiencesById = new Map([...recentExperiences, ...targetedExperiences].map((experience) => [experience.experienceId, experience]));
    const experiences = [...experiencesById.values()];
    const linkedExperienceEvidence = loadJournalsForExperienceIds(this, recentExperiences.map((experience) => experience.experienceId), "/api/trade-history");
    const decisionEvidence = loadJournalsForDecisionIdsDetailed(this, reasoningDecisionIds, 100, "/api/trade-history");
    const blockedReasonEvidenceComplete = linkedExperienceEvidence.complete && decisionEvidence.complete;
    const journals = [...new Map([...linkedExperienceEvidence.journals, ...decisionEvidence.journals].map((journal) => [journal.cycleId, journal])).values()];
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
    const contexts = loadPositionContextsForKeys(this, contextKeys, Math.min(limit * 4, 400), "/api/trade-history");
    const resolved = resolveProviderTradeFacts(this, experiences, PROVIDER_TRADE_LIFECYCLE_CATEGORY, positions, { histories, historyDecisionIds, openPositionIdentities, positionContexts: contexts, queryPath: "/api/trade-history" });
    const localTrades = tradeLogEntries(experiences, journals, contexts, resolved.facts, blockedReasonEvidenceComplete).filter((trade) => {
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
    ensureStorageInitialized(this);
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
      const initialPortfolio = await runTimedCyclePhase("INITIAL_PORTFOLIO", () => client.getDashboardPortfolio());
      const livePositions = initialPortfolio.positions.filter((position) => Number(position.quantity) > 0);
      const openPositionSymbols = [...new Set(livePositions.map((position) => position.symbol))];
      const openPositionCount = countOpenPositionLifecycles(livePositions);
      const instruments = await runTimedCyclePhase("INSTRUMENTS", () => client.getTradableInstruments().catch(() => {
        this.recordEvent("DEMO_UNIVERSE_UNAVAILABLE", cycleId);
        return [];
      }));
      if (instruments.length === 0 && openPositionCount === 0) throw new Error("NO_TRADABLE_INSTRUMENTS");
      const supportedUniverse = instruments.map((instrument) => instrument.symbol);
      const allLessons = loadUsableLessons(this);
      const experiences = loadExperiences(this);
      const { scan, rankedScan } = await runTimedCyclePhase("MARKET_SCAN", async () => {
        const scan = await client.collectLightweightScan(instruments);
        const newEntryMarketCandidates = filterNewEntryMarketCandidates(scan, openPositionSymbols);
        return { scan, rankedScan: rankMarketCandidates(newEntryMarketCandidates) };
      });
      this.recordEvent("MARKET_SCAN", cycleId, { symbols: String(scan.length), preRanked: String(rankedScan.length) });
      this.setState({ ...this.state, runtimeStatus: "ANALYZING", currentStage: "ANALYZING" });
      const remainingEntrySlots = calculateActionCapacity(openPositionCount).remainingEntrySlots;
      const selectedEntryCandidateSymbols = selectDeterministicEntryCandidates(rankedScan, supportedUniverse, openPositionSymbols, remainingEntrySlots);
      if (remainingEntrySlots === 0) this.recordEvent("CANDIDATE_SELECTION_SKIPPED", cycleId, { code: "CAPACITY_SATURATED", openPositionCount: String(openPositionCount), source: "DETERMINISTIC_RANK" });
      else this.recordEvent("CANDIDATE_SELECTED", cycleId, { symbols: selectedEntryCandidateSymbols.join(","), source: "DETERMINISTIC_RANK" });
      const evidenceSymbols = buildEvidenceSymbols(openPositionSymbols, selectedEntryCandidateSymbols);
      const evidenceCollection = await runTimedCyclePhase("MARKET_EVIDENCE", () => client.collectSymbolMarketEvidence(evidenceSymbols, initialPortfolio, instruments));
      for (const unavailable of evidenceCollection.unavailable) this.recordEvent("MARKET_EVIDENCE_UNAVAILABLE", cycleId, {
        symbol: unavailable.symbol,
        providerOperation: unavailable.operation,
        code: "EVIDENCE_UNAVAILABLE",
        diagnostic: unavailable.diagnostic,
      });
      const bundles = evidenceCollection.bundles;
      const lessons = bundles.flatMap((bundle) => retrieveLessons(allLessons, { symbol: bundle.instrument.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN" }, 3))
        .filter((lesson, index, list) => list.findIndex((candidate) => candidate.lessonId === lesson.lessonId) === index)
        .slice(0, 5);
      const account = initialPortfolio;
      const openPositions = account.positions;
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
      // Deterministic provider identity decides whether a missing local experience is lost local
      // state (DARWIN-attributable) or a genuinely provider-external position. It is keyed by
      // the full lifecycle key, so re-key it to symbol:side for the discrepancy audit.
      const livePositionIdentities = loadProviderLiveOpeningOrderIdentities(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, openPositions, "/api/runCycle");
      const attributedLivePositionKeys = new Map<string, { decisionId: string; providerOrderId: string }>();
      for (const position of openPositions) {
        const identity = livePositionIdentities.get(providerLivePositionLifecycleKey(position));
        if (identity) attributedLivePositionKeys.set(providerLivePositionLifecycleKey(position), identity);
      }
      // A deterministically DARWIN-owned position with no local lifecycle is reconstructed before
      // any decision or risk check, so its lifecycle is never left unresolved merely because no
      // REDUCE or CLOSE has happened yet. No financial action is taken to cause this.
      const repairedLifecycles = this.repairMissingDarwinLifecycles(experiences, openPositions, livePositionIdentities, cycleId, startedAt);
      if (repairedLifecycles.length) {
        journal.repairedLifecycles = repairedLifecycles.map((experience) => experience.experienceId);
      }
      journal.positionDiscrepancies = this.recordPositionDiscrepancies(experiences, openPositions, cycleId, attributedLivePositionKeys);
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
      const positionManagementState = await runTimedCyclePhase("POSITION_MANAGEMENT", () => {
        // Reconstruction is scoped to lifecycles that are current provider-live,
        // deterministically resolved, and context-matched. Every persisted OPEN
        // experience is no longer a trigger, so a stale row cannot keep forcing a
        // history read in later cycles.
        const lifecycles = resolvePositionManagementLifecycles(this, experiences, openPositions, attributedLivePositionKeys);
        const reconstructionRequired = positionHistoryReconstructionRequired(lifecycles);
        try {
          console.log(JSON.stringify({ event: "POSITION_HISTORY_RECONSTRUCTION", required: reconstructionRequired }));
        } catch {
          // Cycle telemetry must not affect trading behavior.
        }
        // Bounded read: the hard limit is applied by SQL, so only the rows actually
        // relevant to current provider-live lifecycles are decoded into memory.
        const lifecycleHistory = reconstructionRequired
          ? loadBoundedPositionManagementHistory(this, positionHistoryRequests(lifecycles).map((lifecycle) => ({
            symbol: lifecycle.symbol,
            positionSide: lifecycle.positionSide,
            startAt: lifecycle.entryTime,
          })), { path: "scheduled_cycle", queryName: "position_management_bounded_history" }).journals
          : [];
        return this.refreshPositionManagementState(experiences, openPositions, bundles, new Date().toISOString(), lifecycleHistory, attributedLivePositionKeys);
      });
      journal.positionManagementState = positionManagementState;
      journal.promptVersions = { mandate: PROMPT_VERSIONS.mandate, decision: PROMPT_VERSIONS.decision };
      const openExperiences = [...new Map(openPositions
        .filter((position) => isPositiveDecimal(position.quantity))
        .flatMap((position) => {
          const current = resolveLifecycleExperience(experiences, position, attributedLivePositionKeys.get(providerLivePositionLifecycleKey(position)));
          if (!current || !positionContextMatchesLifecycle(loadPositionContext(this, position.symbol, position.positionSide), current)) return [];
          return [[current.experienceId, current] as const];
        })
      ).values()];
      const executionCapacityHints = buildExecutionCapacityHints(bundles, config.ownerPolicy.maxLeverage);
      const researchEvidence = await runTimedCyclePhase("RESEARCH", () => this.collectResearchEvidence(
        config,
        bundles,
        openPositionSymbols,
        selectedEntryCandidateSymbols,
        cycleId,
      ));
      const context = { bundles, supportedUniverse, openPositionSymbols, entryCandidateSymbols: selectedEntryCandidateSymbols, experiences, openExperiences, lessons, openPositions, positionManagementState, observedAt: new Date().toISOString(), mandate: TRADING_MANDATE, ...(researchEvidence === undefined ? {} : { researchEvidence }), executionCapacityHints };
      const decisionSet = await runTimedCyclePhase("DECISION_QWEN", async () => {
        try {
          return await decide(config, context, cycleId);
        } catch (error) {
          if (error instanceof ZodError) failureStage = "decision_schema_validation";
          throw error;
        }
      });
      if (decisionSet.ignoredLessonIds.length) this.recordEvent("LESSON_REFERENCE_IGNORED", cycleId, { count: String(decisionSet.ignoredLessonIds.length), ids: decisionSet.ignoredLessonIds.slice(0, 8).join(",") });
      journal.marketContext = { scan, deep: bundles.map((candidate) => ({ market: candidate.market, regime: candidate.marketRegime })) };
      journal.portfolio = account;
      journal.evidence = bundles.flatMap((candidate) => candidate.evidence);
      journal.retrievedLessons = lessons.map((lesson) => lesson.lessonId);
      const plan: CycleDecisionPlan = decisionSet.plan;
      journal.cyclePlan = plan;
      const marketEvidenceFailures = new Map<string, MarketEvidenceFailure>();
      const execution = await runTimedCyclePhase("EXECUTION_PLAN", () => executeCyclePlan(plan, {
        refreshEvidence: async (symbol) => {
          const account = await client.getDashboardPortfolio();
          const collection = await client.collectSymbolMarketEvidence([symbol], account, instruments);
          const failure = collection.unavailable[0];
          if (failure) {
            marketEvidenceFailures.set(symbol, failure);
            return undefined;
          }
          marketEvidenceFailures.delete(symbol);
          return collection.bundles[0];
        },
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
        onEvidenceUnavailable: (decision, parentDecision) => {
          const failure = marketEvidenceFailures.get(decision.symbol);
          const plannedDecision = parentDecision ?? decision;
          this.recordEvent("ACTION_SKIPPED", cycleId, {
            symbol: decision.symbol,
            action: plannedDecision.action,
            executionAction: decision.action,
            decisionId: plannedDecision.decisionId,
            decisionType: parentDecision ? "POSITION_MANAGEMENT" : plan.entryActions.some((entry) => entry.decisionId === decision.decisionId) ? "NEW_ENTRY" : "POSITION_MANAGEMENT",
            code: "EVIDENCE_UNAVAILABLE",
            providerOperation: failure?.operation ?? "marketEvidence",
            diagnostic: safeDiagnosticMessage(failure?.diagnostic, "Market evidence unavailable"),
          });
        },
      }));
      return await runTimedCyclePhase("FINALIZE", async () => {
        journal.executionRecords = execution.records;
        journal.discovery = { ...discovery, financialWritesPerformed: execution.records.filter((record) => Boolean(record.executionResult)).length };
        if (execution.finalPortfolio) journal.portfolio = execution.finalPortfolio;
        this.persistPerformanceEquity(execution.finalPortfolio?.portfolioEquity ?? account.portfolioEquity, execution.finalPortfolio?.observedAt ?? account.observedAt);
        this.setState({ ...this.state, runtimeStatus: "REFLECTING", currentStage: "REFLECTING" });
        const backtestLesson = backtest ? saveLesson(this, createBacktestLesson(backtest)) : undefined;
        journal.createdLessons = [...journal.createdLessons, ...(backtestLesson ? [backtestLesson.lessonId] : [])];
        if (backtestLesson) this.recordEvent("LESSON_CREATED", cycleId, { source: "BACKTEST_REPLAY" });
        journal.completedAt = new Date().toISOString();
        journal.durationMs = Math.max(0, new Date(journal.completedAt).getTime() - new Date(startedAt).getTime());
        this.recordEvent("CYCLE_COMPLETED", cycleId, { durationMs: String(journal.durationMs) });
        saveJournal(this, journal);
        saveCycle(this, cycleId, "COMPLETED", startedAt, journal.completedAt);
        saveLatestValidCyclePlan(this, { cycleId, plan, ...(journal.discovery ? { discovery: journal.discovery } : {}), startedAt, completedAt: journal.completedAt });
        this.setState({ ...this.state, runtimeStatus: drawdown.blocked ? "COOLDOWN" : "ONLINE", currentStage: drawdown.blocked ? "COOLDOWN" : "ONLINE", lastStatus: "COMPLETED", cycleStartedAt: null });
        return journal;
      });
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
    const unresolvedExecutionSymbols = loadExecutionQuarantines(this).map((entry) => entry.symbol);
    const riskGateResult = evaluateRiskGate(config, { decision, instrument: bundle.instrument, account: bundle.account, market: bundle.market, evidenceObservedAt: bundle.market.observedAt, openOrderSymbols: bundle.account.openOrderSymbols, supportedUniverse, emergencyStop: this.state.emergencyStop || config.ownerPolicy.emergencyStop, dailyDrawdownBlocked, ...(parentDecision ? { parentDecision } : {}), positionDiscrepancies, unresolvedExecutionSymbols });
    this.recordEvent("DECISION_CREATED", cycleId, { action: decision.action, symbol: decision.symbol, decisionType });
    this.recordEvent(riskGateResult.status === "PASS" ? "RISK_GATE_PASS" : "RISK_GATE_BLOCK", cycleId, { codes: riskGateResult.codes.join(","), decisionType, symbol: decision.symbol });
    if (riskGateResult.codes.includes("OPEN_ORDERS_READ_UNAVAILABLE")) {
      const failure = bundle.account.openOrdersReadFailure;
      this.recordEvent("ACTION_SKIPPED", cycleId, {
        symbol: decision.symbol,
        action: decision.action,
        decisionId: decision.decisionId,
        decisionType,
        code: "OPEN_ORDERS_READ_UNAVAILABLE",
        providerOperation: failure?.operation ?? "getOpenOrders",
        diagnostic: safeDiagnosticMessage(failure?.message ?? failure?.code, "Provider open-orders state unavailable"),
      });
    }
    const positionBefore = findPosition(bundle.account.positions, decision.symbol, decision.positionSide);
    const record: DecisionExecutionRecord = { decision, riskGateResult, ...(parentDecision ? { parentDecisionId: parentDecision.decisionId, parentAction: "REVERSE" as const, parentDecision } : {}), ...(positionBefore ? { positionBefore } : {}) };
    if (riskGateResult.status === "BLOCK" || decision.action === "HOLD") return record;
    this.setState({ ...this.state, runtimeStatus: "EXECUTING", currentStage: "EXECUTING" });
    const executionRequest = buildExecutionRequest(decision, bundle, cycleId);
    if (!recordIdempotency(this, executionRequest.clientOrderId, cycleId, decision.decisionId, startedAt)) throw new Error("DUPLICATE_ORDER");
    this.recordEvent("PAPER_ORDER_SUBMITTED", cycleId, { symbol: decision.symbol, action: decision.action, decisionType });
    const rawExecutionResult = await executePaperOrder(client, executionRequest);
    if (rawExecutionResult.providerOrderId) recordProviderOrderReference(this, executionRequest.clientOrderId, rawExecutionResult.providerOrderId);
    // A post-submit failure is only ambiguous after bounded confirmation. Re-reading the order,
    // its fills and the position once more prevents a transient provider failure from becoming a
    // permanent symbol quarantine. A proven pre-submit failure is never retried and never resubmitted.
    let executionResult = rawExecutionResult;
    if (rawExecutionResult.status === "unknown" && rawExecutionResult.submitState !== "NOT_SUBMITTED") {
      const confirmed = await client.confirmAmbiguousSubmission(executionRequest, rawExecutionResult.submittedAt);
      if (confirmed) {
        executionResult = confirmed;
        if (confirmed.providerOrderId) recordProviderOrderReference(this, executionRequest.clientOrderId, confirmed.providerOrderId);
        this.recordEvent("EXECUTION_POST_SUBMIT_CONFIRMED", cycleId, {
          symbol: decision.symbol,
          decisionType,
          status: confirmed.status,
          attempts: String(BOUNDED_SUBMISSION_CONFIRMATION_ATTEMPTS),
        });
      } else {
        this.recordEvent("EXECUTION_POST_SUBMIT_UNCONFIRMED", cycleId, { symbol: decision.symbol, decisionType, attempts: String(BOUNDED_SUBMISSION_CONFIRMATION_ATTEMPTS) });
      }
    }
    this.setState({ ...this.state, runtimeStatus: "RECONCILING", currentStage: "RECONCILING" });
    let positionAfter: PositionSnapshot | undefined;
    let readbackFailure = false;
    try {
      const afterPortfolio = await client.getDashboardPortfolio();
      record.accountAfter = afterPortfolio;
      positionAfter = findPosition(afterPortfolio.positions, decision.symbol, decision.positionSide);
    } catch {
      readbackFailure = true;
    }
    let reconciliationResult = reconcileExecution(executionRequest, executionResult, record.positionBefore, positionAfter);
    if (readbackFailure) reconciliationResult = { ...reconciliationResult, status: "UNKNOWN", codes: [...reconciliationResult.codes, "POSITION_READBACK_UNAVAILABLE"] };
    if (!readbackFailure && executionRequest.tradeSide === "open" && executionResult.status === "filled" && !positionAfter) reconciliationResult = { ...reconciliationResult, status: "MISMATCH", codes: [...reconciliationResult.codes, "POSITION_READBACK_MISSING"] };
    record.executionRequest = executionRequest;
    record.executionResult = executionResult;
    record.reconciliationResult = reconciliationResult;
    if (positionAfter) record.positionAfter = positionAfter;
    if (!isDefinitivelyRejectedExecution(executionResult, executionRequest, { cycleId, decisionId: decision.decisionId }) && (executionResult.status === "unknown" || reconciliationResult.status !== "MATCHED")) {
      const quarantine = {
        symbol: decision.symbol,
        decisionId: decision.decisionId,
        cycleId,
        clientOrderId: executionRequest.clientOrderId,
        reason: executionResult.status === "unknown" ? "EXECUTION_UNKNOWN" : reconciliationResult.codes.join(",") || "EXECUTION_NOT_RECONCILED",
        createdAt: executionResult.submittedAt,
      };
      saveExecutionQuarantine(this, quarantine, executionResult.readBackAt);
      this.recordEvent("EXECUTION_QUARANTINED", cycleId, { symbol: decision.symbol, decisionId: decision.decisionId, clientOrderId: executionRequest.clientOrderId, reason: quarantine.reason });
    }
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
    // Resolve the provider identity before touching PositionContext or lifecycle persistence. A
    // partial identity match with another populated field conflicting is never ownership proof.
    const livePosition = record.positionBefore;
    const liveIdentityMap = isManagementDecision && livePosition
      ? loadProviderLiveOpeningOrderIdentities(this, PROVIDER_TRADE_LIFECYCLE_CATEGORY, [livePosition], "/api/runCycle")
      : new Map<string, ProviderLiveIdentity>();
    const liveIdentity = livePosition ? liveIdentityMap.get(providerLivePositionLifecycleKey(livePosition)) : undefined;
    let resolvedExperience = livePosition && liveIdentity
      ? resolveLifecycleExperience(experiences, livePosition, liveIdentity)
      : undefined;
    const isRiskReducingManagement = decision.action === "CLOSE" || decision.action === "REDUCE";
    let resolvedContext = livePosition ? loadPositionContext(this, livePosition.symbol, livePosition.positionSide) : null;
    let closeRepair: Extract<DarwinLifecycleRepairPreparation, { status: "READY" }> | undefined;
    if (livePosition && liveIdentity && verified && isRiskReducingManagement
      && (!resolvedExperience || !positionContextMatchesLifecycle(resolvedContext, resolvedExperience))) {
      if (decision.action === "CLOSE") {
        const preparation = this.prepareDarwinLifecycleRepair(experiences, livePosition, liveIdentity, executionResult?.readBackAt ?? bundle.market.observedAt);
        if (preparation.status === "READY") {
          closeRepair = preparation;
          resolvedExperience = preparation.experience;
          resolvedContext = preparation.context;
        } else {
          const diagnosticId = `${preparation.eventType.toLowerCase()}:${liveIdentity.decisionId}:${preparation.existingContext?.entryDecisionId ?? "NONE"}`;
          this.ctx.storage.transactionSync(() => {
            if (!hasEvent(this, diagnosticId)) {
              saveEvent(this, {
                eventId: diagnosticId,
                type: preparation.eventType,
                cycleId,
                createdAt: executionResult?.readBackAt ?? bundle.market.observedAt,
                metadata: {
                  reason: preparation.reason,
                  symbol: livePosition.symbol,
                  positionSide: livePosition.positionSide,
                  expectedEntryDecisionId: liveIdentity.decisionId,
                  existingEntryDecisionId: preparation.existingContext?.entryDecisionId ?? UNAVAILABLE_ATTRIBUTE,
                  providerOrderId: liveIdentity.providerOrderId,
                  experienceId: preparation.experienceId,
                },
              });
            }
          });
        }
      } else {
        this.repairMissingDarwinLifecycles(experiences, [livePosition], liveIdentityMap, cycleId, startedAt);
        resolvedExperience = resolveLifecycleExperience(experiences, livePosition, liveIdentity);
        resolvedContext = loadPositionContext(this, livePosition.symbol, livePosition.positionSide);
      }
    }
    const currentExperience = resolvedExperience && positionContextMatchesLifecycle(resolvedContext, resolvedExperience)
      ? resolvedExperience
      : undefined;
    if (isManagementDecision && managementDecision.action !== "CLOSE" && (decision.action === "HOLD" || verified) && currentExperience) this.updatePositionContext(record, currentExperience);
    // Provider-external or identity-conflicted management records must not be adopted as local lifecycles.
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
      const persistedFailureLesson = saveLesson(this, failureResult.lesson);
      journal.experienceId = failureResult.experience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), failureResult.experience.experienceId];
      journal.reflection = failureResult.reflection;
      journal.createdLessons = [...journal.createdLessons, persistedFailureLesson.lessonId];
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
        selectedLeverage: record.positionAfter?.leverage ?? executionResult.leverage,
        evidenceAtExit: bundle.evidence.map((evidence) => evidence.type),
        lastAction: "INCREASE" as const,
      };
      if (index >= 0) experiences[index] = updatedExperience;
      saveExperience(this, updatedExperience, startedAt);
      journal.experienceId = updatedExperience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), updatedExperience.experienceId];
      return {};
    }
    // A deterministic DARWIN position whose lifecycle still cannot be resolved after the
    // transactional repair must remain incomplete. The execution stays in its journal; do not
    // write an experience-only row or claim a successful lifecycle repair.
    if (!currentExperience && liveIdentity && isManagementDecision && verified && ["CLOSE", "REDUCE"].includes(decision.action)) return {};
    // Without deterministic opening provenance, a verified risk-reducing action may be recorded as
    // provider-external, but it cannot claim DARWIN ownership or supply a missing local context.
    if (!currentExperience && !liveIdentity && isManagementDecision && verified && executionResult && ["CLOSE", "REDUCE"].includes(decision.action)) {
      const positionSide = decision.positionSide;
      const realizedPnl = isDecimal(executionResult.realizedPnl) ? executionResult.realizedPnl : undefined;
      const outcomeStatus = managementOutcomeStatus(decision.action as "CLOSE" | "REDUCE");
      const entryTime = providerEntryTime(record.positionBefore);
      const remaining = remainingOpenState(decision.action as "CLOSE" | "REDUCE", record.positionAfter);
      const experienceId = providerManagementExperienceId(decision.symbol, positionSide);
      const repairedExperience: TradeExperience = {
        experienceId,
        symbol: decision.symbol,
        positionSide,
        action: decision.action,
        entryDecisionId: "",
        entryPrice: providerFact(record.positionBefore?.entryPrice),
        entryTime,
        exitDecisionId: decision.decisionId,
        exitPrice: executionResult.averageFillPrice ?? UNAVAILABLE_ATTRIBUTE,
        exitTime: executionResult.readBackAt ?? bundle.market.observedAt,
        selectedLeverage: remaining.selectedLeverage,
        marginAllocationPct: UNAVAILABLE_ATTRIBUTE,
        marginAllocated: remaining.marginAllocated,
        positionNotional: remaining.positionNotional,
        realizedPnl: realizedPnl ?? UNAVAILABLE_ATTRIBUTE,
        realizedPnlPct: executionResult.realizedPnlPct ?? UNAVAILABLE_ATTRIBUTE,
        maximumFavorableExcursion: UNAVAILABLE_ATTRIBUTE,
        maximumAdverseExcursion: UNAVAILABLE_ATTRIBUTE,
        drawdownContribution: UNAVAILABLE_ATTRIBUTE,
        liquidationDistance: UNAVAILABLE_ATTRIBUTE,
        entryThesis: UNAVAILABLE_ATTRIBUTE,
        exitThesis: `Provider-confirmed ${decision.action} of a live position with no deterministic local entry identity.`,
        evidenceAtEntry: [],
        evidenceAtExit: bundle.evidence.map((evidence) => evidence.type),
        lessonsUsed: [],
        marketContext: bundle.marketRegime ?? "UNKNOWN",
        outcomeStatus,
        lastAction: decision.action,
        realizedPnlVerified: Boolean(realizedPnl),
        financialSource: "LOCAL",
        origin: "PROVIDER_EXTERNAL",
        ...(executionResult.fees ? { fees: executionResult.fees } : {}),
        ...(executionResult.funding ? { funding: executionResult.funding } : {}),
      };
      saveExperience(this, repairedExperience, startedAt);
      journal.experienceId = repairedExperience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), repairedExperience.experienceId];
      this.recordEvent("PROVIDER_EXTERNAL_MANAGEMENT_RECORDED", cycleId, {
        experienceId: repairedExperience.experienceId,
        symbol: decision.symbol,
        positionSide: positionSide ?? "UNKNOWN",
        action: decision.action,
        origin: "PROVIDER_EXTERNAL",
        providerOrderId: executionResult.providerOrderId ?? UNAVAILABLE_ATTRIBUTE,
        clientOrderId: executionResult.clientOrderId,
        realizedPnlVerified: String(Boolean(realizedPnl)),
        entryProvenance: "UNATTRIBUTED_NO_LOCAL_ENTRY",
        entryTime,
      });
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
      const remaining = remainingOpenState("CLOSE", record.positionAfter);
      const reflectedExperience = { ...local.experience, ...remaining };
      const closedAt = executionResult.readBackAt ?? bundle.market.observedAt;
      const managedContext = resolvedContext
        ? upsertPositionContext(resolvedContext, record.decision, closedAt, reflectedExperience, record.parentDecision)
        : null;
      if (!managedContext) throw new Error("POSITION_CONTEXT_IDENTITY_UNRESOLVED");
      const closedContext = {
        ...managedContext,
        symbol: currentExperience.symbol,
        positionSide: currentExperience.positionSide!,
        experienceId: currentExperience.experienceId,
        entryDecisionId: currentExperience.entryDecisionId,
        lifecycleStatus: "CLOSED" as const,
        closedAt,
        updatedAt: closedAt,
      };
      const closeEventId = `darwin-lifecycle-closed:${currentExperience.experienceId}:${decision.decisionId}`;
      this.ctx.storage.transactionSync(() => {
        saveExperience(this, reflectedExperience, startedAt);
        savePositionContext(this, closedContext);
        if (closeRepair && (closeRepair.experienceCreated || closeRepair.contextChanged) && !hasEvent(this, closeRepair.eventId)) {
          saveEvent(this, {
            eventId: closeRepair.eventId,
            type: "DARWIN_LIFECYCLE_REPAIRED",
            cycleId,
            createdAt: closedAt,
            metadata: {
              reason: REPAIR_REASON,
              experienceId: reflectedExperience.experienceId,
              symbol: currentExperience.symbol,
              positionSide: currentExperience.positionSide ?? "UNKNOWN",
              origin: "DARWIN",
              entryDecisionId: liveIdentity?.decisionId ?? currentExperience.entryDecisionId,
              lifecycleOpeningOrderId: liveIdentity?.providerOrderId ?? currentExperience.providerOrderId ?? UNAVAILABLE_ATTRIBUTE,
              entryTime: reflectedExperience.entryTime,
              entryPrice: reflectedExperience.entryPrice,
              entryThesisProvenance: closeRepair.entryThesis === UNAVAILABLE_ATTRIBUTE ? "UNAVAILABLE" : "PERSISTED_DARWIN_EVIDENCE",
              positionContextRepaired: String(closeRepair.contextChanged),
            },
          });
        }
        if (!hasEvent(this, closeEventId)) {
          saveEvent(this, {
            eventId: closeEventId,
            type: "DARWIN_LIFECYCLE_CLOSED",
            cycleId,
            createdAt: closedAt,
            metadata: {
              experienceId: currentExperience.experienceId,
              entryDecisionId: currentExperience.entryDecisionId,
              providerOrderId: currentExperience.providerOrderId ?? UNAVAILABLE_ATTRIBUTE,
              closeDecisionId: decision.decisionId,
              symbol: currentExperience.symbol,
              positionSide: currentExperience.positionSide ?? "UNKNOWN",
            },
          });
        }
      });
      const index = experiences.indexOf(currentExperience);
      if (index >= 0) experiences[index] = reflectedExperience;
      journal.experienceId = reflectedExperience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), reflectedExperience.experienceId];
      try {
        const result = await reflectWithQwen(config, closeInput);
        const updated = { ...result.experience, ...remaining };
        saveExperience(this, updated, startedAt);
        if (index >= 0) experiences[index] = updated;
        const persistedLesson = saveLesson(this, result.lesson);
        recordLessonApplication(this, cycleId, result.reflection.lessonEvaluations.filter((evaluation) => result.experience.lessonsUsed.includes(evaluation.lessonId)), new Date().toISOString());
        this.recordEvent("REFLECTION_COMPLETED", cycleId, { symbol: decision.symbol, action: decision.action });
        this.recordEvent("LESSON_CREATED", cycleId, { source: result.lesson.source, symbol: decision.symbol });
        journal.createdLessons = [...journal.createdLessons, persistedLesson.lessonId];
        journal.exitReflections = [...(journal.exitReflections ?? []), result.reflection];
        journal.reflection = result.reflection;
        return { reflection: result.reflection, lesson: persistedLesson };
      } catch (error) {
        this.recordEvent("REFLECTION_FAILED", cycleId, { code: error instanceof Error ? error.message.split(":", 1)[0] ?? "REFLECTION_FAILED" : "REFLECTION_FAILED", symbol: decision.symbol });
      }
      return {};
    }
    if (decision.action === "REDUCE" && verified) {
      const partialInput = { ...sharedInput, outcome: "PARTIAL_REDUCE", failureCode: "", experienceStatus: "OPEN" as const, existingExperience: currentExperience };
      const local = reflect(partialInput);
      const remaining = remainingOpenState("REDUCE", record.positionAfter);
      const reflectedExperience = { ...local.experience, ...remaining };
      const index = experiences.indexOf(currentExperience);
      if (index >= 0) experiences[index] = reflectedExperience;
      saveExperience(this, reflectedExperience, startedAt);
      journal.experienceId = reflectedExperience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), reflectedExperience.experienceId];
      if (realizedPnl) {
        try {
          const result = await reflectWithQwen(config, partialInput);
          const updated = { ...result.experience, ...remaining };
          saveExperience(this, updated, startedAt);
          if (index >= 0) experiences[index] = updated;
          const persistedPartialLesson = saveLesson(this, result.lesson);
          recordLessonApplication(this, cycleId, result.reflection.lessonEvaluations.filter((evaluation) => result.experience.lessonsUsed.includes(evaluation.lessonId)), new Date().toISOString());
          this.recordEvent("REFLECTION_COMPLETED", cycleId, { symbol: decision.symbol, action: decision.action });
          this.recordEvent("LESSON_CREATED", cycleId, { source: result.lesson.source, symbol: decision.symbol });
          journal.createdLessons = [...journal.createdLessons, persistedPartialLesson.lessonId];
          journal.exitReflections = [...(journal.exitReflections ?? []), result.reflection];
          journal.reflection = result.reflection;
          return { reflection: result.reflection, lesson: persistedPartialLesson };
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
      const persistedFailureLesson = saveLesson(this, failureResult.lesson);
      journal.experienceId = failureResult.experience.experienceId;
      journal.experienceIds = [...(journal.experienceIds ?? []), failureResult.experience.experienceId];
      journal.reflection = failureResult.reflection;
      journal.createdLessons = [...journal.createdLessons, persistedFailureLesson.lessonId];
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

  private recordPositionDiscrepancies(experiences: readonly TradeExperience[], positions: readonly PositionSnapshot[], cycleId: string, attributedLivePositionKeys: ReadonlyMap<string, ProviderLiveIdentity> = new Map()): string[] {
    // A provider lifecycle is owned by a local experience only when its deterministic provenance
    // matches. Symbol, side, and approximate time are not identity, so a stale DARWIN record that
    // happens to share symbol+side must never be allowed to claim a provider position.
    const resolvedFor = (position: PositionSnapshot): TradeExperience | undefined =>
      resolveLifecycleExperience(experiences, position, attributedLivePositionKeys.get(providerLivePositionLifecycleKey(position)));
    const local = experiences.filter((experience) => isDarwinOwnedExperience(experience));
    const localKeys = new Set(positions
      .filter((position) => isPositiveDecimal(position.quantity))
      .filter((position) => Boolean(resolvedFor(position)))
      .map((position) => `${position.symbol}:${position.positionSide}`));
    // A Darwin-owned record whose provider position is gone is still a real lifecycle gap.
    const matchedExperienceIds = new Set(positions
      .filter((position) => isPositiveDecimal(position.quantity))
      .map((position) => resolvedFor(position)?.experienceId)
      .filter((id): id is string => Boolean(id)));
    const providerKeys = new Set(positions.filter((position) => Number(position.quantity) > 0).map((position) => `${position.symbol}:${position.positionSide}`));
    const discrepancies: string[] = [];
    for (const experience of local) {
      const key = `${experience.symbol}:${experience.positionSide}`;
      if (providerKeys.has(key)) continue;
      if (matchedExperienceIds.has(experience.experienceId)) continue;
      const code = `PROVIDER_POSITION_MISSING:${key}`;
      discrepancies.push(code);
      this.recordEvent("POSITION_STATE_DISCREPANCY", cycleId, { code, symbol: experience.symbol, positionSide: experience.positionSide ?? "UNKNOWN", experienceId: experience.experienceId });
    }
    for (const position of positions.filter((candidate) => Number(candidate.quantity) > 0)) {
      const key = `${position.symbol}:${position.positionSide}`;
      const currentExperience = resolvedFor(position);
      if (currentExperience && !positionContextMatchesLifecycle(loadPositionContext(this, position.symbol, position.positionSide), currentExperience)) {
        const code = `POSITION_CONTEXT_IDENTITY_UNRESOLVED:${key}`;
        discrepancies.push(code);
        this.recordEvent("POSITION_CONTEXT_IDENTITY_UNRESOLVED", cycleId, {
          code,
          symbol: position.symbol,
          positionSide: position.positionSide,
          experienceId: currentExperience.experienceId,
          entryDecisionId: currentExperience.entryDecisionId,
          providerOrderId: currentExperience.providerOrderId ?? UNAVAILABLE_ATTRIBUTE,
        });
      }
      if (!localKeys.has(key)) {
        const code = `LOCAL_EXPERIENCE_MISSING:${key}`;
        discrepancies.push(code);
        // Deterministic provider identity (DARWIN order+fill origin joined to the clientOid
        // that issued them) proves a missing local experience is lost local state, not a
        // provider-external position. Only fall back to EXTERNAL_UNATTRIBUTED when no such
        // identity exists, so the audit trail never claims DARWIN positions are external.
        const identity = attributedLivePositionKeys.get(providerLivePositionLifecycleKey(position));
        this.recordEvent("POSITION_STATE_DISCREPANCY", cycleId, {
          code,
          symbol: position.symbol,
          positionSide: position.positionSide,
          experienceId: "NONE",
          classification: identity ? "LOCAL_LIFECYCLE_INCOMPLETE" : "EXTERNAL_UNATTRIBUTED",
          origin: identity ? "DARWIN" : "PROVIDER_ONLY",
          ...(identity ? { decisionId: identity.decisionId, providerOrderId: identity.providerOrderId } : {}),
        });
        // A DARWIN record for this symbol+side that does not match this provider lifecycle is
        // reported explicitly rather than being silently treated as resolved.
        const stale = local.filter((experience) => experience.symbol === position.symbol && experience.positionSide === position.positionSide);
        for (const experience of stale) {
          this.recordEvent("POSITION_IDENTITY_MISMATCH", cycleId, {
            symbol: position.symbol,
            positionSide: position.positionSide,
            experienceId: experience.experienceId,
            localEntryDecisionId: experience.entryDecisionId || UNAVAILABLE_ATTRIBUTE,
            localProviderOrderId: experience.providerOrderId ?? UNAVAILABLE_ATTRIBUTE,
            providerDecisionId: identity?.decisionId ?? UNAVAILABLE_ATTRIBUTE,
            providerOrderId: identity?.providerOrderId ?? UNAVAILABLE_ATTRIBUTE,
            reason: identity ? "PROVENANCE_DOES_NOT_MATCH_PROVIDER_IDENTITY" : "NO_DETERMINISTIC_PROVIDER_IDENTITY",
          });
        }
      }
    }
    return discrepancies;
  }

  private prepareDarwinLifecycleRepair(
    experiences: TradeExperience[],
    position: PositionSnapshot,
    identity: ProviderLiveIdentity,
    observedAt: string,
  ): DarwinLifecycleRepairPreparation {
    const experienceId = darwinLifecycleExperienceId(identity.decisionId);
    const current = resolveLifecycleExperience(experiences, position, identity);
    const storedById = current ?? loadExperienceById(this, experienceId);
    const existingContext = loadPositionContext(this, position.symbol, position.positionSide);
    const decision = persistedDarwinEntryDecision(this, identity.decisionId, position.symbol, position.positionSide);
    const entryThesis = decision?.thesis?.trim() || persistedEntryThesis(this, identity.decisionId, position.symbol, position.positionSide);
    const experience = storedById ?? repairedDarwinOpenExperience({
      identity,
      position,
      entryThesis,
      realizedPnl: providerFact(position.realizedPnl),
      realizedPnlPct: UNAVAILABLE_ATTRIBUTE,
    });
    const blocked = (
      eventType: "DARWIN_LIFECYCLE_REPAIR_INCOMPLETE" | "DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT",
      reason: string,
    ): DarwinLifecycleRepairPreparation => ({ status: "BLOCKED", eventType, reason, existingContext, experienceId: storedById?.experienceId ?? experienceId });
    const identityConflict = [
      ...experiences,
      ...(storedById && !experiences.some((candidate) => candidate.experienceId === storedById.experienceId) ? [storedById] : []),
    ].find((candidate) => candidate.symbol === position.symbol
      && candidate.positionSide === position.positionSide
      && conflictsProviderIdentity(candidate, identity));
    if (identityConflict) return blocked("DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT", "DETERMINISTIC_EXPERIENCE_IDENTITY_MISMATCH");
    if (storedById && (
      storedById.symbol !== position.symbol
      || storedById.positionSide !== position.positionSide
      || storedById.entryDecisionId !== identity.decisionId
      || (storedById.providerOrderId !== undefined && storedById.providerOrderId !== identity.providerOrderId)
      || (storedById.origin !== undefined && storedById.origin !== "DARWIN")
    )) return blocked("DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT", "DETERMINISTIC_EXPERIENCE_IDENTITY_MISMATCH");
    if (storedById && storedById.outcomeStatus !== "OPEN") return blocked("DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT", "DETERMINISTIC_EXPERIENCE_NOT_OPEN");
    const contextResult = repairedPositionContext(existingContext, decision, experience, observedAt);
    if (contextResult.status === "CONFLICT") return blocked("DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT", contextResult.reason);
    if (contextResult.status === "INCOMPLETE") return blocked("DARWIN_LIFECYCLE_REPAIR_INCOMPLETE", contextResult.reason);
    const experienceCreated = !storedById;
    const contextChanged = JSON.stringify(existingContext) !== JSON.stringify(contextResult.context);
    return {
      status: "READY",
      experience,
      context: contextResult.context,
      entryThesis,
      experienceCreated,
      contextChanged,
      eventId: darwinLifecycleRepairEventId(identity.decisionId),
    };
  }

  /**
   * Reconstruct a missing local OPEN lifecycle for a deterministically attributed DARWIN position
   * before decisions or risk checks run, so a proven DARWIN position is never treated as
   * lifecycle-unresolved while it waits for a REDUCE or CLOSE to trigger repair.
   *
   * This performs no financial action: it only reconstructs state the provider has already proven.
   */
  private repairMissingDarwinLifecycles(
    experiences: TradeExperience[],
    positions: readonly PositionSnapshot[],
    identities: ReadonlyMap<string, ProviderLiveIdentity>,
    cycleId: string,
    observedAt: string,
  ): TradeExperience[] {
    const repaired: TradeExperience[] = [];
    for (const position of positions.filter((candidate) => isPositiveDecimal(candidate.quantity))) {
      const identity = identities.get(providerLivePositionLifecycleKey(position));
      if (!identity) continue;
      const persisted = this.ctx.storage.transactionSync(() => {
        const preparation = this.prepareDarwinLifecycleRepair(experiences, position, identity, observedAt);
        if (preparation.status === "BLOCKED") {
          const diagnosticId = `${preparation.eventType.toLowerCase()}:${identity.decisionId}:${preparation.existingContext?.entryDecisionId ?? "NONE"}`;
          if (!hasEvent(this, diagnosticId)) {
            saveEvent(this, {
              eventId: diagnosticId,
              type: preparation.eventType,
              cycleId,
              createdAt: observedAt,
              metadata: {
                reason: preparation.reason,
                symbol: position.symbol,
                positionSide: position.positionSide,
                expectedEntryDecisionId: identity.decisionId,
                existingEntryDecisionId: preparation.existingContext?.entryDecisionId ?? UNAVAILABLE_ATTRIBUTE,
                providerOrderId: identity.providerOrderId,
                experienceId: preparation.experienceId,
              },
            });
          }
          return { status: "BLOCKED" as const };
        }
        const { experience, context, entryThesis, experienceCreated, contextChanged, eventId } = preparation;
        const repairNeeded = experienceCreated || contextChanged;
        if (experienceCreated) saveExperience(this, experience, observedAt);
        if (contextChanged) savePositionContext(this, context);
        if (repairNeeded && !hasEvent(this, eventId)) {
          saveEvent(this, {
            eventId,
            type: "DARWIN_LIFECYCLE_REPAIRED",
            cycleId,
            createdAt: observedAt,
            metadata: {
              reason: REPAIR_REASON,
              experienceId: experience.experienceId,
              symbol: position.symbol,
              positionSide: position.positionSide,
              origin: "DARWIN",
              entryDecisionId: identity.decisionId,
              lifecycleOpeningOrderId: identity.providerOrderId,
              entryTime: experience.entryTime,
              entryPrice: experience.entryPrice,
              entryThesisProvenance: entryThesis === UNAVAILABLE_ATTRIBUTE ? "UNAVAILABLE" : "PERSISTED_DARWIN_EVIDENCE",
              positionContextRepaired: String(contextChanged),
            },
          });
        }
        return { status: repairNeeded ? "REPAIRED" as const : "UNCHANGED" as const, experience };
      });
      if (persisted.status === "REPAIRED") {
        const existingIndex = experiences.findIndex((candidate) => candidate.experienceId === persisted.experience.experienceId);
        if (existingIndex === -1) experiences.push(persisted.experience);
        else experiences[existingIndex] = persisted.experience;
        repaired.push(persisted.experience);
      }
    }
    return repaired;
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

function persistedDarwinEntryDecision(executor: SqlExecutor, decisionId: string, symbol: string, positionSide: PositionSide): Decision | undefined {
  const expectedAction = positionSide === "LONG" ? "OPEN_LONG" : positionSide === "SHORT" ? "OPEN_SHORT" : null;
  if (!expectedAction) return undefined;
  const candidates = new Map<string, Decision>();
  for (const journal of loadJournalsForDecisionIds(executor, [decisionId], 100, "/api/runCycle")) {
    if (journal.mode !== "AUTONOMOUS") continue;
    for (const decision of cyclePlanDecisions(journal)) {
      if (decision.decisionId !== decisionId || decision.symbol !== symbol || decision.positionSide !== positionSide || decision.action !== expectedAction) continue;
      const key = `${decision.cycleId}:${decision.decisionId}`;
      const previous = candidates.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(decision)) return undefined;
      candidates.set(key, decision);
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : undefined;
}

function repairedPositionContext(
  existing: PositionContext | null,
  persistedDecision: Decision | undefined,
  experience: TradeExperience,
  observedAt: string,
): { status: "READY"; context: PositionContext } | { status: "CONFLICT"; reason: string } | { status: "INCOMPLETE"; reason: string } {
  if (!experience.positionSide) return { status: "INCOMPLETE", reason: "EXPERIENCE_POSITION_SIDE_MISSING" };
  const positionSide = experience.positionSide;
  if (existing && (existing.symbol !== experience.symbol || existing.positionSide !== positionSide)) {
    return { status: "CONFLICT", reason: "POSITION_CONTEXT_SYMBOL_SIDE_MISMATCH" };
  }
  if (existing && (!existing.entryDecisionId || existing.entryDecisionId !== experience.entryDecisionId)) {
    return { status: "CONFLICT", reason: existing.entryDecisionId ? "POSITION_CONTEXT_ENTRY_DECISION_MISMATCH" : "POSITION_CONTEXT_ENTRY_DECISION_MISSING" };
  }
  const expectedAction = positionSide === "LONG" ? "OPEN_LONG" : positionSide === "SHORT" ? "OPEN_SHORT" : null;
  const existingReasoning = existing?.entryReasoning;
  const existingReasoningValid = Boolean(existingReasoning && existingReasoning.decisionId === experience.entryDecisionId
    && existingReasoning.action === expectedAction
    && typeof existingReasoning.cycleId === "string" && existingReasoning.cycleId.trim().length > 0
    && typeof existingReasoning.thesis === "string" && existingReasoning.thesis.trim().length > 0);
  const persistedDecisionReasoningValid = Boolean(persistedDecision
    && typeof persistedDecision.cycleId === "string" && persistedDecision.cycleId.trim().length > 0
    && typeof persistedDecision.thesis === "string" && persistedDecision.thesis.trim().length > 0);
  if (!persistedDecisionReasoningValid && !existingReasoningValid) {
    return {
      status: "INCOMPLETE",
      reason: persistedDecision ? "PERSISTED_ENTRY_REASONING_UNAVAILABLE" : "PERSISTED_ENTRY_DECISION_UNAVAILABLE",
    };
  }
  const sourceReasoning = persistedDecisionReasoningValid ? entryReasoning(persistedDecision!) : existingReasoning!;
  const reasoning = {
    ...sourceReasoning,
    entryPrice: experience.entryPrice,
    entryTime: experience.entryTime,
    experienceId: experience.experienceId,
  };
  const context: PositionContext = existing ? { ...existing } : {
    symbol: experience.symbol,
    positionSide,
    experienceId: experience.experienceId,
    entryDecisionId: experience.entryDecisionId,
    entryReasoning: reasoning,
    managementEvents: [],
    lifecycleStatus: "OPEN",
    updatedAt: observedAt,
  };
  delete context.closedAt;
  delete context.closedProviderPositionHistoryId;
  const normalized: PositionContext = {
    ...context,
    symbol: experience.symbol,
    positionSide,
    experienceId: experience.experienceId,
    entryDecisionId: experience.entryDecisionId,
    entryReasoning: reasoning,
    lifecycleStatus: "OPEN",
    updatedAt: observedAt,
  };
  if (existing && JSON.stringify({ ...normalized, updatedAt: existing.updatedAt }) === JSON.stringify(existing)) normalized.updatedAt = existing.updatedAt;
  return { status: "READY", context: normalized };
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

/**
 * Recover the entry thesis for a deterministically attributed DARWIN lifecycle from evidence that
 * already exists (position context or a persisted experience), never invented. Returns the
 * repository's UNAVAILABLE convention when nothing can be recovered.
 */
function persistedEntryThesis(executor: SqlExecutor, decisionId: string, symbol: string, positionSide: PositionSide): string {
  for (const experience of loadAllExperiences(executor, "/api/runCycle", "lifecycle_repair_entry_thesis")) {
    if (experience.entryDecisionId === decisionId && experience.entryThesis.trim()) return experience.entryThesis;
  }
  const context = loadPositionContext(executor, symbol, positionSide);
  const thesis = context?.entryDecisionId === decisionId ? context.entryReasoning?.thesis : undefined;
  return thesis?.trim() ? thesis : UNAVAILABLE_ATTRIBUTE;
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

type ProviderLifecycleFillEvidenceRow = Pick<ProviderLifecycleFill, "fillId" | "providerOrderId" | "clientOid" | "symbol" | "side" | "positionSide" | "tradeSide" | "quantity" | "execPrice" | "execPnl" | "feeTotal" | "createdAt">;

function providerDecimalEvidenceMatches(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  try { return compareDecimal(left, right) === 0; } catch { return false; }
}

function providerLifecycleFillsMatch(directRows: readonly ProviderLifecycleFillEvidenceRow[], localRows: readonly ProviderLifecycleFillEvidenceRow[]): boolean {
  const sortRows = (rows: readonly ProviderLifecycleFillEvidenceRow[]) => [...rows].sort((left, right) => (left.fillId ?? "").localeCompare(right.fillId ?? ""));
  const direct = sortRows(directRows);
  const local = sortRows(localRows);
  if (direct.length === 0 || direct.length !== local.length) return false;
  return direct.every((fill, index) => {
    const other = local[index]!;
    const samePosition = fill.positionSide?.toUpperCase() === other.positionSide?.toUpperCase();
    const directLifecycleSide = resolveProviderLifecycleSide(fill.side, fill.positionSide, fill.tradeSide);
    const localLifecycleSide = resolveProviderLifecycleSide(other.side, other.positionSide, other.tradeSide);
    return fill.fillId === other.fillId && fill.providerOrderId === other.providerOrderId && fill.clientOid === other.clientOid
      && fill.symbol === other.symbol && fill.side?.toLowerCase() === other.side?.toLowerCase() && samePosition
      && directLifecycleSide === localLifecycleSide && directLifecycleSide !== "CONTRADICTORY" && directLifecycleSide !== "UNRESOLVED"
      && fill.createdAt === other.createdAt
      && providerDecimalEvidenceMatches(fill.quantity, other.quantity) && providerDecimalEvidenceMatches(fill.execPrice, other.execPrice)
      && providerDecimalEvidenceMatches(fill.execPnl, other.execPnl) && providerDecimalEvidenceMatches(fill.feeTotal, other.feeTotal);
  });
}

function isTimestampWithin(timestamp: string, startMs: number, endMs: number): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && Number.isFinite(startMs) && Number.isFinite(endMs) && value >= startMs && value <= endMs;
}

function isNearTimestamp(left: string, right: string, toleranceMs = 5_000): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) <= toleranceMs;
}

function providerLifecycleHistoryMatches(left: ProviderLifecycleHistory, right: ProviderLifecycleHistory): boolean {
  if (left.providerPositionHistoryId !== right.providerPositionHistoryId || left.symbol !== right.symbol
    || left.positionSide !== right.positionSide || left.openingTime !== right.openingTime || left.closingTime !== right.closingTime) return false;
  const decimalKeys = ["openTotalPos", "closeTotalPos", "avgEntryPrice", "avgExitPrice", "cumRealisedPnl", "netProfit", "openFeeTotal", "closeFeeTotal", "totalFunding", "cashDividend"] as const;
  return decimalKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    if (a === null || b === null) return a === b;
    try { return compareDecimal(a, b) === 0; } catch { return false; }
  });
}

function providerReadFailureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "details" in error) {
    const classification = (error as { details?: { classification?: unknown } }).details?.classification;
    if (typeof classification === "string" && /^[A-Z0-9_-]{1,80}$/.test(classification)) return classification;
  }
  return "PROVIDER_READ_FAILED";
}

function isControlBody(value: unknown): value is { action: "START" | "PAUSE" | "RESUME" | "EMERGENCY_STOP" } | { action: "REBASELINE_LEGACY_EXECUTION_QUARANTINE"; quarantines: LegacyQuarantineIdentity[] } | { action: "START_PAPER_LOG_COLLECTION_EPOCH"; archiveManifestSha256: string; archiveContentSha256: string; quarantineContentSha256: string; archivedCounts: Record<PaperLogArchiveTable, number>; highWaterRowIds: Record<PaperLogArchiveTable, number> } | { action: "DRY_RUN_EXECUTION_QUARANTINE_RECOVERY"; cycleId: string; decisionId: string; evidenceThrough?: string } | { action: "RECONCILE_LATE_EXECUTION"; cycleId: string; decisionId: string; evidenceHash: string; evidenceThrough: string } | { action: "RECOVER_QUARANTINED_CLOSED_EXECUTION"; cycleId: string; decisionId: string; evidenceHash: string; evidenceThrough: string } | { action: "REPAIR_PROVIDER_CLOSED_LIFECYCLE"; experienceId: string; providerPositionHistoryId: string; dryRun?: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as { action?: unknown; cycleId?: unknown; decisionId?: unknown; experienceId?: unknown; providerPositionHistoryId?: unknown; dryRun?: unknown; evidenceHash?: unknown; evidenceThrough?: unknown; archiveManifestSha256?: unknown; archiveContentSha256?: unknown; quarantineContentSha256?: unknown; archivedCounts?: unknown; highWaterRowIds?: unknown; quarantines?: unknown };
  const archiveTables: PaperLogArchiveTable[] = ["journals", "cycles", "experiences", "events"];
  const validCountMap = (candidate: unknown): candidate is Record<PaperLogArchiveTable, number> => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    && archiveTables.every((table) => Number.isSafeInteger((candidate as Record<string, unknown>)[table]) && Number((candidate as Record<string, unknown>)[table]) >= 0);
  if (body.action === "START_PAPER_LOG_COLLECTION_EPOCH") return typeof body.archiveManifestSha256 === "string" && /^[a-f0-9]{64}$/.test(body.archiveManifestSha256)
    && typeof body.archiveContentSha256 === "string" && /^[a-f0-9]{64}$/.test(body.archiveContentSha256)
    && typeof body.quarantineContentSha256 === "string" && /^[a-f0-9]{64}$/.test(body.quarantineContentSha256)
    && validCountMap(body.archivedCounts) && validCountMap(body.highWaterRowIds);
  if (body.action === "REBASELINE_LEGACY_EXECUTION_QUARANTINE") {
    // The owner must name exact identities. An empty or absent list must never be interpreted as
    // "archive everything currently quarantined".
    if (!Array.isArray(body.quarantines) || body.quarantines.length === 0 || body.quarantines.length > 20) return false;
    return Object.keys(body).every((key) => key === "action" || key === "quarantines")
      && body.quarantines.every((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
        const candidate = entry as Record<string, unknown>;
        return typeof candidate.symbol === "string" && /^[A-Z0-9]{2,16}USDT$/.test(candidate.symbol)
          && typeof candidate.cycleId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(candidate.cycleId)
          && typeof candidate.decisionId === "string" && /^[A-Za-z0-9:-]{1,128}$/.test(candidate.decisionId)
          && typeof candidate.clientOrderId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(candidate.clientOrderId);
      });
  }
  if (body.action === "REPAIR_PROVIDER_CLOSED_LIFECYCLE") return typeof body.experienceId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(body.experienceId) && typeof body.providerPositionHistoryId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(body.providerPositionHistoryId) && (body.dryRun === undefined || typeof body.dryRun === "boolean");
  const validDecisionIdentity = typeof body.cycleId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(body.cycleId)
    && typeof body.decisionId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(body.decisionId);
  if (body.action === "DRY_RUN_EXECUTION_QUARANTINE_RECOVERY") return validDecisionIdentity
    && (body.evidenceThrough === undefined || (typeof body.evidenceThrough === "string" && Number.isFinite(Date.parse(body.evidenceThrough))));
  if (body.action === "RECONCILE_LATE_EXECUTION" || body.action === "RECOVER_QUARANTINED_CLOSED_EXECUTION") return validDecisionIdentity
    && typeof body.evidenceHash === "string" && /^[a-f0-9]{64}$/.test(body.evidenceHash)
    && typeof body.evidenceThrough === "string" && Number.isFinite(Date.parse(body.evidenceThrough));
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
