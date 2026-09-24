import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadAllEvents, loadExperiences, loadJournalsForDecisionIds, loadPerformanceAggregate, loadPositionContext, loadRecentJournals, saveEvent, saveExperience, saveJournal, savePositionContext } from "../src/storage/store.js";
import { buildPaperLogExport } from "../src/storage/paper-log.js";
import type { AccountSnapshot, CycleDecisionPlan, DecisionContext, DecisionExecutionRecord, EvidenceBundle, Instrument, PositionContext, PositionManagementState, PositionReasoning, PositionSnapshot, TradeExperience, TradingJournal } from "../src/types.js";

vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
vi.mock("../src/trading/execution-planner.js", () => ({
  executeCyclePlan: vi.fn(),
}));
vi.mock("../src/agent/decision.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/decision.js")>("../src/agent/decision.js");
  return { ...actual, decide: vi.fn() };
});

import { decide } from "../src/agent/decision.js";
import { TraderAgent } from "../src/agent/agent.js";
import { executeCyclePlan } from "../src/trading/execution-planner.js";
import { BitgetClient } from "../src/bitget/client.js";
import type { PerformanceAggregate } from "../src/trading/performance.js";

interface ObservableJournal extends TradingJournal {
  positionManagementState?: PositionManagementState[];
  promptVersions?: {
    mandate: string;
    decision: string;
  };
}

const lifecycleState: PositionManagementState = {
  symbol: "CRCLUSDT",
  positionSide: "LONG",
  entryPrice: "100",
  currentPrice: "106",
  currentReturnPct: 6,
  maximumFavorableReturnPct: 10,
  maximumFavorableReturnBasis: "SINCE_ENTRY",
  profitGivebackPct: 40,
  timeInTradeMinutes: 15,
  priorManagementActions: ["HOLD", "HOLD", "REDUCE"],
};

const baseJournal: TradingJournal = {
  cycleId: "cycle-legacy",
  agentVersion: "0.2.0",
  promptVersion: "darwin-mandate-v7",
  model: "qwen3.8-max",
  mode: "AUTONOMOUS",
  startedAt: "2026-09-21T00:00:00.000Z",
  retrievedLessons: [],
  createdLessons: [],
};

function memoryExecutor(db = new DatabaseSync(":memory:")): { db: DatabaseSync; executor: SqlExecutor } {
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      const sqliteValues = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[];
      if (/^\s*(SELECT|WITH)\b/i.test(query)) return db.prepare(query).all(...sqliteValues) as T[];
      db.prepare(query).run(...sqliteValues);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor };
}

function account(): AccountSnapshot {
  return {
    balance: "1000",
    availableBalance: "900",
    availableMargin: "900",
    marginUsage: "100",
    positionNotional: "300",
    totalPositionNotional: "300",
    positionQuantity: "3",
    portfolioEquity: "1000",
    positions: [position()],
    realizedPnl: "0",
    unrealizedPnl: "18",
    openOrders: 0,
    openOrderSymbols: [],
    observedAt: "2026-09-21T00:00:30.000Z",
  };
}

function position(): PositionSnapshot {
  return {
    symbol: "CRCLUSDT",
    positionSide: "LONG",
    quantity: "3",
    notional: "300",
    marginAllocated: "100",
    leverage: "3",
    entryPrice: "100",
    markPrice: "106",
    unrealizedPnl: "18",
    unrealizedPnlPct: "6",
    realizedPnl: "0",
  };
}

function instrument(): Instrument {
  return {
    symbol: "CRCLUSDT",
    category: "USDT-FUTURES",
    baseCoin: "CRCL",
    quoteCoin: "USDT",
    marginCoin: "USDT",
    symbolType: "USDT-FUTURES",
    isRwa: "YES",
    status: "online",
    minOrderQty: "1",
    maxOrderQty: "1000",
    minOrderAmount: "1",
    pricePrecision: 2,
    quantityPrecision: 3,
    quantityStep: "0.001",
    leverageMin: "1",
    leverageMax: "5",
  };
}

function bundle(): EvidenceBundle {
  return {
    market: {
      symbol: "CRCLUSDT",
      lastPrice: "106",
      bidPrice: "105.9",
      askPrice: "106.1",
      priceChange24h: "6",
      volume24h: "100000",
      observedAt: "2026-09-21T00:00:30.000Z",
    },
    account: account(),
    instrument: instrument(),
    evidence: [],
  };
}

function plan(): CycleDecisionPlan {
  return {
    positionActions: [{
      decisionId: "decision-hold",
      cycleId: "cycle-runtime",
      action: "HOLD",
      positionSide: "LONG",
      symbol: "CRCLUSDT",
      marginAllocationPct: "0",
      leverage: "3",
      reductionPct: null,
      confidence: 0.8,
      thesis: "Hold the existing position.",
      strategyThesis: "Lifecycle evidence remains bounded.",
      supportingFactors: ["Lifecycle state"],
      riskFactors: ["Market risk"],
      evidenceUsed: ["MARKET"],
      lessonsUsed: [],
      createdAt: "2026-09-21T00:00:31.000Z",
    }],
    entryActions: [],
  } as CycleDecisionPlan;
}

function verifiedCloseRecord(): DecisionExecutionRecord {
  const decision = { ...plan().positionActions[0], decisionId: "decision-close", action: "CLOSE" as const, reductionPct: "100" };
  const executionResult = {
    provider: "test",
    providerOrderId: "provider-order-1",
    clientOrderId: "client-order-1",
    symbol: "CRCLUSDT",
    action: "CLOSE",
    positionSide: "LONG" as const,
    providerSide: "sell" as const,
    tradeSide: "close" as const,
    marginAllocated: "0",
    leverage: "3",
    positionNotional: "300",
    requestedQuantity: "3",
    executedQuantity: "3",
    status: "filled" as const,
    submittedAt: "2026-09-21T00:00:31.000Z",
    readBackAt: "2026-09-21T00:00:32.000Z",
  };
  return {
    decision,
    riskGateResult: { status: "PASS", codes: [], checkedAt: "2026-09-21T00:00:31.000Z" },
    executionRequest: { cycleId: "cycle-runtime", decisionId: "decision-close", symbol: "CRCLUSDT", action: "CLOSE", positionSide: "LONG", providerSide: "sell", tradeSide: "close", marginAllocated: "0", leverage: "3", positionNotional: "300", reductionPct: "100", quantity: "3", clientOrderId: "client-order-1" },
    executionResult,
    reconciliationResult: { status: "MATCHED", codes: [], execution: executionResult },
  } as DecisionExecutionRecord;
}

function openExecutionRecord(status: "filled" | "unknown", reconciliationStatus: "MISMATCH" | "UNKNOWN"): DecisionExecutionRecord {
  const decision = { ...plan().positionActions[0], decisionId: "decision-open", action: "OPEN_LONG" as const, positionSide: "LONG" as const, symbol: "CRCLUSDT", marginAllocationPct: "1.5", reductionPct: null };
  const executionResult = { provider: "test", providerOrderId: status === "filled" ? "provider-open" : undefined, clientOrderId: "client-open", symbol: "CRCLUSDT", action: "OPEN_LONG" as const, positionSide: "LONG" as const, providerSide: "buy" as const, tradeSide: "open" as const, marginAllocated: "100", leverage: "3", positionNotional: "300", requestedQuantity: "3", executedQuantity: status === "filled" ? "3" : "0", status, submittedAt: decision.createdAt, readBackAt: decision.createdAt, averageFillPrice: status === "filled" ? "100" : undefined };
  return { decision, riskGateResult: { status: "PASS", codes: [], checkedAt: decision.createdAt }, executionResult, reconciliationResult: { status: reconciliationStatus, codes: reconciliationStatus === "MISMATCH" ? ["POSITION_READBACK_UNAVAILABLE", "POSITION_READBACK_MISSING"] : ["EXECUTION_UNKNOWN"], execution: executionResult } } as DecisionExecutionRecord;
}

function unresolvedExperienceFixture(): TradeExperience {
  return {
    experienceId: "unresolved-experience",
    symbol: "CRCLUSDT",
    positionSide: "LONG",
    action: "OPEN_LONG",
    entryDecisionId: "decision-open",
    entryPrice: "100",
    entryTime: "2026-09-21T00:00:30.000Z",
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: "",
    selectedLeverage: "3",
    marginAllocationPct: "1.5",
    marginAllocated: "100",
    positionNotional: "300",
    realizedPnl: "0",
    realizedPnlPct: "0",
    maximumFavorableExcursion: "0",
    maximumAdverseExcursion: "0",
    drawdownContribution: "0",
    liquidationDistance: "0",
    entryThesis: "provider-confirmed entry",
    exitThesis: "",
    evidenceAtEntry: ["TICKER"],
    evidenceAtExit: [],
    lessonsUsed: [],
    marketContext: "RANGE_LOW_VOL",
    outcomeStatus: "EXECUTION_UNRESOLVED",
    lastAction: "OPEN_LONG",
  };
}

function cycleTestAgent(executor: SqlExecutor, events: Array<{ type: string; metadata?: Record<string, string> }>, discrepancies: string[] = []) {
  return {
    env: { TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: "USDT-FUTURES" },
    state: { emergencyStop: false, paused: false, lastCycleId: null, lastScanAt: null, nextScanAt: null, model: "", runtimeStatus: "ONLINE", currentStage: "ONLINE", lastStatus: "IDLE", lastPolicyUpdateAt: null, cycleStartedAt: null, temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: true, temporaryScanIntervalDurationMs: 0, userStorageVersion: 0 },
    ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
    activeScanIntervalMinutes: () => 5,
    setState(next: unknown) { (this as unknown as { state: unknown }).state = next; },
    recordEvent(type: string, _cycleId: string, metadata?: Record<string, string>) { events.push({ type, ...(metadata ? { metadata } : {}) }); },
    recordPositionDiscrepancies: () => discrepancies,
    refreshPositionManagementState: () => [lifecycleState],
    reconcileLateExecutions: async () => undefined,
    collectResearchEvidence: async () => undefined,
    persistPerformanceEquity: () => undefined,
    persistDecisionOutcome: async () => undefined,
    sql: executor.sql,
  } as unknown as { state: unknown };
}

describe("journal observability persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("uses a bounded fallback for a legacy journal decision", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE journals (cycle_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE risk_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const legacyJournal = JSON.stringify({ cycleId: "legacy-cycle", decision: { decisionId: "legacy-entry-decision" } });
    db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)").run("legacy-cycle", legacyJournal, "2026-09-01T00:00:00.000Z");
    const { executor } = memoryExecutor(db);
    const result = loadJournalsForDecisionIds(executor, ["legacy-entry-decision"], 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.cycleId).toBe("legacy-cycle");
    expect(result[0]?.decision?.decisionId).toBe("legacy-entry-decision");
    db.close();
  });

  it("round-trips the complete lifecycle state and prompt versions through journal JSON", async () => {
    const { db, executor } = memoryExecutor();
    const journal: ObservableJournal = {
      ...baseJournal,
      cycleId: "cycle-observability",
      positionManagementState: [lifecycleState],
      promptVersions: { mandate: "darwin-mandate-v7", decision: "darwin-decision-v9" },
    };

    saveJournal(executor, journal);

    const loaded = loadRecentJournals(executor, 1)[0] as ObservableJournal;
    expect(loaded.positionManagementState).toEqual([lifecycleState]);
    expect(loaded.promptVersions).toEqual({ mandate: "darwin-mandate-v7", decision: "darwin-decision-v9" });

    const response = (TraderAgent.prototype as unknown as { getAgentJournal: (url: URL) => Response }).getAgentJournal.call({ sql: executor.sql }, new URL("https://example.test/agent-journal?limit=1"));
    const body = await response.json() as { journals: ObservableJournal[] };
    expect(body.journals[0]?.positionManagementState).toEqual([lifecycleState]);
    expect(body.journals[0]?.promptVersions).toEqual({ mandate: "darwin-mandate-v7", decision: "darwin-decision-v9" });
    db.close();
  });

  it("loads historical journals without the additive observability fields", () => {
    const { db, executor } = memoryExecutor();
    saveJournal(executor, baseJournal);

    const loaded = loadRecentJournals(executor, 1)[0] as ObservableJournal;
    expect(loaded.cycleId).toBe("cycle-legacy");
    expect(loaded.positionManagementState).toBeUndefined();
    expect(loaded.promptVersions).toBeUndefined();
    db.close();
  });

  it("persists the exact lifecycle object supplied to the production decision context", async () => {
    const { db, executor } = memoryExecutor();
    const captured: { context?: DecisionContext } = {};
    const lifecycleStateList = [lifecycleState];
    const decideMock = vi.mocked(decide);
    decideMock.mockImplementation(async (_config, context) => {
      captured.context = context;
      return { plan: plan(), ignoredLessonIds: [] };
    });
    vi.mocked(executeCyclePlan).mockImplementation(async (_plan, callbacks) => {
      const holdDecision = plan().positionActions[0];
      if (!holdDecision) throw new Error("TEST_HOLD_DECISION_MISSING");
      const record: DecisionExecutionRecord = { decision: holdDecision, riskGateResult: { status: "PASS", codes: [], checkedAt: "2026-09-21T00:00:31.000Z" } };
      await callbacks.persist(record, bundle());
      return { records: [record], finalPortfolio: undefined, stoppedAfterAmbiguity: false };
    });

    vi.spyOn(BitgetClient.prototype, "getOpenPositionSymbols").mockResolvedValue(["CRCLUSDT"]);
    vi.spyOn(BitgetClient.prototype, "getTradableInstruments").mockResolvedValue([instrument()]);
    vi.spyOn(BitgetClient.prototype, "collectLightweightScan").mockResolvedValue([]);
    vi.spyOn(BitgetClient.prototype, "collectEvidence").mockResolvedValue([bundle()]);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue(account());

    const fake = {
      env: { TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: "USDT-FUTURES" },
      state: { emergencyStop: false, paused: false, lastCycleId: null, lastScanAt: null, nextScanAt: null, model: "", runtimeStatus: "ONLINE", currentStage: "ONLINE", lastStatus: "IDLE", lastPolicyUpdateAt: null, cycleStartedAt: null, temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: true, temporaryScanIntervalDurationMs: 0, userStorageVersion: 0 },
      ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
      activeScanIntervalMinutes: () => 5,
      setState(next: unknown) { (this as unknown as { state: unknown }).state = next; },
      recordEvent: () => undefined,
      recordPositionDiscrepancies: () => [],
      refreshPositionManagementState: () => lifecycleStateList,
      reconcileLateExecutions: async () => undefined,
      collectResearchEvidence: async () => undefined,
      persistPerformanceEquity: () => undefined,
      persistDecisionOutcome: async () => undefined,
      sql: executor.sql,
    } as unknown as { state: unknown };

    const journal = await (TraderAgent.prototype as unknown as { runCycle: () => Promise<TradingJournal> }).runCycle.call(fake);
    const saved = journal as ObservableJournal;
    expect(captured.context?.positionManagementState).toBe(lifecycleStateList);
    expect(saved.positionManagementState).toBe(lifecycleStateList);
    expect(saved.positionManagementState).toEqual([lifecycleState]);
    expect(saved.promptVersions).toEqual({ mandate: "darwin-mandate-v7", decision: "darwin-decision-v9" });
    expect(saved.executionRecords).toHaveLength(1);
    expect(saved.discovery?.financialWritesPerformed).toBe(0);
    expect((loadRecentJournals(executor, 1)[0] as ObservableJournal).positionManagementState).toEqual(captured.context?.positionManagementState);
    db.close();
  });

  it("attributes a pre-write decision Zod failure and records no financial write", async () => {
    const { db, executor } = memoryExecutor();
    const events: Array<{ type: string; metadata?: Record<string, string> }> = [];
    vi.mocked(decide).mockRejectedValue(new z.ZodError([{ code: "too_big", origin: "string", maximum: 500, inclusive: true, path: ["positionActions", 0, "strategyThesis"], message: "Too big" }]));
    vi.mocked(executeCyclePlan).mockReset();
    vi.spyOn(BitgetClient.prototype, "getOpenPositionSymbols").mockResolvedValue(["CRCLUSDT"]);
    vi.spyOn(BitgetClient.prototype, "getTradableInstruments").mockResolvedValue([instrument()]);
    vi.spyOn(BitgetClient.prototype, "collectLightweightScan").mockResolvedValue([]);
    vi.spyOn(BitgetClient.prototype, "collectEvidence").mockResolvedValue([bundle()]);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue(account());

    const fake = cycleTestAgent(executor, events);
    await expect((TraderAgent.prototype as unknown as { runCycle: () => Promise<TradingJournal> }).runCycle.call(fake)).rejects.toThrow();
    expect(executeCyclePlan).not.toHaveBeenCalled();
    const schemaEvent = events.find((event) => event.type === "DECISION_SCHEMA_VALIDATION_FAILED");
    expect(schemaEvent?.metadata).toMatchObject({ stage: "decision_schema_validation", code: "ZOD_VALIDATION_FAILED" });
    const failedEvent = events.find((event) => event.type === "CYCLE_FAILED");
    expect(failedEvent?.metadata).toMatchObject({ stage: "decision_schema_validation" });
    const saved = loadRecentJournals(executor, 1)[0];
    expect(saved?.executionRecords).toBeUndefined();
    expect(saved?.discovery?.financialWritesPerformed).toBe(0);
    db.close();
  });

  it("does not attribute a downstream Zod failure to decision schema validation", async () => {
    const { db, executor } = memoryExecutor();
    const events: Array<{ type: string; metadata?: Record<string, string> }> = [];
    vi.mocked(decide).mockResolvedValue({ plan: plan(), ignoredLessonIds: [] });
    vi.mocked(executeCyclePlan).mockRejectedValue(new z.ZodError([{ code: "custom", path: ["downstream"], message: "Downstream failure" }]));
    vi.spyOn(BitgetClient.prototype, "getOpenPositionSymbols").mockResolvedValue(["CRCLUSDT"]);
    vi.spyOn(BitgetClient.prototype, "getTradableInstruments").mockResolvedValue([instrument()]);
    vi.spyOn(BitgetClient.prototype, "collectLightweightScan").mockResolvedValue([]);
    vi.spyOn(BitgetClient.prototype, "collectEvidence").mockResolvedValue([bundle()]);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue(account());

    const fake = cycleTestAgent(executor, events);
    await expect((TraderAgent.prototype as unknown as { runCycle: () => Promise<TradingJournal> }).runCycle.call(fake)).rejects.toThrow();
    expect(events.some((event) => event.type === "DECISION_SCHEMA_VALIDATION_FAILED")).toBe(false);
    const failedEvent = events.find((event) => event.type === "CYCLE_FAILED");
    expect(failedEvent?.metadata?.stage).toBeUndefined();
    const saved = loadRecentJournals(executor, 1)[0];
    expect(saved?.executionRecords).toBeUndefined();
    expect(saved?.discovery?.financialWritesPerformed).toBe(0);
    db.close();
  });

  it("persists filled position-readback failures as EXECUTION_UNRESOLVED without a failure lesson", async () => {
    const { db, executor } = memoryExecutor();
    const events: Array<{ type: string; metadata?: Record<string, string> }> = [];
    const fake = { sql: executor.sql, updatePerformanceReadModel: () => undefined, recordEvent(type: string, _cycleId: string, metadata?: Record<string, string>) { events.push({ type, ...(metadata ? { metadata } : {}) }); } };
    const journal: TradingJournal = { ...baseJournal, cycleId: "cycle-unresolved" };
    await (TraderAgent.prototype as unknown as { persistDecisionOutcome: (...args: unknown[]) => Promise<unknown> }).persistDecisionOutcome.call(fake, {} as never, openExecutionRecord("filled", "MISMATCH"), bundle(), [], [], journal.cycleId, journal.startedAt, journal, true);
    const experiences = loadExperiences(executor, 10);
    expect(experiences[0]?.outcomeStatus).toBe("EXECUTION_UNRESOLVED");
    expect(events.map((event) => event.type)).toContain("EXECUTION_UNRESOLVED");
    expect(journal.createdLessons).toEqual([]);
    db.close();
  });

  it("retains EXECUTION_FAILURE behavior for a not-executed opening", async () => {
    const { db, executor } = memoryExecutor();
    const events: Array<{ type: string; metadata?: Record<string, string> }> = [];
    const fake = { sql: executor.sql, updatePerformanceReadModel: () => undefined, recordEvent(type: string, _cycleId: string, metadata?: Record<string, string>) { events.push({ type, ...(metadata ? { metadata } : {}) }); } };
    const journal: TradingJournal = { ...baseJournal, cycleId: "cycle-failure" };
    await (TraderAgent.prototype as unknown as { persistDecisionOutcome: (...args: unknown[]) => Promise<unknown> }).persistDecisionOutcome.call(fake, {} as never, openExecutionRecord("unknown", "UNKNOWN"), bundle(), [], [], journal.cycleId, journal.startedAt, journal, true);
    const experiences = loadExperiences(executor, 10);
    expect(experiences[0]?.outcomeStatus).toBe("EXECUTION_FAILURE");
    db.close();
  });

  it("blocks the whole cycle when any provider position lacks local lifecycle ownership", async () => {
    const { db, executor } = memoryExecutor();
    const events: Array<{ type: string; metadata?: Record<string, string> }> = [];
    const entry = { ...plan().positionActions[0], decisionId: "entry-nvda", action: "OPEN_LONG" as const, positionSide: "LONG" as const, symbol: "NVDAUSDT", marginAllocationPct: "1", reductionPct: null };
    vi.mocked(decide).mockResolvedValue({ plan: { positionActions: plan().positionActions, entryActions: [entry] as CycleDecisionPlan["entryActions"] }, ignoredLessonIds: [] });
    vi.mocked(executeCyclePlan).mockImplementation(async () => { throw new Error("EXECUTION_PLANNER_SHOULD_NOT_RUN"); });
    vi.spyOn(BitgetClient.prototype, "getOpenPositionSymbols").mockResolvedValue(["CRCLUSDT"]);
    vi.spyOn(BitgetClient.prototype, "getTradableInstruments").mockResolvedValue([instrument()]);
    vi.spyOn(BitgetClient.prototype, "collectLightweightScan").mockResolvedValue([]);
    vi.spyOn(BitgetClient.prototype, "collectEvidence").mockResolvedValue([bundle()]);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue(account());

    const fake = cycleTestAgent(executor, events, ["LOCAL_EXPERIENCE_MISSING:CRCLUSDT:LONG"]);
    const journal = await (TraderAgent.prototype as unknown as { runCycle: () => Promise<TradingJournal> }).runCycle.call(fake);
    expect(executeCyclePlan).not.toHaveBeenCalled();
    expect(journal.discovery?.financialWritesPerformed).toBe(0);
    expect(events.find((event) => event.type === "FINANCIAL_WRITES_STOPPED")?.metadata).toMatchObject({ code: "LOCAL_LIFECYCLE_UNRESOLVED" });
    db.close();
  });

  it("persists owner late reconciliation exactly once across repeated orchestration calls", async () => {
    const { db, executor } = memoryExecutor();
    const record = openExecutionRecord("filled", "MISMATCH");
    const journal: TradingJournal = { ...baseJournal, cycleId: "cycle-runtime", executionRecords: [record] };
    saveJournal(executor, journal);
    saveExperience(executor, {
      ...unresolvedExperienceFixture(),
      experienceId: "unresolved-persisted",
      entryDecisionId: record.decision.decisionId,
      symbol: record.decision.symbol,
      positionSide: "LONG",
      outcomeStatus: "EXECUTION_UNRESOLVED",
    }, "2026-09-21T00:00:32.000Z");
    const original = loadRecentJournals(executor, 1)[0]!;
    const originalExecution = JSON.stringify(original.executionRecords?.[0]?.executionResult);
    const originalReconciliation = JSON.stringify(original.executionRecords?.[0]?.reconciliationResult);
    const events: string[] = [];
    let eventSequence = 0;
    const fake = {
      env: { TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: "USDT-FUTURES" },
      state: { paused: true, emergencyStop: false },
      ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
      performanceWithEquity: (TraderAgent.prototype as unknown as { performanceWithEquity: (equity: string, observedAt: string) => PerformanceAggregate }).performanceWithEquity,
      recordEvent(type: string, cycleId: string, metadata?: Record<string, string>) {
        if (type === "LATE_EXECUTION_RECONCILED") events.push(type);
        saveEvent(executor, { eventId: `event-${++eventSequence}`, type, cycleId, createdAt: `2026-09-21T00:01:0${eventSequence}.000Z`, ...(metadata ? { metadata } : {}) });
      },
      sql: executor.sql,
    } as unknown as { state: { paused: boolean } };
    vi.spyOn(BitgetClient.prototype, "collectEvidence").mockResolvedValue([bundle()]);
    vi.spyOn(BitgetClient.prototype, "getOrderDetailsRead").mockResolvedValue({ orderId: "provider-open", clientOid: "client-open", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", qty: "3", cumExecQty: "3", avgPrice: "100", orderStatus: "filled", createdTime: "1789968749335" });
    vi.spyOn(BitgetClient.prototype, "getFillHistoryRead").mockResolvedValue({ list: [{ execId: "fill-open", orderId: "provider-open", clientOid: "client-open", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open_long", execQty: "3", execPrice: "100", createdTime: "1789968749337" }] });

    const first = await (TraderAgent.prototype as unknown as { reconcileLateExecution: (cycleId: string, decisionId: string) => Promise<{ status: string; experienceId: string }> }).reconcileLateExecution.call(fake, journal.cycleId, record.decision.decisionId);
    const initialContext = loadPositionContext(executor, "CRCLUSDT", "LONG");
    if (!initialContext) throw new Error("missing reconciled context fixture");
    const managementReasoning = (action: "HOLD" | "REDUCE", decisionId: string, createdAt: string): PositionReasoning => ({ action, thesis: action, strategyThesis: action, supportingFactors: [], riskFactors: [], evidenceUsed: [], lessonsUsed: [], confidence: 0.5, cycleId: "management-cycle", decisionId, createdAt });
    const hold = managementReasoning("HOLD", "hold-decision", "2026-09-21T05:40:00.000Z");
    const reduce = managementReasoning("REDUCE", "reduce-decision", "2026-09-21T05:50:00.000Z");
    const preservedContext: PositionContext = { ...initialContext, managementEvents: [hold, reduce], latestManagement: reduce, updatedAt: "2026-09-21T05:55:00.000Z" };
    savePositionContext(executor, preservedContext);
    const contextBeforeSecond = JSON.stringify(preservedContext);
    const experienceBeforeSecond = JSON.stringify(loadExperiences(executor, 100).find((experience) => experience.entryDecisionId === record.decision.decisionId));
    const performanceBeforeSecond = JSON.stringify(loadPerformanceAggregate<PerformanceAggregate>(executor));
    const eventsBeforeSecond = loadAllEvents(executor).filter((event) => event.type === "LATE_EXECUTION_RECONCILED").length;
    const second = await (TraderAgent.prototype as unknown as { reconcileLateExecution: (cycleId: string, decisionId: string) => Promise<{ status: string; experienceId: string }> }).reconcileLateExecution.call(fake, journal.cycleId, record.decision.decisionId);
    const persistedExperiences = loadExperiences(executor, 100).filter((experience) => experience.entryDecisionId === record.decision.decisionId);
    const persistedContext = loadPositionContext(executor, "CRCLUSDT", "LONG");
    const performance = loadPerformanceAggregate<PerformanceAggregate>(executor);
    const persistedJournal = loadRecentJournals(executor, 1)[0]!;
    const reconciliationEvents = loadAllEvents(executor).filter((event) => event.type === "LATE_EXECUTION_RECONCILED");

    expect(first.status).toBe("RECONCILED");
    expect(second.status).toBe("ALREADY_RECONCILED");
    expect(second.experienceId).toBe(first.experienceId);
    expect(persistedExperiences).toHaveLength(1);
    expect(persistedExperiences[0]?.experienceId).toBe(first.experienceId);
    expect(persistedExperiences[0]?.outcomeStatus).toBe("OPEN");
    expect(persistedExperiences[0]?.entryPrice).toBe("100");
    expect(persistedExperiences[0]?.entryTime).toBe("2026-09-21T05:32:29.337Z");
    expect(Number.isFinite(Date.parse(persistedExperiences[0]?.entryTime ?? ""))).toBe(true);
    expect(JSON.stringify(persistedContext)).toBe(contextBeforeSecond);
    expect(persistedContext?.managementEvents).toEqual([hold, reduce]);
    expect(persistedContext?.latestManagement).toEqual(reduce);
    expect(persistedContext?.updatedAt).toBe("2026-09-21T05:55:00.000Z");
    expect(JSON.stringify(persistedExperiences[0])).toBe(experienceBeforeSecond);
    expect(performance?.totalTrades).toBe(0);
    expect(performance?.openTrades).toBe(0);
    expect(JSON.stringify(performance)).toBe(performanceBeforeSecond);
    expect(events).toEqual(["LATE_EXECUTION_RECONCILED"]);
    expect(reconciliationEvents).toHaveLength(eventsBeforeSecond);
    expect(JSON.stringify(persistedJournal.executionRecords?.[0]?.executionResult)).toBe(originalExecution);
    expect(JSON.stringify(persistedJournal.executionRecords?.[0]?.reconciliationResult)).toBe(originalReconciliation);
    db.close();
  });

  it("rejects owner late reconciliation while runtime is not paused", async () => {
    const { db, executor } = memoryExecutor();
    const fake = {
      state: { paused: false },
      sql: executor.sql,
    } as unknown as { state: { paused: boolean } };
    await expect((TraderAgent.prototype as unknown as { reconcileLateExecution: (cycleId: string, decisionId: string) => Promise<unknown> }).reconcileLateExecution.call(fake, "cycle-runtime", "decision-open")).rejects.toThrow("AGENT_MUST_BE_PAUSED");
    db.close();
  });

  it("persists a verified execution before a later portfolio refresh failure", async () => {
    const { db, executor } = memoryExecutor();
    const record = verifiedCloseRecord();
    const decideMock = vi.mocked(decide);
    decideMock.mockResolvedValue({ plan: { positionActions: [record.decision] as CycleDecisionPlan["positionActions"], entryActions: [] }, ignoredLessonIds: [] });
    vi.mocked(executeCyclePlan).mockImplementation(async (_plan, callbacks) => {
      await callbacks.persist(record, bundle());
      await callbacks.refreshPortfolio();
      return { records: [record], finalPortfolio: undefined, stoppedAfterAmbiguity: false };
    });
    vi.spyOn(BitgetClient.prototype, "getOpenPositionSymbols").mockResolvedValue(["CRCLUSDT"]);
    vi.spyOn(BitgetClient.prototype, "getTradableInstruments").mockResolvedValue([instrument()]);
    vi.spyOn(BitgetClient.prototype, "collectLightweightScan").mockResolvedValue([]);
    vi.spyOn(BitgetClient.prototype, "collectEvidence").mockResolvedValue([bundle()]);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockRejectedValue(new Error("POST_WRITE_REFRESH_FAILURE"));

    const fake = {
      env: { TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: "USDT-FUTURES" },
      state: { emergencyStop: false, paused: false, lastCycleId: null, lastScanAt: null, nextScanAt: null, model: "", runtimeStatus: "ONLINE", currentStage: "ONLINE", lastStatus: "IDLE", lastPolicyUpdateAt: null, cycleStartedAt: null, temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: true, temporaryScanIntervalDurationMs: 0, userStorageVersion: 0 },
      ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
      activeScanIntervalMinutes: () => 5,
      setState(next: unknown) { (this as unknown as { state: unknown }).state = next; },
      recordEvent: () => undefined,
      recordPositionDiscrepancies: () => [],
      refreshPositionManagementState: () => [lifecycleState],
      reconcileLateExecutions: async () => undefined,
      collectResearchEvidence: async () => undefined,
      persistPerformanceEquity: () => undefined,
      persistDecisionOutcome: async () => undefined,
      sql: executor.sql,
    } as unknown as { state: unknown };

    await expect((TraderAgent.prototype as unknown as { runCycle: () => Promise<TradingJournal> }).runCycle.call(fake)).rejects.toThrow("POST_WRITE_REFRESH_FAILURE");
    const saved = loadRecentJournals(executor, 1)[0];
    expect(saved).toBeDefined();
    expect(saved?.cyclePlan?.positionActions).toHaveLength(1);
    expect(saved?.executionRecords).toHaveLength(1);
    expect(saved?.executionRecords?.[0]?.executionResult?.status).toBe("filled");
    expect(saved?.executionRecords?.[0]?.reconciliationResult?.status).toBe("MATCHED");
    expect(saved?.discovery?.financialWritesPerformed).toBe(1);

    const exported = buildPaperLogExport({
      generatedAt: "2026-09-21T00:01:00.000Z",
      period: { start: null, end: null },
      environment: "test",
      model: "qwen",
      version: "0.2.0",
      commit: "test",
      cycles: [{ cycleId: saved!.cycleId, status: "FAILED", startedAt: saved!.startedAt, completedAt: saved!.completedAt ?? null }],
      journals: [saved!],
      experiences: [],
      events: [],
    });
    expect(exported.cycles[0]?.status).toBe("FAILED");
    expect(exported.cycles[0]?.execution.financialWritesPerformed).toBe(1);
    expect(exported.cycles[0]?.execution.verifiedExecutions).toBe(1);
    db.close();
  });
});
