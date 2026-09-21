import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadRecentJournals, saveJournal } from "../src/storage/store.js";
import { buildPaperLogExport } from "../src/storage/paper-log.js";
import type { AccountSnapshot, CycleDecisionPlan, DecisionContext, DecisionExecutionRecord, EvidenceBundle, Instrument, PositionManagementState, PositionSnapshot, TradingJournal } from "../src/types.js";

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

function memoryExecutor(): { db: DatabaseSync; executor: SqlExecutor } {
  const db = new DatabaseSync(":memory:");
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      const sqliteValues = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[];
      if (query.trimStart().toUpperCase().startsWith("SELECT")) return db.prepare(query).all(...sqliteValues) as T[];
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

describe("journal observability persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
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
