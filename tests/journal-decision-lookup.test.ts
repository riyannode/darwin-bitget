import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadJournalForExactDecisionCycle, loadJournalsForDecisionIds } from "../src/storage/store.js";

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

function createDatabase(rows: JournalSeed[]) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE journals (cycle_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)");
  for (const row of rows) insert.run(row.cycleId, row.payload, row.createdAt);
  return db;
}

function historicalJournal(cycleId: string, decisionId: string, createdAt: string): JournalSeed {
  return { cycleId, createdAt, payload: JSON.stringify({ cycleId, decision: { decisionId, action: "OPEN_LONG" }, createdLessons: [] }) };
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

describe("journal decision lookup without global backfill", () => {
  it("opens pre-PR28 production-shape storage, preserves rows, and never runs historical json_tree backfill", () => {
    const db = createDatabase(productionJournalHistory());
    db.exec("CREATE TABLE experiences (experience_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, outcome_status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE risk_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO experiences VALUES (?, ?, ?, ?, ?)").run("legacy-exp", "BTCUSDT", "OPEN", "{\"keep\":true}", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO risk_state VALUES (?, ?, ?)").run("owner_policy", "{\"paused\":true}", "2026-01-01T00:00:00.000Z");
    const beforeJournal = db.prepare("SELECT * FROM journals").all();
    const beforeExperience = db.prepare("SELECT * FROM experiences").all();
    const beforePolicy = db.prepare("SELECT * FROM risk_state").all();
    const queries: string[] = [];
    const executor = sqliteExecutor(db, queries);

    ensureStorage(executor);
    ensureStorage(executor);

    expect(queries.some((query) => /json_tree\s*\(/i.test(query) && /FROM\s+journals/i.test(query))).toBe(false);
    expect(queries.some((query) => /^\s*(SELECT|WITH)\b/i.test(query) && /\bFROM\s+journals\b/i.test(query))).toBe(false);
    expect(db.prepare("SELECT * FROM journals").all()).toEqual(beforeJournal);
    expect(db.prepare("SELECT * FROM experiences").all()).toEqual(beforeExperience);
    expect(db.prepare("SELECT * FROM risk_state").all()).toEqual(beforePolicy);
    expect(db.prepare("SELECT COUNT(*) AS count FROM journals").get()).toEqual({ count: 1595 });
    expect(db.prepare("SELECT SUM(json_array_length(json_extract(payload, '$.decisions'))) AS count FROM journals").get()).toEqual({ count: 5770 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'journal_decision_lookup_migration'").get()).toEqual({ count: 0 });
    db.close();
  });

  it("upgrades lookup triggers and indexes new journal writes without reindexing old rows", () => {
    const db = createDatabase([]);
    db.exec("CREATE TABLE journal_decision_lookup_schema_version (schema_key TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    db.exec("INSERT INTO journal_decision_lookup_schema_version VALUES ('journal_decision_lookup', 1)");
    db.exec("CREATE TABLE journal_decision_lookup (cycle_id TEXT NOT NULL, decision_id TEXT NOT NULL, PRIMARY KEY (cycle_id, decision_id))");
    db.exec("CREATE TRIGGER journals_decision_lookup_insert AFTER INSERT ON journals BEGIN SELECT 1; END");
    const executor = sqliteExecutor(db);

    ensureStorage(executor);
    db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)").run("new-cycle", JSON.stringify({ cycleId: "new-cycle", decisions: [{ decisionId: "new-decision" }] }), "2026-09-24T00:00:00.000Z");
    expect(db.prepare("SELECT cycle_id, decision_id FROM journal_decision_lookup").all()).toEqual([{ cycle_id: "new-cycle", decision_id: "new-decision" }]);

    db.prepare("UPDATE journals SET payload = ? WHERE cycle_id = ?").run(JSON.stringify({ cycleId: "new-cycle", decisions: [{ decisionId: "updated-decision" }] }), "new-cycle");
    expect(db.prepare("SELECT cycle_id, decision_id FROM journal_decision_lookup").all()).toEqual([{ cycle_id: "new-cycle", decision_id: "updated-decision" }]);

    db.prepare("DELETE FROM journals WHERE cycle_id = ?").run("new-cycle");
    expect(db.prepare("SELECT cycle_id, decision_id FROM journal_decision_lookup").all()).toEqual([]);
    expect(db.prepare("SELECT version FROM journal_decision_lookup_schema_version WHERE schema_key = 'journal_decision_lookup'").get()).toEqual({ version: 2 });
    db.close();
  });

  it("uses the maintained index and a bounded fallback for a historical exact decision ID", () => {
    const db = createDatabase([
      historicalJournal("recent-cycle", "unrelated", "2026-09-24T00:00:00.000Z"),
      historicalJournal("legacy-cycle", "legacy-exact-id", "2026-09-23T00:00:00.000Z"),
      ...Array.from({ length: 40 }, (_, index) => historicalJournal(`older-${index}`, `other-${index}`, `2026-09-${String(22 - Math.floor(index / 20)).padStart(2, "0")}T00:00:00.000Z`)),
    ]);
    const queries: string[] = [];
    const executor = sqliteExecutor(db, queries);
    ensureStorage(executor);

    const result = loadJournalsForDecisionIds(executor, ["legacy-exact-id"]);

    expect(result.map((journal) => journal.cycleId)).toEqual(["legacy-cycle"]);
    const fallbackQuery = queries.find((query) => query.includes("WITH recent_journals AS MATERIALIZED"));
    expect(fallbackQuery).toContain("LIMIT ?");
    expect(fallbackQuery).toContain("length(CAST(journal.payload AS BLOB))");
    expect(fallbackQuery).not.toContain("json_tree");
    db.close();
  });

  it("skips oversized payloads on both indexed and fallback lookup paths", () => {
    const oversized = JSON.stringify({ cycleId: "oversized-cycle", decision: { decisionId: "oversized-fallback-decision" }, padding: "x".repeat(256 * 1024) });
    const db = createDatabase([{ cycleId: "oversized-cycle", createdAt: "2026-09-24T00:00:00.000Z", payload: oversized }]);
    const queries: string[] = [];
    const executor = sqliteExecutor(db, queries);
    ensureStorage(executor);

    expect(loadJournalsForDecisionIds(executor, ["oversized-fallback-decision"])).toEqual([]);
    const fallbackQuery = queries.find((query) => query.includes("WITH recent_journals AS MATERIALIZED"));
    expect(fallbackQuery).toContain("length(CAST(journal.payload AS BLOB))");

    const indexedPayload = JSON.stringify({ cycleId: "oversized-indexed-cycle", decision: { decisionId: "oversized-indexed-decision" }, padding: "x".repeat(256 * 1024) });
    db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)").run("oversized-indexed-cycle", indexedPayload, "2026-09-25T00:00:00.000Z");
    expect(loadJournalsForDecisionIds(executor, ["oversized-indexed-decision"])).toEqual([]);
    const indexedQuery = queries.find((query) => query.includes("JOIN journal_decision_lookup"));
    expect(indexedQuery).toContain("length(CAST(j.payload AS BLOB))");
    db.close();
  });

  it("resolves an executed decision outside the recent window through its exact idempotency cycle", () => {
    const rows = [historicalJournal("executed-cycle", "executed-decision", "2020-01-01T00:00:00.000Z"), ...Array.from({ length: 30 }, (_, index) => historicalJournal(`newer-${index}`, `newer-decision-${index}`, new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString()))];
    const db = createDatabase(rows);
    const queries: string[] = [];
    const executor = sqliteExecutor(db, queries);
    ensureStorage(executor);
    const idempotencyPlan = db.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT cycle_id FROM idempotency WHERE decision_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(["executed-decision"])) as Array<{ detail: string }>;
    expect(idempotencyPlan.some((row) => row.detail.includes("SEARCH idempotency USING INDEX idempotency_decision_idx") && row.detail.includes("decision_id=?"))).toBe(true);
    db.prepare("INSERT INTO idempotency (client_order_id, cycle_id, decision_id, provider_order_id, created_at) VALUES (?, ?, ?, ?, ?)").run("client-executed", "executed-cycle", "executed-decision", "provider-executed", "2020-01-01T00:00:00.000Z");

    const result = loadJournalsForDecisionIds(executor, ["executed-decision"]);

    expect(result.map((journal) => journal.cycleId)).toEqual(["executed-cycle"]);
    const exactIdsQuery = queries.find((query) => query.includes("FROM idempotency") && query.includes("decision_id"));
    expect(exactIdsQuery).toContain("WHERE decision_id");
    expect(exactIdsQuery).not.toContain("json_tree");
    const exactJournalQuery = queries.find((query) => query.includes("FROM journals AS journal") && query.includes("cycle_id IN"));
    expect(exactJournalQuery).toContain("cycle_id IN (SELECT value FROM json_each(?))");
    expect(exactIdsQuery).not.toContain("json_tree");
    expect(exactJournalQuery).not.toContain("json_tree");
    expect(queries.some((query) => query.includes("WITH recent_journals AS MATERIALIZED"))).toBe(false);
    db.close();
  });

  it("does not fall back to a recent unrelated journal when an idempotency row identifies an unverifiable execution", () => {
    const rows = [historicalJournal("executed-cycle", "different-decision", "2020-01-01T00:00:00.000Z"), historicalJournal("recent-cycle", "executed-decision", "2026-09-24T00:00:00.000Z")];
    const db = createDatabase(rows);
    const queries: string[] = [];
    const executor = sqliteExecutor(db, queries);
    ensureStorage(executor);
    const insertIdempotency = db.prepare("INSERT INTO idempotency (client_order_id, cycle_id, decision_id, provider_order_id, created_at) VALUES (?, ?, ?, ?, ?)");
    for (let index = 0; index < 200; index += 1) {
      insertIdempotency.run(`client-idempotent-${index}`, `executed-cycle-${String(index).padStart(3, "0")}`, "other-executed-decision", `provider-idempotent-${index}`, "2020-01-01T00:00:00.000Z");
    }
    insertIdempotency.run("client-target", "zzzz-target-cycle", "executed-decision", "provider-target", "2020-01-01T00:00:00.000Z");

    expect(loadJournalsForDecisionIds(executor, ["other-executed-decision", "executed-decision"])).toEqual([]);
    expect(queries.some((query) => query.includes("WITH recent_journals AS MATERIALIZED"))).toBe(false);
    db.close();
  });

  it("loads only the exact cycle journal and validates that the requested decision is present", () => {
    const db = createDatabase([historicalJournal("old-executed-cycle", "old-executed-decision", "2020-01-01T00:00:00.000Z"), ...Array.from({ length: 35 }, (_, index) => historicalJournal(`newer-${index}`, `other-${index}`, new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString()))]);
    const queries: string[] = [];
    const executor = sqliteExecutor(db, queries);
    ensureStorage(executor);

    expect(loadJournalForExactDecisionCycle(executor, "old-executed-cycle", "old-executed-decision")?.cycleId).toBe("old-executed-cycle");
    expect(loadJournalForExactDecisionCycle(executor, "old-executed-cycle", "wrong-decision")).toBeNull();
    const exactQuery = queries.filter((query) => /^\s*SELECT cycle_id, payload FROM journals/i.test(query)).at(-1);
    expect(exactQuery).toContain("WHERE cycle_id = ?");
    expect(exactQuery).not.toContain("ORDER BY created_at");
    expect(exactQuery).not.toContain("json_tree");
    db.close();
  });

  it("does not search older non-idempotent journals outside the 25-row fallback window", () => {
    const rows = [historicalJournal("outside-window", "too-old-non-idempotent", "2026-09-01T00:00:00.000Z"), ...Array.from({ length: 25 }, (_, index) => historicalJournal(`recent-${index}`, `recent-decision-${index}`, new Date(Date.UTC(2026, 8, 2) + index * 60_000).toISOString()))];
    const db = createDatabase(rows);
    const executor = sqliteExecutor(db);
    ensureStorage(executor);

    expect(loadJournalsForDecisionIds(executor, ["too-old-non-idempotent"])).toEqual([]);
    db.close();
  });

  it("continues indexing new journal inserts, updates, and deletes through triggers", () => {
    const db = createDatabase([]);
    const executor = sqliteExecutor(db);
    ensureStorage(executor);
    const insert = db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)");
    insert.run("new-cycle", JSON.stringify({ decision: { decisionId: "new-decision" } }), "2026-09-24T00:00:00.000Z");
    expect(db.prepare("SELECT cycle_id, decision_id FROM journal_decision_lookup").all()).toEqual([{ cycle_id: "new-cycle", decision_id: "new-decision" }]);
    db.prepare("UPDATE journals SET payload = ? WHERE cycle_id = ?").run(JSON.stringify({ decision: { decisionId: "updated-decision" } }), "new-cycle");
    expect(db.prepare("SELECT cycle_id, decision_id FROM journal_decision_lookup").all()).toEqual([{ cycle_id: "new-cycle", decision_id: "updated-decision" }]);
    db.prepare("DELETE FROM journals WHERE cycle_id = ?").run("new-cycle");
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup").get()).toEqual({ count: 0 });
    db.close();
  });
});
