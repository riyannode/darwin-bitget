import { Agent } from "agents";
import type { DashboardSnapshot, Env, ExecutionResult, OwnerPolicy, PositionSnapshot, TradeExperience, TradeLifecycleStatus, TradingJournal } from "../types.js";
import { loadConfig } from "../config.js";
import { BitgetClient } from "../bitget/client.js";
import { TRADING_MANDATE } from "./mandate.js";
import { decide, rankMarketCandidates, selectCandidates } from "./decision.js";
import { scheduleTradingCycle } from "./scheduler.js";
import { authorizeOwner } from "./owner-auth.js";
import { retrieveLessons } from "../learning/lesson-retrieval.js";
import { reflect, reflectWithQwen } from "../learning/reflection.js";
import { createBacktestLesson, runCooldownBacktest } from "../learning/backtest.js";
import { ensureStorage } from "../storage/schema.js";
import {
  loadLatestBacktest,
  loadLatestJournal,
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
import { evaluateRiskGate } from "../trading/risk-gate.js";
import { evaluateDrawdown } from "../trading/drawdown.js";
import { loadOwnerPolicy, updateOwnerPolicy } from "../trading/policy.js";
import { buildExecutionRequest, executePaperOrder } from "../trading/execution.js";
import { reconcileExecution } from "../trading/reconcile.js";

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
}

const STALE_CYCLE_TIMEOUT_MS = 120_000;

function failureCode(codes: string[]): string {
  return codes.join(",") || "";
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
  };

  public override async onStart(): Promise<void> {
    ensureStorage(this);
    const policy = this.ensureActivePolicy();
    const config = loadConfig(this.env, policy);
    const activeCycle = this.state.lastStatus === "RUNNING";
    this.setState({ ...this.state, emergencyStop: policy.emergencyStop, model: config.qwenModel, runtimeStatus: activeCycle ? this.state.runtimeStatus : this.state.paused || policy.emergencyStop ? "PAUSED" : "ONLINE", currentStage: activeCycle ? this.state.currentStage : this.state.paused || policy.emergencyStop ? "PAUSED" : "ONLINE" });
    if (!this.state.paused && !policy.emergencyStop) await scheduleTradingCycle(this, config.ownerPolicy.scanIntervalMinutes);
  }

  public override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot" && request.method === "GET") return json(await this.getDashboardSnapshot());
    if ((url.pathname === "/control" || url.pathname === "/policy") && request.method === "POST") {
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
    return new Response("NOT_FOUND", { status: 404 });
  }

  public async runScheduledCycle(): Promise<void> {
    this.recordEvent("SCHEDULE_CALLBACK", "CONTROL");
    if (this.state.paused || this.state.emergencyStop) return;
    try {
      await this.runCycle();
    } catch (error) {
      this.recordEvent("SCHEDULE_CALLBACK_FAILED", "CONTROL", { code: error instanceof Error ? error.message.split(":", 1)[0] ?? "SCHEDULE_CALLBACK_FAILED" : "SCHEDULE_CALLBACK_FAILED" });
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
      await scheduleTradingCycle(this, config.ownerPolicy.scanIntervalMinutes);
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
        drawdownBlocked: Boolean(drawdown?.cooldownUntil && new Date(drawdown.cooldownUntil).getTime() > Date.now()),
        drawdownCode: drawdown?.cooldownUntil ? "DRAWDOWN_COOLDOWN" : "NONE",
        cooldownUntil: drawdown?.cooldownUntil ?? null,
      },
      activity: loadRecentEvents(this),
      lastPolicyUpdate: loadRecentEvents(this, 50).find((event) => event.type === "POLICY_UPDATED") ?? null,
    };
  }

  private async runCycle(): Promise<TradingJournal> {
    ensureStorage(this);
    if (this.state.paused) throw new Error("AGENT_PAUSED");
    if (this.state.emergencyStop) throw new Error("EMERGENCY_STOP");
    if (this.state.lastStatus === "RUNNING" && !this.recoverStaleCycle()) throw new Error("CYCLE_IN_PROGRESS");
    const startedAt = new Date().toISOString();
    const cycleId = crypto.randomUUID();
    const config = loadConfig(this.env, this.ensureActivePolicy());
    const nextScanAt = new Date(Date.now() + config.ownerPolicy.scanIntervalMinutes * 60_000).toISOString();
    this.setState({ ...this.state, lastCycleId: cycleId, lastScanAt: startedAt, nextScanAt, model: config.qwenModel, runtimeStatus: "SCANNING", currentStage: "SCANNING", lastStatus: "RUNNING", cycleStartedAt: startedAt });
    saveCycle(this, cycleId, "RUNNING", startedAt, null);
    const journal: TradingJournal = { cycleId, agentVersion: config.version ?? "0.2.0", model: config.qwenModel, mode: config.agentMode, startedAt, retrievedLessons: [], createdLessons: [] };
    this.recordEvent("CYCLE_STARTED", cycleId);
    try {
      const client = new BitgetClient(config);
      const instruments = await client.getTradableInstruments();
      if (instruments.length === 0) throw new Error("NO_TRADABLE_INSTRUMENTS");
      const supportedUniverse = instruments.map((instrument) => instrument.symbol);
      const allLessons = loadUsableLessons(this);
      const experiences = loadExperiences(this);
      const openPositionSymbols = await client.getOpenPositionSymbols();
      const scan = await client.collectLightweightScan(instruments);
      const rankedScan = rankMarketCandidates(scan);
      this.recordEvent("MARKET_SCAN", cycleId, { symbols: String(scan.length), preRanked: String(rankedScan.length) });
      this.setState({ ...this.state, runtimeStatus: "ANALYZING", currentStage: "ANALYZING" });
      const selectedSymbols = await selectCandidates(config, supportedUniverse, rankedScan);
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
      const backtest = drawdown.blocked ? await runCooldownBacktest(config, { symbol: candidateSymbols[0] ?? supportedUniverse[0] ?? "", bars: await client.getHistoricalBars(candidateSymbols[0] ?? supportedUniverse[0] ?? ""), experiences, trigger: drawdown.code }) : undefined;
      if (backtest) { saveBacktest(this, backtest); journal.backtest = backtest; this.recordEvent("BACKTEST_COMPLETED", cycleId); }
      const openExperiences = experiences.filter((experience) => experience.outcomeStatus === "OPEN");
      const context = { bundles, supportedUniverse, experiences, openExperiences, lessons, openPositions, observedAt: new Date().toISOString(), mandate: TRADING_MANDATE };
      const decision = await decide(config, context, cycleId);
      const bundle = bundles.find((candidate) => candidate.instrument.symbol === decision.symbol) ?? bundles[0];
      if (!bundle) throw new Error("NO_EVIDENCE");
      this.setState({ ...this.state, runtimeStatus: "RISK_CHECK", currentStage: "RISK_CHECK" });
      const riskGateResult = evaluateRiskGate(config, { decision, instrument: bundle.instrument, account: bundle.account, evidenceObservedAt: bundle.market.observedAt, openOrderSymbols: bundle.account.openOrderSymbols, supportedUniverse, emergencyStop: this.state.emergencyStop || config.ownerPolicy.emergencyStop, dailyDrawdownBlocked: drawdown.blocked });
      journal.marketContext = { scan, deep: bundles.map((candidate) => ({ market: candidate.market, regime: candidate.marketRegime })) };
      journal.portfolio = account;
      journal.evidence = bundles.flatMap((candidate) => candidate.evidence);
      journal.retrievedLessons = lessons.map((lesson) => lesson.lessonId);
      journal.decision = decision;
      journal.riskGateResult = riskGateResult;
      this.recordEvent("DECISION_CREATED", cycleId, { action: decision.action, symbol: decision.symbol });
      this.recordEvent(riskGateResult.status === "PASS" ? "RISK_GATE_PASS" : "RISK_GATE_BLOCK", cycleId, { codes: riskGateResult.codes.join(",") });
      let executionRequest;
      let executionResult;
      let reconciliationResult;
      const positionBefore = findPosition(bundle.account.positions, decision.symbol, decision.positionSide);
      if (riskGateResult.status === "PASS" && decision.action !== "HOLD") {
        this.setState({ ...this.state, runtimeStatus: "EXECUTING", currentStage: "EXECUTING" });
        executionRequest = buildExecutionRequest(decision, bundle, cycleId);
        if (!recordIdempotency(this, executionRequest.clientOrderId, cycleId, decision.decisionId, startedAt)) throw new Error("DUPLICATE_ORDER");
        this.recordEvent("PAPER_ORDER_SUBMITTED", cycleId, { symbol: decision.symbol, action: decision.action });
        executionResult = await executePaperOrder(client, executionRequest);
        this.setState({ ...this.state, runtimeStatus: "RECONCILING", currentStage: "RECONCILING" });
        let positionAfter: PositionSnapshot | undefined;
        try {
          const afterBundle = (await client.collectEvidence([decision.symbol]))[0];
          if (afterBundle) {
            journal.portfolio = afterBundle.account;
            positionAfter = findPosition(afterBundle.account.positions, decision.symbol, decision.positionSide);
          }
        } catch {
          positionAfter = undefined;
        }
        reconciliationResult = reconcileExecution(executionRequest, executionResult, positionBefore, positionAfter);
        if (executionRequest.tradeSide === "open" && executionResult.status === "filled" && !positionAfter) {
          reconciliationResult = { ...reconciliationResult, status: "MISMATCH" as const, codes: [...reconciliationResult.codes, "POSITION_READBACK_MISSING"] };
        }
        if (positionBefore) journal.positionBefore = positionBefore;
        if (positionAfter) journal.positionAfter = positionAfter;
        journal.executionRequest = executionRequest;
        journal.executionResult = executionResult;
        journal.reconciliationResult = reconciliationResult;
        this.recordEvent(reconciliationResult.status === "MATCHED" ? "EXECUTION_VERIFIED" : "EXECUTION_UNRESOLVED", cycleId);
      }
      this.setState({ ...this.state, runtimeStatus: "REFLECTING", currentStage: "REFLECTING" });
      const codes = [...riskGateResult.codes, ...(drawdown.code === "NONE" ? [] : [drawdown.code])];
      const failure = failureCode(codes);
      const verified = Boolean(executionResult && reconciliationResult?.status === "MATCHED" && executionResult.status === "filled");
      const currentExperience = experiences.find((experience) => experience.outcomeStatus === "OPEN" && experience.symbol === decision.symbol && experience.positionSide === decision.positionSide);
      const closed = decision.action === "CLOSE" && verified;
      const reduced = decision.action === "REDUCE" && verified;
      const opening = (decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT") && verified;
      if (opening && executionResult) {
        const openingExperience = reflect({ decision, outcome: "OPEN", failureCode: "", symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", experienceStatus: "OPEN", entryPrice: executionResult.averageFillPrice ?? bundle.market.lastPrice, evidenceAtEntry: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: decision.lessonsUsed, marginAllocated: executionResult.marginAllocated, positionNotional: executionResult.positionNotional, realizedPnlVerified: false });
        journal.experienceId = openingExperience.experience.experienceId;
        saveExperience(this, openingExperience.experience, startedAt);
      } else if (closed && currentExperience && executionResult) {
        const realizedPnl = executionResult.realizedPnl;
        const resolvedPnl = realizedPnl ?? "UNAVAILABLE";
        const realizedPnlVerified = Boolean(realizedPnl && /^-?\d+(?:\.\d+)?$/.test(realizedPnl));
        const closeInput = { decision, outcome: realizedPnlVerified ? "CLOSED" : "CLOSED_PNL_UNVERIFIED", failureCode: realizedPnlVerified ? "" : "REALIZED_PNL_UNAVAILABLE", symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", experienceStatus: realizedPnlVerified ? outcomeFromPnl(resolvedPnl) : "EXECUTION_FAILURE" as const, entryPrice: currentExperience.entryPrice, exitPrice: executionResult.averageFillPrice ?? bundle.market.lastPrice, evidenceAtEntry: currentExperience.evidenceAtEntry, evidenceAtExit: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: [...new Set([...currentExperience.lessonsUsed, ...decision.lessonsUsed])], lessons: lessons.filter((lesson) => currentExperience.lessonsUsed.includes(lesson.lessonId) || decision.lessonsUsed.includes(lesson.lessonId)), marginAllocated: currentExperience.marginAllocated, positionNotional: currentExperience.positionNotional, realizedPnl: resolvedPnl, realizedPnlPct: executionResult.realizedPnlPct ?? "UNAVAILABLE", realizedPnlVerified, existingExperience: currentExperience };
        const closedExperience = reflect({ ...closeInput, ...(executionResult.fees ? { fees: executionResult.fees } : {}), ...(executionResult.funding ? { funding: executionResult.funding } : {}) });
        journal.experienceId = closedExperience.experience.experienceId;
        saveExperience(this, closedExperience.experience, startedAt);
        try {
          const closeResult = await reflectWithQwen(config, { ...closeInput, ...(executionResult.fees ? { fees: executionResult.fees } : {}), ...(executionResult.funding ? { funding: executionResult.funding } : {}) });
          journal.reflection = closeResult.reflection;
          journal.createdLessons = [closeResult.lesson.lessonId];
          saveExperience(this, closeResult.experience, startedAt);
          saveLesson(this, closeResult.lesson);
          recordLessonApplication(this, cycleId, closeResult.reflection.lessonEvaluations.filter((evaluation) => closeResult.experience.lessonsUsed.includes(evaluation.lessonId)), new Date().toISOString());
          this.recordEvent("REFLECTION_COMPLETED", cycleId);
          this.recordEvent("LESSON_CREATED", cycleId, { source: closeResult.lesson.source });
        } catch (error) {
          this.recordEvent("REFLECTION_FAILED", cycleId, { code: error instanceof Error ? error.message.split(":", 1)[0] ?? "REFLECTION_FAILED" : "REFLECTION_FAILED" });
        }
      } else if (reduced && currentExperience && executionResult) {
        const reducedExperience: TradeExperience = { ...currentExperience, lastAction: "REDUCE", exitDecisionId: decision.decisionId, exitPrice: executionResult.averageFillPrice ?? bundle.market.lastPrice, exitThesis: decision.thesis, positionNotional: journal.positionAfter?.notional ?? currentExperience.positionNotional, marginAllocated: journal.positionAfter?.marginAllocated ?? currentExperience.marginAllocated, evidenceAtExit: bundle.evidence.map((evidence) => evidence.type), ...(executionResult.realizedPnl ? { realizedPnl: executionResult.realizedPnl, realizedPnlVerified: true } : {}), ...(executionResult.realizedPnlPct ? { realizedPnlPct: executionResult.realizedPnlPct } : {}), ...(executionResult.fees ? { fees: executionResult.fees } : {}), ...(executionResult.funding ? { funding: executionResult.funding } : {}) };
        journal.experienceId = reducedExperience.experienceId;
        saveExperience(this, reducedExperience, startedAt);
      } else if (riskGateResult.status === "BLOCK" || (executionResult && reconciliationResult?.status !== "MATCHED")) {
        const failureResult = reflect({ decision, outcome: riskGateResult.status === "BLOCK" ? "RISK_BLOCKED" : "EXECUTION_FAILURE", failureCode: failure || "EXECUTION_FAILURE", symbol: decision.symbol, marketRegime: bundle.marketRegime ?? "UNKNOWN", experienceStatus: riskGateResult.status === "BLOCK" ? "BLOCKED" : "EXECUTION_FAILURE", entryPrice: bundle.market.lastPrice, exitPrice: bundle.market.lastPrice, evidenceAtEntry: bundle.evidence.map((evidence) => evidence.type), evidenceAtExit: bundle.evidence.map((evidence) => evidence.type), lessonsUsed: decision.lessonsUsed, marginAllocated: executionRequest?.marginAllocated ?? "0", positionNotional: executionRequest?.positionNotional ?? "0" });
        journal.experienceId = failureResult.experience.experienceId;
        journal.reflection = failureResult.reflection;
        journal.createdLessons = [failureResult.lesson.lessonId];
        saveExperience(this, failureResult.experience, startedAt);
        saveLesson(this, failureResult.lesson);
        this.recordEvent("REFLECTION_COMPLETED", cycleId);
      }
      const backtestLesson = backtest ? createBacktestLesson(backtest) : undefined;
      journal.createdLessons = [...journal.createdLessons, ...(backtestLesson ? [backtestLesson.lessonId] : [])];
      if (backtestLesson) saveLesson(this, backtestLesson);
      if (backtestLesson) this.recordEvent("LESSON_CREATED", cycleId, { source: "BACKTEST_REPLAY" });
      journal.completedAt = new Date().toISOString();
      saveJournal(this, journal);
      saveCycle(this, cycleId, "COMPLETED", startedAt, journal.completedAt);
      this.setState({ ...this.state, runtimeStatus: drawdown.blocked ? "COOLDOWN" : "ONLINE", currentStage: drawdown.blocked ? "COOLDOWN" : "ONLINE", lastStatus: "COMPLETED", cycleStartedAt: null });
      return journal;
    } catch (error) {
      journal.completedAt = new Date().toISOString();
      saveJournal(this, journal);
      saveCycle(this, cycleId, "FAILED", startedAt, journal.completedAt);
      this.recordEvent("CYCLE_FAILED", cycleId, { code: error instanceof Error ? error.message.split(":", 1)[0] ?? "CYCLE_FAILED" : "CYCLE_FAILED" });
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

  private recordEvent(type: string, cycleId: string, metadata?: Record<string, string>): void {
    saveEvent(this, { eventId: crypto.randomUUID(), type, cycleId, createdAt: new Date().toISOString(), ...(metadata ? { metadata } : {}) });
  }

  private async ensureTradingSchedule(config: ReturnType<typeof loadConfig>): Promise<void> {
    if (this.state.paused || this.state.emergencyStop || this.state.lastStatus === "RUNNING") return;
    let schedules: Awaited<ReturnType<TraderAgent["listSchedules"]>> = [];
    try {
      schedules = await this.listSchedules();
      const cycleSchedules = schedules.filter((entry) => entry.callback === "runScheduledCycle");
      if (cycleSchedules.length !== 1) {
        await scheduleTradingCycle(this, config.ownerPolicy.scanIntervalMinutes);
        const refreshedSchedules = await this.listSchedules();
        const refreshedCycle = refreshedSchedules.find((entry) => entry.callback === "runScheduledCycle");
        const nextScanAt = refreshedCycle?.time && Number.isFinite(refreshedCycle.time) ? new Date(refreshedCycle.time * 1000).toISOString() : new Date(Date.now() + config.ownerPolicy.scanIntervalMinutes * 60_000).toISOString();
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
        this.recordEvent("POSITION_STATE_DISCREPANCY", cycleId, { code, symbol: position.symbol, positionSide: position.positionSide, experienceId: "NONE" });
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
    if (previous.scanIntervalMinutes !== next.scanIntervalMinutes && !this.state.paused) await scheduleTradingCycle(this, next.scanIntervalMinutes);
    this.setState({ ...this.state, emergencyStop: next.emergencyStop, nextScanAt: new Date(Date.now() + next.scanIntervalMinutes * 60_000).toISOString(), lastPolicyUpdateAt: new Date().toISOString() });
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
