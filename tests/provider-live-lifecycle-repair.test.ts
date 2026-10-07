import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { hasEvent, loadAllEvents, loadAllExperiences, loadPositionContext, saveExperience, saveJournal, savePositionContext } from "../src/storage/store.js";
import { loadProviderLiveOpeningOrderIdentities, providerLivePositionLifecycleKey } from "../src/storage/provider-ledger.js";
import { TraderAgent } from "../src/agent/agent.js";
import { darwinLifecycleExperienceId, isDarwinOwnedExperience } from "../src/agent/provider-live-lifecycle.js";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import { decide } from "../src/agent/decision.js";
import { executeCyclePlan } from "../src/trading/execution-planner.js";
import { BitgetClient } from "../src/bitget/client.js";
import type { AccountSnapshot, Action, Decision, DecisionExecutionRecord, EvidenceBundle, Instrument, PositionSnapshot, RuntimeConfig, TradeExperience, TradingJournal } from "../src/types.js";

// A deterministically attributed DARWIN position must be reconstructed as a local lifecycle
// *before* decisions and risk checks run, with identity rather than symbol+side proving
// ownership, and with a REDUCE's remaining state taken from authoritative post-execution readback.

vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
vi.mock("../src/trading/execution-planner.js", () => ({ executeCyclePlan: vi.fn() }));
vi.mock("../src/agent/decision.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/decision.js")>("../src/agent/decision.js");
  return { ...actual, decide: vi.fn() };
});

const CYCLE_ID = "cycle-repair";
const OBSERVED_AT = "2026-10-07T17:00:00.000Z";
const OPENED_AT = "2026-10-05T14:25:48.407Z";
const CATEGORY = "USDT-FUTURES";
const THESIS = "COIN shows accelerating bullish momentum with consecutive higher closes";

function memoryExecutor(db = new DatabaseSync(":memory:")): { db: DatabaseSync; executor: SqlExecutor } {
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      const params = values.map((value) => typeof value === "boolean" ? Number(value) : value) as (string | number | null)[];
      if (query.trimStart().toUpperCase().startsWith("SELECT")) return db.prepare(query).all(...params) as T[];
      db.prepare(query).run(...params);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor };
}

function fakeAgent(executor: SqlExecutor, db: DatabaseSync) {
  return {
    sql: executor.sql,
    env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_CATEGORY: CATEGORY },
    state: { paused: false, runtimeStatus: "ONLINE" },
    ctx: { storage: { transactionSync: <T>(closure: () => T) => { db.exec("BEGIN IMMEDIATE"); try { const value = closure(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } } } },
    ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
    repairMissingDarwinLifecycles: (TraderAgent.prototype as unknown as { repairMissingDarwinLifecycles: (...args: unknown[]) => TradeExperience[] }).repairMissingDarwinLifecycles,
    prepareDarwinLifecycleRepair: (TraderAgent.prototype as unknown as { prepareDarwinLifecycleRepair: (...args: unknown[]) => unknown }).prepareDarwinLifecycleRepair,
    persistDecisionOutcome: (TraderAgent.prototype as unknown as { persistDecisionOutcome: (...args: unknown[]) => Promise<unknown> }).persistDecisionOutcome,
    recordEvent: (TraderAgent.prototype as unknown as { recordEvent: (type: string, cycleId: string, metadata?: Record<string, string>) => void }).recordEvent,
    recordPositionDiscrepancies: (TraderAgent.prototype as unknown as { recordPositionDiscrepancies: (...args: unknown[]) => string[] }).recordPositionDiscrepancies,
    updatePositionContext: vi.fn(),
    updatePerformanceReadModel: vi.fn(),
  };
}

type PositionOverride = { openedAt?: string | undefined } & Partial<Omit<PositionSnapshot, "openedAt">>;

function position(overrides: PositionOverride = {}): PositionSnapshot {
  const { openedAt, ...rest } = overrides;
  const resolved = "openedAt" in overrides ? openedAt : OPENED_AT;
  return {
    symbol: "COINUSDT", positionSide: "LONG", quantity: "12.05", notional: "2157",
    marginAllocated: "720", leverage: "3", entryPrice: "190.81", unrealizedPnl: "0",
    realizedPnl: "0", markPrice: "190.81",
    ...(resolved === undefined ? {} : { openedAt: resolved }),
    ...rest,
  };
}

/** Seed the deterministic DARWIN opening identity that ties a live position to an entry decision. */
function seedDarwinOpeningIdentity(executor: SqlExecutor, options: { symbol?: string; decisionId?: string; providerOrderId?: string; oid?: string; openedAt?: string; includeEntryDecision?: boolean; entryThesis?: string; entryCycleId?: string } = {}): { decisionId: string; providerOrderId: string } {
  const symbol = options.symbol ?? "COINUSDT";
  const decisionId = options.decisionId ?? "decision-entry";
  const providerOrderId = options.providerOrderId ?? "1491009757156626432";
  const oid = options.oid ?? "darwin-entry-oid";
  const openedAt = options.openedAt ?? OPENED_AT;
  const entryCycleId = options.entryCycleId ?? "cycle-entry";
  executor.sql`INSERT INTO idempotency (client_order_id, cycle_id, decision_id, provider_order_id, created_at) VALUES (${oid}, ${entryCycleId}, ${decisionId}, ${providerOrderId}, ${openedAt})`;
  executor.sql`INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (${providerOrderId}, ${oid}, ${CATEGORY}, ${symbol}, ${"buy"}, ${"long"}, ${"open"}, ${"12.05"}, ${"12.05"}, ${"filled"}, ${openedAt}, ${openedAt}, ${"DARWIN"}, ${"{}"}, ${openedAt}, ${openedAt})`;
  executor.sql`INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (${`fill-${providerOrderId}`}, ${providerOrderId}, ${oid}, ${CATEGORY}, ${symbol}, ${"buy"}, ${"long"}, ${"open"}, ${"12.05"}, ${"190.81"}, ${openedAt}, ${"DARWIN"}, ${"{}"}, ${openedAt}, ${openedAt})`;
  if (options.includeEntryDecision !== false) {
    const entryDecision = { ...decision("OPEN_LONG"), decisionId, cycleId: entryCycleId, symbol, createdAt: openedAt, thesis: options.entryThesis ?? THESIS };
    const [existingJournalRow] = executor.sql<{ payload: string }>`SELECT payload FROM journals WHERE cycle_id = ${entryCycleId} LIMIT 1`;
    const existingJournal = existingJournalRow ? JSON.parse(existingJournalRow.payload) as TradingJournal : undefined;
    saveJournal(executor, {
      ...(existingJournal ?? {} as TradingJournal),
      cycleId: entryCycleId, agentVersion: "test", promptVersion: "test", model: "test", mode: "AUTONOMOUS",
      startedAt: openedAt, completedAt: openedAt, retrievedLessons: [], createdLessons: [],
      cyclePlan: { positionActions: [], entryActions: [...(existingJournal?.cyclePlan?.entryActions ?? []), entryDecision as never] },
    });
  }
  return { decisionId, providerOrderId };
}

/** The real cycle-phase repair, driven exactly as runCycle drives it. */
function runRepair(agent: ReturnType<typeof fakeAgent>, executor: SqlExecutor, positions: readonly PositionSnapshot[]) {
  const identities = loadProviderLiveOpeningOrderIdentities(executor, CATEGORY, positions, "/api/runCycle");
  const experiences = loadAllExperiences(executor);
  const repaired = agent.repairMissingDarwinLifecycles(experiences, positions, identities, CYCLE_ID, OBSERVED_AT);
  const attributedLivePositionKeys = new Map<string, { decisionId: string; providerOrderId: string }>();
  for (const candidate of positions) {
    const identity = identities.get(providerLivePositionLifecycleKey(candidate));
    if (identity) attributedLivePositionKeys.set(providerLivePositionLifecycleKey(candidate), identity);
  }
  const discrepancies = agent.recordPositionDiscrepancies(loadAllExperiences(executor), positions, CYCLE_ID, attributedLivePositionKeys);
  return { repaired, discrepancies, experiences: loadAllExperiences(executor) };
}

function auditEvents(executor: SqlExecutor, type: string): Array<Record<string, string>> {
  return executor.sql<{ payload: string }>`SELECT payload FROM events WHERE event_type = ${type}`
    .map((row) => (JSON.parse(row.payload) as { metadata?: Record<string, string> }).metadata ?? {});
}

// ---------------------------------------------------------------------------
// Real scheduled-cycle harness. Only the network-facing seams are stubbed; the repair, the
// discrepancy audit, and the cycle ordering all run the real implementations.
// ---------------------------------------------------------------------------
interface CycleObservation {
  repairCalledBeforeDecision: boolean;
  decisionsAtRepairTime: string[];
  discrepancies: string[];
  ordersSubmitted: string[];
}

function cycleAgent(executor: SqlExecutor, db: DatabaseSync) {
  return {
    env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: CATEGORY },
    state: { emergencyStop: false, paused: false, lastCycleId: null, lastScanAt: null, nextScanAt: null, model: "", runtimeStatus: "ONLINE", currentStage: "ONLINE", lastStatus: "IDLE", lastPolicyUpdateAt: null, cycleStartedAt: null, temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: true, temporaryScanIntervalDurationMs: 0, userStorageVersion: 0 },
    sql: executor.sql,
    ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
    activeScanIntervalMinutes: () => 5,
    setState(next: unknown) { (this as unknown as { state: unknown }).state = next; },
    recordEvent: () => undefined,
    // Real implementations: repair ordering and identity matching are what is under test.
    repairMissingDarwinLifecycles: (TraderAgent.prototype as unknown as { repairMissingDarwinLifecycles: (...args: unknown[]) => TradeExperience[] }).repairMissingDarwinLifecycles,
    prepareDarwinLifecycleRepair: (TraderAgent.prototype as unknown as { prepareDarwinLifecycleRepair: (...args: unknown[]) => unknown }).prepareDarwinLifecycleRepair,
    recordPositionDiscrepancies: (TraderAgent.prototype as unknown as { recordPositionDiscrepancies: (...args: unknown[]) => string[] }).recordPositionDiscrepancies,
    refreshPositionManagementState: () => [],
    reconcileLateExecutions: async () => undefined,
    collectResearchEvidence: async () => undefined,
    persistPerformanceEquity: () => undefined,
    persistDecisionOutcome: async () => undefined,
    ctx: { storage: { transactionSync: <T>(closure: () => T) => { db.exec("BEGIN IMMEDIATE"); try { const value = closure(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } } } },
  } as unknown as { state: unknown };
}

async function runRealCycle(agent: ReturnType<typeof cycleAgent>, executor: SqlExecutor, positions: readonly PositionSnapshot[]): Promise<CycleObservation> {
  const observation: CycleObservation = { repairCalledBeforeDecision: false, decisionsAtRepairTime: [], discrepancies: [], ordersSubmitted: [] };
  const portfolio = { ...account(), positions: positions.map((entry) => ({ ...entry, notional: entry.notional, marginAllocated: entry.marginAllocated, unrealizedPnl: "0", realizedPnl: "0" })) } as unknown as AccountSnapshot;

  vi.mocked(decide).mockImplementation(async (_config, context) => {
    // The decision phase runs after the repair; record what the cycle already knew by then.
    observation.discrepancies = [];
    observation.decisionsAtRepairTime = context.openExperiences.map((experience) => experience.experienceId);
    return { plan: { positionActions: [], entryActions: [] }, ignoredLessonIds: [] } as never;
  });
  vi.mocked(executeCyclePlan).mockImplementation(async () => ({ records: [], finalPortfolio: undefined, stoppedAfterAmbiguity: false }));

  vi.spyOn(BitgetClient.prototype, "getOpenPositionSymbols").mockResolvedValue([]);
  vi.spyOn(BitgetClient.prototype, "getTradableInstruments").mockResolvedValue([instrument]);
  vi.spyOn(BitgetClient.prototype, "collectLightweightScan").mockResolvedValue([]);
  vi.spyOn(BitgetClient.prototype, "collectSymbolMarketEvidence").mockResolvedValue({ bundles: [bundle()], unavailable: [] });
  vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue(portfolio);

  const repair = (TraderAgent.prototype as unknown as { repairMissingDarwinLifecycles: (...args: unknown[]) => TradeExperience[] }).repairMissingDarwinLifecycles;
  const discrepancies = (TraderAgent.prototype as unknown as { recordPositionDiscrepancies: (...args: unknown[]) => string[] }).recordPositionDiscrepancies;
  // Wrap the real methods so ordering is observed while the real logic still runs.
  (agent as unknown as Record<string, unknown>).repairMissingDarwinLifecycles = (...args: unknown[]) => {
    observation.repairCalledBeforeDecision = vi.mocked(decide).mock.calls.length === 0;
    return repair.apply(agent, args as never);
  };
  (agent as unknown as Record<string, unknown>).recordPositionDiscrepancies = (...args: unknown[]) => {
    const result = discrepancies.apply(agent, args as never);
    observation.discrepancies = result;
    return result;
  };

  await (TraderAgent.prototype as unknown as { runCycle: () => Promise<TradingJournal> }).runCycle.call(agent);
  observation.ordersSubmitted = auditEvents(executor, "PAPER_ORDER_SUBMITTED").map((event) => event.symbol ?? "");
  return observation;
}

// ---------------------------------------------------------------------------
// Risk gate fixtures
// ---------------------------------------------------------------------------
const config: RuntimeConfig = {
  tradingMode: "PAPER", agentMode: "AUTONOMOUS",
  ownerPolicy: { paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false },
  evidenceMaxAgeSeconds: 90, bitgetCategory: CATEGORY, bitgetApiBaseUrl: "https://api.bitget.com",
  qwenBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", qwenModel: "qwen3.8-max",
};
const instrument: Instrument = { symbol: "COINUSDT", category: CATEGORY, baseCoin: "COIN", quoteCoin: "USDT", marginCoin: "USDT", symbolType: "crypto", isRwa: "NO", status: "online", minOrderQty: "0.001", maxOrderQty: "100", minOrderAmount: "10", pricePrecision: 2, quantityPrecision: 3, quantityStep: "0.001", leverageMin: "1", leverageMax: "10" };

function account(): AccountSnapshot {
  return {
    balance: "1000", availableBalance: "1000", availableMargin: "1000", marginUsage: "0",
    positionNotional: "2157", totalPositionNotional: "2157", positionQuantity: "12.05",
    portfolioEquity: "1000",
    positions: [{ symbol: "COINUSDT", positionSide: "LONG", quantity: "12.05", notional: "2157", marginAllocated: "720", leverage: "3", entryPrice: "190.81", unrealizedPnl: "0", realizedPnl: "0" }],
    realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [], observedAt: OBSERVED_AT,
  } as unknown as AccountSnapshot;
}

function decision(action: Action): Decision {
  return {
    decisionId: `decision-${action}`, cycleId: CYCLE_ID, action, positionSide: "LONG", symbol: "COINUSDT",
    marginAllocationPct: "10", additionalMarginPct: action === "INCREASE" ? "5" : null, leverage: "3",
    reductionPct: action === "REDUCE" ? "50" : null, targetPositionSide: action === "REVERSE" ? "SHORT" : null,
    confidence: 0.7, thesis: "t", strategyThesis: "s", supportingFactors: ["f"], riskFactors: ["r"],
    evidenceUsed: ["TICKER"], lessonsUsed: [], createdAt: OBSERVED_AT,
  } as Decision;
}

function gate(action: Action, discrepancies: string[], overrides: Record<string, unknown> = {}) {
  return evaluateRiskGate(config, {
    decision: decision(action),
    instrument,
    account: account(),
    market: { symbol: "COINUSDT", lastPrice: "190.81", bidPrice: "190.80", askPrice: "190.82", priceChange24h: "0", volume24h: "100", observedAt: OBSERVED_AT },
    evidenceObservedAt: OBSERVED_AT,
    openOrderSymbols: [],
    supportedUniverse: ["COINUSDT"],
    emergencyStop: false,
    dailyDrawdownBlocked: false,
    positionDiscrepancies: discrepancies,
    now: new Date(OBSERVED_AT),
    ...overrides,
  } as never);
}

function bundle(): EvidenceBundle {
  return {
    market: { symbol: "COINUSDT", lastPrice: "190.81", bidPrice: "190.80", askPrice: "190.82", priceChange24h: "0", volume24h: "100", observedAt: OBSERVED_AT },
    evidence: [{ type: "TICKER", observedAt: OBSERVED_AT }],
    marketRegime: "VOLATILITY_EXPANSION",
    instrument,
    account: account(),
  } as unknown as EvidenceBundle;
}

async function persist(agent: ReturnType<typeof fakeAgent>, executionRecord: DecisionExecutionRecord, experiences: unknown[] = []) {
  const journal = { cycleId: CYCLE_ID, experienceIds: [] as string[], createdLessons: [] as string[] } as unknown as TradingJournal;
  await agent.persistDecisionOutcome.call(agent, { tradingMode: "PAPER" } as never, executionRecord, bundle(), experiences as never, [] as never, CYCLE_ID, OBSERVED_AT, journal, false);
  return journal;
}

type RecordOverride = { positionAfter?: PositionSnapshot | undefined } & Partial<Omit<DecisionExecutionRecord, "positionAfter">>;

function managementRecord(action: "CLOSE" | "REDUCE", overrides: RecordOverride = {}): DecisionExecutionRecord {
  return {
    decision: {
      decisionId: "decision-mgmt-1", cycleId: CYCLE_ID, action, positionSide: "LONG", symbol: "COINUSDT",
      marginAllocationPct: "0", additionalMarginPct: null, leverage: "3",
      reductionPct: action === "REDUCE" ? "50" : null, targetPositionSide: null, confidence: 0.7,
      thesis: "manage live position", strategyThesis: "reduce risk", supportingFactors: ["f"], riskFactors: ["r"],
      evidenceUsed: ["TICKER"], lessonsUsed: [], createdAt: OBSERVED_AT,
    },
    riskGateResult: { status: "PASS", codes: [], checkedAt: OBSERVED_AT },
    positionBefore: position(),
    executionResult: {
      provider: "BITGET", providerOrderId: "provider-mgmt-order", clientOrderId: "darwin-mgmt-oid", symbol: "COINUSDT",
      action, positionSide: "LONG", providerSide: "sell", tradeSide: "close", marginAllocated: "360", leverage: "3",
      positionNotional: "1078", requestedQuantity: "6.02", executedQuantity: "6.02", status: "filled",
      submittedAt: OBSERVED_AT, readBackAt: OBSERVED_AT, averageFillPrice: "185.00", realizedPnl: "-35.00", realizedPnlPct: "-3.0",
    },
    reconciliationResult: { status: "MATCHED", codes: [], checkedAt: OBSERVED_AT },
    ...overrides,
    ...("positionAfter" in overrides ? {} : { positionAfter: undefined }),
  } as unknown as DecisionExecutionRecord;
}

const LIVE_PRODUCTION_POSITIONS = [
  { symbol: "CRCLUSDT", providerOrderId: "1490493208880631808" },
  { symbol: "SPCXUSDT", providerOrderId: "1491008302198706231" },
  { symbol: "COINUSDT", providerOrderId: "1491009757156626432" },
] as const;

describe("missing DARWIN lifecycle repair before decision", () => {
  it("1. repairs a deterministic DARWIN position before any financial management execution", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);

    const { repaired, discrepancies, experiences } = runRepair(agent, executor, [position()]);

    // Repaired with no CLOSE/REDUCE ever executed.
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.experienceId).toBe(darwinLifecycleExperienceId(identity.decisionId));
    expect(repaired[0]!.origin).toBe("DARWIN");
    expect(repaired[0]!.entryDecisionId).toBe(identity.decisionId);
    expect(repaired[0]!.providerOrderId).toBe(identity.providerOrderId);
    expect(repaired[0]!.entryTime).toBe(OPENED_AT);
    expect(repaired[0]!.entryPrice).toBe("190.81");
    expect(repaired[0]!.outcomeStatus).toBe("OPEN");
    // The lifecycle is resolved, so it is no longer an unresolved gap for this position.
    expect(discrepancies).not.toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    expect(experiences).toHaveLength(1);
    db.close();
  });

  it("1b. runCycle itself repairs before decision and risk execution", async () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const agent = cycleAgent(executor, db);

    // Repair is invoked by the real scheduled cycle, before the decision phase begins.
    const seen = await runRealCycle(agent, executor, [position()]);

    expect(seen.repairCalledBeforeDecision).toBe(true);
    // By the time decisions are generated, the repaired lifecycle is already in context.
    expect(seen.decisionsAtRepairTime).toEqual([darwinLifecycleExperienceId(identity.decisionId)]);
    // The repaired lifecycle exists and the position is no longer an unresolved gap.
    const saved = loadAllExperiences(executor);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.experienceId).toBe(darwinLifecycleExperienceId(identity.decisionId));
    expect(saved[0]!.origin).toBe("DARWIN");
    expect(seen.discrepancies).not.toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    // No financial action was required to cause the repair.
    expect(seen.ordersSubmitted).toEqual([]);
    db.close();
  });

  it("1c. runCycle excludes stale same-side DARWIN OPEN records from Qwen context", async () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    saveExperience(executor, {
      experienceId: "stale-darwin-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "stale-entry", entryPrice: "190.81", entryTime: OPENED_AT, exitDecisionId: "", exitPrice: "0", exitTime: "",
      selectedLeverage: "3", marginAllocationPct: "10", marginAllocated: "700", positionNotional: "2100", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
      entryThesis: "historical stale record", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [], lessonsUsed: [], marketContext: "UNKNOWN", outcomeStatus: "OPEN", origin: "DARWIN",
    } as unknown as TradeExperience, OBSERVED_AT);
    const seen = await runRealCycle(cycleAgent(executor, db), executor, [position()]);
    expect(seen.decisionsAtRepairTime).toEqual([darwinLifecycleExperienceId(identity.decisionId)]);
    expect(seen.decisionsAtRepairTime).not.toContain("stale-darwin-open");
    db.close();
  });

  it("1d. an external live position cannot inherit a stale same-side DARWIN experience", async () => {
    const { db, executor } = memoryExecutor();
    saveExperience(executor, {
      experienceId: "stale-darwin-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "stale-entry", entryPrice: "190.81", entryTime: OPENED_AT, exitDecisionId: "", exitPrice: "0", exitTime: "",
      selectedLeverage: "3", marginAllocationPct: "10", marginAllocated: "700", positionNotional: "2100", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
      entryThesis: "historical stale record", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [], lessonsUsed: [], marketContext: "UNKNOWN", outcomeStatus: "OPEN", origin: "DARWIN",
    } as unknown as TradeExperience, OBSERVED_AT);
    const seen = await runRealCycle(cycleAgent(executor, db), executor, [position()]);
    expect(seen.decisionsAtRepairTime).toEqual([]);
    db.close();
  });

  it("1e. repairs unknown excursion metrics without claiming zero or since-entry history", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const { repaired } = runRepair(fakeAgent(executor, db), executor, [position()]);
    expect(repaired[0]).toMatchObject({ maximumFavorableExcursion: "UNAVAILABLE", maximumAdverseExcursion: "UNAVAILABLE" });
    expect(repaired[0]).not.toHaveProperty("maximumFavorableExcursionBasis");
    db.close();
  });

  it("1e2. sparse repaired history preserves its observed peak with first-observation scope", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const { repaired } = runRepair(agent, executor, [position()]);
    const refresh = (TraderAgent.prototype as unknown as { refreshPositionManagementState: (...args: unknown[]) => unknown[] }).refreshPositionManagementState;
    const positionSnapshot = position({ markPrice: "106", unrealizedPnl: "91.26" });
    const lifecycleHistory = [{
      cycleId: "cycle-observed-peak", agentVersion: "test", promptVersion: "test", model: "test", mode: "AUTONOMOUS" as const,
      startedAt: "2026-10-06T17:00:00.000Z", completedAt: "2026-10-06T17:00:01.000Z",
      portfolio: { positions: [{ symbol: "COINUSDT", positionSide: "LONG", quantity: "12.05" }], observedAt: "2026-10-06T17:00:00.000Z" } as never,
      marketContext: { deep: [{ market: { symbol: "COINUSDT", lastPrice: "210", observedAt: "2026-10-06T17:00:00.000Z" } }] },
      retrievedLessons: [], createdLessons: [],
    }] as TradingJournal[];
    const refreshBundle = { ...bundle(), market: { ...bundle().market, lastPrice: "202", observedAt: OBSERVED_AT } };
    const identities = new Map([[providerLivePositionLifecycleKey(positionSnapshot), identity]]);
    const states = refresh.call(agent, repaired, [positionSnapshot], [refreshBundle], OBSERVED_AT, lifecycleHistory, identities) as Array<{ maximumFavorableReturnPct: number; maximumFavorableReturnBasis: string; profitGivebackPct: number }>;
    expect(states[0]?.maximumFavorableReturnPct).toBeGreaterThan(10);
    expect(states[0]).toMatchObject({ maximumFavorableReturnBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
    expect(states[0]?.profitGivebackPct).toBeGreaterThan(0);
    expect(loadAllExperiences(executor)[0]).toMatchObject({ maximumFavorableExcursionBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
    expect(Number(loadAllExperiences(executor)[0]!.maximumFavorableExcursion)).toBeGreaterThan(10);
    expect(loadAllExperiences(executor)[0]!.maximumFavorableExcursionBasis).not.toBe("SINCE_ENTRY");
    db.close();
  });

  it("1e3. unproven repaired history stays unknown and is excluded from profit-giveback state", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const { repaired } = runRepair(agent, executor, [position()]);
    const refresh = (TraderAgent.prototype as unknown as { refreshPositionManagementState: (...args: unknown[]) => unknown[] }).refreshPositionManagementState;
    const currentPosition = position({ markPrice: "202" });
    const identities = new Map([[providerLivePositionLifecycleKey(currentPosition), identity]]);
    const states = refresh.call(agent, repaired, [currentPosition], [bundle()], OBSERVED_AT, [], identities);
    expect(states).toEqual([]);
    expect(loadAllExperiences(executor)[0]).toMatchObject({ maximumFavorableExcursion: "UNAVAILABLE", maximumAdverseExcursion: "UNAVAILABLE" });
    expect(loadAllExperiences(executor)[0]).not.toHaveProperty("maximumFavorableExcursionBasis");
    db.close();
  });

  it("1e. repair does not map unrealized PnL percentage to realized PnL percentage", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const { repaired } = runRepair(fakeAgent(executor, db), executor, [position({ unrealizedPnlPct: "12.5" })]);
    expect(repaired[0]!.realizedPnlPct).toBe("UNAVAILABLE");
    expect(repaired[0]!.outcomeStatus).toBe("OPEN");
    expect(["PROFITABLE", "LOSING", "BREAK_EVEN"]).not.toContain(repaired[0]!.outcomeStatus);
    db.close();
  });

  it("1f. repairs the current PositionContext from the exact persisted entry Decision", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const { repaired } = runRepair(fakeAgent(executor, db), executor, [position()]);
    const experience = repaired[0]!;
    const context = loadPositionContext(executor, "COINUSDT", "LONG");
    expect(context).toMatchObject({
      symbol: experience.symbol,
      positionSide: experience.positionSide,
      experienceId: experience.experienceId,
      entryDecisionId: identity.decisionId,
      lifecycleStatus: "OPEN",
      updatedAt: OBSERVED_AT,
    });
    expect(context?.entryReasoning).toEqual({
      action: "OPEN_LONG", thesis: THESIS, strategyThesis: "s", supportingFactors: ["f"], riskFactors: ["r"],
      evidenceUsed: ["TICKER"], lessonsUsed: [], confidence: 0.7, cycleId: "cycle-entry",
      decisionId: identity.decisionId, createdAt: OPENED_AT, additionalMarginPct: null, targetPositionSide: null,
      entryPrice: experience.entryPrice, entryTime: experience.entryTime, experienceId: experience.experienceId,
    });
    expect(context).not.toHaveProperty("closedAt");
    expect(context).not.toHaveProperty("closedProviderPositionHistoryId");
    db.close();
  });

  it("1g. an existing context for the exact entry keeps its management history and clears stale closed markers", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const oldExperienceId = "old-experience-key";
    const oldReasoning = { action: "OPEN_LONG" as const, thesis: "t", strategyThesis: "s", supportingFactors: ["f"], riskFactors: ["r"], evidenceUsed: ["TICKER"], lessonsUsed: [], confidence: 0.7, cycleId: "cycle-entry", decisionId: identity.decisionId, createdAt: OPENED_AT, experienceId: oldExperienceId };
    const managementEvent = { ...oldReasoning, action: "REDUCE" as const, decisionId: "existing-management" };
    savePositionContext(executor, { symbol: "COINUSDT", positionSide: "LONG", experienceId: oldExperienceId, entryDecisionId: identity.decisionId, entryReasoning: oldReasoning, managementEvents: [managementEvent], lifecycleStatus: "CLOSED", closedAt: OBSERVED_AT, closedProviderPositionHistoryId: "stale-history", updatedAt: OPENED_AT });
    const { repaired } = runRepair(fakeAgent(executor, db), executor, [position()]);
    const context = loadPositionContext(executor, "COINUSDT", "LONG");
    expect(context).toMatchObject({ experienceId: repaired[0]!.experienceId, entryDecisionId: identity.decisionId, lifecycleStatus: "OPEN", managementEvents: [managementEvent], updatedAt: OBSERVED_AT });
    expect(context?.entryReasoning).toMatchObject({ decisionId: identity.decisionId, experienceId: repaired[0]!.experienceId, thesis: THESIS });
    expect(context).not.toHaveProperty("closedAt");
    expect(context).not.toHaveProperty("closedProviderPositionHistoryId");
    db.close();
  });

  it("1h. missing persisted reasoning leaves the lifecycle incomplete without fabricating either read model", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor, { includeEntryDecision: false });
    const result = runRepair(fakeAgent(executor, db), executor, [position()]);
    expect(result.repaired).toEqual([]);
    expect(result.experiences).toEqual([]);
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toBeNull();
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIR_INCOMPLETE")).toMatchObject([{ reason: "PERSISTED_ENTRY_DECISION_UNAVAILABLE" }]);
    expect(result.discrepancies).toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    expect(gate("INCREASE", result.discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("1h2. a persisted entry Decision with blank reasoning is incomplete and blocks exposure increases", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor, { entryThesis: "" });
    const result = runRepair(fakeAgent(executor, db), executor, [position()]);
    expect(result.repaired).toEqual([]);
    expect(result.experiences).toEqual([]);
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toBeNull();
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIR_INCOMPLETE")).toMatchObject([{ reason: "PERSISTED_ENTRY_REASONING_UNAVAILABLE" }]);
    expect(gate("INCREASE", result.discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("1h3. a persisted entry Decision without a cycle identity is incomplete and blocks exposure increases", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor, { entryCycleId: "" });
    const result = runRepair(fakeAgent(executor, db), executor, [position()]);
    expect(result.repaired).toEqual([]);
    expect(result.experiences).toEqual([]);
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toBeNull();
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIR_INCOMPLETE")).toMatchObject([{ reason: "PERSISTED_ENTRY_REASONING_UNAVAILABLE" }]);
    expect(gate("INCREASE", result.discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("1i. a stale same-symbol/side PositionContext is not adopted and blocks increases", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const first = runRepair(fakeAgent(executor, db), executor, [position()]);
    const existingExperience = first.repaired[0]!;
    const stale = { symbol: "COINUSDT", positionSide: "LONG" as const, experienceId: "stale-exp", entryDecisionId: "old-entry", entryReasoning: { action: "OPEN_LONG" as const, thesis: "old", strategyThesis: "old", supportingFactors: [], riskFactors: [], evidenceUsed: [], lessonsUsed: [], confidence: 0.5, cycleId: "old-cycle", decisionId: "old-entry", experienceId: "stale-exp", createdAt: OPENED_AT }, managementEvents: [], lifecycleStatus: "CLOSED" as const, closedAt: OBSERVED_AT, closedProviderPositionHistoryId: "old-history", updatedAt: OPENED_AT };
    savePositionContext(executor, stale);
    const result = runRepair(fakeAgent(executor, db), executor, [position()]);
    expect(result.repaired).toEqual([]);
    expect(result.experiences).toContainEqual(existingExperience);
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toEqual(stale);
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT")).toMatchObject([{ expectedEntryDecisionId: identity.decisionId, existingEntryDecisionId: "old-entry" }]);
    expect(result.discrepancies).toContain("POSITION_CONTEXT_IDENTITY_UNRESOLVED:COINUSDT:LONG");
    expect(gate("INCREASE", result.discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("1j. experience, context and repair event roll back together when the audit write fails", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const originalSql = agent.sql;
    agent.sql = ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => {
      const query = strings.join("?");
      if (query.includes("INSERT INTO events")) throw new Error("TEST_AUDIT_WRITE_FAILURE");
      return originalSql(strings, ...values);
    }) as typeof agent.sql;
    const identities = loadProviderLiveOpeningOrderIdentities(executor, CATEGORY, [position()], "/api/runCycle");
    expect(() => agent.repairMissingDarwinLifecycles.call(agent, [], [position()], identities, CYCLE_ID, OBSERVED_AT)).toThrow("TEST_AUDIT_WRITE_FAILURE");
    expect(loadAllExperiences(executor)).toEqual([]);
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toBeNull();
    expect(loadAllEvents(executor).filter((event) => event.type === "DARWIN_LIFECYCLE_REPAIRED")).toEqual([]);
    db.close();
  });

  it("2. requires no CLOSE or REDUCE to occur, and records no financial write", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const before = executor.sql<{ count: number }>`SELECT COUNT(*) AS count FROM idempotency`;
    runRepair(agent, executor, [position()]);
    // Repair writes only the experience and its audit event: no order, no idempotency row.
    expect(executor.sql<{ count: number }>`SELECT COUNT(*) AS count FROM idempotency`[0]!.count).toBe(before[0]!.count);
    expect(auditEvents(executor, "PAPER_ORDER_SUBMITTED")).toHaveLength(0);
    expect(executor.sql<{ count: number }>`SELECT COUNT(*) AS count FROM provider_orders WHERE origin = 'PROVIDER_EXTERNAL'`[0]!.count).toBe(0);
    db.close();
  });

  it("2b. records the repair with an explicit reason and is idempotent by event id", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    runRepair(agent, executor, [position()]);

    const events = auditEvents(executor, "DARWIN_LIFECYCLE_REPAIRED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "MISSING_LOCAL_OPEN_PROVIDER_IDENTITY_MATCHED",
      origin: "DARWIN",
      entryDecisionId: identity.decisionId,
      lifecycleOpeningOrderId: identity.providerOrderId,
      experienceId: darwinLifecycleExperienceId(identity.decisionId),
    });
    expect(hasEvent(executor, `darwin-lifecycle-repair:${identity.decisionId}`)).toBe(true);
    db.close();
  });

  it("3. lets a repaired DARWIN lifecycle pass the lifecycle gate for INCREASE", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const { discrepancies } = runRepair(agent, executor, [position()]);
    expect(gate("INCREASE", discrepancies).codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("4. lets a repaired DARWIN lifecycle reach REVERSE lifecycle handling", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const { discrepancies } = runRepair(agent, executor, [position()]);
    expect(gate("REVERSE", discrepancies).codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("5. repairs the three deterministic production identities without any REDUCE or CLOSE", () => {
    const { db, executor } = memoryExecutor();
    for (const live of LIVE_PRODUCTION_POSITIONS) {
      seedDarwinOpeningIdentity(executor, {
        symbol: live.symbol,
        decisionId: `decision-entry-${live.symbol}`,
        providerOrderId: live.providerOrderId,
        oid: `darwin-entry-oid-${live.symbol}`,
      });
    }
    const agent = fakeAgent(executor, db);
    const positions = LIVE_PRODUCTION_POSITIONS.map((live) => position({ symbol: live.symbol }));
    const { repaired } = runRepair(agent, executor, positions);

    expect(repaired).toHaveLength(3);
    for (const live of LIVE_PRODUCTION_POSITIONS) {
      const row = loadAllExperiences(executor).find((experience) => experience.symbol === live.symbol);
      expect(row?.origin).toBe("DARWIN");
      expect(row?.providerOrderId).toBe(live.providerOrderId);
      expect(row?.outcomeStatus).toBe("OPEN");
      expect(row?.entryThesis).toBe(THESIS);
      expect(loadPositionContext(executor, live.symbol, "LONG")).toMatchObject({
        symbol: live.symbol,
        positionSide: "LONG",
        experienceId: row?.experienceId,
        entryDecisionId: `decision-entry-${live.symbol}`,
        lifecycleStatus: "OPEN",
        entryReasoning: expect.objectContaining({ decisionId: `decision-entry-${live.symbol}`, thesis: THESIS }),
      });
    }
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIRED")).toHaveLength(3);
    expect(auditEvents(executor, "PROVIDER_EXTERNAL_MANAGEMENT_RECORDED")).toHaveLength(0);
    db.close();
  });

  it("6. is idempotent across repeated natural cycles and worker reload", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);

    // Three successive cycles, each reloading persisted state exactly as a restarted worker would.
    // The first cycle repairs; later cycles must find nothing left to repair.
    const first = runRepair(agent, executor, [position()]);
    expect(first.repaired).toHaveLength(1);
    const firstContext = loadPositionContext(executor, "COINUSDT", "LONG");
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const reloadedAgent = fakeAgent(executor, db);
      const { repaired } = runRepair(reloadedAgent, executor, [position()]);
      expect(repaired).toHaveLength(0);
    }
    const persisted = loadAllExperiences(executor);
    const persistedContext = loadPositionContext(executor, "COINUSDT", "LONG");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.experienceId).toBe(darwinLifecycleExperienceId(identity.decisionId));
    expect(persistedContext).toEqual(firstContext);
    expect(persistedContext).toMatchObject({ experienceId: persisted[0]!.experienceId, entryDecisionId: identity.decisionId, lifecycleStatus: "OPEN" });
    // The audit event is written once, not once per cycle or worker restart.
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIRED")).toHaveLength(1);
    db.close();
  });

  it("6b. recovers the persisted entry thesis when one exists and leaves it unavailable otherwise", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    saveExperience(executor, {
      experienceId: "prior-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: identity.decisionId, entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
      liquidationDistance: "0", entryThesis: THESIS, exitThesis: "", evidenceAtEntry: ["TICKER"],
      evidenceAtExit: [], lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "PROFITABLE",
    } as never, OPENED_AT);

    const agent = fakeAgent(executor, db);
    const { repaired } = runRepair(agent, executor, [position()]);
    expect(repaired[0]!.entryThesis).toBe(THESIS);
    db.close();
  });
it("6c. never repairs a lifecycle for a position with no live provider quantity", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    // A provider position whose quantity is zero is not a live lifecycle and must not be
    // reconstructed into one.
    const closed = position({ quantity: "0", notional: "0", marginAllocated: "0" });
    const { repaired } = runRepair(agent, executor, [closed]);
    expect(repaired).toHaveLength(0);
    expect(loadAllExperiences(executor)).toHaveLength(0);
    db.close();
  });

  it("6d. repairs nothing when the provider reports no deterministic identity", () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const { repaired, discrepancies } = runRepair(agent, executor, [position()]);
    expect(repaired).toHaveLength(0);
    expect(loadAllExperiences(executor)).toHaveLength(0);
    expect(discrepancies).toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    db.close();
  });

  it("6e. a repaired lifecycle invents neither an entry price nor excursion from a missing one", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);

    // The provider resolved this position's opening order but reported no entry price.
    const { repaired } = runRepair(agent, executor, [position({ entryPrice: "" })]);
    const saved = repaired[0]!;
    expect(saved.origin).toBe("DARWIN");
    expect(saved.entryPrice).toBe("UNAVAILABLE");
    // Provenance facts the provider did prove are still retained.
    expect(saved.entryTime).toBe(OPENED_AT);
    expect(saved.providerOrderId).toBe(identity.providerOrderId);
    expect(saved.entryDecisionId).toBe(identity.decisionId);
    db.close();
  });

  it("6e2. a provider position with no opening timestamp yields no identity and therefore no repair", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    // Deterministic attribution requires the provider's authoritative opening timestamp as the
    // join key. Without it there is no identity, so nothing is repaired and nothing is invented.
    const { repaired, discrepancies } = runRepair(agent, executor, [position({ openedAt: undefined })]);
    expect(repaired).toHaveLength(0);
    expect(loadAllExperiences(executor)).toHaveLength(0);
    expect(discrepancies).toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    db.close();
  });

  it("6f. a repaired lifecycle uses only persisted entry reasoning and invents no lesson, decision or financial result", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const { repaired } = runRepair(agent, executor, [position()]);
    const saved = repaired[0]!;
    expect(saved.entryThesis).toBe(THESIS);
    expect(saved.lessonsUsed).toEqual([]);
    expect(saved.evidenceAtEntry).toEqual([]);
    expect(saved.exitDecisionId).toBe("");
    expect(saved.exitPrice).toBe("0");
    expect(saved.exitTime).toBe("");
    expect(saved.lastAction).toBeUndefined();
    // Outcome stays OPEN and unclassified: no profit or loss is asserted by a repair.
    expect(saved.outcomeStatus).toBe("OPEN");
    expect(["PROFITABLE", "LOSING", "BREAK_EVEN"]).not.toContain(saved.outcomeStatus);
    db.close();
  });
});

describe("identity must be deterministic, not symbol+side", () => {
  it("7. a stale DARWIN record does not satisfy a new external position with the same symbol+side", () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    // A stale DARWIN OPEN record for COINUSDT:LONG exists...
    saveExperience(executor, {
      experienceId: "stale-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "old-decision", entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
      liquidationDistance: "0", entryThesis: "old", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [],
      lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN", origin: "DARWIN",
    } as never, OBSERVED_AT);

    // ...and a new external COINUSDT:LONG position appears with no deterministic DARWIN identity.
    const { discrepancies, repaired } = runRepair(agent, executor, [position()]);
    expect(repaired).toHaveLength(0);
    // The stale record must not resolve the new position's lifecycle.
    expect(discrepancies).toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    expect(gate("INCREASE", discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    expect(gate("REVERSE", discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("7b. reports the identity mismatch explicitly rather than silently resolving", () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    saveExperience(executor, {
      experienceId: "stale-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "old-decision", entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
      liquidationDistance: "0", entryThesis: "old", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [],
      lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN", origin: "DARWIN",
    } as never, OBSERVED_AT);
    runRepair(agent, executor, [position()]);
    const mismatch = auditEvents(executor, "POSITION_IDENTITY_MISMATCH");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatchObject({ reason: "NO_DETERMINISTIC_PROVIDER_IDENTITY", experienceId: "stale-open" });
    db.close();
  });

  it("8. a mismatched entryDecisionId with the same symbol+side stays unresolved", () => {
    const { db, executor } = memoryExecutor();
    // Deterministic identity exists for decision "decision-new", but the local record is "old".
    seedDarwinOpeningIdentity(executor, { decisionId: "decision-new", providerOrderId: "order-new", oid: "oid-new" });
    const agent = fakeAgent(executor, db);
    saveExperience(executor, {
      experienceId: "other-darwin-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "old-decision", entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
      liquidationDistance: "0", entryThesis: "other", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [],
      lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN", origin: "DARWIN",
    } as never, OBSERVED_AT);

    const identities = loadProviderLiveOpeningOrderIdentities(executor, CATEGORY, [position()], "/api/runCycle");
    const attributed = new Map<string, { decisionId: string; providerOrderId: string }>();
    for (const candidate of [position()]) {
      const identity = identities.get(providerLivePositionLifecycleKey(candidate));
      if (identity) attributed.set(providerLivePositionLifecycleKey(candidate), identity);
    }
    // Only the mismatched record exists, so the real discrepancy logic must not resolve it.
    const discrepancies = agent.recordPositionDiscrepancies([...loadAllExperiences(executor)], [position()], CYCLE_ID, attributed);
    expect(discrepancies).toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    expect(gate("INCREASE", discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("9. a matching deterministic entryDecisionId resolves the lifecycle", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    saveExperience(executor, {
      experienceId: "matching-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: identity.decisionId, entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
      liquidationDistance: "0", entryThesis: "match", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [],
      lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN", origin: "DARWIN",
    } as never, OBSERVED_AT);

    const { repaired, discrepancies } = runRepair(agent, executor, [position()]);
    // Entry provenance already matches. The repair completes only the missing PositionContext read model.
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.experienceId).toBe("matching-open");
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toMatchObject({
      experienceId: "matching-open",
      entryDecisionId: identity.decisionId,
      lifecycleStatus: "OPEN",
    });
    expect(discrepancies).not.toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    expect(gate("INCREASE", discrepancies).codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("17. never silently upgrades a provider-external record to DARWIN on symbol+side alone", () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    saveExperience(executor, {
      experienceId: "provider-live:COINUSDT:LONG", symbol: "COINUSDT", positionSide: "LONG", action: "REDUCE",
      entryDecisionId: "", entryPrice: "UNAVAILABLE", entryTime: "UNAVAILABLE",
      exitDecisionId: "d", exitPrice: "179.06", exitTime: OBSERVED_AT, selectedLeverage: "3",
      marginAllocationPct: "UNAVAILABLE", marginAllocated: "720", positionNotional: "2157",
      realizedPnl: "-141.5875", realizedPnlPct: "-7.7", maximumFavorableExcursion: "UNAVAILABLE",
      maximumAdverseExcursion: "UNAVAILABLE", drawdownContribution: "UNAVAILABLE", liquidationDistance: "UNAVAILABLE",
      entryThesis: "UNAVAILABLE", exitThesis: "x", evidenceAtEntry: [], evidenceAtExit: [], lessonsUsed: [],
      marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN", lastAction: "REDUCE",
      origin: "PROVIDER_EXTERNAL", financialSource: "LOCAL",
    } as never, OBSERVED_AT);

    const identities = loadProviderLiveOpeningOrderIdentities(executor, CATEGORY, [position()], "/api/runCycle");
    const attributed = new Map<string, { decisionId: string; providerOrderId: string }>();
    for (const candidate of [position()]) {
      const identity = identities.get(providerLivePositionLifecycleKey(candidate));
      if (identity) attributed.set(providerLivePositionLifecycleKey(candidate), identity);
    }
    const discrepancies = agent.recordPositionDiscrepancies(loadAllExperiences(executor), [position()], CYCLE_ID, attributed);
    expect(discrepancies).toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");
    // The persisted record must still say external; nothing rewrote its provenance.
    expect(loadAllExperiences(executor)[0]!.origin).toBe("PROVIDER_EXTERNAL");
    db.close();
  });
});

describe("external positions keep their guard across cycles", () => {
  it("10. an external REDUCE stays externally attributed on the next cycle", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, managementRecord("REDUCE"));
    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.origin).toBe("PROVIDER_EXTERNAL");
    expect(isDarwinOwnedExperience(saved)).toBe(false);
    db.close();
  });

  it("11. repeated external REDUCE still blocks INCREASE", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    for (let i = 0; i < 3; i += 1) {
      const r = managementRecord("REDUCE");
      r.decision.decisionId = `decision-reduce-${i}`;
      await persist(agent, r, loadAllExperiences(executor));
    }
    expect(loadAllExperiences(executor)).toHaveLength(1);
    const { discrepancies } = runRepair(agent, executor, [position()]);
    expect(gate("INCREASE", discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("12. repeated external REDUCE still blocks REVERSE", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    for (let i = 0; i < 3; i += 1) {
      const r = managementRecord("REDUCE");
      r.decision.decisionId = `decision-reduce-${i}`;
      await persist(agent, r, loadAllExperiences(executor));
    }
    const { discrepancies } = runRepair(agent, executor, [position()]);
    expect(gate("REVERSE", discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("12b. the external guard survives a worker reload", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, managementRecord("REDUCE"));
    // Fresh read of persisted state, as a restarted worker would see.
    const reloaded = loadAllExperiences(executor);
    expect(reloaded.filter((experience) => isDarwinOwnedExperience(experience))).toHaveLength(0);
    const { discrepancies } = runRepair(agent, executor, [position()]);
    expect(gate("INCREASE", discrepancies).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });
});

describe("REDUCE persists the remaining position, not the reduced slice", () => {
  it("13. stores remaining provider position notional and margin from positionAfter", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const after = position({ quantity: "6.03", notional: "1079", marginAllocated: "360" });
    await persist(agent, managementRecord("REDUCE", { positionAfter: after }));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.origin).toBe("DARWIN");
    expect(saved.outcomeStatus).toBe("OPEN");
    // Remaining live position, not the reduced execution slice (1078 / 360).
    expect(saved.positionNotional).toBe("1079");
    expect(saved.marginAllocated).toBe("360");
    expect(saved.positionNotional).not.toBe("1078");
    db.close();
  });

  it("14. the reduced execution slice is still retained separately as execution evidence", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const after = position({ quantity: "6.03", notional: "1079", marginAllocated: "360" });
    const execution = managementRecord("REDUCE", { positionAfter: after });
    await persist(agent, execution);

    // The execution record still describes what was actually reduced.
    expect(execution.executionResult!.executedQuantity).toBe("6.02");
    expect(execution.executionResult!.positionNotional).toBe("1078");
    expect(execution.executionResult!.marginAllocated).toBe("360");
    expect(execution.positionAfter!.notional).toBe("1079");
    db.close();
  });

  it("15. a missing positionAfter does not fabricate remaining financial state", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    await persist(agent, managementRecord("REDUCE", { positionAfter: undefined }));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.outcomeStatus).toBe("OPEN");
    expect(saved.positionNotional).toBe("UNAVAILABLE");
    expect(saved.marginAllocated).toBe("UNAVAILABLE");
    expect(saved.selectedLeverage).toBe("UNAVAILABLE");
    // The reduced execution values must not leak into the remaining lifecycle state.
    expect(saved.positionNotional).not.toBe("1078");
    db.close();
  });

  it("15c. a partially unreadable positionAfter leaves only the unreadable fields unavailable", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    // Readback returns a position with no authoritative margin value. That field must stay
    // unavailable rather than being filled from the reduced execution.
    const partial = position({ quantity: "6.03", notional: "1079", marginAllocated: "", leverage: "" });
    await persist(agent, managementRecord("REDUCE", { positionAfter: partial }));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.positionNotional).toBe("1079");
    expect(saved.marginAllocated).toBe("UNAVAILABLE");
    expect(saved.selectedLeverage).toBe("UNAVAILABLE");
    // Not silently backfilled from the execution slice (360 / 3).
    expect(saved.marginAllocated).not.toBe("360");
    expect(saved.selectedLeverage).not.toBe("3");
    db.close();
  });

  it("15b. a CLOSE creates no remaining-open state", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    await persist(agent, managementRecord("CLOSE", { positionAfter: position({ quantity: "0", notional: "0", marginAllocated: "0" }) }));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.outcomeStatus).toBe("LOSING");
    expect(saved.positionNotional).toBe("UNAVAILABLE");
    expect(saved.marginAllocated).toBe("UNAVAILABLE");
    db.close();
  });
});

describe("other deterministic gates are unchanged", () => {
  it("16. emergency stop, drawdown, open orders and quarantine still block as before", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const { discrepancies } = runRepair(agent, executor, [position()]);
    expect(discrepancies).not.toContain("LOCAL_EXPERIENCE_MISSING:COINUSDT:LONG");

    // Repair must not weaken any other gate.
    for (const action of ["CLOSE", "REDUCE", "HOLD", "INCREASE", "REVERSE"] as const) {
      expect(gate(action, discrepancies, { emergencyStop: true }).codes).toContain("EMERGENCY_STOP");
    }
    for (const action of ["INCREASE", "REVERSE", "OPEN_LONG"] as const) {
      expect(gate(action, discrepancies, { dailyDrawdownBlocked: true }).codes).toContain("DAILY_DRAWDOWN");
    }
    for (const action of ["CLOSE", "REDUCE"] as const) {
      expect(gate(action, discrepancies, { account: { ...account(), openOrders: null } }).codes).toContain("OPEN_ORDERS_READ_UNAVAILABLE");
      expect(gate(action, discrepancies, { unresolvedExecutionSymbols: ["COINUSDT"] }).codes).toContain("UNRESOLVED_PRIOR_EXECUTION");
    }
    expect(gate("CLOSE", discrepancies, { openOrderSymbols: ["COINUSDT"] }).codes).toContain("DUPLICATE_ORDER");
    expect(gate("CLOSE", discrepancies, { evidenceObservedAt: "2026-10-07T10:00:00.000Z" }).codes).toContain("STALE_EVIDENCE");
    expect(gate("CLOSE", discrepancies, { instrument: { ...instrument, status: "offline" } }).codes).toContain("INSTRUMENT_UNAVAILABLE");
    // Provider position must still exist for management to be meaningful.
    expect(gate("CLOSE", discrepancies, { account: { ...account(), positions: [] } }).codes).toContain("INSUFFICIENT_POSITION");
    db.close();
  });

  it("16b. a missing provider position still blocks management fail-closed", () => {
    expect(gate("CLOSE", ["PROVIDER_POSITION_MISSING:COINUSDT:LONG"]).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    expect(gate("REDUCE", ["PROVIDER_POSITION_MISSING:COINUSDT:LONG"]).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    expect(gate("HOLD", ["PROVIDER_POSITION_MISSING:COINUSDT:LONG"]).codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
  });

  it("16c. a repaired lifecycle is a real OPEN experience, not a management-only record", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const { repaired } = runRepair(agent, executor, [position()]);
    expect(isDarwinOwnedExperience(repaired[0]!)).toBe(true);
    expect(repaired[0]!.lastAction).toBeUndefined();
    expect(repaired[0]!.exitDecisionId).toBe("");
    // No financial result, decision, or lesson is invented by the repair.
    expect(repaired[0]!.lessonsUsed).toEqual([]);
    expect(repaired[0]!.evidenceAtEntry).toEqual([]);
    expect(auditEvents(executor, "PROVIDER_EXTERNAL_MANAGEMENT_RECORDED")).toHaveLength(0);
    expect(loadAllEvents(executor).filter((event) => event.type === "PAPER_ORDER_SUBMITTED")).toHaveLength(0);
    db.close();
  });
});