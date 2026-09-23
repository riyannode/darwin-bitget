import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { initializeJournalLookupMigrationState, isCurrentJournalLookupMigrationSchedule, journalLookupMigrationSchedulePayload, JOURNAL_LOOKUP_BATCH_SIZE, loadJournalLookupMigrationState, markJournalLookupMigrationFailed, runJournalLookupMigrationBatch, type TransactionSync } from "../src/storage/journal-lookup-migration.js";

type JournalSeed = { cycleId: string; createdAt: string; payload: string };

function sqliteExecutor(db: DatabaseSync, queries: string[] = []): SqlExecutor {
  return {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      queries.push(query);
      const parameters = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[];
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) return db.prepare(query).all(...parameters) as T[];
      if (parameters.length > 0) db.prepare(query).run(...parameters);
      else db.exec(query);
      return [];
    },
  };
}

function transactional(db: DatabaseSync, failAfterCallback = false): TransactionSync {
  return <T>(callback: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      if (failAfterCallback) throw new Error("simulated process crash before commit");
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}

function productionJournalHistory(): JournalSeed[] {
  let decisionNumber = 0;
  return Array.from({ length: 1595 }, (_, journalNumber) => {
    const cycleId = `cycle-${String(journalNumber).padStart(5, "0")}`;
    const decisionCount = journalNumber < 985 ? 4 : 3;
    const decisions = Array.from({ length: decisionCount }, () => ({ decisionId: `decision-${String(++decisionNumber).padStart(5, "0")}`, action: "HOLD" }));
    return {
      cycleId,
      createdAt: new Date(Date.UTC(2026, 0, 1) + journalNumber * 60_000).toISOString(),
      payload: JSON.stringify({ cycleId, decisions, decision: decisions[0], retrievedLessons: [], createdLessons: [] }),
    };
  });
}

function createDatabase(rows: JournalSeed[]) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE journals (cycle_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)");
  for (const row of rows) insert.run(row.cycleId, row.payload, row.createdAt);
  return db;
}

describe("resumable journal decision lookup migration", () => {
  it("processes no more than 25 journals per invocation and advances a stable cycle_id primary-key cursor", () => {
    const db = createDatabase(productionJournalHistory());
    const queries: string[] = [];
    const executor = sqliteExecutor(db, queries);
    ensureStorage(executor);
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup_migration").get()).toEqual({ count: 0 });

    const state = runJournalLookupMigrationBatch(executor, transactional(db), "2026-09-24T00:00:00.000Z");
    const indexQueries = queries.filter((query) => /^\s*INSERT OR IGNORE INTO journal_decision_lookup/i.test(query) && query.includes("json_tree(CASE WHEN json_valid("));

    expect(state).toMatchObject({ status: "RUNNING", processedJournalCount: 25, indexedDecisionCount: 100 });
    expect(state.lastCreatedAt).toBe(new Date(Date.UTC(2026, 0, 1) + 24 * 60_000).toISOString());
    expect(state.lastCycleId).toBe("cycle-00024");
    expect(indexQueries).toHaveLength(25);
    const journalBatchQuery = queries.find((query) => /^\s*SELECT cycle_id, created_at, payload FROM journals/i.test(query));
    expect(journalBatchQuery).toContain("ORDER BY cycle_id ASC LIMIT ?");
    const cursorPlan = db.prepare("EXPLAIN QUERY PLAN SELECT cycle_id, created_at, payload FROM journals WHERE cycle_id > ? ORDER BY cycle_id ASC LIMIT 25").all("cycle-00024") as Array<{ detail: string }>;
    expect(cursorPlan.some((row) => row.detail.includes("SEARCH journals USING INDEX") && row.detail.includes("cycle_id>?"))).toBe(true);
    expect(cursorPlan.some((row) => row.detail.includes("SCAN journals"))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup").get()).toEqual({ count: 100 });
    db.close();
  });

  it("replaces legacy capped triggers once and indexes every decision ID on subsequent writes", () => {
    const db = createDatabase([]);
    const executor = sqliteExecutor(db);
    ensureStorage(executor);
    db.exec("DROP TRIGGER journals_decision_lookup_insert; DROP TRIGGER journals_decision_lookup_update;");
    db.exec(`CREATE TRIGGER journals_decision_lookup_insert AFTER INSERT ON journals BEGIN
      INSERT OR IGNORE INTO journal_decision_lookup (cycle_id, decision_id)
      SELECT DISTINCT NEW.cycle_id, decision.value FROM json_tree(NEW.payload) AS decision
      WHERE decision.key = 'decisionId' AND decision.type = 'text' AND length(decision.value) BETWEEN 1 AND 256
      LIMIT 500;
    END`);
    db.prepare("UPDATE journal_decision_lookup_schema_version SET version = 1 WHERE schema_key = 'journal_decision_lookup'").run();

    ensureStorage(executor);
    const decisions = Array.from({ length: 501 }, (_, index) => ({ decisionId: `trigger-decision-${index + 1}` }));
    db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)").run("cycle-trigger", JSON.stringify({ decisions }), "2026-09-24T00:00:00.000Z");

    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup WHERE cycle_id = 'cycle-trigger'").get()).toEqual({ count: 501 });
    expect(db.prepare("SELECT version FROM journal_decision_lookup_schema_version WHERE schema_key = 'journal_decision_lookup'").get()).toEqual({ version: 2 });
    db.close();
  });

  it("indexes every eligible decision ID in a journal larger than 500 decisions before declaring coverage", () => {
    const decisions = Array.from({ length: 501 }, (_, index) => ({ decisionId: `large-decision-${index + 1}`, action: "HOLD" }));
    const db = createDatabase([{ cycleId: "cycle-large", createdAt: "2026-09-01T00:00:00.000Z", payload: JSON.stringify({ cycleId: "cycle-large", decisions }) }]);
    const executor = sqliteExecutor(db);
    ensureStorage(executor);

    const running = runJournalLookupMigrationBatch(executor, transactional(db), "2026-09-24T00:00:00.000Z");
    expect(running).toMatchObject({ status: "RUNNING", processedJournalCount: 1, indexedDecisionCount: 501 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup").get()).toEqual({ count: 501 });

    const complete = runJournalLookupMigrationBatch(executor, transactional(db), "2026-09-24T00:00:05.000Z");
    expect(complete.status).toBe("COMPLETE");
    db.close();
  });

  it("rolls back lookup writes and cursor together after a crash, then retries idempotently", () => {
    const db = createDatabase(productionJournalHistory().slice(0, 30));
    const executor = sqliteExecutor(db);
    ensureStorage(executor);

    expect(() => runJournalLookupMigrationBatch(executor, transactional(db, true), "2026-09-24T00:00:00.000Z")).toThrow("simulated process crash");
    expect(loadJournalLookupMigrationState(executor)).toMatchObject({ status: "PENDING", lastCreatedAt: null, lastCycleId: null, processedJournalCount: 0, indexedDecisionCount: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup").get()).toEqual({ count: 0 });

    const retried = runJournalLookupMigrationBatch(executor, transactional(db), "2026-09-24T00:00:05.000Z");
    expect(retried).toMatchObject({ status: "RUNNING", processedJournalCount: 25, indexedDecisionCount: 100 });
    const replay = runJournalLookupMigrationBatch(executor, transactional(db), "2026-09-24T00:00:10.000Z");
    expect(replay).toMatchObject({ status: "RUNNING", processedJournalCount: 30, indexedDecisionCount: 120 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup").get()).toEqual({ count: 120 });
    db.close();
  });

  it("creates cursor-specific idempotency payloads and rejects stale scheduled callbacks", () => {
    const first = journalLookupMigrationSchedulePayload({ lastCycleId: null });
    const next = journalLookupMigrationSchedulePayload({ lastCycleId: "cycle-00024" });

    expect(first).not.toEqual(next);
    expect(isCurrentJournalLookupMigrationSchedule(first, { lastCycleId: null })).toBe(true);
    expect(isCurrentJournalLookupMigrationSchedule(first, { lastCycleId: "cycle-00024" })).toBe(false);
    expect(isCurrentJournalLookupMigrationSchedule(next, { lastCycleId: "cycle-00024" })).toBe(true);
  });

  it("completes 1,595 production-shape journals over bounded invocations and covers all 5,770 decisions", () => {
    const db = createDatabase(productionJournalHistory());
    const executor = sqliteExecutor(db);
    ensureStorage(executor);
    let state = loadJournalLookupMigrationState(executor);
    let invocations = 0;

    while (state.status !== "COMPLETE" && invocations < 100) {
      state = runJournalLookupMigrationBatch(executor, transactional(db), new Date(Date.UTC(2026, 8, 24) + invocations * 5_000).toISOString());
      invocations += 1;
      expect(state.processedJournalCount).toBeLessThanOrEqual(1595);
    }

    expect(invocations).toBeGreaterThan(2);
    expect(invocations).toBe(Math.ceil(1595 / JOURNAL_LOOKUP_BATCH_SIZE) + 1);
    expect(state).toMatchObject({ status: "COMPLETE", processedJournalCount: 1595, indexedDecisionCount: 5770 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup").get()).toEqual({ count: 5770 });

    const actualIds = (db.prepare("SELECT decision_id FROM journal_decision_lookup ORDER BY decision_id").all() as Array<{ decision_id: string }>).map((row) => row.decision_id);
    const expectedIds = Array.from({ length: 5770 }, (_, index) => `decision-${String(index + 1).padStart(5, "0")}`);
    expect(actualIds).toEqual(expectedIds);
    db.close();
  });

  it("persists bounded failure details without advancing migration coverage", () => {
    const db = createDatabase(productionJournalHistory().slice(0, 2));
    const executor = sqliteExecutor(db);
    ensureStorage(executor);

    const state = markJournalLookupMigrationFailed(executor, new Error("bounded migration failure"), "2026-09-24T00:00:00.000Z");

    expect(state).toMatchObject({ status: "FAILED", processedJournalCount: 0, lastCreatedAt: null, lastCycleId: null, lastError: "bounded migration failure" });
    db.close();
  });

  it("marks historical coverage COMPLETE only when the legacy binary marker already exists", () => {
    const db = createDatabase([]);
    db.exec("CREATE TABLE risk_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO risk_state VALUES (?, ?, ?)").run("journal_decision_lookup_v1", "{}", "2026-01-01T00:00:00.000Z");
    const executor = sqliteExecutor(db);

    ensureStorage(executor);
    initializeJournalLookupMigrationState(executor);

    expect(loadJournalLookupMigrationState(executor).status).toBe("COMPLETE");
    db.close();
  });

  it("does not alter journal, experience, policy, or provider sync rows while creating migration bookkeeping", () => {
    const db = createDatabase(productionJournalHistory().slice(0, 4));
    db.exec("CREATE TABLE experiences (experience_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, outcome_status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE risk_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.exec("CREATE TABLE provider_sync_state (category TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL, last_successful_sync_at TEXT, last_reconciliation_at TEXT, last_error TEXT, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)");
    db.prepare("INSERT INTO experiences VALUES (?, ?, ?, ?, ?)").run("legacy-exp", "BTCUSDT", "OPEN", "{\"keep\":true}", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO risk_state VALUES (?, ?, ?)").run("owner_policy", "{\"paused\":true}", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO provider_sync_state VALUES (?, ?, ?, ?, ?, ?, ?)").run("USDT-FUTURES", "{}", null, null, null, "2026-01-01T00:00:00.000Z", 3);
    const before = {
      journals: db.prepare("SELECT * FROM journals ORDER BY cycle_id").all(),
      experiences: db.prepare("SELECT * FROM experiences").all(),
      risk: db.prepare("SELECT * FROM risk_state WHERE state_key = 'owner_policy'").all(),
      sync: db.prepare("SELECT * FROM provider_sync_state").all(),
    };
    ensureStorage(sqliteExecutor(db));
    const after = {
      journals: db.prepare("SELECT * FROM journals ORDER BY cycle_id").all(),
      experiences: db.prepare("SELECT * FROM experiences").all(),
      risk: db.prepare("SELECT * FROM risk_state WHERE state_key = 'owner_policy'").all(),
      sync: db.prepare("SELECT * FROM provider_sync_state").all(),
    };
    expect(after).toEqual(before);
    db.close();
  });
});
