import { Agent } from "agents";
import type { DashboardSnapshot, Decision, DecisionExecutionRecord, Env, EvidenceBundle, Lesson, OwnerPolicy, PositionSnapshot, ReflectionResult, RuntimeConfig, TradeExperience, TradeLifecycleStatus, TradingJournal } from "../types.js";
import { loadConfig } from "../config.js";
import { BitgetClient } from "../bitget/client.js";
import { MANDATE_VERSION, TRADING_MANDATE } from "./mandate.js";
import { boundExitDecisions, decide, rankMarketCandidates, selectCandidates } from "./decision.js";
import { scheduleTradingCycle, temporaryScanIntervalActive, TEMPORARY_SCAN_INTERVAL_DURATION_MS, TEMPORARY_SCAN_INTERVAL_MINUTES } from "./scheduler.js";
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
  loadRecentJournals,
  loadRecentEvents,
  loadRecentLessons,
  loadUsableLessons,
  loadDailyDrawdownState,
  loadExperiences,
  loadActiveOwnerPolicy,
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
import { evaluateRiskGate } from "../trading/risk-gate.js";
import { evaluateDrawdown } from "../trading/drawdown.js";
import { loadOwnerPolicy, updateOwnerPolicy } from "../trading/policy.js";
import { buildExecutionRequest, executePaperOrder } from "../trading/execution.js";
import { reconcileExecution } from "../trading/reconcile.js";
import { addDecimal, isDecimal } from "../trading/decimal.js";
import { EvaClient } from "../eva/client.js";
import { EVA_AGENT_NAME, EVA_CAPABILITIES, EVA_EXECUTION_PROVIDERS, EVA_PROTOCOL_VERSION } from "../eva/types.js";

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
}

const STALE_CYCLE_TIMEOUT_MS = 120_000;

function failureCode(codes: string[]): string {
  return codes.join(",") || "";
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
  };
}

function tradeLifecycleStatus(experience: TradeExperience): TradeLifecycleStatus {
  if (experience.outcomeStatus === "OPEN") return experience.lastAction === "REDUCE" ? "PARTIALLY_REDUCED" : "OPEN";
  if (experience.outcomeStatus === "PROFITABLE" || experience.outcomeStatus === "LOSING" || experience.outcomeStatus === "BREAK_EVEN") return "CLOSED";
  if (experience.outcomeStatus === "BLOCKED") return "BLOCKED";
  return "EXECUTION_FAILURE";
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export class TraderAgent extends Agent<Env, AgentState> {
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
  };

  public override async onStart(): Promise<void> {
    ensureStorage(this);
    this.ensureTemporaryScanTest();
    const policy = this.ensureActivePolicy();
    const config = loadConfig(this.env, policy);
    const activeCycle = this.state.lastStatus === "RUNNING";
    this.setState({ ...this.state, emergencyStop: policy.emergencyStop, model: config.qwenModel, runtimeStatus: activeCycle ? this.state.runtimeStatus : this.state.paused || policy.emergencyStop ? "PAUSED" : "ONLINE", currentStage: activeCycle ? this.state.currentStage : this.state.paused || policy.emergencyStop ? "PAUSED" : "ONLINE" });
    if (!this.state.paused && !policy.emergencyStop) await scheduleTradingCycle(this, this.activeScanIntervalMinutes(policy));
  }

  public override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot" && request.method === "GET") return json(await this.getDashboardSnapshot());
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
    this.recordEvent("SCHEDULE_CALLBACK", "CONTROL");
    if (this.state.paused || this.state.emergencyStop) return;
    try {
      const policy = this.ensureActivePolicy();
      const config = loadConfig(this.env, policy);
      await this.ensureTradingSchedule(config);
      await this.runCycle();
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":", 1)[0] ?? "SCHEDULE_CALLBACK_FAILED" : "SCHEDULE_CALLBACK_FAILED";
      if (code === "CYCLE_IN_PROGRESS") this.recordEvent("CYCLE_IN_PROGRESS", this.state.lastCycleId ?? "UNKNOWN", { code });
      if (code.includes("TIMEOUT")) this.recordEvent("CYCLE_TIMEOUT", this.state.lastCycleId ?? "UNKNOWN", { code });
      this.recordEvent("SCHEDULE_CALLBACK_FAILED", "CONTROL", { code });
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
      await scheduleTradingCycle(this, intervalMinutes);
      this.setState({ ...this.state, nextScanAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString() });
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
      ensureStorage(this);
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

  public async getDashboardSnapshot(): Promise<DashboardSnapshot> {
    ensureStorage(this);
    const config = loadConfig(this.env, this.ensureActivePolicy());
    await this.ensureTradingSchedule(config);
    const journal = loadLatestJournal(this);
    const journals = loadRecentJournals(this);
    const experiences = loadExperiences(this);
    const drawdown = loadDailyDrawdownState(this);
    const trades = experiences.filter((experience) => experience.action !== "HOLD").map((experience) => {
      const journal = journals.find((entry) => entry.experienceId === experience.experienceId || entry.decision?.decisionId === experience.exitDecisionId || entry.decision?.decisionId === experience.entryDecisionId);
      const action = experience.lastAction && experience.lastAction !== "HOLD" ? experience.lastAction : experience.action;
      if (action === "HOLD") return null;
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
        orderReference: journal?.executionResult?.providerOrderId ?? journal?.executionResult?.clientOrderId ?? "—",
        positionSide: experience.positionSide,
        openedAt: experience.entryTime,
        ...(experience.exitTime ? { closedAt: experience.exitTime } : {}),
      };
    }).filter((trade): trade is NonNullable<typeof trade> => trade !== null).slice(0, 25);
    const closedExperiences = experiences.filter((experience) => experience.outcomeStatus === "PROFITABLE" || experience.outcomeStatus === "LOSING" || experience.outcomeStatus === "BREAK_EVEN");
    const totalTrades = closedExperiences.length;
    const wins = experiences.filter((experience) => experience.outcomeStatus === "PROFITABLE").length;
    const losses = experiences.filter((experience) => experience.outcomeStatus === "LOSING").length;
    const breakeven = experiences.filter((experience) => experience.outcomeStatus === "BREAK_EVEN").length;
    const totalPnl = closedExperiences.reduce((total, experience) => total + Number(experience.realizedPnl || 0), 0).toFixed(8);
    const drawdownPct = drawdown ? calculateDrawdownPct(drawdown.baselineEquity, drawdown.lastEquity) : "0";
    const dailyPnl = closedExperiences.reduce<Record<string, { pnl: string; trades: number }>>((summary, experience) => {
      const day = (experience.exitTime || experience.entryTime).slice(0, 10);
      const current = summary[day] ?? { pnl: "0", trades: 0 };
      summary[day] = { pnl: (Number(current.pnl) + Number(experience.realizedPnl || 0)).toFixed(8), trades: current.trades + 1 };
      return summary;
    }, {});
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
      portfolio: journal?.portfolio ?? null,
      performance: { totalPnl, winRate: totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : "0", dailyDrawdown: drawdownPct, totalTrades, wins, losses, breakeven, dailyPnl },
      trades,
      latestDecision: journal?.decision ?? null,
      decisions: journals.map((entry) => entry.decision).filter((decision): decision is Decision => Boolean(decision)).slice(0, 25),
      executionEvidence: journal?.executionResult && journal.reconciliationResult ? {
        provider: journal.executionResult.provider,
        action: journal.executionResult.action,
        symbol: journal.executionResult.symbol,
        marginAllocated: journal.executionResult.marginAllocated,
        leverage: journal.executionResult.leverage,
        positionNotional: journal.executionResult.positionNotional,
        orderReference: journal.executionResult.providerOrderId ?? journal.executionResult.clientOrderId,
        executionStatus: journal.executionResult.status,
        reconciliationStatus: journal.reconciliationResult.status,
        ...(journal.executionResult.providerCode ? { providerCode: journal.executionResult.providerCode } : {}),
        ...(journal.executionResult.providerMessage ? { providerMessage: journal.executionResult.providerMessage } : {}),
        ...(journal.executionResult.providerReadbackCode ? { providerReadbackCode: journal.executionResult.providerReadbackCode } : {}),
        ...(journal.executionResult.providerReadbackMessage ? { providerReadbackMessage: journal.executionResult.providerReadbackMessage } : {}),
        timestamp: journal.executionResult.readBackAt,
      } : null,
      learning: {
        reflection: journal?.reflection ?? null,
        lessons: loadRecentLessons(this, 8),
        lessonsUsed: journal?.decision?.lessonsUsed ?? [],
        backtest: loadLatestBacktest(this),
        recentExperiences: experiences.slice(0, 8),
      },
      riskControls: {
        ...config.ownerPolicy,
        scanIntervalMinutes: this.activeScanIntervalMinutes(config.ownerPolicy),
        temporaryScanIntervalExpiresAt: this.state.temporaryScanIntervalExpiresAt,
        drawdownBlocked: Boolean(drawdown?.cooldownUntil && new Date(drawdown.cooldownUntil).getTime() > Date.now()),
        drawdownCode: drawdown?.cooldownUntil ? "DRAWDOWN_COOLDOWN" : "NONE",
        cooldownUntil: drawdown?.cooldownUntil ?? null,
      },
      activity: loadRecentEvents(this),
      lastPolicyUpdate: loadRecentEvents(this, 50).find((event) => event.type === "POLICY_UPDATED") ?? null,
      scheduler: schedulerMetrics(loadRecentEvents(this, 200)),
    };
  }

  private async runCycle(): Promise<TradingJournal> {
    ensureStorage(this);
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
      const selectedSymbols = rankedScan.length ? await selectCandidates(config, supportedUniverse, rankedScan) : [];
      const candidateSymbols = [...new Set([...openPositionSymbols, ...selectedSymbols])];
      this.recordEvent("CANDIDATE_SELECTED", cycleId, { symbols: candidateSymbols.join(",") });
      const bundles = await client.collectEvidence(candidateSymbols);
      const lessons = bundles.flatMap((bundle) => retrieveLessons(allLessons, { symbol: bundle.instrument.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN" }, 3))
        .filter((lesson, index, list) => list.findIndex((candidate) => candidate.lessonId === lesson.lessonId) === index)
        .slice(0, 5);
      const account = bundles[0]?.account;
      if (!account) throw new Error("NO_ACCOUNT_EVIDENCE");
      const openPositions = [...new Map(bundles.flatMap((bundle) => bundle.account.positions).map((position) => [`${position.symbol}:${position.positionSide}`, position])).values()];
      journal.positionDiscrepancies = this.recordPositionDiscrepancies(experiences, openPositions, cycleId);
      recordLessonRetrieval(this, lessons.map((lesson) => lesson.lessonId), cycleId, startedAt);
      const drawdown = evaluateDrawdown(config.ownerPolicy, loadDailyDrawdownState(this), account.portfolioEquity, new Date());
      saveDailyDrawdownState(this, drawdown.state, new Date().toISOString());
      if (drawdown.blocked) {
        this.setState({ ...this.state, runtimeStatus: "COOLDOWN", currentStage: "COOLDOWN" });
        this.recordEvent("COOLDOWN_STARTED", cycleId, { code: drawdown.code });
      }
      const backtest = drawdown.blocked ? await runCooldownBacktest(config, { symbol: candidateSymbols[0] ?? supportedUniverse[0] ?? "", bars: await client.getHistoricalBars(candidateSymbols[0] ?? supportedUniverse[0] ?? ""), experiences: experiences.filter((experience) => experience.outcomeStatus !== "EXECUTION_FAILURE"), trigger: drawdown.code }) : undefined;
      if (backtest) { saveBacktest(this, backtest); journal.backtest = backtest; this.recordEvent("BACKTEST_COMPLETED", cycleId); }
      const openExperiences = experiences.filter((experience) => experience.outcomeStatus === "OPEN");
      const context = { bundles, supportedUniverse, experiences, openExperiences, lessons, openPositions, observedAt: new Date().toISOString(), mandate: TRADING_MANDATE };
      const decisionSet = await decide(config, context, cycleId);
      const decision = decisionSet.decision;
      if (decisionSet.ignoredLessonIds.length) this.recordEvent("LESSON_REFERENCE_IGNORED", cycleId, { count: String(decisionSet.ignoredLessonIds.length), ids: decisionSet.ignoredLessonIds.slice(0, 8).join(",") });
      const legacyExit = decision.action === "REDUCE" || decision.action === "CLOSE" ? [decision] : [];
      const proposedExits = [...legacyExit, ...decisionSet.exitDecisions.filter((exitDecision) => !legacyExit.some((legacy) => legacy.symbol === exitDecision.symbol && legacy.positionSide === exitDecision.positionSide))];
      const exitDecisions = boundExitDecisions(proposedExits, openPositions);
      for (const exitDecision of proposedExits.filter((candidate) => !exitDecisions.some((accepted) => accepted.decisionId === candidate.decisionId))) {
        this.recordEvent("EXIT_SKIPPED", cycleId, { code: "POSITION_NOT_OPEN", symbol: exitDecision.symbol, positionSide: exitDecision.positionSide ?? "UNKNOWN" });
      }
      const bundle = bundles.find((candidate) => candidate.instrument.symbol === decision.symbol) ?? bundles[0];
      if (!bundle) throw new Error("NO_EVIDENCE");
      this.setState({ ...this.state, runtimeStatus: "RISK_CHECK", currentStage: "RISK_CHECK" });
      journal.marketContext = { scan, deep: bundles.map((candidate) => ({ market: candidate.market, regime: candidate.marketRegime })) };
      journal.portfolio = account;
      journal.evidence = bundles.flatMap((candidate) => candidate.evidence);
      journal.retrievedLessons = lessons.map((lesson) => lesson.lessonId);
      journal.decision = decision;
      journal.exitDecisions = exitDecisions;
      if ((decision.action === "REDUCE" || decision.action === "CLOSE") && !exitDecisions.some((exitDecision) => exitDecision.decisionId === decision.decisionId)) {
        journal.riskGateResult = { status: "BLOCK", codes: ["INSUFFICIENT_POSITION"], checkedAt: new Date().toISOString() };
        this.recordEvent("DECISION_CREATED", cycleId, { action: decision.action, symbol: decision.symbol, decisionType: "EXIT" });
        this.recordEvent("RISK_GATE_BLOCK", cycleId, { codes: "INSUFFICIENT_POSITION", decisionType: "EXIT", symbol: decision.symbol });
      }
      const exitRecords: DecisionExecutionRecord[] = [];
      let exitWriteBlocked = false;
      for (const exitDecision of exitDecisions) {
        if (exitWriteBlocked) break;
        const exitBundle = (await client.collectEvidence([exitDecision.symbol]))[0];
        if (!exitBundle) {
          this.recordEvent("EXECUTION_UNRESOLVED", cycleId, { decisionType: "EXIT", symbol: exitDecision.symbol, codes: "EVIDENCE_READBACK_UNAVAILABLE" });
          exitWriteBlocked = true;
          break;
        }
        const exitRecord = await this.executeDecision(client, config, exitDecision, exitBundle, cycleId, supportedUniverse, drawdown.blocked, startedAt, "EXIT");
        exitRecords.push(exitRecord);
        await this.persistDecisionOutcome(config, exitRecord, exitBundle, experiences, lessons, cycleId, startedAt, journal, false);
        if (exitRecord.decision.decisionId === decision.decisionId) {
          journal.riskGateResult = exitRecord.riskGateResult;
          if (exitRecord.executionRequest) journal.executionRequest = exitRecord.executionRequest;
          if (exitRecord.executionResult) journal.executionResult = exitRecord.executionResult;
          if (exitRecord.reconciliationResult) journal.reconciliationResult = exitRecord.reconciliationResult;
          if (exitRecord.positionBefore) journal.positionBefore = exitRecord.positionBefore;
          if (exitRecord.positionAfter) journal.positionAfter = exitRecord.positionAfter;
          if (exitRecord.accountAfter) journal.portfolio = exitRecord.accountAfter;
        }
        if (exitRecord.reconciliationResult && exitRecord.reconciliationResult.status !== "MATCHED") exitWriteBlocked = true;
      }
      journal.exitExecutions = exitRecords;
      const refreshedBundles = exitDecisions.length && !exitWriteBlocked ? await client.collectEvidence([...new Set([...candidateSymbols, decision.symbol])]) : bundles;
      const refreshedBundle = refreshedBundles.find((candidate) => candidate.instrument.symbol === decision.symbol) ?? refreshedBundles[0];
      if (!refreshedBundle) throw new Error("NO_EVIDENCE");
      journal.portfolio = refreshedBundle.account;
      if (!exitWriteBlocked && decision.action !== "REDUCE" && decision.action !== "CLOSE") {
        const entryRecord = await this.executeDecision(client, config, decision, refreshedBundle, cycleId, supportedUniverse, drawdown.blocked, startedAt, "ENTRY");
        journal.riskGateResult = entryRecord.riskGateResult;
        if (entryRecord.executionRequest) journal.executionRequest = entryRecord.executionRequest;
        if (entryRecord.executionResult) journal.executionResult = entryRecord.executionResult;
        if (entryRecord.reconciliationResult) journal.reconciliationResult = entryRecord.reconciliationResult;
        if (entryRecord.positionBefore) journal.positionBefore = entryRecord.positionBefore;
        if (entryRecord.positionAfter) journal.positionAfter = entryRecord.positionAfter;
        if (entryRecord.accountAfter) journal.portfolio = entryRecord.accountAfter;
        await this.persistDecisionOutcome(config, entryRecord, refreshedBundle, experiences, lessons, cycleId, startedAt, journal, true);
      } else if (exitWriteBlocked && (decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT")) {
        this.recordEvent("ENTRY_SKIPPED", cycleId, { code: "EXIT_UNRESOLVED" });
        journal.riskGateResult = { status: "BLOCK", codes: ["EXIT_UNRESOLVED"], checkedAt: new Date().toISOString() };
      }
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
      this.setState({ ...this.state, runtimeStatus: drawdown.blocked ? "COOLDOWN" : "ONLINE", currentStage: drawdown.blocked ? "COOLDOWN" : "ONLINE", lastStatus: "COMPLETED", cycleStartedAt: null });
      return journal;
    } catch (error) {
      journal.completedAt = new Date().toISOString();
      journal.durationMs = Math.max(0, new Date(journal.completedAt).getTime() - new Date(startedAt).getTime());
      saveJournal(this, journal);
      saveCycle(this, cycleId, "FAILED", startedAt, journal.completedAt);
      const code = error instanceof Error ? error.message.split(":", 1)[0] ?? "CYCLE_FAILED" : "CYCLE_FAILED";
      this.recordEvent("CYCLE_FAILED", cycleId, { code, durationMs: String(journal.durationMs) });
      if (code.includes("TIMEOUT")) this.recordEvent("CYCLE_TIMEOUT", cycleId, { code });
      this.setState({ ...this.state, runtimeStatus: "ERROR", currentStage: "ERROR", lastStatus: "FAILED", cycleStartedAt: null });
      throw error;
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
    decisionType: "ENTRY" | "EXIT",
  ): Promise<DecisionExecutionRecord> {
    const riskGateResult = evaluateRiskGate(config, { decision, instrument: bundle.instrument, account: bundle.account, evidenceObservedAt: bundle.market.observedAt, openOrderSymbols: bundle.account.openOrderSymbols, supportedUniverse, emergencyStop: this.state.emergencyStop || config.ownerPolicy.emergencyStop, dailyDrawdownBlocked });
    this.recordEvent("DECISION_CREATED", cycleId, { action: decision.action, symbol: decision.symbol, decisionType });
    this.recordEvent(riskGateResult.status === "PASS" ? "RISK_GATE_PASS" : "RISK_GATE_BLOCK", cycleId, { codes: riskGateResult.codes.join(","), decisionType, symbol: decision.symbol });
    const positionBefore = findPosition(bundle.account.positions, decision.symbol, decision.positionSide);
    const record: DecisionExecutionRecord = { decision, riskGateResult, ...(positionBefore ? { positionBefore } : {}) };
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
    const currentExperience = experiences.find((experience) => experience.outcomeStatus === "OPEN" && experience.symbol === decision.symbol && experience.positionSide === decision.positionSide);
    if (!currentExperience && allowFailureReflection && (record.riskGateResult.status === "BLOCK" || (executionResult && !verified))) {
      const failure = failureCode(record.riskGateResult.codes.length ? record.riskGateResult.codes : ["EXECUTION_FAILURE"]);
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
      return {};
    }
    if (!currentExperience || !executionResult) return {};
    const realizedPnl = isDecimal(executionResult.realizedPnl) ? executionResult.realizedPnl : undefined;
    const cumulativePnl = realizedPnl && isDecimal(currentExperience.realizedPnl) ? addDecimal(currentExperience.realizedPnl, realizedPnl) : currentExperience.realizedPnl;
    const sharedInput = { decision, symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", entryPrice: currentExperience.entryPrice, exitPrice: executionResult.averageFillPrice ?? bundle.market.lastPrice, evidenceAtEntry: currentExperience.evidenceAtEntry, evidenceAtExit: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: [...new Set([...currentExperience.lessonsUsed, ...decision.lessonsUsed])], lessons: lessons.filter((lesson) => currentExperience.lessonsUsed.includes(lesson.lessonId) || decision.lessonsUsed.includes(lesson.lessonId)), marginAllocated: currentExperience.marginAllocated, positionNotional: record.positionAfter?.notional ?? currentExperience.positionNotional, realizedPnl: cumulativePnl, realizedPnlPct: executionResult.realizedPnlPct ?? currentExperience.realizedPnlPct, realizedPnlVerified: Boolean(realizedPnl), ...(executionResult.fees ? { fees: executionResult.fees } : {}), ...(executionResult.funding ? { funding: executionResult.funding } : {}) };
    if (decision.action === "CLOSE" && verified) {
      const closeInput = { ...sharedInput, outcome: realizedPnl ? "CLOSED" : "CLOSED_PNL_UNVERIFIED", failureCode: realizedPnl ? "" : "REALIZED_PNL_UNAVAILABLE", experienceStatus: realizedPnl ? outcomeFromPnl(cumulativePnl) : "EXECUTION_FAILURE" as const, existingExperience: currentExperience };
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
          this.recordEvent("REFLECTION_FAILED", cycleId, { code: error instanceof Error ? error.message.split(":", 1)[0] ?? "REFLECTION_FAILED" : "REFLECTION_FAILED", symbol: decision.symbol });
        }
      }
      return {};
    }
    if (allowFailureReflection && (record.riskGateResult.status === "BLOCK" || (executionResult && !verified))) {
      const failure = failureCode(record.riskGateResult.codes.length ? record.riskGateResult.codes : ["EXECUTION_FAILURE"]);
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

  private async ensureTradingSchedule(config: ReturnType<typeof loadConfig>): Promise<void> {
    if (this.state.paused || this.state.emergencyStop) return;
    const intervalMinutes = this.activeScanIntervalMinutes(config.ownerPolicy);
    let schedules: Awaited<ReturnType<TraderAgent["listSchedules"]>> = [];
    try {
      schedules = await this.listSchedules();
      const cycleSchedules = schedules.filter((entry) => entry.callback === "runScheduledCycle");
      const matchingSchedule = cycleSchedules.length === 1 && cycleSchedules[0]?.type === "interval" && cycleSchedules[0]?.intervalSeconds === intervalMinutes * 60;
      if (!matchingSchedule) {
        await scheduleTradingCycle(this, intervalMinutes);
        this.recordEvent("SCHEDULE_RESCHEDULED", "CONTROL", { intervalMinutes: String(intervalMinutes) });
        const refreshedSchedules = await this.listSchedules();
        const refreshedCycle = refreshedSchedules.find((entry) => entry.callback === "runScheduledCycle");
        const nextScanAt = refreshedCycle?.time && Number.isFinite(refreshedCycle.time) ? new Date(refreshedCycle.time * 1000).toISOString() : new Date(Date.now() + intervalMinutes * 60_000).toISOString();
        this.setState({ ...this.state, nextScanAt });
      } else {
        const cycleSchedule = cycleSchedules[0];
        const nextScanAt = cycleSchedule?.time && Number.isFinite(cycleSchedule.time) ? new Date(cycleSchedule.time * 1000).toISOString() : this.state.nextScanAt;
        if (nextScanAt && nextScanAt !== this.state.nextScanAt) this.setState({ ...this.state, nextScanAt });
      }
    } catch (error) {
      this.recordEvent("SCHEDULE_REPAIR_FAILED", "CONTROL", { code: error instanceof Error ? error.message.split(":", 1)[0] ?? "SCHEDULE_REPAIR_FAILED" : "SCHEDULE_REPAIR_FAILED", scheduleCount: String(schedules.length) });
    }
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
    if (previous.scanIntervalMinutes !== next.scanIntervalMinutes && !this.state.paused && !next.emergencyStop) await scheduleTradingCycle(this, this.activeScanIntervalMinutes(next));
    this.setState({ ...this.state, emergencyStop: next.emergencyStop, nextScanAt: new Date(Date.now() + this.activeScanIntervalMinutes(next) * 60_000).toISOString(), lastPolicyUpdateAt: new Date().toISOString() });
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
