import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { hasEvent, loadAllExperiences, saveExperience } from "../src/storage/store.js";
import { TraderAgent } from "../src/agent/agent.js";
import type { DecisionExecutionRecord, EvidenceBundle, TradingJournal } from "../src/types.js";

// A provider-only CLOSE/REDUCE must produce an auditable persisted outcome without inventing a
// DARWIN entry. These tests drive the real persistDecisionOutcome implementation.

vi.mock("agents", () => ({ Agent: class {} }));

const CYCLE_ID = "cycle-provider-only";
const OBSERVED_AT = "2026-10-07T17:00:00.000Z";

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
    env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_CATEGORY: "USDT-FUTURES" },
    state: { paused: false, runtimeStatus: "ONLINE" },
    ctx: { storage: { transactionSync: <T>(closure: () => T) => { db.exec("BEGIN IMMEDIATE"); try { const value = closure(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } } } },
    ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
    persistDecisionOutcome: (TraderAgent.prototype as unknown as { persistDecisionOutcome: (...args: unknown[]) => Promise<unknown> }).persistDecisionOutcome,
    recordEvent: (TraderAgent.prototype as unknown as { recordEvent: (type: string, cycleId: string, metadata?: Record<string, string>) => void }).recordEvent,
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

function record(action: "CLOSE" | "REDUCE"): DecisionExecutionRecord {
  return {
    decision: {
      decisionId: "decision-close-1", cycleId: CYCLE_ID, action, positionSide: "LONG", symbol: "COINUSDT",
      marginAllocationPct: "0", additionalMarginPct: null, leverage: "3",
      reductionPct: action === "REDUCE" ? "50" : null, targetPositionSide: null, confidence: 0.7,
      thesis: "manage unattributed live position", strategyThesis: "reduce risk",
      supportingFactors: ["factor"], riskFactors: ["risk"], evidenceUsed: ["TICKER"], lessonsUsed: [], createdAt: OBSERVED_AT,
    },
    riskGateResult: { status: "PASS", codes: [], checkedAt: OBSERVED_AT },
    executionResult: {
      provider: "BITGET", providerOrderId: "provider-close-order", clientOrderId: "darwin-close-oid", symbol: "COINUSDT",
      action, positionSide: "LONG", providerSide: "sell", tradeSide: "close", marginAllocated: "0", leverage: "3",
      positionNotional: "0", requestedQuantity: "12.05", executedQuantity: "12.05", status: "filled",
      submittedAt: OBSERVED_AT, readBackAt: OBSERVED_AT, averageFillPrice: "179.06", realizedPnl: "-141.5875", realizedPnlPct: "-7.7",
    },
    reconciliationResult: { status: "MATCHED", codes: [], checkedAt: OBSERVED_AT },
  } as unknown as DecisionExecutionRecord;
}

async function persist(agent: ReturnType<typeof fakeAgent>, action: "CLOSE" | "REDUCE", experiences: unknown[] = []) {
  const journal = { cycleId: CYCLE_ID, experienceIds: [] as string[], createdLessons: [] as string[] } as unknown as TradingJournal;
  await agent.persistDecisionOutcome.call(
    agent,
    { tradingMode: "PAPER" } as never,
    record(action),
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

describe("provider-only management persistence", () => {
  it("10. persists an auditable provider-origin outcome for a successful CLOSE", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const journal = await persist(agent, "CLOSE");

    const experiences = loadAllExperiences(executor);
    expect(experiences).toHaveLength(1);
    const saved = experiences[0]!;
    expect(saved.experienceId).toBe("provider-live:COINUSDT:LONG");
    expect(saved.action).toBe("CLOSE");
    expect(saved.outcomeStatus).toBe("CLOSED_UNCLASSIFIED");
    expect(saved.realizedPnl).toBe("-141.5875");
    expect(saved.realizedPnlVerified).toBe(true);
    expect(saved.financialSource).toBe("PROVIDER_LEDGER");
    expect(journal.experienceIds).toContain("provider-live:COINUSDT:LONG");

    const audit = loadAllExperiences(executor).length === 1
      ? executor.sql<{ payload: string }>`SELECT payload FROM events WHERE event_type = 'PROVIDER_EXTERNAL_MANAGEMENT_RECORDED'`
      : [];
    expect(audit).toHaveLength(1);
    const metadata = JSON.parse(audit[0]!.payload).metadata as Record<string, string>;
    expect(metadata.origin).toBe("PROVIDER_EXTERNAL");
    expect(metadata.action).toBe("CLOSE");
    expect(metadata.providerOrderId).toBe("provider-close-order");
    expect(metadata.entryProvenance).toBe("UNATTRIBUTED_NO_LOCAL_ENTRY");
    db.close();
  });

  it("10b. persists an auditable provider-origin outcome for a successful REDUCE", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const journal = await persist(agent, "REDUCE");

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.experienceId).toBe("provider-live:COINUSDT:LONG");
    expect(saved.action).toBe("REDUCE");
    expect(saved.outcomeStatus).toBe("OPEN");
    expect(journal.experienceIds).toContain("provider-live:COINUSDT:LONG");
    db.close();
  });

  it("11. never fabricates a DARWIN entry decision, thesis, price, or ownership", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, "CLOSE");

    const saved = loadAllExperiences(executor)[0]!;
    expect(saved.entryDecisionId).toBe("");
    expect(saved.entryPrice).toBe("UNAVAILABLE");
    expect(saved.entryThesis).toBe("UNAVAILABLE");
    expect(saved.origin).toBe("PROVIDER_EXTERNAL");
    expect(saved.lessonsUsed).toEqual([]);
    expect(saved.evidenceAtEntry).toEqual([]);
    // A provider-origin close must not be counted as a self-learning win or loss.
    expect(["PROFITABLE", "LOSING", "BREAK_EVEN"]).not.toContain(saved.outcomeStatus);
    db.close();
  });

  it("11b. does not overwrite an existing local experience for the same position", async () => {
    const { db, executor } = memoryExecutor();
    saveExperience(executor, {
      experienceId: "local-open-1", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG",
      entryDecisionId: "decision-open", entryPrice: "190.81", entryTime: "2026-10-05T14:25:48.407Z",
      exitDecisionId: "", exitPrice: "", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
      entryThesis: "local thesis", exitThesis: "", evidenceAtEntry: ["TICKER"], evidenceAtExit: [], lessonsUsed: [],
      marketContext: "VOLATILITY_EXPANSION", outcomeStatus: "OPEN",
    } as never, OBSERVED_AT);

    const agent = fakeAgent(executor, db);
    await persist(agent, "CLOSE", [{
      experienceId: "local-open-1", symbol: "COINUSDT", positionSide: "LONG", action: "OPEN_LONG", outcomeStatus: "OPEN",
      entryDecisionId: "decision-open", entryPrice: "190.81", entryTime: "2026-10-05T14:25:48.407Z",
      exitDecisionId: "", exitPrice: "", exitTime: "", selectedLeverage: "3", marginAllocationPct: "10",
      marginAllocated: "720", positionNotional: "2157", realizedPnl: "0", realizedPnlPct: "0",
      maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0",
      liquidationDistance: "0", entryThesis: "local thesis", exitThesis: "",
      evidenceAtEntry: ["TICKER"], evidenceAtExit: [], lessonsUsed: [], marketContext: "VOLATILITY_EXPANSION",
    }]);

    const ids = loadAllExperiences(executor).map((experience) => experience.experienceId);
    expect(ids).toContain("local-open-1");
    expect(ids).not.toContain("provider-live:COINUSDT:LONG");
    expect(loadAllExperiences(executor).find((e) => e.experienceId === "local-open-1")!.outcomeStatus).not.toBe("CLOSED_UNCLASSIFIED");
    db.close();
  });

  it("12. records the provider-external management event idempotently under one identity", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    await persist(agent, "CLOSE");
    await persist(agent, "REDUCE");

    const experiences = loadAllExperiences(executor);
    expect(experiences).toHaveLength(1);
    const events = executor.sql<{ payload: string }>`SELECT payload FROM events WHERE event_type = 'PROVIDER_EXTERNAL_MANAGEMENT_RECORDED'`;
    expect(events).toHaveLength(2);
    expect(experiences[0]!.experienceId).toBe("provider-live:COINUSDT:LONG");
    db.close();
  });

  it("12b. does not record an outcome when the provider execution is unverified", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const unverified = record("CLOSE");
    (unverified.reconciliationResult as { status: string }).status = "PENDING";
    const journal = { cycleId: CYCLE_ID, experienceIds: [] as string[] } as unknown as TradingJournal;
    await agent.persistDecisionOutcome.call(agent, { tradingMode: "PAPER" } as never, unverified, bundle(), [], [] as never, CYCLE_ID, OBSERVED_AT, journal, false);
    expect(loadAllExperiences(executor)).toHaveLength(0);
    db.close();
  });

  it("12c. does not create a provider-origin record for an exposure-increasing action", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const journal = { cycleId: CYCLE_ID, experienceIds: [] as string[] } as unknown as TradingJournal;
    const increasing = record("CLOSE");
    increasing.decision.action = "INCREASE";
    await agent.persistDecisionOutcome.call(agent, { tradingMode: "PAPER" } as never, increasing, bundle(), [], [] as never, CYCLE_ID, OBSERVED_AT, journal, false);
    expect(loadAllExperiences(executor)).toHaveLength(0);
    db.close();
  });
});