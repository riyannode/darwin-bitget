import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadJournalsForDecisionIds } from "../src/storage/store.js";

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
    expect(db.prepare("SELECT * FROM journals").all()).toEqual(beforeJournal);
    expect(db.prepare("SELECT * FROM experiences").all()).toEqual(beforeExperience);
    expect(db.prepare("SELECT * FROM risk_state").all()).toEqual(beforePolicy);
    expect(db.prepare("SELECT COUNT(*) AS count FROM journals").get()).toEqual({ count: 1595 });
    expect(db.prepare("SELECT SUM(json_array_length(json_extract(payload, '$.decisions'))) AS count FROM journals").get()).toEqual({ count: 5770 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_decision_lookup").get()).toEqual({ count: 0 });
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

  it("skips a single legacy payload larger than the bounded fallback byte budget", () => {
    const oversized = JSON.stringify({ cycleId: "oversized-cycle", decision: { decisionId: "oversized-decision" }, padding: "x".repeat(256 * 1024) });
    const db = createDatabase([{ cycleId: "oversized-cycle", createdAt: "2026-09-24T00:00:00.000Z", payload: oversized }]);
    const executor = sqliteExecutor(db);
    ensureStorage(executor);

    expect(loadJournalsForDecisionIds(executor, ["oversized-decision"])).toEqual([]);
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
