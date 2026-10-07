import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadAllExperiences, loadPositionContext, saveExperience, saveJournal, savePositionContext } from "../src/storage/store.js";
import { TraderAgent } from "../src/agent/agent.js";
import { isDarwinOwnedExperience } from "../src/agent/provider-live-lifecycle.js";
import { loadProviderLiveOpeningOrderIdentities, providerLivePositionLifecycleKey } from "../src/storage/provider-ledger.js";
import { evaluateRiskGate } from "../src/trading/risk-gate.js";
import type { AccountSnapshot, Action, Decision, DecisionExecutionRecord, EvidenceBundle, Instrument, PositionSnapshot, RuntimeConfig, TradeExperience, TradingJournal } from "../src/types.js";

// A verified CLOSE/REDUCE on a provider-live position with no persisted local experience must
// preserve the *true* provenance. Deterministic DARWIN identity repairs the lifecycle; only a
// position with no identity at all is provider-external. A synthetic provider-external record
// must never satisfy the local-lifecycle requirement on a later cycle.

vi.mock("agents", () => ({ Agent: class {} }));

const CYCLE_ID = "cycle-provider-only";
const OBSERVED_AT = "2026-10-07T17:00:00.000Z";
const OPENED_AT = "2026-10-05T14:25:48.407Z";
const ENTRY_DECISION_ID = "decision-entry-darwin";
const OPENING_ORDER_ID = "1491009757156626432";
const ENTRY_OID = "darwin-entry-oid";
const THESIS = "COIN shows accelerating bullish momentum with consecutive higher closes";
const CATEGORY = "USDT-FUTURES";

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
    persistDecisionOutcome: (TraderAgent.prototype as unknown as { persistDecisionOutcome: (...args: unknown[]) => Promise<unknown> }).persistDecisionOutcome,
    repairMissingDarwinLifecycles: (TraderAgent.prototype as unknown as { repairMissingDarwinLifecycles: (...args: unknown[]) => TradeExperience[] }).repairMissingDarwinLifecycles,
    prepareDarwinLifecycleRepair: (TraderAgent.prototype as unknown as { prepareDarwinLifecycleRepair: (...args: unknown[]) => unknown }).prepareDarwinLifecycleRepair,
    recordEvent: (TraderAgent.prototype as unknown as { recordEvent: (type: string, cycleId: string, metadata?: Record<string, string>) => void }).recordEvent,
    recordPositionDiscrepancies: (TraderAgent.prototype as unknown as { recordPositionDiscrepancies: (...args: unknown[]) => string[] }).recordPositionDiscrepancies,
    updatePositionContext: vi.fn(),
    updatePerformanceReadModel: vi.fn(),
  };
}

function bundle(): EvidenceBundle {
  return {
    market: { symbol: "COINUSDT", lastPrice: "180", bidPrice: "179", askPrice: "181", priceChange24h: "0", volume24h: "100", observedAt: OBSERVED_AT },
    evidence: [{ type: "TICKER", observedAt: OBSERVED_AT }],
    marketRegime: "VOLATILITY_EXPANSION",
  } as unknown as EvidenceBundle;
}

type PositionOverride = { openedAt?: string | undefined } & Partial<Omit<PositionSnapshot, "openedAt">>;

function position(overrides: PositionOverride = {}): PositionSnapshot {
  // An explicit `openedAt: undefined` must clear the field entirely (the "provider reported no
  // opening time" case); otherwise the default authoritative openedAt applies.
  const { openedAt, ...rest } = overrides;
  const resolved = arguments.length > 0 && "openedAt" in overrides ? openedAt : OPENED_AT;
  return {
    symbol: "COINUSDT", positionSide: "LONG", quantity: "12.05", notional: "2157",
    marginAllocated: "720", leverage: "3", entryPrice: "190.81", unrealizedPnl: "0",
    realizedPnl: "0", ...rest,
    ...(resolved === undefined ? {} : { openedAt: resolved }),
  };
}

function record(action: "CLOSE" | "REDUCE", overrides: Partial<DecisionExecutionRecord> = {}): DecisionExecutionRecord {
  return {
    decision: {
      decisionId: "decision-close-1", cycleId: CYCLE_ID, action, positionSide: "LONG", symbol: "COINUSDT",
      marginAllocationPct: "0", additionalMarginPct: null, leverage: "3",
      reductionPct: action === "REDUCE" ? "50" : null, targetPositionSide: null, confidence: 0.7,
      thesis: "manage live position", strategyThesis: "reduce risk",
      supportingFactors: ["factor"], riskFactors: ["risk"], evidenceUsed: ["TICKER"], lessonsUsed: [], createdAt: OBSERVED_AT,
    },
    riskGateResult: { status: "PASS", codes: [], checkedAt: OBSERVED_AT },
    positionBefore: position(),
    executionResult: {
      provider: "BITGET", providerOrderId: "provider-close-order", clientOrderId: "darwin-close-oid", symbol: "COINUSDT",
      action, positionSide: "LONG", providerSide: "sell", tradeSide: "close", marginAllocated: "0", leverage: "3",
      positionNotional: "0", requestedQuantity: "12.05", executedQuantity: "12.05", status: "filled",
      submittedAt: OBSERVED_AT, readBackAt: OBSERVED_AT, averageFillPrice: "179.06", realizedPnl: "-141.5875", realizedPnlPct: "-7.7",
    },
    reconciliationResult: { status: "MATCHED", codes: [], checkedAt: OBSERVED_AT },
    ...overrides,
  } as unknown as DecisionExecutionRecord;
}

async function persist(agent: ReturnType<typeof fakeAgent>, executionRecord: DecisionExecutionRecord, experiences: unknown[] = []) {
  const journal = { cycleId: CYCLE_ID, experienceIds: [] as string[], createdLessons: [] as string[] } as unknown as TradingJournal;
  await agent.persistDecisionOutcome.call(
    agent,
    { tradingMode: "PAPER" } as never,
    executionRecord,
    bundle(),
    experiences as never,
    [] as never,
    CYCLE_ID,
    OBSERVED_AT,
    journal,
    false,
  );
  return journal;
}

/** Seed the deterministic DARWIN opening identity for the live position. */
function seedDarwinOpeningIdentity(executor: SqlExecutor, includeEntryDecision = true): void {
  executor.sql`INSERT INTO idempotency (client_order_id, cycle_id, decision_id, provider_order_id, created_at) VALUES (${ENTRY_OID}, ${"cycle-entry"}, ${ENTRY_DECISION_ID}, ${OPENING_ORDER_ID}, ${OPENED_AT})`;
  executor.sql`INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (${OPENING_ORDER_ID}, ${ENTRY_OID}, ${CATEGORY}, ${"COINUSDT"}, ${"buy"}, ${"long"}, ${"open"}, ${"12.05"}, ${"12.05"}, ${"filled"}, ${OPENED_AT}, ${OPENED_AT}, ${"DARWIN"}, ${"{}"}, ${OPENED_AT}, ${OPENED_AT})`;
  executor.sql`INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (${"fill-open"}, ${OPENING_ORDER_ID}, ${ENTRY_OID}, ${CATEGORY}, ${"COINUSDT"}, ${"buy"}, ${"long"}, ${"open"}, ${"12.05"}, ${"190.81"}, ${OPENED_AT}, ${"DARWIN"}, ${"{}"}, ${OPENED_AT}, ${OPENED_AT})`;
  if (includeEntryDecision) {
    const entryDecision = { ...decision("OPEN_LONG"), decisionId: ENTRY_DECISION_ID, cycleId: "cycle-entry", createdAt: OPENED_AT, thesis: THESIS };
    saveJournal(executor, {
      cycleId: "cycle-entry", agentVersion: "test", promptVersion: "test", model: "test", mode: "AUTONOMOUS",
      startedAt: OPENED_AT, completedAt: OPENED_AT, retrievedLessons: [], createdLessons: [],
      cyclePlan: { positionActions: [], entryActions: [entryDecision as never] },
    });
  }
}

function auditEvents(executor: SqlExecutor, type: string): Array<Record<string, string>> {
  return executor.sql<{ payload: string }>`SELECT payload FROM events WHERE event_type = ${type}`
    .map((row) => (JSON.parse(row.payload) as { metadata?: Record<string, string> }).metadata ?? {});
}

// ---------------------------------------------------------------------------
// Risk gate fixtures, used to prove the guard survives across cycles.
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

/**
 * The next cycle's real computation: call the actual recordPositionDiscrepancies with the
 * identities the real evidence loader returns, then run the real risk gate for an action.
 */
function nextCycleGate(agent: ReturnType<typeof fakeAgent>, executor: SqlExecutor, action: Action) {
  const persisted = loadAllExperiences(executor);
  const livePositions = [position()];
  const identities = loadProviderLiveOpeningOrderIdentities(executor, CATEGORY, livePositions, "/api/runCycle");
  const attributedLivePositionKeys = new Map<string, { decisionId: string; providerOrderId: string }>();
  for (const candidate of livePositions) {
    const identity = identities.get(providerLivePositionLifecycleKey(candidate));
    if (identity) attributedLivePositionKeys.set(providerLivePositionLifecycleKey(candidate), identity);
  }
  agent.repairMissingDarwinLifecycles.call(agent, persisted, livePositions, identities, "next-cycle", OBSERVED_AT);
  const resolvedExperiences = loadAllExperiences(executor);
  const discrepancies = agent.recordPositionDiscrepancies(resolvedExperiences, livePositions, "next-cycle", attributedLivePositionKeys);
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
  } as never);
}

describe("provider-live management provenance", () => {
  it("1. persists a DARWIN-attributable CLOSE as DARWIN with deterministic identity and no external event", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const journal = await persist(agent, record("CLOSE"));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.origin).toBe("DARWIN");
    expect(saved.entryDecisionId).toBe(ENTRY_DECISION_ID);
    expect(saved.providerOrderId).toBe(OPENING_ORDER_ID);
    const closedContext = loadPositionContext(executor, "COINUSDT", "LONG");
    expect(closedContext).toMatchObject({ experienceId: saved.experienceId, entryDecisionId: ENTRY_DECISION_ID, lifecycleStatus: "CLOSED", closedAt: OBSERVED_AT, updatedAt: OBSERVED_AT });
    expect(closedContext?.managementEvents?.at(-1)?.action).toBe("CLOSE");
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_CLOSED")).toHaveLength(1);
    // Deterministic repair is idempotent under one identity.
    expect(saved.experienceId).toBe(`darwin-lifecycle-repair:${ENTRY_DECISION_ID}`);
    expect(journal.experienceIds).toContain(`darwin-lifecycle-repair:${ENTRY_DECISION_ID}`);
    // A DARWIN-attributed position is never labelled external.
    expect(auditEvents(executor, "PROVIDER_EXTERNAL_MANAGEMENT_RECORDED")).toHaveLength(0);
    const repaired = auditEvents(executor, "DARWIN_LIFECYCLE_REPAIRED");
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ origin: "DARWIN", entryDecisionId: ENTRY_DECISION_ID, lifecycleOpeningOrderId: OPENING_ORDER_ID, positionContextRepaired: "true" });
    db.close();
  });

  it("1a. a failed CLOSE transaction rolls back experience, context, and the close audit together", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const experienceId = `darwin-lifecycle-repair:${ENTRY_DECISION_ID}`;
    const existing: TradeExperience = {
      experienceId, symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: ENTRY_DECISION_ID, providerOrderId: OPENING_ORDER_ID, entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
      entryThesis: THESIS, exitThesis: "", evidenceAtEntry: ["TICKER"], evidenceAtExit: [], lessonsUsed: [],
      marketContext: "UNKNOWN", outcomeStatus: "OPEN", origin: "DARWIN",
    } as unknown as TradeExperience;
    const context = {
      symbol: "COINUSDT", positionSide: "LONG", experienceId, entryDecisionId: ENTRY_DECISION_ID,
      entryReasoning: { action: "OPEN_LONG", thesis: THESIS, strategyThesis: "s", supportingFactors: [], riskFactors: [], evidenceUsed: ["TICKER"], lessonsUsed: [], confidence: 0.7, cycleId: "cycle-entry", decisionId: ENTRY_DECISION_ID, createdAt: OPENED_AT, entryPrice: "190.81", entryTime: OPENED_AT, experienceId },
      managementEvents: [], lifecycleStatus: "OPEN", updatedAt: OPENED_AT,
    };
    saveExperience(executor, existing, OPENED_AT);
    savePositionContext(executor, context as never);
    const agent = fakeAgent(executor, db);
    const originalSql = agent.sql;
    agent.sql = ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => {
      if (strings.join("?").includes("INSERT INTO events")) throw new Error("TEST_CLOSE_AUDIT_WRITE_FAILURE");
      return originalSql(strings, ...values);
    }) as typeof agent.sql;

    await expect(persist(agent, record("CLOSE"), [existing])).rejects.toThrow("TEST_CLOSE_AUDIT_WRITE_FAILURE");

    expect(loadAllExperiences(executor)).toEqual([existing]);
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toEqual(context);
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_CLOSED")).toHaveLength(0);
    db.close();
  });

  it("1aa. a failed CLOSE does not leave an intermediate OPEN lifecycle repair", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    const originalSql = agent.sql;
    agent.sql = ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => {
      if (strings.join("").includes("INSERT INTO events") && values[1] === "DARWIN_LIFECYCLE_CLOSED") {
        throw new Error("TEST_CLOSE_AUDIT_WRITE_FAILURE");
      }
      return originalSql(strings, ...values);
    }) as typeof agent.sql;

    await expect(persist(agent, record("CLOSE"))).rejects.toThrow("TEST_CLOSE_AUDIT_WRITE_FAILURE");

    expect(loadAllExperiences(executor)).toEqual([]);
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toBeNull();
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIRED")).toHaveLength(0);
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_CLOSED")).toHaveLength(0);
    db.close();
  });

  it("1b. refuses to update a lifecycle whose entry decision matches but provider order conflicts", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const conflicting: TradeExperience = {
      experienceId: `darwin-lifecycle-repair:${ENTRY_DECISION_ID}`, symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: ENTRY_DECISION_ID, providerOrderId: "different-provider-order", entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
      entryThesis: THESIS, exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [], lessonsUsed: [], marketContext: "UNKNOWN",
      outcomeStatus: "OPEN", origin: "DARWIN",
    } as unknown as TradeExperience;
    saveExperience(executor, conflicting, OPENED_AT);
    const agent = fakeAgent(executor, db);

    await persist(agent, record("CLOSE"), [conflicting]);

    expect(loadAllExperiences(executor)).toEqual([conflicting]);
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT")).toMatchObject([{ reason: "DETERMINISTIC_EXPERIENCE_IDENTITY_MISMATCH" }]);
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIRED")).toHaveLength(0);
    db.close();
  });

  it("1c. refuses to update a lifecycle whose provider order matches but entry decision conflicts", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const conflicting: TradeExperience = {
      experienceId: "stale-lifecycle-id", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "different-entry-decision", providerOrderId: OPENING_ORDER_ID, entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
      entryThesis: THESIS, exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [], lessonsUsed: [], marketContext: "UNKNOWN",
      outcomeStatus: "OPEN", origin: "DARWIN",
    } as unknown as TradeExperience;
    saveExperience(executor, conflicting, OPENED_AT);
    const agent = fakeAgent(executor, db);

    await persist(agent, record("CLOSE"), [conflicting]);

    expect(loadAllExperiences(executor)).toEqual([conflicting]);
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIR_IDENTITY_CONFLICT")).toMatchObject([{ reason: "DETERMINISTIC_EXPERIENCE_IDENTITY_MISMATCH" }]);
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIRED")).toHaveLength(0);
    db.close();
  });

  it("2. keeps a DARWIN-attributable REDUCE as DARWIN after persistence and on the next cycle", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const agent = fakeAgent(executor, db);
    await persist(agent, record("REDUCE"));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.origin).toBe("DARWIN");
    expect(saved.outcomeStatus).toBe("OPEN");
    // The repaired lifecycle is DARWIN-owned, so it counts locally on the next cycle.
    expect(isDarwinOwnedExperience(saved)).toBe(true);
    expect(nextCycleGate(agent, executor, "INCREASE").codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    expect(auditEvents(executor, "PROVIDER_EXTERNAL_MANAGEMENT_RECORDED")).toHaveLength(0);
    db.close();
  });

  it("3. keeps a provider-external REDUCE externally attributed on the next cycle", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, record("REDUCE"));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.origin).toBe("PROVIDER_EXTERNAL");
    expect(saved.outcomeStatus).toBe("OPEN");
    // The synthetic record must not count as a DARWIN local lifecycle.
    expect(isDarwinOwnedExperience(saved)).toBe(false);
    db.close();
  });

  it("4. blocks INCREASE on an external position after one REDUCE", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, record("REDUCE"));
    expect(nextCycleGate(agent, executor, "INCREASE").codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("5. blocks REVERSE on an external position after one REDUCE", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, record("REDUCE"));
    expect(nextCycleGate(agent, executor, "REVERSE").codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    db.close();
  });

  it("6. keeps the external guard persistent and idempotent across multiple REDUCEs and reload", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, record("REDUCE"));
    await persist(agent, record("REDUCE"));
    await persist(agent, record("REDUCE"));

    // One identity, and it is still external after every repeat.
    const persisted = loadAllExperiences(executor);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.origin).toBe("PROVIDER_EXTERNAL");

    // Simulate a worker restart: reload everything from storage and re-evaluate.
    const reloaded = loadAllExperiences(executor).filter((experience) => isDarwinOwnedExperience(experience));
    expect(reloaded).toHaveLength(0);
    expect(nextCycleGate(agent, executor, "INCREASE").codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    expect(nextCycleGate(agent, executor, "REVERSE").codes).toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    // Risk-reducing management stays available for a genuinely external position.
    for (const action of ["CLOSE", "REDUCE", "HOLD"] as const) {
      expect(nextCycleGate(agent, executor, action).codes).not.toContain("LOCAL_LIFECYCLE_UNRESOLVED");
    }
    db.close();
  });

  it("7. persists an external CLOSE outcome without fabricated DARWIN provenance", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, record("CLOSE"));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.origin).toBe("PROVIDER_EXTERNAL");
    expect(saved.outcomeStatus).toBe("CLOSED_UNCLASSIFIED");
    expect(saved.entryDecisionId).toBe("");
    expect(saved.entryThesis).toBe("UNAVAILABLE");
    expect(saved.lessonsUsed).toEqual([]);
    expect(["PROFITABLE", "LOSING", "BREAK_EVEN"]).not.toContain(saved.outcomeStatus);
    expect(auditEvents(executor, "PROVIDER_EXTERNAL_MANAGEMENT_RECORDED")[0]).toMatchObject({ origin: "PROVIDER_EXTERNAL", entryProvenance: "UNATTRIBUTED_NO_LOCAL_ENTRY" });
    db.close();
  });

  it("8. never writes a management timestamp as the entry time", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    // No provider openedAt at all.
    await persist(agent, record("CLOSE", { positionBefore: position({ openedAt: undefined }) }));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.entryTime).toBe("UNAVAILABLE");
    expect(saved.entryTime).not.toBe(OBSERVED_AT);
    expect(saved.exitTime).toBe(OBSERVED_AT);
    db.close();
  });

  it("9. uses the authoritative provider openedAt as the entry time when available", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, record("REDUCE"));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.entryTime).toBe(OPENED_AT);
    expect(saved.entryTime).not.toBe(saved.exitTime);
    db.close();
  });

  it("9b. never reuses the exit fill price as the entry price", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, record("REDUCE"));

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.exitPrice).toBe("179.06");
    expect(saved.entryPrice).toBe("190.81");
    expect(saved.entryPrice).not.toBe(saved.exitPrice);

    // With no provider entry price the field stays unavailable rather than borrowing the exit.
    const { db: db2, executor: executor2 } = memoryExecutor();
    const agent2 = fakeAgent(executor2, db2);
    await persist(agent2, record("REDUCE", { positionBefore: position({ entryPrice: "" }) }));
    const noEntry = loadAllExperiences(executor2)[0]!;
    expect(noEntry.entryPrice).toBe("UNAVAILABLE");
    expect(noEntry.entryPrice).not.toBe(noEntry.exitPrice);
    db.close();
    db2.close();
  });

  it("10. does not claim PROVIDER_LEDGER for a value only backed by the verified execution path", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, record("CLOSE"));
    // The realized PnL came from the execution readback, not a provider ledger history row.
    expect(loadAllExperiences(executor)[0]!.financialSource).toBe("LOCAL");
    db.close();
  });

  it("11. recovers the persisted entry thesis instead of inventing one", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    saveExperience(executor, {
      experienceId: "prior-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: ENTRY_DECISION_ID, entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
      liquidationDistance: "0", entryThesis: THESIS, exitThesis: "", evidenceAtEntry: ["TICKER"],
      evidenceAtExit: [], lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "PROFITABLE",
    } as never, OPENED_AT);

    const agent = fakeAgent(executor, db);
    await persist(agent, record("CLOSE"));
    expect(loadAllExperiences(executor).find((experience) => experience.experienceId === `darwin-lifecycle-repair:${ENTRY_DECISION_ID}`)!.entryThesis).toBe(THESIS);
    db.close();
  });

  it("12. leaves the DARWIN lifecycle incomplete when the entry Decision is unavailable", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor, false);
    const agent = fakeAgent(executor, db);
    await persist(agent, record("CLOSE"));
    expect(loadAllExperiences(executor)).toEqual([]);
    expect(loadPositionContext(executor, "COINUSDT", "LONG")).toBeNull();
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIR_INCOMPLETE")).toMatchObject([{ reason: "PERSISTED_ENTRY_DECISION_UNAVAILABLE" }]);
    db.close();
  });

  it("13. does not overwrite an existing local experience for the same position", async () => {
    const { db, executor } = memoryExecutor();
    const existing = {
      experienceId: "local-open-1", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "decision-open", entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
      liquidationDistance: "0", entryThesis: "local thesis", exitThesis: "", evidenceAtEntry: ["TICKER"],
      evidenceAtExit: [], lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN",
    } as never as TradeExperience;
    saveExperience(executor, existing, OBSERVED_AT);

    const agent = fakeAgent(executor, db);
    await persist(agent, record("CLOSE"), [existing]);
    const persisted = loadAllExperiences(executor);
    expect(persisted.find((experience) => experience.experienceId === "local-open-1")).toMatchObject({ outcomeStatus: "OPEN", entryDecisionId: "decision-open" });
    expect(persisted.find((experience) => experience.origin === "PROVIDER_EXTERNAL")).toBeDefined();
    db.close();
  });

  it("14. records nothing when the execution is unverified and nothing for an exposure increase", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const unverified = record("CLOSE");
    (unverified.reconciliationResult as { status: string }).status = "PENDING";
    await persist(agent, unverified);
    expect(loadAllExperiences(executor)).toHaveLength(0);

    const increasing = record("CLOSE");
    increasing.decision.action = "INCREASE";
    await persist(agent, increasing);
    expect(loadAllExperiences(executor)).toHaveLength(0);
    db.close();
  });

  it("15. a synthetic provider-external record never becomes the current experience for a later action", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    // Cycle 1: external REDUCE persists a synthetic OPEN record.
    await persist(agent, record("REDUCE"));
    const persisted = loadAllExperiences(executor);

    // Cycle 2: the same synthetic record must not be treated as a local lifecycle, otherwise
    // the ordinary local-experience branch would silently adopt it as DARWIN state.
    const secondCycle = record("CLOSE");
    secondCycle.decision.decisionId = "decision-close-2";
    await persist(agent, secondCycle, persisted);

    const saved = loadAllExperiences(executor);
    expect(saved).toHaveLength(1);
    // Still one external identity, still no DARWIN adoption.
    expect(saved[0]!.experienceId).toBe("provider-live:COINUSDT:LONG");
    expect(saved[0]!.origin).toBe("PROVIDER_EXTERNAL");
    expect(saved[0]!.entryDecisionId).toBe("");
    // The second cycle must take the provider-external branch again. Adopting the synthetic
    // record as a local experience would instead run the ordinary CLOSE reflection path.
    expect(auditEvents(executor, "PROVIDER_EXTERNAL_MANAGEMENT_RECORDED")).toHaveLength(2);
    expect(auditEvents(executor, "REFLECTION_COMPLETED")).toHaveLength(0);
    expect(saved[0]!.exitDecisionId).toBe("decision-close-2");
    db.close();
  });

  it("16. the per-cycle position-management refresh skips a provider-external record instead of failing the cycle", () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const refresh = (TraderAgent.prototype as unknown as { refreshPositionManagementState: (...args: unknown[]) => unknown[] }).refreshPositionManagementState;

    // The synthetic external record persisted by an external REDUCE has no usable entry price.
    const external = {
      experienceId: "provider-live:COINUSDT:LONG", symbol: "COINUSDT", positionSide: "LONG",
      action: "REDUCE", entryDecisionId: "", entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "decision-close-1", exitPrice: "179.06", exitTime: OBSERVED_AT,
      selectedLeverage: "3", marginAllocationPct: "UNAVAILABLE", marginAllocated: "720",
      positionNotional: "2157", realizedPnl: "-141.5875", realizedPnlPct: "-7.7",
      maximumFavorableExcursion: "UNAVAILABLE", maximumAdverseExcursion: "UNAVAILABLE",
      drawdownContribution: "UNAVAILABLE", liquidationDistance: "UNAVAILABLE",
      entryThesis: "UNAVAILABLE", exitThesis: "x", evidenceAtEntry: [], evidenceAtExit: [],
      lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN",
      lastAction: "REDUCE", origin: "PROVIDER_EXTERNAL", financialSource: "LOCAL",
    } as unknown as TradeExperience;

    const refreshBundle = { market: { symbol: "COINUSDT", lastPrice: "190.81", observedAt: OBSERVED_AT }, marketRegime: "VOLATILITY_EXPANSION" } as unknown as EvidenceBundle;
    // Without the guard this throws INVALID_POSITION_MANAGEMENT_ENTRY_PRICE and fails the cycle.
    const states = refresh.call(agent, [external], [position()], [refreshBundle], OBSERVED_AT, []);
    expect(states).toEqual([]);
    db.close();
  });

  // The three live production positions under audit: CRCLUSDT, SPCXUSDT, COINUSDT.
  const LIVE_PRODUCTION_POSITIONS = [
    { symbol: "CRCLUSDT", providerOrderId: "1490493208880631808" },
    { symbol: "SPCXUSDT", providerOrderId: "1491008302198706231" },
    { symbol: "COINUSDT", providerOrderId: "1491009757156626432" },
  ] as const;

  it("17. the three deterministic DARWIN positions never persist as PROVIDER_EXTERNAL", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const openedAt = OPENED_AT;
    for (const live of LIVE_PRODUCTION_POSITIONS) {
      const decisionId = `decision-entry-${live.symbol}`;
      const oid = `darwin-entry-oid-${live.symbol}`;
      const entryCycleId = `cycle-entry-${live.symbol}`;
      executor.sql`INSERT INTO idempotency (client_order_id, cycle_id, decision_id, provider_order_id, created_at) VALUES (${oid}, ${entryCycleId}, ${decisionId}, ${live.providerOrderId}, ${openedAt})`;
      executor.sql`INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (${live.providerOrderId}, ${oid}, ${CATEGORY}, ${live.symbol}, ${"buy"}, ${"long"}, ${"open"}, ${"12.05"}, ${"12.05"}, ${"filled"}, ${openedAt}, ${openedAt}, ${"DARWIN"}, ${"{}"}, ${openedAt}, ${openedAt})`;
      executor.sql`INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (${`fill-${live.symbol}`}, ${live.providerOrderId}, ${oid}, ${CATEGORY}, ${live.symbol}, ${"buy"}, ${"long"}, ${"open"}, ${"12.05"}, ${"190.81"}, ${openedAt}, ${"DARWIN"}, ${"{}"}, ${openedAt}, ${openedAt})`;
      const entryDecision = { ...decision("OPEN_LONG"), decisionId, cycleId: entryCycleId, symbol: live.symbol, createdAt: openedAt, thesis: THESIS };
      saveJournal(executor, {
        cycleId: entryCycleId, agentVersion: "test", promptVersion: "test", model: "test", mode: "AUTONOMOUS",
        startedAt: openedAt, completedAt: openedAt, retrievedLessons: [], createdLessons: [],
        cyclePlan: { positionActions: [], entryActions: [entryDecision as never] },
      });
      const base = record("REDUCE");
      await persist(agent, {
        ...base,
        positionBefore: position({ symbol: live.symbol, openedAt }),
        decision: { ...base.decision, symbol: live.symbol, decisionId: `decision-reduce-${live.symbol}` } as never,
        executionResult: { ...base.executionResult, symbol: live.symbol } as never,
      });
    }
    const saved = loadAllExperiences(executor);
    expect(saved).toHaveLength(3);
    for (const live of LIVE_PRODUCTION_POSITIONS) {
      const row = saved.find((experience) => experience.symbol === live.symbol);
      expect(row).toMatchObject({ origin: "DARWIN", providerOrderId: live.providerOrderId, entryDecisionId: `decision-entry-${live.symbol}` });
    }
    expect(auditEvents(executor, "PROVIDER_EXTERNAL_MANAGEMENT_RECORDED")).toHaveLength(0);
    expect(auditEvents(executor, "DARWIN_LIFECYCLE_REPAIRED")).toHaveLength(3);
    db.close();
  });

  it("18. repaired current REDUCE lifecycle receives only positionAfter remaining state, preserving stale same-side history", async () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const stale = {
      experienceId: "stale-darwin-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "old-entry-decision", entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
      entryThesis: "old", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [], lessonsUsed: [], marketContext: "UNKNOWN", outcomeStatus: "OPEN", origin: "DARWIN",
    } as unknown as TradeExperience;
    saveExperience(executor, stale, OBSERVED_AT);
    const agent = fakeAgent(executor, db);
    const experiences = loadAllExperiences(executor);
    const identities = loadProviderLiveOpeningOrderIdentities(executor, CATEGORY, [position()], "/api/runCycle");
    const repaired = agent.repairMissingDarwinLifecycles.call(agent, experiences, [position()], identities, CYCLE_ID, OBSERVED_AT);
    expect(repaired).toHaveLength(1);
    const execution = record("REDUCE", {
      positionAfter: position({ quantity: "6.02", notional: "1079", marginAllocated: "359.67", leverage: "2" }),
      executionResult: { ...record("REDUCE").executionResult, positionNotional: "1078", marginAllocated: "360", leverage: "3", realizedPnl: "UNAVAILABLE", realizedPnlPct: "UNAVAILABLE", executedQuantity: "6.03" } as never,
    });
    const journal = await persist(agent, execution, experiences);
    const saved = loadAllExperiences(executor);
    const current = saved.find((experience) => experience.experienceId === `darwin-lifecycle-repair:${ENTRY_DECISION_ID}`)!;
    const historical = saved.find((experience) => experience.experienceId === "stale-darwin-open")!;
    expect(current).toMatchObject({ outcomeStatus: "OPEN", positionNotional: "1079", marginAllocated: "359.67", selectedLeverage: "2" });
    expect(historical).toMatchObject({ outcomeStatus: "OPEN", positionNotional: "2157", marginAllocated: "720" });
    expect(journal.experienceId).toBe(current.experienceId);
    expect(execution.executionResult?.positionNotional).toBe("1078");
    expect(execution.executionResult?.executedQuantity).toBe("6.03");
    db.close();
  });

  it.each(["CLOSE", "INCREASE"] as const)("19. %s persistence updates only the deterministic live lifecycle", async (action) => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const stale = {
      experienceId: "stale-darwin-open", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "old-entry-decision", entryPrice: "190.81", entryTime: OPENED_AT,
      exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
      entryThesis: "old", exitThesis: "", evidenceAtEntry: [], evidenceAtExit: [], lessonsUsed: [], marketContext: "UNKNOWN", outcomeStatus: "OPEN", origin: "DARWIN",
    } as unknown as TradeExperience;
    saveExperience(executor, stale, OBSERVED_AT);
    const agent = fakeAgent(executor, db);
    const experiences = loadAllExperiences(executor);
    const identities = loadProviderLiveOpeningOrderIdentities(executor, CATEGORY, [position()], "/api/runCycle");
    agent.repairMissingDarwinLifecycles.call(agent, experiences, [position()], identities, CYCLE_ID, OBSERVED_AT);
    const sourceRecord = record(action === "CLOSE" ? "CLOSE" : "REDUCE", {
      decision: { ...record("REDUCE").decision, action, decisionId: `decision-${action}` } as never,
      executionResult: { ...record("REDUCE").executionResult, action, positionNotional: "2250", marginAllocated: "750", leverage: "3", realizedPnl: "UNAVAILABLE", realizedPnlPct: "UNAVAILABLE" } as never,
      ...(action === "INCREASE" ? { positionAfter: position({ notional: "3000", marginAllocated: "1000", leverage: "4" }) } : {}),
    });
    await persist(agent, sourceRecord, experiences);
    const saved = loadAllExperiences(executor);
    const current = saved.find((experience) => experience.experienceId === `darwin-lifecycle-repair:${ENTRY_DECISION_ID}`)!;
    const historical = saved.find((experience) => experience.experienceId === "stale-darwin-open")!;
    expect(historical).toMatchObject({ outcomeStatus: "OPEN", positionNotional: "2157" });
    expect(current.lastAction).toBe(action);
    expect(current.outcomeStatus).toBe(action === "CLOSE" ? "CLOSED_UNCLASSIFIED" : "OPEN");
    if (action === "INCREASE") expect(current).toMatchObject({ positionNotional: "3000", marginAllocated: "1000", selectedLeverage: "4" });
    db.close();
  });
});