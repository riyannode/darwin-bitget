import { Agent } from "agents";
import { ZodError } from "zod";
import type { CycleDecisionPlan, CycleDiscovery, DashboardSnapshot, Decision, DecisionExecutionRecord, Env, EvidenceBundle, LatestValidCyclePlan, Lesson, NormalizedCycleDecisions, OwnerPolicy, PositionContext, PositionSnapshot, ReflectionResult, RuntimeConfig, TradeExperience, TradeLifecycleStatus, TradingJournal } from "../types.js";
import { loadConfig } from "../config.js";
import { BitgetClient } from "../bitget/client.js";
import { MANDATE_VERSION, TRADING_MANDATE } from "./mandate.js";
import { assertOpenPositionCountWithinPlanLimit, decide, rankMarketCandidates, selectCandidates } from "./decision.js";
import { reconcileTradingSchedule, temporaryScanIntervalActive, TEMPORARY_SCAN_INTERVAL_DURATION_MS, TEMPORARY_SCAN_INTERVAL_MINUTES, type SchedulerReconciliationResult } from "./scheduler.js";
import { authorizeOwner } from "./owner-auth.js";
import { retrieveLessons } from "../learning/lesson-retrieval.js";
import { reflect, reflectWithQwen } from "../learning/reflection.js";
import { createBacktestLesson, runCooldownBacktest } from "../learning/backtest.js";
import { ensureStorage } from "../storage/schema.js";
import {
  loadLatestBacktest,
  loadLatestJournal,
  loadAllAutonomousJournals,
  loadAllEvents,
  loadAllExperiences,
  loadAllStoredCycles,
  loadRecentStoredCycles,
  loadRecentJournals,
  loadRecentEvents,
  loadRecentLessons,
  loadOpenExperiences,
  loadJournalsForDecisionIds,
  loadUsableLessons,
  loadPerformanceAggregate,
  savePerformanceAggregate,
  loadLatestValidCyclePlan,
  loadLatestCompletedCyclePlanFromHistory,
  saveLatestValidCyclePlan,
  loadPositionContext,
  savePositionContext,
  loadPositionContextBootstrap,
  savePositionContextBootstrap,
  loadDailyDrawdownState,
  loadExperiences,
  loadActiveOwnerPolicy,
  clampHistoryLimit,
  recordIdempotency,
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
} from "../storage/store.js";
import { buildPaperLogExport, parsePaperLogPeriod, paperLogToCsv } from "../storage/paper-log.js";
import { cyclePlanDecisions, cycleReadModel, normalizeCycleDecisions } from "../storage/journal-normalizer.js";
import { evaluateRiskGate } from "../trading/risk-gate.js";
import { evaluateDrawdown } from "../trading/drawdown.js";
import { loadOwnerPolicy, updateOwnerPolicy } from "../trading/policy.js";
import { buildExecutionRequest, executePaperOrder } from "../trading/execution.js";
import { executeCyclePlan } from "../trading/execution-planner.js";
import { reconcileExecution } from "../trading/reconcile.js";
import { addDecimal, isDecimal } from "../trading/decimal.js";
import { bootstrapPerformance, currentMonthDailyPnl, emptyPerformance, isPerformanceAggregate, performanceTotalPnl, POSITION_CONTEXT_READ_MODEL_VERSION, recordVerifiedClose, recordVerifiedOpen, updateEquity, verifiedLifecycleFacts, type PerformanceAggregate } from "../trading/performance.js";
import { bootstrapPositionContexts, decisionReasoning, upsertPositionContext } from "./position-context.js";
import { EvaClient } from "../eva/client.js";
import { EVA_AGENT_NAME, EVA_CAPABILITIES, EVA_EXECUTION_PROVIDERS, EVA_PROTOCOL_VERSION } from "../eva/types.js";
import { availableResearchCapabilities } from "../research/capabilities.js";
import { ResearchExecutor } from "../research/executor.js";
import { ResearchRouter, validateResearchPlan, type ResearchRouterInput } from "../research/router.js";
import { buildExecutionCapacityHints } from "../trading/execution-capacity.js";


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
const USER_STORAGE_VERSION = 5;
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
  return { category: "RUNTIME_ERROR", code, message: safeDiagnosticMessage(detail, "Runtime error") };
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
  };
}

function tradeLifecycleStatus(experience: TradeExperience): TradeLifecycleStatus {
  if (experience.outcomeStatus === "OPEN") return experience.lastAction === "REDUCE" ? "PARTIALLY_REDUCED" : "OPEN";
  if (experience.outcomeStatus === "PROFITABLE" || experience.outcomeStatus === "LOSING" || experience.outcomeStatus === "BREAK_EVEN" || experience.outcomeStatus === "CLOSED_UNCLASSIFIED") return "CLOSED";
  if (experience.outcomeStatus === "BLOCKED") return "BLOCKED";
  return "EXECUTION_FAILURE";
}

function tradeLogEntries(experiences: readonly TradeExperience[], journals: readonly TradingJournal[], contexts: ReadonlyMap<string, PositionContext> = new Map()): DashboardSnapshot["trades"] {
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
    return {
      tradeId: experience.experienceId,
      timestamp: experience.entryTime,
      symbol: experience.symbol,
      action,
      marginAllocationPct: experience.marginAllocationPct,
      marginAllocated: experience.marginAllocated,
      leverage: experience.selectedLeverage,
      positionNotional: experience.positionNotional,
      entry: experience.entryPrice,
      exit: experience.exitPrice,
      realizedPnl: experience.realizedPnl,
      status: tradeLifecycleStatus(experience),
      thesis: experience.entryThesis,
      orderReference: record?.executionResult?.providerOrderId ?? record?.executionResult?.clientOrderId ?? journal?.executionResult?.providerOrderId ?? journal?.executionResult?.clientOrderId ?? "—",
      positionSide: experience.positionSide,
      openedAt: experience.entryTime,
      ...(experience.exitTime ? { closedAt: experience.exitTime } : {}),
      ...(entryReasoning ? { entryReasoning } : {}),
      ...(exitReasoning ? { exitReasoning } : {}),
      ...(managementEvents.length ? { managementEvents } : {}),
    };
  });
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
  return { totalPnl: "UNAVAILABLE", winRate: "UNAVAILABLE", dailyDrawdown: "UNAVAILABLE", totalTrades: null, openTrades: null, closedTrades: null, wins: null, losses: null, breakeven: null, verifiedRealizedPnl: "", competitionBaselineEquity: null, latestEquity: null, performanceBaselineAt: null, dailyPnl: {} };
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

export class TraderAgent extends Agent<Env, AgentState> {
  private readonly researchRouter = new ResearchRouter();
  private readonly researchExecutor = new ResearchExecutor();

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
    const needsLatestValidPlanMigration = (this.state.userStorageVersion ?? 0) < USER_STORAGE_VERSION;
    if (needsLatestValidPlanMigration) {
      ensureStorage(this);
      this.setState({ ...this.state, userStorageVersion: USER_STORAGE_VERSION, temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: false, temporaryScanIntervalDurationMs: 0 });
    }
    this.ensureReadModels(needsLatestValidPlanMigration);
    const policy = this.ensureActivePolicy();
    const config = loadConfig(this.env, policy);
    const activeCycle = this.state.lastStatus === "RUNNING";
    this.setState({ ...this.state, emergencyStop: policy.emergencyStop, model: config.qwenModel, runtimeStatus: activeCycle ? this.state.runtimeStatus : this.state.paused || policy.emergencyStop ? "PAUSED" : "ONLINE", currentStage: activeCycle ? this.state.currentStage : this.state.paused || policy.emergencyStop ? "PAUSED" : "ONLINE" });
    if (!this.state.paused && !policy.emergencyStop) await this.reconcileScheduler(this.activeScanIntervalMinutes(policy), { ensureSchedule: true });
  }

  public override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot" && request.method === "GET") return json(await this.getDashboardSnapshot());
    if (url.pathname === "/position-context" && request.method === "GET") return this.getPositionContext(url);
    if (url.pathname === "/agent-journal" && request.method === "GET") return this.getAgentJournal(url);
    if (url.pathname === "/trade-history" && request.method === "GET") return this.getTradeHistory(url);
    if (url.pathname === "/learning" && request.method === "GET") return this.getLearning(url);
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
      await this.reconcileScheduler(intervalMinutes, { ensureSchedule: true });
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
      if (format === "csv") return new Response(paperLogToCsv(exported), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=darwin-paper-log.csv", "cache-control": "no-store" } });
      return new Response(JSON.stringify(exported), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": "attachment; filename=darwin-paper-log.json", "cache-control": "no-store" } });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message.split(":", 1)[0] ?? "PAPER_LOG_EXPORT_FAILED" : "PAPER_LOG_EXPORT_FAILED" }, 400);
    }
  }

  private ensureTemporaryScanTest(): void {
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
      this.recordEvent("TEMPORARY_SCAN_INTERVAL_EXPIRED", "CONTROL", { restoredIntervalMinutes: "15" });
      return;
    }
    const nextExpiresAt = new Date(Date.now() + TEMPORARY_SCAN_INTERVAL_DURATION_MS).toISOString();
    this.setState({ ...this.state, temporaryScanIntervalExpiresAt: nextExpiresAt, temporaryScanIntervalCompleted: false, temporaryScanIntervalDurationMs: TEMPORARY_SCAN_INTERVAL_DURATION_MS });
    this.recordEvent("TEMPORARY_SCAN_INTERVAL_ACTIVATED", "CONTROL", { intervalMinutes: String(TEMPORARY_SCAN_INTERVAL_MINUTES), durationHours: "2", expiresAt: nextExpiresAt });
  }

  private activeScanIntervalMinutes(policy: OwnerPolicy): number {
    this.ensureTemporaryScanTest();
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
    if (isPerformanceAggregate(performance) && positionContextBootstrapped?.version === POSITION_CONTEXT_READ_MODEL_VERSION) return;
    const history = this.readBootstrapHistory();
    if (!isPerformanceAggregate(performance)) savePerformanceAggregate(this, bootstrapPerformance(history.journals, history.experiences, initializedAt), initializedAt);
    if (positionContextBootstrapped?.version !== POSITION_CONTEXT_READ_MODEL_VERSION) {
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

  private updatePerformanceReadModel(record: DecisionExecutionRecord, bundle: EvidenceBundle, verified: boolean): void {
    if (!verified || !record.executionResult) return;
    const observedAt = record.executionResult.readBackAt;
    const equity = record.accountAfter?.portfolioEquity ?? bundle.account.portfolioEquity;
    let performance = this.performanceWithEquity(equity, observedAt);
    if (record.decision.action === "OPEN_LONG" || record.decision.action === "OPEN_SHORT") performance = recordVerifiedOpen(performance, equity, observedAt);
    if (record.decision.action === "CLOSE") performance = recordVerifiedClose(performance, record.executionResult.realizedPnl, equity, observedAt);
    savePerformanceAggregate(this, performance, observedAt);
  }

  private persistPerformanceEquity(equity: string, observedAt: string): void {
    savePerformanceAggregate(this, this.performanceWithEquity(equity, observedAt), observedAt);
  }

  private performanceWithEquity(equity: string, observedAt: string): PerformanceAggregate {
    let performance = loadPerformanceAggregate<PerformanceAggregate>(this);
    if (!isPerformanceAggregate(performance)) performance = emptyPerformance(observedAt);
    if (!performance.competitionBaselineEquity && isDecimal(equity) && Number(equity) > 0) performance = { ...performance, competitionBaselineEquity: equity, latestEquity: equity, performanceBaselineAt: observedAt };
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

  public async getDashboardSnapshot(): Promise<DashboardSnapshot> {
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
    const performance = isPerformanceAggregate(persistedPerformance) ? {
      totalPnl: performanceTotalPnl(persistedPerformance),
      winRate: persistedPerformance.winRate,
      dailyDrawdown: drawdownPct,
      totalTrades: persistedPerformance.totalTrades,
      openTrades: persistedPerformance.openTrades,
      closedTrades: persistedPerformance.closedTrades,
      wins: persistedPerformance.wins,
      losses: persistedPerformance.losses,
      breakeven: persistedPerformance.breakeven,
      verifiedRealizedPnl: persistedPerformance.verifiedRealizedPnl,
      competitionBaselineEquity: persistedPerformance.competitionBaselineEquity,
      latestEquity: persistedPerformance.latestEquity,
      performanceBaselineAt: persistedPerformance.performanceBaselineAt,
      dailyPnl: currentMonthDailyPnl(persistedPerformance),
    } : { ...unavailablePerformance(), dailyDrawdown: drawdownPct };
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
      portfolio: null,
      portfolioFreshness: { source: "UNAVAILABLE", observedAt: new Date().toISOString(), stale: true, errorCode: "LIVE_PORTFOLIO_REQUIRED" },
      performance,
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
      scheduler: { ...schedulerMetrics(events), ...scheduler },
    };
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

  private async reconcileScheduler(intervalMinutes: number, options: { ensureSchedule?: boolean; now?: number } = {}): Promise<SchedulerReconciliationResult> {
    const result = await reconcileTradingSchedule(this, intervalMinutes, {
      paused: this.state.paused,
      emergencyStop: this.state.emergencyStop,
      activeCycle: this.state.lastStatus === "RUNNING" || Boolean(this.state.cycleStartedAt),
      nextScanAt: this.state.nextScanAt,
    }, options);
    if (result.matchingSchedules.length === 1 && result.nextScanAt !== this.state.nextScanAt) this.setState({ ...this.state, nextScanAt: result.nextScanAt });
    return result;
  }

  private getAgentJournal(url: URL): Response {
    const limit = clampHistoryLimit(Number(url.searchParams.get("limit") ?? "25"));
    const journals = loadRecentJournals(this, limit);
    const storedCycles = loadRecentStoredCycles(this, limit);
    const events = loadRecentEvents(this, limit);
    const cycles = journals.map((entry) => cycleReadModelWithStatus(entry, storedCycles, events));
    return json({ journals, cycles, latestValidCyclePlan: loadLatestValidCyclePlan(this), decisions: journals.flatMap((entry) => cyclePlanDecisions(entry)), limit });
  }

  private getPositionContext(url: URL): Response {
    const symbol = url.searchParams.get("symbol")?.trim() ?? "";
    const positionSide = url.searchParams.get("positionSide");
    if (!/^[A-Z0-9_-]{1,40}$/.test(symbol) || (positionSide !== "LONG" && positionSide !== "SHORT")) return json({ error: "INVALID_POSITION_CONTEXT_KEY" }, 400);
    return json({ source: "DARWIN_PERSISTED", context: loadPositionContext(this, symbol, positionSide) });
  }

  private getTradeHistory(url: URL): Response {
    const limit = clampHistoryLimit(Number(url.searchParams.get("limit") ?? "25"));
    const experiences = loadExperiences(this, limit);
    const journals = loadRecentJournals(this, limit);
    const contexts = new Map<string, PositionContext>();
    for (const experience of experiences) {
      if (!experience.positionSide) continue;
      const context = loadPositionContext(this, experience.symbol, experience.positionSide);
      if (context) contexts.set(`${experience.symbol}:${experience.positionSide}`, context);
    }
    const trades = tradeLogEntries(experiences, journals, contexts);
    return json({ trades, limit });
  }

  private getLearning(url: URL): Response {
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
    this.recordEvent("CYCLE_STARTED", cycleId);
    try {
      const client = new BitgetClient(config);
      const openPositionSymbols = await client.getOpenPositionSymbols();
      const instruments = await client.getTradableInstruments().catch(() => {
        this.recordEvent("DEMO_UNIVERSE_UNAVAILABLE", cycleId);
        return [];
      });
      if (instruments.length === 0 && openPositionSymbols.length === 0) throw new Error("NO_TRADABLE_INSTRUMENTS");
      const supportedUniverse = instruments.map((instrument) => instrument.symbol);
      const allLessons = loadUsableLessons(this);
      const experiences = loadExperiences(this);
      const scan = await client.collectLightweightScan(instruments);
      const rankedScan = rankMarketCandidates(scan);
      this.recordEvent("MARKET_SCAN", cycleId, { symbols: String(scan.length), preRanked: String(rankedScan.length) });
      this.setState({ ...this.state, runtimeStatus: "ANALYZING", currentStage: "ANALYZING" });
      const selectedEntryCandidateSymbols = rankedScan.length ? await selectCandidates(config, supportedUniverse, rankedScan) : [];
      const evidenceSymbols = [...new Set([...openPositionSymbols, ...selectedEntryCandidateSymbols])];
      this.recordEvent("CANDIDATE_SELECTED", cycleId, { symbols: selectedEntryCandidateSymbols.join(",") });
      const bundles = await client.collectEvidence(evidenceSymbols);
      const lessons = bundles.flatMap((bundle) => retrieveLessons(allLessons, { symbol: bundle.instrument.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN" }, 3))
        .filter((lesson, index, list) => list.findIndex((candidate) => candidate.lessonId === lesson.lessonId) === index)
        .slice(0, 5);
      const account = bundles[0]?.account ?? await client.getDashboardPortfolio();
      const openPositions = [...new Map((bundles.flatMap((bundle) => bundle.account.positions).length ? bundles.flatMap((bundle) => bundle.account.positions) : account.positions).map((position) => [`${position.symbol}:${position.positionSide}`, position])).values()];
      const discovery: CycleDiscovery = { scannedUniverseCount: scan.length, selectedEntryCandidateSymbols, managedExistingPositionSymbols: openPositions.filter((position) => Number(position.quantity) > 0).map((position) => position.symbol).sort(), financialWritesPerformed: 0 };
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
      const backtest = drawdown.blocked ? await runCooldownBacktest(config, { symbol: backtestSymbol, bars: await client.getHistoricalBars(backtestSymbol), experiences: experiences.filter((experience) => experience.outcomeStatus !== "EXECUTION_FAILURE"), trigger: drawdown.code }) : undefined;
      if (backtest) { saveBacktest(this, backtest); journal.backtest = backtest; this.recordEvent("BACKTEST_COMPLETED", cycleId); }
      const openExperiences = experiences.filter((experience) => experience.outcomeStatus === "OPEN");
      const executionCapacityHints = buildExecutionCapacityHints(bundles, config.ownerPolicy.maxLeverage);
      const researchEvidence = await this.collectResearchEvidence(config, bundles, openPositionSymbols, selectedEntryCandidateSymbols);
      const context = { bundles, supportedUniverse, openPositionSymbols, entryCandidateSymbols: selectedEntryCandidateSymbols, experiences, openExperiences, lessons, openPositions, observedAt: new Date().toISOString(), mandate: TRADING_MANDATE, researchEvidence, executionCapacityHints };
      const decisionSet = await decide(config, context, cycleId);
      if (decisionSet.ignoredLessonIds.length) this.recordEvent("LESSON_REFERENCE_IGNORED", cycleId, { count: String(decisionSet.ignoredLessonIds.length), ids: decisionSet.ignoredLessonIds.slice(0, 8).join(",") });
      journal.marketContext = { scan, deep: bundles.map((candidate) => ({ market: candidate.market, regime: candidate.marketRegime })) };
      journal.portfolio = account;
      journal.evidence = bundles.flatMap((candidate) => candidate.evidence);
      journal.retrievedLessons = lessons.map((lesson) => lesson.lessonId);
      const plan: CycleDecisionPlan = decisionSet.plan;
      journal.cyclePlan = plan;
      const execution = await executeCyclePlan(plan, {
        refreshEvidence: async (symbol) => (await client.collectEvidence([symbol]))[0],
        execute: async (action, actionBundle, decisionType, parentDecision) => {
          this.setState({ ...this.state, runtimeStatus: "RISK_CHECK", currentStage: "RISK_CHECK" });
          return this.executeDecision(client, config, action, actionBundle, cycleId, supportedUniverse, drawdown.blocked, startedAt, decisionType, parentDecision);
        },
        persist: async (record, actionBundle) => {
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
      this.recordEvent("CYCLE_FAILED", cycleId, { ...diagnostic, durationMs: String(journal.durationMs) });
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
  ) {
    if (!config.bitgetSignalEnabled) return [];
    const availableResearchSkills = availableResearchCapabilities();
    if (availableResearchSkills.length === 0) return [];
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
    try {
      const plan = await this.researchRouter.plan(config, routerInput);
      const validation = validateResearchPlan(plan, routerInput);
      return await this.researchExecutor.execute(validation.accepted);
    } catch {
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
  ): Promise<DecisionExecutionRecord> {
    const riskGateResult = evaluateRiskGate(config, { decision, instrument: bundle.instrument, account: bundle.account, market: bundle.market, evidenceObservedAt: bundle.market.observedAt, openOrderSymbols: bundle.account.openOrderSymbols, supportedUniverse, emergencyStop: this.state.emergencyStop || config.ownerPolicy.emergencyStop, dailyDrawdownBlocked });
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
    this.updatePerformanceReadModel(record, bundle, verified);
    const currentExperience = experiences.find((experience) => experience.outcomeStatus === "OPEN" && experience.symbol === decision.symbol && experience.positionSide === decision.positionSide);
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
    const cumulativePnl = realizedPnl && isDecimal(currentExperience.realizedPnl) ? addDecimal(currentExperience.realizedPnl, realizedPnl) : currentExperience.realizedPnl;
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

function calculateDrawdownPct(baseline: string, current: string): string {
  const base = Number(baseline);
  const equity = Number(current);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(equity)) return "0";
  return (((equity - base) / base) * 100).toFixed(2);
}

function isControlBody(value: unknown): value is { action: "START" | "PAUSE" | "RESUME" | "EMERGENCY_STOP" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const action = (value as { action?: unknown }).action;
  return action === "START" || action === "PAUSE" || action === "RESUME" || action === "EMERGENCY_STOP";
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
