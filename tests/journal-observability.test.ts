import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadRecentJournals, saveJournal } from "../src/storage/store.js";
import type { AccountSnapshot, CycleDecisionPlan, DecisionContext, EvidenceBundle, Instrument, PositionManagementState, PositionSnapshot, TradingJournal } from "../src/types.js";

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
    vi.mocked(executeCyclePlan).mockResolvedValue({ records: [], finalPortfolio: undefined, stoppedAfterAmbiguity: false });

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
      sql: executor.sql,
    } as unknown as { state: unknown };

    const journal = await (TraderAgent.prototype as unknown as { runCycle: () => Promise<TradingJournal> }).runCycle.call(fake);
    const saved = journal as ObservableJournal;
    expect(captured.context?.positionManagementState).toBe(lifecycleStateList);
    expect(saved.positionManagementState).toBe(lifecycleStateList);
    expect(saved.positionManagementState).toEqual([lifecycleState]);
    expect(saved.promptVersions).toEqual({ mandate: "darwin-mandate-v7", decision: "darwin-decision-v9" });
    expect((loadRecentJournals(executor, 1)[0] as ObservableJournal).positionManagementState).toEqual(captured.context?.positionManagementState);
    db.close();
  });
});
