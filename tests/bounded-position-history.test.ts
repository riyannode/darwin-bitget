import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

// The trading cycle must never materialize the full journal history. In production the
// unbounded position-management read returned 5032 rows in one Durable Object invocation,
// exhausted the isolate memory limit, and reset the isolate before the cycle completed.
//
// These tests prove the bounded reader: that the hard limit is enforced by SQL before any
// JSON is materialized, that reconstruction converges, and that stale history is inert.

vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));

import { TraderAgent } from "../src/agent/agent.js";
import { ensureStorage, executeMeasuredSql, type SqlExecutor } from "../src/storage/schema.js";
import {
  HISTORY_ROW_HARD_LIMIT,
  loadAllAutonomousJournals,
  loadBoundedPositionManagementHistory,
  saveExperience,
  savePositionContext,
  type PositionHistoryRequest,
} from "../src/storage/store.js";
import { loadProviderLiveOpeningOrderIdentities, providerLivePositionLifecycleKey } from "../src/storage/provider-ledger.js";
import {
  positionHistoryReconstructionRequired,
  positionHistoryRequests,
  resolvePositionManagementLifecycles,
  type ResolvedPositionLifecycle,
} from "../src/trading/position-management.js";
import type { EvidenceBundle, PositionSnapshot, TradeExperience, TradingJournal } from "../src/types.js";

const OBSERVED_AT = "2026-10-07T17:00:00.000Z";
const OPENED_AT = "2026-10-05T14:25:48.407Z";
const CATEGORY = "USDT-FUTURES";
const ENTRY_PRICE = "190.81";
const PROVIDER_ORDER_ID = "1491009757156626432";
const ENTRY_DECISION_ID = "decision-entry";

/** The production row count that exhausted the isolate. */
const PRODUCTION_JOURNAL_ROWS = 5032;

type SqlValue = string | number | boolean | null;

function memoryExecutor(db = new DatabaseSync(":memory:")): { db: DatabaseSync; executor: SqlExecutor } {
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] {
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

/**
 * A measured executor identical in shape to the Durable Object path, so rowsRead
 * telemetry reflects what SQL actually returned.
 */
function measuredExecutor(db: DatabaseSync): SqlExecutor {
  const base = memoryExecutor(db).executor;
  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...values: SqlValue[]) {
          const normalized = query.trimStart().toUpperCase();
          const params = values.map((value) => typeof value === "boolean" ? Number(value) : value) as (string | number | null)[];
          const rows = (normalized.startsWith("SELECT") || normalized.startsWith("WITH"))
            ? db.prepare(query).all(...params) as Record<string, unknown>[]
            : (db.prepare(query).run(...params), []);
          return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
        },
      },
    },
  };
  return Object.assign(base, {
    ctx,
    measuredSql: TraderAgent.prototype.measuredSql.bind({ ctx } as never),
  }) as SqlExecutor;
}

function observationJournal(index: number, symbol: string, positionSide: "LONG" | "SHORT", lastPrice: string, observedAt: string): TradingJournal {
  return {
    cycleId: `cycle-${index}`,
    agentVersion: "test",
    promptVersion: "test",
    model: "test",
    mode: "AUTONOMOUS",
    startedAt: observedAt,
    completedAt: observedAt,
    portfolio: { positions: [{ symbol, positionSide, quantity: "12.05" }], observedAt } as never,
    marketContext: { deep: [{ market: { symbol, lastPrice, observedAt } }] },
    retrievedLessons: [],
    createdLessons: [],
  };
}

/**
 * Seed the exact production condition: at least 5032 stored journals, most of them
 * unrelated to the current lifecycle.
 */
function seedJournalHistory(executor: SqlExecutor, options: { relevant?: TradingJournal[]; unrelated?: number } = {}): number {
  const insert = (cycleId: string, payload: unknown, createdAt: string): void => {
    executor.sql`INSERT INTO journals (cycle_id, payload, created_at) VALUES (${cycleId}, ${JSON.stringify(payload)}, ${createdAt})`;
  };
  const unrelated = options.unrelated ?? PRODUCTION_JOURNAL_ROWS;
  // Unrelated, older, different-symbol history: the shape that previously forced a
  // full-table materialization.
  for (let index = 0; index < unrelated; index += 1) {
    insert(`unrelated-${index}`, {
      cycleId: `unrelated-${index}`,
      mode: "AUTONOMOUS",
      startedAt: "2026-09-01T00:00:00.000Z",
      completedAt: "2026-09-01T00:00:01.000Z",
      portfolio: { positions: [{ symbol: "UNRELATEDUSDT", positionSide: "LONG", quantity: "1" }], observedAt: "2026-09-01T00:00:00.000Z" },
      marketContext: { deep: [{ market: { symbol: "UNRELATEDUSDT", lastPrice: "1", observedAt: "2026-09-01T00:00:00.000Z" } }] },
      retrievedLessons: [], createdLessons: [],
    }, `2026-09-01T00:00:00.000Z`);
  }
  for (const [index, journal] of (options.relevant ?? []).entries()) {
    insert(journal.cycleId, journal, journal.startedAt);
  }
  const [countRow] = executor.sql<{ total: number }>`SELECT count(*) AS total FROM journals`;
  return countRow?.total ?? 0;
}

function position(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    symbol: "COINUSDT", positionSide: "LONG", quantity: "12.05", notional: "2157",
    marginAllocated: "720", leverage: "3", entryPrice: ENTRY_PRICE, unrealizedPnl: "0",
    realizedPnl: "0", markPrice: ENTRY_PRICE, openedAt: OPENED_AT,
    ...overrides,
  } as PositionSnapshot;
}

function bundle(lastPrice: string): EvidenceBundle {
  return {
    instrument: { symbol: "COINUSDT" },
    market: { symbol: "COINUSDT", lastPrice, observedAt: OBSERVED_AT },
    marketRegime: "RANGE_LOW_VOL",
  } as unknown as EvidenceBundle;
}

/** A repaired lifecycle: excursion metrics unknown and no basis, exactly as PR #50 leaves it. */
function repairedExperience(overrides: Partial<TradeExperience> = {}): TradeExperience {
  return {
    experienceId: "provider-live:COINUSDT:LONG",
    symbol: "COINUSDT",
    positionSide: "LONG",
    action: "OPEN_LONG",
    entryDecisionId: ENTRY_DECISION_ID,
    entryPrice: ENTRY_PRICE,
    entryTime: OPENED_AT,
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: "",
    selectedLeverage: "3",
    marginAllocationPct: "UNAVAILABLE",
    marginAllocated: "720",
    positionNotional: "2157",
    realizedPnl: "UNAVAILABLE",
    realizedPnlPct: "UNAVAILABLE",
    maximumFavorableExcursion: "UNAVAILABLE",
    maximumAdverseExcursion: "UNAVAILABLE",
    drawdownContribution: "UNAVAILABLE",
    liquidationDistance: "UNAVAILABLE",
    entryThesis: "UNAVAILABLE",
    exitThesis: "",
    evidenceAtEntry: [],
    evidenceAtExit: [],
    lessonsUsed: [],
    marketContext: "UNKNOWN",
    outcomeStatus: "OPEN",
    ...overrides,
  } as TradeExperience;
}

/** Seed the deterministic DARWIN opening identity that ties a live position to an entry decision. */
function seedDarwinOpeningIdentity(executor: SqlExecutor): { decisionId: string; providerOrderId: string } {
  const oid = "darwin-entry-oid";
  executor.sql`INSERT INTO idempotency (client_order_id, cycle_id, decision_id, provider_order_id, created_at) VALUES (${oid}, ${"cycle-entry"}, ${ENTRY_DECISION_ID}, ${PROVIDER_ORDER_ID}, ${OPENED_AT})`;
  executor.sql`INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (${PROVIDER_ORDER_ID}, ${oid}, ${CATEGORY}, ${"COINUSDT"}, ${"buy"}, ${"long"}, ${"open"}, ${"12.05"}, ${"12.05"}, ${"filled"}, ${OPENED_AT}, ${OPENED_AT}, ${"DARWIN"}, ${"{}"}, ${OPENED_AT}, ${OPENED_AT})`;
  executor.sql`INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (${`fill-${PROVIDER_ORDER_ID}`}, ${PROVIDER_ORDER_ID}, ${oid}, ${CATEGORY}, ${"COINUSDT"}, ${"buy"}, ${"long"}, ${"open"}, ${"12.05"}, ${"190.81"}, ${OPENED_AT}, ${"DARWIN"}, ${"{}"}, ${OPENED_AT}, ${OPENED_AT})`;
  return { decisionId: ENTRY_DECISION_ID, providerOrderId: PROVIDER_ORDER_ID };
}

/** The agent seam that position management uses: PositionContext reads and experience writes. */
function fakeAgent(executor: SqlExecutor, db: DatabaseSync) {
  return {
    sql: executor.sql,
    env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_CATEGORY: CATEGORY },
    state: { paused: false, runtimeStatus: "ONLINE" },
    ctx: {
      storage: {
        transactionSync: <T>(closure: () => T): T => {
          db.exec("BEGIN IMMEDIATE");
          try { const value = closure(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
        },
      },
    },
  };
}

const refresh = (TraderAgent.prototype as unknown as {
  refreshPositionManagementState: (...args: unknown[]) => PositionManagementStateLike[];
}).refreshPositionManagementState;

type PositionManagementStateLike = {
  symbol: string;
  positionSide: string;
  maximumFavorableReturnPct: number;
  maximumFavorableReturnBasis: string;
  profitGivebackPct: number;
};

function seedContextMatching(executor: SqlExecutor, experience: TradeExperience): void {
  const positionSide = experience.positionSide;
  if (positionSide !== "LONG" && positionSide !== "SHORT") throw new Error("TEST_FIXTURE_REQUIRES_POSITION_SIDE");
  savePositionContext(executor, {
    symbol: experience.symbol,
    positionSide,
    entryDecisionId: experience.entryDecisionId,
    experienceId: experience.experienceId,
    lifecycleStatus: "OPEN",
    managementEvents: [],
    updatedAt: OBSERVED_AT,
  });
}

function identitiesFor(executor: SqlExecutor, positions: readonly PositionSnapshot[]): Map<string, { decisionId: string; providerOrderId: string }> {
  return loadProviderLiveOpeningOrderIdentities(executor, CATEGORY, positions, "/api/runCycle");
}

afterEach(() => vi.restoreAllMocks());

describe("bounded position-management history read", () => {
  // Requirement 1: position management never invokes loadAllAutonomousJournals().
  // Proven at runtime through the real scheduled cycle, not by reading source: the
  // module is instrumented so any call from the cycle is recorded and fails the test.
  it("never calls loadAllAutonomousJournals from the trading cycle, at any row count", async () => {
    const storeModule = await import("../src/storage/store.js");
    const unbounded = vi.spyOn(storeModule, "loadAllAutonomousJournals");
    const { db, executor } = memoryExecutor();
    seedJournalHistory(executor, { unrelated: PRODUCTION_JOURNAL_ROWS });
    const agent = fakeAgent(executor, db);
    // Only the cycle phase under test is executed; the read decision is the real one.
    const resolveLifecycles = (await import("../src/trading/position-management.js")).resolvePositionManagementLifecycles;
    const store = await import("../src/storage/store.js");

    const lifecycles = resolveLifecycles(executor, [], [], new Map());
    const history = store.loadBoundedPositionManagementHistory(executor, lifecycles.map((lifecycle) => ({
      symbol: lifecycle.symbol, positionSide: lifecycle.positionSide, startAt: lifecycle.entryTime,
    })));

    expect(history.journals).toEqual([]);
    expect(unbounded).not.toHaveBeenCalled();
    db.close();
  });

  it("keeps the unbounded loader reachable only for the export path", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/agent/agent.ts", import.meta.url), "utf8"));
    const callers = source.split("\n").map((line) => line.trim()).filter((line) => line.includes("loadAllAutonomousJournals(") && !line.startsWith("import"));
    const positionManagementPhase = source.slice(source.indexOf("POSITION_MANAGEMENT", source.indexOf("runTimedCyclePhase")));
    const exportHandler = source.slice(source.indexOf("private exportPaperLog"));

    // The only remaining caller is the paper-log export, which is date-windowed by the
    // caller's own period; the trading cycle's position-management phase has none.
    expect(callers).toHaveLength(1);
    expect(exportHandler).toContain("loadAllAutonomousJournals(");
    expect(positionManagementPhase.slice(0, 2000)).not.toContain("loadAllAutonomousJournals");
    expect(positionManagementPhase.slice(0, 2000)).toContain("loadBoundedPositionManagementHistory");
  });

  // Requirements 2 and 15: 5032 stored journals do not become a 5032-row materialization.
  it("reads a bounded subset when 5032 journals are stored", () => {
    const { db, executor } = memoryExecutor();
    const relevant = [observationJournal(1, "COINUSDT", "LONG", "210", "2026-10-06T17:00:00.000Z")];
    const total = seedJournalHistory(executor, { relevant });

    expect(total).toBeGreaterThanOrEqual(PRODUCTION_JOURNAL_ROWS);

    const result = loadBoundedPositionManagementHistory(executor, [{ symbol: "COINUSDT", positionSide: "LONG", startAt: OPENED_AT }]);

    expect(result.journals.length).toBe(1);
    expect(result.journals.length).toBeLessThanOrEqual(HISTORY_ROW_HARD_LIMIT);
    expect(result.journals.length).toBeLessThan(total);
    // The unbounded path would have decoded every stored payload.
    expect(result.journals.length).toBeLessThan(total - PRODUCTION_JOURNAL_ROWS + 5);
    db.close();
  });

  // Requirement 15: the bound is enforced by SQL, before JSON materialization.
  it("bounds rows in SQL and never receives more payload rows than the hard limit", () => {
    const { db, executor } = memoryExecutor();
    // Every stored journal matches the current lifecycle, so only SQL can bound this.
    const total = seedJournalHistory(executor, {
      unrelated: PRODUCTION_JOURNAL_ROWS,
      relevant: Array.from({ length: PRODUCTION_JOURNAL_ROWS }, (_, index) =>
        observationJournal(index, "COINUSDT", "LONG", "210", new Date(Date.UTC(2026, 9, 6, 0, 0, index % 60)).toISOString())),
    });
    expect(total).toBeGreaterThanOrEqual(PRODUCTION_JOURNAL_ROWS * 2);

    const measured = measuredExecutor(db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = loadBoundedPositionManagementHistory(measured, [{ symbol: "COINUSDT", positionSide: "LONG", startAt: "2026-10-06T00:00:00.000Z" }]);

    // Only the bounded rows are decoded by the application.
    expect(result.journals.length).toBe(HISTORY_ROW_HARD_LIMIT);
    expect(result.truncated).toBe(true);

    // rowsRead is what the SQL statement returned: one probe row over the limit.
    const reads = logSpy.mock.calls
      .flatMap((call) => { const value = call[0]; if (typeof value !== "string") return []; try { const parsed: unknown = JSON.parse(value); return typeof parsed === "object" && parsed !== null ? [parsed as Record<string, unknown>] : []; } catch { return []; } })
      .filter((record) => record.queryName === "position_management_bounded_history");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.rowsRead).toBe(HISTORY_ROW_HARD_LIMIT + 1);
    expect(reads[0]!.rowsRead).toBeLessThan(total);

    // Contrast: the unbounded loader materializes the entire history.
    const unbounded = loadAllAutonomousJournals(executor, undefined, undefined, "scheduled_cycle", "position_management_full_journal_history");
    expect(unbounded.length).toBe(total);
    expect(result.journals.length).toBeLessThan(unbounded.length);
    db.close();
  });

  // Requirement 3: the reader never exceeds its configured hard limit.
  it("never returns more than the configured hard limit", () => {
    const { db, executor } = memoryExecutor();
    seedJournalHistory(executor, {
      relevant: Array.from({ length: 900 }, (_, index) =>
        observationJournal(index, "COINUSDT", "LONG", "210", new Date(Date.UTC(2026, 9, 6, 0, 0, index % 60)).toISOString())),
    });

    for (const limit of [1, 25, 300, 100_000]) {
      const result = loadBoundedPositionManagementHistory(executor, [{ symbol: "COINUSDT", positionSide: "LONG", startAt: "2026-10-06T00:00:00.000Z" }], { limit });
      expect(result.journals.length).toBeLessThanOrEqual(Math.min(limit, HISTORY_ROW_HARD_LIMIT));
    }
    db.close();
  });

  // Requirement 4: thousands of unrelated old journals do not affect reconstruction.
  it("ignores thousands of unrelated old journals when reconstructing the current lifecycle", () => {
    const { db, executor } = memoryExecutor();
    const relevant = [
      observationJournal(1, "COINUSDT", "LONG", "210", "2026-10-06T17:00:00.000Z"),
      observationJournal(2, "COINUSDT", "LONG", "205", "2026-10-06T17:05:00.000Z"),
    ];
    seedJournalHistory(executor, { relevant, unrelated: PRODUCTION_JOURNAL_ROWS });

    const result = loadBoundedPositionManagementHistory(executor, [{ symbol: "COINUSDT", positionSide: "LONG", startAt: OPENED_AT }]);

    expect(result.journals.map((journal) => journal.cycleId).sort()).toEqual(["cycle-1", "cycle-2"]);
    db.close();
  });

  it("excludes observations older than the provider-live entry time", () => {
    const { db, executor } = memoryExecutor();
    const relevant = [
      observationJournal(1, "COINUSDT", "LONG", "999", "2026-10-01T00:00:00.000Z"),
      observationJournal(2, "COINUSDT", "LONG", "210", "2026-10-06T17:00:00.000Z"),
    ];
    seedJournalHistory(executor, { relevant, unrelated: 10 });

    const result = loadBoundedPositionManagementHistory(executor, [{ symbol: "COINUSDT", positionSide: "LONG", startAt: OPENED_AT }]);

    expect(result.journals.map((journal) => journal.cycleId)).toEqual(["cycle-2"]);
    expect(result.journals).toHaveLength(1);
    db.close();
  });

  it("skips a legacy journal with no portfolio without failing the cycle read", () => {
    const { db, executor } = memoryExecutor();
    // Legacy journals legitimately exist without a portfolio block; json_each on the
    // missing path must yield no rows rather than erroring. The json_valid guard is
    // kept as defence in depth: the decision-lookup insert trigger already rejects
    // malformed payloads, so this proves the guard cannot itself fail a cycle read.
    executor.sql`INSERT INTO journals (cycle_id, payload, created_at) VALUES (${"legacy-no-portfolio"}, ${JSON.stringify({ cycleId: "legacy-no-portfolio", mode: "AUTONOMOUS" })}, ${"2026-10-06T16:00:00.000Z"})`;
    seedJournalHistory(executor, { relevant: [observationJournal(1, "COINUSDT", "LONG", "210", "2026-10-06T17:00:00.000Z")], unrelated: 5 });

    const result = loadBoundedPositionManagementHistory(executor, [{ symbol: "COINUSDT", positionSide: "LONG", startAt: OPENED_AT }]);

    expect(result.journals.map((journal) => journal.cycleId)).toEqual(["cycle-1"]);
    db.close();
  });

  it("performs no read at all when no lifecycle needs reconstruction", () => {
    const { db, executor } = memoryExecutor();
    seedJournalHistory(executor, { unrelated: 50 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const measured = measuredExecutor(db);

    const result = loadBoundedPositionManagementHistory(measured, []);

    expect(result.journals).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    db.close();
  });
});

describe("reconstruction gate is scoped to current provider-live lifecycles", () => {
  // Requirement 5: stale OPEN experiences never trigger reconstruction.
  it("does not let a stale OPEN experience trigger a history read", () => {
    const { db, executor } = memoryExecutor();
    const stale = repairedExperience({ experienceId: "stale-open", entryDecisionId: "stale-entry" });
    saveExperience(executor, stale, OPENED_AT);
    const agent = fakeAgent(executor, db);
    const current = position();

    const lifecycles = resolvePositionManagementLifecycles(executor, [stale], [current], new Map());

    expect(lifecycles).toEqual([]);
    expect(positionHistoryReconstructionRequired(lifecycles)).toBe(false);
    expect(positionHistoryRequests(lifecycles)).toEqual([]);
    db.close();
  });

  it("requires provider-live, deterministically resolved, context-matched lifecycles", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const experience = repairedExperience();
    saveExperience(executor, experience, OPENED_AT);
    seedContextMatching(executor, experience);
    const agent = fakeAgent(executor, db);
    const current = position();
    const identities = identitiesFor(executor, [current]);

    const resolved = resolvePositionManagementLifecycles(executor, [experience], [current], identities);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ symbol: "COINUSDT", positionSide: "LONG", entryTime: OPENED_AT, requiresReconstruction: true });
    expect(identity.decisionId).toBe(ENTRY_DECISION_ID);

    // Without the deterministic provider identity the lifecycle does not resolve.
    expect(resolvePositionManagementLifecycles(executor, [experience], [current], new Map())).toEqual([]);
    // Without a matching PositionContext the lifecycle does not resolve.
    db.close();
  });

  it("does not require reconstruction once a basis is established", () => {
    const { db, executor } = memoryExecutor();
    const established = repairedExperience({ maximumFavorableExcursion: "10", maximumFavorableExcursionBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
    const lifecycle: ResolvedPositionLifecycle = {
      symbol: "COINUSDT",
      positionSide: "LONG",
      experience: established,
      entryTime: OPENED_AT,
      requiresReconstruction: established.outcomeStatus === "OPEN" && !established.maximumFavorableExcursionBasis,
    };

    expect(positionHistoryReconstructionRequired([lifecycle])).toBe(false);
    expect(positionHistoryRequests([lifecycle])).toEqual([]);
    db.close();
  });
});

describe("reconstruction converges instead of repeating every cycle", () => {
  // Requirement 6: bounded historical observations establish a first-observation basis.
  it("stamps SINCE_FIRST_DETERMINISTIC_OBSERVATION from bounded history and persists it", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const experience = repairedExperience();
    saveExperience(executor, experience, OPENED_AT);
    seedContextMatching(executor, experience);
    const agent = fakeAgent(executor, db);
    const current = position({ markPrice: "206" });
    const identities = identitiesFor(executor, [current]);
    seedJournalHistory(executor, {
      unrelated: PRODUCTION_JOURNAL_ROWS,
      relevant: [observationJournal(1, "COINUSDT", "LONG", "210", "2026-10-06T17:00:00.000Z")],
    });

    const lifecycles = resolvePositionManagementLifecycles(executor, [experience], [current], identities);
    const history = loadBoundedPositionManagementHistory(executor, positionHistoryRequests(lifecycles).map((lifecycle) => ({
      symbol: lifecycle.symbol, positionSide: lifecycle.positionSide, startAt: lifecycle.entryTime,
    }))).journals;
    const states = refresh.call(agent, [experience], [current], [bundle("202")], OBSERVED_AT, history, identities);

    expect(states[0]).toMatchObject({ maximumFavorableReturnBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
    expect(states[0]!.maximumFavorableReturnPct).toBeGreaterThan(10);
    const [persisted] = executor.sql<{ payload: string }>`SELECT payload FROM experiences WHERE experience_id = ${experience.experienceId}`
      .map((row) => JSON.parse(row.payload) as TradeExperience);
    expect(persisted).toMatchObject({ maximumFavorableExcursionBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
    expect(Number(persisted!.maximumFavorableExcursion)).toBeGreaterThan(10);

    // Requirement 9: partial bounded history is never labelled SINCE_ENTRY.
    expect(persisted!.maximumFavorableExcursionBasis).not.toBe("SINCE_ENTRY");
    // Requirement 10: MAE is never fabricated from history.
    expect(persisted!.maximumAdverseExcursion).toBe("UNAVAILABLE");
    db.close();
  });

  // Requirement 7 and 8: no prior observation -> current observation converges the gate.
  it("converges from the current observation when no prior history exists", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const experience = repairedExperience();
    saveExperience(executor, experience, OPENED_AT);
    seedContextMatching(executor, experience);
    const agent = fakeAgent(executor, db);
    const current = position({ markPrice: "206" });
    const identities = identitiesFor(executor, [current]);
    seedJournalHistory(executor, { unrelated: 50 });

    const first = resolvePositionManagementLifecycles(executor, [experience], [current], identities);
    expect(positionHistoryReconstructionRequired(first)).toBe(true);

    const states = refresh.call(agent, [experience], [current], [bundle("202")], OBSERVED_AT, [], identities);
    expect(states[0]).toMatchObject({ maximumFavorableReturnBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });

    const [persisted] = executor.sql<{ payload: string }>`SELECT payload FROM experiences WHERE experience_id = ${experience.experienceId}`
      .map((row) => JSON.parse(row.payload) as TradeExperience);
    expect(persisted).toMatchObject({ maximumFavorableExcursionBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });

    // Requirement 8: the next cycle-equivalent resolves no reconstruction.
    const next = resolvePositionManagementLifecycles(executor, [persisted!], [current], identities);
    expect(positionHistoryReconstructionRequired(next)).toBe(false);
    expect(positionHistoryRequests(next)).toEqual([]);
    db.close();
  });

  it("converges from the current observation when the bounded read is truncated", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const experience = repairedExperience();
    saveExperience(executor, experience, OPENED_AT);
    seedContextMatching(executor, experience);
    const agent = fakeAgent(executor, db);
    const current = position({ markPrice: "206" });
    const identities = identitiesFor(executor, [current]);
    // A history far larger than the bound, none of it relevant to this lifecycle.
    seedJournalHistory(executor, { unrelated: PRODUCTION_JOURNAL_ROWS });

    const history = loadBoundedPositionManagementHistory(executor, [{ symbol: "COINUSDT", positionSide: "LONG", startAt: OPENED_AT }]);
    expect(history.journals).toEqual([]);
    const states = refresh.call(agent, [experience], [current], [bundle("202")], OBSERVED_AT, history.journals, identities);

    expect(states[0]).toMatchObject({ maximumFavorableReturnBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
    const [persisted] = executor.sql<{ payload: string }>`SELECT payload FROM experiences WHERE experience_id = ${experience.experienceId}`
      .map((row) => JSON.parse(row.payload) as TradeExperience);
    expect(persisted!.maximumFavorableExcursionBasis).toBe("SINCE_FIRST_DETERMINISTIC_OBSERVATION");
    expect(persisted!.maximumAdverseExcursion).toBe("UNAVAILABLE");
    db.close();
  });

  it("converges with zero excursion when the current observation is not favorable", () => {
    const { db, executor } = memoryExecutor();
    seedDarwinOpeningIdentity(executor);
    const experience = repairedExperience();
    saveExperience(executor, experience, OPENED_AT);
    seedContextMatching(executor, experience);
    const agent = fakeAgent(executor, db);
    const current = position({ markPrice: ENTRY_PRICE });
    const identities = identitiesFor(executor, [current]);

    const states = refresh.call(agent, [experience], [current], [bundle(ENTRY_PRICE)], OBSERVED_AT, [], identities);

    expect(states[0]).toMatchObject({ maximumFavorableReturnBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION", maximumFavorableReturnPct: 0 });
    const [persisted] = executor.sql<{ payload: string }>`SELECT payload FROM experiences WHERE experience_id = ${experience.experienceId}`
      .map((row) => JSON.parse(row.payload) as TradeExperience);
    expect(persisted).toMatchObject({ maximumFavorableExcursionBasis: "SINCE_FIRST_DETERMINISTIC_OBSERVATION" });
    expect(persisted!.maximumAdverseExcursion).toBe("UNAVAILABLE");
    db.close();
  });
});

describe("preserved lifecycle semantics", () => {
  // Requirement 11: PR #50 identity-safe lifecycle semantics are unchanged.
  it("still excludes a provider-external record without failing the cycle", () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db);
    const external = repairedExperience({
      experienceId: "provider-live:COINUSDT:LONG", symbol: "COINUSDT", positionSide: "LONG",
      action: "REDUCE", entryDecisionId: "", marginAllocationPct: "UNAVAILABLE",
      maximumFavorableExcursion: "UNAVAILABLE", maximumAdverseExcursion: "UNAVAILABLE",
      outcomeStatus: "OPEN", origin: "PROVIDER_EXTERNAL",
    } as Partial<TradeExperience>);

    expect(refresh.call(agent, [external], [position()], [bundle(ENTRY_PRICE)], OBSERVED_AT, [])).toEqual([]);
    db.close();
  });

  it("keeps the gate scoped to a live position with a positive quantity", () => {
    const { db, executor } = memoryExecutor();
    const identity = seedDarwinOpeningIdentity(executor);
    const experience = repairedExperience();
    saveExperience(executor, experience, OPENED_AT);
    seedContextMatching(executor, experience);
    const agent = fakeAgent(executor, db);
    const closed = position({ quantity: "0" });

    expect(resolvePositionManagementLifecycles(executor, [experience], [closed], identitiesFor(executor, [closed]))).toEqual([]);
    db.close();
  });

  it("deduplicates repeated lifecycle requests and caps their number", () => {
    const { db, executor } = memoryExecutor();
    const request = { symbol: "COINUSDT", positionSide: "LONG", startAt: OPENED_AT } as PositionHistoryRequest;
    const many = Array.from({ length: 50 }, (_, index) => ({ symbol: `SYM${index}USDT`, positionSide: "LONG", startAt: OPENED_AT }) as PositionHistoryRequest);

    // Duplicates collapse and invalid requests are rejected before reaching SQL.
    expect(loadBoundedPositionManagementHistory(executor, [request, request, { symbol: "", positionSide: "LONG", startAt: OPENED_AT } as PositionHistoryRequest]).journals).toEqual([]);
    expect(loadBoundedPositionManagementHistory(executor, many).journals).toEqual([]);
    db.close();
  });
});