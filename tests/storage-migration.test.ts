import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlExecutor } from "../src/storage/schema.js";
import { loadJournalsForDecisionIds, savePerformanceAggregate } from "../src/storage/store.js";
import { emptyPerformance } from "../src/trading/performance.js";

vi.mock("agents", () => ({ Agent: class {} }));
vi.mock("../src/agent/scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent/scheduler.js")>()),
  reconcileProviderLedgerSchedule: vi.fn().mockResolvedValue(true),
}));

import { TraderAgent } from "../src/agent/agent.js";

const prePr28Schema = readFileSync(new URL("./fixtures/pre-pr28-schema.sql", import.meta.url), "utf8");
const observedAt = "2026-09-22T12:00:00.000Z";

function sqliteExecutor(db: DatabaseSync): SqlExecutor {
  return {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      const parameters = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[];
      if (/^\s*SELECT\b/i.test(query)) return db.prepare(query).all(...parameters) as T[];
      if (parameters.length > 0) db.prepare(query).run(...parameters);
      else db.exec(query);
      return [];
    },
  };
}

function insertLegacyRows(db: DatabaseSync, executor: SqlExecutor): void {
  const performance = {
    ...emptyPerformance(observedAt),
    performanceBaselineAt: "2026-01-01T00:00:00.000Z",
    competitionBaselineEquity: "1000.25",
    latestEquity: "1234.50",
    totalPnl: "234.25",
    totalTrades: 1,
    openTrades: 1,
  };
  savePerformanceAggregate(executor, performance, observedAt);
  db.prepare("INSERT INTO risk_state (state_key, payload, updated_at) VALUES (?, ?, ?)")
    .run("owner_policy", "{\"sentinel\":\"preserve-policy\"}", observedAt);

  const experience = {
    experienceId: "legacy-open-experience",
    symbol: "CRCLUSDT",
    positionSide: "LONG",
    action: "OPEN_LONG",
    entryDecisionId: "legacy-open-decision",
    entryPrice: "100",
    entryTime: "2026-06-01T10:00:00.000Z",
    exitDecisionId: "",
    exitPrice: "0",
    exitTime: "",
    selectedLeverage: "3",
    marginAllocationPct: "10",
    marginAllocated: "100",
    positionNotional: "300",
    realizedPnl: "0",
    realizedPnlPct: "0",
    maximumFavorableExcursion: "0",
    maximumAdverseExcursion: "0",
    drawdownContribution: "0",
    liquidationDistance: "0",
    entryThesis: "preserve lifecycle",
    exitThesis: "",
    evidenceAtEntry: ["TICKER"],
    evidenceAtExit: [],
    lessonsUsed: [],
    marketContext: "TRENDING_UP",
    outcomeStatus: "OPEN",
    realizedPnlVerified: false,
  };
  const journal = {
    cycleId: "legacy-open-cycle",
    agentVersion: "1",
    model: "qwen",
    mode: "AUTONOMOUS",
    startedAt: "2026-06-01T10:00:00.000Z",
    decision: {
      decisionId: "legacy-open-decision",
      cycleId: "legacy-open-cycle",
      action: "OPEN_LONG",
      positionSide: "LONG",
      symbol: "CRCLUSDT",
      createdAt: "2026-06-01T10:00:00.000Z",
      thesis: "preserve lifecycle",
      strategyThesis: "preserve strategy",
    },
    retrievedLessons: [],
    createdLessons: [],
  };
  db.prepare("INSERT INTO experiences (experience_id, symbol, outcome_status, payload, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(experience.experienceId, experience.symbol, experience.outcomeStatus, JSON.stringify(experience), experience.entryTime);
  db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)")
    .run(journal.cycleId, JSON.stringify(journal), journal.startedAt);

  db.prepare(`INSERT INTO provider_orders (
    provider_order_id, client_oid, category, symbol, side, qty, cum_exec_qty, order_status,
    created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("legacy-order", "legacy-client", "USDT-FUTURES", "CRCLUSDT", "buy", "3", "3", "filled", observedAt, observedAt, "DARWIN", "{\"id\":\"legacy-order\"}", observedAt, observedAt);
  db.prepare(`INSERT INTO provider_fills (
    exec_id, provider_order_id, client_oid, category, symbol, side, exec_qty, exec_price, created_time,
    origin, raw_provider_json, first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("legacy-fill", "legacy-order", "legacy-client", "USDT-FUTURES", "CRCLUSDT", "buy", "3", "100", observedAt, "DARWIN", "{\"execId\":\"legacy-fill\"}", observedAt, observedAt);
  db.prepare(`INSERT INTO provider_position_history (
    provider_position_history_key, category, symbol, position_side, opening_time, closing_time,
    closing_quantity, origin, raw_provider_json, first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("legacy-position-history", "USDT-FUTURES", "CRCLUSDT", "LONG", observedAt, observedAt, "3", "DARWIN", "{\"id\":\"legacy-position-history\"}", observedAt, observedAt);
  db.prepare(`INSERT INTO provider_financial_records (
    provider_record_key, category, type, provider_timestamp, origin, raw_provider_json, first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("USDT-FUTURES:legacy-fee", "USDT-FUTURES", "FEE", observedAt, "DARWIN", "{\"id\":\"legacy-fee\"}", observedAt, observedAt);
  db.prepare(`INSERT INTO provider_sync_state (
    category, checkpoint_json, last_successful_sync_at, last_reconciliation_at, last_error, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("USDT-FUTURES", "{\"financialRecords\":\"legacy-cursor\"}", observedAt, observedAt, null, observedAt);
}

function preservedRows(db: DatabaseSync) {
  return {
    performance: db.prepare("SELECT payload, updated_at FROM risk_state WHERE state_key = 'performance_aggregate'").get(),
    policy: db.prepare("SELECT payload, updated_at FROM risk_state WHERE state_key = 'owner_policy'").get(),
    experience: db.prepare("SELECT experience_id, outcome_status, payload, created_at FROM experiences WHERE experience_id = 'legacy-open-experience'").get(),
    journal: db.prepare("SELECT cycle_id, payload, created_at FROM journals WHERE cycle_id = 'legacy-open-cycle'").get(),
    order: db.prepare("SELECT provider_order_id, client_oid, category, symbol, side, qty, cum_exec_qty, order_status, raw_provider_json FROM provider_orders WHERE provider_order_id = 'legacy-order'").get(),
    fill: db.prepare("SELECT exec_id, provider_order_id, exec_qty, exec_price, raw_provider_json FROM provider_fills WHERE exec_id = 'legacy-fill'").get(),
    positionHistory: db.prepare("SELECT provider_position_history_key, category, symbol, position_side, closing_quantity, raw_provider_json FROM provider_position_history WHERE provider_position_history_key = 'legacy-position-history'").get(),
    financialRecord: db.prepare("SELECT provider_record_key, category, type, provider_timestamp, origin, raw_provider_json FROM provider_financial_records WHERE provider_record_key = 'USDT-FUTURES:legacy-fee'").get(),
    syncState: db.prepare("SELECT category, checkpoint_json, last_successful_sync_at, last_reconciliation_at, last_error, updated_at FROM provider_sync_state WHERE category = 'USDT-FUTURES'").get(),
  };
}

function versionFiveAgent(executor: SqlExecutor) {
  const agent = Object.create(TraderAgent.prototype) as {
    state: Record<string, unknown>;
    env: Record<string, string>;
    sql: SqlExecutor["sql"];
    setState(next: Record<string, unknown>): void;
    ensureActivePolicy(): Record<string, unknown>;
  };
  agent.state = {
    emergencyStop: false,
    paused: true,
    lastCycleId: null,
    lastScanAt: null,
    nextScanAt: null,
    model: "",
    runtimeStatus: "PAUSED",
    currentStage: "PAUSED",
    lastStatus: "IDLE",
    lastPolicyUpdateAt: null,
    cycleStartedAt: null,
    temporaryScanIntervalExpiresAt: "2026-09-23T16:00:00.000Z",
    temporaryScanIntervalCompleted: false,
    temporaryScanIntervalDurationMs: 7_200_000,
    userStorageVersion: 5,
  };
  agent.env = { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_CATEGORY: "USDT-FUTURES" };
  agent.sql = executor.sql.bind(executor);
  agent.setState = (next) => { agent.state = next; };
  agent.ensureActivePolicy = () => ({ paperOnly: true, emergencyStop: false });
  return agent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pre-PR #28 Durable Object storage migration", () => {
  it("upgrades version-5 storage before bootstrap while preserving existing rows", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(prePr28Schema);
    const executor = sqliteExecutor(db);
    insertLegacyRows(db, executor);
    const before = preservedRows(db);
    const agent = versionFiveAgent(executor);

    await expect(TraderAgent.prototype.onStart.call(agent)).resolves.toBeUndefined();

    expect(agent.state).toMatchObject({
      userStorageVersion: 6,
      paused: true,
      runtimeStatus: "PAUSED",
      currentStage: "PAUSED",
      temporaryScanIntervalExpiresAt: "2026-09-23T16:00:00.000Z",
      temporaryScanIntervalCompleted: false,
      temporaryScanIntervalDurationMs: 7_200_000,
    });
    expect(preservedRows(db)).toEqual(before);
    expect(db.prepare("SELECT cycle_id, decision_id FROM journal_decision_lookup").all()).toEqual([
      { cycle_id: "legacy-open-cycle", decision_id: "legacy-open-decision" },
    ]);
    expect(loadJournalsForDecisionIds(executor, ["legacy-open-decision"])).toMatchObject([
      { cycleId: "legacy-open-cycle", decision: { decisionId: "legacy-open-decision" } },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_financial_records").get()).toEqual({ count: 1 });
    db.close();
  });
});
